// Production in-process SDK browser-tool adapter.
//
// Productionizes host/agent/spike/lib/adapter.mjs (see
// reports/01-sdk-gate-evidence.md gate 1.2, which proved the underlying
// tool()/createSdkMcpServer() wiring against real zod v3 schemas and the
// real host/tool-runtime.js dispatch path): the spike's registration loop
// was a bare passthrough with no authorization; this version adds the
// unconditional handler-side authorization design.md decision 2 requires —
// "Validate run state, arguments, browser lease, and tab scope inside each
// tool handler, even when SDK permission checks preapprove the tool" — on
// every single call, and attaches the run-identifying metadata (run id,
// conversation id, browser identity, tab scope, unique request id) task 3.4
// requires on every dispatched request.
//
// Still does not reimplement browser automation: every call still ends at
// the existing, unmodified host/tool-definitions.js schema and (via the
// injected `callTool`) host/tool-runtime.js dispatch.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { TOOLS } from "../../tool-definitions.js";
import { authorizeToolCall, AuthorizationError } from "../policy/authorization.js";
import {
  sdkFacingToolDefs,
  enforceBorrowedTabScope,
  BorrowedTabMutationError,
  recordAgentCreatedTab,
  extractCreatedTabId,
  authorizeBorrowedTabMutation,
  isBorrowedTab,
  isBorrowedTabMutationAuthorized,
  isSendClassCall,
  classifySendClassCall,
  classifyBrowserBatch,
  normalizeApprovalArgs,
  fingerprintNormalizedArgs
} from "./mapping.js";

export const SDK_MCP_SERVER_NAME = "browzy-in-chrome-browser";

export const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// Task 9.3/10.4 helpers: determine which calls are eligible for the
// automatic borrowed-tab mutation authorization (the "automatic action set"
// — computer's non-submit-classified actions and form_input only —
// per design section 9d). javascript_tool is deliberately NOT eligible: the
// shared per-tab flag has no notion of which tool asked, and a future
// javascript_tool call against the same tab (including a navigating one)
// must never be silently authorized by a grant made for typing.
const TAB_ARG_KEYS_FOR_AUTOAUTH = ["tabId"];

function _isAutoAuthorizeEligible(toolName, args) {
  // form_input is always eligible: it is reliably classifiable per call as
  // a non-send, filling action, and the live-evidence design (9d) includes
  // it in the automatic action set.
  if (toolName === "form_input") return true;
  // computer is eligible ONLY for non-send-class, non-click-or-key actions
  // (typing, scrolling, hovering, dragging — per design 9d's "computer's
  // non-submit-classified actions"). Wait: the design says "typing, filling,
  // non-submit clicks, scrolling, hovering" — non-submit clicks ARE included.
  // So the gate is: a `computer` call that is NOT send-class. isSendClassCall
  // already classifies per call (a non-submit click/key, scroll/zoom/type/
  // drag/hover all return false). We auto-authorize when the call is not
  // send-class; a send-class call (submit click, submit key) is gated through
  // the approval card.
  if (toolName === "computer") return !isSendClassCall(toolName, args || {});
  // Every other tool: not part of the automatic action set.
  // javascript_tool: explicitly excluded (design 9d).
  return false;
}

function _tabIdsForArgs(toolName, args) {
  const ids = [];
  for (const key of TAB_ARG_KEYS_FOR_AUTOAUTH) {
    const v = args?.[key];
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const id of v) {
        if (typeof id === "number") ids.push(id);
      }
    } else if (typeof v === "number") {
      ids.push(v);
    }
  }
  return ids;
}

function authorizationErrorResult(err) {
  return {
    content: [
      {
        type: "text",
        text: `Error: request rejected (${err.reason}). This is not a page-content or model decision — it is enforced independently of any prior approval.`
      }
    ],
    isError: true
  };
}

function borrowedTabMutationErrorResult(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    isError: true
  };
}

function staleApprovalErrorResult(reason) {
  return {
    content: [
      {
        type: "text",
        text: `Error: approval is stale and cannot dispatch (${reason}). The target, document, domain, arguments, scope, nonce, or observed state changed after Allow — request a fresh approval instead of retrying this dispatch.`
      }
    ],
    isError: true
  };
}

/**
 * 3.4 pre-dispatch revalidation for send-class-shaped calls. Runs INSIDE
 * the tool handler — i.e. after `canUseTool` resolved Allow, immediately
 * before `toolBridge.call` dispatches to the browser. Verifies:
 *   1. a single-use approval grant for THIS call's normalized-args
 *      fingerprint was recorded by the Allow path and has not been consumed
 *      (catches argument/target swaps between Allow and dispatch, replays,
 *      and handler invocations that never passed the gate at all);
 *   2. (then the caller's existing authorizeToolCall + borrowed-tab scope
 *      checks re-verify run state, lease, and tab scope per dispatch —
 *      unchanged, they already run here).
 *
 * On success for a `computer` call, the grant ALSO lifts the borrowed-tab
 * read-only default for that tab (the user's explicit Allow IS the explicit
 * task authorization that default waits for). `javascript_tool` is
 * deliberately EXCLUDED from that lift — the borrowed-tab scripting
 * restriction (mapping.js 10.4) is independent of approval text and stays
 * rejected regardless of any Allow (spec "Borrowed-tab JavaScript").
 *
 * @returns {{ ok: true, granted: boolean } | { ok: false, reason: string }}
 *   `granted` is true only when a single-use grant was consumed for this
 *   exact call (i.e. the call was gated AND approved); false for non-send
 *   calls that need no grant.
 */
export function verifyPreDispatchApproval({ run, legacyToolName, args }) {
  const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs(legacyToolName, args));
  // The gate's own verdict binds when it recorded one. This used to say gate
  // and dispatch were "hintless and identical by construction" — they are
  // not. can-use-tool.js's resolveHintFor() dereferences a `ref` against the
  // live page and classifies WITH that hint; nothing here can (no page
  // access at dispatch time), so this side is genuinely hintless.
  //
  // That was aspirational for a while: `resolveHint` was an optional
  // constructor argument that production never passed, so the gate WAS
  // hintless too, never reached its own `allow` branch for a ref click, and
  // never recorded a verdict — and this check then refused every ref-only
  // click as "stale or bypassed gate" while waving through the bare
  // coordinate that carries less evidence. The resolver is wired now
  // (companion.js), which is what makes the sentence above true and this
  // handshake reachable. When the
  // hint is what downgrades a call to non-send, the gate allows without
  // minting a grant and this check, re-deciding on less evidence, would
  // refuse a call nothing can ever mint a grant for — an unrecoverable
  // refusal that no retry can clear. The gate holds strictly more evidence,
  // so its recorded verdict is honoured here rather than second-guessed.
  //
  // Absence of a recorded verdict still means "never passed the gate", which
  // is exactly what the fall-through below is for: a handler invoked without
  // the gate, or a replayed one, is classified here and refused if it looks
  // send-class. That is the invariant this check exists to hold, and it is
  // unchanged.
  if (typeof run.consumeGateVerdict === "function") {
    const gateVerdict = run.consumeGateVerdict(fingerprint);
    if (gateVerdict.ok && gateVerdict.verdict === "allow") {
      return { ok: true, granted: false };
    }
  }

  const hint = args?.targetHint && typeof args.targetHint === "object" ? args.targetHint : null;
  const classification = classifySendClassCall(legacyToolName, args, hint);
  if (classification.verdict !== "approve-known" && classification.verdict !== "approve-unknown") {
    return { ok: true, granted: false };
  }
  if (typeof run.consumeApprovalGrant !== "function") {
    return { ok: false, reason: "approval grants unsupported by this run" };
  }
  const grant = run.consumeApprovalGrant(fingerprint);
  if (!grant.ok) {
    return { ok: false, reason: grant.reason === "grant_replayed" ? "approval grant already used (replay)" : "no approval grant for these exact arguments (stale or bypassed gate)" };
  }
  return { ok: true, granted: true };
}

/**
 * @param {object} deps
 * @param {import("../broker/tool-bridge.js").ToolBridge} deps.toolBridge
 *   Run-scoped tool dispatch — wraps host/tool-runtime.js's callTool with the
 *   meta parameter this adapter attaches on every call, and distinguishes a
 *   real error from a lost-response "result unknown" outcome.
 * @param {(coerced: object) => object} deps.coerceArgs
 * @param {import("../session/run.js").Run} deps.run - the run this server
 *   instance is scoped to; authorization reads its live state/lease/tabScope
 *   at CALL time (not at build time), so a run stopped mid-conversation
 *   rejects a call made a second later even though the tool was built once.
 */
// Description text only (design.md 5b's current-page-default wording) —
// registration below still uses TOOLS directly, keyed by t.name, so the
// registered tool() identifier is untouched (see mapping.js's file-header
// note on why: host/test/agent-tool-adapter.test.mjs, out of this task's
// ownership, asserts byte-identical registration against TOOLS).
const SDK_DESCRIPTIONS = new Map(sdkFacingToolDefs().map((t) => [t.legacyName, t.description]));

/**
 * The unconditional host-side checks every SINGLE dispatch must pass, for one
 * call. Extracted so a standalone call and each item of a browser_batch run
 * the exact same checks: batching cannot give an item a capability (or less
 * scrutiny) than its standalone form. Records rejections on the run exactly
 * as the pre-extraction code did.
 *
 * @param {object} opts
 * @param {string} opts.legacyToolName
 * @param {object} opts.args
 * @param {boolean} opts.sendClassTool - true for the tools that can produce a
 *   send/submit-class call (`computer`, `javascript_tool`, `webmcp_call_tool`).
 *   For those, the single-use pre-dispatch approval check runs (3.4),
 *   including the borrowed-tab lift a consumed grant authorizes. Batch items
 *   pass false: the batch's own pre-flight already adjudicated send-class
 *   before any item check runs, and a batch never carries a per-item grant.
 * @returns {{ ok: true } | { ok: false, result: object }}
 */
function runHostSideChecks({ run, legacyToolName, args, sendClassTool }) {
  try {
    authorizeToolCall({
      toolName: legacyToolName,
      args,
      runState: run.state,
      leaseHeldByThisRun: run.leaseHeldByThisRun(),
      tabScope: run.tabScope,
      uploadAllowlist: run.uploadAllowlist,
      knownToolNames: KNOWN_TOOL_NAMES
    });
    // Second, additive gate (design.md 5b): even a call authorizeToolCall
    // above already approved (in-scope, run active, lease held) can still be a
    // mutation against a borrowed tab, which needs its own explicit
    // authorization — see mapping.js.
    //
    // Task 9.3 (design 9d): automatically authorize the borrowed tab for
    // interaction once it is legitimately in scope — for the automatic action
    // set ONLY: `computer`'s non-submit-classified actions and `form_input`.
    // `javascript_tool` is deliberately EXCLUDED (design 9d): the shared
    // per-tab flag has no notion of which tool asked, so granting it for
    // typing would silently also authorize a later navigating script.
    if (_isAutoAuthorizeEligible(legacyToolName, args)) {
      for (const tabId of _tabIdsForArgs(legacyToolName, args)) {
        if (isBorrowedTab(run, tabId) && !isBorrowedTabMutationAuthorized(run, tabId)) {
          authorizeBorrowedTabMutation(run, tabId);
        }
      }
    }
    // 3.3/3.4: a genuinely approved send-class call carries the user's
    // explicit Allow for THIS exact call (proven by the grant consumed below)
    // — that Allow IS the explicit task authorization the borrowed-tab
    // read-only default waits for, so it lifts the default for this dispatch.
    // `javascript_tool` is deliberately EXCLUDED: its borrowed-tab scripting
    // restriction stays rejected regardless of any approval text.
    if (sendClassTool) {
      const preDispatch = verifyPreDispatchApproval({ run, legacyToolName, args });
      if (!preDispatch.ok) {
        run.recordRejectedDispatch?.(legacyToolName, args, { reason: "stale_approval", detail: { dispatchReason: preDispatch.reason } });
        return { ok: false, result: staleApprovalErrorResult(preDispatch.reason) };
      }
      if (preDispatch.granted && (legacyToolName === "computer" || legacyToolName === "webmcp_call_tool")) {
        for (const tabId of _tabIdsForArgs(legacyToolName, args)) {
          if (isBorrowedTab(run, tabId) && !isBorrowedTabMutationAuthorized(run, tabId)) {
            authorizeBorrowedTabMutation(run, tabId);
          }
        }
      }
    }
    enforceBorrowedTabScope({ run, legacyToolName, args });
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthorizationError) {
      run.recordRejectedDispatch?.(legacyToolName, args, err);
      return { ok: false, result: authorizationErrorResult(err) };
    }
    if (err instanceof BorrowedTabMutationError) {
      run.recordRejectedDispatch?.(legacyToolName, args, { reason: "borrowed_tab_mutation", detail: { tabId: err.tabId } });
      return { ok: false, result: borrowedTabMutationErrorResult(err) };
    }
    throw err;
  }
}

function firstTextOf(result) {
  if (!result || !Array.isArray(result.content)) return "";
  const block = result.content.find((b) => b && b.type === "text");
  return block ? String(block.text || "") : "";
}

/**
 * Host-side checks for a browser_batch, run BEFORE the batch reaches the
 * extension. Order matters:
 *   1. structure + nesting are always validated;
 *   2. send-class is adjudicated — a clean-batch gate verdict for THIS exact,
 *      item-sensitive fingerprint means the gate already classified every
 *      item with resolved target hints the handler cannot obtain, so that
 *      verdict binds; with no verdict (a handler invoked without passing the
 *      gate) the items are classified hintless with the SAME classifier, so a
 *      batch can never smuggle in an item that needs the user's decision;
 *   3. every item then runs the same per-call host checks as its standalone
 *      form.
 * Any failure refuses the WHOLE batch before anything runs.
 */
function checkBrowserBatchHostSide({ run, args }) {
  const actions = Array.isArray(args?.actions) ? args.actions : [];
  const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs("browser_batch", args));

  let gateAllowed = false;
  if (typeof run.consumeGateVerdict === "function") {
    const verdict = run.consumeGateVerdict(fingerprint);
    gateAllowed = verdict.ok && verdict.verdict === "allow";
  }

  const classification = classifyBrowserBatch(actions, [], { classify: !gateAllowed });
  if (!classification.ok) {
    return { ok: false, result: { content: [{ type: "text", text: `Error: ${classification.reason}` }], isError: true } };
  }

  for (const item of classification.items) {
    const check = runHostSideChecks({ run, legacyToolName: item.legacyName, args: item.input, sendClassTool: false });
    if (!check.ok) {
      return {
        ok: false,
        result: {
          content: [
            {
              type: "text",
              text:
                `Error: browser_batch item ${item.index + 1} (${item.legacyName}) was refused exactly as it would be standing alone, ` +
                `so the whole batch was refused before anything ran. ${firstTextOf(check.result)}`
            }
          ],
          isError: true
        }
      };
    }
  }
  return { ok: true };
}

export function buildSdkTools({ toolBridge, coerceArgs, run }) {
  return TOOLS.map((t) =>
    tool(t.name, SDK_DESCRIPTIONS.get(t.name) ?? t.description, t.paramShape, async (args) => {
      const coerced = coerceArgs({ ...(args ?? {}) });
      if (t.name === "browser_batch") {
        const batchCheck = checkBrowserBatchHostSide({ run, args: coerced });
        if (!batchCheck.ok) return batchCheck.result;
      } else {
        const check = runHostSideChecks({
          run,
          legacyToolName: t.name,
          args: coerced,
          sendClassTool: t.name === "computer" || t.name === "javascript_tool" || t.name === "webmcp_call_tool"
        });
        if (!check.ok) return check.result;
      }
      const meta = run.describeRequestForWire();
      const { result, resultUnknown } = await toolBridge.call(t.name, coerced, meta);
      if (resultUnknown) run.recordResultUnknown?.(t.name, coerced, meta);
      // tabs_create_mcp's own new tab is agent-created, never borrowed —
      // recorded from the real result text rather than a new wire field
      // (see mapping.js's extractCreatedTabId). Best-effort: a shape change
      // in the shipped handler's text would just mean this run's cleanup
      // guard cannot recognize that tab as its own, not a crash.
      if (t.name === "tabs_create_mcp" && !resultUnknown) {
        const createdTabId = extractCreatedTabId(result);
        if (createdTabId !== null) {
          recordAgentCreatedTab(run, createdTabId);
          // ...and admit it into this run's tab scope. Marking it
          // agent-created alone only kept the borrowed-tab read-only guard
          // off it; without this the run still failed tab_out_of_scope on
          // every call against the tab it had just been told to create.
          // Ordering matters: mark first, so the tab is never briefly
          // classified as borrowed while it is in scope.
          run.admitSessionOwnedTab?.(createdTabId);
        }
      }
      return result;
    })
  );
}

export function createBrowserMcpServer(deps) {
  // Task 9.5: include the application-owned ask-the-user tool alongside the
  // browser tools on the SAME SDK MCP server. The caller (companion.js)
  // builds it via host/agent/tools/ask-the-user.js's createAskUserTool() and
  // passes it as `deps.extraTools` (an array). This keeps ask_user on the
  // same server as the browser tools so the SDK's `tools`/`allowedTools`
  // allowlist derivation (sdkQualifiedToolNames) covers it naturally.
  const browserTools = buildSdkTools(deps);
  const extraTools = Array.isArray(deps?.extraTools) ? deps.extraTools : [];
  return createSdkMcpServer({
    name: SDK_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [...browserTools, ...extraTools]
  });
}

export function adapterToolNames() {
  return TOOLS.map((t) => t.name);
}

/**
 * Every registered browser tool's fully-qualified SDK identifier
 * (`mcp__${serverName}__${toolName}`) — the exact string the SDK's `tools`
 * allowlist (host/agent/tools/query-options.js) needs to preapprove a call
 * before it ever reaches the handler-side authorization above.
 *
 * @param {string} [serverName] - defaults to SDK_MCP_SERVER_NAME; callers
 *   should always pass the same name used to key the `mcpServers` option so
 *   the two can never name two different servers.
 * @param {string[]} [toolNames] - defaults to `adapterToolNames()`, itself
 *   derived from `TOOLS` — the same array `buildSdkTools()` registers
 *   from — so the default can never drift out of sync with what is actually
 *   registered on the server. Overridable only so tests can prove that
 *   default equals the live registry rather than a hand-typed copy of it.
 */
export function sdkQualifiedToolNames(serverName = SDK_MCP_SERVER_NAME, toolNames = adapterToolNames()) {
  return toolNames.map((name) => `mcp__${serverName}__${name}`);
}

/**
 * The inverse of `sdkQualifiedToolNames()`: map whatever name the SDK hands
 * a permission callback back to the legacy tool name every classifier in
 * host/agent/tools/mapping.js keys on ("computer", "javascript_tool", ...).
 *
 * This exists because the two sides of the approval boundary see the SAME
 * call under DIFFERENT names. The tool HANDLER knows its own registered
 * legacy name (`t.name` in `buildSdkTools()`), but `Options.canUseTool`
 * receives the SDK-facing identifier, which for an MCP-served tool is the
 * fully-qualified `mcp__<server>__<tool>` form. Every classifier compares
 * against the legacy names by exact string equality
 * (`SEND_CLASS_TOOL_NAMES.includes(...)`, `legacyToolName === "computer"`),
 * so handing one a qualified name silently takes the "not a gated tool"
 * branch — the gate then auto-allows a call the handler independently
 * classifies as send-class, and the two disagree about the same bytes.
 *
 * Only a prefix whose suffix is a tool this adapter actually registers is
 * stripped, so this cannot map some other MCP server's identically-suffixed
 * tool onto this project's gate, and a name that is already legacy (or is a
 * builtin like "WebFetch") is returned untouched.
 *
 * @param {string} sdkToolName - the name as the SDK presented it.
 * @param {string[]} [toolNames] - defaults to `adapterToolNames()`, the same
 *   registry-derived array `sdkQualifiedToolNames()` uses, so the two can
 *   never disagree about which suffixes are ours.
 * @returns {string} the legacy tool name, or `sdkToolName` unchanged.
 */
export function legacyToolNameFromSdkName(sdkToolName, toolNames = adapterToolNames()) {
  if (typeof sdkToolName !== "string" || sdkToolName.length === 0) return "";
  if (toolNames.includes(sdkToolName)) return sdkToolName;
  if (!sdkToolName.startsWith("mcp__")) return sdkToolName;
  const suffix = sdkToolName.slice(sdkToolName.lastIndexOf("__") + 2);
  return toolNames.includes(suffix) ? suffix : sdkToolName;
}

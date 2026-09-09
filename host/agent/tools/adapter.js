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
  // The SAME hint rule as the gate (can-use-tool.js resolveHintFor): an
  // explicitly provided hint is used as-is, otherwise classification is
  // hintless. Gate and dispatch must never disagree about what evidence a
  // call carries — in live traffic the SDK input carries no hint either
  // way, so both sides are hintless and identical by construction.
  const hint = args?.targetHint && typeof args.targetHint === "object" ? args.targetHint : null;
  const classification = classifySendClassCall(legacyToolName, args, hint);
  if (classification.verdict !== "approve-known" && classification.verdict !== "approve-unknown") {
    return { ok: true, granted: false };
  }
  if (typeof run.consumeApprovalGrant !== "function") {
    return { ok: false, reason: "approval grants unsupported by this run" };
  }
  const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs(legacyToolName, args));
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

export function buildSdkTools({ toolBridge, coerceArgs, run }) {
  return TOOLS.map((t) =>
    tool(t.name, SDK_DESCRIPTIONS.get(t.name) ?? t.description, t.paramShape, async (args) => {
      const coerced = coerceArgs({ ...(args ?? {}) });
      try {
        authorizeToolCall({
          toolName: t.name,
          args: coerced,
          runState: run.state,
          leaseHeldByThisRun: run.leaseHeldByThisRun(),
          tabScope: run.tabScope,
          uploadAllowlist: run.uploadAllowlist,
          knownToolNames: KNOWN_TOOL_NAMES
        });
        // Second, additive gate (design.md 5b): even a call
        // authorizeToolCall above already approved (in-scope, run active,
        // lease held) can still be a mutation against a borrowed tab, which
        // needs its own explicit authorization — see mapping.js.
        //
        // Task 9.3 (design 9d): automatically authorize the borrowed tab
        // for interaction once it is legitimately in scope — for the
        // automatic action set ONLY: `computer`'s non-submit-classified
        // actions and `form_input`. This mirrors how "Live current-page
        // reading" already authorizes reading a borrowed tab without a
        // confirmation. `javascript_tool` is deliberately EXCLUDED (design
        // 9d): the shared per-tab flag has no notion of which tool asked,
        // so granting it for typing would silently also authorize a later
        // navigating script. A `javascript_tool` call against a borrowed
        // tab keeps requiring its own authorization (10.4), which this
        // change does not add.
        if (_isAutoAuthorizeEligible(t.name, coerced)) {
          for (const tabId of _tabIdsForArgs(t.name, coerced)) {
            if (isBorrowedTab(run, tabId) && !isBorrowedTabMutationAuthorized(run, tabId)) {
              authorizeBorrowedTabMutation(run, tabId);
            }
          }
        }
        // 3.3/3.4: a genuinely approved send-class `computer` call carries
        // the user's explicit Allow for THIS exact call (proven by the grant
        // consumed below) — that Allow IS the explicit task authorization
        // the borrowed-tab read-only default waits for, so it lifts the
        // default for this dispatch. `javascript_tool` is deliberately
        // EXCLUDED: the borrowed-tab scripting restriction stays rejected
        // regardless of any approval text (spec "Borrowed-tab JavaScript" —
        // enforced by enforceBorrowedTabScope below, which still throws for
        // unscripted-borrowed-tab calls).
        //
        // 3.4 pre-dispatch revalidation: for send-class-shaped calls, a
        // single-use approval grant for THESE EXACT normalized arguments
        // must have been recorded by the Allow path (canUseTool) — otherwise
        // the evidence is stale (or the gate was bypassed) and nothing
        // dispatches. Non-send calls skip this entirely. Verification runs
        // here, AFTER the run-state/lease/scope checks above and BEFORE
        // enforceBorrowedTabScope below, so the lift and the restriction
        // compose in the right order.
        if (t.name === "computer" || t.name === "javascript_tool") {
          const preDispatch = verifyPreDispatchApproval({ run, legacyToolName: t.name, args: coerced });
          if (!preDispatch.ok) {
            run.recordRejectedDispatch?.(t.name, coerced, { reason: "stale_approval", detail: { dispatchReason: preDispatch.reason } });
            return staleApprovalErrorResult(preDispatch.reason);
          }
          if (preDispatch.granted && t.name === "computer") {
            for (const tabId of _tabIdsForArgs(t.name, coerced)) {
              if (isBorrowedTab(run, tabId) && !isBorrowedTabMutationAuthorized(run, tabId)) {
                authorizeBorrowedTabMutation(run, tabId);
              }
            }
          }
        }
        enforceBorrowedTabScope({ run, legacyToolName: t.name, args: coerced });
      } catch (err) {
        if (err instanceof AuthorizationError) {
          run.recordRejectedDispatch?.(t.name, coerced, err);
          return authorizationErrorResult(err);
        }
        if (err instanceof BorrowedTabMutationError) {
          run.recordRejectedDispatch?.(t.name, coerced, { reason: "borrowed_tab_mutation", detail: { tabId: err.tabId } });
          return borrowedTabMutationErrorResult(err);
        }
        throw err;
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

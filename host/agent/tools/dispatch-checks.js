// The unconditional host-side checks EVERY browser dispatch must pass,
// extracted from host/agent/tools/adapter.js so a second decision engine can
// call the exact same gate instead of a copy of it
// (openspec/changes/add-typesafe-jev-provider design.md decision 7: "Dispatch
// discipline is single-sourced ... two implementations of a security gate
// drift, and the drift would be invisible until a protected action dispatched
// ungated"). The adapter imports from here; the Jev runtime
// (host/agent/jev/runtime.js) calls the same functions.
//
// Everything in this file was MOVED here unchanged from adapter.js — the
// checks, their order, their comments, and their failure results are the
// behavior-preserving part; only the module boundary is new. The registry's
// tool-name set is derived here from the same host/tool-definitions.js TOOLS
// data the adapter derives its exported set from, so the two can never
// disagree about which names exist.

import { authorizeToolCall, AuthorizationError } from "../policy/authorization.js";
import { TOOLS } from "../../tool-definitions.js";
import {
  enforceBorrowedTabScope,
  BorrowedTabMutationError,
  isBorrowedTab,
  isBorrowedTabMutationAuthorized,
  isSendClassCall,
  classifySendClassCall,
  classifyBrowserBatch,
  normalizeApprovalArgs,
  fingerprintNormalizedArgs,
  authorizeBorrowedTabMutation
} from "./mapping.js";

// Same derivation as adapter.js's exported KNOWN_TOOL_NAMES, from the same
// registry array — this is the registry, not a second list of tools.
const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

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
 * before the dispatch reaches the browser. Verifies:
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
export function runHostSideChecks({ run, legacyToolName, args, sendClassTool }) {
  try {
    const authz = authorizeToolCall({
      toolName: legacyToolName,
      args,
      runState: run.state,
      leaseHeldByThisRun: run.leaseHeldByThisRun(),
      tabScope: run.tabScope,
      uploadAllowlist: run.uploadAllowlist,
      knownToolNames: KNOWN_TOOL_NAMES,
      targetHint: args?.targetHint && typeof args.targetHint === "object" ? args.targetHint : null
    });
    // Protected-action backstop (task 2.1): a protected call dispatches
    // only under a fresh decision — a consumed single-use grant (a card the
    // user just approved) or a gate verdict the mode resolver recorded for
    // this exact call. No mode, remembered decision, or preapproval reaches
    // past this point: the resolver never returns "proceed" for protected
    // calls, so neither artifact legitimately exists without a decision.
    // Send-class tools peek instead of consuming (verifyPreDispatchApproval
    // below spends the artifact); every other tool spends it here, since
    // nothing later will.
    if (authz.protectedCategory) {
      const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs(legacyToolName, args));
      let covered = false;
      if (sendClassTool) {
        covered =
          (typeof run.hasApprovalGrant === "function" && run.hasApprovalGrant(fingerprint)) ||
          (typeof run.hasGateVerdict === "function" && run.hasGateVerdict(fingerprint));
      } else if (typeof run.consumeApprovalGrant === "function") {
        covered = run.consumeApprovalGrant(fingerprint).ok;
        if (!covered && typeof run.consumeGateVerdict === "function") {
          covered = run.consumeGateVerdict(fingerprint).ok;
        }
      }
      if (!covered) {
        run.recordRejectedDispatch?.(legacyToolName, args, { reason: "protected_requires_decision", detail: { protectedCategory: authz.protectedCategory } });
        return { ok: false, result: staleApprovalErrorResult(`protected:${authz.protectedCategory} requires a fresh decision`) };
      }
    }
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

export function firstTextOf(result) {
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
export function checkBrowserBatchHostSide({ run, args }) {
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

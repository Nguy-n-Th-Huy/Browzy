// `canUseTool` callback implementation for send/submit-class gating
// (design.md section 8 / task 9.2).
//
// Per the SDK's own docstring (sdk.d.ts:203-208): "Return `null` ONLY after
// the consumer has already sent the control_response out-of-band... Fail-
// closed: an accidental null means no response is sent and the tool stays
// blocked indefinitely." This module never returns null: every code path
// resolves either `{behavior:'allow', ...}` or `{behavior:'deny', ...}`.
//
// Behavior (upgrade-agent-reliability-and-workflows 3.1-3.4):
//   0. For a `WebFetch` call, classify its URL via
//      `./webfetch-url-guard.js`'s `classifyWebFetchUrl()` and resolve
//      `{behavior:'deny', message}` or `{behavior:'allow'}` immediately —
//      this is a local, already-known answer (not a user decision), so it
//      never issues an approval token and never emits `approval_request`.
//   1. Resolve target evidence (the `resolveHint` bridge stage — a ref the
//      bridge never resolves stays unresolved) and classify via mapping.js's
//      registry-derived tri-state `classifySendClassCall()`:
//      `allow` resolves `{behavior:'allow'}` with no prompt; `deny` resolves
//      `{behavior:'deny', message}` locally with no panel card (nothing
//      coherent to approve).
//   2. For an approve-known/approve-unknown call:
//      a. Issue an `ApprovalRegistry` token via
//         `run.issueApproval(action, target, { binding })` — bound to run,
//         domain, document identity, execution nonce, normalized
//         tool/action/arguments fingerprint, target evidence, observed
//         state, and credential revision, not just run/action/target.
//         Approve-unknown cards name their unknown fields in the action
//         text so the panel shows them with no panel change.
//      b. Emit a sequenced `approval_request` stream event so the panel can
//         render the card (this event survives a reconnect via TranscriptStore).
//      c. Suspend resolution pending the panel's matching `approval_decision`
//         or the bound 5-minute timeout (the registry's `defaultTtlMs`).
//   3. On `approve`: re-verify the token INCLUDING the 3.3 binding (domain,
//      document, args, state, nonce, credential drift all fail closed here)
//      and resolve `{behavior:'allow'}` — plus record a single-use
//      pre-dispatch grant the tool handler consumes immediately before
//      dispatch (3.4), so Allow cannot dispatch stale evidence.
//   4. On `deny`: resolve `{behavior:'deny', message}` with a user-legible
//      reason.
//   5. On timeout: resolve `{behavior:'deny', message}` with a distinguishable
//      timeout reason (NEVER null, NEVER an indefinite hang).
//   6. On Stop (the run is stopped, which calls
//      `approvals.invalidateForRun()` synchronously) or scope change
//      (`approvals.invalidateAll()`) or credential revocation, the token
//      becomes `unknown_token`; the next consume attempt returns
//      `unknown_token` so we resolve deny with a distinguishable reason.
//   7. Approval controls live in the panel ONLY: this module emits
//      `approval_request` stream events and consumes `approval_decision`
//      replies; the controlled-page overlay is observe-only by construction
//      (extension/overlay/pointer-overlay.js carries no Allow/Deny control)
//      and page/skill content can never mint, resolve, or consume a token.
//
// The callback is created per-run (binding to one Run + ApprovalRegistry +
// one event emitter + one "decision resolver" hooked to the wire).

import {
  classifySendClassCall,
  classifyBrowserBatch,
  legacyNameFor,
  normalizeApprovalArgs,
  fingerprintNormalizedArgs,
  resolveTargetEvidence,
  stableStringify,
  hashString
} from "../tools/mapping.js";
import { classifyWebFetchUrl, readWebFetchUrl } from "./webfetch-url-guard.js";
import { legacyToolNameFromSdkName } from "../tools/adapter.js";

/**
 * Mint a single-execution nonce for one approval (3.3). Bound into the
 * registry entry at issue and re-required at consume: an approval granted
 * for one execution cannot be replayed as another even within its TTL
 * (the registry token's own single-use already gives this; the explicit
 * nonce makes the binding visible in evidence and independently checkable).
 */
function mintExecNonce() {
  return `xn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build a `canUseTool` callback bound to a specific run.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run
 * @param {import("../policy/approvals.js").ApprovalRegistry} deps.approvals
 * @param {object} deps.requestIdTracker - holds pending approval promises keyed
 *   by requestId, so the wire-side `approval_decision` handler can resolve one.
 *   Must implement `set(requestId, resolverFn, token)`,
 *   `take(requestId)` returning `{ resolverFn, token } | undefined`,
 *   and `clearRun(runId)` to reject everything in-flight for a stop/scope change.
 * @param {object} [deps.now] - injectable Date.now for tests
 * @param {Function} [deps.resolveHint] - 3.2 target-resolution stage:
 *   `async (toolName, args, evidence) => targetHint | null`. Awaits the
 *   browser bridge's element registry (ref -> live metadata). The companion
 *   wires this to the `describe_ref` handler; omitting it (host tests) leaves
 *   refs unresolved and classification takes the conservative approve-unknown
 *   path instead of guessing. Leaving it unwired in PRODUCTION is what made
 *   every ref click demand approval while a guessed coordinate — strictly
 *   less evidence — was auto-allowed, so the resolver is not optional there.
 * @param {object} [deps.approvalContext] - 3.3 run-level evidence bound into
 *   every approval this callback issues: `{ domain, docIdentity,
 *   credentialRevision }`. Each PRESENT field is enforced on consume; absent
 *   fields are simply not bound (never fabricated — a host that cannot
 *   observe document identity does not invent one).
 * @returns {Function} a `canUseTool(toolContext) => Promise<PermissionResult>`
 *   suitable for assignment to `Options.canUseTool`
 */
export function createCanUseTool({ run, approvals, requestIdTracker, now = Date.now, resolveHint = null, approvalContext = {} }) {
  if (!run) throw new Error("createCanUseTool requires a run");
  if (!approvals) throw new Error("createCanUseTool requires approvals");
  if (!requestIdTracker) throw new Error("createCanUseTool requires requestIdTracker");

  // 3.2: the SDK passes the call's own input here, NOT a resolved element
  // hint — a `ref` in the input is a NAME, not evidence. When the caller
  // wired a bridge resolver, resolve it before classifying; otherwise the
  // hint stays null and the classifier takes the conservative unknown path.
  // The input may ALSO carry a `targetHint` field when the caller already
  // resolved one (tests, future adapter pass-through) — an explicitly
  // provided hint is used as-is and never re-resolved.
  async function resolveHintFor(toolName, args) {
    if (args && typeof args === "object" && args.targetHint && typeof args.targetHint === "object") {
      return args.targetHint;
    }
    const evidence = resolveTargetEvidence(toolName, args, null);
    if (typeof resolveHint === "function") {
      try {
        const hint = await resolveHint(toolName, args, evidence);
        if (hint && typeof hint === "object") return hint;
      } catch {
        // A failed resolution is unresolved evidence, not a classification
        // error — fall through to the null-hint (unknown) path.
      }
    }
    return null;
  }

  return async function canUseTool(...sdkArgs) {
    // The SDK calls this with POSITIONAL arguments — `(toolName, input,
    // context)` — not the single context object this function was written
    // against. Reading `.toolName`/`.input` off the first argument therefore
    // produced `undefined` and `{}` for every call: the classifier saw an
    // empty tool name (its "not a gated tool" branch, verdict `allow`) and
    // fingerprinted an empty args object, so ONE fingerprint stood for every
    // call in the run. The dispatch check, which sees the real name and args,
    // then computed a fingerprint that could never match the one recorded
    // here, and refused every ref click as "stale or bypassed gate" — while
    // the gate itself had waved the call through without ever knowing what it
    // was. Both shapes are accepted here so neither SDK convention can
    // silently reintroduce that.
    const toolContext =
      typeof sdkArgs[0] === "string"
        ? { toolName: sdkArgs[0], input: sdkArgs[1] ?? {}, ...(sdkArgs[2] && typeof sdkArgs[2] === "object" ? sdkArgs[2] : {}) }
        : sdkArgs[0] || {};
    // Per sdk.d.ts:209-262, the second parameter carries `toolName`, `input`,
    // and a `requestId`/`toolUseID`. The exact field name carrying the
    // SDK-side request id is `tool_use_id` or `requestId` depending on the
    // build; defensively check both. When neither is present we mint a
    // local requestId so the wire `approval_request`/`approval_decision`
    // correlation still has something to echo.
    const sdkRequestId = toolContext?.toolUseID || toolContext?.tool_use_id || toolContext?.requestId || `local_${now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Resolve the legacy tool name. The SDK-facing identifier for an
    // MCP-served tool is the fully-qualified `mcp__<server>__<tool>` form,
    // NOT the legacy name the classifiers below key on — and every one of
    // them compares by exact string equality, so a qualified name silently
    // takes their "not a gated tool" branch and auto-allows the call. The
    // tool handler (host/agent/tools/adapter.js) classifies the same call
    // under its registered legacy name, so without this normalization the
    // gate and the dispatch check disagree about identical bytes: the gate
    // never prompts and never records a grant, and the handler then refuses
    // to dispatch for want of one. A name that is already legacy, or a
    // builtin like "WebFetch", passes through untouched.
    const toolName = legacyToolNameFromSdkName(toolContext?.toolName || "");
    // Build args/input snapshot. The SDK passes the call's input here.
    const args = toolContext?.input ?? {};

    // === 0. WebFetch: local URL guard, decided synchronously, no panel ===
    // WebFetch is available (query-options.js's `tools`) but deliberately
    // never auto-approved (absent from `allowedTools`), so every call lands
    // here. Unlike the send-class approval flow below, this is NOT something
    // a user needs to weigh in on — the URL's host is either an ordinary
    // public address or it plainly is not, and that answer is already known
    // before the fetch. So this branch decides LOCALLY and returns
    // immediately: it never issues an approval token, never emits an
    // `approval_request` event, and never awaits a panel decision. See
    // ./webfetch-url-guard.js for exactly what this does and does not
    // protect against (name-based, pre-redirect — not a boundary against a
    // determined attacker who controls DNS or a redirect target).
    if (toolName === "WebFetch") {
      // Field-name extraction lives in the guard module so this branch and
      // the PreToolUse hook read the call the same way — two readers that
      // disagreed would mean one of them silently allowing what the other
      // denies.
      const verdict = classifyWebFetchUrl(readWebFetchUrl(args));
      if (!verdict.allowed) {
        return { behavior: "deny", message: verdict.reason };
      }
      return { behavior: "allow" };
    }

    // === browser_batch: the gate must see INSIDE the batch (add-browser-batch-tool) ===
    // A batch is one SDK call. Left to the generic path below it would be
    // classified as a whole — and because `browser_batch` is not a send-class
    // tool name, that whole would be `allow`, silently auto-approving every
    // item inside it, including the `computer`/`javascript_tool` actions this
    // gate exists to catch. So each item's own target hint is resolved (the
    // SAME bridge stage a standalone call uses) and each item is classified
    // with the SAME classifier. Any item that is not a plain `allow` — or a
    // nested batch — rejects the WHOLE batch before anything runs.
    //
    // A batch never raises a panel approval card. An action that needs the
    // user's decision was always going to cost its own round trip (the user
    // has to see a card and answer it), so hoisting it out of the batch costs
    // nothing batching was going to save; and a card bound to evidence from
    // BEFORE items 1..n ran would be a decision made on a stale description.
    if (toolName === "browser_batch") {
      const actions = Array.isArray(args?.actions) ? args.actions : [];
      const itemHints = [];
      for (const item of actions) {
        const itemLegacyName = legacyNameFor(item?.name);
        const itemInput = item?.input && typeof item.input === "object" ? item.input : {};
        itemHints.push(await resolveHintFor(itemLegacyName, itemInput));
      }
      const batch = classifyBrowserBatch(actions, itemHints);
      if (!batch.ok) {
        return { behavior: "deny", message: `Không thể thực thi batch: ${batch.reason}` };
      }
      // A clean batch. Record the gate's allow decision (single-use, keyed by
      // the batch's item-sensitive fingerprint) so the handler-side
      // pre-dispatch check honours this gate's per-item evidence — it has no
      // page access and would otherwise re-classify hintless and could reach
      // the opposite verdict for an item the gate resolved with a hint. This
      // is an "allow" verdict, never an approval grant: no send-class action
      // is authorized by it, because a batch containing one never gets here.
      run.recordGateVerdict?.(fingerprintNormalizedArgs(normalizeApprovalArgs("browser_batch", args)), "allow");
      return { behavior: "allow" };
    }

    // === 1. Classify === (3.1/3.2: registry-derived tri-state matrix with a
    // target-resolution stage — a non-send call is auto-allowed with no
    // prompt; a deny-verdict call is denied locally with no panel card)
    const targetHint = await resolveHintFor(toolName, args);
    const classification = classifySendClassCall(toolName, args, targetHint);
    const normalized = normalizeApprovalArgs(toolName, args);
    const normalizedArgs = fingerprintNormalizedArgs(normalized);
    if (classification.verdict === "allow") {
      // Record the verdict even though nothing is being approved. This gate
      // classifies WITH a resolved target hint (resolveHintFor above, which
      // dereferences a `ref` against the live page); the pre-dispatch check
      // in host/agent/tools/adapter.js has no page access and classifies
      // hintless. When the hint is what downgrades a call to non-send, the
      // two verdicts differ, and the handler would refuse to dispatch for
      // want of a grant this branch is precisely deciding it does not need.
      // The gate holds strictly more evidence, so its verdict is the one
      // that binds; recording it here is what lets the handler honour it
      // instead of re-deciding on less. Single-use, exactly like a grant:
      // one gate decision authorizes one dispatch, never a replay.
      run.recordGateVerdict?.(normalizedArgs, "allow");
      return { behavior: "allow" };
    }
    if (classification.verdict === "deny") {
      return { behavior: "deny", message: `Không thể phê duyệt hành động này (${classification.reason}). Hành động không được thực thi.` };
    }

    // === 2. Build the action/target descriptor and mint an approval token ===
    // 3.2/3.3: the card text carries the verdict's unknowns for
    // approve-unknown (visible unknown fields — the panel renders `action`
    // verbatim, so no panel change is needed for the unknowns to be seen),
    // and the token binds run + normalized tool/action/arguments fingerprint
    // + target evidence + observed state + run-level domain/document/
    // credential evidence + a fresh execution nonce + expiry.
    const action = buildActionDescriptor(toolName, args, classification);
    const target = buildTargetDescriptor(toolName, args, targetHint, classification);
    const observedState = `st_${hashString(stableStringify({ normalized, evidence: classification.evidence }))}`;
    const execNonce = mintExecNonce();
    const binding = {
      ...(approvalContext.domain != null ? { domain: approvalContext.domain } : {}),
      ...(approvalContext.docIdentity != null ? { docIdentity: approvalContext.docIdentity } : {}),
      ...(approvalContext.credentialRevision != null ? { credentialRevision: approvalContext.credentialRevision } : {}),
      execNonce,
      normalizedArgs,
      observedState
    };

    let token;
    try {
      token = run.issueApproval(action, target, { binding });
    } catch (err) {
      // The registry throws if runId or action are falsy — but a send-class
      // call always has both. Fail closed anyway.
      return { behavior: "deny", message: `internal error issuing approval token: ${err && err.message}` };
    }

    // === 3. Emit the approval_request stream event ===
    // The wire envelope carries the requestId (NOT the token), the action
    // descriptor, and the target. CompanionCore forwards this through its
    // event emitter (TranscriptStore handles persistence + reconnect replay).
    run.emit({
      type: "approval_request",
      requestId: sdkRequestId,
      action,
      target,
      // 3.2: the full classification evidence rides along for transcript/
      // debugging consumers; the panel card itself reads `action`/`target`
      // (unknowns are already rendered into the action text above).
      evidence: classification.evidence,
      ts: now()
    });

    // === 4. Suspend the SDK call pending a decision, with the registry's
    // TTL as the wait budget ===
    const ttlMs = approvals.defaultTtlMs;
    return await new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        requestIdTracker.take(sdkRequestId);
        // The token has expired by now (registry sweeps on issue); not used
        // further. Per design: never resolve `null`, never hang.
        resolve({ behavior: "deny", message: `Quá thời gian chờ cấp quyền (${Math.round(ttlMs / 1000)} giây). Hành động gửi/gửi-form chưa được phê duyệt.` });
      }, ttlMs);

      requestIdTracker.set(sdkRequestId, (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (decision && decision.decision === "approve") {
          // Verify the token before letting the call through. This catches
          // stop, scope change, credential revocation, replay, run
          // mismatch — and 3.3/3.4: domain/document/argument/state/nonce/
          // credential drift between Allow and now. On success, record the
          // single-use pre-dispatch grant the tool handler consumes
          // immediately before dispatch (3.4 — Allow cannot dispatch stale
          // evidence even inside the same run).
          const verify = run.consumeApproval(token, action, target, binding);
          if (verify.ok) {
            if (typeof run.recordApprovalGrant === "function") {
              run.recordApprovalGrant(normalizedArgs, { requestId: sdkRequestId, action, target });
            }
            resolve({ behavior: "allow" });
          } else {
            resolve({ behavior: "deny", message: `Phiếu phê duyệt không hợp lệ (${verify.reason}). Hành động không được thực thi.` });
          }
        } else if (decision && decision.decision === "deny") {
          resolve({ behavior: "deny", message: "Người dùng đã từ chối cấp quyền cho hành động này." });
        } else if (decision && decision.reason) {
          // An invalidation (stop/scope change/credential): the denial
          // reason tells the model and the transcript what actually happened.
          resolve({ behavior: "deny", message: decision.reason });
        } else {
          resolve({ behavior: "deny", message: "Quyết định phê duyệt không hợp lệ." });
        }
      }, token);
    });
  };
}

function buildActionDescriptor(toolName, args, classification = null) {
  const unknowns = classification?.evidence?.unknowns;
  const unknownSuffix = Array.isArray(unknowns) && unknowns.length ? ` — chưa rõ: ${unknowns.join("; ")}` : "";
  if (toolName === "computer") {
    const action = String(args?.action || "");
    if (action === "click" || action === "left_click" || action === "double_click" || action === "triple_click") {
      return `computer ${action} (submit-type control)${unknownSuffix}`;
    }
    if (action === "key") return `computer key (submit-type control)${unknownSuffix}`;
    return `computer ${action} (submit-type control)${unknownSuffix}`;
  }
  if (toolName === "javascript_tool") {
    return `javascript_tool form-submission script${unknownSuffix}`;
  }
  return toolName;
}

function buildTargetDescriptor(toolName, args, targetHint = null, classification = null) {
  const tabId = args?.tabId ?? args?.tab_id ?? null;
  const descriptor = tabId != null ? { tabId } : {};
  // 3.2: carry the resolved target evidence on the descriptor so the panel
  // card, the transcript replay, and the registry binding all see the same
  // ref/coordinate/verdict the classifier saw.
  if (args?.ref != null) descriptor.ref = args.ref;
  if (Array.isArray(args?.coordinate)) descriptor.coordinate = [...args.coordinate];
  if (targetHint && typeof targetHint === "object") {
    if (targetHint.accessibleName != null) descriptor.targetName = String(targetHint.accessibleName).slice(0, 120);
    if (targetHint.tagName != null) descriptor.targetTag = String(targetHint.tagName).slice(0, 40);
  }
  if (classification && classification.verdict !== "allow") descriptor.verdict = classification.verdict;
  return Object.keys(descriptor).length ? descriptor : null;
}

// ---- RequestIdTracker: small per-run holder for pending approval decisions --
//
// The wire-side handler in companion.js receives an `approval_decision`
// envelope and uses this to resolve the matching `canUseTool` promise. Stop
// and scope-change handlers iterate to reject every pending one.

export class RequestIdTracker {
  constructor() {
    // requestId -> { resolver: Function, token: string }
    this._pending = new Map();
  }
  set(requestId, resolver, token) {
    this._pending.set(requestId, { resolver, token });
  }
  take(requestId) {
    const entry = this._pending.get(requestId);
    if (entry) {
      this._pending.delete(requestId);
      return entry;
    }
    return undefined;
  }
  has(requestId) {
    return this._pending.has(requestId);
  }
  /**
   * Reject every pending decision for a run with a specific reason. Used by
   * stop, scope change, and credential revocation handlers.
   * @param {object} opts
   * @param {string} opts.reason - the denial message the SDK call resolves to
   */
  rejectAll({ reason }) {
    const taken = [...this._pending.values()];
    this._pending.clear();
    for (const { resolver } of taken) {
      try {
        resolver({ decision: "deny", reason });
      } catch {
        // a resolver that throws must not break the invalidation loop
      }
    }
    return taken.length;
  }
  size() {
    return this._pending.size;
  }
}

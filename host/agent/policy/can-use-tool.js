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
import { legacyToolNameFromSdkName, KNOWN_TOOL_NAMES } from "../tools/adapter.js";
import {
  classifyActionClass,
  resolveModeDecision,
  originFromContext,
  normalizeMode,
  REMEMBERABLE_CLASSES,
  ACTION_CLASSES
} from "./permission-modes.js";
import { matchSiteEntry, recordSiteEntry } from "./site-store.js";

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
 * @param {Function} [deps.policySnapshot] - `() => ({ mode, managed, sites })
 *   | null`. The companion supplies the latest extension-pushed permission
 *   snapshot (mode, local site entries, managed policy). Absent means an
 *   unconfigured install: Auto mode, no entries, no policy — today's
 *   behavior. (Task 7.6's finding/risk context on a decision card is
 *   delivered a different way — see the `approval_request` emit below.)
 * @param {Function} [deps.persistSiteEntry] - `({ origin, actionClass,
 *   decision }) => void | Promise<void>`. Persists a remembered decision the
 *   user explicitly asked to remember, into the local per-site store
 *   (site-store.js). Defaults to that store's own `recordSiteEntry` — the
 *   real writer, not a stub — so companion.js does not need to pass this at
 *   all in production: host/test/site-store.test.mjs's import-graph guard
 *   requires `recordSiteEntry` to be importable ONLY from this file (and
 *   tests), so the real persistence call lives HERE, called from the single
 *   sanctioned invocation site below (the approval-decision reply path),
 *   rather than in a companion-supplied callback that would itself have to
 *   import `recordSiteEntry` and violate that guard. Tests that must avoid
 *   touching disk pass their own no-op/spy here instead.
 * @returns {Function} a `canUseTool(toolContext) => Promise<PermissionResult>`
 *   suitable for assignment to `Options.canUseTool`
 */
export function createCanUseTool({
  run,
  approvals,
  requestIdTracker,
  now = Date.now,
  resolveHint = null,
  approvalContext = {},
  policySnapshot = null,
  persistSiteEntry = recordSiteEntry
}) {
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
    // === 0.5 Permission-mode resolution ===
    // Every call THIS ADAPTER REGISTERS is classified (read-only/mutating/
    // send/protected) and the active mode decides whether it needs a
    // decision — before the legacy send-class flow below, which now
    // implements the "decide" outcome. Auto mode reproduces the pre-change
    // gate entry by entry (proven by host/test/permission-modes.test.mjs),
    // so this stage is inert until a mode is chosen, a site is remembered,
    // or a policy is managed.
    //
    // A tool name this adapter never registered at all (a foreign MCP
    // server's identically-suffixed tool, or any other builtin this gate has
    // no opinion about) is not this gate's business: classifyActionClass()
    // treats an unrecognized NAME as a classification gap and resolves it to
    // protected, which is the right fail-closed answer for a gap in THIS
    // PROJECT'S OWN registry (task 1.2) but wrong here — nothing this
    // project registers would ever suspend a run for a tool it never even
    // offered the model. `KNOWN_TOOL_NAMES` (this project's own registry,
    // from adapter.js) gates whether the mode stage runs at all; an unknown
    // name skips straight to the legacy classification below, which already
    // resolves "allow" for anything outside SEND_CLASS_TOOL_NAMES.
    const isKnownTool = KNOWN_TOOL_NAMES.has(toolName);
    let actionClass = null;
    let modeTargetHint = null;
    let policy = {};
    let effectiveMode = "auto";
    let callOrigin = null;
    // Default for a tool the mode stage never classified (unknown to this
    // adapter): never rememberable, since nothing about it was ever decided
    // by this stage — read only where a card is actually built, which never
    // happens for a foreign tool (its classification resolves "allow").
    let modeDecision = { requiresDecision: false, outcome: "proceed", reason: "not-classified", rememberable: false };
    if (isKnownTool) {
      modeTargetHint = await resolveHintFor(toolName, args);
      actionClass = classifyActionClass(toolName, args, modeTargetHint);
      // A call the classifier itself finds undispatchable (a javascript_tool
      // call with the wrong action, or with no script source under any known
      // argument name) must resolve deny immediately. `resolveModeDecision`
      // has no "deny" outcome of its own — reaching it with a mutating class
      // that is secretly undispatchable would auto-proceed under Auto/Skip
      // (nothing to suspend for) or suspend Manual mode on a decision no
      // answer could ever make dispatchable. The legacy deny short-circuit
      // below (no approval token, no panel card) is what an undispatchable
      // call has always resolved to; mode resolution must not shadow it.
      if (actionClass.sendVerdict && actionClass.sendVerdict.verdict === "deny") {
        return { behavior: "deny", message: `Không thể phê duyệt hành động này (${actionClass.sendVerdict.reason}). Hành động không được thực thi.` };
      }
      policy = typeof policySnapshot === "function" ? policySnapshot() || {} : {};
      const managed = policy.managed && typeof policy.managed === "object" ? policy.managed : null;
      effectiveMode = (managed && managed.mode) || policy.mode || "auto";
      callOrigin = originFromContext(approvalContext);
      let siteMatch = null;
      if (callOrigin && REMEMBERABLE_CLASSES.includes(actionClass.class)) {
        const managedSites = Array.isArray(managed?.sites) ? managed.sites : [];
        const managedHit = matchSiteEntry(
          managedSites.map((s) => ({ ...s, source: "managed" })),
          callOrigin,
          actionClass.class
        );
        if (managedHit) {
          siteMatch = { decision: managedHit.decision, source: "managed" };
        } else if (Array.isArray(policy.sites)) {
          const localHit = matchSiteEntry(policy.sites, callOrigin, actionClass.class);
          if (localHit) siteMatch = { decision: localHit.decision, source: "local" };
        }
      }
      modeDecision = resolveModeDecision({
        actionClass: actionClass.class,
        protectedCategory: actionClass.protectedCategory,
        mode: effectiveMode,
        siteMatch,
        managed
      });
      const normalizedForMode = normalizeApprovalArgs(toolName, args);
      const normalizedArgsForMode = fingerprintNormalizedArgs(normalizedForMode);
      if (modeDecision.outcome === "refuse") {
        // A remembered (or managed) denial: refused without asking, with a
        // reason distinguishable in the transcript from a timeout and from a
        // fresh denial (task 3.5).
        return {
          behavior: "deny",
          message:
            modeDecision.reason === "managed-site-deny"
              ? "Administrator policy denies this action class on this site. The action was refused without asking."
              : "A remembered denial covers this action class on this site. The action was refused without asking."
        };
      }
      if (modeDecision.outcome === "proceed") {
        // Record the verdict like the legacy allow branch below, so the
        // handler-side pre-dispatch check can tell "the gate decided" apart
        // from "this call never passed the gate". Single-use, exactly like a
        // grant.
        run.recordGateVerdict?.(normalizedArgsForMode, "allow");
        if (modeDecision.reason === "remembered-allow" || modeDecision.reason === "managed-site-allow") {
          // The transcript must show a remembered decision resolved the call
          // rather than an unasked request (task 3.2) — without suspending
          // anything and without authorizing anything further.
          run.emit({
            type: "permission_note",
            requestId: sdkRequestId,
            resolution: modeDecision.reason,
            actionClass: actionClass.class,
            origin: callOrigin,
            ts: now()
          });
        }
        return { behavior: "allow" };
      }
    }
    // === 1. Classify (mode-aware) ===
    // The mode stage above already classified with the resolved hint; reuse
    // it rather than re-resolving. Protected calls carry their category
    // instead of a send verdict (never alongside) — the card flow below
    // names the category from it. A tool the mode stage skipped (unknown to
    // this adapter) falls straight to the legacy classifier, exactly as it
    // did before permission modes existed.
    const targetHint = modeTargetHint;
    const legacyVerdict = actionClass?.sendVerdict || classifySendClassCall(toolName, args, targetHint);
    // A REAL gap this stage must close, not just reproduce: `modeDecision`
    // above can say "decide" for a class the LEGACY send-class verdict alone
    // would call "allow" — every ordinary MUTATING call (e.g. `navigate`)
    // under Manual mode is exactly this, since `classifySendClassCall` has
    // no opinion on anything outside SEND_CLASS_TOOL_NAMES and defaults it to
    // "allow". Without this override, such a call would fall through
    // `classification.verdict === "allow"` a few lines below and dispatch
    // with NO decision ever raised — silently discarding the mode stage's
    // own "decide" outcome and leaving Manual mode's "every mutating action
    // SHALL require a decision" requirement unmet for exactly the calls that
    // are not already protected or send-class. (A genuine send-class call
    // needs no override: its OWN `legacyVerdict` is already
    // approve-known/approve-unknown, which already takes the suspend path
    // below.)
    const needsModeOverride = !!actionClass && modeDecision.outcome === "decide" && legacyVerdict.verdict === "allow";
    let classification;
    if (actionClass && actionClass.class === ACTION_CLASSES.PROTECTED) {
      classification = {
        verdict: "approve-known",
        reason: actionClass.gap
          ? `unclassified action treated as protected (${actionClass.gap})`
          : `protected:${actionClass.protectedCategory}`,
        evidence: resolveTargetEvidence(toolName, args, targetHint)
      };
    } else if (needsModeOverride) {
      classification = {
        verdict: "approve-known",
        reason: modeDecision.reason,
        evidence: resolveTargetEvidence(toolName, args, targetHint)
      };
    } else {
      classification = legacyVerdict;
    }
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
    const baseAction = buildActionDescriptor(toolName, args, classification);
    const target = buildTargetDescriptor(toolName, args, targetHint, classification);
    // Protected cards name their category (spec: the decision surface states
    // which protected category applies); classification gaps are reported on
    // the card itself, since the card is the surface that refuses to proceed
    // without a human.
    const isProtectedCard = !!actionClass && actionClass.class === ACTION_CLASSES.PROTECTED;
    const action = !isProtectedCard
      ? baseAction
      : `[protected:${actionClass.protectedCategory || "unclassified"}] ${baseAction}` +
        (actionClass.gap ? ` — classification gap: ${actionClass.gap}` : "");
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
      // Permission-policy context for the panel: which protected category
      // (null when not protected), whether this decision may be remembered,
      // and the deciding mode. Task 7.6's finding/risk context for the
      // acting tab is deliberately NOT carried here — the panel already
      // derives it live from its own `tab_risk_update` history
      // (ConversationModel.getTabRisk(target.tabId), consumed by
      // sidepanel.js's renderPermission()/viewRiskContext()), which reflects
      // the CURRENT category at render time rather than a value snapshotted
      // once at approval_request time. A `findingContext`/`riskContext`
      // pair used to be emitted here too, but nothing ever supplied or read
      // them (CompanionCore._permissionPolicySnapshot() never populated
      // `findingsByTab`/`riskByTab`, and the panel never looked for these
      // exact field names) — removed rather than wired up a second, always-
      // stale source of the same information.
      protectedCategory: isProtectedCard ? actionClass.protectedCategory || "unclassified" : null,
      rememberable: modeDecision.rememberable === true,
      mode: effectiveMode,
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
            // Remembering is offered only for decisions the mode permits to
            // be remembered, and recorded only when the user asks (task
            // 3.4): the reply's remember flag is the whole authority, and
            // this call site is the single sanctioned writer. A persist
            // failure never revokes the Allow just granted.
            if (decision.remember === true && modeDecision.rememberable === true && callOrigin && typeof persistSiteEntry === "function") {
              try {
                const maybe = persistSiteEntry({ origin: callOrigin, actionClass: actionClass.class, decision: "allow" });
                if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
              } catch {}
            }
            resolve({ behavior: "allow" });
          } else {
            resolve({ behavior: "deny", message: `Phiếu phê duyệt không hợp lệ (${verify.reason}). Hành động không được thực thi.` });
          }
        } else if (decision && decision.decision === "deny") {
          // A denial the user asked to remember is stored the same way an
          // allowance is; the refusal it reports stays a fresh denial —
          // remembered denials apply to LATER calls (task 3.5).
          if (decision.remember === true && modeDecision.rememberable === true && callOrigin) {
            try {
              const maybe = persistSiteEntry ? persistSiteEntry({ origin: callOrigin, actionClass: actionClass.class, decision: "deny" }) : null;
              if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
            } catch {}
          }
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

/**
 * Build a PreToolUse hook that closes the gap the SDK's own runtime warning
 * names verbatim (host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs):
 * "canUseTool will not be invoked for [bare allowedTools entries] ... Bare
 * allowedTools entries auto-approve the whole tool before the callback is
 * consulted. To gate every tool call, use a PreToolUse hook; or remove the
 * bare names from allowedTools so they fall through to canUseTool."
 *
 * query-options.js keeps every non-send-class browser tool (including
 * `form_input` and `gif_creator`) bare-listed in `allowedTools`, exactly as
 * task 9.1 fixed it — Auto mode must reproduce today's behavior byte for
 * byte, and shrinking that list per protected-capability or per-mode would
 * both preapprove *and* auto-approve two different things for the same tool
 * name depending on which call it is, which `allowedTools` cannot express at
 * its whole-tool granularity. This hook is the SDK-documented alternative:
 * it runs BEFORE `allowedTools` is consulted (hooks run first in the
 * permission pipeline — the same ordering the WebFetch guard hook in
 * webfetch-url-guard.js already relies on, where "a hook deny applies even
 * in bypassPermissions mode"), and forcing `permissionDecision: "ask"` here
 * routes the call through the exact same `can_use_tool` control_request
 * `canUseTool` answers for a call that was never bare-listed at all (per the
 * SDK's own PermissionDenied-event docstring: "With a permission prompt
 * surface (stdio/SDK canUseTool), the 'ask' path surfaces via a
 * can_use_tool control_request"). So a protected or Manual-mode-gated call
 * reaches the SAME interactive decision path a never-preapproved tool would,
 * without touching the `tools`/`allowedTools` arrays or the tests that pin
 * their exact contents for the default/Auto path.
 *
 * Two, and only two, cases force `ask`:
 *   1. The call classifies as protected (`ACTION_CLASSES.PROTECTED`) — under
 *      EVERY mode, unconditionally, per `detectProtectedCategory`'s
 *      `PROTECTED_CAPABLE_TOOLS` guard. This is what makes a `gif_creator`
 *      export with `download: true`, or a `form_input` call into a secret
 *      field, actually reach `canUseTool` (and therefore a real decision, and
 *      therefore an artifact `runHostSideChecks`' protected-action backstop
 *      in host/agent/tools/adapter.js can find) instead of being silently
 *      auto-approved and then permanently denied at dispatch for want of a
 *      grant nothing could ever have recorded.
 *   2. The call classifies as mutating OR send-class AND the live-read mode
 *      (see `policySnapshot` below) is "manual" — the spec's "every action
 *      classified as mutating SHALL require a decision" under Manual, made
 *      structurally possible for the first time: `buildIsolatedOptions`'s
 *      static `allowedTools` array cannot itself vary per call, so it alone
 *      could never satisfy Manual's per-call requirement no matter how it is
 *      computed at query() construction time. Send-class is included here
 *      too because `webmcp_call_tool` (SEND_CLASS_TOOL_NAMES) is, unlike
 *      `computer`/`javascript_tool`/`browser_batch`, bare-listed in
 *      `allowedTools` for its ordinary (Auto-safe, always approve-unknown)
 *      case — so without this branch it would stay silently preapproved
 *      under Manual exactly like an ordinary mutating call would.
 * Every other call (read-only always, send-class always — already routed
 * through canUseTool by staying out of `allowedTools`, mutating-non-protected
 * under Auto/Skip) resolves `{}` — no override, no added latency, identical
 * to this hook not existing.
 *
 * This hook classifies WITHOUT the bridge-resolved evidence a standalone
 * `computer`/`form_input` click would get inside `canUseTool` itself unless
 * `resolveHint` is supplied — supplying the SAME resolver companion.js wires
 * into `createCanUseTool` lets a credential-field `form_input` call be
 * correctly recognized as protected here too, so it never quietly stays
 * bare-approved on argument shape alone. A resolution failure or a missing
 * resolver falls back to the conservative unknown-hint path exactly like
 * `canUseTool`'s own resolver does — never a thrown error, and never treated
 * as evidence the call is safe.
 *
 * Fails OPEN on any internal error (returns `{}`, no override): a broken
 * hook must not interrupt the run (the SDK's own hooks guidance), and
 * failing to force `ask` here never opens a bypass on its own — the
 * unconditional protected-action backstop in host/agent/policy/
 * authorization.js still refuses to dispatch a protected call without a
 * recorded grant or gate verdict regardless of what this hook did or did not
 * do, so the worst a hook failure costs is a missed prompt that dispatch
 * still refuses, never a silent bypass.
 *
 * @param {object} [deps]
 * @param {Function} [deps.policySnapshot] - same shape/contract as
 *   `createCanUseTool`'s own `policySnapshot`: `() => ({ mode, managed, ... })
 *   | null`, read live on every call (never cached), so a mode change or a
 *   managed-policy change applies to the very next call. Absent means an
 *   unconfigured install: Auto mode, identical to today.
 * @param {Function} [deps.resolveHint] - same shape/contract as
 *   `createCanUseTool`'s own `resolveHint`: `async (toolName, args, evidence)
 *   => targetHint | null`.
 */
export function createPermissionModeGateHook({ policySnapshot = null, resolveHint = null } = {}) {
  return async function permissionModeGateHook(input) {
    try {
      const toolName = legacyToolNameFromSdkName(input?.tool_name || "");
      if (!KNOWN_TOOL_NAMES.has(toolName)) return {};
      const args = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
      const hookEventName = input?.hook_event_name || "PreToolUse";

      let targetHint = null;
      if (typeof resolveHint === "function") {
        try {
          const evidence = resolveTargetEvidence(toolName, args, null);
          const hint = await resolveHint(toolName, args, evidence);
          if (hint && typeof hint === "object") targetHint = hint;
        } catch {
          targetHint = null;
        }
      }

      const actionClass = classifyActionClass(toolName, args, targetHint);

      if (actionClass.class === ACTION_CLASSES.PROTECTED) {
        return {
          hookSpecificOutput: {
            hookEventName,
            permissionDecision: "ask",
            permissionDecisionReason: actionClass.protectedCategory
              ? `protected:${actionClass.protectedCategory} always requires a fresh decision`
              : `unclassified action treated as protected${actionClass.gap ? ` (${actionClass.gap})` : ""}`
          }
        };
      }

      if (actionClass.class === ACTION_CLASSES.MUTATING || actionClass.class === ACTION_CLASSES.SEND) {
        const policy = typeof policySnapshot === "function" ? policySnapshot() || {} : {};
        const managed = policy.managed && typeof policy.managed === "object" ? policy.managed : null;
        const mode = normalizeMode((managed && managed.mode) || policy.mode);
        if (mode === "manual") {
          return {
            hookSpecificOutput: {
              hookEventName,
              permissionDecision: "ask",
              permissionDecisionReason: "manual mode requires a decision for every mutating action"
            }
          };
        }
      }
      return {};
    } catch {
      return {};
    }
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

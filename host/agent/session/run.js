// One SDK run within a conversation: lifecycle, browser-lease membership,
// approval scope, and honest cancellation bookkeeping.
//
// A "run" is one query() invocation — from a user Send to that turn's model
// generation finishing, stopping, or being superseded by a new Send. A
// conversation can have at most one ACTIVE run at a time (spec: "prevent
// more than one active run per conversation"); further runs from other
// conversations queue on the shared browser lease
// (host/agent/broker/browser-lease.js), not here.

import { newRunId } from "../broker/browser-lease.js";
import { RunUploadAllowlist } from "../policy/authorization.js";

export const RUN_STATES = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  STOPPED: "stopped",
  DONE: "done"
});

export class Run {
  /**
   * @param {object} opts
   * @param {string} opts.conversationId
   * @param {import("../broker/browser-lease.js").BrowserLease} opts.lease
   * @param {import("../policy/approvals.js").ApprovalRegistry} opts.approvals
   * @param {Array<number>|'any'} [opts.tabScope]
   * @param {(event: object) => void} [opts.onEvent] - sink for transcript/event-log entries
   */
  /**
   * `releaseNativeLease` is the cross-process half of releasing the browser.
   * `lease` only serializes runs inside THIS companion; host/native-host.js
   * keeps its own NativeLeaseGuard so legacy MCP clients and the companion
   * cannot dispatch over each other. Without telling it a run is done, that
   * guard holds on until its 5-minute TTL and every other conversation is
   * refused with "Browser is busy" for up to five minutes after a run has
   * already finished — which is exactly what an operator hit in practice.
   * Injected rather than imported so a Run stays testable with no pipe.
   */
  constructor({ conversationId, lease, approvals, tabScope = "any", onEvent, releaseNativeLease }) {
    this.runId = newRunId();
    this.conversationId = conversationId;
    this.lease = lease;
    this.approvals = approvals;
    this.tabScope = tabScope;
    this.uploadAllowlist = new RunUploadAllowlist();
    this.state = RUN_STATES.QUEUED;
    this.abortController = new AbortController();
    this._releaseLease = null;
    this._releaseNativeLease = releaseNativeLease || (() => {});
    this._onEvent = onEvent || (() => {});
    this._unknownResults = [];
  }

  emit(event) {
    try {
      this._onEvent({ runId: this.runId, conversationId: this.conversationId, ...event });
    } catch {
      // event sink failures must never break run control flow
    }
  }

  /** Wait for (and hold) the shared browser lease. Resolves once this run may dispatch. */
  async begin() {
    this.emit({ type: "run_queued" });
    this._releaseLease = await this.lease.acquire({
      runId: this.runId,
      conversationId: this.conversationId,
      tabScope: this.tabScope
    });
    if (this.state === RUN_STATES.STOPPED) {
      // Stopped while still queued: release immediately, never actually run.
      this._releaseLease();
      this._releaseLease = null;
      return false;
    }
    this.state = RUN_STATES.RUNNING;
    // tabScope rides along so the extension can raise the remote-control
    // overlay the moment the run actually starts driving, rather than waiting
    // for the first dispatched tool that happens to name a tab. The run is
    // holding the browser lease for exactly these tabs from this line onward,
    // so this is a report of real state, not a prediction: see
    // extension/background.js's startOverlayForRun().
    this.emit({ type: "run_started", tabScope: this.tabScope });
    return true;
  }

  leaseHeldByThisRun() {
    const holder = this.lease.currentHolder();
    return !!holder && holder.runId === this.runId;
  }

  describeRequestForWire() {
    return this.lease.describeForWire(this.runId, this.conversationId, this.tabScope);
  }

  /**
   * Admit a tab this run opened itself into its own scope.
   *
   * The runtime spec authorizes "the authorized browser bridge and
   * session-owned tabs, the current tab bound at user submission, or
   * explicitly selected tabs". Only the middle clause was ever enforced:
   * tabScope was fixed at construction from what the panel sent at Send, and
   * nothing could extend it. So a tab the run opened via tabs_create_mcp was
   * rejected with tab_out_of_scope on every subsequent call, while the bound
   * page tab stayed read-only by design — leaving a run unable to reach a
   * second page at all, even though its own tool description tells the model
   * to create one.
   *
   * A session-owned tab is wholly the run's own: unlike a borrowed tab it may
   * be navigated, mutated and closed. Admitting it widens nothing else — only
   * ids this run actually created reach here (adapter.js, read from
   * tabs_create_mcp's real result), never a pre-existing tab of the user's.
   *
   * No-op when tabScope is already unrestricted ("any"). Idempotent.
   */
  admitSessionOwnedTab(tabId) {
    if (typeof tabId !== "number") return;
    if (!Array.isArray(this.tabScope)) return;
    if (this.tabScope.includes(tabId)) return;
    this.tabScope = [...this.tabScope, tabId];
    this.emit({ type: "tab_scope_extended", tabId, reason: "session_owned" });
  }

  /**
   * Stop: cancels model generation and blocks all further dispatch.
   * Does NOT touch an action already in flight — its eventual settlement
   * (real result, or a lost-response "result unknown") is reported as-is;
   * already executed browser effects are never represented as undone.
   */
  stop(reason = "user_stop") {
    if (this.state === RUN_STATES.STOPPED || this.state === RUN_STATES.DONE) return;
    this.state = RUN_STATES.STOPPED;
    this.approvals.invalidateForRun(this.runId);
    // 3.4: outstanding pre-dispatch grants die with the run too — an Allow
    // recorded a moment before Stop must never dispatch after it (the
    // handler-side run-state check already rejects those, this is the
    // belt-and-suspenders half).
    if (this._approvalGrants) this._approvalGrants.clear();
    try {
      this.abortController.abort();
    } catch {}
    this.emit({ type: "run_stopped", reason });
    this._releaseFromLease();
  }

  markDone() {
    if (this.state === RUN_STATES.STOPPED || this.state === RUN_STATES.DONE) {
      this._releaseFromLease();
      return;
    }
    this.state = RUN_STATES.DONE;
    this.emit({ type: "run_done" });
    this._releaseFromLease();
  }

  _releaseFromLease() {
    if (this._releaseLease) {
      this._releaseLease();
      this._releaseLease = null;
    } else {
      // Belt-and-suspenders: release by id even if we never captured the
      // closure (e.g. restored after a companion restart).
      this.lease.release(this.runId);
    }
    // Hand the shared bridge back too, so the next conversation (or a legacy
    // MCP client) can dispatch immediately instead of waiting out the native
    // guard's TTL. Best-effort by design — that TTL and socket-close cleanup
    // remain the backstop — so a failure here must never break run teardown.
    try {
      this._releaseNativeLease(this.runId);
    } catch {
      // see above: courtesy release only
    }
  }

  recordRejectedDispatch(toolName, args, err) {
    this.emit({ type: "tool_rejected", toolName, reason: err.reason, detail: err.detail });
  }

  recordResultUnknown(toolName, args, meta) {
    this._unknownResults.push({ toolName, requestId: meta?.requestId, at: Date.now() });
    this.emit({ type: "tool_result_unknown", toolName, requestId: meta?.requestId });
  }

  unknownResults() {
    return [...this._unknownResults];
  }

  issueApproval(action, target, opts = undefined, legacyTtlMs = undefined) {
    // 3.3: `opts` is either the new `{ binding, ttlMs }` object or a legacy
    // bare ttlMs number (the pre-3.3 positional form). Both keep working.
    let binding = null;
    let ttlMs = legacyTtlMs;
    if (typeof opts === "number") {
      ttlMs = opts;
    } else if (opts && typeof opts === "object") {
      binding = opts.binding ?? null;
      if (opts.ttlMs !== undefined) ttlMs = opts.ttlMs;
    }
    return this.approvals.issue({ runId: this.runId, action, target, ttlMs, binding });
  }

  consumeApproval(token, action, target, binding = null) {
    return this.approvals.consume(token, { runId: this.runId, action, target, binding });
  }

  // --- 3.4: pre-dispatch approval grants ----------------------------------
  //
  // The registry token above is consumed inside `canUseTool` at Allow time;
  // the actual browser dispatch happens later, in the tool handler
  // (host/agent/tools/adapter.js). Between the two, arguments, document,
  // domain, scope, nonce, or state may have changed — "Allow cannot dispatch
  // stale evidence". So a successful Allow ALSO records a single-use grant
  // keyed by the call's normalized-args fingerprint; the handler consumes
  // that grant immediately before dispatch. A grant consumed with a
  // different fingerprint (arguments swapped after Allow), twice (replay),
  // or never recorded (a handler invoked without passing the gate) fails
  // with a distinguishable reason instead of dispatching.
  recordApprovalGrant(fingerprint, info = {}) {
    if (!this._approvalGrants) this._approvalGrants = new Map();
    this._approvalGrants.set(fingerprint, { ...info, used: false });
  }

  consumeApprovalGrant(fingerprint) {
    const entry = this._approvalGrants ? this._approvalGrants.get(fingerprint) : undefined;
    if (!entry) return { ok: false, reason: "unknown_grant" };
    if (entry.used) return { ok: false, reason: "grant_replayed" };
    entry.used = true;
    return { ok: true, info: entry };
  }
  // Non-consuming presence checks for the protected-action backstop
  // (adapter.js): dispatch must verify a decision covers a protected call
  // without spending the single-use grant a later check consumes.
  hasApprovalGrant(fingerprint) {
    const entry = this._approvalGrants ? this._approvalGrants.get(fingerprint) : undefined;
    return !!entry && entry.used === false;
  }

  hasGateVerdict(fingerprint) {
    const entry = this._gateVerdicts ? this._gateVerdicts.get(fingerprint) : undefined;
    return !!entry && entry.used === false;
  }

  // A gate verdict that needed NO approval, recorded for the same reason a
  // grant is: so the dispatch-time check can tell "the gate decided this
  // call is not send-class" apart from "this call never passed the gate".
  //
  // The gate classifies with a resolved target hint the tool handler cannot
  // obtain (no page access at dispatch time). When that hint is what makes a
  // call non-send, the handler's own hintless classification reaches the
  // opposite verdict and refuses to dispatch for want of a grant the gate
  // deliberately did not mint. The gate holds strictly more evidence, so its
  // verdict binds; this records it. Single-use like a grant — one gate
  // decision authorizes one dispatch, so a replayed handler invocation still
  // finds nothing and is refused.
  recordGateVerdict(fingerprint, verdict) {
    if (!this._gateVerdicts) this._gateVerdicts = new Map();
    this._gateVerdicts.set(fingerprint, { verdict, used: false });
  }

  consumeGateVerdict(fingerprint) {
    const entry = this._gateVerdicts ? this._gateVerdicts.get(fingerprint) : undefined;
    if (!entry) return { ok: false, reason: "unknown_verdict" };
    if (entry.used) return { ok: false, reason: "verdict_replayed" };
    entry.used = true;
    return { ok: true, verdict: entry.verdict };
  }
}

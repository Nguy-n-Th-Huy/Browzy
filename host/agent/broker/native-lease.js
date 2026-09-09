// Cross-process browser-lease arbitration, as used by host/native-host.js.
//
// host/agent/broker/browser-lease.js serializes runs WITHIN one companion
// process (every SDK conversation for a bridge lives in that one process).
// This module is the other half: native-host.js is the one process every
// legacy MCP client (host/mcp-server.js, codemode, hybrid) and the companion
// actually share, so it is the only place that can arbitrate BETWEEN them —
// design.md decision 5d: "Arbitrate browser ownership at the shared bridge:
// concurrent callers must not silently interfere. If another connection owns
// control, return an explicit retryable busy tool error without dispatch."
//
// Deliberately opt-in and backward compatible: a `tool_request` that never
// carries a `runId` (every existing legacy client, and every existing test in
// host/test/ownership.test.mjs) never creates or is blocked by a lease AS
// LONG AS no lease is currently held. Only once some run has actually
// declared itself via a runId-bearing request does exclusivity kick in — at
// that point an anonymous request is also bounced, because it has no way to
// identify itself as the current holder. This is what makes "existing
// suites still pass unmodified" and "SDK run can exclude a concurrent legacy
// client" simultaneously true: nothing changes until an SDK run exists.

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

export class NativeLeaseGuard {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this._lease = null; // { clientId, runId, conversationId, expiresAt }
  }

  currentLease() {
    if (this._lease && Date.now() > this._lease.expiresAt) {
      this._lease = null;
    }
    return this._lease ? { ...this._lease } : null;
  }

  /**
   * Decide whether an inbound tool_request may be forwarded to the browser.
   * @returns {{ allow: true } | { allow: false, reason: string, heldBy: object }}
   */
  check({ clientId, runId, conversationId }) {
    const lease = this.currentLease();
    if (!lease) {
      if (runId) this._grant({ clientId, runId, conversationId });
      return { allow: true };
    }
    if (runId && lease.runId === runId) {
      // Same run refreshing its own lease: extend the TTL.
      this._grant({ clientId, runId, conversationId });
      return { allow: true };
    }
    if (lease.clientId === clientId && !runId) {
      // The lease holder's OWN socket making an untagged call (e.g. a
      // companion call that predates lease bookkeeping) is allowed through;
      // it is the same connection, not a competing one.
      return { allow: true };
    }
    return {
      allow: false,
      reason: "browser_busy",
      heldBy: { runId: lease.runId, conversationId: lease.conversationId }
    };
  }

  _grant({ clientId, runId, conversationId }) {
    this._lease = { clientId, runId, conversationId, expiresAt: Date.now() + this.ttlMs };
  }

  /** Explicit release, e.g. on run stop or browser switch. No-op if runId does not match the current holder. */
  release(runId) {
    if (this._lease && this._lease.runId === runId) this._lease = null;
  }

  /** A holder's socket disconnected — release unconditionally regardless of runId (connection loss). */
  releaseForClient(clientId) {
    if (this._lease && this._lease.clientId === clientId) this._lease = null;
  }
}

export function busyErrorMessage(heldBy) {
  return (
    `Browser is busy: another ${heldBy?.conversationId ? "conversation" : "connection"} ` +
    `currently owns the browser lease. This is retryable — wait for it to release and try again. ` +
    `Do not treat this as a permanent failure or attempt to bypass scope.`
  );
}

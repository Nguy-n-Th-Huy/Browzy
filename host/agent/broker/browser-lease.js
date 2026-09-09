// The single companion-wide browser lease.
//
// design.md decision 1: "Keep the existing single-active-browser behavior. A
// companion-wide lease serializes runs across conversations and legacy
// clients... Browser switching releases the lease, verifies the new host
// handshake, then reacquires context." And the spec's "Concurrent
// conversation" scenario: a second conversation is queued, not rejected,
// until the lease is released.
//
// This class is the IN-PROCESS half of that story: one companion process
// hosts every SDK conversation for the active bridge, so serializing across
// conversations is just an ordinary async queue here. The CROSS-process half
// (an external legacy MCP client contending with a run this companion owns)
// is arbitrated by host/native-host.js, which is the one process both sides
// actually share — see native-host.js's `lease_acquire`/`lease_release`
// handling. This module's `describeForWire()` produces the metadata that
// gets attached to that side of the protocol.

import crypto from "node:crypto";

export function newRunId() {
  return `run_${crypto.randomBytes(9).toString("hex")}`;
}
export function newRequestId() {
  return `req_${crypto.randomBytes(9).toString("hex")}`;
}

/**
 * @param {Array<number>|'any'} tabScope
 * @param {number} tabId
 */
export function isTabInScope(tabScope, tabId) {
  if (tabScope === "any") return true;
  if (!Array.isArray(tabScope)) return false;
  return tabScope.includes(tabId);
}

export class BrowserLease {
  /**
   * @param {object} [opts]
   * @param {string} opts.browserIdentity - installation/profile connection id
   *   of the currently attached browser (never a model-provided name — see
   *   design.md decision 1's "Distinguish browser instances with
   *   installation/profile connection IDs, not a model-provided display
   *   name.").
   */
  constructor(opts = {}) {
    this.browserIdentity = opts.browserIdentity ?? null;
    this._holder = null; // { runId, conversationId, tabScope, acquiredAt }
    this._queue = []; // [{ runId, conversationId, tabScope, resolve }]
  }

  isHeld() {
    return this._holder !== null;
  }

  currentHolder() {
    return this._holder ? { ...this._holder } : null;
  }

  setBrowserIdentity(id) {
    this.browserIdentity = id;
  }

  /**
   * Request the lease for a run. Resolves immediately if free; otherwise
   * queues (FIFO) and resolves once released. Returns a release() function
   * bound to this specific grant so a caller can never accidentally release
   * someone else's grant.
   */
  acquire({ runId, conversationId, tabScope = "any" }) {
    if (!runId) throw new Error("acquire requires runId");
    return new Promise((resolve) => {
      const grant = () => {
        this._holder = { runId, conversationId, tabScope, acquiredAt: Date.now() };
        resolve(() => this._release(runId));
      };
      if (!this._holder) {
        grant();
        return;
      }
      this._queue.push({ runId, conversationId, tabScope, grant });
    });
  }

  _release(runId) {
    if (!this._holder || this._holder.runId !== runId) return; // not the current holder: no-op
    this._holder = null;
    const next = this._queue.shift();
    if (next) next.grant();
  }

  /** Explicit release by runId, for a caller that did not keep the closure (e.g. after a crash/restore). */
  release(runId) {
    this._release(runId);
  }

  // Browser switching (design.md: "Browser switching releases the lease,
  // verifies the new host handshake, then reacquires context") drops
  // whoever currently holds it and clears the queue — a stale queued run
  // must re-request against the new browser identity/tab scope rather than
  // being silently granted context that no longer matches what it asked for.
  releaseForBrowserSwitch(newBrowserIdentity) {
    this._holder = null;
    const waiters = this._queue.splice(0, this._queue.length);
    this.browserIdentity = newBrowserIdentity;
    return waiters.map((w) => ({ runId: w.runId, conversationId: w.conversationId }));
  }

  queuedRunIds() {
    return this._queue.map((w) => w.runId);
  }

  /** Metadata attached to every tool_request this run makes, per design.md's
   *  "Every request carries run ID, conversation ID, browser identity, tab
   *  scope and unique request ID." */
  describeForWire(runId, conversationId, tabScope) {
    return {
      runId,
      conversationId,
      browserIdentity: this.browserIdentity,
      tabScope,
      requestId: newRequestId()
    };
  }
}

// Approval tokens: bound to exact action/target/run, expiring on stop or
// scope change, never reusable by webpage content.
//
// design.md decision 5: "Approval tokens bind exact action/target/run,
// expire on stop or scope change, and are never reusable by webpage
// content." A token issued for one permission decision must not silently
// authorize a different tool, a different tab, or a later run — the whole
// point is that a model cannot stretch one human "yes" further than the
// human actually agreed to, and that nothing on a page can hand itself an
// approval it was never given.

import crypto from "node:crypto";

export function newApprovalToken() {
  return `appr_${crypto.randomBytes(16).toString("hex")}`;
}

export class ApprovalRegistry {
  constructor(opts = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 5 * 60_000;
    this._tokens = new Map(); // token -> { runId, action, target, expiresAt, used, binding }
  }

  /**
   * @param {object} spec
   * @param {string} spec.runId
   * @param {string} spec.action - exact tool/action name this token authorizes
   * @param {object} spec.target - exact target (e.g. { tabId, ref }) this token authorizes
   * @param {number} [spec.ttlMs]
   * @param {object} [spec.binding] - upgrade-agent-reliability-and-workflows
   *   3.3 evidence binding. Every field is optional; each PRESENT field is
   *   enforced on consume, each ABSENT field is not compared (so pre-3.3
   *   callers that issue run/action/target only keep working unchanged):
   *   - domain: expected page domain (hostname) at dispatch
   *   - docIdentity: { tabId, generation?, docNonce?, url? } — minimum
   *     document identity; any present sub-field must match
   *   - execNonce: single-execution nonce minted for this approval; must
   *     match exactly (replay with a different nonce fails)
   *   - normalizedArgs: fingerprint (fingerprintNormalizedArgs) of the
   *     normalized tool/action/arguments at Allow time
   *   - observedState: fingerprint of the observed target/element state
   *   - credentialRevision: credential revision the approval was granted
   *     under (a rotation/revocation between Allow and dispatch fails)
   */
  issue({ runId, action, target, ttlMs, binding }) {
    if (!runId || !action) throw new Error("issue requires runId and action");
    this._sweepExpired();
    const token = newApprovalToken();
    this._tokens.set(token, {
      runId,
      action,
      target: target ?? null,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
      used: false,
      binding: binding && typeof binding === "object" ? { ...binding } : null
    });
    return token;
  }

  /**
   * Verify (and, on success, consume) a token against the exact action/target
   * of the call attempting to use it. A token is single-use: consuming it
   * once for its bound action prevents replay against a second dispatch even
   * within its TTL.
   *
   * 3.3: when the issued entry carries a `binding`, each present binding
   * field is compared against the caller's `binding` argument with a
   * specific mismatch reason (domain_mismatch, document_replaced,
   * nonce_mismatch, args_mismatch, state_changed, credential_mismatch).
   * Omitting a bound field at consume time is itself a mismatch (fail
   * closed) — a caller cannot shed a binding by simply not repeating it.
   */
  consume(token, { runId, action, target, binding }) {
    const entry = this._tokens.get(token);
    if (!entry) return { ok: false, reason: "unknown_token" };
    if (entry.used) return { ok: false, reason: "already_used" };
    if (Date.now() > entry.expiresAt) {
      this._tokens.delete(token);
      return { ok: false, reason: "expired" };
    }
    if (entry.runId !== runId) return { ok: false, reason: "run_mismatch" };
    if (entry.action !== action) return { ok: false, reason: "action_mismatch" };
    if (!targetsMatch(entry.target, target)) return { ok: false, reason: "target_mismatch" };
    if (entry.binding) {
      const mismatch = compareBinding(entry.binding, binding);
      if (mismatch) return { ok: false, reason: mismatch };
    }
    // Mark used rather than delete: a replay attempt against the SAME
    // token must be told "already_used" (a meaningfully different signal
    // from "unknown_token", e.g. for diagnosing a webpage trying to reuse a
    // captured token) instead of looking like it never existed.
    entry.used = true;
    return { ok: true };
  }

  /** Stop invalidates every outstanding approval for that run. */
  invalidateForRun(runId) {
    for (const [token, entry] of this._tokens) {
      if (entry.runId === runId) this._tokens.delete(token);
    }
  }

  /** Scope change (e.g. browser switch, tab scope narrowed) invalidates everything outstanding. */
  invalidateAll() {
    this._tokens.clear();
  }

  // Opportunistic cleanup so a long-lived companion does not accumulate
  // used/expired tokens forever; called on every issue() rather than on a
  // timer, since a companion with no activity needs no cleanup.
  _sweepExpired() {
    const now = Date.now();
    for (const [token, entry] of this._tokens) {
      if (entry.used || now > entry.expiresAt) this._tokens.delete(token);
    }
  }

  isValid(token) {
    const entry = this._tokens.get(token);
    return !!entry && !entry.used && Date.now() <= entry.expiresAt;
  }
}

function targetsMatch(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a !== "object" || typeof b !== "object" || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

/**
 * Compare an issued 3.3 binding against the binding presented at consume
 * time. Each field the ISSUE side bound must be present and equal on the
 * consume side; fields neither side bound are skipped. Returns a specific
 * mismatch reason string, or null when everything bound matches.
 */
function compareBinding(issued, presented) {
  const p = presented && typeof presented === "object" ? presented : {};
  if (issued.domain != null && p.domain !== issued.domain) return "domain_mismatch";
  if (issued.execNonce != null && p.execNonce !== issued.execNonce) return "nonce_mismatch";
  if (issued.normalizedArgs != null && p.normalizedArgs !== issued.normalizedArgs) return "args_mismatch";
  if (issued.observedState != null && p.observedState !== issued.observedState) return "state_changed";
  if (issued.credentialRevision != null && p.credentialRevision !== issued.credentialRevision) return "credential_mismatch";
  if (issued.docIdentity != null) {
    const d = p.docIdentity;
    if (!d || typeof d !== "object") return "document_replaced";
    for (const field of ["tabId", "generation", "docNonce", "url"]) {
      if (issued.docIdentity[field] != null && d[field] !== issued.docIdentity[field]) return "document_replaced";
    }
  }
  return null;
}

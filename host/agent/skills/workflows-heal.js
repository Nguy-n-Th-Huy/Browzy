// Heal proposals: propose → approve → save, never a silent rewrite
// (openspec/changes/add-workflow-materialization-and-heal — design.md
// decisions 5/7, spec "Healing proposes a new version and never rewrites
// silently").
//
// A repair of a drifted workflow is a PROPOSED new version, not an edit:
// the assistant inspects the live site with ordinary tools and offers a
// candidate definition; the stored definition stays untouched until the
// operator explicitly approves, and the approval rides the registry's
// existing updateWorkflow version bump so the previous version remains
// addressable for rollback. Nothing in this module can apply a proposal:
// it owns the review object, the bounded expiry, and the supersede rule;
// the SAVE is a single updateWorkflow call made by the caller after this
// module resolved the decision (see companion.js's _handleWorkflowHealDecide).
//
// Proposals are in-memory, deliberately: they are conversation-scoped review
// objects with a ten-minute life, and their durable record is the transcript
// event family (workflow_heal_proposed / _saved / _rejected / _expired /
// _superseded). A companion restart therefore drops a pending proposal
// instead of resurrecting a decision surface the operator can no longer see
// the evidence for — the panel restores cards from the EVENTS, and an
// orphaned card resolves to the host's refusal (unknown_proposal), which is
// the honest outcome.

import crypto from "node:crypto";

import { validateWorkflowRecord, WorkflowValidationError } from "./workflows-schema.js";

/** Ten minutes: long enough to read the evidence and decide, short enough
 *  that a stale card never outlives the drift it addresses by much. */
export const HEAL_PROPOSAL_TTL_MS = 10 * 60_000;

/** How often the lazy sweep runs while a proposal is pending. Bounded by
 *  design: the sweep only exists so an unanswered proposal resolves to a
 *  distinguishable `workflow_heal_expired` record even if the operator never
 *  touches it again. */
export const HEAL_SWEEP_INTERVAL_MS = 30_000;

export const HEAL_PROPOSAL_STATES = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  EXPIRED: "expired",
  SUPERSEDED: "superseded"
});

export const HEAL_REASON_MAX_CHARS = 500;
const HEAL_EVIDENCE_MAX_BYTES = 4096;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lineKey(owner, workflowId) {
  return `${owner}/${workflowId}`;
}

function boundedEvidence(evidence) {
  if (evidence === undefined || evidence === null) return null;
  const text = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  return typeof text === "string" ? text.slice(0, HEAL_EVIDENCE_MAX_BYTES) : null;
}

/**
 * Validate a candidate heal against the SAME registry validation every
 * authored or imported definition passes (spec: "validated by the same
 * registry validation as any authored or imported workflow"). A candidate
 * that would smuggle in an unsupported step kind, an auto-approve field, or
 * an undeclared parameter template is rejected here with the schema's own
 * errors — never partially applied.
 *
 * @returns {{ ok: true, steps: Array } | { ok: false, errors: Array<{code, message}> }}
 */
export function validateHealCandidate({ current, steps }) {
  if (!current) return { ok: false, errors: [{ code: "MISSING_FIELD", message: "no workflow record to heal" }] };
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, errors: [{ code: "MISSING_FIELD", message: "a healed definition must declare a nonempty steps array" }] };
  }
  let validated;
  try {
    validated = validateWorkflowRecord({ ...current, steps, createdAt: current.createdAt, updatedAt: current.updatedAt });
  } catch (err) {
    if (err instanceof WorkflowValidationError) return { ok: false, errors: [{ code: err.code, message: err.message }] };
    throw err;
  }
  if (JSON.stringify(validated.steps) === JSON.stringify(current.steps)) {
    // A proposal identical to what is already stored cannot fix anything
    // (design.md decision 7: "heal only when needed"). Refused with its own
    // error rather than saved as a no-op version bump.
    return {
      ok: false,
      errors: [{ code: "NO_CHANGE", message: "the proposed steps are identical to the stored definition; nothing to heal" }]
    };
  }
  return { ok: true, steps: validated.steps };
}

/**
 * The provenance a saved heal carries: the previous provenance history plus
 * the version it heals and the drift evidence it addresses (frozen
 * contract). `healedFrom` is the proposal's base version — the version the
 * assistant actually diagnosed against — so the record names the healed
 * version even after later edits.
 */
export function buildHealProvenance({ current, baseVersion, reason, evidence, proposedAt }) {
  return {
    ...(isPlainObject(current && current.provenance) ? current.provenance : {}),
    healedFrom: baseVersion,
    healReason: typeof reason === "string" ? reason.slice(0, HEAL_REASON_MAX_CHARS) : "",
    healEvidence: boundedEvidence(evidence),
    proposedAt: proposedAt || new Date().toISOString()
  };
}

/**
 * The in-memory proposal registry: one live proposal per (owner, id) line, a
 * new one superseding the pending one, bounded expiry, and a lazy sweep.
 */
export class HealProposalStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] - bounded proposal lifetime
   * @param {number} [opts.sweepIntervalMs] - 0 disables the interval (tests drive sweep() directly)
   * @param {() => number} [opts.now]
   * @param {(proposal: object) => void} [opts.onExpire] - called once per
   *   proposal whose expiry the store observed, so the companion can append
   *   the `workflow_heal_expired` event for that conversation
   */
  constructor({ ttlMs = HEAL_PROPOSAL_TTL_MS, sweepIntervalMs = HEAL_SWEEP_INTERVAL_MS, now = Date.now, onExpire = null } = {}) {
    this.ttlMs = ttlMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this._now = now;
    this._onExpire = onExpire;
    this._proposals = new Map(); // proposalId -> proposal
    this._lines = new Map(); // owner/id -> proposalId (the live one)
    this._timer = null;
  }

  /**
   * Register a candidate proposal. A pending proposal for the same line is
   * SUPERSEDED (never silently applied, never silently dropped): it is
   * returned so the caller records `workflow_heal_superseded`.
   *
   * @returns {{ proposal: object, superseded: object|null, expired: object|null }}
   */
  propose({ conversationId, workflowId, owner, baseVersion, steps, reason, evidence, enabled }) {
    const now = this._now();
    // Resolve any earlier pending proposal FIRST, so an expiry that lands
    // between two proposals is recorded before the supersede.
    const expired = this.sweep(now);
    const key = lineKey(owner, workflowId);
    const previousId = this._lines.get(key);
    const previous = previousId ? this._proposals.get(previousId) : null;
    let superseded = null;
    if (previous && previous.status === HEAL_PROPOSAL_STATES.PENDING) {
      previous.status = HEAL_PROPOSAL_STATES.SUPERSEDED;
      previous.resolvedAt = new Date(now).toISOString();
      superseded = { ...previous };
    }
    const proposalId = `heal_${crypto.randomBytes(8).toString("hex")}`;
    const proposal = {
      proposalId,
      conversationId: conversationId || null,
      workflowId,
      owner,
      baseVersion,
      steps: Array.isArray(steps) ? steps : [],
      reason: typeof reason === "string" ? reason.slice(0, HEAL_REASON_MAX_CHARS) : "",
      evidence: boundedEvidence(evidence),
      // The record's enabled state AT PROPOSAL TIME, kept for the review
      // surface. It is deliberately NOT what the approval applies: the save
      // carries the record's CURRENT state, so a workflow the operator
      // disabled while the card was open stays disabled (design.md edge
      // cases: "enablement state is unchanged by the save").
      enabled: enabled !== false,
      status: HEAL_PROPOSAL_STATES.PENDING,
      proposedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      resolvedAt: null,
      supersededBy: null
    };
    if (superseded) {
      previous.supersededBy = proposalId;
      proposal.supersededProposalId = previousId;
    }
    this._proposals.set(proposalId, proposal);
    this._lines.set(key, proposalId);
    this._armSweep();
    return { proposal: { ...proposal }, superseded, expired };
  }

  get(proposalId) {
    const proposal = this._proposals.get(proposalId);
    return proposal ? { ...proposal } : null;
  }

  /** The line's live (pending) proposal, if any. */
  pendingForLine(owner, workflowId) {
    const proposalId = this._lines.get(lineKey(owner, workflowId));
    const proposal = proposalId ? this._proposals.get(proposalId) : null;
    return proposal && proposal.status === HEAL_PROPOSAL_STATES.PENDING ? { ...proposal } : null;
  }

  size() {
    return this._proposals.size;
  }

  /**
   * Settle one decision. The caller performs the actual save; this decides
   * whether the decision still applies, and why not when it does not.
   *
   * @returns {{ ok: true, proposal: object }
   *          | { ok: false, reason: "unknown_proposal"|"expired"|"superseded"|"already_decided", state: object, expiredProposal?: object }}
   */
  resolve({ proposalId, decision }) {
    const now = this._now();
    const proposal = this._proposals.get(proposalId);
    if (!proposal) return { ok: false, reason: "unknown_proposal", state: { status: "unknown", proposalId } };
    if (proposal.status === HEAL_PROPOSAL_STATES.EXPIRED) {
      return { ok: false, reason: "expired", state: { status: proposal.status, proposalId, expiresAt: proposal.expiresAt } };
    }
    if (proposal.status === HEAL_PROPOSAL_STATES.SUPERSEDED) {
      // Reported with its own reason (and the replacement named) rather than
      // collapsed into `unknown_proposal`: the panel's own copy for a
      // superseded card is "đã được thay thế", and a refusal that cannot tell
      // the operator WHY the decision was late is not a diagnosable one.
      return {
        ok: false,
        reason: "superseded",
        state: { status: proposal.status, proposalId, supersededBy: proposal.supersededBy || null }
      };
    }
    if (proposal.status !== HEAL_PROPOSAL_STATES.PENDING) {
      // A late second decision on an already-settled proposal: refused with
      // the decision that actually happened disclosed, so the panel can show
      // "already decided" instead of a misleading success.
      return {
        ok: false,
        reason: "unknown_proposal",
        state: { status: proposal.status, proposalId, resolvedAt: proposal.resolvedAt }
      };
    }
    if (now >= Date.parse(proposal.expiresAt)) {
      const expired = this._expire(proposal, now);
      return {
        ok: false,
        reason: "expired",
        state: { status: proposal.status, proposalId, expiresAt: proposal.expiresAt },
        expiredProposal: expired
      };
    }
    proposal.status = decision === "deny" ? HEAL_PROPOSAL_STATES.REJECTED : HEAL_PROPOSAL_STATES.APPROVED;
    proposal.resolvedAt = new Date(now).toISOString();
    this._disarmSweepIfIdle();
    return { ok: true, proposal: { ...proposal }, decision: decision === "deny" ? "deny" : "allow" };
  }

  /**
   * Put an APPROVED proposal back to pending after the save it authorized
   * failed (a disk error, a schema rejection at write time). Without this the
   * operator's only decision surface would be burnt by a failure that was not
   * theirs — the approval was legitimate, the write was not, and the
   * proposal stays decidable instead of becoming "unknown".
   */
  reopen(proposalId) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal || proposal.status !== HEAL_PROPOSAL_STATES.APPROVED) return null;
    proposal.status = HEAL_PROPOSAL_STATES.PENDING;
    proposal.resolvedAt = null;
    this._armSweep();
    return { ...proposal };
  }

  /**
   * Mark one proposal (and every other pending one) whose lifetime ended.
   * Called by the interval below and directly by tests; the returned list is
   * exactly what the caller must record as `workflow_heal_expired`.
   */
  sweep(now = this._now()) {
    const expired = [];
    for (const proposal of this._proposals.values()) {
      if (proposal.status !== HEAL_PROPOSAL_STATES.PENDING) continue;
      if (now < Date.parse(proposal.expiresAt)) continue;
      expired.push(this._expire(proposal, now));
    }
    this._disarmSweepIfIdle();
    return expired;
  }

  _expire(proposal, now) {
    proposal.status = HEAL_PROPOSAL_STATES.EXPIRED;
    proposal.resolvedAt = new Date(now).toISOString();
    const snapshot = { ...proposal };
    try {
      if (this._onExpire) this._onExpire(snapshot);
    } catch {
      // The durable record must never be the reason a decision path throws.
    }
    return snapshot;
  }

  _armSweep() {
    if (this._timer || !this.sweepIntervalMs) return;
    this._timer = setInterval(() => {
      try {
        this.sweep();
      } catch {}
    }, this.sweepIntervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  _disarmSweepIfIdle() {
    if (!this._timer) return;
    for (const proposal of this._proposals.values()) {
      if (proposal.status === HEAL_PROPOSAL_STATES.PENDING) return;
    }
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Stop the sweep timer (companion teardown, tests). */
  dispose() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Test-only. */
  _clearForTests() {
    this.dispose();
    this._proposals.clear();
    this._lines.clear();
  }
}

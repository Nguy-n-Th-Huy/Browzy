// Versioned recording-attachment protocol (tasks.md 6.1/6.3/6.4, design.md
// decision 5): the two-phase claim `selected -> attached -> submitted ->
// included|unknown|failed`.
//
// The existing pending channel (storage/pending-recordings.js) stays
// reference-only. This module is the durable claim state: the panel selects
// one IDLE conversation and sends an idempotency key; the companion
// atomically claims the pending reference, verifies ownership/path/schema/
// integrity, persists the state, and only then removes it from pending.
// The next model turn may report `included` only after the scoped
// model-readable delivery path (recording-content.js) succeeds.
//
// Crash/cancel leaves `submitted` or `unknown` until reconciled — those
// states survive a companion restart because this file is the durable
// record, not memory. A lease/conversation race returns the existing
// idempotent result or an explicit conflict, never a duplicate claim.
// Completion with no active run reconciles to the SELECTED owner (the claim
// recorded here) rather than routing to an arbitrary run.

import fs from "node:fs";
import path from "node:path";

import { agentRoot, ensureDir } from "./paths.js";

export const RECORDING_ATTACHMENT_SCHEMA_VERSION = 1;

export const RECORDING_ATTACHMENT_STATES = Object.freeze({
  SELECTED: "selected",
  ATTACHED: "attached",
  SUBMITTED: "submitted",
  INCLUDED: "included",
  UNKNOWN: "unknown",
  FAILED: "failed"
});

const TERMINAL_STATES = new Set([
  RECORDING_ATTACHMENT_STATES.INCLUDED,
  RECORDING_ATTACHMENT_STATES.UNKNOWN,
  RECORDING_ATTACHMENT_STATES.FAILED
]);

function atomicWriteJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function recordingAttachmentsFile() {
  return path.join(agentRoot(), "recordings", "attachments.json");
}

function transition(record, to, reason = null) {
  record.state = to;
  record.updatedAt = Date.now();
  record.history.push({ state: to, at: record.updatedAt, reason });
  return record;
}

export class RecordingAttachmentsStore {
  /** @param {object} [opts] @param {string} [opts.file] - override for tests */
  constructor(opts = {}) {
    this.file = opts.file || recordingAttachmentsFile();
  }

  _readAll() {
    const data = readJsonSafe(this.file, {});
    return data && typeof data === "object" ? data : {};
  }

  _writeAll(all) {
    atomicWriteJson(this.file, all);
  }

  get(idempotencyKey) {
    return this._readAll()[String(idempotencyKey)] || null;
  }

  /**
   * Phase 1 — select: the panel names one idle conversation for one finished
   * recording. Idempotent by key: the same key with the same
   * recording+conversation returns the existing record; the same key with a
   * DIFFERENT recording or conversation is an explicit conflict, never a
   * silent overwrite (race safety).
   */
  select({ recordingId, conversationId, idempotencyKey }) {
    const key = String(idempotencyKey ?? "");
    const recId = String(recordingId ?? "");
    const convId = String(conversationId ?? "");
    if (!key) throw new Error("recording attachment idempotencyKey is required");
    if (!recId) throw new Error("recording attachment recordingId is required");
    if (!convId) throw new Error("recording attachment conversationId is required");
    const all = this._readAll();
    const existing = all[key];
    if (existing) {
      if (existing.recordingId !== recId || existing.conversationId !== convId) {
        return { ok: false, reason: "attachment_key_conflict", record: existing };
      }
      return { ok: true, idempotent: true, record: existing };
    }
    const now = Date.now();
    const record = {
      schemaVersion: RECORDING_ATTACHMENT_SCHEMA_VERSION,
      idempotencyKey: key,
      recordingId: recId,
      conversationId: convId,
      state: RECORDING_ATTACHMENT_STATES.SELECTED,
      createdAt: now,
      updatedAt: now,
      integrity: null,
      deliveryEvidence: null,
      history: [{ state: RECORDING_ATTACHMENT_STATES.SELECTED, at: now, reason: null }]
    };
    all[key] = record;
    this._writeAll(all);
    return { ok: true, idempotent: false, record };
  }

  /**
   * Phase 1 — attach: atomically verify and claim. `verify` is an injected
   * async/sync predicate `({recordingId, conversationId}) ->
   * {ok:true, integrity}|{ok:false, reason}` checking pending-reference
   * existence, conversation ownership/idleness, path, schema, and integrity.
   * `consumePending(recordingId)` removes the pending reference and runs
   * ONLY after the attached state is durably persisted.
   */
  async attach(idempotencyKey, { verify, consumePending } = {}) {
    const all = this._readAll();
    const record = all[String(idempotencyKey)];
    if (!record) return { ok: false, reason: "attachment_unknown_key" };
    if (record.state !== RECORDING_ATTACHMENT_STATES.SELECTED) {
      return TERMINAL_STATES.has(record.state) || record.state === RECORDING_ATTACHMENT_STATES.ATTACHED || record.state === RECORDING_ATTACHMENT_STATES.SUBMITTED
        ? { ok: true, idempotent: true, record }
        : { ok: false, reason: `attachment_unexpected_state:${record.state}` };
    }
    let verdict = { ok: true, integrity: null };
    if (typeof verify === "function") verdict = await verify({ recordingId: record.recordingId, conversationId: record.conversationId });
    if (!verdict || !verdict.ok) {
      transition(record, RECORDING_ATTACHMENT_STATES.FAILED, (verdict && verdict.reason) || "attach_verification_failed");
      this._writeAll(all);
      return { ok: false, reason: record.history[record.history.length - 1].reason, record };
    }
    record.integrity = verdict.integrity || null;
    transition(record, RECORDING_ATTACHMENT_STATES.ATTACHED, null);
    this._writeAll(all);
    if (typeof consumePending === "function") {
      try {
        await consumePending(record.recordingId);
      } catch {
        // The claim is already durably attached; a pending-list removal
        // failure must never roll the claim back (that would re-offer an
        // owned recording). The stale pending entry is reconciled on next
        // list (see SessionManager.claimPendingRecording).
      }
    }
    return { ok: true, idempotent: false, record };
  }

  /**
   * Phase 2 — submit: the next model turn picked this recording up for
   * delivery. Only from `attached` (re-submitting an already submitted
   * record is idempotent, never a duplicate delivery request).
   */
  markSubmitted(idempotencyKey) {
    const all = this._readAll();
    const record = all[String(idempotencyKey)];
    if (!record) return { ok: false, reason: "attachment_unknown_key" };
    if (record.state === RECORDING_ATTACHMENT_STATES.SUBMITTED) return { ok: true, idempotent: true, record };
    if (record.state !== RECORDING_ATTACHMENT_STATES.ATTACHED) {
      return { ok: false, reason: `attachment_unexpected_state:${record.state}` };
    }
    transition(record, RECORDING_ATTACHMENT_STATES.SUBMITTED, null);
    this._writeAll(all);
    return { ok: true, idempotent: false, record };
  }

  /**
   * Phase 2 outcome — delivery acknowledgement (tasks.md 6.4: "Include
   * recording content in the next model turn only after successful
   * submission and delivery acknowledgement"). `evidence` describes exactly
   * which scoped tool/content blocks carried the data; without it the row
   * becomes `unknown`, never `included` (verify: transcript `included` is
   * impossible without model-input evidence).
   */
  markIncluded(idempotencyKey, evidence = null) {
    const all = this._readAll();
    const record = all[String(idempotencyKey)];
    if (!record) return { ok: false, reason: "attachment_unknown_key" };
    if (record.state === RECORDING_ATTACHMENT_STATES.INCLUDED) return { ok: true, idempotent: true, record };
    // Reconciliation: an `unknown` row (crash/cancel/evidence-less attempt)
    // may still resolve to `included` once REAL delivery evidence arrives —
    // "leaves submitted or unknown until reconciled" means exactly this.
    // Anything that never submitted (selected/attached) still cannot skip
    // the submission phase, and a `failed` row never becomes included.
    if (record.state !== RECORDING_ATTACHMENT_STATES.SUBMITTED && record.state !== RECORDING_ATTACHMENT_STATES.UNKNOWN) {
      return { ok: false, reason: `attachment_unexpected_state:${record.state}` };
    }
    if (!evidence || typeof evidence !== "object") {
      transition(record, RECORDING_ATTACHMENT_STATES.UNKNOWN, "inclusion_without_evidence");
      this._writeAll(all);
      return { ok: false, reason: "inclusion_without_evidence", record };
    }
    record.deliveryEvidence = evidence;
    transition(record, RECORDING_ATTACHMENT_STATES.INCLUDED, null);
    this._writeAll(all);
    return { ok: true, idempotent: false, record };
  }

  markUnknown(idempotencyKey, reason = "delivery_outcome_unknown") {
    const all = this._readAll();
    const record = all[String(idempotencyKey)];
    if (!record) return { ok: false, reason: "attachment_unknown_key" };
    if (TERMINAL_STATES.has(record.state)) return { ok: true, idempotent: true, record };
    transition(record, RECORDING_ATTACHMENT_STATES.UNKNOWN, reason);
    this._writeAll(all);
    return { ok: true, idempotent: false, record };
  }

  markFailed(idempotencyKey, reason = "delivery_failed") {
    const all = this._readAll();
    const record = all[String(idempotencyKey)];
    if (!record) return { ok: false, reason: "attachment_unknown_key" };
    if (record.state === RECORDING_ATTACHMENT_STATES.INCLUDED) {
      return { ok: false, reason: "attachment_already_included" };
    }
    transition(record, RECORDING_ATTACHMENT_STATES.FAILED, reason);
    this._writeAll(all);
    return { ok: true, idempotent: false, record };
  }

  /** The non-terminal claim for this recording, if any (crash reconciliation). */
  findOpenClaimForRecording(recordingId) {
    const all = Object.values(this._readAll());
    return all.find((r) => r.recordingId === String(recordingId) && !TERMINAL_STATES.has(r.state)) || null;
  }

  /** Every claim owned by one conversation (panel status, deletion sweep). */
  listForConversation(conversationId) {
    return Object.values(this._readAll())
      .filter((r) => r.conversationId === String(conversationId))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  /** Remove every claim owned by a deleted conversation (no resurrection). */
  deleteForConversation(conversationId) {
    const all = this._readAll();
    let removed = 0;
    for (const key of Object.keys(all)) {
      if (all[key].conversationId === String(conversationId)) {
        delete all[key];
        removed += 1;
      }
    }
    if (removed) this._writeAll(all);
    return removed;
  }
}

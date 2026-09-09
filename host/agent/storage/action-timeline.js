// Host-side storage helpers for the action timeline (design.md decision 5c /
// task 5.10's host half). Two independent concerns live here:
//
//   1. `sanitizeActionEvent()` — validates and allowlist-copies ONE wire
//      event (built by extension/events/action-events.js's `buildEvent()`,
//      see reports/05-action-event-schema.md for the authoritative shape)
//      before it is ever persisted. This is deliberate defense in depth, not
//      a restatement of that schema's own redaction: `action-events.js`
//      already redacts typed-text/script-source content at the point of
//      emission, and this module does NOT undo that. What it adds is a
//      HOST-SIDE guarantee that holds even if the wire's own claim is wrong
//      (a bug, or a tampered/compromised extension build) — an event whose
//      own shape says "this action type can carry a secret" is re-redacted
//      here unconditionally when the wire's `redaction.applied` flag is not
//      already true, AND every field that ends up on disk is copied from an
//      explicit allowlist, so an unexpected extra field (e.g. a hypothetical
//      future bug that attaches raw tool `args` to an event) can never reach
//      storage no matter what produced it.
//
//   2. `PerStreamSeqTracker` — the reconnect-dedup half: action-events.js's
//      own contract is that `seq` is monotonic per `streamKey` and NEVER
//      reused (see that module's "Sequencing and dedup" section). This
//      tracker remembers the highest `seq` accepted per stream and rejects
//      anything at or below it, so a redelivered/replayed batch (a retried
//      native message, a companion restart racing an in-flight send) can
//      never create a duplicate row in the transcript.
//
//   3. `ActionArtifactStore` — persists a captured screenshot's actual bytes
//      under the conversation's own artifacts directory (already the
//      established location for SDK-run artifacts, and already covered by
//      TranscriptStore.deleteConversation()'s directory removal — recordings
//      live in a completely separate tree and are never touched by that).
//      Resolves a request by artifactId back to the EXACT stored bytes, or
//      an explicit "not found" — this module never substitutes a different
//      image and never re-captures anything (it does no browser I/O at all).

import fs from "node:fs";
import path from "node:path";

import { conversationArtifactsDir, ensureDir, assertSafeId } from "./paths.js";

// --- Sanitize + allowlist-copy one wire action event -----------------------

const KNOWN_KINDS = new Set(["start", "progress", "complete", "error"]);
const KNOWN_ACTION_TYPES = new Set([
  "open_page",
  "read",
  "find",
  "click",
  "hover",
  "scroll",
  "type",
  "wait",
  "drag",
  "capture",
  "script",
  "other"
]);
const KNOWN_OUTCOME_STATUSES = new Set(["success", "unknown", "error"]);

// The two argument shapes reports/05-action-event-schema.md documents as
// secret-bearing (typed text; executed script source). Mirrors that report's
// own "Redaction" section exactly — this is the same categorical rule,
// re-enforced independently rather than trusted from the wire.
const REDACTION_REQUIRED_ACTION_TYPES = new Set(["type"]);
const REDACTION_REQUIRED_TOOLS = new Set(["javascript_tool"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sanitizePointer(rawPointer) {
  if (rawPointer === null || rawPointer === undefined) return { ok: true, pointer: null };
  if (!isPlainObject(rawPointer) || !Array.isArray(rawPointer.points)) {
    return { ok: false, reason: "invalid_pointer" };
  }
  const points = rawPointer.points
    .filter((p) => isPlainObject(p) && typeof p.x === "number" && typeof p.y === "number")
    .map((p) => ({
      x: p.x,
      y: p.y,
      t: typeof p.t === "number" ? p.t : null,
      phase: typeof p.phase === "string" ? p.phase : null
    }));
  const frame = isPlainObject(rawPointer.frame)
    ? {
        frameId: typeof rawPointer.frame.frameId === "number" ? rawPointer.frame.frameId : 0,
        isMainFrame: rawPointer.frame.isMainFrame !== false
      }
    : { frameId: 0, isMainFrame: true };
  return { ok: true, pointer: { points, frame } };
}

function sanitizeCapture(rawCapture) {
  if (rawCapture === null || rawCapture === undefined) return { ok: true, capture: null };
  if (!isPlainObject(rawCapture) || typeof rawCapture.artifactId !== "string" || !rawCapture.artifactId) {
    return { ok: false, reason: "invalid_capture" };
  }
  return { ok: true, capture: { artifactId: rawCapture.artifactId } };
}

/**
 * Validate + allowlist-copy one raw wire action event into the exact shape
 * this store persists.
 * @returns {{ok: true, event: object} | {ok: false, reason: string}}
 */
export function sanitizeActionEvent(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_an_object" };
  if (raw.schemaVersion !== 1) return { ok: false, reason: "unsupported_schema_version" };
  if (!KNOWN_KINDS.has(raw.kind)) return { ok: false, reason: "unknown_kind" };
  if (typeof raw.streamKey !== "string" || !raw.streamKey) return { ok: false, reason: "missing_stream_key" };
  if (typeof raw.actionId !== "string" || !raw.actionId) return { ok: false, reason: "missing_action_id" };
  if (!Number.isInteger(raw.seq) || raw.seq < 1) return { ok: false, reason: "invalid_seq" };
  if (
    !isPlainObject(raw.action) ||
    !KNOWN_ACTION_TYPES.has(raw.action.type) ||
    typeof raw.action.tool !== "string" ||
    !raw.action.tool
  ) {
    return { ok: false, reason: "invalid_action" };
  }
  if (!isPlainObject(raw.timing) || typeof raw.timing.startedAt !== "number") {
    return { ok: false, reason: "invalid_timing" };
  }

  const pointerResult = sanitizePointer(raw.pointer);
  if (!pointerResult.ok) return pointerResult;
  // Never fabricate pointer motion for a non-pointer-capable action type —
  // the same enforcement extension/events/action-events.js's own
  // buildEvent() already applies, re-checked here independently.
  const POINTER_CAPABLE = new Set(["click", "hover", "scroll", "drag"]);
  if (pointerResult.pointer !== null && !POINTER_CAPABLE.has(raw.action.type)) {
    return { ok: false, reason: "pointer_not_allowed_for_action_type" };
  }

  const captureResult = sanitizeCapture(raw.capture);
  if (!captureResult.ok) return captureResult;

  let outcome = null;
  if (raw.kind === "complete" || raw.kind === "error") {
    if (!isPlainObject(raw.outcome) || !KNOWN_OUTCOME_STATUSES.has(raw.outcome.status)) {
      return { ok: false, reason: "missing_outcome" };
    }
    outcome = {
      // An "error" kind event can never be downgraded to a non-error status
      // by anything in `raw.outcome` — mirrors action-events.js's own
      // emitActionSettled() guarantee, re-enforced independently.
      status: raw.kind === "error" ? "error" : raw.outcome.status,
      detail: typeof raw.outcome.detail === "string" ? raw.outcome.detail.slice(0, 500) : null
    };
  } else if (raw.outcome !== null && raw.outcome !== undefined) {
    // start/progress events must never carry an outcome — a caller
    // reporting one here would be exactly the "successful dispatch treated
    // as proof of effect" bug this schema exists to prevent.
    return { ok: false, reason: "outcome_not_allowed_on_this_kind" };
  }

  // --- Redaction defence (see file header) --------------------------------
  const requiresRedaction =
    REDACTION_REQUIRED_ACTION_TYPES.has(raw.action.type) || REDACTION_REQUIRED_TOOLS.has(raw.action.tool);
  let summary = typeof raw.summary === "string" ? raw.summary.slice(0, 2000) : "";
  let redactionApplied = !!(raw.redaction && raw.redaction.applied === true);
  let redactionReason = redactionApplied && typeof raw.redaction.reason === "string" ? raw.redaction.reason : null;
  if (requiresRedaction && !redactionApplied) {
    // The wire claimed (or omitted) redaction for a shape this host
    // independently knows can carry a secret. Never trust it — replace the
    // summary with a generic, length-free placeholder instead of forwarding
    // whatever content arrived. This is the concrete, testable guarantee: a
    // secret-bearing payload cannot reach disk through this path even if the
    // producer that emitted it was buggy or compromised.
    summary = raw.action.type === "type" ? "Type (redacted)" : "Run page script (redacted)";
    redactionApplied = true;
    redactionReason = "host_enforced_redaction";
  }

  return {
    ok: true,
    event: {
      schemaVersion: 1,
      kind: raw.kind,
      seq: raw.seq,
      streamKey: raw.streamKey,
      runId: typeof raw.runId === "string" ? raw.runId : null,
      conversationId: typeof raw.conversationId === "string" ? raw.conversationId : null,
      requestId: typeof raw.requestId === "string" ? raw.requestId : null,
      actionId: raw.actionId,
      tabId: typeof raw.tabId === "number" ? raw.tabId : null,
      documentId: typeof raw.documentId === "string" ? raw.documentId : null,
      ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
      action: {
        type: raw.action.type,
        tool: raw.action.tool,
        op: typeof raw.action.op === "string" ? raw.action.op : null
      },
      timing: {
        startedAt: raw.timing.startedAt,
        endedAt: typeof raw.timing.endedAt === "number" ? raw.timing.endedAt : null
      },
      pointer: pointerResult.pointer,
      capture: captureResult.capture,
      summary,
      redaction: { applied: redactionApplied, reason: redactionReason },
      outcome
    }
  };
}

// --- Per-stream sequence dedup ---------------------------------------------

/**
 * Remembers the highest `seq` accepted per `streamKey` and rejects anything
 * at or below it. `seed()` lets a caller reconstruct this from already-
 * persisted history (e.g. after a companion restart) without trusting a
 * fresh, empty tracker to be correct — see SessionManager.recordActionEvents().
 */
export class PerStreamSeqTracker {
  constructor() {
    this._max = new Map();
  }
  seed(streamKey, seq) {
    if (typeof streamKey !== "string" || !Number.isInteger(seq)) return;
    const cur = this._max.get(streamKey) || 0;
    if (seq > cur) this._max.set(streamKey, seq);
  }
  /** @returns {boolean} true (and records it) if this seq is new for this stream. */
  accept(streamKey, seq) {
    const cur = this._max.get(streamKey) || 0;
    if (seq <= cur) return false;
    this._max.set(streamKey, seq);
    return true;
  }
  maxSeq(streamKey) {
    return this._max.get(streamKey) || 0;
  }
}

// --- Screenshot artifact bytes ----------------------------------------------

const EXT_BY_MIME = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
});

/**
 * Persists (and resolves) a captured screenshot's actual bytes under a
 * conversation's own artifacts directory, addressed by the exact artifactId
 * the capture event's `capture.artifactId` field names. Deliberately does no
 * network/browser I/O of any kind — `read()` either returns the bytes that
 * were genuinely stored for this id, or `{found:false}`. There is no code
 * path here that can substitute a different image or trigger a new capture.
 */
export class ActionArtifactStore {
  /**
   * @param {Buffer} buffer
   * @param {{mimeType?: string}} [opts]
   */
  write(conversationId, artifactId, buffer, opts = {}) {
    assertSafeId(artifactId, "artifactId");
    if (!Buffer.isBuffer(buffer)) throw new Error("ActionArtifactStore.write requires a Buffer");
    const mimeType = opts.mimeType || "image/jpeg";
    const ext = EXT_BY_MIME[mimeType] || "bin";
    const dir = ensureDir(conversationArtifactsDir(conversationId));
    const dataFile = path.join(dir, `${artifactId}.${ext}`);
    const metaFile = path.join(dir, `${artifactId}.meta.json`);
    const tmp = `${dataFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, dataFile);
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ artifactId, mimeType, ext, sizeBytes: buffer.length, storedAt: Date.now() })
    );
    return { artifactId, mimeType, sizeBytes: buffer.length };
  }

  /**
   * @returns {{found: true, mimeType: string, buffer: Buffer} | {found: false}}
   */
  read(conversationId, artifactId) {
    assertSafeId(artifactId, "artifactId");
    const dir = conversationArtifactsDir(conversationId);
    const metaFile = path.join(dir, `${artifactId}.meta.json`);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf-8"));
    } catch {
      return { found: false };
    }
    const dataFile = path.join(dir, `${artifactId}.${meta.ext || "bin"}`);
    let buffer;
    try {
      buffer = fs.readFileSync(dataFile);
    } catch {
      return { found: false };
    }
    return { found: true, mimeType: meta.mimeType || "application/octet-stream", buffer };
  }
}

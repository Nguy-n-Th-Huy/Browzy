// The shared action-event schema (design.md decision 5c / tasks 5.9, 5.10).
//
// ONE event stream describes every real browser action this extension
// dispatches, and is meant to be consumed by TWO independent, not-yet-built
// clients: the per-tab overlay (extension/overlay/**, Batch 2) and the
// companion-side action timeline (host/**, Batch 3). This module is the
// contract between them and the dispatch code in extension/background.js and
// extension/humanize/**. See reports/05-action-event-schema.md for the full,
// field-by-field specification — this file's job is to make that spec real
// and testable, not to restate it.
//
// PURE: nothing here touches chrome.*, CDP, or the DOM (same discipline as
// extension/humanize/index.js) — every function is plain, deterministic
// (given its inputs and, for IDs/timestamps, the ambient clock), and
// runnable in plain Node. background.js is the only place that wires this to
// real dispatch.
//
// THE INVARIANTS (see reports/05-action-event-schema.md for the full list):
//   - `start` is built and emitted BEFORE the action executes.
//   - `progress` is built ONLY from values a caller has ALREADY dispatched —
//     never from a plan, proposal, or anything not yet sent to the browser.
//   - `complete`/`error` are built ONLY from a caller's actual result/thrown
//     error — this module never guesses an outcome.
//   - Nothing in this module ever receives or stores raw typed text, raw
//     script source, or any other potentially secret-bearing payload — only
//     lengths and static labels. See `summarize()`.
//   - Every function here is synchronous and does no I/O, so wiring this
//     into a dispatch path can never add a delay, retry, or reordering.

// --- Schema version -----------------------------------------------------

export const SCHEMA_VERSION = 1;

// --- Event kinds ----------------------------------------------------------
//
// start:    emitted before the action's real dispatch begins.
// progress: emitted from values already sent to the browser (e.g. a batch of
//           real dispatched pointer coordinates). Never emitted for a
//           DOM/script-only action (see POINTER_ACTION_TYPES below).
// complete: emitted once, after the action's real executor result is known.
// error:    emitted once, after the action's real executor threw/rejected.
//
// Exactly one of {complete, error} is ever emitted per action, and only
// after {start}. `progress` may be emitted zero or more times in between.
export const EVENT_KINDS = Object.freeze({
  START: "start",
  PROGRESS: "progress",
  COMPLETE: "complete",
  ERROR: "error"
});

// --- Action taxonomy --------------------------------------------------
//
// Sufficient to render design.md 5c's example labels ("Opened page",
// "Finding link", "Clicked", "Waited 3 seconds", "Captured page", "Ran page
// script") plus the pointer-specific actions the visible-cursor requirement
// (spec.md "Visible agent pointer and control status") also needs (hover,
// drag). Labels/localization are a UI concern for the overlay/timeline
// (Batches 2/3) — this module exposes only the stable taxonomy KEY, in
// `action.type` below, plus the raw tool/op it was derived from so a
// renderer can localize without re-deriving the classification.
export const ACTION_TYPES = Object.freeze({
  OPEN_PAGE: "open_page", // navigate
  READ: "read", // read_page, get_page_text
  FIND: "find", // find
  CLICK: "click", // computer left_click/right_click/double_click/triple_click
  HOVER: "hover", // computer hover
  SCROLL: "scroll", // computer scroll/scroll_to
  TYPE: "type", // computer type/key
  WAIT: "wait", // computer wait
  DRAG: "drag", // computer left_click_drag
  CAPTURE: "capture", // computer screenshot/zoom
  SCRIPT: "script", // javascript_tool
  OTHER: "other" // everything else in the registry (tab/session management, etc.)
});

// Action types whose progress/complete events may legitimately carry a
// `pointer` field. Every other type MUST have `pointer: null` on every event
// it produces — this is the enforceable half of "never fabricate pointer
// motion for DOM/script-only calls" (spec.md "Visible agent pointer and
// control status": "Read-only extraction or page-script execution SHALL not
// fabricate mouse movement.").
export const POINTER_ACTION_TYPES = Object.freeze(
  new Set([ACTION_TYPES.CLICK, ACTION_TYPES.HOVER, ACTION_TYPES.SCROLL, ACTION_TYPES.DRAG])
);

export const OUTCOME_STATUSES = Object.freeze({
  SUCCESS: "success",
  UNKNOWN: "unknown",
  ERROR: "error"
});

// --- Action classification -------------------------------------------------

const COMPUTER_OP_TYPE = Object.freeze({
  screenshot: ACTION_TYPES.CAPTURE,
  zoom: ACTION_TYPES.CAPTURE,
  left_click: ACTION_TYPES.CLICK,
  right_click: ACTION_TYPES.CLICK,
  double_click: ACTION_TYPES.CLICK,
  triple_click: ACTION_TYPES.CLICK,
  hover: ACTION_TYPES.HOVER,
  type: ACTION_TYPES.TYPE,
  key: ACTION_TYPES.TYPE,
  scroll: ACTION_TYPES.SCROLL,
  scroll_to: ACTION_TYPES.SCROLL,
  wait: ACTION_TYPES.WAIT,
  left_click_drag: ACTION_TYPES.DRAG
  // diag_input (hidden diagnostic, not in the tool schema) intentionally
  // falls through to OTHER below.
});

/**
 * Classify a dispatched tool call into the taxonomy above.
 * @param {string} tool - the legacy registry tool name (host/tool-definitions.js)
 * @param {object} args - the tool's own arguments (never mutated, never stored)
 * @returns {{type: string, op: string|null}}
 */
export function classifyAction(tool, args) {
  const a = args || {};
  if (tool === "computer") {
    const op = typeof a.action === "string" ? a.action : null;
    return { type: (op && COMPUTER_OP_TYPE[op]) || ACTION_TYPES.OTHER, op };
  }
  if (tool === "navigate") return { type: ACTION_TYPES.OPEN_PAGE, op: null };
  if (tool === "read_page" || tool === "get_page_text") return { type: ACTION_TYPES.READ, op: null };
  if (tool === "find") return { type: ACTION_TYPES.FIND, op: null };
  if (tool === "javascript_tool") return { type: ACTION_TYPES.SCRIPT, op: null };
  return { type: ACTION_TYPES.OTHER, op: null };
}

export function isPointerCapable(actionType) {
  return POINTER_ACTION_TYPES.has(actionType);
}

// --- Redaction + safe summaries ---------------------------------------
//
// "A declared place for redaction" (task brief) and design.md 5c's "never
// raw password values or secret-bearing payloads" / spec.md's "Sensitive
// input" scenario. There is no reliable signal in extension/background.js
// today about whether a given coordinate/ref is a credential field (that
// would require a content-script change, out of this batch's scope — see
// reports/05-action-event-schema.md's "Known limitations"), so the safe,
// root-cause-correct default implemented here is unconditional: an action's
// summary is built ENTIRELY from its own arguments' STRUCTURE (coordinates,
// lengths, static labels) and NEVER from the arguments' free-text CONTENT
// for the two cases that can carry a secret — typed text and executed
// script source. Every event's `summary` field is safe to log, render, and
// forward over the wire unmodified.
function plain(summary) {
  return { summary, redaction: { applied: false, reason: null } };
}

function redactedLength(label, text) {
  const n = typeof text === "string" ? text.length : 0;
  return {
    summary: `${label} (${n} character${n === 1 ? "" : "s"})`,
    redaction: { applied: true, reason: "content_redacted" }
  };
}

function coordSummary(label, coordinate, ref) {
  if (Array.isArray(coordinate) && coordinate.length === 2) {
    return `${label} at (${coordinate[0]}, ${coordinate[1]})`;
  }
  if (typeof ref === "string" && ref) return `${label} ${ref}`;
  return label;
}

function safeUrl(url) {
  return typeof url === "string" ? url.slice(0, 200) : "";
}

function safeQuery(q) {
  return typeof q === "string" ? `"${q.slice(0, 80)}"` : "";
}

/**
 * Build a safe, redaction-applied summary for a tool call, using ONLY its
 * arguments (never a result, which may embed page content the caller never
 * intended for a control-surface log). See the file-header note above.
 * @returns {{summary: string, redaction: {applied: boolean, reason: string|null}}}
 */
export function summarize(tool, args) {
  const a = args || {};
  if (tool === "computer") {
    switch (a.action) {
      case "screenshot":
        return plain("Capture screenshot");
      case "zoom":
        return plain("Capture zoomed region");
      case "left_click":
        return plain(coordSummary("Click", a.coordinate, a.ref));
      case "right_click":
        return plain(coordSummary("Right-click", a.coordinate, a.ref));
      case "double_click":
        return plain(coordSummary("Double-click", a.coordinate, a.ref));
      case "triple_click":
        return plain(coordSummary("Triple-click", a.coordinate, a.ref));
      case "hover":
        return plain(coordSummary("Hover", a.coordinate, a.ref));
      case "scroll": {
        const dir = typeof a.scroll_direction === "string" ? a.scroll_direction : "down";
        const at = Array.isArray(a.coordinate) ? ` at (${a.coordinate[0]}, ${a.coordinate[1]})` : "";
        return plain(`Scroll ${dir}${at}`);
      }
      case "scroll_to":
        return plain("Scroll to target");
      case "wait": {
        const d = typeof a.duration === "number" ? a.duration : 1;
        return plain(`Wait ${d} second${d === 1 ? "" : "s"}`);
      }
      case "left_click_drag": {
        const from = Array.isArray(a.start_coordinate) ? ` from (${a.start_coordinate[0]}, ${a.start_coordinate[1]})` : "";
        const to = Array.isArray(a.coordinate) ? ` to (${a.coordinate[0]}, ${a.coordinate[1]})` : "";
        return plain(`Drag${from}${to}`);
      }
      case "type":
        return redactedLength("Type", a.text);
      case "key":
        return plain(`Press key(s): ${typeof a.text === "string" ? a.text.slice(0, 60) : ""}`);
      default:
        return plain(`Computer action: ${a.action || "unknown"}`);
    }
  }
  if (tool === "navigate") return plain(`Open ${safeUrl(a.url)}`);
  if (tool === "read_page") return plain("Read page");
  if (tool === "get_page_text") return plain("Read page text");
  if (tool === "find") return plain(`Find ${safeQuery(a.query)}`);
  if (tool === "javascript_tool") return redactedLength("Run page script", a.text);
  return plain(tool);
}

/** Safe error summary — the error's own message only, length-capped. Never
 * includes args/results, which could otherwise smuggle page content or a
 * secret into an error event through an exception's context. */
export function safeErrorSummary(err) {
  const msg = (err && err.message) || String(err) || "error";
  return msg.slice(0, 300);
}

// --- Identity: action IDs and per-stream sequence numbers -----------------
//
// "run ID, action ID, tab ID, document ID, plus ordered timestamps and a
// sequence number for reconnect dedup" (task brief). `actionId` is stable
// across every event belonging to the same logical action instance
// (start -> progress* -> complete|error). `seq` is monotonic PER STREAM,
// where a stream is one run (`run:<runId>`) or the single `legacy` bucket
// used for tool calls with no run identity (external MCP clients — see
// design.md 5d). Streams are independent: two runs' sequences never
// interleave or block each other.

let actionCounter = 0;
export function newActionId() {
  actionCounter += 1;
  // Counter first (guarantees uniqueness within this module instance even
  // if Math.random() ever collided) then a random suffix (so ids are not
  // trivially guessable/orderable by a downstream consumer that should be
  // using `seq`, not the id, for ordering).
  return `act_${actionCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const seqByStream = new Map();

export function streamKeyForRun(runId) {
  return runId ? `run:${runId}` : "legacy";
}

/** Next sequence number for a stream, starting at 1. */
export function nextSeq(streamKey) {
  const key = streamKey || "legacy";
  const n = (seqByStream.get(key) || 0) + 1;
  seqByStream.set(key, n);
  return n;
}

/** Current (last-issued) sequence number for a stream, 0 if none issued yet. */
export function currentSeq(streamKey) {
  return seqByStream.get(streamKey || "legacy") || 0;
}

/** Drop a stream's sequence counter — call when a run ends, so a companion
 * that never comes back does not hold memory forever. Not wired to any
 * lifecycle event by this batch (run lifecycle is host-owned); exposed for
 * Batch 3 to call when it owns run teardown. */
export function resetStream(streamKey) {
  seqByStream.delete(streamKey || "legacy");
}

// --- Document identity (best-effort, per tab) ------------------------------
//
// A lightweight, background.js-local "document generation" counter — NOT
// the same thing as extension/content.js's own `documentEpoch` (a content
// script concept, owned by a parallel batch, and not reachable from here
// without a content.js change out of this batch's scope). This tracker
// exists so the schema's `documentId` field has a real, monotonic value: it
// increments once per observed navigation in a tab (background.js wires
// `.bump()` to its existing tab-URL-change listener) and never resets to a
// previous value, so a stale event referencing an old document is always
// numerically distinguishable from a current one. See
// reports/05-action-event-schema.md's "Known limitations" for exactly what
// this does and does not guarantee (in particular: it does NOT observe an
// in-page SPA navigation the way content.js's own tracker does, only
// browser-visible URL changes background.js already listens for).
export class DocumentIdTracker {
  constructor() {
    this._gen = new Map();
  }
  /** Current document id for a tab, or null if the tab is unknown/absent. */
  current(tabId) {
    if (tabId === undefined || tabId === null) return null;
    const g = this._gen.get(tabId) || 0;
    return `${tabId}:${g}`;
  }
  /** Call when a tab is known to have navigated (new document). */
  bump(tabId) {
    if (tabId === undefined || tabId === null) return;
    this._gen.set(tabId, (this._gen.get(tabId) || 0) + 1);
  }
  /** Call when a tab closes, so its generation does not linger forever. */
  clear(tabId) {
    this._gen.delete(tabId);
  }
}

// --- Movement-sample grouping ----------------------------------------------
//
// "Movement samples must be groupable under their parent action, so hundreds
// of rows are never emitted" (task brief). A humanized path can dispatch
// dozens of real mouseMoved events for a single click; this batches them
// into bounded-size chunks instead of one progress event per sample. Every
// point pushed here MUST already have been really dispatched — this class
// never invents, interpolates, or reorders a point; it only buffers points
// its caller hands it, in the order handed.
export class PointBatcher {
  constructor(maxPoints = 20) {
    this.maxPoints = Math.max(1, maxPoints);
    this._buf = [];
  }
  /** @returns {Array|null} a full batch to flush now, or null if not yet full. */
  push(point) {
    this._buf.push(point);
    if (this._buf.length >= this.maxPoints) return this.drain();
    return null;
  }
  /** @returns {Array|null} whatever is buffered (and clears it), or null if empty. */
  drain() {
    if (!this._buf.length) return null;
    const out = this._buf;
    this._buf = [];
    return out;
  }
  get pending() {
    return this._buf.length;
  }
}

// --- Event construction -----------------------------------------------

const REQUIRED_FIELDS = ["kind", "streamKey", "actionId", "action", "timing"];

/**
 * Build one well-formed action event. Every event this module or
 * background.js produces MUST go through this function, so every consumer
 * (overlay, companion timeline, tests) can rely on one shape. Assigns `seq`
 * itself (via nextSeq(streamKey)) — callers never choose their own sequence
 * number, which is what keeps `seq` genuinely monotonic per stream.
 *
 * See reports/05-action-event-schema.md for the authoritative field-by-field
 * description of the object this returns.
 */
export function buildEvent(fields) {
  for (const f of REQUIRED_FIELDS) {
    if (fields[f] === undefined || fields[f] === null) {
      throw new Error(`action-events: buildEvent missing required field "${f}"`);
    }
  }
  const {
    kind,
    streamKey,
    runId = null,
    conversationId = null,
    requestId = null,
    actionId,
    tabId = null,
    documentId = null,
    action,
    timing,
    pointer = null,
    capture = null,
    summary = "",
    redaction = { applied: false, reason: null },
    outcome = null
  } = fields;

  if (pointer !== null && !POINTER_ACTION_TYPES.has(action.type)) {
    // Fail loudly rather than silently drop the field — a caller passing a
    // pointer payload for a non-pointer action type is exactly the
    // fabrication bug this schema exists to make impossible.
    throw new Error(
      `action-events: pointer payload not allowed on action type "${action.type}" (kind=${kind})`
    );
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    kind,
    seq: nextSeq(streamKey),
    streamKey,
    runId,
    conversationId,
    requestId,
    actionId,
    tabId,
    documentId,
    ts: Date.now(),
    action: { type: action.type, tool: action.tool, op: action.op ?? null },
    timing: { startedAt: timing.startedAt, endedAt: timing.endedAt ?? null },
    pointer,
    capture,
    summary,
    redaction,
    outcome
  });
}

// --- Emission bus -----------------------------------------------------
//
// Synchronous, in-process pub/sub. Deliberately minimal: this batch's job is
// emitting well-formed events at the real dispatch points, not building the
// overlay (a subscriber) or the companion-forwarding transport (another
// subscriber, host-side). A listener throwing never affects the caller that
// emitted the event — see the file-header invariant about never adding
// delay/risk to real dispatch.
const listeners = new Set();

export function onActionEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function offActionEvent(fn) {
  listeners.delete(fn);
}

export function listenerCount() {
  return listeners.size;
}

export function emitActionEvent(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // A subscriber's failure must never affect the action it is observing.
    }
  }
  return event;
}

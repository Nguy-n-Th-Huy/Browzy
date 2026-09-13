// Durable, sequenced per-conversation event log + metadata.
//
// Every session-level fact (a message arriving, a tool dispatch, its result,
// a run stopping) is appended here as one JSON line with a monotonically
// increasing `seq`. This is what makes "reopen a persisted conversation"
// possible without depending on any in-memory state surviving a companion or
// native-host restart (design.md decision 1 / requirement "Session
// continuity and honest cancellation").
//
// Writes are append-only for events (durable log) and atomic
// write-then-rename for meta.json (small, fully-rewritten document) so a
// crash mid-write never leaves a half-written file a later read can choke on.

import fs from "node:fs";
import path from "node:path";

import {
  conversationDir,
  conversationArtifactsDir,
  conversationEventsFile,
  conversationMetaFile,
  conversationsDir,
  ensureDir,
  assertSafeId
} from "./paths.js";
import { initConversationMetadataEnvelope } from "./conversation-metadata.js";

// The SDK hands each message to us with its tool results in two places: the
// `tool_result` blocks inside `message.content`, and a flat `tool_use_result`
// mirror alongside them. For a turn carrying a screenshot or a GIF that means
// the identical base64 is written to the log twice, and image bytes dwarf
// everything else in it — one 2.7 MB GIF export produced a 7.3 MB log, of
// which 99.8% was those two copies.
//
// Nothing in this project reads `tool_use_result`; the panel renders images
// out of `message.content`. So the mirror is persisted WITHOUT the payloads
// that are provably already stored in `content` (compared by value, not
// assumed), each replaced by a marker naming where the bytes live. A payload
// that is NOT found in `content` is left exactly as it is — that one is not a
// duplicate, and dropping it would lose data.
//
// This rewrites only what is written to disk. The event handed back to the
// caller, and therefore what the live panel receives, is untouched.
export function dedupeMirroredImageData(event) {
  const message = event && event.message && event.message.message;
  const mirror = event && event.message && event.message.tool_use_result;
  if (!Array.isArray(mirror) || !message || !Array.isArray(message.content)) return event;

  const inContent = new Set();
  for (const block of message.content) {
    const inner = block && block.content;
    if (!Array.isArray(inner)) continue;
    for (const part of inner) {
      const data = part && part.source && part.source.data;
      if (typeof data === "string" && data) inContent.add(data);
    }
  }
  if (!inContent.size) return event;

  let changed = false;
  const slimMirror = mirror.map((entry) => {
    const data = entry && entry.source && entry.source.data;
    if (typeof data !== "string" || !inContent.has(data)) return entry;
    changed = true;
    const { data: _omitted, ...source } = entry.source;
    return { ...entry, source: { ...source, data_in: "message.content" } };
  });
  if (!changed) return event;
  return { ...event, message: { ...event.message, tool_use_result: slimMirror } };
}

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

// Presentation-metadata bounds (openspec/changes/optimize-chat-history task
// 1.1). These are enforced a second time at the wire boundary
// (host/agent/protocol.js's validateConversationUpdate) — the store clamps
// rather than rejects, so a long legacy title already on disk is truncated
// instead of making a conversation unreadable.
export const PRESENTATION_LIMITS = Object.freeze({
  titleMaxChars: 200,
  hostnameMaxChars: 255
});

// How long appendEvent() may defer persisting meta.json's `lastSeq`. Every
// event still hits events.jsonl immediately (append-only, the durable half of
// the pair — see this file's header). `lastSeq` is a CACHE of that log, so a
// crash inside this window loses nothing that a restart cannot recover: the
// next append (or snapshot) reconciles the true last sequence from the log
// itself (`_lastSeqFromLog`). Before this batching, every single event
// rewrote the whole meta.json — one atomic write per token batch, per tool
// result, per message.
const META_FLUSH_DELAY_MS = 1000;

function clampText(value, maxChars) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export class TranscriptStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSnapshotEvents] - snapshot()/transcriptWindow()
   *   return at most this many events per page; a reconnecting panel asks
   *   for the newest window and lazily loads OLDER pages by sequence range
   *   (design.md decision 3) instead of pulling unbounded history into one
   *   native-messaging payload.
   * @param {number} [opts.metaFlushDelayMs] - how long appendEvent() may
   *   defer persisting meta.json before a timer flushes it. Run terminals
   *   and every explicit updateMeta() flush immediately; this only bounds
   *   how long a pure streaming stretch can go without a meta write.
   */
  constructor(opts = {}) {
    this.maxSnapshotEvents = opts.maxSnapshotEvents ?? 500;
    this.metaFlushDelayMs = opts.metaFlushDelayMs ?? META_FLUSH_DELAY_MS;
    // conversationId -> highest seq ever assigned in THIS process (seeded
    // from the log the first time this process needs it — see
    // `_lastSeqOf`). The authoritative sequence number for ordering is the
    // one stamped on each stored event; this map is only the allocator, and
    // it can always be rebuilt from the log.
    this._lastSeq = new Map();
    this._dirtyMeta = new Set();
    this._metaTimer = null;
  }

  createConversation(conversationId, meta = {}) {
    assertSafeId(conversationId, "conversationId");
    ensureDir(conversationDir(conversationId));
    ensureDir(conversationArtifactsDir(conversationId));
    const now = Date.now();
    const record = {
      conversationId,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      interrupted: false,
      // tasks.md 2.1: every conversation record carries the versioned
      // conversationMetadata envelope from creation, including the
      // appendEvent() auto-vivify path just above (which calls
      // createConversation(conversationId) with no meta) — so a conversation
      // can never exist on disk without this field going forward. An
      // explicit `meta.conversationMetadata` (uncommon) still wins via the
      // spread below, same as every other default field here.
      conversationMetadata: initConversationMetadataEnvelope(),
      ...meta
    };
    atomicWriteJson(conversationMetaFile(conversationId), record);
    // Truncate/create the events file so re-creating an id never appends to
    // a stale prior log.
    fs.writeFileSync(conversationEventsFile(conversationId), "");
    this._lastSeq.set(conversationId, 0);
    this._dirtyMeta.delete(conversationId);
    return record;
  }

  loadMeta(conversationId) {
    assertSafeId(conversationId, "conversationId");
    const meta = readJsonSafe(conversationMetaFile(conversationId), null);
    if (!meta) return null;
    // A meta.json whose `lastSeq` trails the in-memory allocator (events
    // appended since the last flush, see `_dirtyMeta`) must never be handed
    // out as if it were current — snapshot()/updateMeta() would then publish
    // a cursor the log has already moved past.
    const cached = this._lastSeq.get(conversationId);
    if (cached != null && cached > (meta.lastSeq || 0)) return { ...meta, lastSeq: cached };
    return meta;
  }

  updateMeta(conversationId, patch) {
    const disk = this.loadMeta(conversationId) || { conversationId, lastSeq: 0 };
    // The event LOG, not meta.json, is the authority on the last sequence
    // number: meta's `lastSeq` is a deferred cache (see appendEvent). A
    // metadata update that trusted the on-disk value would persist — and
    // cache — a cursor behind the log, and the next appendEvent() would then
    // stamp a seq the log already holds (a DUPLICATE event, exactly what
    // design.md decision 3 forbids). `_lastSeqOf()` seeds itself from the log
    // once per conversation per process, so this stays O(1) after the first
    // write of any kind.
    const lastSeq = Math.max(disk.lastSeq || 0, this._lastSeqOf(conversationId));
    const next = { ...disk, ...patch, lastSeq, updatedAt: Date.now() };
    return this._writeMeta(next);
  }

  /** Persist meta.json directly (single atomic write). Internal; callers go
   * through updateMeta()/flushMeta(). Never LOWERS the in-memory allocator —
   * see updateMeta()'s comment for why a lower cursor is a correctness bug,
   * not just a stale read. */
  _writeMeta(record) {
    const known = this._lastSeq.get(record.conversationId);
    const lastSeq = Math.max(record.lastSeq || 0, known || 0);
    const next = lastSeq === record.lastSeq ? record : { ...record, lastSeq };
    atomicWriteJson(conversationMetaFile(next.conversationId), next);
    this._dirtyMeta.delete(next.conversationId);
    this._lastSeq.set(next.conversationId, lastSeq);
    return next;
  }

  /**
   * Persist the deferred `lastSeq` for one conversation now. Returns true
   * when a write actually happened. Run terminals and explicit deletes reach
   * this through updateMeta(); a pure streaming stretch reaches it through
   * the flush timer (or a caller that wants durability right now, e.g. a
   * companion about to exit).
   */
  flushMeta(conversationId) {
    assertSafeId(conversationId, "conversationId");
    if (!this._dirtyMeta.has(conversationId)) return false;
    const current = readJsonSafe(conversationMetaFile(conversationId), null);
    if (!current) {
      this._dirtyMeta.delete(conversationId);
      return false;
    }
    const seq = this._lastSeq.get(conversationId);
    return Boolean(this._writeMeta({ ...current, lastSeq: Math.max(current.lastSeq || 0, seq || 0), updatedAt: Date.now() }));
  }

  /** Flush every conversation whose meta is dirty (timer path / shutdown). */
  flushAllMeta() {
    for (const conversationId of [...this._dirtyMeta]) this.flushMeta(conversationId);
    return this;
  }

  _markMetaDirty(conversationId) {
    this._dirtyMeta.add(conversationId);
    if (this._metaTimer) return;
    this._metaTimer = setTimeout(() => {
      this._metaTimer = null;
      this.flushAllMeta();
    }, this.metaFlushDelayMs);
    if (this._metaTimer.unref) this._metaTimer.unref();
  }

  /** Highest sequence number the log for this conversation actually holds.
   * Seeded once per conversation per process: after a crash the deferred
   * lastSeq may be behind the log, and allocating from a stale counter would
   * stamp TWO events with the same seq (the "no duplicate events" contract
   * design.md decision 3 requires). Walks backwards so a torn tail line from
   * a crash mid-append is skipped instead of read as the newest event. */
  _lastSeqFromLog(conversationId) {
    let text;
    try {
      text = fs.readFileSync(conversationEventsFile(conversationId), "utf-8");
    } catch {
      return 0;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.seq === "number") return parsed.seq;
      } catch {
        // torn tail — keep walking backwards
      }
    }
    return 0;
  }

  _lastSeqOf(conversationId) {
    const cached = this._lastSeq.get(conversationId);
    if (cached != null) return cached;
    const seq = this._lastSeqFromLog(conversationId);
    this._lastSeq.set(conversationId, seq);
    return seq;
  }

  /**
   * Presentation metadata (task 1.1): title, hostname, pinned, archived.
   * `revision` increments on every accepted write so a panel can send an
   * `ifRevision` guard and get a conflict instead of silently clobbering a
   * newer edit from another panel (design.md risk: "Cross-panel races — use
   * revision/updatedAt checks ... for presentation metadata").
   *
   * @returns {{ok: true, meta: object} | {ok: false, reason: string, revision: number}}
   */
  updatePresentation(conversationId, patch = {}) {
    assertSafeId(conversationId, "conversationId");
    const current = this.loadMeta(conversationId);
    if (!current) return { ok: false, reason: "unknown_conversation", revision: 0 };
    const revision = current.revision || 0;
    if (patch.ifRevision != null && patch.ifRevision !== revision) {
      return { ok: false, reason: "revision_conflict", revision };
    }
    const next = { ...current, revision: revision + 1 };
    if ("title" in patch) next.title = clampText(patch.title, PRESENTATION_LIMITS.titleMaxChars);
    if ("hostname" in patch) next.hostname = clampText(patch.hostname, PRESENTATION_LIMITS.hostnameMaxChars);
    if ("pinned" in patch) next.pinned = patch.pinned === true;
    if ("archived" in patch) next.archived = patch.archived === true;
    return { ok: true, meta: this._writeMeta({ ...next, updatedAt: Date.now() }) };
  }

  /**
   * Every returned meta carries one DERIVED field, `hasData`: whether the
   * conversation holds at least one stored event (see `_hasStoredEvents()`).
   * It is computed here, never persisted, because meta.json's cursor is
   * deferred (see appendEvent) and because the log remains the authority on
   * what a conversation actually holds. The list itself is never filtered:
   * callers that page through conversations (the panel's `limit`) must not
   * have real conversations hidden behind a page full of empty ones.
   *
   * @param {number} [limit] - cap on returned summaries (design.md risk:
   *   "Large host directories → ... limit summary responses"). Applied
   *   AFTER the most-recent-first sort, so the cap keeps the newest.
   */
  listConversations(limit) {
    const dir = conversationsDir();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const listed = entries
      .filter((e) => e.isDirectory())
      .map((e) => this.loadMeta(e.name))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const capped = Number.isInteger(limit) && limit > 0 ? listed.slice(0, limit) : listed;
    // `hasData` is answered only for the conversations this call returns: the
    // log-touching fallback inside `_hasStoredEvents()` is not paid for rows
    // the limit already dropped.
    return capped.map((meta) => ({ ...meta, hasData: this._hasStoredEvents(meta) }));
  }

  /** Does this conversation hold at least ONE stored event?
   *
   * A different question from "is meta.json's cursor non-zero": appendEvent()
   * defers that write (task 3.1), so a conversation whose first events were
   * appended in THIS process can still read 0 on disk. The live allocator is
   * consulted first for exactly that reason; the persisted cursor is the
   * fallback for conversations this process never touched. When neither knows
   * of an event the LOG decides, through `_lastSeqOf()`: a process that
   * crashed inside the deferred window leaves meta.json at 0 with real events
   * on disk, and reporting such a conversation as empty would hide history
   * that exists. Only conversations that still look empty pay for that read
   * (a conversation created here truncated its own log, so a live 0 is
   * already final and stays O(1)). */
  _hasStoredEvents(meta) {
    const live = this._lastSeq.get(meta.conversationId);
    const seq = live != null ? live : meta.lastSeq || 0;
    return seq > 0 || this._lastSeqOf(meta.conversationId) > 0;
  }

  /** Total conversations on disk, independent of any list limit. */
  conversationCount() {
    const dir = conversationsDir();
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch {
      return 0;
    }
  }

  /**
   * Append one event, assigning it the next sequence number for this
   * conversation. Returns the stored event (with its assigned `seq`).
   *
   * The event line itself is durable the moment this returns. meta.json's
   * `lastSeq` is NOT rewritten per event any more (task 3.1) — it is marked
   * dirty and persisted by `flushMeta()` on the next lifecycle write or
   * flush-timer tick, while `_lastSeqOf()` keeps allocation correct in the
   * meantime and `_lastSeqFromLog()` recovers it after a restart.
   */
  appendEvent(conversationId, event) {
    assertSafeId(conversationId, "conversationId");
    if (!this.loadMeta(conversationId)) this.createConversation(conversationId);
    const seq = this._lastSeqOf(conversationId) + 1;
    const stored = { seq, ts: Date.now(), ...event };
    fs.appendFileSync(
      conversationEventsFile(conversationId),
      JSON.stringify(dedupeMirroredImageData(stored)) + "\n"
    );
    this._lastSeq.set(conversationId, seq);
    this._markMetaDirty(conversationId);
    return stored;
  }

  /** Read + parse this conversation's whole log (ascending seq). */
  _readEvents(conversationId) {
    let text = "";
    try {
      text = fs.readFileSync(conversationEventsFile(conversationId), "utf-8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Read every event with seq > afterSeq (default 0 = everything, bounded to
   * maxSnapshotEvents most-recent when afterSeq is 0 so a cold reconnect
   * cannot pull an unbounded history into one native-messaging payload).
   */
  eventsAfter(conversationId, afterSeq = 0) {
    assertSafeId(conversationId, "conversationId");
    const all = this._readEvents(conversationId).filter((e) => e.seq > afterSeq);
    if (afterSeq === 0 && all.length > this.maxSnapshotEvents) {
      return all.slice(all.length - this.maxSnapshotEvents);
    }
    return all;
  }

  /**
   * One older TRANSCRIPT PAGE, by sequence range (task 3.2 / design.md
   * decision 3: "loading transcript pages by sequence range ... rather than
   * dropping replay correctness").
   *
   * @param {object} [opts]
   * @param {number} [opts.beforeSeq] - exclusive upper bound; 0/omitted
   *   means "the newest page".
   * @param {number} [opts.limit] - page size (defaults to
   *   maxSnapshotEvents).
   * @returns {{conversationId, events: Array, firstSeq: number,
   *   lastSeq: number, hasOlder: boolean, limit: number}}
   */
  transcriptWindow(conversationId, { beforeSeq = 0, limit } = {}) {
    assertSafeId(conversationId, "conversationId");
    const cap = Number.isInteger(limit) && limit > 0 ? limit : this.maxSnapshotEvents;
    const all = this._readEvents(conversationId);
    const eligible = beforeSeq > 0 ? all.filter((e) => e.seq < beforeSeq) : all;
    const page = eligible.length > cap ? eligible.slice(eligible.length - cap) : eligible;
    return {
      conversationId,
      events: page,
      firstSeq: page.length ? page[0].seq : 0,
      lastSeq: page.length ? page[page.length - 1].seq : 0,
      hasOlder: page.length > 0 && page[0].seq > (all.length ? all[0].seq : 0),
      limit: cap
    };
  }

  /**
   * A reopened panel's request: "give me a snapshot plus everything after my
   * last known seq" (design.md decision 1). `afterSeq` of 0 or undefined
   * means "never seen anything" and gets the bounded recent history — the
   * panel then lazily loads older pages through transcriptWindow().
   *
   * `firstSeq`/`hasOlder` are what make the bounded window HONEST: a client
   * that only receives the newest page can tell it is a window (and ask for
   * the page below it) instead of rendering a transcript that silently
   * begins mid-conversation.
   */
  snapshot(conversationId, afterSeq = 0) {
    const meta = this.loadMeta(conversationId);
    if (!meta) return { conversationId, meta: null, lastSeq: 0, firstSeq: 0, hasOlder: false, events: [] };
    const all = this._readEvents(conversationId);
    const after = all.filter((e) => e.seq > afterSeq);
    const page = after.length > this.maxSnapshotEvents ? after.slice(after.length - this.maxSnapshotEvents) : after;
    const oldest = all.length ? all[0].seq : 0;
    return {
      conversationId,
      meta,
      lastSeq: meta.lastSeq || 0,
      firstSeq: page.length ? page[0].seq : 0,
      hasOlder: page.length > 0 && page[0].seq > oldest,
      events: page
    };
  }

  artifactsDir(conversationId) {
    assertSafeId(conversationId, "conversationId");
    return ensureDir(conversationArtifactsDir(conversationId));
  }

  // Explicit local deletion (5.3): removes only this app's own conversation
  // data. Recordings live in a separate tree (native-host.js's
  // .config/browzy-in-chrome/recordings) and are untouched.
  //
  // Returns whether the directory is actually gone after the attempt — the
  // caller (SessionManager.deleteConversation) reports that as
  // `onDiskRemoved` rather than claiming a removal that a still-open SDK
  // subprocess handle defeated. A THROWING rmSync propagates to the caller
  // for the same reason: "deleted" must never be reported for a removal that
  // did not happen.
  deleteConversation(conversationId) {
    assertSafeId(conversationId, "conversationId");
    this._lastSeq.delete(conversationId);
    this._dirtyMeta.delete(conversationId);
    fs.rmSync(conversationDir(conversationId), { recursive: true, force: true });
    return { removed: !fs.existsSync(conversationDir(conversationId)) };
  }

  /**
   * Remove every conversation this store owns (task 1.3's delete-all).
   * Per-conversation failures are collected, never swallowed: the caller
   * reports `deleted:false` for a partial sweep so the panel cannot clear
   * its whole local cache over a half-deleted host.
   *
   * @returns {{removed: string[], failed: Array<{conversationId: string, reason: string}>}}
   */
  deleteAllConversations() {
    const dir = conversationsDir();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { removed: [], failed: [] };
    }
    const removed = [];
    const failed = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const conversationId = entry.name;
      try {
        assertSafeId(conversationId, "conversationId");
        this.deleteConversation(conversationId);
        if (fs.existsSync(conversationDir(conversationId))) {
          failed.push({ conversationId, reason: "remove_failed" });
        } else {
          removed.push(conversationId);
        }
      } catch (err) {
        failed.push({ conversationId, reason: err && err.message ? err.message : String(err) });
      }
    }
    return { removed, failed };
  }
}

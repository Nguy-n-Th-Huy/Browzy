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

export class TranscriptStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSnapshotEvents] - snapshot() returns at most
   *   this many most-recent events; a reconnecting panel asks for events
   *   after its own last-seen seq instead of the whole history once it has
   *   one.
   */
  constructor(opts = {}) {
    this.maxSnapshotEvents = opts.maxSnapshotEvents ?? 500;
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
    return record;
  }

  loadMeta(conversationId) {
    assertSafeId(conversationId, "conversationId");
    return readJsonSafe(conversationMetaFile(conversationId), null);
  }

  updateMeta(conversationId, patch) {
    const current = this.loadMeta(conversationId) || { conversationId, lastSeq: 0 };
    const next = { ...current, ...patch, updatedAt: Date.now() };
    atomicWriteJson(conversationMetaFile(conversationId), next);
    return next;
  }

  listConversations() {
    const dir = conversationsDir();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => this.loadMeta(e.name))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Append one event, assigning it the next sequence number for this
   * conversation. Returns the stored event (with its assigned `seq`).
   */
  appendEvent(conversationId, event) {
    assertSafeId(conversationId, "conversationId");
    const meta = this.loadMeta(conversationId) || this.createConversation(conversationId);
    const seq = (meta.lastSeq || 0) + 1;
    const stored = { seq, ts: Date.now(), ...event };
    fs.appendFileSync(conversationEventsFile(conversationId), JSON.stringify(stored) + "\n");
    this.updateMeta(conversationId, { lastSeq: seq });
    return stored;
  }

  /**
   * Read every event with seq > afterSeq (default 0 = everything, bounded to
   * maxSnapshotEvents most-recent when afterSeq is 0 so a cold reconnect
   * cannot pull an unbounded history into one native-messaging payload).
   */
  eventsAfter(conversationId, afterSeq = 0) {
    assertSafeId(conversationId, "conversationId");
    let text = "";
    try {
      text = fs.readFileSync(conversationEventsFile(conversationId), "utf-8");
    } catch {
      return [];
    }
    const all = text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((e) => e.seq > afterSeq);
    if (afterSeq === 0 && all.length > this.maxSnapshotEvents) {
      return all.slice(all.length - this.maxSnapshotEvents);
    }
    return all;
  }

  /**
   * A reopened panel's request: "give me a snapshot plus everything after my
   * last known seq" (design.md decision 1). `afterSeq` of 0 or undefined
   * means "never seen anything" and gets the bounded recent history.
   */
  snapshot(conversationId, afterSeq = 0) {
    const meta = this.loadMeta(conversationId);
    return {
      conversationId,
      meta,
      lastSeq: meta ? meta.lastSeq : 0,
      events: meta ? this.eventsAfter(conversationId, afterSeq) : []
    };
  }

  artifactsDir(conversationId) {
    assertSafeId(conversationId, "conversationId");
    return ensureDir(conversationArtifactsDir(conversationId));
  }

  // Explicit local deletion (5.3): removes only this app's own conversation
  // data. Recordings live in a separate tree (native-host.js's
  // .config/browzy-in-chrome/recordings) and are untouched.
  deleteConversation(conversationId) {
    assertSafeId(conversationId, "conversationId");
    fs.rmSync(conversationDir(conversationId), { recursive: true, force: true });
  }
}

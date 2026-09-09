// Recordings that finished while no SDK run was active.
//
// Spec (agent-browser-runtime, "Preserve recorder and sandbox boundaries" —
// "Recording finishes without an open conversation"): "WHEN a narrated
// recording completes while no SDK run is active THEN it is saved and
// listed for later attachment without requiring a Claude Code channel."
//
// The "saved" half is already true unconditionally — extension/background.js
// writes the trace/audio/images to disk under
// ~/.config/browzy-in-chrome/recordings/<id>/ before it ever attempts to
// notify anything (see host/test/recorder-companion-routing.test.mjs). This
// module is only the "listed for later attachment" half: a companion-wide
// (not per-conversation, since no conversation claimed it) durable reference
// so a sidepanel opened later can show "3 recordings waiting to be attached"
// and let the user pick one for a conversation, without re-deriving that
// list from disk scans of the recordings tree.
//
// This stores a REFERENCE only — recordingId, its existing on-disk path,
// schema version, transcript status, and an optional summary — never a copy
// of trace.json/audio/images. Retains the existing host storage format
// exactly (design.md decision 3 / task 6.3: "Host-side recordings retain
// their current locations."). Follows the same private-per-user directory
// and atomic-write-then-rename convention as
// host/agent/storage/transcript-store.js so this fits the existing artifact-
// reference model rather than inventing a second one.

import fs from "node:fs";
import path from "node:path";

import { agentRoot, ensureDir } from "./paths.js";

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

export function pendingRecordingsFile() {
  return path.join(agentRoot(), "recordings", "pending.json");
}

export class PendingRecordingsStore {
  /** @param {object} [opts] @param {string} [opts.file] - override for tests */
  constructor(opts = {}) {
    this.file = opts.file || pendingRecordingsFile();
  }

  _readAll() {
    return readJsonSafe(this.file, {});
  }

  /**
   * Record (or re-record) a finished recording as available for later
   * attachment. Keyed by recordingId, so a re-delivered event (e.g. a
   * companion restart racing the extension's own delivery attempt) can never
   * create a second entry for the same recording — idempotent by
   * construction, not by best-effort deduping at read time.
   */
  add(recording) {
    const recordingId = String(recording?.recordingId ?? "");
    if (!recordingId) throw new Error("recording.recordingId is required");
    const all = this._readAll();
    const existing = all[recordingId];
    all[recordingId] = {
      recordingId,
      path: String(recording.path ?? ""),
      schema: String(recording.schema ?? "v0"),
      summary: typeof recording.summary === "string" ? recording.summary : "",
      transcriptStatus: String(recording.transcriptStatus ?? "ok"),
      // Preserve the original arrival time across a re-delivery of the same
      // id, so the list's ordering reflects when the recording actually
      // finished, not when it was last (re)announced.
      receivedAt: existing ? existing.receivedAt : Date.now()
    };
    atomicWriteJson(this.file, all);
    return all[recordingId];
  }

  /** Every pending recording, most-recently-finished first. */
  list() {
    return Object.values(this._readAll()).sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0));
  }

  get(recordingId) {
    return this._readAll()[recordingId] || null;
  }

  has(recordingId) {
    return Object.prototype.hasOwnProperty.call(this._readAll(), String(recordingId));
  }

  /**
   * Drop a pending entry once it has been attached to a conversation (a
   * future sidepanel "attach" action — group 5.3 — is the eventual caller;
   * this store only needs to stop listing it as pending). Never touches the
   * recording's actual files on disk.
   */
  remove(recordingId) {
    const all = this._readAll();
    const id = String(recordingId ?? "");
    if (!(id in all)) return false;
    delete all[id];
    atomicWriteJson(this.file, all);
    return true;
  }
}

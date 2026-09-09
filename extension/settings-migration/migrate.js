// One-time export/import of NON-SECRET settings + recorder session metadata
// across an extension-id change.
//
// Why this exists: Chrome partitions chrome.storage and IndexedDB by
// extension id. Moving from an unkeyed unpacked build (a random id per
// browser/profile) to the persistent-keyed build (openspec/changes/
// migrate-to-claude-agent-sdk/specs/stable-extension-installation/spec.md,
// "Migration and diagnostics") gets a brand-new storage origin, so the old
// extension's settings and recorder session list are not simply visible to
// the new one. This module is the one-time bridge.
//
// What is exported:
//   - the non-secret operational config (`ocic_config_v1`: humanize,
//     humanize_speed, humanize_seed, audit_mode)
//   - the recorder session INDEX: one row per recording with its id, times,
//     first URL, event/utterance counts, on-disk `path`, transcript status,
//     and the full behavior/cognitive/cursor trace (enough to repopulate the
//     Options page sessions list and its timeline view).
//
// What is deliberately NOT exported:
//   - `openai_api_key` (or any other secret) — secrets are never exported;
//     the user re-enters them in the new extension.
//   - the cached `audio` Blob and `images` (dataURL thumbnails) IndexedDB
//     stores — these are a large, disposable CACHE of what a session's
//     `path` already points to on disk (the native host writes the
//     authoritative trace.json/audio/images bundle there, independent of
//     which extension id is active — host-side recordings are not touched or
//     moved by this migration). Re-attaching a recording's `path` after
//     import is enough for the "Copy reference" flow and for a human to open
//     the bundle directly; only the small in-app thumbnail/audio preview is
//     unavailable until the recording is played back from `path`.
//
// Storage access is injected via `adapter` so the actual export/import logic
// is unit-testable outside a browser (see migrate.test.mjs, which exercises
// it with an in-memory fake adapter); browser callers omit `adapter` and get
// the real chrome.storage/indexedDB-backed one built by `defaultAdapter()`.

export const CONFIG_KEY = "ocic_config_v1";
export const EXPORT_SCHEMA = "ocic-legacy-export-v1";

const DB_NAME = "ocic-recorder";
const DB_VERSION = 3;

// Session fields carried over. Deliberately excludes `audio` and `images` —
// see the file header.
const SESSION_FIELDS = [
  "recording_id",
  "started_at",
  "ended_at",
  "url0",
  "events",
  "utterances",
  "path",
  "transcriptStatus",
  "trace"
];

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "recording_id" });
      if (!d.objectStoreNames.contains("events")) d.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("cursor")) d.createObjectStore("cursor", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("images")) d.createObjectStore("images", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * The real, browser-backed storage adapter (chrome.storage.local +
 * IndexedDB "ocic-recorder"). Only constructible where `chrome` and
 * `indexedDB` exist, i.e. inside the extension.
 */
export function defaultAdapter() {
  return {
    async getConfig() {
      const local = await chrome.storage.local.get(CONFIG_KEY);
      return local[CONFIG_KEY] || null;
    },
    async setConfig(value) {
      await chrome.storage.local.set({ [CONFIG_KEY]: value });
    },
    async getSessions() {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction("sessions", "readonly");
        const req = tx.objectStore("sessions").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    },
    async putSession(row) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        tx.objectStore("sessions").put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };
}

function pickSessionFields(row) {
  const out = {};
  for (const k of SESSION_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

/**
 * Build the exportable snapshot: non-secret config + session index rows.
 * NEVER includes openai_api_key or any other secret — see file header.
 *
 * @param {object} [adapter] storage adapter; defaults to the real browser one
 */
export async function buildExport(adapter) {
  const a = adapter || defaultAdapter();
  const config = await a.getConfig();
  const sessions = await a.getSessions();
  return {
    schema: EXPORT_SCHEMA,
    exported_at: Date.now(),
    settings: config ? { [CONFIG_KEY]: config } : {},
    recordings: sessions.map(pickSessionFields)
  };
}

/**
 * Apply a previously-exported snapshot into this extension's storage.
 * Secrets are never part of the payload, so there is nothing to re-enter
 * here — the user must set the OpenAI transcription key again from Options.
 *
 * @param {object} data a `buildExport()` result (or its JSON round-trip)
 * @param {object} [adapter] storage adapter; defaults to the real browser one
 * @returns {Promise<{importedSettings: boolean, importedRecordings: number, skipped: string[]}>}
 */
export async function applyImport(data, adapter) {
  const a = adapter || defaultAdapter();
  if (!data || data.schema !== EXPORT_SCHEMA) {
    throw new Error(
      `unrecognized export format (expected schema "${EXPORT_SCHEMA}"); this file may be from an incompatible version`
    );
  }
  const skipped = [];
  let importedSettings = false;
  const config = data.settings && data.settings[CONFIG_KEY];
  if (config && typeof config === "object") {
    await a.setConfig(config);
    importedSettings = true;
  }
  let importedRecordings = 0;
  for (const row of data.recordings || []) {
    if (!row || typeof row.recording_id !== "string" || !row.recording_id) {
      skipped.push(row && row.recording_id ? String(row.recording_id) : "(missing recording_id)");
      continue;
    }
    await a.putSession(pickSessionFields(row));
    importedRecordings++;
  }
  return { importedSettings, importedRecordings, skipped };
}

// --- Browser convenience wrappers ------------------------------------------
// These require a real DOM/chrome environment (Blob, document, chrome.*) and
// are meant to be run from an extension page's console — see README.md in
// this directory. They are NOT exercised by migrate.test.mjs (BLOCKED:
// requires a real browser); buildExport/applyImport above carry the actual
// logic and are what that test covers.

/** Export and trigger a file download, for use from an extension page console. */
export async function exportAndDownload() {
  const data = await buildExport();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ocic-legacy-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return data;
}

/** Parse and import a previously-downloaded export file's text content. */
export async function importFromText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`export file is not valid JSON: ${err.message}`);
  }
  return applyImport(data);
}

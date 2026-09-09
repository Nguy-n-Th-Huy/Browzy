#!/usr/bin/env node
//
// Tests for extension/settings-migration/migrate.js's export/import logic.
//
// buildExport/applyImport take an injectable storage `adapter`, so this
// suite exercises the REAL export/import logic with a small in-memory fake
// adapter — no browser, no chrome.* shim, no fake-indexeddb dependency
// needed. The browser-only convenience wrappers (exportAndDownload,
// importFromText's DOM-free JSON parsing aside) need a real DOM/chrome
// environment and are BLOCKED here — see the note at the bottom of this file.
//
// Run: node extension/settings-migration/migrate.test.mjs

import { buildExport, applyImport, CONFIG_KEY, EXPORT_SCHEMA } from "./migrate.js";

function fakeAdapter(initial = {}) {
  const state = {
    config: initial.config ?? null,
    sessions: new Map((initial.sessions || []).map((s) => [s.recording_id, s]))
  };
  return {
    state,
    async getConfig() {
      return state.config;
    },
    async setConfig(value) {
      state.config = value;
    },
    async getSessions() {
      return Array.from(state.sessions.values());
    },
    async putSession(row) {
      state.sessions.set(row.recording_id, row);
    }
  };
}

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, err: err.message });
      console.log(`  FAIL  ${name}  — ${err.stack || err.message}`);
    });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nLegacy settings/recorder-metadata export-import\n");

await test("export never includes the OpenAI secret key even if present in raw storage", async () => {
  // The adapter contract only exposes getConfig() for ocic_config_v1 — there
  // is intentionally no adapter method that could return openai_api_key, so
  // this also documents that the export path has no code path capable of
  // reading it.
  const adapter = fakeAdapter({ config: { humanize: true, audit_mode: "audit" } });
  const data = await buildExport(adapter);
  assert(JSON.stringify(data).indexOf("openai") === -1, "export must never mention the secret key name/value");
  assert(data.settings[CONFIG_KEY].humanize === true, "non-secret config should be exported");
});

await test("export excludes audio/images cache fields even if a session row carries them", async () => {
  const adapter = fakeAdapter({
    sessions: [
      {
        recording_id: "r1",
        started_at: 1000,
        ended_at: 2000,
        url0: "https://example.com",
        events: 3,
        utterances: 1,
        path: "/tmp/rec/r1",
        transcriptStatus: "ok",
        trace: { schema: "v0", behavior: [], cognitive: [], cursor: [], images: [] },
        // Should NOT survive into the export:
        audio: { size: 12345, type: "audio/webm" },
        images: [{ dataUrl: "data:image/png;base64,AAAA" }]
      }
    ]
  });
  const data = await buildExport(adapter);
  assert(data.recordings.length === 1, "expected one exported recording");
  const row = data.recordings[0];
  assert(row.audio === undefined, "audio blob must not be exported");
  assert(row.images === undefined, "image thumbnails must not be exported");
  assert(row.path === "/tmp/rec/r1", "path must be preserved (host-side recording stays at this path)");
  assert(row.trace && Array.isArray(row.trace.behavior), "trace should be preserved for the timeline view");
});

await test("export with no settings yet yields an empty settings object, not an error", async () => {
  const adapter = fakeAdapter({});
  const data = await buildExport(adapter);
  assert(data.schema === EXPORT_SCHEMA, "schema tag should be set");
  assert(Object.keys(data.settings).length === 0, "expected empty settings when nothing was configured");
  assert(data.recordings.length === 0, "expected no recordings");
});

await test("round trip: export from one adapter, import into a fresh one", async () => {
  const source = fakeAdapter({
    config: { humanize: true, humanize_speed: "natural", audit_mode: "off" },
    sessions: [
      { recording_id: "a", started_at: 1, ended_at: 2, url0: "https://a.example", events: 1, utterances: 0, path: "/tmp/a" },
      { recording_id: "b", started_at: 3, ended_at: 4, url0: "https://b.example", events: 2, utterances: 1, path: "/tmp/b" }
    ]
  });
  const data = await buildExport(source);
  // Simulate the export surviving a JSON file round trip.
  const reparsed = JSON.parse(JSON.stringify(data));

  const target = fakeAdapter({});
  const result = await applyImport(reparsed, target);
  assert(result.importedSettings === true, "settings should have been imported");
  assert(result.importedRecordings === 2, `expected 2 recordings imported, got ${result.importedRecordings}`);
  assert(result.skipped.length === 0, `expected nothing skipped, got ${JSON.stringify(result.skipped)}`);

  assert(target.state.config.humanize === true, "imported config mismatch");
  assert(target.state.config.humanize_speed === "natural", "imported config mismatch");
  assert(target.state.sessions.size === 2, "expected 2 sessions in target after import");
  assert(target.state.sessions.get("a").path === "/tmp/a", "session a should keep its host-side path");
});

await test("import into an extension that already has sessions merges rather than wiping", async () => {
  const target = fakeAdapter({
    sessions: [{ recording_id: "existing", started_at: 0, ended_at: 1, path: "/tmp/existing" }]
  });
  const data = { schema: EXPORT_SCHEMA, exported_at: Date.now(), settings: {}, recordings: [
    { recording_id: "imported", started_at: 5, ended_at: 6, path: "/tmp/imported" }
  ] };
  await applyImport(data, target);
  assert(target.state.sessions.has("existing"), "pre-existing session must survive an import");
  assert(target.state.sessions.has("imported"), "imported session must be present");
  assert(target.state.sessions.size === 2, "expected both sessions to coexist");
});

await test("import rejects an unrecognized/incompatible export format", async () => {
  const target = fakeAdapter({});
  let threw = null;
  try {
    await applyImport({ not: "an export" }, target);
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected applyImport to reject an unrecognized format");
  assert(/unrecognized export format/.test(threw.message), `unexpected message: ${threw.message}`);
});

await test("import skips a malformed recording (no recording_id) instead of throwing", async () => {
  const target = fakeAdapter({});
  const data = {
    schema: EXPORT_SCHEMA,
    exported_at: Date.now(),
    settings: {},
    recordings: [{ started_at: 1, ended_at: 2 }, { recording_id: "ok", started_at: 3, ended_at: 4 }]
  };
  const result = await applyImport(data, target);
  assert(result.importedRecordings === 1, "the well-formed recording should still import");
  assert(result.skipped.length === 1, "the malformed recording should be reported as skipped, not silently dropped");
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
console.log(
  "BLOCKED (requires a real browser): exportAndDownload()/the chrome.storage+IndexedDB-backed\n" +
  "defaultAdapter() cannot run under Node (no chrome.*, no indexedDB, no Blob/document download\n" +
  "flow). To exercise those, load the extension in Chrome/Edge/Brave, open the extension's Options\n" +
  "page devtools console, and run:\n" +
  '  const m = await import(chrome.runtime.getURL("settings-migration/migrate.js"));\n' +
  "  await m.exportAndDownload();   // in the OLD (unkeyed) extension\n" +
  '  await m.importFromText(await (await fetch("<file url or paste>")).text()); // in the NEW extension\n'
);
process.exit(failed.length ? 1 : 0);

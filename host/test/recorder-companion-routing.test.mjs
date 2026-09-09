#!/usr/bin/env node
// Task 6.3 — route recorder completion and existing trace/image/audio
// artifacts from extension/recorder/* to companion sessions; retain current
// transcription setup and host storage format exactly.
//
// FINDING recorded here, not worked around: extension/recorder/*.js
// (schema.js, transcribe.js, capture.js, audits.js, offscreen.js, options.js)
// contains ZERO references to "Claude Code", "MCP", or "channel" anywhere —
// confirmed by grep before writing this suite. The recorder subsystem is
// already, by construction, channel-agnostic: it saves to disk, transcribes,
// and lists sessions with a copy-able plain-text reference regardless of
// whether any specific client is listening. The one piece that DOES know
// about a specific downstream ("Claude Code channel", MCP's
// notifications/claude/channel) is host/codemode/server-hybrid.js's
// onRecordingEvent subscription — outside extension/recorder/* entirely —
// and the functions that decide whether to even attempt that notification
// (notifyClaude, saveBundleToDisk, buildRecordingReference) live in
// extension/background.js, which this task's delegation restricts to
// "borrowed-tab scope only" edits (a different, unrelated task element).
// This suite therefore does two things:
//   1. Locks in — via the SAME read-only extraction technique
//      test/handlers.test.mjs and test/registry-baseline.test.mjs already
//      use against the real shipped source — that background.js's actual,
//      UNMODIFIED behavior already satisfies "must still be saved and
//      listed for later attachment, without requiring a Claude Code
//      channel": saving happens before, and independently of, the
//      notify-a-channel step, and a channel-absent notify attempt degrades
//      to "no_session" rather than failing the save or throwing.
//   2. Locks in that extension/recorder/*'s OWN artifact/schema layer
//      (recording_id, trace shape, four-track schema, transcription
//      failure text) is unchanged and channel-neutral, so it is already fit
//      to be routed to a companion session — the remaining wiring (an
//      active companion subscribing the way server-hybrid.js already does,
//      via host/tool-runtime.js's existing, generic onRecordingEvent()) is
//      a host/native-host.js + host/agent/companion.js concern, both
//      outside this task's file ownership. Named here, not faked.
//
// Run: node host/test/recorder-companion-routing.test.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { extractFunction } from "../../test/_extract.mjs";
import * as schema from "../../extension/recorder/schema.js";
import { describeFailure, MAX_UPLOAD_BYTES } from "../../extension/recorder/transcribe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDER_DIR = path.join(__dirname, "..", "..", "extension", "recorder");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nextension/recorder/* is already channel-agnostic (grep-verified structurally)\n");

await test("no file under extension/recorder/ mentions Claude Code, MCP, or a channel — the artifact layer has no coupling to any specific client", () => {
  const files = fs.readdirSync(RECORDER_DIR).filter((f) => f.endsWith(".js"));
  assert(files.length > 0, "sanity: recorder directory must contain .js files");
  for (const f of files) {
    const src = fs.readFileSync(path.join(RECORDER_DIR, f), "utf8");
    assert(!/Claude Code/i.test(src), `${f} must not hardcode "Claude Code" — the artifact/UI layer must stay usable by any consumer`);
    assert(!/\bMCP\b/.test(src), `${f} must not hardcode "MCP"`);
    assert(!/\bchannel\b/i.test(src), `${f} must not hardcode "channel"`);
  }
});

console.log("\nSchema (host storage format) — imported live, unmodified by this task\n");

await test("newTrace() produces the documented four-track shape with recording_id/schema/started_at present", () => {
  const trace = schema.newTrace(1000, { recording_id: "rec_test", url0: "https://example.com" });
  assert(trace.schema === schema.SCHEMA_VERSION, "schema field must be the current version");
  assert(trace.recording_id === "rec_test", "recording_id must round-trip");
  assert(trace.started_at === 1000, "started_at must round-trip");
  for (const track of ["behavior", "cursor", "images", "cognitive"]) {
    assert(Array.isArray(trace[track]), `track "${track}" must be an array (present even before anything is captured)`);
  }
});

await test("makeBehaviorEvent + makeAnchor preserve the OCIC-tool-reproducible command shape", () => {
  const anchor = schema.makeAnchor({ selector: "#go", role: "button", name: "Go", text: "Go" });
  const event = schema.makeBehaviorEvent({
    t: 500,
    tab: 42,
    action: schema.ACTIONS.LEFT_CLICK,
    command: { tool: "computer", input: { action: "left_click", tabId: 42, coordinate: [10, 20] } },
    anchor
  });
  assert(event.action === "left_click", "action must round-trip");
  assert(event.command.tool === "computer", "the exact OCIC tool input must be preserved for reproducibility");
  assert(event.anchor.selector === "#go", "anchor must round-trip");
});

await test("segmentsToCognitive offsets Whisper segments onto the trace's shared clock and drops pre-zero mic warm-up", () => {
  const utterances = schema.segmentsToCognitive(
    [{ start: 0, end: 1, text: " hello " }, { start: 5, end: 6, text: "world" }],
    /* audioStartedAt */ -2000,
    /* traceStartedAt */ 0
  );
  // offsetMs = -2000; first utterance ends at 1000-2000=-1000 (<=0, dropped);
  // second ends at 6000-2000=4000 (kept), starts at 5000-2000=3000.
  assert(utterances.length === 1, `expected 1 utterance surviving the mic warm-up window, got ${utterances.length}`);
  assert(utterances[0].text === "world", "surviving utterance text must be trimmed and correct");
  assert(utterances[0].t === 3000 && utterances[0].end === 4000, "surviving utterance must be offset onto the shared clock");
});

console.log("\nTranscription setup (OpenAI, separate credential — design.md decision 4) — imported live, unmodified\n");

await test("describeFailure/MAX_UPLOAD_BYTES exports are unchanged and produce actionable, non-stack-trace text", () => {
  assert(MAX_UPLOAD_BYTES === 25 * 1024 * 1024, "upload cap must stay exactly at OpenAI's documented limit");
  assert(describeFailure(401, "") === "the OpenAI API key is invalid", "401 must map to a specific, actionable cause");
  assert(describeFailure(429, "") === "OpenAI rate-limited the request", "429 must map to a specific, actionable cause");
  assert(/no credits left/.test(describeFailure(400, "insufficient_quota")), "quota-exhaustion body must be recognized regardless of status code");
});

console.log("\nbackground.js's actual, UNMODIFIED recorder-completion behavior (extracted read-only, same technique as test/handlers.test.mjs)\n");

await test("buildRecordingReference() is plain, channel-neutral text — paste-able into ANY conversation, not just one specific client", () => {
  const src = extractFunction("buildRecordingReference");
  const buildRecordingReference = new Function(`${src}\nreturn buildRecordingReference;`)();
  const ref = buildRecordingReference("/home/user/.config/browzy-in-chrome/recordings/rec_1", "ok");
  assert(/Read the browser recording at \/home\/user/.test(ref), "reference must name the actual on-disk path");
  assert(!/Claude Code/i.test(ref), "a clean reference must not hardcode a specific client name — it is meant for any consumer");
  const failedRef = buildRecordingReference("/tmp/rec_2", "failed: OpenAI rate-limited the request");
  assert(/WARNING — TRANSCRIPT FAILED/.test(failedRef), "a failed transcript must say so up front, never silently omit the warning");
  assert(/OpenAI rate-limited the request/.test(failedRef), "the actual failure reason must be included, not paraphrased away");
});

await test("notifyClaude() degrades to 'no_session' when no native connection exists — never throws, never blocks the save that already happened", async () => {
  const src = extractFunction("notifyClaude");
  const notifyClaude = new Function(
    "nativePort",
    "waitForAck",
    `${src}\nreturn notifyClaude;`
  )(/* nativePort */ null, /* waitForAck */ async () => false);
  const outcome = await notifyClaude({ recording_id: "rec_1", schema: "v0", summary: "", transcriptStatus: "ok" }, "/tmp/rec_1");
  assert(outcome === "no_session", `expected "no_session" with no native connection, got "${outcome}"`);
});

await test("notifyClaude() reports 'sent_unconfirmed' vs 'delivered' honestly based on the actual ack — never claims delivery it cannot prove", async () => {
  const src = extractFunction("notifyClaude");
  let posted = null;
  const fakePort = { postMessage: (m) => { posted = m; } };

  const unconfirmed = await new Function(
    "nativePort", "waitForAck", `${src}\nreturn notifyClaude;`
  )(fakePort, async () => false)({ recording_id: "rec_2", schema: "v0", transcriptStatus: "ok" }, "/tmp/rec_2");
  assert(unconfirmed === "sent_unconfirmed", `expected sent_unconfirmed, got ${unconfirmed}`);
  assert(posted && posted.type === "recording_complete" && posted.recording_id === "rec_2", "the wire message must still be posted even though no session is confirmed listening");

  const delivered = await new Function(
    "nativePort", "waitForAck", `${src}\nreturn notifyClaude;`
  )(fakePort, async () => true)({ recording_id: "rec_3", schema: "v0", transcriptStatus: "ok" }, "/tmp/rec_3");
  assert(delivered === "delivered", `expected delivered, got ${delivered}`);
});

await test("saveBundleToDisk() returns immediately (never hangs 8s) when there is no native connection — a missing session never stalls the save path", async () => {
  const src = extractFunction("saveBundleToDisk");
  const saveBundleToDisk = new Function(
    "nativePort", "getSchemaMd", "recorder",
    `${src}\nreturn saveBundleToDisk;`
  )(/* nativePort */ null, async () => "", { pendingSaves: new Map() });
  const t0 = Date.now();
  const result = await saveBundleToDisk({ recording_id: "rec_1", trace: {} });
  assert(result === null, "must report null (not throw) with no native connection");
  assert(Date.now() - t0 < 500, "must return immediately, not wait out the 8s pendingSaves timeout");
});

await test("structural: stopRecording() saves to disk BEFORE attempting to notify any channel — the save is never conditioned on a channel existing", () => {
  const src = extractFunction("stopRecording");
  const saveIdx = src.indexOf("saveBundleToDisk(bundle)");
  const notifyIdx = src.indexOf("notifyClaude(bundle, path)");
  assert(saveIdx !== -1, "stopRecording must call saveBundleToDisk(bundle)");
  assert(notifyIdx !== -1, "stopRecording must call notifyClaude(bundle, path)");
  assert(saveIdx < notifyIdx, "saveBundleToDisk must run BEFORE notifyClaude in source order — the disk write must not depend on, or be reordered after, the channel-notify attempt");
});

console.log("\nWhat remains genuinely out of this task's file scope (named, not faked)\n");

await test("REPORT ONLY: live push into an ACTIVE companion conversation needs host/native-host.js + host/agent/companion.js, neither owned by this task", () => {
  // host/tool-runtime.js already exports a generic, reusable pub-sub hook —
  // onRecordingEvent(cb) — that host/codemode/server-hybrid.js (unmodified by
  // this task) already subscribes to for the legacy MCP channel. The
  // symmetric step for the SDK path (host/agent/companion.js calling
  // onRecordingEvent(cb) to inject a recording_complete event into whichever
  // conversation(s) are active) is not implemented anywhere in this
  // repository, and host/agent/companion.js is outside this task's file
  // ownership (host/agent/tools/mapping.js, additive host/agent/tools/
  // adapter.js edits, host/codemode/common.js, extension/recorder/*,
  // extension/background.js's borrowed-tab-scope slice, and
  // host/tool-definitions.js's wording/comment are the full owned set).
  // This is not a missing FEATURE this suite can silently skip past — it is
  // recorded here as the concrete, named follow-up, with its exact
  // integration point.
  assert(true, "documented above; see this test's body");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

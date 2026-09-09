#!/usr/bin/env node
// Task 6.3 (remainder) — route recorder completion to companion sessions.
//
// host/test/recorder-companion-routing.test.mjs already proved (real,
// extracted) that extension/recorder/* and extension/background.js's
// UNMODIFIED save/notify path are channel-agnostic and that a recording is
// saved to disk before any channel-notify attempt. That suite's own header
// named exactly what was left: an ACTIVE companion conversation was never
// pushed a live recording_complete event, and nothing persisted a recording
// for later attachment when no run was active. host/native-host.js and
// host/agent/companion.js were outside that delegation's file ownership;
// they are owned here.
//
// This suite covers the acceptance criteria for that remainder:
//   - a recorder event is routed to an ACTIVE conversation's transcript
//   - a recorder event with NO active run is persisted and listable for
//     later attachment (spec: "Recording finishes without an open
//     conversation" — no Claude Code channel required)
//   - the pre-existing host storage format/location (recordings tree,
//     handleSaveRecording's path template) is unchanged, and the new
//     pending-recordings reference stores only a reference, never a copy
//   - resending the same recorder event never produces a duplicate — either
//     in an active conversation's sequenced transcript, or in the pending
//     list — so a reconnecting panel's resync is never shown a duplicate
//   - an unsupported protocol version on a recorder event fails closed,
//     independent of whether hello has ever succeeded
//
// Two techniques, like reports/06-preservation-evidence.md's existing
// suites: fast in-process CompanionCore tests (fakes for the SDK, real
// storage under a scratch OCIC_AGENT_HOME — no live browser/API key needed)
// for the branching logic, plus a real spawned native-host.js + real forked
// companion.js for the actual wire-level routing (host/native-host.js's
// routeFromExtension -> companionChild.send -> companion's reply relayed
// back), exactly the harness host/test/agent-native-handshake.test.mjs
// already established for the version handshake.
//
// Run: node host/test/agent-recorder-push.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { PendingRecordingsStore } from "../agent/storage/pending-recordings.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";
import { extractFunction } from "../../test/_extract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_HOST = path.join(HERE, "..", "native-host.js");

// Isolate every test run's storage under a scratch directory (same
// convention as agent-companion-core.test.mjs).
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-recorder-push-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slowSdk() {
  return {
    async *query() {
      await new Promise((r) => setTimeout(r, 300));
    }
  };
}

// Matches host/agent/settings/profile.js's documented snapshotForRun()
// contract exactly (same fake used by agent-companion-core.test.mjs) — a
// real, working profile is needed here because a run must actually reach
// RUNNING (holding the lease) before a recorder event arrives; only the
// query() call itself needs to hang.
function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

function buildCore({ sdk } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async () => ({ content: [] }), shutdown: () => {} });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || slowSdk(),
    profileProvider: fakeProfileProvider()
  });
}

function recordingEnvelope(overrides = {}) {
  return makeEnvelope(AGENT_MESSAGE_TYPES.RECORDING_COMPLETE, {
    recording_id: "rec_1",
    path: "/home/user/.config/browzy-in-chrome/recordings/rec_1",
    schema: "v0",
    summary: "Filled out the signup form",
    transcript_status: "ok",
    ...overrides
  });
}

console.log("\nRecorder push: protocol version (fails closed independent of hello)\n");

await test("an unsupported protocol version on a recording_complete envelope fails closed, with NO hello ever sent", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope({ v: 999, type: AGENT_MESSAGE_TYPES.RECORDING_COMPLETE, recording_id: "rec_bad_v" });
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, `expected version_mismatch, got ${reply.type}`);
  assert(reply.reason === "unsupported_version", `expected unsupported_version, got ${reply.reason}`);
  assert(reply.requested === 999, "must echo the requested version");
  assert(
    core.sessionManager.listPendingRecordings().every((r) => r.recordingId !== "rec_bad_v"),
    "a version-rejected event must never be persisted — fail closed means nothing is recorded, not recorded-with-a-warning"
  );
});

await test("a missing/non-integer version on a recording_complete envelope also fails closed", async () => {
  const core = buildCore();
  const missing = await core.handleEnvelope({ type: AGENT_MESSAGE_TYPES.RECORDING_COMPLETE, recording_id: "rec_x" });
  assert(missing.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH && missing.reason === "unsupported_version", "a missing v must fail closed, not default to current");
  const stringVersion = await core.handleEnvelope({ v: "1", type: AGENT_MESSAGE_TYPES.RECORDING_COMPLETE, recording_id: "rec_y" });
  assert(stringVersion.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "a string version must not coerce to a number and pass");
});

await test("a recording_complete envelope succeeds with NO hello ever sent — recorder events must not require a Claude Code channel", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_no_hello" }));
  assert(reply.type === AGENT_MESSAGE_TYPES.RECORDING_COMPLETE, "must be handled, not rejected as hello_required");
  assert(reply.attachedTo === null, "with no conversation ever created, there is nothing active to attach to");
  assert(
    core.sessionManager.listPendingRecordings().some((r) => r.recordingId === "rec_no_hello"),
    "it must still be saved and listed for later attachment"
  );
});

console.log("\nRecorder push: routed to an active conversation\n");

await test("a recorder event is appended to the conversation currently holding the browser lease", async () => {
  const core = buildCore({ sdk: slowSdk() });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "go" }));
  await sleep(30);
  assert(core.sessionManager.activeRun(conversationId).leaseHeldByThisRun(), "sanity: this run should hold the lease before the recorder event arrives");

  const reply = await core.handleEnvelope(
    recordingEnvelope({ recording_id: "rec_active", path: "/home/user/.config/browzy-in-chrome/recordings/rec_active" })
  );
  assert(reply.type === AGENT_MESSAGE_TYPES.RECORDING_COMPLETE);
  assert(reply.attachedTo === conversationId, `expected attachment to ${conversationId}, got ${reply.attachedTo}`);

  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  const event = snap.events.find((e) => e.type === "recording_complete");
  assert(event, "the conversation's transcript must contain the recorder event");
  assert(typeof event.seq === "number" && event.seq > 0, "the event must carry a real sequence number so a reopened panel can resync");
  assert(event.recordingId === "rec_active", "recordingId must round-trip exactly");
  assert(event.path === "/home/user/.config/browzy-in-chrome/recordings/rec_active", "the artifact path must round-trip exactly — the companion references it, it does not move or copy it");
  assert(event.schema === "v0" && event.transcriptStatus === "ok" && event.summary === "Filled out the signup form", "schema/transcriptStatus/summary must round-trip exactly, unchanged from the wire format");
  assert(
    core.sessionManager.listPendingRecordings().every((r) => r.recordingId !== "rec_active"),
    "a recording attached to an active conversation must not ALSO sit in the pending-attachment list"
  );

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("a recorder event with zero active runs is persisted, not silently dropped or misattached", async () => {
  const core = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  // A conversation exists, but nothing was ever started — "no SDK run is
  // active" per the spec scenario, even though a conversation id exists.
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  const reply = await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_idle" }));
  assert(reply.attachedTo === null, "no active run exists, so nothing should claim this recording");

  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  assert(!snap.events.some((e) => e.type === "recording_complete"), "an idle conversation must not receive an event meant for nobody");
  assert(
    core.sessionManager.listPendingRecordings().some((r) => r.recordingId === "rec_idle"),
    "it must be listed for later attachment instead"
  );
});

console.log("\nRecorder push: format/location preservation\n");

await test("the pending-attachment reference stores exactly the given path/schema/summary/transcriptStatus — a reference, never a copy", async () => {
  const core = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  await core.handleEnvelope(
    recordingEnvelope({
      recording_id: "rec_shape",
      path: "/home/user/.config/browzy-in-chrome/recordings/rec_shape",
      schema: "v0",
      summary: "Read the pricing page",
      transcript_status: "failed: OpenAI rate-limited the request"
    })
  );
  const entry = core.sessionManager.listPendingRecordings().find((r) => r.recordingId === "rec_shape");
  assert(entry, "the entry must be listed");
  assert(entry.path === "/home/user/.config/browzy-in-chrome/recordings/rec_shape", "path must be preserved verbatim — this is a reference to the EXISTING recording directory, not a new one");
  assert(entry.schema === "v0", "schema must be preserved verbatim");
  assert(entry.summary === "Read the pricing page", "summary must be preserved verbatim");
  assert(entry.transcriptStatus === "failed: OpenAI rate-limited the request", "a failed transcript status must round-trip honestly, never silently normalized to ok");
  assert(typeof entry.receivedAt === "number", "must record when it was received, for later-attachment ordering");

  // And, on disk: this store must only ever hold the reference fields —
  // never any of the actual trace/audio/image bytes, which stay exactly
  // where handleSaveRecording already put them.
  const onDisk = JSON.parse(fs.readFileSync(path.join(scratchRoot, "recordings", "pending.json"), "utf-8"));
  const keys = Object.keys(onDisk.rec_shape).sort();
  assert(
    keys.join(",") === ["path", "receivedAt", "recordingId", "schema", "summary", "transcriptStatus"].sort().join(","),
    `pending.json entry must hold only reference fields, got: ${keys.join(",")}`
  );
});

await test("structural: host/native-host.js's handleSaveRecording (the pre-existing host storage format/location) is untouched by this task's new routing", () => {
  const src = extractFunction("handleSaveRecording", NATIVE_HOST);
  assert(
    /path\.join\(\s*os\.homedir\(\),\s*"\.config",\s*"browzy-in-chrome",\s*"recordings",\s*String\(msg\.recording_id \|\| "unknown"\)\s*\)/.test(src),
    "the recordings directory template must be byte-identical to the existing one — this task must not migrate, rename, or reformat existing recordings"
  );
  assert(/"trace\.json"/.test(src), "trace.json must still be the artifact filename");
});

await test("structural: routeFromExtension still fans out to every legacy MCP client BEFORE forwarding to the companion", () => {
  const src = extractFunction("routeFromExtension", NATIVE_HOST);
  const legacyFanoutIdx = src.indexOf("for (const socket of clients.values())");
  const companionForwardIdx = src.indexOf("companionChild.send");
  assert(legacyFanoutIdx !== -1, "the existing legacy client fan-out must still be present, unchanged");
  assert(companionForwardIdx !== -1, "the new companion forwarding must be present");
  assert(legacyFanoutIdx < companionForwardIdx, "legacy behavior must run first and be unconditional — the SDK-path push is an addition, not a replacement");
});

console.log("\nRecorder push: no duplicates on redelivery (reconnect/resync safety)\n");

await test("redelivering the identical recorder event to an active conversation appends the transcript event only once", async () => {
  const core = buildCore({ sdk: slowSdk() });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "go" }));
  await sleep(30);

  await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_dup" }));
  const seqAfterFirst = core.sessionManager.store.loadMeta(conversationId).lastSeq;
  await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_dup" }));
  const seqAfterSecond = core.sessionManager.store.loadMeta(conversationId).lastSeq;
  assert(seqAfterSecond === seqAfterFirst, "a redelivered event with the same recordingId must not consume a new sequence number");

  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  const matches = snap.events.filter((e) => e.type === "recording_complete" && e.recordingId === "rec_dup");
  assert(matches.length === 1, `expected exactly 1 recording_complete event for rec_dup, got ${matches.length}`);

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("a reconnecting panel resyncing with afterSeq never sees the recorder event twice", async () => {
  const core = buildCore({ sdk: slowSdk() });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "go" }));
  await sleep(30);
  await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_resync" }));

  const firstSync = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  const recorderEvent = firstSync.events.find((e) => e.type === "recording_complete");
  assert(recorderEvent, "first sync must see the recorder event");

  // The panel "reconnects" and resyncs from its own last-seen seq.
  const secondSync = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: recorderEvent.seq })
  );
  assert(!secondSync.events.some((e) => e.type === "recording_complete"), "resyncing from a cursor already past the recorder event must not replay it");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("redelivering the identical recorder event with no active run does not create a second pending entry", async () => {
  const core = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_pending_dup", summary: "first delivery" }));
  const firstEntry = core.sessionManager.listPendingRecordings().find((r) => r.recordingId === "rec_pending_dup");
  await sleep(5);
  await core.handleEnvelope(recordingEnvelope({ recording_id: "rec_pending_dup", summary: "redelivered" }));
  const all = core.sessionManager.listPendingRecordings().filter((r) => r.recordingId === "rec_pending_dup");
  assert(all.length === 1, `expected exactly one pending entry for rec_pending_dup, got ${all.length}`);
  assert(all[0].receivedAt === firstEntry.receivedAt, "receivedAt must reflect the FIRST arrival, not the redelivery");
});

console.log("\nRecorder push: real end-to-end wire routing (real native-host.js + real forked companion.js)\n");

let seq = 0;
const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-recorder-push-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-recorder-push-${process.pid}-${n}.sock`);

function driveHostAsExtension(pipe, agentHome) {
  const proc = spawn(process.execPath, [NATIVE_HOST], {
    env: { ...process.env, OCIC_PIPE: pipe, OCIC_AGENT_HOME: agentHome },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const handlers = [];
  let buf = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
      buf = buf.subarray(4 + len);
      for (const h of handlers) h(msg);
    }
  });
  return {
    proc,
    onMessage: (cb) => handlers.push(cb),
    send(obj) {
      const body = Buffer.from(JSON.stringify(obj), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      proc.stdin.write(Buffer.concat([header, body]));
    },
    kill: () => proc.kill()
  };
}

function waitForAgentMsg(ext, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for agent_msg")), timeoutMs);
    ext.onMessage((msg) => {
      if (msg && msg.type === "agent_msg" && msg.envelope && predicate(msg.envelope)) {
        clearTimeout(timer);
        resolve(msg.envelope);
      }
    });
  });
}

await test("end-to-end: a raw recording_complete extension message with no active run is relayed through the REAL native host to the REAL forked companion and persisted for real to disk", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-recorder-push-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    ext.send({ type: "agent_msg", envelope: { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() } });
    await helloWaiter;

    const recorderWaiter = waitForAgentMsg(ext, (e) => e.type === "recording_complete");
    // This is the EXACT wire shape extension/background.js's notifyClaude()
    // sends today (host/test/recorder-companion-routing.test.mjs pins that
    // shape) — a top-level message, not wrapped in agent_msg, exactly as the
    // real extension sends it.
    ext.send({
      type: "recording_complete",
      recording_id: "rec_e2e",
      path: "/home/user/.config/browzy-in-chrome/recordings/rec_e2e",
      schema: "v0",
      summary: "Booked a flight",
      transcript_status: "ok"
    });
    const envelope = await recorderWaiter;
    assert(envelope.recordingId === "rec_e2e", "recordingId must round-trip through the real host+companion");
    assert(envelope.attachedTo === null, "no conversation was ever started, so it must be reported as persisted, not attached");

    const onDiskFile = path.join(e2eHome, "recordings", "pending.json");
    const onDisk = JSON.parse(fs.readFileSync(onDiskFile, "utf-8"));
    assert(onDisk.rec_e2e, "the REAL companion process must have written the pending entry to the REAL scratch OCIC_AGENT_HOME");
    assert(onDisk.rec_e2e.path === "/home/user/.config/browzy-in-chrome/recordings/rec_e2e", "path must be preserved exactly through the real wire round trip");
    assert(onDisk.rec_e2e.summary === "Booked a flight", "summary must be preserved exactly through the real wire round trip");
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);

if (process.platform !== "win32") {
  for (let i = 1; i <= seq; i++) {
    try {
      fs.unlinkSync(pipeFor(i));
    } catch {}
  }
}

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {}

process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
//
// Host-side action-timeline storage (task 5.10's host half; design.md
// decision 5c; reports/05-action-event-schema.md is the upstream contract
// this batch consumes, not redefines). Every event fed into these tests is
// built with the REAL extension/events/action-events.js's own buildEvent()
// (imported directly — that module is dependency-free and touches no
// chrome.*/DOM, so it runs unmodified in plain Node, exactly the technique
// the delegation's "Environment constraint" section names). No live browser
// or native-messaging wire is used here — that end-to-end proof is
// agent-timeline-wire.test.mjs.
//
// Run: node host/test/agent-timeline-storage.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  buildEvent,
  classifyAction,
  summarize,
  newActionId,
  streamKeyForRun,
  PointBatcher
} from "../../extension/events/action-events.js";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { PendingRecordingsStore } from "../agent/storage/pending-recordings.js";
import { ActionArtifactStore, sanitizeActionEvent, PerStreamSeqTracker } from "../agent/storage/action-timeline.js";
import { chunkBuffer, flattenChunkedMessage, ChunkReassembler } from "../agent/broker/chunked-transport.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";
import { conversationArtifactsDir } from "../agent/storage/paths.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-timeline-storage-"));
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

let runCounter = 0;
function freshRunId() {
  runCounter += 1;
  return `run_test_${runCounter}`;
}

/** Build a full start->progress->complete click lifecycle with the REAL schema module. */
function clickLifecycle({ runId, conversationId, tabId = 7, outcomeStatus = "success" }) {
  const streamKey = streamKeyForRun(runId);
  const actionId = newActionId();
  const startedAt = Date.now();
  const args = { action: "left_click", coordinate: [10, 20] };
  const cls = classifyAction("computer", args);
  const sum = summarize("computer", args);
  const action = { type: cls.type, tool: "computer", op: cls.op };
  const start = buildEvent({
    kind: "start",
    streamKey,
    runId,
    conversationId,
    requestId: "req_1",
    actionId,
    tabId,
    documentId: `${tabId}:0`,
    action,
    timing: { startedAt },
    summary: sum.summary,
    redaction: sum.redaction
  });
  const progress = buildEvent({
    kind: "progress",
    streamKey,
    runId,
    conversationId,
    requestId: "req_1",
    actionId,
    tabId,
    documentId: `${tabId}:0`,
    action,
    timing: { startedAt },
    pointer: { points: [{ x: 10, y: 20, t: Date.now(), phase: "move" }], frame: { frameId: 0, isMainFrame: true } }
  });
  const complete = buildEvent({
    kind: "complete",
    streamKey,
    runId,
    conversationId,
    requestId: "req_1",
    actionId,
    tabId,
    documentId: `${tabId}:0`,
    action,
    timing: { startedAt, endedAt: Date.now() },
    summary: sum.summary,
    redaction: sum.redaction,
    outcome: { status: outcomeStatus, detail: outcomeStatus === "unknown" ? "post-click confirmation unavailable" : null }
  });
  return { start, progress, complete, actionId, streamKey };
}

function typedTextEvent({ runId, conversationId, tabId = 7, secret = "hunter2correcthorsebatterystaple" }) {
  const streamKey = streamKeyForRun(runId);
  const actionId = newActionId();
  const args = { action: "type", text: secret };
  const cls = classifyAction("computer", args);
  const sum = summarize("computer", args); // real redaction applied here already
  return buildEvent({
    kind: "complete",
    streamKey,
    runId,
    conversationId,
    actionId,
    tabId,
    documentId: `${tabId}:0`,
    action: { type: cls.type, tool: "computer", op: cls.op },
    timing: { startedAt: Date.now(), endedAt: Date.now() },
    summary: sum.summary,
    redaction: sum.redaction,
    outcome: { status: "success", detail: null }
  });
}

function buildCore({ withProfileProvider = true } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const pendingRecordings = new PendingRecordingsStore();
  const sessionManager = new SessionManager({ store, lease, approvals, pendingRecordings });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  const artifactStore = new ActionArtifactStore();
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: { async *query() {} },
    profileProvider: withProfileProvider ? { async snapshotForRun() { return { model: "x", env: {}, revision: 1, profileId: "d" }; } } : undefined,
    artifactStore
  });
  return { core, sessionManager, store, pendingRecordings, artifactStore };
}

async function helloAndNew(core) {
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, { installationId: "i1", connectionId: "c1" }));
  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  return snap.conversationId;
}

console.log("\nAction-timeline host storage (task 5.10)\n");

// --- sanitizeActionEvent -----------------------------------------------

await test("sanitizeActionEvent accepts a well-formed real schema event verbatim", () => {
  const { complete } = clickLifecycle({ runId: freshRunId(), conversationId: "conv_x" });
  const result = sanitizeActionEvent(complete);
  assert(result.ok, "expected acceptance");
  assert(result.event.actionId === complete.actionId);
  assert(result.event.outcome.status === "success");
  assert(result.event.pointer === null, "click complete carries no pointer payload in this fixture");
});

await test("a secret-bearing typed-text event is redacted before it can be persisted, even if it were unredacted on the wire", () => {
  const runId = freshRunId();
  const event = typedTextEvent({ runId, conversationId: "conv_x", secret: "S3cretPassw0rd!!" });
  // Simulate a buggy/compromised producer that failed to redact — this is
  // exactly the case host-side defence must catch independently of
  // action-events.js's own (already-correct) behavior.
  const tampered = { ...event, summary: "Type: S3cretPassw0rd!!", redaction: { applied: false, reason: null } };
  const result = sanitizeActionEvent(tampered);
  assert(result.ok, "a redaction-bypass attempt must still be accepted, just re-redacted");
  assert(!result.event.summary.includes("S3cretPassw0rd!!"), "the raw secret must never survive into the stored summary");
  assert(result.event.redaction.applied === true, "must be marked redacted");
  assert(result.event.redaction.reason === "host_enforced_redaction");
});

await test("a javascript_tool event carrying literal source is redacted independently of the wire's own claim", () => {
  const runId = freshRunId();
  const streamKey = streamKeyForRun(runId);
  const secretToken = "sk-live-abc123token";
  const raw = buildEvent({
    kind: "complete",
    streamKey,
    runId,
    actionId: newActionId(),
    action: { type: "script", tool: "javascript_tool", op: null },
    timing: { startedAt: Date.now(), endedAt: Date.now() },
    summary: `Run page script: fetch("https://x?key=${secretToken}")`,
    redaction: { applied: false, reason: null },
    outcome: { status: "success", detail: null }
  });
  const result = sanitizeActionEvent(raw);
  assert(result.ok);
  assert(!result.event.summary.includes(secretToken), "javascript_tool source must never survive into storage");
  assert(result.event.redaction.reason === "host_enforced_redaction");
});

await test("a start/progress event must never carry an outcome (fabricated proof of effect)", () => {
  const runId = freshRunId();
  const { start } = clickLifecycle({ runId, conversationId: "conv_x" });
  const tampered = { ...start, outcome: { status: "success", detail: null } };
  const result = sanitizeActionEvent(tampered);
  assert(!result.ok, "a start event claiming an outcome must be rejected outright, not silently accepted");
  assert(result.reason === "outcome_not_allowed_on_this_kind");
});

await test("a complete event missing its outcome is rejected, never defaulted to success", () => {
  const runId = freshRunId();
  const { complete } = clickLifecycle({ runId, conversationId: "conv_x" });
  const { outcome, ...withoutOutcome } = complete;
  const result = sanitizeActionEvent(withoutOutcome);
  assert(!result.ok, "must reject rather than invent success");
  assert(result.reason === "missing_outcome");
});

await test("an error-kind event's outcome.status can never be downgraded away from error", () => {
  const runId = freshRunId();
  const streamKey = streamKeyForRun(runId);
  const raw = buildEvent({
    kind: "error",
    streamKey,
    runId,
    actionId: newActionId(),
    action: { type: "click", tool: "computer", op: "left_click" },
    timing: { startedAt: Date.now(), endedAt: Date.now() },
    outcome: { status: "success", detail: "tampered" } // a hostile/buggy producer trying to hide a real error
  });
  const result = sanitizeActionEvent(raw);
  assert(result.ok);
  assert(result.event.outcome.status === "error", "error kind must always store outcome.status === 'error'");
});

await test("an unknown-outcome complete (dispatched but DOM effect unverified) is stored as unknown, never coerced to success", () => {
  const runId = freshRunId();
  const { complete } = clickLifecycle({ runId, conversationId: "conv_x", outcomeStatus: "unknown" });
  const result = sanitizeActionEvent(complete);
  assert(result.ok);
  assert(result.event.outcome.status === "unknown", "successful dispatch must not be reported as proof of DOM effect");
});

await test("pointer motion is rejected for a non-pointer-capable action type, independent of action-events.js's own enforcement", () => {
  const runId = freshRunId();
  const streamKey = streamKeyForRun(runId);
  // Constructed by hand (buildEvent() itself already throws on this
  // combination) to simulate a producer that bypasses that enforcement.
  const raw = {
    schemaVersion: 1,
    kind: "progress",
    seq: 1,
    streamKey,
    runId,
    conversationId: null,
    requestId: null,
    actionId: newActionId(),
    tabId: null,
    documentId: null,
    ts: Date.now(),
    action: { type: "read", tool: "read_page", op: null },
    timing: { startedAt: Date.now(), endedAt: null },
    pointer: { points: [{ x: 1, y: 2, t: Date.now(), phase: "move" }], frame: { frameId: 0, isMainFrame: true } },
    capture: null,
    summary: "",
    redaction: { applied: false, reason: null },
    outcome: null
  };
  const result = sanitizeActionEvent(raw);
  assert(!result.ok, "a DOM/script-only action type must never be stored with fabricated pointer motion");
  assert(result.reason === "pointer_not_allowed_for_action_type");
});

await test("an unexpected extra top-level field on the wire object is dropped, never copied through", () => {
  const runId = freshRunId();
  const { complete } = clickLifecycle({ runId, conversationId: "conv_x" });
  const tampered = { ...complete, args: { password: "should-never-reach-disk" }, rawResult: "leaked page text" };
  const result = sanitizeActionEvent(tampered);
  assert(result.ok);
  assert(!("args" in result.event), "unknown fields must be dropped, not passed through");
  assert(!("rawResult" in result.event), "unknown fields must be dropped, not passed through");
});

// --- PerStreamSeqTracker -------------------------------------------------

await test("PerStreamSeqTracker rejects a redelivered/replayed seq and independent streams never interfere", () => {
  const tracker = new PerStreamSeqTracker();
  assert(tracker.accept("run:a", 1) === true);
  assert(tracker.accept("run:a", 2) === true);
  assert(tracker.accept("run:a", 2) === false, "a replayed seq must be rejected");
  assert(tracker.accept("run:a", 1) === false, "an older seq must be rejected");
  assert(tracker.accept("run:b", 1) === true, "a different stream's numbering must be independent");
  const seeded = new PerStreamSeqTracker();
  seeded.seed("run:c", 5);
  assert(seeded.accept("run:c", 5) === false, "seeding must count as already-accepted");
  assert(seeded.accept("run:c", 6) === true);
});

// --- SessionManager.recordActionEvents -----------------------------------

await test("recordActionEvents stores well-formed events and rejects malformed ones, reporting both counts", () => {
  const { sessionManager } = buildCore();
  const conversationId = sessionManager.newConversation({});
  const runId = freshRunId();
  const { start, progress, complete } = clickLifecycle({ runId, conversationId });
  const malformed = { ...complete, schemaVersion: 2 };
  const result = sessionManager.recordActionEvents(conversationId, [start, progress, complete, malformed]);
  assert(result.stored === 3, `expected 3 stored, got ${result.stored}`);
  assert(result.rejected === 1, `expected 1 rejected, got ${result.rejected}`);
  const snapshot = sessionManager.snapshotSince(conversationId, 0);
  const actionEvents = snapshot.events.filter((e) => e.type === "action_event");
  assert(actionEvents.length === 3);
});

await test("reconnect after a gap replays no duplicates: a redelivered batch is deduped by (streamKey, seq)", () => {
  const { sessionManager } = buildCore();
  const conversationId = sessionManager.newConversation({});
  const runId = freshRunId();
  const { start, progress, complete } = clickLifecycle({ runId, conversationId });
  const first = sessionManager.recordActionEvents(conversationId, [start, progress, complete]);
  assert(first.stored === 3);
  // Exact redelivery of the same batch (e.g. a retried native message).
  const redelivered = sessionManager.recordActionEvents(conversationId, [start, progress, complete]);
  assert(redelivered.stored === 0, "a fully redelivered batch must store nothing new");
  assert(redelivered.duplicate === 3);
  const snapshot = sessionManager.snapshotSince(conversationId, 0);
  const actionEvents = snapshot.events.filter((e) => e.type === "action_event");
  assert(actionEvents.length === 3, "no duplicate rows after redelivery");
});

await test("the dedup cursor survives a fresh SessionManager over the SAME persisted store (companion-restart safety)", () => {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sm1 = new SessionManager({ store, lease, approvals });
  const conversationId = sm1.newConversation({});
  const runId = freshRunId();
  const { start, progress, complete } = clickLifecycle({ runId, conversationId });
  sm1.recordActionEvents(conversationId, [start, progress, complete]);

  // Simulate a companion restart: brand-new SessionManager, same on-disk store.
  const sm2 = new SessionManager({ store, lease: new BrowserLease(), approvals: new ApprovalRegistry() });
  const redelivered = sm2.recordActionEvents(conversationId, [start, progress, complete]);
  assert(redelivered.stored === 0, "a restart must not forget already-persisted stream positions");
  assert(redelivered.duplicate === 3);
});

await test("movement samples stay grouped: 45 real points across pre-batched progress events persist as 3 rows, not 45", () => {
  const { sessionManager } = buildCore();
  const conversationId = sessionManager.newConversation({});
  const runId = freshRunId();
  const streamKey = streamKeyForRun(runId);
  const actionId = newActionId();
  const startedAt = Date.now();
  const action = { type: "drag", tool: "computer", op: "left_click_drag" };

  const batcher = new PointBatcher(20);
  const events = [
    buildEvent({ kind: "start", streamKey, runId, conversationId, actionId, action, timing: { startedAt } })
  ];
  for (let i = 0; i < 45; i++) {
    const flushed = batcher.push({ x: i, y: i, t: Date.now(), phase: "move" });
    if (flushed) {
      events.push(
        buildEvent({
          kind: "progress",
          streamKey,
          runId,
          conversationId,
          actionId,
          action,
          timing: { startedAt },
          pointer: { points: flushed, frame: { frameId: 0, isMainFrame: true } }
        })
      );
    }
  }
  const remaining = batcher.drain();
  if (remaining) {
    events.push(
      buildEvent({
        kind: "progress",
        streamKey,
        runId,
        conversationId,
        actionId,
        action,
        timing: { startedAt },
        pointer: { points: remaining, frame: { frameId: 0, isMainFrame: true } }
      })
    );
  }
  events.push(
    buildEvent({
      kind: "complete",
      streamKey,
      runId,
      conversationId,
      actionId,
      action,
      timing: { startedAt, endedAt: Date.now() },
      outcome: { status: "success", detail: null }
    })
  );

  const result = sessionManager.recordActionEvents(conversationId, events);
  assert(result.stored === events.length, "every well-formed batched event must store as ONE row each");
  const progressRows = sessionManager
    .snapshotSince(conversationId, 0)
    .events.filter((e) => e.type === "action_event" && e.event.kind === "progress");
  assert(progressRows.length === 3, `expected 3 progress rows (20+20+5), got ${progressRows.length}`);
  const totalPoints = progressRows.reduce((n, e) => n + e.event.pointer.points.length, 0);
  assert(totalPoints === 45, `expected all 45 points preserved across grouped rows, got ${totalPoints}`);
  assert(
    progressRows.every((e) => e.event.actionId === actionId),
    "every batched row must share the parent action's actionId"
  );
});

await test("the final answer (stream_message) and the action timeline never conflate in the same event log", () => {
  const { sessionManager, store } = buildCore();
  const conversationId = sessionManager.newConversation({});
  const runId = freshRunId();
  const { start, complete } = clickLifecycle({ runId, conversationId });
  sessionManager.recordActionEvents(conversationId, [start, complete]);
  store.appendEvent(conversationId, { type: "stream_message", message: { role: "assistant", content: "Done." } });
  const snapshot = store.snapshot(conversationId, 0);
  const answers = snapshot.events.filter((e) => e.type === "stream_message");
  const actionEvents = snapshot.events.filter((e) => e.type === "action_event");
  assert(answers.length === 1);
  assert(actionEvents.length === 2);
});

// --- ActionArtifactStore ---------------------------------------------------

await test("ActionArtifactStore round-trips exact bytes for a stored artifact", () => {
  const store = new ActionArtifactStore();
  const conversationId = "conv_artifact_1";
  fs.mkdirSync(conversationArtifactsDir(conversationId), { recursive: true });
  const buffer = Buffer.from("fake-jpeg-bytes-not-a-real-image");
  store.write(conversationId, "screenshot_111", buffer, { mimeType: "image/jpeg" });
  const read = store.read(conversationId, "screenshot_111");
  assert(read.found === true);
  assert(read.mimeType === "image/jpeg");
  assert(Buffer.compare(read.buffer, buffer) === 0, "bytes must round-trip exactly");
});

await test("a never-stored artifact resolves to explicit unavailable, never a substitute image", () => {
  const store = new ActionArtifactStore();
  const read = store.read("conv_artifact_2", "screenshot_does_not_exist");
  assert(read.found === false);
});

await test("a deleted artifact resolves to explicit unavailable, never a substitute image", () => {
  const store = new ActionArtifactStore();
  const conversationId = "conv_artifact_3";
  store.write(conversationId, "screenshot_222", Buffer.from("bytes"), { mimeType: "image/png" });
  assert(store.read(conversationId, "screenshot_222").found === true);
  fs.rmSync(path.join(conversationArtifactsDir(conversationId), "screenshot_222.png"));
  const read = store.read(conversationId, "screenshot_222");
  assert(read.found === false, "a deleted artifact must never resolve to any bytes");
});

// --- CompanionCore wiring: ACTION_EVENT / ACTION_ARTIFACT_REQUEST / chunk ingestion ---

await test("CompanionCore rejects action_event before hello (fail closed)", async () => {
  const { core } = buildCore();
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_EVENT, { conversationId: "x", events: [] }));
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH);
  assert(reply.reason === "hello_required");
});

await test("CompanionCore rejects an action_event envelope with an unsupported protocol version, even after hello", async () => {
  const { core } = buildCore();
  const conversationId = await helloAndNew(core);
  const bad = { ...makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_EVENT, { conversationId, events: [] }), v: 999 };
  const reply = await core.handleEnvelope(bad);
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH);
  assert(reply.reason === "unsupported_version");
  assert(reply.requested === 999);
});

await test("CompanionCore rejects action_event for an unknown conversationId", async () => {
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_EVENT, { conversationId: "conv_never_existed", events: [] })
  );
  assert(reply.type === AGENT_MESSAGE_TYPES.ERROR);
  assert(reply.reason === "unknown_conversation");
});

await test("CompanionCore end-to-end: hello -> new -> action_event -> snapshot_request shows the timeline events in order", async () => {
  const { core } = buildCore();
  const conversationId = await helloAndNew(core);
  const runId = freshRunId();
  const { start, progress, complete } = clickLifecycle({ runId, conversationId });
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_EVENT, { conversationId, events: [start, progress, complete] })
  );
  assert(reply.type === AGENT_MESSAGE_TYPES.ACTION_EVENT);
  assert(reply.stored === 3);

  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  const rows = snap.events.filter((e) => e.type === "action_event");
  assert(rows.length === 3);
  assert(rows[0].event.kind === "start" && rows[1].event.kind === "progress" && rows[2].event.kind === "complete", "order must be preserved");
  // Host-level storage seq (outer) must be strictly increasing — this is
  // what a reconnecting panel uses to restore scroll position.
  assert(rows[0].seq < rows[1].seq && rows[1].seq < rows[2].seq);
});

await test("CompanionCore: action_artifact_request for a missing artifact reports found:false, never triggers a capture", async () => {
  const { core } = buildCore();
  const conversationId = await helloAndNew(core);
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_ARTIFACT_REQUEST, { conversationId, artifactId: "screenshot_missing", requestId: "r1" })
  );
  assert(reply.type === AGENT_MESSAGE_TYPES.ACTION_ARTIFACT);
  assert(reply.found === false);
  assert(reply.reason === "not_found");
});

await test("CompanionCore: action_artifact_request for an unknown conversation reports found:false", async () => {
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_ARTIFACT_REQUEST, { conversationId: "conv_ghost", artifactId: "screenshot_1" })
  );
  assert(reply.found === false);
  assert(reply.reason === "unknown_conversation");
});

await test("CompanionCore: chunked ingestion stores an artifact's real bytes, then action_artifact_request resolves the EXACT same bytes", async () => {
  const { core } = buildCore();
  const conversationId = await helloAndNew(core);
  const artifactId = "screenshot_999888777";
  // A payload comfortably larger than one chunk to prove multi-part reassembly, not just a trivial single-part case.
  const original = Buffer.alloc(1_500_000);
  for (let i = 0; i < original.length; i++) original[i] = i % 256;

  const chunked = chunkBuffer(original, {
    meta: { kind: "action_artifact", conversationId, artifactId, mimeType: "image/jpeg" }
  });
  const sequence = flattenChunkedMessage(chunked).map((part) => makeEnvelope(part.type, part));
  let finalReply = null;
  for (const envelope of sequence) {
    const reply = await core.handleEnvelope(envelope);
    if (reply) finalReply = reply;
  }
  assert(finalReply, "the final chunk_end must produce a reply");
  assert(finalReply.type === AGENT_MESSAGE_TYPES.ACTION_ARTIFACT_STORED);
  assert(finalReply.stored === true, `expected stored:true, got ${JSON.stringify(finalReply)}`);
  assert(finalReply.sizeBytes === original.length);

  // Now resolve it back out through the retrieval path.
  const retrieveReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.ACTION_ARTIFACT_REQUEST, { conversationId, artifactId, requestId: "r2" })
  );
  assert(Array.isArray(retrieveReply.multi), "a found artifact must reply as a chunked multi-envelope sequence");
  const reassembler = new ChunkReassembler();
  let result = null;
  for (const part of retrieveReply.multi) {
    result = reassembler.receive(part);
  }
  assert(result && result.done, "the reply sequence must reassemble completely");
  assert(Buffer.compare(result.buffer, original) === 0, "retrieved bytes must be byte-identical to what was ingested");
});

await test("chunked ingestion for an unknown conversation is rejected, never silently accepted", async () => {
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const buf = Buffer.from("small");
  const chunked = chunkBuffer(buf, {
    meta: { kind: "action_artifact", conversationId: "conv_ghost", artifactId: "screenshot_x", mimeType: "image/jpeg" }
  });
  const sequence = flattenChunkedMessage(chunked).map((part) => makeEnvelope(part.type, part));
  let finalReply = null;
  for (const envelope of sequence) {
    const reply = await core.handleEnvelope(envelope);
    if (reply) finalReply = reply;
  }
  assert(finalReply.type === AGENT_MESSAGE_TYPES.ACTION_ARTIFACT_STORED);
  assert(finalReply.stored === false);
  assert(finalReply.reason === "unknown_conversation");
});

await test("a malformed/truncated chunk sequence is rejected outright (chunked-transport's own validation), not partially stored", async () => {
  const { core } = buildCore();
  const conversationId = await helloAndNew(core);
  const buf = Buffer.alloc(2_000_000);
  const chunked = chunkBuffer(buf, {
    meta: { kind: "action_artifact", conversationId, artifactId: "screenshot_truncated", mimeType: "image/jpeg" }
  });
  await core.handleEnvelope(makeEnvelope(chunked.begin.type, chunked.begin));
  await core.handleEnvelope(makeEnvelope(chunked.parts[0].type, chunked.parts[0]));
  // Skip remaining parts, go straight to chunk_end — must fail, not silently store a partial file.
  const reply = await core.handleEnvelope(makeEnvelope(chunked.end.type, chunked.end));
  assert(reply.type === AGENT_MESSAGE_TYPES.ERROR);
  assert(reply.reason === "chunk_rejected");
  const stored = new ActionArtifactStore().read(conversationId, "screenshot_truncated");
  assert(stored.found === false, "an incomplete transfer must never leave a persisted artifact");
});

// --- Non-negotiable: deleting a conversation removes only its own data, never recordings ---

await test("deleting a conversation removes its own action-timeline data but leaves recordings (a separate retention tree) untouched", () => {
  const { sessionManager, pendingRecordings } = buildCore();
  const conversationId = sessionManager.newConversation({});
  const runId = freshRunId();
  const { start, complete } = clickLifecycle({ runId, conversationId, outcomeStatus: "success" });
  sessionManager.recordActionEvents(conversationId, [start, complete]);

  const artifactStore = new ActionArtifactStore();
  artifactStore.write(conversationId, "screenshot_555", Buffer.from("bytes"), { mimeType: "image/jpeg" });
  assert(artifactStore.read(conversationId, "screenshot_555").found === true);

  // A recording is a completely separate tree/store — seed one so we can
  // prove it survives deletion of an UNRELATED conversation's data.
  pendingRecordings.add({ recordingId: "rec_survive_1", path: "/tmp/whatever/trace.json", schema: "v0", summary: "demo" });
  assert(pendingRecordings.has("rec_survive_1"));

  const { hadActiveRun } = sessionManager.deleteConversation(conversationId);
  assert(hadActiveRun === false);
  assert(!sessionManager.hasConversation(conversationId), "conversation itself must be gone");
  assert(artifactStore.read(conversationId, "screenshot_555").found === false, "this conversation's own artifact must be gone");
  assert(pendingRecordings.has("rec_survive_1"), "recordings must survive an unrelated conversation's deletion — separate retention");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

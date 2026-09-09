#!/usr/bin/env node
//
// Action-timeline wire transport, end to end (task 5.10's host half):
// exercises the REAL host/native-host.js process and the REAL forked
// companion.js child exactly as extension/background.js drives them today
// (host/test/agent-native-handshake.test.mjs / agent-recorder-push.test.mjs
// already established this harness for the version handshake and the
// recorder-push path; this file reuses it verbatim for action_event /
// action_artifact_request / chunked artifact ingestion).
//
// No live browser or Chrome extension is involved — this drives the exact
// native-messaging framing the extension's chrome.runtime.connectNative()
// port speaks, which IS the wire contract, not a simulation of it. Every
// action event sent here is built with the REAL
// extension/events/action-events.js's own buildEvent().
//
// Run: node host/test/agent-timeline-wire.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION } from "../agent/protocol.js";
import { chunkBuffer, flattenChunkedMessage, ChunkReassembler } from "../agent/broker/chunked-transport.js";
import { buildEvent, classifyAction, summarize, newActionId, streamKeyForRun } from "../../extension/events/action-events.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_HOST = path.join(HERE, "..", "native-host.js");

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

let seq = 0;
const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-timeline-wire-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-timeline-wire-${process.pid}-${n}.sock`);

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
    onAllMessages: (cb) => handlers.push(cb),
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
    const handler = (msg) => {
      if (msg && msg.type === "agent_msg" && msg.envelope && predicate(msg.envelope)) {
        clearTimeout(timer);
        resolve(msg.envelope);
      }
    };
    ext.onMessage(handler);
  });
}

/** Collect agent_msg envelopes matching `predicate` until `count` have
 * arrived (used for the multi-envelope chunked artifact reply). */
function collectAgentMsgs(ext, predicate, count, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(
      () => reject(new Error(`timed out collecting ${count} envelopes, got ${collected.length}`)),
      timeoutMs
    );
    ext.onMessage((msg) => {
      if (msg && msg.type === "agent_msg" && msg.envelope && predicate(msg.envelope)) {
        collected.push(msg.envelope);
        if (collected.length >= count) {
          clearTimeout(timer);
          resolve(collected);
        }
      }
    });
  });
}

function sendAgentMsg(ext, envelope) {
  ext.send({ type: "agent_msg", envelope });
}

let runCounter = 0;
function realClickEvents(runId, conversationId) {
  const streamKey = streamKeyForRun(runId);
  const actionId = newActionId();
  const startedAt = Date.now();
  const args = { action: "left_click", coordinate: [5, 6] };
  const cls = classifyAction("computer", args);
  const sum = summarize("computer", args);
  const action = { type: cls.type, tool: "computer", op: cls.op };
  const start = buildEvent({ kind: "start", streamKey, runId, conversationId, actionId, action, timing: { startedAt }, summary: sum.summary, redaction: sum.redaction });
  const complete = buildEvent({
    kind: "complete",
    streamKey,
    runId,
    conversationId,
    actionId,
    action,
    timing: { startedAt, endedAt: Date.now() },
    summary: sum.summary,
    redaction: sum.redaction,
    outcome: { status: "success", detail: null }
  });
  return [start, complete];
}

console.log("\nAction-timeline wire transport (real native-host.js + real forked companion.js)\n");

await test("hello -> new -> action_event -> snapshot_request round-trips real schema events through the real wire, in order", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-timeline-wire-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const snap = await snapWaiter;
    const conversationId = snap.conversationId;
    assert(conversationId, "new must return a conversationId");

    const runId = `run_wire_${++runCounter}`;
    const [start, complete] = realClickEvents(runId, conversationId);

    const actionEventWaiter = waitForAgentMsg(ext, (e) => e.type === "action_event");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "action_event", conversationId, events: [start, complete], ts: Date.now() });
    const ack = await actionEventWaiter;
    assert(ack.stored === 2, `expected stored:2, got ${JSON.stringify(ack)}`);

    const snapshotWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot" && e.conversationId === conversationId);
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "snapshot_request", conversationId, afterSeq: 0, ts: Date.now() });
    const resynced = await snapshotWaiter;
    const rows = resynced.events.filter((e) => e.type === "action_event");
    assert(rows.length === 2, `expected 2 stored action_event rows, got ${rows.length}`);
    assert(rows[0].event.kind === "start" && rows[1].event.kind === "complete", "order must be preserved end to end");
    assert(rows[1].event.outcome.status === "success");
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

await test("reconnect after a gap: resending the identical action_event batch over the real wire stores nothing new", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-timeline-wire-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const { conversationId } = await snapWaiter;

    const runId = `run_wire_${++runCounter}`;
    const events = realClickEvents(runId, conversationId);

    const firstAck = waitForAgentMsg(ext, (e) => e.type === "action_event");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "action_event", conversationId, events, ts: Date.now() });
    const first = await firstAck;
    assert(first.stored === 2);

    // A native-messaging retry, or a reconnecting panel resending its last
    // unacknowledged batch — the exact same payload, byte for byte.
    const secondAck = waitForAgentMsg(ext, (e) => e.type === "action_event");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "action_event", conversationId, events, ts: Date.now() });
    const second = await secondAck;
    assert(second.stored === 0, "a redelivered batch must store nothing new over the real wire");
    assert(second.duplicate === 2);

    const snapshotWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot" && e.conversationId === conversationId);
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "snapshot_request", conversationId, afterSeq: 0, ts: Date.now() });
    const resynced = await snapshotWaiter;
    assert(resynced.events.filter((e) => e.type === "action_event").length === 2, "no duplicate rows after a real redelivered wire batch");
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

await test("an action_event envelope with an unsupported protocol version fails closed over the real wire", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-timeline-wire-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const { conversationId } = await snapWaiter;

    const mismatchWaiter = waitForAgentMsg(ext, (e) => e.type === "version_mismatch");
    sendAgentMsg(ext, { v: 424242, type: "action_event", conversationId, events: [], ts: Date.now() });
    const rejection = await mismatchWaiter;
    assert(rejection.reason === "unsupported_version");
    assert(rejection.requested === 424242);
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

await test("screenshot artifact: real chunked ingestion + real chunked retrieval over the real wire reassemble to the exact original bytes", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-timeline-wire-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const { conversationId } = await snapWaiter;

    const artifactId = "screenshot_wire_e2e_1";
    // Comfortably larger than one chunk at the module's default
    // maxChunkBytes (700_000) so both the ingestion sequence AND the reply
    // sequence this test also drives are genuinely multi-part, using the
    // SAME default on both sides (companion.js's retrieval path does not
    // accept a custom maxChunkBytes) so the two sequences' part counts match.
    const original = Buffer.alloc(900_000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256;
    const chunked = chunkBuffer(original, {
      meta: { kind: "action_artifact", conversationId, artifactId, mimeType: "image/jpeg" }
    });
    const sequence = flattenChunkedMessage(chunked);

    const storedWaiter = waitForAgentMsg(ext, (e) => e.type === "action_artifact_stored");
    for (const part of sequence) {
      sendAgentMsg(ext, { v: PROTOCOL_VERSION, ...part, ts: Date.now() });
    }
    const storedAck = await storedWaiter;
    assert(storedAck.stored === true, `expected stored:true, got ${JSON.stringify(storedAck)}`);
    assert(storedAck.sizeBytes === original.length);

    const replyCollector = collectAgentMsgs(
      ext,
      (e) => e.type === "chunk_begin" || e.type === "chunk_part" || e.type === "chunk_end",
      sequence.length // same shape/size class as what was sent in, chunker is deterministic given the same maxChunkBytes default
    );
    sendAgentMsg(ext, {
      v: PROTOCOL_VERSION,
      type: "action_artifact_request",
      conversationId,
      artifactId,
      requestId: "wire-req-1",
      ts: Date.now()
    });
    const replyParts = await replyCollector;
    const reassembler = new ChunkReassembler();
    let result = null;
    for (const part of replyParts) result = reassembler.receive(part);
    assert(result && result.done, "the real wire reply sequence must reassemble completely");
    assert(Buffer.compare(result.buffer, original) === 0, "retrieved bytes over the real wire must be byte-identical to what was ingested");
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

await test("document: a stored document's bytes cross the real wire as a chunked reply and reassemble exactly", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-document-wire-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const { conversationId } = await snapWaiter;

    // Write the document into the SPAWNED host's own agent home. paths.js
    // reads OCIC_AGENT_HOME on every call, so pointing this process at the
    // same directory for the duration of the write is enough — the file the
    // host serves is the file written here, not a copy.
    const { DocumentStore } = await import("../agent/documents/store.js");
    const previousHome = process.env.OCIC_AGENT_HOME;
    let record;
    try {
      process.env.OCIC_AGENT_HOME = e2eHome;
      // Over one chunk at the module's 700_000-byte default, so the reply is
      // genuinely multi-part rather than a single envelope that would prove
      // nothing about the sequence.
      const body = `# Báo cáo\n\n${"nội dung dài ".repeat(70_000)}`;
      record = await new DocumentStore().write({ conversationId, title: "Báo cáo dài", format: "md", content: body });
    } finally {
      if (previousHome === undefined) delete process.env.OCIC_AGENT_HOME;
      else process.env.OCIC_AGENT_HOME = previousHome;
    }
    assert(record.byteLength > 700_000, `fixture must exceed one chunk, was ${record.byteLength}`);
    const expectedParts = Math.ceil(record.byteLength / 700_000) + 2; // begin + parts + end

    const replyCollector = collectAgentMsgs(
      ext,
      (e) => e.type === "chunk_begin" || e.type === "chunk_part" || e.type === "chunk_end",
      expectedParts
    );
    sendAgentMsg(ext, {
      v: PROTOCOL_VERSION,
      type: "document_request",
      conversationId,
      documentId: record.documentId,
      requestId: "doc-wire-1",
      ts: Date.now()
    });
    const replyParts = await replyCollector;

    // The chunk_begin carries what the panel needs to name and type the file
    // without a second round trip.
    const begin = replyParts.find((p) => p.type === "chunk_begin");
    assert(begin.kind === "document_bytes", `chunk kind was ${begin.kind}`);
    assert(begin.fileName === record.fileName && begin.mimeType === "text/markdown", "the reply is not self-describing");

    const reassembler = new ChunkReassembler();
    let result = null;
    for (const part of replyParts) result = reassembler.receive(part);
    assert(result && result.done, "the document reply sequence must reassemble completely");
    assert(result.buffer.length === record.byteLength, "reassembled length must match what was stored");
    assert(result.buffer.toString("utf8").startsWith("# Báo cáo"), "reassembled bytes must be the document");
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

await test("document: an unknown document resolves to an explicit unavailable envelope, never a stand-in file", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-document-missing-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const { conversationId } = await snapWaiter;

    const notFoundWaiter = waitForAgentMsg(ext, (e) => e.type === "document");
    sendAgentMsg(ext, {
      v: PROTOCOL_VERSION,
      type: "document_request",
      conversationId,
      documentId: "never-created",
      requestId: "doc-wire-2",
      ts: Date.now()
    });
    const reply = await notFoundWaiter;
    assert(reply.found === false, "an unknown document must report found:false");
    assert(reply.reason === "not_found", `reason was ${reply.reason}`);
  } finally {
    ext.kill();
    fs.rmSync(e2eHome, { recursive: true, force: true });
  }
});

await test("a missing artifact resolves to an explicit unavailable envelope over the real wire, never a substitute image", async () => {
  const e2eHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-timeline-wire-e2e-"));
  const ext = driveHostAsExtension(pipeFor(++seq), e2eHome);
  try {
    const helloWaiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "hello", ts: Date.now() });
    await helloWaiter;

    const snapWaiter = waitForAgentMsg(ext, (e) => e.type === "snapshot");
    sendAgentMsg(ext, { v: PROTOCOL_VERSION, type: "new", ts: Date.now() });
    const { conversationId } = await snapWaiter;

    const notFoundWaiter = waitForAgentMsg(ext, (e) => e.type === "action_artifact");
    sendAgentMsg(ext, {
      v: PROTOCOL_VERSION,
      type: "action_artifact_request",
      conversationId,
      artifactId: "screenshot_never_uploaded",
      requestId: "wire-req-2",
      ts: Date.now()
    });
    const reply = await notFoundWaiter;
    assert(reply.found === false);
    assert(reply.reason === "not_found");
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

process.exit(failed.length ? 1 : 0);

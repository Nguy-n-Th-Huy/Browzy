#!/usr/bin/env node
// The reported defect, end to end over the REAL wire: "mở lại hội thoại cũ thì
// chỉ thấy [Nội dung tin nhắn trước đó không có sẵn]" — reopening an old
// conversation could not show what was asked.
//
// Root cause it pins: the host persisted the ANSWER but never the QUESTION.
// conversation-model.js's `_ensureUserItemForRun()` falls back to
// `_localPrompts`, a bounded LOCAL preview cache (history-store.js's
// `prompts`), and for an old conversation in a fresh panel document there is
// nothing to fall back to — measured live: 165 cached conversations, 5 still
// holding any prompt text, every older one rendering the placeholder.
// SessionManager.startRun() now appends a `message_submitted` event, so the
// transcript itself carries the operator's words.
//
// This drives host/native-host.js as the extension does (native-messaging
// framing, exactly like test/sidepanel-fake-companion.test.mjs but across a
// real process boundary and a real pipe), sends one message, then RESUME's the
// conversation from a SECOND connection — the "another browser session, empty
// local cache" shape — and replays the resulting bytes through the REAL
// ConversationModel.
//
// Isolation: its own OCIC_PIPE and its own OCIC_AGENT_HOME, so it can never
// reach the user's live companion or their real conversation store.
//
// Run: node host/test/message-submitted-durability.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ConversationModel } from "../../extension/sidepanel/conversation-model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, "..", "native-host.js");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-message-submitted-"));
const pipe =
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-message-submitted-${process.pid}`
    : path.join(os.tmpdir(), `ocic-message-submitted-${process.pid}.sock`);

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

/**
 * One native-host connection speaking the extension's own wire contract:
 * 4-byte little-endian length prefix + JSON `{type: "agent_msg", envelope}`.
 */
function connect() {
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_AGENT_HOME: scratch, OCIC_PIPE: pipe },
    stdio: ["pipe", "pipe", "pipe"]
  });
  proc.stderr.on("data", () => {}); // the host logs bridge/companion chatter on stderr
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
    send(envelope) {
      const body = Buffer.from(JSON.stringify({ type: "agent_msg", envelope }), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      proc.stdin.write(Buffer.concat([header, body]));
    },
    waitFor(predicate, timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for an envelope")), timeoutMs);
        handlers.push((msg) => {
          if (msg && msg.type === "agent_msg" && msg.envelope && predicate(msg.envelope)) {
            clearTimeout(timer);
            resolve(msg.envelope);
          }
        });
      });
    },
    kill() {
      try {
        proc.kill();
      } catch {}
    }
  };
}

async function main() {
  console.log("\nThe operator's own message is durable, so an old conversation reopens complete\n");

  const first = connect();
  try {
    first.send({ v: 1, type: "hello", ts: Date.now() });
    const ack = await first.waitFor((e) => e.type === "hello_ack");
    ok(ack.v === 1, "the host answers the handshake (a real companion is behind it)");

    const created = first.waitFor((e) => e.type === "snapshot");
    first.send({ v: 1, type: "new", ts: Date.now(), meta: {} });
    const conversationId = (await created).conversationId;
    ok(typeof conversationId === "string" && conversationId.startsWith("conv_"), `a conversation exists (${conversationId})`);

    const prompt = "câu hỏi chỉ tồn tại ở phía host, không có trong bộ nhớ cục bộ";
    const started = first.waitFor((e) => e.type === "start");
    first.send({
      v: 1,
      type: "start",
      ts: Date.now(),
      conversationId,
      prompt,
      tabScope: "any",
      mode: "queue",
      idempotencyKey: "message-submitted-e2e-1"
    });
    const startReply = await started;
    ok(typeof startReply.runId === "string", "the send is accepted with a run id");
    // Let the run's own events land next to the message's.
    await new Promise((r) => setTimeout(r, 1500));

    // A SECOND connection: nothing of the first session's in-memory state is
    // reused, which is the browser-restart / fresh-panel shape.
    const second = connect();
    try {
      second.send({ v: 1, type: "hello", ts: Date.now() });
      await second.waitFor((e) => e.type === "hello_ack");
      const replayed = second.waitFor((e) => e.type === "snapshot" && e.conversationId === conversationId);
      second.send({ v: 1, type: "resume", ts: Date.now(), conversationId, afterSeq: 0 });
      const snapshot = await replayed;

      const events = snapshot.events || [];
      const submitted = events.find((e) => e.type === "message_submitted");
      ok(!!submitted, "the reopened transcript carries a message_submitted event");
      ok(
        submitted && submitted.submission && submitted.submission.text === prompt,
        "...with the operator's own text, verbatim"
      );
      ok(
        events.findIndex((e) => e.type === "run_created") < events.findIndex((e) => e.type === "message_submitted"),
        "...ordered after run_created, so a replay can bind it to the run that answers it"
      );

      // The panel half, on these exact bytes, with NO local prompt cache.
      const model = new ConversationModel(conversationId);
      model.applySnapshot(snapshot);
      const firstUser = model.items.find((i) => i.kind === "user");
      ok(!!firstUser && firstUser.text === prompt, "the panel renders the question instead of a placeholder");
      ok(!!firstUser && firstUser.isPlaceholder !== true, "...and marks it as a real bubble");
      ok(model.items.filter((i) => i.kind === "user").length === 1, "...exactly once");
      const seeded = model.submittedPrompts();
      ok(seeded.length === 1 && seeded[0].text === prompt, "...and the local prompt cache can be seeded from the same record");
    } finally {
      second.kill();
    }
  } finally {
    first.kill();
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL MESSAGE-DURABILITY TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});

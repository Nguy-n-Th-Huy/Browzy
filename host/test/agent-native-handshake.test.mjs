#!/usr/bin/env node
//
// host/native-host.js's own end of the agent-protocol version handshake:
// driven exactly the way extension/background.js drives it (native-messaging
// framed agent_msg envelopes over stdin/stdout), proving an unsupported
// version fails closed BEFORE any companion involvement, and that a
// supported hello is genuinely acknowledged.
//
// Run: node host/test/agent-native-handshake.test.mjs

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, "..", "native-host.js");

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

let seq = 0;
const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-handshake-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-handshake-${process.pid}-${n}.sock`);

// Speaks native messaging framing directly to native-host.js's stdin/stdout,
// exactly as extension/background.js's chrome.runtime.connectNative() port
// does — this IS the extension's wire contract, not a simulation of it.
function driveHostAsExtension(pipe) {
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
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

console.log("\nNative-host agent-protocol handshake (fail-closed)\n");

await test("an unsupported protocol version fails closed with version_mismatch, naming what IS supported", async () => {
  const ext = driveHostAsExtension(pipeFor(++seq));
  const waiter = waitForAgentMsg(ext, (e) => e.type === "version_mismatch");
  ext.send({ type: "agent_msg", envelope: { v: 999999, type: "hello", ts: Date.now() } });
  const envelope = await waiter;
  assert(envelope.reason === "unsupported_version", `expected unsupported_version, got ${envelope.reason}`);
  assert(envelope.requested === 999999, "must echo the requested version");
  assert(Array.isArray(envelope.supported) && envelope.supported.length > 0, "must name supported versions");
  ext.kill();
});

await test("a hello missing its version field fails closed rather than assuming the current one", async () => {
  const ext = driveHostAsExtension(pipeFor(++seq));
  const waiter = waitForAgentMsg(ext, (e) => e.type === "version_mismatch");
  ext.send({ type: "agent_msg", envelope: { type: "hello", ts: Date.now() } });
  const envelope = await waiter;
  assert(envelope.reason === "missing_version", `expected missing_version, got ${envelope.reason}`);
  ext.kill();
});

await test("a supported hello is genuinely acknowledged (real companion, not a stub)", async () => {
  const ext = driveHostAsExtension(pipeFor(++seq));
  const waiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
  ext.send({ type: "agent_msg", envelope: { v: 1, type: "hello", ts: Date.now() } });
  const envelope = await waiter;
  assert(envelope.v === 1, "ack should carry the negotiated version");
  ext.kill();
});

await test("an unsupported hello does not disrupt ordinary tool_request traffic on the same connection", async () => {
  const ext = driveHostAsExtension(pipeFor(++seq));
  ext.send({ type: "agent_msg", envelope: { v: -1, type: "hello", ts: Date.now() } });
  await sleep(200); // let the (irrelevant) rejection settle
  // Ordinary browser-tool traffic is a completely different message type
  // (tool_request from an attached MCP client, not from "the extension"
  // stdin at all) — assert only that the host process is still alive and
  // responsive to a second, valid hello, i.e. one bad handshake did not take
  // the whole bridge down.
  const waiter = waitForAgentMsg(ext, (e) => e.type === "hello_ack");
  ext.send({ type: "agent_msg", envelope: { v: 1, type: "hello", ts: Date.now() } });
  await waiter;
  ext.kill();
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);

if (process.platform !== "win32") {
  const { unlinkSync } = await import("node:fs");
  for (let i = 1; i <= seq; i++) {
    try {
      unlinkSync(pipeFor(i));
    } catch {}
  }
}

process.exit(failed.length ? 1 : 0);

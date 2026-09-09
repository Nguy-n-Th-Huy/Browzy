#!/usr/bin/env node
//
// Proves the group-1 ESM module-caching bug
// (reports/01-sdk-gate-evidence.md: "Node's ESM loader caches a module by
// resolved file URL for the life of a process... gate 1.5's reconnect test
// silently got gate 1.2's already-initialized, already-connected
// tool-runtime.js module instance") is structurally IMPOSSIBLE for the real
// companion, not merely avoided by convention.
//
// Method: fork two REAL companion processes (via the same
// createRealCompanion() entry point host/native-host.js's supervision code
// uses), each bound to its OWN scratch bridge (its own real native-host.js
// + fake extension, same technique as host/test/ownership.test.mjs), and
// prove each companion's tool calls are answered ONLY by its own bridge —
// including a "same tool name, different bridge, different fingerprint"
// check that would immediately reveal any cross-talk.
//
// Also proves the same-process guard directly: starting a second companion
// bridge inside ONE process (the exact shape of the original bug) is
// rejected outright by construction.
//
// Run: node host/test/agent-pipe-isolation.test.mjs

import net from "node:net";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, "..", "native-host.js");
const CHILD = path.join(HERE, "agent-companion-child.mjs");

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
    ? `\\\\.\\pipe\\ocic-pipe-iso-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-pipe-iso-${process.pid}-${n}.sock`);

function fakeExtension(pipe, tag) {
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stderr = [];
  proc.stderr.on("data", (c) => stderr.push(c.toString()));
  let buf = Buffer.alloc(0);
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
      buf = buf.subarray(4 + len);
      if (msg.type === "tool_request") {
        const body = Buffer.from(
          JSON.stringify({ id: msg.id, result: { echoTag: tag, tool: msg.tool } }),
          "utf-8"
        );
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        proc.stdin.write(Buffer.concat([header, body]));
      }
    }
  });
  return { proc, stderrText: () => stderr.join(""), kill: () => proc.kill() };
}

function bridgeIsHeld(pipe) {
  return new Promise((resolve) => {
    const probe = net.createConnection(pipe);
    const done = (v) => {
      probe.destroy();
      resolve(v);
    };
    probe.on("connect", () => done(true));
    probe.on("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
}
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(50);
  }
}

function startCompanionChild(pipe) {
  const child = fork(CHILD, [], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  let idc = 0;
  const pending = new Map();
  child.on("message", (msg) => {
    if (msg.ready) return;
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    child,
    ready: new Promise((resolve) => child.once("message", (m) => m.ready && resolve(m))),
    call(tool, args, meta) {
      const id = ++idc;
      child.send({ cmd: "call", id, tool, args, meta });
      return new Promise((resolve) => pending.set(id, resolve));
    },
    kill: () => child.kill()
  };
}

console.log("\nPer-companion-process pipe isolation (group-1 bug reproduction)\n");

await test("two companion processes on two different bridges never cross-talk", async () => {
  const pipeA = pipeFor(++seq);
  const pipeB = pipeFor(++seq);
  const extA = fakeExtension(pipeA, "BRIDGE_A");
  const extB = fakeExtension(pipeB, "BRIDGE_B");
  await waitFor(() => bridgeIsHeld(pipeA));
  await waitFor(() => bridgeIsHeld(pipeB));

  const companionA = startCompanionChild(pipeA);
  const companionB = startCompanionChild(pipeB);
  const readyA = await companionA.ready;
  const readyB = await companionB.ready;
  assert(readyA.pipe === pipeA, "companion A's own process env must report pipe A");
  assert(readyB.pipe === pipeB, "companion B's own process env must report pipe B");

  const replyA = await companionA.call("navigate", { url: "https://a.example" }, { runId: "runA" });
  const replyB = await companionB.call("navigate", { url: "https://b.example" }, { runId: "runB" });

  assert(replyA.ok, `companion A call failed: ${replyA.error}`);
  assert(replyB.ok, `companion B call failed: ${replyB.error}`);

  const textA = replyA.result.content?.[0]?.text || "";
  const textB = replyB.result.content?.[0]?.text || "";
  assert(textA.includes("BRIDGE_A"), `companion A must be answered by bridge A only, got: ${textA}`);
  assert(textB.includes("BRIDGE_B"), `companion B must be answered by bridge B only, got: ${textB}`);
  assert(!textA.includes("BRIDGE_B"), "companion A must NEVER see bridge B's tag (this is exactly the group-1 bug shape)");
  assert(!textB.includes("BRIDGE_A"), "companion B must NEVER see bridge A's tag");

  companionA.kill();
  companionB.kill();
  extA.kill();
  extB.kill();
});

await test("interleaved concurrent calls on both bridges still never cross — repeated to catch a race, not just a static wire-up", async () => {
  const pipeA = pipeFor(++seq);
  const pipeB = pipeFor(++seq);
  const extA = fakeExtension(pipeA, "BRIDGE_A2");
  const extB = fakeExtension(pipeB, "BRIDGE_B2");
  await waitFor(() => bridgeIsHeld(pipeA));
  await waitFor(() => bridgeIsHeld(pipeB));

  const companionA = startCompanionChild(pipeA);
  const companionB = startCompanionChild(pipeB);
  await companionA.ready;
  await companionB.ready;

  // One runId per companion (a single run making several tool calls, the
  // realistic shape — the browser-lease queueing of MULTIPLE different runs
  // is exercised separately in agent-lease.test.mjs). What this test checks
  // is purely: interleaved traffic on two independent bridges never crosses.
  const calls = [];
  for (let i = 0; i < 10; i++) {
    calls.push(companionA.call("computer", { n: i }, { runId: "runA" }));
    calls.push(companionB.call("computer", { n: i }, { runId: "runB" }));
  }
  const replies = await Promise.all(calls);
  replies.forEach((r, i) => {
    const expectTag = i % 2 === 0 ? "BRIDGE_A2" : "BRIDGE_B2";
    const text = r.result?.content?.[0]?.text || "";
    assert(text.includes(expectTag), `call ${i} expected ${expectTag}, got: ${text}`);
  });

  companionA.kill();
  companionB.kill();
  extA.kill();
  extB.kill();
});

await test("a single process may only ever start ONE companion bridge (structural guard against the original bug shape)", async () => {
  const { startCompanionProcess, _resetForTests } = await import("../agent/companion.js");
  _resetForTests();
  await startCompanionProcess({ browserIdentity: "test-a" });
  let threw = false;
  try {
    await startCompanionProcess({ browserIdentity: "test-b" });
  } catch (err) {
    threw = /exactly one bridge/.test(err.message);
  }
  assert(threw, "a second startCompanionProcess() call in the same process must be refused, not silently allowed");
  _resetForTests();
});

if (process.platform !== "win32") {
  const { unlinkSync } = await import("node:fs");
  for (let i = 1; i <= seq; i++) {
    try {
      unlinkSync(pipeFor(i));
    } catch {}
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

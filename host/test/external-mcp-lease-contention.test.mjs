#!/usr/bin/env node
//
// Task 6.5/6.6 (migrate-to-claude-agent-sdk): "Mixed-client contention: an
// SDK run and a legacy MCP client competing for the browser. The design
// requires one companion-wide lease covering both; prove the second client
// is queued and that control never crosses client scope."
//
// host/test/agent-lease.test.mjs (task-group-3-owned, unmodified here)
// already proves this end to end against a FAKE SDK-shaped client (a raw
// socket that merely attaches a runId to its JSON messages). This suite
// proves the same property using the REAL companion process
// (host/agent/companion.js's createRealCompanion(), via the existing
// host/test/agent-companion-child.mjs test harness — unmodified, already
// used by host/test/agent-pipe-isolation.test.mjs) driving its REAL
// ToolBridge, which is what actually attaches run/conversation/tabScope
// metadata in production — a stronger proof than a hand-written JSON
// message with the right-looking shape.
//
// "Control never crosses client scope" is proven at its strongest possible
// level here: the excluded party is NEVER DISPATCHED to the extension at
// all while the lease is held, so it cannot act on any tab — the SDK run's
// or anyone else's — regardless of what tabScope either side declares.
// Per-tab scope enforcement for calls that DO get dispatched (the
// extension/background.js borrowed-tab-scope logic) is a separate,
// already-covered concern: see test/registry-borrowed-tab-scope.test.mjs
// (task group 6.1, unowned here, unmodified, still passing).
//
// Run: node host/test/external-mcp-lease-contention.test.mjs

import net from "node:net";
import path from "node:path";
import { spawn, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_HOST = path.join(HERE, "..", "native-host.js");
const COMPANION_CHILD = path.join(HERE, "agent-companion-child.mjs");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}  — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-lease-ext-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-lease-ext-${process.pid}-${n}.sock`);

function fakeExtension(pipe) {
  const proc = spawn(process.execPath, [NATIVE_HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const handlers = [];
  const received = [];
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
    received, // every tool_request the extension actually saw, in order
    autoRespond(transform = (m) => ({ echo: m.tool })) {
      handlers.push((msg) => {
        if (msg.type === "tool_request") {
          received.push({ tool: msg.tool, runId: msg.runId ?? null, tabScope: msg.tabScope ?? null });
          const body = Buffer.from(JSON.stringify({ id: msg.id, result: transform(msg) }), "utf-8");
          const header = Buffer.alloc(4);
          header.writeUInt32LE(body.length, 0);
          proc.stdin.write(Buffer.concat([header, body]));
        }
      });
    },
    kill: () => proc.kill()
  };
}

function fakeLegacyClient(pipe, name) {
  const socket = net.createConnection(pipe);
  const pending = new Map();
  let idc = 0;
  let buf = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let idx;
    while ((idx = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, idx).toString("utf-8").trim();
      buf = buf.subarray(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const ready = new Promise((resolve) => {
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "client_hello" }) + "\n");
      resolve();
    });
  });
  return {
    name,
    ready,
    call(tool, args = {}, timeoutMs = 4000) {
      const id = String(++idc);
      socket.write(JSON.stringify({ id, type: "tool_request", tool, args }) + "\n");
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`${name}: ${tool} timed out`));
          }
        }, timeoutMs);
      });
    },
    sendRaw(obj) {
      socket.write(JSON.stringify(obj) + "\n");
    },
    close: () => socket.end()
  };
}

// Drives the REAL companion (host/agent/companion.js's createRealCompanion(),
// via the unmodified host/test/agent-companion-child.mjs harness) as a
// forked child process, bound to the given pipe, exactly the way
// host/test/agent-pipe-isolation.test.mjs already uses it. Every call goes
// through the REAL ToolBridge -> the REAL host/tool-runtime.js -> the REAL
// wire protocol to native-host.js, attaching real run-identifying metadata.
function realCompanion(pipe) {
  const child = fork(COMPANION_CHILD, [], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const pending = new Map();
  let idc = 0;
  child.on("message", (msg) => {
    if (msg?.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ready = new Promise((resolve) => {
    child.once("message", function onFirst(msg) {
      if (msg?.ready) resolve();
    });
  });
  return {
    ready,
    call(tool, args, meta, timeoutMs = 5000) {
      const id = ++idc;
      child.send({ cmd: "call", id, tool, args, meta });
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`companion call ${tool} timed out`));
          }
        }, timeoutMs);
      });
    },
    kill: () => child.kill()
  };
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
async function waitFor(fn, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
}

console.log("\nExternal MCP — mixed-client contention with a REAL companion (6.5/6.6)\n");

await test("a REAL companion's run excludes a concurrent legacy client (busy, retryable, NEVER dispatched), release lets it through, and legacy-vs-SDK dispatch is never interleaved", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ echo: m.tool, sawRunId: m.runId ?? null }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const sdk = realCompanion(pipe);
  await sdk.ready;
  const legacy = fakeLegacyClient(pipe, "legacy");
  await legacy.ready;

  // The REAL companion's ToolBridge claims the lease with its first tagged call.
  const sdkResult = await sdk.call("navigate", { url: "https://example.com" }, { runId: "run1", conversationId: "conv1", tabScope: [100] });
  assert(sdkResult.ok, `sdk call failed: ${JSON.stringify(sdkResult)}`);
  const sdkText = sdkResult.result?.content?.[0]?.text ?? "";
  assert(/navigate/.test(sdkText), `unexpected sdk reply: ${sdkText}`);
  assert(ext.received.at(-1)?.runId === "run1", "the extension should have seen run1's runId forwarded through native-host.js");

  // A concurrent legacy call must be excluded WITHOUT EVER REACHING THE EXTENSION.
  const dispatchCountBefore = ext.received.length;
  const legacyReply = await legacy.call("computer", {});
  assert(legacyReply.type === "tool_error", `legacy call must be rejected while the SDK run holds the lease, got ${JSON.stringify(legacyReply)}`);
  assert(legacyReply.busy === true, "rejection must be flagged retryable busy, not a hard failure");
  assert(/retryable/.test(legacyReply.error), "busy error text must say this is retryable");
  assert(ext.received.length === dispatchCountBefore, "the excluded legacy call must NEVER have been dispatched to the extension — this is the 'control never crosses client scope' guarantee");

  // Release the lease (the same mechanism the real companion's ToolBridge/
  // Run would use on stop — see host/tool-runtime.js's releaseLease()),
  // then the legacy client proceeds normally, dispatched for real.
  const releaser = fakeLegacyClient(pipe, "releaser");
  await releaser.ready;
  releaser.sendRaw({ type: "lease_release", runId: "run1" });
  await sleep(150);
  const afterRelease = await legacy.call("computer", {});
  assert(afterRelease.result?.echo === "computer", "legacy client should succeed once the lease is released");
  assert(ext.received.at(-1).tool === "computer" && ext.received.at(-1).runId === null, "the post-release dispatch should be the legacy call, carrying no runId");

  releaser.close();
  legacy.close();
  sdk.kill();
  ext.kill();
});

await test("a second REAL SDK run is excluded exactly like a legacy client would be — exclusivity is not legacy-specific", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ echo: m.tool, sawRunId: m.runId ?? null }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const sdkA = realCompanion(pipe);
  await sdkA.ready;
  const sdkB = realCompanion(pipe);
  await sdkB.ready;

  const first = await sdkA.call("navigate", {}, { runId: "runA", conversationId: "convA", tabScope: [1] });
  assert(first.ok, `first sdk run failed: ${JSON.stringify(first)}`);

  const dispatchCountBefore = ext.received.length;
  // A second, DIFFERENT companion process (a second SDK conversation) tries
  // to dispatch while runA holds the lease. host/tool-runtime.js surfaces a
  // busy tool_error as a plain error() rejection from callTool's own
  // try/catch — the companion's toolBridge.call() therefore comes back
  // { ok: true, result: { content: [{ type:"text", text:"Error: ..." }] } }
  // (see host/tool-runtime.js's callTool()'s catch branch), not a thrown
  // exception — same non-upgraded-to-isError shape task 6.6 requires
  // preserved for every client, SDK or legacy alike.
  const second = await sdkB.call("navigate", {}, { runId: "runB", conversationId: "convB", tabScope: [2] });
  assert(second.ok, `second sdk run's call errored unexpectedly at the IPC layer: ${JSON.stringify(second)}`);
  const secondText = second.result?.content?.[0]?.text ?? "";
  assert(/busy/i.test(secondText) && /retryable/i.test(secondText), `second run should see the busy/retryable message, got: ${secondText}`);
  assert(ext.received.length === dispatchCountBefore, "the excluded second SDK run must never have been dispatched to the extension either — tab scope [2] never touched tab scope [1]'s browser at all");

  sdkA.kill();
  sdkB.kill();
  ext.kill();
});

// On POSIX a unix socket outlives its process.
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

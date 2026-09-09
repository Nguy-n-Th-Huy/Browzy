#!/usr/bin/env node
//
// The single companion-wide browser lease: unit tests for both halves
// (host/agent/broker/browser-lease.js — in-process conversation queueing;
// host/agent/broker/native-lease.js — cross-process arbitration) plus an
// end-to-end test against the REAL host/native-host.js proving:
//   - an SDK run can exclude a concurrent legacy client (busy, retryable,
//     no dispatch to the extension),
//   - release lets the legacy client through afterward,
//   - and — critically — nothing changes for clients that never opt into the
//     lease protocol, so host/test/ownership.test.mjs's existing concurrent-
//     client behavior is provably unaffected by this change.
//
// Run: node host/test/agent-lease.test.mjs

import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BrowserLease, isTabInScope } from "../agent/broker/browser-lease.js";
import { NativeLeaseGuard, busyErrorMessage } from "../agent/broker/native-lease.js";

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

console.log("\nBrowser lease\n");

// --- Unit tests: BrowserLease (in-process, per-companion) -----------------

await test("isTabInScope: 'any' allows everything, an explicit list only its own", () => {
  assert(isTabInScope("any", 42), "'any' scope should allow any tab");
  assert(isTabInScope([1, 2, 3], 2), "explicit scope should allow a listed tab");
  assert(!isTabInScope([1, 2, 3], 99), "explicit scope must reject an unlisted tab");
  assert(!isTabInScope(undefined, 1), "an undefined scope must not silently allow");
});

await test("BrowserLease: free lease grants immediately", async () => {
  const lease = new BrowserLease();
  const release = await lease.acquire({ runId: "r1", conversationId: "c1" });
  assert(lease.isHeld(), "lease should be held after acquire");
  assert(lease.currentHolder().runId === "r1", "holder should be r1");
  release();
  assert(!lease.isHeld(), "lease should be free after release");
});

await test("BrowserLease: a second conversation queues until release (spec: 'Concurrent conversation')", async () => {
  const lease = new BrowserLease();
  const release1 = await lease.acquire({ runId: "r1", conversationId: "c1" });
  let grantedSecond = false;
  const p2 = lease.acquire({ runId: "r2", conversationId: "c2" }).then((release2) => {
    grantedSecond = true;
    return release2;
  });
  await sleep(50);
  assert(!grantedSecond, "second run must not be granted while the first still holds the lease");
  assert(lease.queuedRunIds().includes("r2"), "second run should appear in the queue");
  release1();
  const release2 = await p2;
  assert(grantedSecond, "second run should be granted once released");
  assert(lease.currentHolder().runId === "r2", "holder should now be r2");
  release2();
});

await test("BrowserLease: browser switch drops the holder and clears the queue", async () => {
  const lease = new BrowserLease({ browserIdentity: "install-A" });
  await lease.acquire({ runId: "r1", conversationId: "c1" });
  const p2 = lease.acquire({ runId: "r2", conversationId: "c2" });
  const dropped = lease.releaseForBrowserSwitch("install-B");
  assert(dropped.some((w) => w.runId === "r2"), "the queued waiter should be reported as dropped, not silently granted");
  assert(!lease.isHeld(), "lease must be free immediately after a browser switch");
  assert(lease.browserIdentity === "install-B", "browser identity should update on switch");
  // The dropped waiter's promise never resolves — that is intentional (it
  // must re-request against the new browser rather than being silently
  // granted stale context). Don't await p2; just confirm it hasn't settled.
  let settled = false;
  p2.then(() => (settled = true));
  await sleep(20);
  assert(!settled, "a dropped queued waiter must not be silently granted after a browser switch");
});

// --- Unit tests: NativeLeaseGuard (cross-process arbitration) -------------

await test("NativeLeaseGuard: no lease ever created when nobody sends a runId (regression parity)", () => {
  const guard = new NativeLeaseGuard();
  assert(guard.check({ clientId: "1" }).allow, "anonymous request with no lease held must pass");
  assert(guard.check({ clientId: "2" }).allow, "a second anonymous client must also pass — no lease was ever created");
  assert(guard.currentLease() === null, "no lease should exist when nobody ever declared a runId");
});

await test("NativeLeaseGuard: a runId-bearing request claims the lease and excludes others", () => {
  const guard = new NativeLeaseGuard();
  assert(guard.check({ clientId: "sdk", runId: "run1", conversationId: "conv1" }).allow, "first runId claim should be granted");
  const blocked = guard.check({ clientId: "legacy" }); // anonymous, different client
  assert(!blocked.allow, "an anonymous client from a different socket must be excluded while a run holds the lease");
  assert(blocked.reason === "browser_busy", `expected browser_busy, got ${blocked.reason}`);
  assert(busyErrorMessage(blocked.heldBy).includes("retryable"), "busy error text must say this is retryable");
});

await test("NativeLeaseGuard: the same run refreshing its own lease is allowed", () => {
  const guard = new NativeLeaseGuard();
  guard.check({ clientId: "sdk", runId: "run1", conversationId: "conv1" });
  const again = guard.check({ clientId: "sdk", runId: "run1", conversationId: "conv1" });
  assert(again.allow, "the same run must be able to keep dispatching");
});

await test("NativeLeaseGuard: a second run is queued-equivalent (bounced busy) until release", () => {
  const guard = new NativeLeaseGuard();
  guard.check({ clientId: "sdkA", runId: "runA", conversationId: "convA" });
  const second = guard.check({ clientId: "sdkB", runId: "runB", conversationId: "convB" });
  assert(!second.allow, "a second conversation's run must be excluded while the first holds the lease");
  guard.release("runA");
  const afterRelease = guard.check({ clientId: "sdkB", runId: "runB", conversationId: "convB" });
  assert(afterRelease.allow, "after release, the second run should be grantable");
});

await test("NativeLeaseGuard: releaseForClient (connection loss) frees the lease", () => {
  const guard = new NativeLeaseGuard();
  guard.check({ clientId: "sdk", runId: "run1", conversationId: "conv1" });
  guard.releaseForClient("sdk");
  assert(guard.currentLease() === null, "connection loss must release the lease");
});

await test("NativeLeaseGuard: expiry frees a stale lease", () => {
  const guard = new NativeLeaseGuard({ ttlMs: 5 });
  guard.check({ clientId: "sdk", runId: "run1", conversationId: "conv1" });
  return sleep(20).then(() => {
    assert(guard.currentLease() === null, "an expired lease must be treated as free");
  });
});

// --- End-to-end: real native-host.js, real fake-extension pattern --------
// (Same technique host/test/ownership.test.mjs already uses to exercise
// native-host.js without Chrome.)

let seq = 0;
const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-agent-lease-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-agent-lease-${process.pid}-${n}.sock`);

function fakeExtension(pipe) {
  const proc = spawn(process.execPath, [HOST], {
    env: { ...process.env, OCIC_PIPE: pipe, OCIC_COMPANION_CHILD: "" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const handlers = [];
  const stderr = [];
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
  proc.stderr.on("data", (c) => stderr.push(c.toString()));
  return {
    proc,
    stderrText: () => stderr.join(""),
    autoRespond(transform = (m) => ({ echo: m.tool })) {
      handlers.push((msg) => {
        if (msg.type === "tool_request") {
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

function fakeClient(pipe, name) {
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
    call(tool, args = {}, extra = {}, timeoutMs = 3000) {
      const id = String(++idc);
      socket.write(JSON.stringify({ id, type: "tool_request", tool, args, ...extra }) + "\n");
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

await test("real bridge: an SDK run excludes a concurrent legacy client (busy, retryable, never dispatched)", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ echo: m.tool, sawRunId: m.runId ?? null }));
  await waitFor(() => bridgeIsHeld(pipe));

  const sdk = fakeClient(pipe, "sdk");
  const legacy = fakeClient(pipe, "legacy");
  await Promise.all([sdk.ready, legacy.ready]);

  // The SDK claims the lease with its first tagged call.
  const sdkReply = await sdk.call("navigate", { url: "https://example.com" }, { runId: "run1", conversationId: "conv1" });
  assert(sdkReply.result?.echo === "navigate", "sdk call should reach the extension");
  assert(sdkReply.result?.sawRunId === "run1", "the extension should see the runId forwarded through native-host.js");

  // A concurrent anonymous (legacy) call must be bounced without reaching the extension.
  const legacyReply = await legacy.call("computer", {});
  assert(legacyReply.type === "tool_error", "legacy call must be rejected while the SDK run holds the lease");
  assert(legacyReply.busy === true, "rejection must be flagged as retryable busy, not a hard failure");
  assert(/retryable/.test(legacyReply.error), "error text must say this is retryable");

  // Release, then the legacy client proceeds normally.
  sdk.sendRaw({ type: "lease_release", runId: "run1" });
  await sleep(100);
  const afterRelease = await legacy.call("computer", {});
  assert(afterRelease.result?.echo === "computer", "legacy client should succeed once the lease is released");

  sdk.close();
  legacy.close();
  ext.kill();
});

await test("real bridge: legacy-only traffic (no runId anywhere) is completely unaffected — ownership.test.mjs parity", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ forTool: m.tool }));
  await waitFor(() => bridgeIsHeld(pipe));

  const clients = [];
  for (let i = 0; i < 6; i++) clients.push(fakeClient(pipe, `c${i}`));
  await Promise.all(clients.map((c) => c.ready));
  const replies = await Promise.all(clients.map((c, i) => c.call(`tool_${i}`, { n: i })));
  replies.forEach((r, i) => {
    assert(r.result?.forTool === `tool_${i}`, `client ${i} should get its own reply, unaffected by lease logic`);
  });

  clients.forEach((c) => c.close());
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

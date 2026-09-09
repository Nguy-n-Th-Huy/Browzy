#!/usr/bin/env node
//
// Task 6.5/6.6 (migrate-to-claude-agent-sdk): "Sidepanel close or SDK
// failure must not shut down the shared host while the browser and external
// clients remain connected" (design.md decision 5d) / "SDK failure while a
// legacy client is connected — the legacy client keeps working" (tasks.md
// 6.6).
//
// host/native-host.js (read-only for this task; owned by task group 3)
// forks a real companion child (host/agent/companion.js) automatically on
// ordinary bridge startup — see native-host.js's claimPipe() ->
// startCompanion(). This suite proves, against the REAL native-host.js and
// a REAL forked companion process (found by walking the OS process tree —
// no fake stand-in), that killing the companion out from under a connected
// legacy MCP client never interrupts that client's own tool traffic, and
// that the shared bridge (pipeServer, attached clients, the lease guard)
// survives the companion's death, restart-scheduling, and (once exhausted)
// permanent give-up untouched.
//
// Run: node host/test/external-mcp-companion-resilience.test.mjs

import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    ? `\\\\.\\pipe\\ocic-companion-res-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-companion-res-${process.pid}-${n}.sock`);

function fakeExtension(pipe) {
  const proc = spawn(process.execPath, [NATIVE_HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
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
async function waitFor(fn, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`);
    await sleep(50);
  }
}

// Find the REAL companion child forked by a given native-host.js pid, by
// walking the OS-recorded parent/child relationship and matching on the
// companion's own entry-point file name — no fake stand-in, the exact
// process host/native-host.js's startCompanion() actually creates.
function findCompanionPid(hostPid) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${hostPid}" | Where-Object { $_.CommandLine -like '*companion.js*' } | Select-Object -ExpandProperty ProcessId`
    ]).toString();
    const pid = parseInt(out.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {}
}

console.log("\nExternal MCP — SDK/companion failure does not degrade the shared host (6.5/6.6)\n");

if (process.platform !== "win32") {
  console.log(
    "  SKIPPED (all tests) — this suite's companion-pid discovery uses a Windows-specific" +
      " Win32_Process query; this environment is not win32. See host/test/agent-lease.test.mjs's" +
      " fake-runId-bearing-client E2E test for the platform-portable equivalent of the lease half" +
      " of this story."
  );
  console.log("\n0/0 passed (skipped — non-Windows)\n");
  process.exit(0);
}

await test("a legacy client's traffic is completely unaffected by the real companion's death (native-host.js keeps serving)", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ echo: m.tool, n: m.args?.n }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const companionPid = await waitFor(
    () => findCompanionPid(ext.proc.pid),
    8000,
    "companion child forked"
  ).then(() => findCompanionPid(ext.proc.pid));
  assert(companionPid, "could not find the real forked companion process");

  const legacy = fakeLegacyClient(pipe, "legacy");
  await legacy.ready;
  const before = await legacy.call("navigate", { n: 1 });
  assert(before.result?.echo === "navigate", "legacy call failed BEFORE the companion was ever touched");

  // Kill the real companion process — an ungraceful SDK/companion crash, not
  // a clean shutdown. native-host.js's own "companion exited" handler and
  // restart scheduling are exercised here for real, not simulated.
  killPid(companionPid);
  await waitFor(
    () => /companion exited/.test(ext.stderrText()),
    5000,
    "native-host.js logs the companion's exit"
  );

  // The bridge itself must still be reachable, and the legacy client's own
  // socket must not have been touched at all.
  assert(await bridgeIsHeld(pipe), "the shared bridge went down when the companion died — this is exactly what design.md 5d forbids");
  const immediatelyAfter = await legacy.call("navigate", { n: 2 });
  assert(immediatelyAfter.result?.echo === "navigate", "legacy call failed immediately after the companion died");

  // And after native-host.js's own scheduled restart fires (a fresh
  // companion comes back up), the legacy client must still be unaffected —
  // its socket to native-host.js was never touched by any of this.
  await waitFor(() => findCompanionPid(ext.proc.pid) !== null, 6000, "a fresh companion is respawned");
  const afterRestart = await legacy.call("navigate", { n: 3 });
  assert(afterRestart.result?.echo === "navigate", "legacy call failed after the companion's automatic restart");

  legacy.close();
  ext.kill();
});

await test("the legacy client keeps working even after the companion crash-loops past its restart budget and native-host.js gives up on it", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ echo: m.tool }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const legacy = fakeLegacyClient(pipe, "legacy");
  await legacy.ready;

  // native-host.js's MAX_COMPANION_RESTARTS is 5, with a growing backoff
  // (1s * min(30, restartCount*2): 2s, 4s, 6s, 8s, 10s after the 1st-5th
  // exits). The 6th exit pushes the restart counter past the budget and
  // native-host.js gives up permanently — reached by killing the companion
  // 6 times total. Kill it repeatedly, each time waiting for a fresh one to
  // reappear, until it stops coming back.
  let killedCount = 0;
  for (let i = 0; i < 10; i++) {
    const pid = await (async () => {
      try {
        return await waitFor(() => findCompanionPid(ext.proc.pid), 15000, `companion #${i + 1} appears`).then(() => findCompanionPid(ext.proc.pid));
      } catch {
        return null;
      }
    })();
    if (!pid) break; // it has given up restarting — exactly the state this test wants to reach
    killPid(pid);
    killedCount++;
    // Legacy traffic must keep working after EVERY single kill, not just the first.
    const reply = await legacy.call("navigate", {});
    assert(reply.result?.echo === "navigate", `legacy call failed after companion kill #${killedCount}`);
  }
  assert(killedCount >= 6, `expected to kill the companion at least 6 times (MAX_COMPANION_RESTARTS=5, so the 6th exit gives up) before it stopped restarting, only reached ${killedCount}`);
  assert(/giving up automatic restart/.test(ext.stderrText()), "native-host.js never logged giving up on the crash-looping companion");

  // Final confirmation: with the companion permanently gone, the bridge and
  // the legacy client are still completely healthy.
  assert(await bridgeIsHeld(pipe), "bridge went down after the companion permanently gave up");
  const finalReply = await legacy.call("computer", {});
  assert(finalReply.result?.echo === "computer", "legacy client stopped working once the companion permanently gave up — it must not depend on the companion at all");

  legacy.close();
  ext.kill();
  // This test intentionally takes roughly 30-45s of real wall-clock time:
  // native-host.js's own restart backoff (2s+4s+6s+8s+10s) is exercised for
  // real, not mocked, because the "gives up after N restarts" behavior is
  // itself part of what "SDK failure must not degrade external MCP" has to
  // survive.
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

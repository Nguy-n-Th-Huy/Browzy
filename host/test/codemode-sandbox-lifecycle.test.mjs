#!/usr/bin/env node
// Task 6.2 — host/codemode/common.js's SandboxLifecycle: proper lifecycle
// and error handling for the execute_code sandbox, adapted for a single
// disciplined owner (design.md task 6.2), plus the structural/behavioral
// proof that generated code is never evaluated in the Node process itself.
//
// No real wrangler/workerd is spawned here: startFn/runCodeFactory are
// injected fakes (an EventEmitter standing in for the child process, and a
// real local http server standing in for workerd's HTTP endpoint), exactly
// the seam SandboxLifecycle was built with for this purpose. A live
// end-to-end run through the real sandbox is a separate, genuinely
// live-infrastructure-dependent check — see the BLOCKED item at the bottom
// of this file's report entry (reports/06-preservation-evidence.md).
//
// Run: node host/test/codemode-sandbox-lifecycle.test.mjs

import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SandboxLifecycle,
  SandboxUnavailableError,
  makeRunCode
} from "../codemode/common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMMON_JS_PATH = path.join(__dirname, "..", "codemode", "common.js");

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

function fakeProc() {
  const ee = new EventEmitter();
  ee.pid = 999999; // never a real pid; dispose()'s process.kill is not exercised here
  return ee;
}

/** A real local HTTP server standing in for workerd's /execute endpoint, so
 * makeRunCode's real fetch-based wire behavior is exercised for real — just
 * against a fake backend instead of real wrangler. */
async function startFakeWorkerd(handler) {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    const out = await handler(parsed);
    // "Connection: close" (plus closeAllConnections() in closeFakeWorkerd
    // below) avoids leaving a keep-alive socket half-torn-down across
    // multiple independent server instances in one process — observed on
    // Windows/Node 24 as `Assertion failed: !(handle->flags &
    // UV_HANDLE_CLOSING)` from libuv on process.exit() otherwise. Purely a
    // test-harness hygiene detail; unrelated to SandboxLifecycle itself.
    res.writeHead(200, { "content-type": "application/json", Connection: "close" });
    res.end(JSON.stringify(out));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function closeFakeWorkerd(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log("\nSandboxLifecycle (task 6.2)\n");

await test("starts in 'starting' state before startFn resolves", async () => {
  let resolveStart;
  const startFn = () => new Promise((r) => { resolveStart = r; });
  const sandbox = new SandboxLifecycle({ startFn, runCodeFactory: () => async () => ({}) });
  assert(sandbox.state === "starting", `expected starting, got ${sandbox.state}`);
  resolveStart({ proc: fakeProc(), port: 1 });
  await sandbox.ready();
});

await test("transitions to 'ready' when startFn resolves, and runCode works", async () => {
  const proc = fakeProc();
  let sawCode = null;
  const sandbox = new SandboxLifecycle({
    startFn: async () => ({ proc, port: 1 }),
    runCodeFactory: () => async (code) => { sawCode = code; return { result: "ok" }; }
  });
  const isReady = await sandbox.ready();
  assert(isReady === true, "ready() must resolve true on success");
  assert(sandbox.state === "ready", `expected ready, got ${sandbox.state}`);
  const result = await sandbox.runCode("async () => 1");
  assert(sawCode === "async () => 1", "runCode must forward the exact code to the underlying factory");
  assert(result.result === "ok", "runCode must return the underlying result unmodified");
});

await test("startFn rejection (start failure) surfaces as a specific SandboxUnavailableError, not a generic throw", async () => {
  const sandbox = new SandboxLifecycle({
    startFn: async () => { throw new Error("wrangler exited (1) before ready."); },
    runCodeFactory: () => async () => ({})
  });
  const isReady = await sandbox.ready();
  assert(isReady === false, "ready() must resolve false, not reject");
  assert(sandbox.state === "unavailable", `expected unavailable, got ${sandbox.state}`);
  assert(sandbox.unavailableError instanceof SandboxUnavailableError, "must be the specific error type");
  assert(sandbox.unavailableError.reason === "start_failed", `expected start_failed, got ${sandbox.unavailableError.reason}`);
  let threw = null;
  try { await sandbox.runCode("x"); } catch (err) { threw = err; }
  assert(threw instanceof SandboxUnavailableError, "runCode must throw the same specific error type");
  assert(threw.reason === "start_failed", "runCode's thrown error must carry the same reason");
});

await test("a startup TIMEOUT is classified as 'start_timeout', distinct from an ordinary start failure", async () => {
  const sandbox = new SandboxLifecycle({
    startFn: async () => { throw new Error("wrangler did not become ready in 60s. output:\n"); },
    runCodeFactory: () => async () => ({})
  });
  await sandbox.ready();
  assert(sandbox.unavailableError.reason === "start_timeout", `expected start_timeout, got ${sandbox.unavailableError.reason}`);
});

await test("a sandbox that exits AFTER a successful start degrades to 'unavailable' with reason 'exited' — the gap the legacy startWorkerd()-only pattern does not cover", async () => {
  const proc = fakeProc();
  const sandbox = new SandboxLifecycle({
    startFn: async () => ({ proc, port: 1 }),
    runCodeFactory: () => async () => ({ result: "still fine" })
  });
  await sandbox.ready();
  assert(sandbox.state === "ready", "must be ready before the crash");
  const before = await sandbox.runCode("x");
  assert(before.result === "still fine", "runCode works while genuinely ready");

  proc.emit("exit", 1, null); // simulate the sandbox process crashing mid-session

  assert(sandbox.state === "unavailable", "state must flip to unavailable on exit, not stay ready");
  let threw = null;
  try { await sandbox.runCode("x"); } catch (err) { threw = err; }
  assert(threw instanceof SandboxUnavailableError, "post-crash runCode must throw the specific error, never hang or leak a raw fetch failure");
  assert(threw.reason === "exited", `expected exited, got ${threw.reason}`);
  assert(/exited/.test(threw.message), `message must name the exit, got: ${threw.message}`);
});

await test("a proc 'error' event (e.g. spawn failure after handoff) also degrades to unavailable, once", async () => {
  const proc = fakeProc();
  const sandbox = new SandboxLifecycle({
    startFn: async () => ({ proc, port: 1 }),
    runCodeFactory: () => async () => ({})
  });
  await sandbox.ready();
  proc.emit("error", new Error("EPIPE"));
  assert(sandbox.state === "unavailable", "an error event must also flip state");
  assert(sandbox.unavailableError.reason === "exited", "an error event is still classified under 'exited' (the process is gone either way)");
  // A second exit/error after the first must not overwrite the original reason.
  proc.emit("exit", 0, null);
  assert(/EPIPE/.test(sandbox.unavailableError.message), "the FIRST failure's detail must be preserved, not overwritten by a later event");
});

console.log("\nDirect browser operations stay available regardless of sandbox state (design.md 6.2)\n");

await test("execute_code degrading never disables anything else — SandboxLifecycle exposes no shared state with the browser-tool dispatch path", async () => {
  // Structural proof, not a behavioral one: SandboxLifecycle's public surface
  // (state/unavailableError/runCode/dispose) has no reference to
  // host/tool-runtime.js, extension/background.js, or any browser-dispatch
  // primitive — its unavailability literally cannot reach them, because
  // nothing wires it to them. host/codemode/server-hybrid.js's existing,
  // untouched passthrough path (`return await upstream.callTool(...)` for
  // every non-execute_code tool name) is the concrete evidence this already
  // holds for the current server; this assertion pins that SandboxLifecycle
  // introduces no NEW coupling that could regress it.
  const sandbox = new SandboxLifecycle({
    startFn: async () => { throw new Error("boom"); },
    runCodeFactory: () => async () => ({})
  });
  await sandbox.ready();
  assert(sandbox.state === "unavailable", "sanity: sandbox really is down");
  const ownKeys = Object.keys(sandbox);
  const forbidden = ["toolRuntime", "toolBridge", "callTool", "browserLease", "background"];
  for (const key of ownKeys) {
    assert(!forbidden.includes(key), `SandboxLifecycle must not hold a reference named "${key}" — that would couple sandbox failure to browser dispatch`);
  }
});

console.log("\nGenerated code is never evaluated in the companion/Node process (design.md 6.2, non-negotiable)\n");

await test("structural: host/codemode/common.js contains no eval/new Function/vm-based execution of the code argument", () => {
  const src = fs.readFileSync(COMMON_JS_PATH, "utf8");
  // A literal `eval(`, `new Function(`, or Node's `vm` module anywhere in
  // this file would be a red flag that generated code might be run locally
  // instead of shipped over the wire to the sandboxed worker process.
  assert(!/\beval\s*\(/.test(src), "common.js must not call eval()");
  assert(!/new\s+Function\s*\(/.test(src), "common.js must not construct a Function from generated code");
  assert(!/require\(["']vm["']\)|from\s+["']node:vm["']|from\s+["']vm["']/.test(src), "common.js must not import Node's vm module");
});

await test("behavioral: makeRunCode forwards `code` over the wire unmodified and returns EXACTLY the sandbox's response — never a locally-computed result", async () => {
  let received = null;
  const { server, port } = await startFakeWorkerd(async (body) => {
    received = body;
    // A canary value with NO relationship to the submitted code's actual
    // semantics. If Node ever evaluated `code` itself, this test's real
    // assertion below (the returned result equals the canary, not `2`)
    // would fail — the only way it can pass is if runCode did nothing but
    // relay bytes over HTTP and return the remote reply as-is.
    return { result: "CANARY_NEVER_COMPUTED_LOCALLY", logs: [], calls: [] };
  });
  try {
    const runCode = makeRunCode({ workerPort: port, callbackUrl: "http://127.0.0.1:1/unused", tools: [], namespace: "chrome" });
    const out = await runCode("async () => 1 + 1"); // if Node evaluated this, the "real" answer would be 2
    assert(received && received.code === "async () => 1 + 1", "the exact code string must reach the sandboxed endpoint unmodified");
    assert(out.result === "CANARY_NEVER_COMPUTED_LOCALLY", `runCode must return the sandbox's own reply verbatim, got: ${JSON.stringify(out)}`);
  } finally {
    await closeFakeWorkerd(server);
  }
});

await test("behavioral: SandboxLifecycle.runCode goes through the same real HTTP path, not a local shortcut", async () => {
  const { server, port } = await startFakeWorkerd(async (body) => ({ result: `echo:${body.code}`, logs: [], calls: [] }));
  try {
    const sandbox = new SandboxLifecycle({
      startFn: async () => ({ proc: fakeProc(), port }),
      callbackUrl: "http://127.0.0.1:1/unused",
      tools: [],
      namespace: "chrome"
      // runCodeFactory intentionally NOT overridden — exercises the REAL makeRunCode from common.js
    });
    await sandbox.ready();
    const out = await sandbox.runCode("async () => 'x'");
    assert(out.result === "echo:async () => 'x'", `expected the fake server's echo, got: ${JSON.stringify(out)}`);
  } finally {
    await closeFakeWorkerd(server);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

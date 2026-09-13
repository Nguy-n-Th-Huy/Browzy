#!/usr/bin/env node
//
// Task 6.5/6.6 (migrate-to-claude-agent-sdk): prove the three external MCP
// launch modes — default (host/mcp-server.js), codemode
// (host/codemode/server-codemode.js), and hybrid (host/codemode/server-hybrid.js)
// — remain an ongoing supported mode, independent of sidepanel provider setup
// and the SDK model lifecycle:
//
//   1. Structural: none of the three launch files (nor host/codemode/common.js,
//      which all three share) reach host/agent/** through their own import
//      graph — the SDK/settings/secrets/companion machinery is not merely
//      unused at runtime, it is UNREACHABLE from this code, by construction.
//   2. Behavioral: each of the three REAL server files, started as a real
//      stdio MCP server via the official @modelcontextprotocol/sdk Client,
//      with the process environment reduced to the MCP SDK's OWN minimal
//      inherited allowlist (StdioClientTransport's getDefaultEnvironment() —
//      APPDATA/PATH/TEMP/etc. on Windows; no ANTHROPIC_*/CLAUDE_* anywhere)
//      plus only OCIC_PIPE pointed at a scratch bridge, still lists and
//      calls tools correctly against a fake extension. No provider profile,
//      no stored key, no companion child was ever consulted.
//   3. Legacy argument coercion (string tabId -> number), image results
//      (screenshot-shaped content passed through byte-identical), and error
//      shapes (a tool_error from the extension surfaces as plain text
//      content, exactly as host/tool-runtime.js has always done — this is
//      NOT "improved" to isError:true, because that would be a behavior
//      change to a frozen contract) are all preserved through each launch
//      mode's own MCP protocol surface, not just at the shared runtime layer
//      (already covered elsewhere by test/handlers.test.mjs and
//      test/registry-baseline.test.mjs, which this suite does not duplicate).
//
// Environment: no live browser, no live Anthropic credential. Every fake
// extension here is the REAL host/native-host.js on a scratch pipe, driven
// exactly as Chrome would (same technique as host/test/ownership.test.mjs).
// codemode/hybrid unconditionally spawn a real `wrangler dev` child in the
// background on startup (host/codemode/common.js's startWorkerd(), fired
// from server-{codemode,hybrid}.js's Phase 2, independent of whether any
// test ever calls execute_code) — this suite never depends on wrangler
// reaching "ready" and always force-kills the whole spawned process TREE by
// PID on teardown (Windows: taskkill /T /F; POSIX: SIGKILL best-effort),
// so no wrangler/workerd process is left running regardless of wrangler's
// own state when the test ends. The live sandboxed execute_code round trip
// itself is intentionally out of this suite's scope — already tracked as
// BLOCKED (needs live infra) by reports/06-preservation-evidence.md's task
// 6.2/6.4 sections, closed the same documented way:
// `node host/codemode/test-hybrid.js` / `test-codemode.js`.
//
// Run: node host/test/external-mcp-launch-contracts.test.mjs

import net from "node:net";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = path.join(HERE, "..");
const NATIVE_HOST = path.join(HOST_DIR, "native-host.js");
const MCP_SERVER = path.join(HOST_DIR, "mcp-server.js");
const SERVER_CODEMODE = path.join(HOST_DIR, "codemode", "server-codemode.js");
const SERVER_HYBRID = path.join(HOST_DIR, "codemode", "server-hybrid.js");
const COMMON_JS = path.join(HOST_DIR, "codemode", "common.js");

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}  (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}  — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. Structural import-graph reachability -------------------------------
//
// Regex-based ESM import extraction (the same class of technique
// test/_extract.mjs already uses for read-only source analysis elsewhere in
// this repo) walked recursively over RELATIVE imports only — a bare
// specifier (an npm package, or a "node:" builtin) can never resolve inside
// this repo's own host/agent/ tree, so only relative imports matter for this
// specific question ("can this file reach host/agent/** through its own
// import graph").

function collectRelativeImports(entryFile, seen = new Set()) {
  const abs = path.resolve(entryFile);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  if (!existsSync(abs)) return seen;
  const src = readFileSync(abs, "utf-8");
  const importRe =
    /import\s+(?:[^'";]*?from\s+)?["']([^"']+)["']|export\s+(?:[^'";]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const dir = path.dirname(abs);
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !spec.startsWith(".")) continue; // skip bare/npm/node: specifiers
    let resolved = path.resolve(dir, spec);
    if (!path.extname(resolved)) resolved += ".js";
    collectRelativeImports(resolved, seen);
  }
  return seen;
}

function reachesHostAgent(entryFile) {
  const agentRoot = path.join(HOST_DIR, "agent") + path.sep;
  const graph = collectRelativeImports(entryFile);
  return [...graph].filter((p) => p.startsWith(agentRoot));
}

console.log("\nExternal MCP — launch and protocol contract preservation (6.5/6.6)\n");

await test("structural: host/mcp-server.js's import graph never reaches host/agent/**", () => {
  const hits = reachesHostAgent(MCP_SERVER);
  assert(hits.length === 0, `reaches host/agent/**: ${hits.join(", ")}`);
});

await test("structural: host/codemode/server-codemode.js's import graph never reaches host/agent/**", () => {
  const hits = reachesHostAgent(SERVER_CODEMODE);
  assert(hits.length === 0, `reaches host/agent/**: ${hits.join(", ")}`);
});

await test("structural: host/codemode/server-hybrid.js's import graph never reaches host/agent/**", () => {
  const hits = reachesHostAgent(SERVER_HYBRID);
  assert(hits.length === 0, `reaches host/agent/**: ${hits.join(", ")}`);
});

await test("structural: host/codemode/common.js (shared by both) never reaches host/agent/**", () => {
  const hits = reachesHostAgent(COMMON_JS);
  assert(hits.length === 0, `reaches host/agent/**: ${hits.join(", ")}`);
});

await test("structural: none of the three launch files reference ANTHROPIC_/CLAUDE_ env vars in their own source", () => {
  for (const f of [MCP_SERVER, SERVER_CODEMODE, SERVER_HYBRID, COMMON_JS]) {
    const src = readFileSync(f, "utf-8");
    assert(!/ANTHROPIC_(API_KEY|BASE_URL|AUTH_TOKEN)/.test(src), `${f} references a provider credential env var`);
    assert(!/CLAUDE_CODE_OAUTH/.test(src), `${f} references Claude OAuth state`);
  }
});

await test("structural: none of the three launch files (or the endpoint they share) reference the extension's ID or allowed_origins at all — external MCP registration is ID-agnostic by construction", () => {
  // A client's MCP registration (e.g. `claude mcp add ... -- node host/mcp-server.js`,
  // or codemode/hybrid's own stdio launch command) is a fixed absolute
  // command line pointing at a file on disk. host/endpoint.js's rendezvous
  // address is derived from the OS username, not from the extension's
  // Chrome-assigned ID. None of that has to change, and nothing here even
  // COULD reference the extension's id, when the extension reloads or the
  // browser restarts — proving "no repeated ID registration is needed" for
  // the external-MCP registration itself, independent of task group 2's own
  // (already covered, unowned here) native-messaging-host allowed_origins
  // stability proof in host/test/identity.test.mjs and
  // reports/02-packaging-evidence.md.
  const endpointJs = path.join(HOST_DIR, "endpoint.js");
  for (const f of [MCP_SERVER, SERVER_CODEMODE, SERVER_HYBRID, COMMON_JS, endpointJs]) {
    const src = readFileSync(f, "utf-8");
    assert(!/extension.?[iI]d|allowed_origins|chrome-extension:\/\//.test(src), `${f} references the extension id/allowed_origins — registration would not be ID-agnostic`);
  }
});

// --- 2. Real fake-extension harness (same technique as ownership.test.mjs) -

let seq = 0;
const pipeFor = (n) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-extmcp-${process.pid}-${n}`
    : path.join(process.env.TMPDIR || "/tmp", `ocic-extmcp-${process.pid}-${n}.sock`);

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
    onMessage: (cb) => handlers.push(cb),
    send(msg) {
      const body = Buffer.from(JSON.stringify(msg), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      proc.stdin.write(Buffer.concat([header, body]));
    },
    // Records every tool_request it ever answers, with the RAW args it
    // received, so a caller can assert on exactly what reached "the browser"
    // (coercion, echoed image content, etc.) rather than trusting the
    // client's own report of what it sent.
    received: [],
    autoRespond(transform) {
      handlers.push((msg) => {
        if (msg.type === "tool_request") {
          this.received.push({ tool: msg.tool, args: msg.args });
          const reply = transform ? transform(msg) : { echo: msg.tool, args: msg.args };
          this.send({ id: msg.id, ...reply });
        }
      });
    },
    kill: () => proc.kill()
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

// Force-kill an entire process TREE by pid. taskkill /T alone was tried
// first and found UNRELIABLE for this specific tree shape (verified by hand
// during this suite's development: it reliably killed the top-level MCP
// server process but reliably LEFT the wrangler/workerd descendants running
// — host/codemode/common.js's startWorkerd() spawns cmd.exe -> node
// (bin/wrangler.js) -> node (wrangler-dist/cli.js) -> workerd.exe, a chain
// that finishes materializing over roughly 1-3 real seconds, well after this
// suite's own MCP-level assertions return; taskkill's snapshot of the
// process tree, taken immediately after those assertions, simply predates
// most of that chain even existing yet, so /T has nothing to walk).
//
// The robust alternative used here: host/codemode/common.js's own
// startWorkerd() tags every spawned process's command line with a
// `--persist-to <tmpdir>/oc-wrangler-<variant>-<PID>` argument where PID is
// THIS TEST's own spawned top-level server process's pid — a unique,
// greppable fingerprint that survives however many process-spawning layers
// wrangler puts between itself and workerd. Sweep the ENTIRE system process
// list for that tag (catching cmd.exe / both node layers, which all carry
// the argument), then take one more hop to each matched process's direct
// children (catching workerd.exe, which does not carry the tag itself but
// is always a child of the tagged cli.js process) — repeated twice with a
// pause in between, since a first sweep run immediately after the MCP-level
// assertions can still predate later-spawned members of the chain.
function findTaggedTreePids(tagSubstring) {
  const psQuery = (filter) => {
    try {
      const out = execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        filter
      ]).toString();
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  };
  const escaped = tagSubstring.replace(/'/g, "''");
  const tagged = psQuery(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId`
  );
  const children = new Set();
  for (const pid of tagged) {
    for (const c of psQuery(
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`
    )) {
      children.add(c);
    }
  }
  return [...new Set([...tagged, ...children])];
}

async function killTree(pid, { wranglerTag } = {}) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    if (wranglerTag) {
      // Two sweeps: immediately, then again after the wrangler spawn chain
      // has had time to fully materialize, so a member that did not exist
      // yet at the first sweep is still caught.
      for (const delayMs of [0, 3000]) {
        if (delayMs) await sleep(delayMs);
        for (const p of findTaggedTreePids(wranglerTag)) {
          try {
            execFileSync("taskkill", ["/PID", String(p), "/F"], { stdio: "ignore" });
          } catch {}
        }
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

// Connect a real launch-mode server as a real MCP client, with the
// environment reduced to EXACTLY what @modelcontextprotocol/sdk's own
// StdioClientTransport inherits by default (see node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js's
// getDefaultEnvironment(): a fixed, small, platform-specific allowlist —
// APPDATA/PATH/TEMP/USERPROFILE/etc. on Windows, HOME/PATH/SHELL/etc. on
// POSIX — that structurally never includes ANTHROPIC_*/CLAUDE_* regardless
// of what this test process's OWN environment holds) plus only OCIC_PIPE.
// This is a stronger proof than "we remembered to delete some env vars":
// the transport itself never forwards them in the first place.
async function connectServer(serverPath, pipe, { extraEnv = {}, wranglerVariant } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { OCIC_PIPE: pipe, ...extraEnv },
    stderr: "pipe"
  });
  const stderrChunks = [];
  const client = new Client({ name: "external-mcp-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  transport.stderr?.on("data", (c) => stderrChunks.push(c.toString()));
  return {
    client,
    transport,
    pid: transport.pid,
    stderrText: () => stderrChunks.join(""),
    async teardown() {
      const pid = transport.pid;
      try {
        await Promise.race([client.close(), sleep(1000)]);
      } catch {}
      // host/codemode/common.js's startWorkerd() names its --persist-to
      // directory oc-wrangler-<variant>-<PID>, using THIS process's own pid
      // (the top-level server process spawned above) — the exact fingerprint
      // findTaggedTreePids() sweeps for. See killTree()'s comment for why
      // this is necessary instead of relying on taskkill /T alone.
      const wranglerTag = wranglerVariant ? `oc-wrangler-${wranglerVariant}-${pid}` : undefined;
      await killTree(pid, { wranglerTag });
    }
  };
}

// ---------------------------------------------------------------------------

await test("default mode (host/mcp-server.js): starts, lists the full registry, and calls a tool — env limited to the MCP SDK's own minimal allowlist (no ANTHROPIC_*/CLAUDE_* anywhere)", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ result: { echo: m.tool, echoedArgs: m.args } }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(MCP_SERVER, pipe);
  try {
    const { tools } = await server.client.listTools();
    assert(tools.length === 30, `expected 30 registry tools (26 preserved + 5 post-baseline - 1 removed), got ${tools.length}`);
    assert(tools.some((t) => t.name === "navigate"), "navigate missing from tool list");
    assert(tools.some((t) => t.name === "tabs_context_mcp"), "legacy _mcp-suffixed alias missing from tool list");

    const reply = await server.client.callTool({ name: "navigate", arguments: { url: "https://example.com", tabId: 7 } });
    const text = reply.content?.[0]?.text ?? "";
    assert(/navigate/.test(text), `unexpected reply: ${text}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

await test("default mode: legacy argument coercion is preserved (string tabId/coordinate arrive as real number/array at the extension)", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ result: { ok: true } }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(MCP_SERVER, pipe);
  try {
    // The MCP SDK's own zod validation runs on the CLIENT-declared schema,
    // so this must be sent as raw, uncoerced JSON-RPC — callTool's own
    // argument object is what some real MCP clients send when they
    // serialize numbers/arrays as strings. Send the request directly on the
    // transport to bypass the client's local schema validation and exercise
    // exactly the server-side coerceArgs() wrapping in host/mcp-server.js.
    const id = 9001;
    await new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg.id === id) {
          server.transport.onmessage = origOnMessage;
          resolve(msg);
        }
      };
      const origOnMessage = server.transport.onmessage;
      server.transport.onmessage = (msg) => {
        origOnMessage?.(msg);
        onMessage(msg);
      };
      server.transport
        .send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "computer", arguments: { action: "screenshot", tabId: "42", coordinate: "[1,2]" } }
        })
        .catch(reject);
      setTimeout(() => reject(new Error("coercion round trip timed out")), 4000);
    });

    await waitFor(() => ext.received.some((r) => r.tool === "computer"), 3000, "extension saw the computer call");
    const seen = ext.received.find((r) => r.tool === "computer");
    assert(typeof seen.args.tabId === "number" && seen.args.tabId === 42, `tabId not coerced to a number: ${JSON.stringify(seen.args)}`);
    assert(Array.isArray(seen.args.coordinate) && seen.args.coordinate[0] === 1, `coordinate not coerced to an array: ${JSON.stringify(seen.args)}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

await test("default mode: an image content block from the extension survives byte-identical (never collapsed to text)", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  const FAKE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  ext.autoRespond((m) => {
    if (m.tool === "computer" && m.args?.action === "screenshot") {
      return { result: { content: [{ type: "image", data: FAKE_B64, mimeType: "image/png" }] } };
    }
    return { result: { ok: true } };
  });
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(MCP_SERVER, pipe);
  try {
    const reply = await server.client.callTool({ name: "computer", arguments: { action: "screenshot", tabId: 1 } });
    const img = reply.content?.find((b) => b.type === "image");
    assert(img, `no image block in reply: ${JSON.stringify(reply)}`);
    assert(img.data === FAKE_B64, "image data was mutated in transit");
    assert(img.mimeType === "image/png", `mimeType changed: ${img.mimeType}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

await test("default mode: a tool_error from the extension surfaces as plain text content — the EXISTING shape, not upgraded to isError:true", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ type: "tool_error", error: "no such tab" }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(MCP_SERVER, pipe);
  try {
    const reply = await server.client.callTool({ name: "get_page_text", arguments: { tabId: 1 } });
    // host/tool-runtime.js's callTool() catches the rejection and returns
    // textResult(`Error: ${err.message}`) with NO isError flag — preserved
    // here exactly, not "fixed" to the arguably nicer isError:true shape.
    assert(reply.isError !== true, "isError was set — this is a behavior CHANGE from the existing contract, not preservation");
    const text = reply.content?.[0]?.text ?? "";
    assert(/Error: no such tab/.test(text), `unexpected error text: ${text}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

// --- codemode / hybrid: Phase-1 (no wrangler dependency) -------------------
//
// Both unconditionally spawn a real `wrangler dev` child on startup,
// independent of this suite ever calling execute_code (see file header).
// These tests exercise ONLY the parts that do not depend on wrangler ever
// becoming ready: stdio MCP connect, tools/list, and a passthrough tool
// call — proving the launch mode starts and serves tools with no provider
// credential — and always force-kill the whole process tree on teardown.

await test("codemode mode (server-codemode.js): starts, exposes execute_code + screenshot + zoom, and a passthrough (screenshot) call reaches the extension — no ANTHROPIC_*/CLAUDE_* env, no companion", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  const FAKE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  ext.autoRespond((m) => {
    if (m.tool === "computer") return { result: { content: [{ type: "image", data: FAKE_B64, mimeType: "image/png" }] } };
    return { result: { availableTabs: [], tabGroupId: null } };
  });
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(SERVER_CODEMODE, pipe, { wranglerVariant: "codemode" });
  try {
    const { tools } = await server.client.listTools();
    const names = tools.map((t) => t.name);
    assert(names.includes("execute_code"), `execute_code missing: ${names.join(", ")}`);
    assert(names.includes("screenshot"), `screenshot missing: ${names.join(", ")}`);
    assert(names.includes("zoom"), `zoom missing: ${names.join(", ")}`);

    const reply = await server.client.callTool({ name: "screenshot", arguments: { tabId: 3 } });
    const img = reply.content?.find((b) => b.type === "image");
    assert(img && img.data === FAKE_B64, `screenshot passthrough did not survive: ${JSON.stringify(reply)}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

await test("hybrid mode (server-hybrid.js): starts, exposes all 30 upstream tools + execute_code + recording_ack, and a direct passthrough call reaches the extension — no ANTHROPIC_*/CLAUDE_* env, no companion", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ result: { echo: m.tool } }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(SERVER_HYBRID, pipe, { wranglerVariant: "hybrid" });
  try {
    const { tools } = await server.client.listTools();
    const names = tools.map((t) => t.name);
    assert(names.includes("execute_code"), `execute_code missing: ${names.join(", ")}`);
    assert(names.includes("recording_ack"), `recording_ack missing: ${names.join(", ")}`);
    const upstreamCount = names.filter((n) => n !== "execute_code" && n !== "recording_ack").length;
    assert(upstreamCount === 30, `expected 30 upstream passthrough tools (26 preserved + 5 post-baseline - 1 removed), got ${upstreamCount}: ${names.join(", ")}`);

    const reply = await server.client.callTool({ name: "tabs_context_mcp", arguments: {} });
    const text = reply.content?.[0]?.text ?? "";
    assert(/tabs_context_mcp/.test(text), `unexpected passthrough reply: ${text}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

await test("hybrid mode: an error from the extension on a direct passthrough call is not upgraded to isError:true (unchanged contract)", async () => {
  const pipe = pipeFor(++seq);
  const ext = fakeExtension(pipe);
  ext.autoRespond((m) => ({ type: "tool_error", error: "extension busy" }));
  await waitFor(() => bridgeIsHeld(pipe), 5000, "host serving");

  const server = await connectServer(SERVER_HYBRID, pipe, { wranglerVariant: "hybrid" });
  try {
    const reply = await server.client.callTool({ name: "read_page", arguments: { tabId: 1 } });
    assert(reply.isError !== true, "isError was set on a hybrid passthrough call — a behavior change");
    assert(/Error: extension busy/.test(reply.content?.[0]?.text ?? ""), `unexpected reply: ${JSON.stringify(reply)}`);
  } finally {
    await server.teardown();
    ext.kill();
  }
});

// ---------------------------------------------------------------------------

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

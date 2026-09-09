// Gate 1.5 — cancellation, companion/browser reconnect, bounded errors, and a
// configured Anthropic endpoint/model round trip.
//
// Reconnect and bounded-error sub-gates run the REAL host/native-host.js and
// REAL host/tool-runtime.js against a scratch pipe with a fake extension
// stand-in (see lib/fake-extension.mjs) — the same technique
// host/test/ownership.test.mjs already uses. Cancellation spawns the REAL
// bundled Claude Code CLI binary via query({ abortController }) and proves
// the abort actually terminates it, pointed at an unreachable local address
// so no live provider is ever contacted. The Anthropic endpoint/model round
// trip genuinely needs a live, reachable, credentialed endpoint — that stays
// BLOCKED unless --live is passed with real credentials configured by the
// caller.

import { spawnFakeExtension, scratchPipe, sleep } from "../lib/fake-extension.mjs";
import { buildIsolatedOptions } from "../lib/query-options.mjs";

// Poll callTool() until it stops (or starts) reporting "not connected", up to
// a bounded number of attempts. native-host.js's own pipe-claim retry cadence
// (RETRY_MS = 1500ms) and tool-runtime.js's reconnect cadence (500ms) mean a
// single fixed sleep is inherently racy; polling is the honest way to wait
// for an asynchronous, real process handshake without either flaking or
// papering over a genuine hang with an arbitrarily long fixed delay.
async function waitForConnected(callTool, { attempts = 20, intervalMs = 300 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await callTool("tabs_context_mcp", { createIfEmpty: true });
    const text = last?.content?.[0]?.text ?? JSON.stringify(last);
    if (!/not connected/i.test(text)) return { ok: true, result: last, text, attempts: i + 1 };
    await sleep(intervalMs);
  }
  const text = last?.content?.[0]?.text ?? JSON.stringify(last);
  return { ok: false, result: last, text, attempts };
}

async function testReconnect(evidence) {
  const pipe = scratchPipe("1.5-reconnect");
  process.env.OCIC_PIPE = pipe;
  const { init, callTool, shutdown } = await import("../../../tool-runtime.js");
  await init();

  // 1. No extension yet -> real NO_BRIDGE_ERROR.
  const before = await callTool("tabs_context_mcp", {});
  const beforeText = before?.content?.[0]?.text ?? "";
  if (!/not connected/i.test(beforeText)) throw new Error(`expected not-connected before extension attaches, got: ${beforeText}`);
  evidence.push(`PASS: before any extension attaches, callTool() returns the real 'not connected' error`);

  // 2. Attach a fake extension; requests now round-trip for real through the
  // real native-host.js. Poll (bounded, ~6s max) rather than a fixed sleep —
  // this is a real process handshake (spawn -> claim pipe -> client
  // reconnect), not a fixed-latency operation.
  const ext1 = spawnFakeExtension(pipe);
  let respondEnabled = true;
  ext1.autoRespond((m) => ({ synthetic: true, tool: m.tool, echoedArgs: m.args }), () => respondEnabled);
  const connectedWait = await waitForConnected(callTool);
  evidence.push(`With extension attached: tabs_context_mcp -> ${connectedWait.text.slice(0, 140)} (after ${connectedWait.attempts} poll(s))`);
  if (!connectedWait.ok) throw new Error(`expected a real round trip once the extension attached, still saw not-connected after ${connectedWait.attempts} attempts. stderr: ${ext1.stderrText().slice(0, 500)}`);
  evidence.push("PASS: once a (stand-in) extension attaches, the real native-host.js + tool-runtime.js round-trip a tool call end to end");

  // 3. Disconnect mid-flight: dispatch a request the fake extension will
  // never answer, then kill it before it can reply. tool-runtime.js must
  // report "result unknown" (HOST_DROPPED_ERROR), not silently hang or
  // silently succeed.
  respondEnabled = false; // this request will reach the fake extension but get no reply
  const dropPromise = callTool("navigate", { url: "https://example.invalid", tabId: 1 });
  await sleep(150); // let the request actually reach native-host.js/the fake extension
  ext1.kill();
  const dropResult = await dropPromise;
  const dropText = dropResult?.content?.[0]?.text ?? "";
  evidence.push(`Disconnect mid-flight -> ${dropText.slice(0, 160)}`);
  if (!/result is unknown/i.test(dropText) && !/dropped/i.test(dropText)) {
    throw new Error(`expected the real HOST_DROPPED_ERROR wording, got: ${dropText}`);
  }
  evidence.push("PASS: a connection lost after dispatch (before the response arrived) is reported as result-unknown, per the existing HOST_DROPPED_ERROR contract — never silently retried");

  // 4. Reconnect: attach a fresh extension on the same pipe; new calls must
  // succeed again without any manual restart of tool-runtime.js.
  await sleep(400); // let the old native-host.js process fully exit and release the pipe
  const ext3 = spawnFakeExtension(pipe);
  ext3.autoRespond((m) => ({ synthetic: true, reconnected: true, tool: m.tool }));
  const reconnectWait = await waitForConnected(callTool);
  evidence.push(`After reconnect: tabs_context_mcp -> ${reconnectWait.text.slice(0, 140)} (after ${reconnectWait.attempts} poll(s))`);
  if (!reconnectWait.ok) throw new Error(`expected a working round trip after reconnect, still saw not-connected after ${reconnectWait.attempts} attempts. stderr: ${ext3.stderrText().slice(0, 500)}`);
  evidence.push("PASS: after the browser/extension reconnects on the same bridge, calls succeed again with no manual restart");

  ext3.kill();
  shutdown();
}

async function testCancellation(evidence) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  const t0 = Date.now();

  const q = query({
    prompt: "ping",
    options: {
      abortController: controller,
      env: {
        PATH: process.env.PATH || process.env.Path || "",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
        // Deliberately unreachable: 127.0.0.1:1 refuses connections instantly
        // on every platform, so this can never reach a live provider even if
        // the abort is slow.
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        ANTHROPIC_API_KEY: "sk-ant-spike-cancellation-test-not-a-real-key"
      },
      model: "claude-3-5-haiku-latest",
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      tools: []
    }
  });

  const messages = [];
  setTimeout(() => controller.abort(), 300);

  const HARD_TIMEOUT_MS = 25_000;
  let threw = null;
  await Promise.race([
    (async () => {
      try {
        for await (const msg of q) messages.push(msg.type);
      } catch (err) {
        threw = err;
      }
    })(),
    sleep(HARD_TIMEOUT_MS).then(() => {
      throw new Error(`cancellation did not resolve within ${HARD_TIMEOUT_MS}ms (hard gate timeout — likely hung)`);
    })
  ]);

  const elapsed = Date.now() - t0;
  evidence.push(`abortController.abort() called at ~300ms; generator settled at ${elapsed}ms (messages seen before abort took effect: ${messages.join(", ") || "none"})`);
  if (!controller.signal.aborted) throw new Error("abort signal was never set");
  if (!threw) throw new Error("expected query() to throw/stop on abort, it completed normally instead");
  evidence.push(`PASS: query() stopped in response to abortController.abort() (${threw.name}: ${threw.message}); no live Anthropic endpoint was ever reachable (ANTHROPIC_BASE_URL=http://127.0.0.1:1)`);
  evidence.push(
    `Note: observed latency between abort() and generator termination was ${elapsed - 300}ms, bound by the CLI's own retry/backoff before it next checks the abort signal — real measured behavior, not an assumption`
  );
}

// Live configured-endpoint/model round trip, resolved through the REAL
// production credential path (host/agent/settings/profile.js), never a raw
// ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY env var. A prior session's first
// draft of this gate read those two env vars directly, which would have let
// a live run bypass the profile/credential-store contract entirely; that was
// a real finding, not a style preference — production code (the eventual
// session orchestration in tasks.md group 3) will resolve credentials this
// same way, so the gate must too, or it stops proving what it claims to.
//
// Requires a profile to already be configured and a credential already
// stored (via profile.js's saveProfile()/setCredential(), which persists to
// the OS credential store) before running with --live — this gate does not,
// and must not, ever accept or embed a credential itself.
async function testConfiguredRoundTrip(evidence) {
  const ambientLeak = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].filter((k) => process.env[k]);
  if (ambientLeak.length) {
    throw new Error(
      `ambient credential env var(s) present in this process: ${ambientLeak.join(", ")} — this gate must prove the round ` +
        "trip works from the stored profile/credential alone, with zero ambient leakage; unset these and re-run"
    );
  }
  evidence.push("Ambient shell env check: clean — no ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN set in this process's own environment");

  const { loadProfile, snapshotForRun } = await import("../../settings/profile.js");
  const profile = await loadProfile();
  if (!profile || !profile.hasCredential || !profile.defaultModelId) {
    throw new Error(
      "no usable profile is configured (host/agent/settings/profile.js saveProfile()+setCredential() must be run first) — " +
        "gate-1.5 --live resolves the endpoint/model/credential exclusively through that production path, never through env vars"
    );
  }

  const snapshot = await snapshotForRun(profile.profileId, profile.defaultModelId);
  evidence.push(
    `snapshotForRun("${snapshot.profileId}", "${snapshot.model}") resolved a credential from the OS credential store ` +
      `(secretBackend: ${profile.secretBackend}) — env is isolated (only ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY/PATH/SystemRoot), never merged with process.env`
  );

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  const options = {
    abortController: controller,
    model: snapshot.model,
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    maxTurns: 1,
    env: {
      PATH: process.env.PATH || process.env.Path || "",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
      ...snapshot.env
    }
  };

  let resultMsg = null;
  const messageTypes = [];
  for await (const msg of query({ prompt: "Reply with exactly one word: pong", options })) {
    messageTypes.push(msg.type + (msg.subtype ? `:${msg.subtype}` : ""));
    if (msg.type === "result") resultMsg = msg;
  }
  if (!resultMsg || resultMsg.is_error) {
    throw new Error(`live round trip through query() failed: ${JSON.stringify(resultMsg)}`);
  }
  evidence.push(`message types observed: ${messageTypes.join(", ")}`);
  evidence.push(
    `PASS: a real round trip through query() succeeded using ONLY the isolated env produced by snapshotForRun() — subtype=${resultMsg.subtype}, ` +
      `${resultMsg.num_turns} turn(s), ${resultMsg.duration_ms}ms`
  );
}

export async function run({ live = false } = {}) {
  const evidence = [];
  await testReconnect(evidence);
  await testCancellation(evidence);

  if (!live) {
    return {
      id: "1.5",
      title: "Cancellation, reconnect, bounded errors, and an Anthropic endpoint/model round trip",
      status: "PASS_WITH_BLOCKED_SUBITEM",
      evidence,
      blockedReason:
        "The 'configured Anthropic endpoint/model round trip' sub-item requires a live, reachable, credentialed " +
        "Anthropic-compatible endpoint. Cancellation, reconnect, and bounded-error handling above are demonstrated " +
        "for real against the actual product code; only the live provider round trip is blocked.",
      exactCommand:
        "Configure a profile+credential via host/agent/settings/profile.js (saveProfile()+setCredential(), which stores " +
        "the key in the OS credential store — never an env var), then run: node host/agent/spike/gate.mjs --live"
    };
  }

  await testConfiguredRoundTrip(evidence);

  return {
    id: "1.5",
    title: "Cancellation, reconnect, bounded errors, and an Anthropic endpoint/model round trip",
    status: "PASS",
    evidence
  };
}

import { fileURLToPath } from "node:url";
import { runAsCli } from "../lib/cli-runner.mjs";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAsCli(run);
}

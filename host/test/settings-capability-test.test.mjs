#!/usr/bin/env node
//
// Bounded synthetic capability test (host/agent/settings/capability-test.js),
// exercised against the in-process fixture Anthropic-Messages-API server
// using the REAL `@anthropic-ai/claude-agent-sdk` `query()` — the same
// transport a real session uses — so a pass here is evidence the actual SDK
// wire protocol is compatible, not just a bespoke HTTP client.
//
// No live Anthropic credential is used or required. Every scenario is a
// deterministic local fixture. See reports/04-settings-evidence.md for the
// empirical trace (captured by pointing the real SDK at a local probe
// server) this fixture and the classification logic were built from.
//
// Run: node host/test/settings-capability-test.test.mjs
// (this one is slower than the others — each check spawns the real bundled
// Claude Code CLI as a child process; expect ~5-20s per check)

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runCapabilityTest } from "../agent/settings/capability-test.js";
import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";
import * as profile from "../agent/settings/profile.js";
import { readProfileFromDisk } from "../agent/settings/profile-store.js";
import { capabilityTestKey } from "../agent/settings/profile-schema.js";
import { createChatgptGateway, _setActiveGatewayForTests } from "../agent/chatgpt/gateway.js";

// Isolation (same pattern as host/test/skills-catalog.test.mjs and
// host/test/skills-dispatch.test.mjs): runCapabilityTest() observes each
// fixture's `system`/`init` message and calls capability-test.js's
// recordAdvertisedCommands(), which persists to
// host/agent/settings/advertised-commands.js's agentRoot() — OCIC_AGENT_HOME
// when set, else the developer's real ~/.config/browzy-in-chrome/agent.
// agentRoot() reads that env var live on every call rather than caching it
// at import time, so pointing it at a fresh scratch directory here is
// enough to keep this suite from ever writing into real developer state.
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-settings-capability-test-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

const results = [];
async function check(name, fn) {
  freshHome();
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} (${Date.now() - startedAt}ms) — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Short budgets: the fixture server responds in milliseconds for every
// scenario except the deliberate "hang" ones, so the real 60s/30s product
// defaults would only make failing-fast tests slow for no benefit. The
// "hang"/timeout check below uses its own short budget explicitly.
const FAST_BUDGETS = { startupBudgetMs: 8_000, testBudgetMs: 8_000 };

console.log("\nBounded synthetic capability test (real SDK, real fixture server)\n");

await check("all three sub-tests pass against a well-behaved fixture endpoint", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert(result.status === "pass", JSON.stringify(result));
    assert(result.capabilities.text === "pass", JSON.stringify(result.capabilities));
    assert(result.capabilities.tool === "pass", JSON.stringify(result.capabilities));
    assert(result.capabilities.vision === "pass", JSON.stringify(result.capabilities));
    assert(Object.keys(result.errors).length === 0, JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("a gateway that accepts the image block but answers without seeing it is reported vision-fail, not pass", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "vision-blind" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    // Text and tool are genuinely fine here — only vision is not.
    assert(result.capabilities.text === "pass", JSON.stringify(result.capabilities));
    assert(result.capabilities.tool === "pass", JSON.stringify(result.capabilities));
    assert(result.capabilities.vision === "fail", JSON.stringify(result.capabilities));
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.errors.vision.code === "VISION_ERROR", JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("401 is classified as AUTH_ERROR and blocks every sub-test (not silently retried into a false pass)", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "401" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-bad", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.errors.text.code === "AUTH_ERROR", JSON.stringify(result.errors));
    assert(result.capabilities.tool === "not_run", "an endpoint-level auth failure must skip the remaining sub-tests");
    assert(result.capabilities.vision === "not_run");
  } finally {
    await fixture.close();
  }
});

await check("403 is classified as AUTH_ERROR", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "403" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-bad", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert(result.errors.text.code === "AUTH_ERROR", JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("404 (model not found) is classified as MODEL_UNAVAILABLE_ERROR", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "404-model" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-missing-model", sdk, z, ...FAST_BUDGETS });
    assert(result.errors.text.code === "MODEL_UNAVAILABLE_ERROR", JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("429 is classified as RATE_LIMIT_ERROR", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "429" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert(result.errors.text.code === "RATE_LIMIT_ERROR", JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("connection refused (no server) is classified as NETWORK_ERROR", async () => {
  // Nothing is listening on this port.
  const result = await runCapabilityTest({ baseUrl: "http://127.0.0.1:1", apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
  assert(result.errors.text.code === "NETWORK_ERROR", JSON.stringify(result.errors));
});

await check("an OpenAI-Chat-Completions-shaped endpoint is classified PROTOCOL_ERROR, never reported compatible", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "protocol-openai" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert(result.status === "fail", "an OpenAI-Chat-Completions-only endpoint must never be reported as compatible");
    assert(result.errors.text.code === "PROTOCOL_ERROR", JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("a cross-origin redirect on /v1/messages is rejected (REDIRECT_REJECTED or an equivalent connection-level failure), never silently followed", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "redirect-cross-origin", redirectTargetOrigin: "http://127.0.0.1:1" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert(result.status === "fail", JSON.stringify(result));
    // The SDK's own transport (not this module's authenticatedFetch) makes
    // this particular request, so the exact taxonomy code it surfaces here
    // is transport-dependent; what must hold unconditionally is that the
    // run never completes as a "pass" against the redirect target.
    assert(result.capabilities.text === "fail", JSON.stringify(result));
  } finally {
    await fixture.close();
  }
});

await check("no response at all is classified TIMEOUT_ERROR once the (short, test-configured) deadline elapses", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "hang" });
  try {
    const result = await runCapabilityTest({
      baseUrl: fixture.url,
      apiKey: "sk-fixture",
      modelId: "fixture-model",
      sdk,
      z,
      startupBudgetMs: 2_000,
      testBudgetMs: 2_000
    });
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.errors.text.code === "TIMEOUT_ERROR", JSON.stringify(result.errors));
  } finally {
    await fixture.close();
  }
});

await check("capability results are reported separately: text can pass while tool/vision fail independently is at least structurally supported", async () => {
  // This check documents the reporting SHAPE (each capability its own key)
  // rather than forcing a real provider into a partial-capability state,
  // which the "success" fixture doesn't produce (see
  // reports/04-settings-evidence.md for why a genuine partial-capability
  // real-provider result is recorded BLOCKED, not fabricated).
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    const result = await runCapabilityTest({ baseUrl: fixture.url, apiKey: "sk-fixture", modelId: "fixture-model", sdk, z, ...FAST_BUDGETS });
    assert("text" in result.capabilities && "tool" in result.capabilities && "vision" in result.capabilities);
  } finally {
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------
// ChatGPT subscription provider capability path (add-chatgpt-subscription-
// provider). A `chatgpt` profile's testCapability() runs the SAME
// runCapabilityTest above, but through the companion's loopback gateway with
// a test-scoped gateway token (specs/agent-settings, "Explicit compatibility
// and connection testing"). The gateway's module-level instance is swapped
// for one backed by a real local mock Codex upstream (never a real
// ChatGPT/OpenAI endpoint) via gateway.js's documented test seam.
// ---------------------------------------------------------------------------

const CHATGPT_TEST_PROFILE_ID = "ocic-test-capability-chatgpt";
const CHATGPT_TEST_MODEL = "gpt-5.5";

function useScratchConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-capability-chatgpt-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  return dir;
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textFrames(text) {
  return (
    sseFrame("response.created", { type: "response.created", response: { id: "resp_mock", model: CHATGPT_TEST_MODEL } }) +
    sseFrame("response.output_text.delta", { type: "response.output_text.delta", delta: text }) +
    sseFrame("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_mock",
        model: CHATGPT_TEST_MODEL,
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 5, output_tokens: 9 }
      }
    })
  );
}

function toolFrames(name, args) {
  const callId = "call_mock_1";
  const item = { type: "function_call", id: "fc_mock_1", call_id: callId, name };
  return (
    sseFrame("response.created", { type: "response.created", response: { id: "resp_mock_tool", model: CHATGPT_TEST_MODEL } }) +
    sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: 0, item }) +
    sseFrame("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: args }) +
    sseFrame("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } }) +
    sseFrame("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_mock_tool",
        model: CHATGPT_TEST_MODEL,
        output: [{ type: "function_call", call_id: callId, name, arguments: args }],
        usage: { input_tokens: 5, output_tokens: 9 }
      }
    })
  );
}

/** A local mock of the Codex `responses` endpoint: answers the three
 * capability sub-tests distinctly (image -> names the probe, tools present on
 * a first turn -> one function call, otherwise plain text). */
async function startMockCodexUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        body = {};
      }
      requests.push({ headers: req.headers, body });
      const input = Array.isArray(body.input) ? body.input : [];
      const hasImage = JSON.stringify(input).includes('"input_image"');
      const hasFunctionOutput = input.some((item) => item && item.type === "function_call_output");
      const functionTool = Array.isArray(body.tools) ? body.tools.find((t) => t && t.type === "function") : null;
      let payload;
      if (hasImage) {
        payload = textFrames("The colour is red and the shape is a circle.");
      } else if (functionTool && !hasFunctionOutput) {
        payload = toolFrames(functionTool.name, "{}");
      } else {
        payload = textFrames("Hello from the mock Codex upstream.");
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/backend-api/codex/responses`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          setTimeout(resolve, 100).unref?.();
        }, 100).unref?.();
      })
  };
}

await check("a chatgpt profile that is not signed in (or whose session expired) sends no request at all", async () => {
  const fastProfile = async () => {
    useScratchConfigDir();
    await profile.saveProfile({
      profileId: CHATGPT_TEST_PROFILE_ID,
      baseUrl: "https://api.anthropic.com",
      models: [{ id: CHATGPT_TEST_MODEL, label: CHATGPT_TEST_MODEL }],
      defaultModelId: CHATGPT_TEST_MODEL
    });
    await profile.setProviderType(CHATGPT_TEST_PROFILE_ID, "chatgpt");
  };

  let upstreamCalls = 0;
  const gw = createChatgptGateway({
    upstreamUrl: "http://127.0.0.1:1/never",
    getAccessToken: async () => {
      throw new Error("the ChatGPT credential must never be read for a not-eligible profile");
    },
    loadProfile: () => profile.loadProfile(),
    fetchImpl: async () => {
      upstreamCalls++;
      throw new Error("no upstream call expected");
    }
  });
  _setActiveGatewayForTests(gw);
  try {
    // signed_out (never signed in) -> NO_CREDENTIAL, the spec's "ChatGPT
    // profile not signed in" outcome.
    await fastProfile();
    let err = null;
    try {
      await profile.testCapability(CHATGPT_TEST_PROFILE_ID, CHATGPT_TEST_MODEL);
      throw new Error("testCapability must fail for a profile that never signed in");
    } catch (e) {
      err = e;
    }
    assert(err && err.code === "NO_CREDENTIAL", `expected NO_CREDENTIAL, got ${err && err.code}: ${err && err.message}`);
    assert(/sign[- ]?in/i.test(err.message), `the message must ask the user to sign in, got: ${err.message}`);

    // session_expired (host-side refresh was rejected) -> SESSION_EXPIRED.
    await fastProfile();
    await profile.recordChatgptSignIn(CHATGPT_TEST_PROFILE_ID, { email: "expired@example.com", planType: "plus", backend: "memory" });
    await profile.recordChatgptSessionExpired(CHATGPT_TEST_PROFILE_ID);
    err = null;
    try {
      await profile.testCapability(CHATGPT_TEST_PROFILE_ID, CHATGPT_TEST_MODEL);
      throw new Error("testCapability must fail for an expired session");
    } catch (e) {
      err = e;
    }
    assert(err && err.code === "SESSION_EXPIRED", `expected SESSION_EXPIRED, got ${err && err.code}: ${err && err.message}`);

    // Signed in, but the requested model is not in the profile's list.
    await fastProfile();
    await profile.recordChatgptSignIn(CHATGPT_TEST_PROFILE_ID, { email: "ok@example.com", planType: "plus", backend: "memory" });
    err = null;
    try {
      await profile.testCapability(CHATGPT_TEST_PROFILE_ID, "not-in-the-model-list");
      throw new Error("testCapability must reject a model outside the profile's list");
    } catch (e) {
      err = e;
    }
    assert(err && err.code === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${err && err.code}: ${err && err.message}`);

    assert(gw._port() === null, "the gateway was never started for any not-eligible case");
    assert(gw._tokenCount() === 0, "no gateway token was issued for any not-eligible case");
    assert(upstreamCalls === 0, "no upstream request was made for any not-eligible case");
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
  }
});

await check("a signed-in chatgpt profile runs the three-part test through the gateway with a test-scoped token", async () => {
  const upstream = await startMockCodexUpstream();
  const issued = [];
  const gw = createChatgptGateway({
    upstreamUrl: upstream.url,
    getAccessToken: async (profileId) => {
      assert(profileId === CHATGPT_TEST_PROFILE_ID, `getAccessToken called for the wrong profile: ${profileId}`);
      return { accessToken: "fake-chatgpt-access-token", accountId: "acc-mock" };
    },
    loadProfile: () => profile.loadProfile()
  });
  const realIssueToken = gw.issueToken.bind(gw);
  gw.issueToken = (opts) => {
    const handle = realIssueToken(opts);
    issued.push({ ...opts, token: handle.token });
    return handle;
  };
  _setActiveGatewayForTests(gw);

  try {
    useScratchConfigDir();
    await profile.saveProfile({
      profileId: CHATGPT_TEST_PROFILE_ID,
      baseUrl: "https://api.anthropic.com",
      models: [{ id: CHATGPT_TEST_MODEL, label: CHATGPT_TEST_MODEL }],
      defaultModelId: CHATGPT_TEST_MODEL
    });
    await profile.setProviderType(CHATGPT_TEST_PROFILE_ID, "chatgpt");
    const signedIn = await profile.recordChatgptSignIn(CHATGPT_TEST_PROFILE_ID, {
      email: "capability@example.com",
      planType: "plus",
      backend: "memory"
    });
    assert(signedIn.chatgptSessionState === "signed_in" && signedIn.hasCredential === true, JSON.stringify(signedIn));

    const result = await profile.testCapability(CHATGPT_TEST_PROFILE_ID, CHATGPT_TEST_MODEL);
    assert(result.status === "pass", JSON.stringify(result));
    assert(result.capabilities.text === "pass" && result.capabilities.tool === "pass" && result.capabilities.vision === "pass",
      JSON.stringify(result.capabilities));
    assert(Object.keys(result.errors).length === 0, JSON.stringify(result.errors));

    // Exactly one token, test-scoped, bound to this profile and model.
    assert(issued.length === 1, `expected exactly one gateway token, got ${issued.length}`);
    assert(issued[0].purpose === "capability-test", `expected a capability-test token, got purpose=${issued[0].purpose}`);
    assert(issued[0].profileId === CHATGPT_TEST_PROFILE_ID && issued[0].model === CHATGPT_TEST_MODEL, JSON.stringify(issued[0]));

    // The token is revoked when the test ends, whatever the outcome.
    assert(gw._tokenCount() === 0, "the test-scoped gateway token must be released when the test ends");

    // Every upstream call presented the real ChatGPT credential (held by the
    // gateway, never by the SDK) and the honest client identity.
    assert(upstream.requests.length >= 3, `expected at least one upstream call per sub-test, got ${upstream.requests.length}`);
    for (const request of upstream.requests) {
      assert(request.headers.authorization === "Bearer fake-chatgpt-access-token", JSON.stringify(request.headers.authorization));
      assert(request.headers.originator === "browzy", JSON.stringify(request.headers.originator));
      assert(request.headers["chatgpt-account-id"] === "acc-mock", JSON.stringify(request.headers["chatgpt-account-id"]));
      assert(request.body.stream === true && request.body.store === false, JSON.stringify({ stream: request.body.stream, store: request.body.store }));
    }

    // Recorded under the fixed chatgpt:codex marker, so isRunnable() sees it.
    const stored = readProfileFromDisk();
    const key = capabilityTestKey({ baseUrl: "chatgpt:codex", modelId: CHATGPT_TEST_MODEL, credentialRevision: stored.credentialRevision });
    assert(stored.lastCapabilityTest && stored.lastCapabilityTest[key] && stored.lastCapabilityTest[key].status === "pass",
      `expected a pass recorded under ${key}`);
    assert(await profile.isRunnable(CHATGPT_TEST_PROFILE_ID, CHATGPT_TEST_MODEL), "a chatgpt profile must be runnable after a passing test");
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
    await upstream.close();
  }
});

await check("a chatgpt run snapshot points the SDK at the gateway, never at a ChatGPT token", async () => {
  const issued = [];
  const gw = createChatgptGateway({
    upstreamUrl: "http://127.0.0.1:1/never",
    getAccessToken: async () => ({ accessToken: "fake-chatgpt-access-token", accountId: "acc-mock" }),
    loadProfile: () => profile.loadProfile()
  });
  const realIssueToken = gw.issueToken.bind(gw);
  gw.issueToken = (opts) => {
    const handle = realIssueToken(opts);
    issued.push({ ...opts, token: handle.token });
    return handle;
  };
  _setActiveGatewayForTests(gw);
  try {
    useScratchConfigDir();
    await profile.saveProfile({
      profileId: CHATGPT_TEST_PROFILE_ID,
      baseUrl: "https://api.anthropic.com",
      models: [{ id: CHATGPT_TEST_MODEL, label: CHATGPT_TEST_MODEL }],
      defaultModelId: CHATGPT_TEST_MODEL
    });
    await profile.setProviderType(CHATGPT_TEST_PROFILE_ID, "chatgpt");
    await profile.recordChatgptSignIn(CHATGPT_TEST_PROFILE_ID, { email: "run@example.com", planType: "plus", backend: "memory" });

    const snapshot = await profile.snapshotForRun(CHATGPT_TEST_PROFILE_ID, CHATGPT_TEST_MODEL);
    assert(Object.keys(snapshot.env).sort().join(",") === "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL",
      `the SDK environment must carry ONLY the gateway URL and token, got ${JSON.stringify(snapshot.env)}`);
    assert(snapshot.env.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:"), snapshot.env.ANTHROPIC_BASE_URL);
    assert(issued.length === 1 && snapshot.env.ANTHROPIC_API_KEY === issued[0].token,
      "ANTHROPIC_API_KEY must be the issued gateway token, not a ChatGPT token");
    assert(issued[0].purpose === "run", JSON.stringify(issued[0]));
    assert(!/fake-chatgpt-access-token|acc-mock/.test(JSON.stringify(snapshot.env)), "no ChatGPT token/account value may appear in the SDK environment");
    snapshot.releaseGatewayToken();
    assert(gw._tokenCount() === 0, "releasing the run token revokes it");
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;

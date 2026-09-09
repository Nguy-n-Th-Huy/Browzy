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
import os from "node:os";
import path from "node:path";

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { runCapabilityTest } from "../agent/settings/capability-test.js";
import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";

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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;

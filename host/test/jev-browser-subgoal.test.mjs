#!/usr/bin/env node
//
// jev-browser-subgoal-tool: the `browser_subgoal` SDK tool's gating,
// checkpoint contract and failure honesty.
//
// Two layers, both against REAL production code:
//   - host/agent/settings/profile.js's `resolveJevBrowserSubgoalConfig` —
//     the gate (jev-tools-reuse-primary-provider design.md decision 2): the
//     saved Jev transport key ALONE, plus a supplied `textModel` (the run's
//     own primary provider — never a second, separately configured one);
//     the endpoint always `typesafeDefaultForSource`, never `profile.baseUrl`.
//     Driven against a real scratch profile store (OCIC_AGENT_CONFIG_DIR),
//     the same isolation host/test/settings-typesafe.test.mjs uses.
//   - host/agent/tools/browser-subgoal.js's `createBrowserSubgoalTool` — the
//     tool handler's validation, the unverified-checkpoint mapping (TYPE_TEXT
//     value never present), and honest failure reporting. Driven with a fake
//     `toolFactory` (so no real SDK/zod-schema call is needed to exercise the
//     handler) and a fake `runTypesafeRunImpl` standing in for the real Jev
//     runtime, whose own subgoal-mode behavior is covered by
//     host/test/jev-decision-runtime.test.mjs.
//
// Run: node --test host/test/jev-browser-subgoal.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as profile from "../agent/settings/profile.js";
import { memoryClearAll } from "../agent/secrets/memory-store.js";
import {
  createBrowserSubgoalTool,
  BROWSER_SUBGOAL_TOOL_NAME,
  mapSubgoalCheckpoint
} from "../agent/tools/browser-subgoal.js";

const TEST_PROFILE_ID = "ocic-test-browser-subgoal";
// The run's own primary provider/model — what `primaryTextModelFromSnapshot`
// would derive from a real anthropic/chatgpt snapshot. Built by hand here
// (this suite tests the resolvers, not the snapshot helper — that is
// host/test/jev-decision-runtime.test.mjs's/agent-settings-relay's concern)
// so every gate test can supply it exactly like companion.js now does.
const PRIMARY_TEXT_MODEL = { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "sk-ant-primary-test-only" };

function useScratchConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-subgoal-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  profile._clearCredentialRevokedListenersForTests();
  return dir;
}

/**
 * An `anthropic` profile (the default provider type a fresh profile loads
 * as) carrying a saved Jev transport key, built the SAME way the settings
 * surface would — `setTypesafeConfig`/`setTypesafeCredentials`. On this
 * profile type `setTypesafeConfig` now writes ONLY `typesafeSource`/
 * `jevToolsSendScreenshots` (jev-tools-reuse-primary-provider design.md
 * decision 4); legacy text-model fields are accepted here only so a test can
 * prove they are ignored, never because the resolver still reads them.
 */
async function anthropicProfileWithJev({
  typesafeSource = "typesafe",
  typesafeApiKey = "ts-test-only-key",
  // Legacy fields: stored (via setTypesafeCredentials, which has no
  // providerType gate) so a test can prove the gate no longer depends on
  // them, never because the resolver reads them.
  textModelApiKey = null,
  // jev-subgoal-screenshots-default-off: left undefined by default so most
  // tests exercise the documented default (toggle unset, resolver returns
  // false) — the same "omitted keeps the stored/resolved default" rule
  // setTypesafeConfig itself follows.
  jevToolsSendScreenshots
} = {}) {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-x", label: "Claude X" }],
    defaultModelId: "claude-x"
  });
  await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource,
    ...(jevToolsSendScreenshots === undefined ? {} : { jevToolsSendScreenshots })
  });
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, {
    ...(typesafeApiKey !== null ? { typesafeApiKey } : {}),
    ...(textModelApiKey !== null ? { textModelApiKey } : {}),
    memoryOnly: true
  });
  return TEST_PROFILE_ID;
}

// --- resolveJevBrowserSubgoalConfig (the gate) ------------------------------

test("a saved transport key resolves a Jev config whose textModel is exactly the supplied primary model, never from profile.baseUrl", async () => {
  await anthropicProfileWithJev();
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(config, "expected a resolved config");
  assert.equal(config.source, "typesafe");
  assert.equal(config.endpoint, "https://api.typesafe.ai");
  assert.notEqual(config.endpoint, "https://api.anthropic.com", "must never reuse profile.baseUrl (the Anthropic endpoint)");
  assert.equal(config.apiKey, "ts-test-only-key");
  assert.equal(typeof config.model, "string");
  assert(config.model, "a Jev transport model id must be present");
  assert.deepEqual(config.textModel, PRIMARY_TEXT_MODEL);
  assert.equal(config.decisionSource, "anthropic", "decisionSource reports the profile's own provider type");
});

test("the vercel source resolves the Vercel AI Gateway endpoint, not the direct default", async () => {
  await anthropicProfileWithJev({ typesafeSource: "vercel" });
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(config);
  assert.equal(config.source, "vercel");
  assert.equal(config.endpoint, "https://ai-gateway.vercel.sh");
});

test("a missing typesafe transport key resolves null even though a textModel is supplied", async () => {
  await anthropicProfileWithJev({ typesafeApiKey: null });
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert.equal(config, null);
});

test("a missing textModel resolves null even though the transport key is saved", async () => {
  await anthropicProfileWithJev();
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, {});
  assert.equal(config, null);
});

test("a profile with no saved transport key resolves null even with a textModel supplied and no prior Jev config at all", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert.equal(config, null, "no saved transport key means the gate is unmet");
});

test("an unrelated profileId resolves null", async () => {
  await anthropicProfileWithJev();
  const config = await profile.resolveJevBrowserSubgoalConfig("some-other-profile", { textModel: PRIMARY_TEXT_MODEL });
  assert.equal(config, null);
});

// --- jev-subgoal-screenshots-default-off: the Jev-tools screenshot toggle --

test("sendScreenshots defaults to false when the Jev-tools toggle is never set, even though every other gate field is present", async () => {
  await anthropicProfileWithJev();
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(config, "expected a resolved config");
  assert.equal(config.sendScreenshots, false, "a browser_subgoal sub-run must default to no screenshot capture");
});

test("sendScreenshots resolves true once the Jev-tools toggle is explicitly enabled", async () => {
  await anthropicProfileWithJev({ jevToolsSendScreenshots: true });
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(config);
  assert.equal(config.sendScreenshots, true);
});

test("sendScreenshots resolves false when the Jev-tools toggle is explicitly disabled", async () => {
  await anthropicProfileWithJev({ jevToolsSendScreenshots: false });
  const config = await profile.resolveJevBrowserSubgoalConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(config);
  assert.equal(config.sendScreenshots, false);
});

test("loadProfile() surfaces the Jev-tools toggle for the settings page, and the removed primary/typesafe toggle no longer exists", async () => {
  await anthropicProfileWithJev({ jevToolsSendScreenshots: true });
  const loaded = await profile.loadProfile();
  assert.equal(loaded.profileId, TEST_PROFILE_ID);
  assert.equal(loaded.jevToolsSendScreenshots, true, "loadProfile() surfaces the Jev-tools toggle for the settings page");
  assert.equal("sendScreenshots" in loaded, false, "the removed standalone provider's own screenshot toggle no longer exists");
});

test("setTypesafeConfig on an anthropic/chatgpt profile persists only typesafeSource and jevToolsSendScreenshots, and never touches baseUrl/models/defaultModelId/lastCapabilityTest", async () => {
  await anthropicProfileWithJev();
  const before = await profile.loadProfile();
  const updated = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    // Legacy fields sent alongside the two real ones, to prove they are
    // silently ignored on this profile type rather than validated/persisted.
    textModelBaseUrl: "https://ignored.example/v1",
    textModelId: "ignored-model",
    decisionSource: "openai",
    jevToolsSendScreenshots: true
  });
  assert.equal(updated.jevToolsSendScreenshots, true);
  assert.equal(updated.baseUrl, before.baseUrl, "the primary endpoint must be untouched");
  assert.deepEqual(updated.models, before.models, "the primary model list must be untouched");
  assert.equal(updated.defaultModelId, before.defaultModelId, "the primary default model must be untouched");
  assert.deepEqual(updated.lastCapabilityTest, before.lastCapabilityTest, "a recorded primary capability test must survive a Jev-transport-only save");
  assert.equal(updated.textModelBaseUrl, before.textModelBaseUrl, "the legacy text-model base URL is left exactly as stored");
  assert.equal(updated.textModelId, before.textModelId, "the legacy text-model id is left exactly as stored");

  // An omitted field on a later call keeps the stored value — the same rule
  // sendScreenshots itself follows.
  const keptOnOmit = await profile.setTypesafeConfig(TEST_PROFILE_ID, {});
  assert.equal(keptOnOmit.jevToolsSendScreenshots, true, "an omitted jevToolsSendScreenshots keeps the previously stored value");
});

test("setTypesafeConfig rejects a non-boolean jevToolsSendScreenshots on an anthropic profile", async () => {
  await anthropicProfileWithJev();
  await assert.rejects(
    () => profile.setTypesafeConfig(TEST_PROFILE_ID, { jevToolsSendScreenshots: "yes" }),
    (err) => err.code === "INVALID_PROFILE"
  );
});

test("resolveJevExtractPageConfig never carries sendScreenshots either way — extract_page is unaffected by the Jev-tools toggle", async () => {
  await anthropicProfileWithJev({ jevToolsSendScreenshots: true });
  const extractConfig = await profile.resolveJevExtractPageConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(extractConfig, "expected extract_page's config to resolve");
  assert.equal("sendScreenshots" in extractConfig, false, "extract_page's config never carries a screenshot field of any kind");
});

// --- createBrowserSubgoalTool (the tool handler) ----------------------------

function fakeToolFactory(name, description, shape, handler) {
  return { name, description, shape, handler };
}

function buildTool({ jevConfig, tabId = 7, runTypesafeRunImpl, canUseTool = async () => ({ behavior: "allow" }) } = {}) {
  return createBrowserSubgoalTool({
    run: { id: "run-1" },
    toolBridge: { call: async () => ({ result: { content: [] } }) },
    coerceArgs: (a) => a,
    canUseTool,
    jevConfig: jevConfig ?? {
      source: "typesafe",
      endpoint: "https://api.typesafe.ai",
      apiKey: "ts-secret-should-never-leak",
      model: "jev-latest",
      textModel: { kind: "anthropic", baseUrl: PRIMARY_TEXT_MODEL.baseUrl, model: PRIMARY_TEXT_MODEL.model, apiKey: "primary-secret-should-never-leak" },
      sendScreenshots: true
    },
    resolveTabId: () => tabId,
    toolFactory: fakeToolFactory,
    runTypesafeRunImpl
  });
}

test("browser_subgoal registers under its documented name", async () => {
  const tool = await buildTool({ runTypesafeRunImpl: async () => ({ outcome: "done", reason: null, checkpoint: { url: null, title: null, actions: [] } }) });
  assert.equal(tool.name, BROWSER_SUBGOAL_TOOL_NAME);
  assert.equal(BROWSER_SUBGOAL_TOOL_NAME, "browser_subgoal");
});

test("an empty, missing, or non-string goal is rejected before any sub-run starts", async () => {
  let started = 0;
  const tool = await buildTool({ runTypesafeRunImpl: async () => { started++; return { outcome: "done", reason: null }; } });
  for (const goal of [undefined, "", "   ", 42, null]) {
    const result = await tool.handler({ goal });
    assert.equal(result.isError, true);
    assert(/non-empty/.test(result.content[0].text));
  }
  assert.equal(started, 0, "no sub-run may start for an invalid goal");
});

test("no bound tab is rejected before any sub-run starts", async () => {
  let started = 0;
  const tool = await buildTool({ tabId: null, runTypesafeRunImpl: async () => { started++; return { outcome: "done" }; } });
  const result = await tool.handler({ goal: "click the sign in button" });
  assert.equal(result.isError, true);
  assert(/bound page tab/.test(result.content[0].text));
  assert.equal(started, 0);
});

test("a completed subgoal returns an unverified checkpoint, never a success claim", async () => {
  const tool = await buildTool({
    runTypesafeRunImpl: async () => ({
      outcome: "done",
      reason: null,
      steps: 2,
      checkpoint: {
        url: "https://example.com/account",
        title: "Account",
        actions: [
          { operation: "CLICK", targetLabel: "Sign in", targetRole: "button", outcome: "succeeded" },
          { operation: "TYPE_TEXT", targetLabel: "Email", targetRole: "textbox", outcome: "succeeded" }
        ]
      }
    })
  });
  const result = await tool.handler({ goal: "sign in" });
  assert.equal(result.isError, false);
  const checkpoint = JSON.parse(result.content[0].text);
  assert.equal(checkpoint.status, "checkpoint");
  assert.equal(checkpoint.unverified, true);
  assert.equal(checkpoint.url, "https://example.com/account");
  assert.equal(checkpoint.title, "Account");
  assert.equal(checkpoint.actions.length, 2);
  // TYPE_TEXT's typed value is never present under any key.
  const typeTextAction = checkpoint.actions.find((a) => a.operation === "TYPE_TEXT");
  assert.deepEqual(Object.keys(typeTextAction).sort(), ["operation", "outcome", "targetLabel", "targetRole"]);
  assert(!JSON.stringify(checkpoint).toLowerCase().includes("password"));
});

test("a blocked subgoal (needs_operator) surfaces needsOperator without claiming an error", async () => {
  const tool = await buildTool({
    runTypesafeRunImpl: async () => ({ outcome: "blocked", reason: "needs_operator", needsOperator: true, checkpoint: { url: "https://example.com", title: "Example", actions: [] } })
  });
  const result = await tool.handler({ goal: "log in with the saved account" });
  assert.equal(result.isError, false, "a blocked-but-honest checkpoint is not a tool error");
  const checkpoint = JSON.parse(result.content[0].text);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.reason, "needs_operator");
  assert.equal(checkpoint.needsOperator, true);
  assert.equal(checkpoint.unverified, true);
});

test("a denied approval ends the subgoal blocked, never dispatching and never claiming success", async () => {
  const tool = await buildTool({
    runTypesafeRunImpl: async () => ({ outcome: "blocked", reason: "action_denied", checkpoint: { url: "https://example.com", title: "Example", actions: [] } })
  });
  const result = await tool.handler({ goal: "submit the payment form" });
  const checkpoint = JSON.parse(result.content[0].text);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.reason, "action_denied");
  assert.equal(result.isError, false);
});

test("a provider/transport failure returns a bounded named failure and never leaks the configured keys", async () => {
  const tool = await buildTool({
    runTypesafeRunImpl: async () => ({ outcome: "error", reason: "provider_error", error: { code: "NETWORK_ERROR", message: "the Jev endpoint rejected the request" } })
  });
  const result = await tool.handler({ goal: "click continue" });
  assert.equal(result.isError, true);
  const checkpoint = JSON.parse(result.content[0].text);
  assert.equal(checkpoint.status, "error");
  assert.equal(checkpoint.reason, "provider_error");
  assert(!result.content[0].text.includes("ts-secret-should-never-leak"));
  assert(!result.content[0].text.includes("primary-secret-should-never-leak"));
});

test("a runtime exception is caught and mapped to a bounded named failure — the tool call never throws", async () => {
  const tool = await buildTool({
    runTypesafeRunImpl: async () => { throw new Error("boom"); }
  });
  const result = await tool.handler({ goal: "click continue" });
  assert.equal(result.isError, true);
  const checkpoint = JSON.parse(result.content[0].text);
  assert.equal(checkpoint.status, "error");
  assert.equal(checkpoint.reason, "jev_runtime_failed");
});

test("the sub-run is invoked with the goal as provider.goal, an empty conversation, subgoal-mode limits, and the resolved tab", async () => {
  let captured = null;
  const tool = await buildTool({
    tabId: 42,
    runTypesafeRunImpl: async (opts) => { captured = opts; return { outcome: "done", reason: null, checkpoint: { url: null, title: null, actions: [] } }; }
  });
  await tool.handler({ goal: "  click the continue button  " });
  assert(captured, "runTypesafeRun must be called");
  assert.equal(captured.provider.goal, "click the continue button", "the goal is trimmed and never the outer conversation");
  assert.deepEqual(captured.provider.conversation, []);
  assert.equal(captured.provider.tabId, 42);
  assert.deepEqual(captured.limits, { mode: "subgoal" });
  assert.equal(captured.provider.source, "typesafe");
  assert.equal(captured.provider.endpoint, "https://api.typesafe.ai");
});

test("the tool mints a subgoalId, passes it as provider.subgoalId, and the returned checkpoint references the same id", async () => {
  let captured = null;
  const tool = await buildTool({
    runTypesafeRunImpl: async (opts) => {
      captured = opts;
      // The real runtime tags jev_step/jev_end with this same
      // provider.subgoalId and echoes it back on the checkpoint
      // (host/agent/jev/runtime.js) — asserted directly against the real
      // runtime in host/test/jev-decision-runtime.test.mjs. This fake
      // mirrors that echo so the tool-level wiring is exercised too.
      return { outcome: "done", reason: null, checkpoint: { subgoalId: opts.provider.subgoalId, url: null, title: null, actions: [] } };
    }
  });
  const result = await tool.handler({ goal: "click continue" });
  const checkpoint = JSON.parse(result.content[0].text);
  assert(captured, "runTypesafeRun must be called");
  assert.equal(typeof captured.provider.subgoalId, "string");
  assert(captured.provider.subgoalId, "a non-empty subgoalId must be minted per call");
  assert.equal(checkpoint.subgoalId, captured.provider.subgoalId, "the returned checkpoint references the same id passed to the sub-run");
});

test("a start/transport failure still returns the minted subgoalId even though no checkpoint came back", async () => {
  const tool = await buildTool({
    runTypesafeRunImpl: async () => { throw new Error("boom"); }
  });
  const result = await tool.handler({ goal: "click continue" });
  const checkpoint = JSON.parse(result.content[0].text);
  assert.equal(typeof checkpoint.subgoalId, "string");
  assert(checkpoint.subgoalId, "the id minted before the failed call is still surfaced for correlation");
});

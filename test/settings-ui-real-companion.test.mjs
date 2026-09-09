// Task 4.5: end-to-end proof that settings-client.js's wire contract +
// settings-controller.js's state machine hold against REAL production host
// code (host/agent/settings/profile.js — already independently tested in
// host/test/settings-*.test.mjs; reports/04-settings-evidence.md), not just
// against the deterministic scripted double. This is the "faithful fake
// companion harness speaking the real message shapes" this task's brief
// asks for, given no live installed extension/native-messaging pipe is
// available in this environment.
//
// Uses the same fixture Anthropic-compatible server host's own capability-
// test/discovery suites use (host/agent/settings/testing/
// fixture-anthropic-server.mjs) — a real HTTP server, real SDK transport,
// zero live billed calls.
//
// NOTE ON RUNTIME: the AUTH_ERROR (401) scenario below drives the REAL
// @anthropic-ai/claude-agent-sdk query() against the fixture and waits for
// its own retry/backoff behavior to surface the first classifiable signal
// (reports/04-settings-evidence.md: "classified on the first retry, not
// after exhaustion") -- this is slower than the scripted-companion tests
// (single-digit seconds, not instant). This file is intentionally kept to a
// SMALL number of representative end-to-end cases for exactly that reason;
// the full error-taxonomy x state-machine matrix is covered fast and
// deterministically in test/settings-ui-controller.test.mjs.
//
// Run: node test/settings-ui-real-companion.test.mjs
import { createSettingsClient } from "../extension/settings/settings-client.js";
import { SettingsController } from "../extension/settings/settings-controller.js";
import { createRealCompanionHarness } from "./settings-ui-real-companion-harness.mjs";
import { startFixtureAnthropicServer } from "../host/agent/settings/testing/fixture-anthropic-server.mjs";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

console.log("== real host module: save() validation is enforced by REAL host/agent/settings/url.js + models.js, not just the client mirror ==");
{
  const harness = await createRealCompanionHarness();
  try {
    const client = createSettingsClient({ sendMessage: harness.sendMessage });
    const c = new SettingsController(client, { profileId: harness.profileId });
    await c.init();
    ok(c.getState().isFirstRun === true, "a genuinely fresh scratch profile is first-run");

    // Bypass the client-side mirror validation to prove the REAL host module
    // independently rejects bad input too (defense in depth, not just a
    // client-side illusion of safety).
    let threw = false;
    try {
      await client.saveProfile(harness.profileId, { baseUrl: "ftp://nope.example.com", models: [], defaultModelId: null });
    } catch (err) {
      threw = true;
      ok(err.code === "INVALID_BASE_URL", `real host rejects an unsupported scheme with INVALID_BASE_URL — got ${err.code}`);
    }
    ok(threw, "the real host module actually threw (not silently accepted)");

    threw = false;
    try {
      await client.saveProfile(harness.profileId, {
        baseUrl: "https://api.anthropic.com",
        models: [{ id: "a", label: "A" }, { id: "a", label: "A dup" }],
        defaultModelId: "a"
      });
    } catch (err) {
      threw = true;
      ok(err.code === "INVALID_MODELS", `real host rejects a duplicate model id with INVALID_MODELS — got ${err.code}`);
    }
    ok(threw, "the real host module actually threw for duplicate IDs");

    const saved = await c.save();
    ok(saved.ok === true, "an empty model list with no default is itself valid (never a guessed model) and saves cleanly through the real host module");
  } finally {
    harness.teardown();
  }
}

console.log("== real host module: credential set/remove round trip (memory-only), export contains no secret ==");
{
  const harness = await createRealCompanionHarness();
  const SECRET = `sk-ant-real-harness-secret-${Date.now()}`;
  try {
    const client = createSettingsClient({ sendMessage: harness.sendMessage });
    const c = new SettingsController(client, { profileId: harness.profileId });
    await c.init();
    c.addModel({ id: "claude-sonnet-5", label: "Sonnet" });
    const saveResult = await c.save(SECRET);
    ok(saveResult.ok === true, "save with a real credential succeeds against the real host module");
    ok(c.getState().hasCredential === true && c.getState().memoryOnlyCredential === true, "real profile.js reports the credential as saved (memory-only, per harness policy)");

    const exported = await c.exportProfile();
    ok(!JSON.stringify(exported).includes(SECRET), "real exportProfileRedacted() output contains no trace of the real secret");

    const removeResult = await c.removeCredential();
    ok(removeResult.ok === true && c.getState().hasCredential === false, "real removeCredential() round trip completes and is reflected");
  } finally {
    harness.teardown();
  }
}

console.log("== real host module + real fixture server: unsupported discovery (404) leaves the manual list untouched ==");
{
  const fixture = await startFixtureAnthropicServer({ scenario: "models-404" });
  const harness = await createRealCompanionHarness();
  try {
    const client = createSettingsClient({ sendMessage: harness.sendMessage });
    const c = new SettingsController(client, { profileId: harness.profileId });
    await c.init();
    c.addModel({ id: "manual-model", label: "Manual" });
    await c.save("sk-ant-discovery-404-test");
    const before = JSON.stringify(c.getState().models);
    // save() normalized/persisted baseUrl only via the model list step above;
    // point the real profile at the fixture for the discovery call itself.
    await client.saveProfile(harness.profileId, { baseUrl: fixture.url, models: c.getState().models, defaultModelId: c.getState().defaultModelId });
    await c.init(harness.profileId); // reload so controller sees the fixture baseUrl
    const result = await c.discoverModels();
    ok(result.ok === true && result.supported === false, "real 404 from the fixture is reported as unsupported, not an error");
    ok(JSON.stringify(c.getState().models) === before, "manual model list is completely untouched");
  } finally {
    harness.teardown();
    await fixture.close();
  }
}

console.log("== real host module + real fixture server: supported discovery merges a real paginated, mixed-vendor-shaped catalog ==");
{
  const fixture = await startFixtureAnthropicServer({ scenario: "success" }); // fixture's GET /v1/models is scenario-independent (fixture-model-a/b, paginated)
  const harness = await createRealCompanionHarness();
  try {
    const client = createSettingsClient({ sendMessage: harness.sendMessage });
    const c = new SettingsController(client, { profileId: harness.profileId });
    await c.init();
    c.addModel({ id: "manual-keep-me", label: "Manual" });
    await c.save("sk-ant-discovery-ok-test");
    await client.saveProfile(harness.profileId, { baseUrl: fixture.url, models: c.getState().models, defaultModelId: c.getState().defaultModelId });
    await c.init(harness.profileId);
    const result = await c.discoverModels();
    ok(result.ok === true && result.supported === true, "real paginated discovery succeeds end to end");
    const ids = c.getState().models.map((m) => m.id).sort();
    ok(JSON.stringify(ids) === JSON.stringify(["fixture-model-a", "fixture-model-b", "manual-keep-me"].sort()),
      `both real fixture pages merged in, manual entry preserved — got ${JSON.stringify(ids)}`);
  } finally {
    harness.teardown();
    await fixture.close();
  }
}

console.log("== real host module + real fixture server + real SDK: a full text/tool/vision PASS renders correctly ==");
{
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  const harness = await createRealCompanionHarness();
  try {
    const client = createSettingsClient({ sendMessage: harness.sendMessage });
    const c = new SettingsController(client, { profileId: harness.profileId });
    await c.init();
    c.addModel({ id: "fixture-model", label: "Fixture" });
    await c.save("sk-ant-capability-pass-test");
    await client.saveProfile(harness.profileId, { baseUrl: fixture.url, models: c.getState().models, defaultModelId: c.getState().defaultModelId });
    await c.init(harness.profileId);
    const result = await c.testConnection();
    ok(result.ok === true, "a real end-to-end capability test against the fixture passes");
    ok(c.getState().connectionStatus.capabilities.text === "pass" && c.getState().connectionStatus.capabilities.tool === "pass" && c.getState().connectionStatus.capabilities.vision === "pass",
      "all three capabilities reported pass, from the real SDK message stream");
  } finally {
    harness.teardown();
    await fixture.close();
  }
}

console.log("== real host module + real fixture server + real SDK: bad credentials render AUTH_ERROR end to end (slow: real SDK retry path) ==");
{
  const fixture = await startFixtureAnthropicServer({ scenario: "401" });
  const harness = await createRealCompanionHarness();
  try {
    const client = createSettingsClient({ sendMessage: harness.sendMessage });
    const c = new SettingsController(client, { profileId: harness.profileId });
    await c.init();
    c.addModel({ id: "fixture-model", label: "Fixture" });
    await c.save("sk-ant-deliberately-rejected-test");
    await client.saveProfile(harness.profileId, { baseUrl: fixture.url, models: c.getState().models, defaultModelId: c.getState().defaultModelId });
    await c.init(harness.profileId);
    const result = await c.testConnection();
    ok(result.ok === false, "a real 401 from the fixture never passes");
    ok(c.getState().banner.code === "AUTH_ERROR", `real end-to-end 401 renders as AUTH_ERROR in the settings UI — got ${c.getState().banner && c.getState().banner.code}`);
    ok(!/sk-ant-deliberately-rejected-test/.test(JSON.stringify(c.getState())), "the real rejected key itself never appears anywhere in state");
  } finally {
    harness.teardown();
    await fixture.close();
  }
}

console.log(fail === 0 ? "\nALL SETTINGS-UI REAL-COMPANION INTEGRATION TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

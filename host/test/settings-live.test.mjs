#!/usr/bin/env node
//
// LIVE-endpoint coverage for host/agent/settings/**, guarded behind an
// explicit opt-in env var so the offline suite (settings-all.test.mjs and
// everything it runs) never depends on a live credential existing anywhere
// on the machine. This file makes NO network call and requires NO credential
// unless OCIC_RUN_LIVE_PROVIDER_TESTS=1 is set.
//
// This does NOT create or store a credential itself — it consumes whatever
// profile+credential is ALREADY configured through the real production path
// (host/agent/settings/profile.js's saveProfile()+setCredential(), which
// persists the non-secret profile via the atomic store and the secret via
// the OS credential store). Seed one first, e.g.:
//
//   node -e "
//     import('./agent/settings/profile.js').then(async (p) => {
//       await p.saveProfile({ baseUrl: '<endpoint>', models: [{id:'<model>',label:'<model>'}], defaultModelId: '<model>' });
//       await p.setCredential('default', '<key-read-from-somewhere-that-is-not-this-command-line>');
//     });
//   "
//
// Then: OCIC_RUN_LIVE_PROVIDER_TESTS=1 node host/test/settings-live.test.mjs
//
// See reports/09-live-gate-evidence.md for the captured results of the run
// this file's checks are modeled on (paginated discovery against a real
// mixed-vendor catalog, a real two-model capability matrix, and real
// auth/model error-taxonomy verification against a live gateway).

import { loadProfile, refreshDiscoveredModels, testCapability } from "../agent/settings/profile.js";
import { runCapabilityTest } from "../agent/settings/capability-test.js";
import { readSecret } from "../agent/secrets/secret-store.js";
import * as sdk from "@anthropic-ai/claude-agent-sdk";

const LIVE = process.env.OCIC_RUN_LIVE_PROVIDER_TESTS === "1";

if (!LIVE) {
  console.log("settings-live.test.mjs: skipped (set OCIC_RUN_LIVE_PROVIDER_TESTS=1 with a profile+credential already configured to run this)");
  process.exit(0);
}

const results = [];
async function check(name, fn) {
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

console.log("\nLIVE provider coverage (real endpoint, real credential from the OS store)\n");

const profile = await loadProfile();
if (!profile || !profile.hasCredential || !profile.defaultModelId) {
  console.log("No usable profile+credential is configured (host/agent/settings/profile.js saveProfile()+setCredential() must run first). Skipping.");
  process.exit(0);
}

const target = `browzy-in-chrome/settings/${profile.profileId}`;
const apiKey = await readSecret(target, { memoryOnly: profile.memoryOnlyCredential, backend: profile.secretBackend });
assert(apiKey, "no credential resolved from the OS store even though hasCredential is true");

await check("model discovery paginates and preserves every manual model entry", async () => {
  const result = await refreshDiscoveredModels(profile.profileId);
  assert(result.supported === true, `expected discovery to be supported, got: ${JSON.stringify(result)}`);
  for (const manual of profile.models) {
    assert(result.models.some((m) => m.id === manual.id), `manual model "${manual.id}" did not survive the discovery merge`);
  }
  console.log(`    (${result.models.length} models after merge)`);
});

// Bounded on purpose: capability-test the profile's default model plus, at
// most, a small explicit cap of its OTHER configured models — never every
// entry in `profile.models` unconditionally. A profile's model list can grow
// arbitrarily large after a discovery refresh merges in a real mixed-vendor
// catalog (see reports/09-live-gate-evidence.md — one such catalog had 31
// entries), and this is a real, billed request per model; iterating the
// whole list here would make the cost of running this file scale with
// however many models someone's profile happens to have.
const MAX_MODELS_TO_CAPABILITY_TEST = 3;
const modelsToTest = [
  ...profile.models.filter((m) => m.id === profile.defaultModelId),
  ...profile.models.filter((m) => m.id !== profile.defaultModelId)
].slice(0, MAX_MODELS_TO_CAPABILITY_TEST);

for (const model of modelsToTest) {
  await check(`capability test for "${model.id}" reports text/tool/vision each on its own key`, async () => {
    const result = await testCapability(profile.profileId, model.id);
    assert(["pass", "fail"].includes(result.status), `unexpected status: ${result.status}`);
    for (const cap of ["text", "tool", "vision"]) {
      assert(["pass", "fail", "not_run"].includes(result.capabilities[cap]), `capabilities.${cap} has an unexpected value: ${result.capabilities[cap]}`);
    }
    console.log(`    ${model.id} -> ${JSON.stringify(result.capabilities)}`);
  });
}

await check("a deliberately bad API key is classified AUTH_ERROR against the real endpoint", async () => {
  const result = await runCapabilityTest({
    baseUrl: profile.baseUrl,
    apiKey: "sk-ant-deliberately-invalid-for-error-taxonomy-verification",
    modelId: profile.defaultModelId,
    sdk,
    z: {}
  });
  assert(result.status === "fail", "a bad key must not report status: pass");
  assert(result.errors.text?.code === "AUTH_ERROR", `expected AUTH_ERROR, got: ${JSON.stringify(result.errors.text)}`);
});

await check("a nonexistent model id is classified as a model/route failure, never reported compatible", async () => {
  const result = await runCapabilityTest({
    baseUrl: profile.baseUrl,
    apiKey,
    modelId: "claude-this-model-does-not-exist-live-gate-probe",
    sdk,
    z: {}
  });
  assert(result.status === "fail", "a nonexistent model must not report status: pass");
  // Empirically, this specific class of gateway (see reports/09-live-gate-evidence.md)
  // reports "model not found" as a RETRIED 5xx ("server_error") rather than the
  // documented unretried 404 — the bundled CLI's own api_retry message only
  // ever forwards { error_status, error }, discarding the upstream response
  // body where the specific "model_not_found" reason actually lives, so this
  // module cannot always distinguish it from a generic server/network fault
  // without bypassing the SDK transport entirely (a design this module
  // deliberately avoids). Accept either the ideal classification or the
  // documented, evidenced fallback — but never a silent "pass".
  const code = result.errors.text?.code;
  assert(
    code === "MODEL_UNAVAILABLE_ERROR" || code === "NETWORK_ERROR",
    `expected MODEL_UNAVAILABLE_ERROR (ideal) or NETWORK_ERROR (documented gateway-dependent fallback — see capability-test.js's classifySdkError comment), got: ${JSON.stringify(result.errors.text)}`
  );
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

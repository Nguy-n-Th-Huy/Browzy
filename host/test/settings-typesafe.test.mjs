#!/usr/bin/env node
//
// TypeSafe/Jev provider settings, host half (tasks 5.1, 5.2, 5.3, 5.6; and
// openspec/changes/add-jev-run-screenshots task 3.1): the provider-type set,
// the pinned `typesafe` run-snapshot shape and its key containment, the
// three-stage capability test (including `INVALID_RESPONSE` classification and
// the separately reported image stage), switching/seeding/endpoint-defaulting,
// runnability, the screenshot toggle, and the merged credential record's
// write / merge / remove / revocation behavior — all against the REAL code
// paths and a local stub HTTP server
// (host/agent/settings/testing/fixture-typesafe-server.mjs), never a live
// provider.
//
// Isolation: every check gets its own scratch config directory via
// OCIC_AGENT_CONFIG_DIR, a dedicated test-only profileId (never the
// production "default"), and memoryOnly:true credentials — the OS credential
// store is never touched (see host/agent/secrets/secret-store.js's guard and
// host/test/settings-profile.test.mjs's note on why the profileId matters).
// The one check that exercises the OS-store path replaces every backend's
// write with a spy first, so it too writes nothing to a real store.
//
// Run: node host/test/settings-typesafe.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as profile from "../agent/settings/profile.js";
import { writeProfileToDisk, readProfileFromDisk } from "../agent/settings/profile-store.js";
import { capabilityTestKey, isKnownProviderType, PROVIDER_TYPES } from "../agent/settings/profile-schema.js";
import { memoryClearAll, memoryRead } from "../agent/secrets/memory-store.js";
import { OS_BACKENDS } from "../agent/secrets/secret-store.js";
import { startFixtureTypesafeServer } from "../agent/settings/testing/fixture-typesafe-server.mjs";
import { createChatgptGateway, _setActiveGatewayForTests } from "../agent/chatgpt/gateway.js";

const TEST_PROFILE_ID = "ocic-test-typesafe";
const TYPESAFE_KEY = "ts-test-only-not-a-real-key-0001";
const TYPESAFE_KEY_2 = "ts-test-only-rotation-key-0002";
const TEXT_MODEL_KEY = "tm-test-only-not-a-real-key-0001";
const TEXT_MODEL_ID = "fixture-text-model";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function useScratchConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-typesafe-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  profile._clearCredentialRevokedListenersForTests();
  return dir;
}

/** A profile on disk with an empty model list, exactly as a fresh install saves it. */
async function freshProfile(profileId = TEST_PROFILE_ID) {
  await profile.saveProfile({ profileId, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
}

/** Count non-overlapping occurrences — used for the "appears exactly once" key assertions. */
function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}
function assertNoKeyValues(serialized, where) {
  for (const key of [TYPESAFE_KEY, TYPESAFE_KEY_2, TEXT_MODEL_KEY]) {
    assert(!serialized.includes(key), `${where} leaks a raw provider key`);
  }
}
/** The same anchored, fail-closed key-NAME scan profile-protocol.js applies to settings replies. */
function assertNoCredentialFieldNames(value, where) {
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      assert(
        !/^(secret|apiKey|api_key|credential|accessToken|access_token|refreshToken|refresh_token|idToken|id_token)$/i.test(key),
        `${where} carries a credential-shaped field name "${key}"`
      );
      visit(child);
    }
  };
  visit(value);
}
async function storedTypesafeSecret(profileId = TEST_PROFILE_ID) {
  const raw = await memoryRead(`browzy-in-chrome/typesafe/${profileId}`, { memoryOnly: true });
  return raw ? JSON.parse(raw) : null;
}

console.log("\nTypeSafe/Jev provider settings (host)\n");

await check("PROVIDER_TYPES accepts typesafe while a legacy/unknown stored value is left alone", async () => {
  useScratchConfigDir();
  assert(PROVIDER_TYPES.includes("typesafe"), "PROVIDER_TYPES must include typesafe");
  assert(isKnownProviderType("typesafe") === true, "typesafe must be a known provider type");
  assert(isKnownProviderType("openai") === false, "an unknown type must stay unknown");

  // A profile saved before provider types existed still loads as anthropic.
  writeProfileToDisk({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null, revision: 0 });
  const legacy = readProfileFromDisk();
  delete legacy.providerType;
  writeProfileToDisk(legacy);
  const loadedLegacy = await profile.loadProfile();
  assert(loadedLegacy.providerType === "anthropic", `expected anthropic, got ${loadedLegacy.providerType}`);

  // An unrecognized stored value loads verbatim and is refused at run time.
  const unknown = readProfileFromDisk();
  unknown.providerType = "openai";
  writeProfileToDisk(unknown);
  const loadedUnknown = await profile.loadProfile();
  assert(loadedUnknown.providerType === "openai", "an unrecognized stored value must load as-is");
  let code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "any-model");
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${code}`);
});

await check("setProviderType seeds jev-latest exactly once and never overwrites an edited list", async () => {
  useScratchConfigDir();
  await freshProfile();
  const switched = await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  assert(switched.models.length === 1, `expected one seeded model, got ${JSON.stringify(switched.models)}`);
  assert(switched.models[0].id === "jev-latest" && switched.models[0].label === "Jev (ultrafast)", JSON.stringify(switched.models));
  assert(switched.defaultModelId === "jev-latest", `expected defaultModelId jev-latest, got ${switched.defaultModelId}`);

  // Round-tripping the provider type must not duplicate the seed.
  await profile.setProviderType(TEST_PROFILE_ID, "anthropic");
  const again = await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  assert(again.models.length === 1, `re-selecting typesafe must not re-seed, got ${JSON.stringify(again.models)}`);

  // An edited list survives a switch away and back unchanged.
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: again.baseUrl,
    models: [{ id: "jev-custom", label: "Custom" }],
    defaultModelId: "jev-custom"
  });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  const back = await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  assert(back.models.length === 1 && back.models[0].id === "jev-custom", `edited list must be preserved, got ${JSON.stringify(back.models)}`);
  assert(back.defaultModelId === "jev-custom", "an edited default must be preserved");

  let code = null;
  try {
    await profile.setProviderType(TEST_PROFILE_ID, "openai");
  } catch {
    code = "rejected";
  }
  assert(code === "rejected", "an unknown provider type must be rejected");
});

await check("the endpoint follows the provider default only while it is still the other provider's default", async () => {
  useScratchConfigDir();
  await freshProfile();
  const toTypesafe = await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  assert(toTypesafe.baseUrl === "https://api.typesafe.ai", `expected the TypeSafe default, got ${toTypesafe.baseUrl}`);
  const backToAnthropic = await profile.setProviderType(TEST_PROFILE_ID, "anthropic");
  assert(backToAnthropic.baseUrl === "https://api.anthropic.com", `expected the Anthropic default, got ${backToAnthropic.baseUrl}`);

  // A user-chosen endpoint is untouched in both directions.
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://gateway.example.com",
    models: [{ id: "m", label: "m" }],
    defaultModelId: "m"
  });
  const custom = await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  assert(custom.baseUrl === "https://gateway.example.com", `a user endpoint must survive the switch, got ${custom.baseUrl}`);
  const customBack = await profile.setProviderType(TEST_PROFILE_ID, "anthropic");
  assert(customBack.baseUrl === "https://gateway.example.com", `a user endpoint must survive the switch back, got ${customBack.baseUrl}`);
});

await check("setTypesafeConfig validates, persists, and invalidates on change", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");

  // Loopback HTTP is allowed (the existing URL rules), and the model ID must be nonempty.
  const configured = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    textModelBaseUrl: "http://127.0.0.1:9/",
    textModelId: "  deepseek-chat  "
  });
  assert(configured.textModelBaseUrl === "http://127.0.0.1:9", `expected the normalized loopback URL, got ${configured.textModelBaseUrl}`);
  assert(configured.textModelId === "deepseek-chat", `expected a trimmed model id, got ${configured.textModelId}`);

  // An OpenAI-compatible base URL keeps its terminal /v1 (design.md §5 posts
  // to {baseUrl}/chat/completions); a plain URL keeps its trailing slash off.
  const withV1 = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-x" });
  assert(withV1.textModelBaseUrl === "https://api.openai.com/v1", `a terminal /v1 must be preserved, got ${withV1.textModelBaseUrl}`);
  const plain = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com/", textModelId: "gpt-x" });
  assert(plain.textModelBaseUrl === "https://text.example.com", `trailing slash must be stripped, got ${plain.textModelBaseUrl}`);

  // Field-level rejections: the model ID must be nonempty, the URL must satisfy the URL rules.
  let emptyId = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: "   " });
  } catch (err) {
    emptyId = err.code;
  }
  assert(emptyId === "INVALID_PROFILE", `expected INVALID_PROFILE for an empty text-model id, got ${emptyId}`);
  let badUrl = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "ftp://text.example.com", textModelId: "gpt-x" });
  } catch (err) {
    badUrl = err.code;
  }
  assert(badUrl === "INVALID_BASE_URL", `expected INVALID_BASE_URL, got ${badUrl}`);

  // A configuration change clears a recorded capability result; a no-op save keeps it.
  const before = readProfileFromDisk();
  writeProfileToDisk({ ...before, lastCapabilityTest: { "stale|key": { status: "pass" } } });
  const changed = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: "gpt-y" });
  assert(Object.keys(changed.lastCapabilityTest).length === 0, `a changed configuration must clear recorded results, got ${JSON.stringify(changed.lastCapabilityTest)}`);

  const withResult = readProfileFromDisk();
  writeProfileToDisk({ ...withResult, lastCapabilityTest: { keep: { status: "pass" } } });
  const unchanged = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: "gpt-y" });
  assert(Boolean(unchanged.lastCapabilityTest.keep), "a no-op configuration save must keep recorded results");

  // Discovery is unsupported for this provider, and the manual list is untouched.
  const discovery = await profile.refreshDiscoveredModels(TEST_PROFILE_ID);
  assert(discovery.supported === false, `expected unsupported discovery, got ${JSON.stringify(discovery)}`);
  assert(/manually editable/.test(discovery.reason || ""), `expected an editable-list reason, got ${discovery.reason}`);
  assert((await profile.loadProfile()).models.length === 1, "discovery must not erase the manual model list");
});

await check("snapshotForRun returns the pinned typesafe shape and no key leaves the host object", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com/v1", textModelId: TEXT_MODEL_ID });
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, {
    typesafeApiKey: TYPESAFE_KEY,
    textModelApiKey: TEXT_MODEL_KEY,
    memoryOnly: true
  });

  const loaded = await profile.loadProfile();
  const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");

  assert(snapshot.runtime === "typesafe", `expected runtime typesafe, got ${snapshot.runtime}`);
  assert(snapshot.model === "jev-latest", snapshot.model);
  assert(snapshot.profileId === TEST_PROFILE_ID, snapshot.profileId);
  assert(snapshot.revision === loaded.revision, `revision must be the profile's, got ${snapshot.revision} vs ${loaded.revision}`);
  assert(snapshot.credentialRevision === loaded.credentialRevision, "credentialRevision must be the profile's credential counter");
  assert(
    JSON.stringify(snapshot.env) === JSON.stringify({ ANTHROPIC_BASE_URL: "typesafe:jev", ANTHROPIC_API_KEY: "" }),
    `env must carry only the identity marker, got ${JSON.stringify(snapshot.env)}`
  );
  assert(snapshot.typesafe.endpoint === "https://api.typesafe.ai", snapshot.typesafe.endpoint);
  assert(snapshot.typesafe.apiKey === TYPESAFE_KEY, "typesafe.apiKey must be the stored TypeSafe key");
  assert(snapshot.textModel.baseUrl === "https://text.example.com/v1", snapshot.textModel.baseUrl);
  assert(snapshot.textModel.model === TEXT_MODEL_ID, snapshot.textModel.model);
  assert(snapshot.textModel.apiKey === TEXT_MODEL_KEY, "textModel.apiKey must be the stored text-model key");
  // A capability the profile was never tested for is never claimed: an
  // untested configuration reports no provider-side search, so a run on it
  // declares no search tool.
  assert(snapshot.searchSources === false, `an untested profile claims no search: ${snapshot.searchSources}`);

  // The keys appear exactly once each in the whole snapshot — under the two
  // host-memory fields, nowhere else — and not at all in env.
  const snapshotJson = JSON.stringify(snapshot);
  assert(countOccurrences(snapshotJson, TYPESAFE_KEY) === 1, "the TypeSafe key must appear exactly once in the snapshot");
  assert(countOccurrences(snapshotJson, TEXT_MODEL_KEY) === 1, "the text-model key must appear exactly once in the snapshot");
  assertNoKeyValues(JSON.stringify(snapshot.env), "the snapshot environment");

  // The identity half (everything a conversation bound-identity check reads)
  // is key-free.
  const withoutKeys = {
    runtime: snapshot.runtime,
    model: snapshot.model,
    env: snapshot.env,
    endpoint: snapshot.typesafe.endpoint,
    textModelBaseUrl: snapshot.textModel.baseUrl,
    textModelId: snapshot.textModel.model,
    revision: snapshot.revision,
    profileId: snapshot.profileId,
    credentialRevision: snapshot.credentialRevision
  };
  assertNoKeyValues(JSON.stringify(withoutKeys), "the snapshot identity half");

  // The same holds for every non-secret surface a settings reply could carry.
  const rawFile = fs.readFileSync(path.join(process.env.OCIC_AGENT_CONFIG_DIR, "agent-profile.json"), "utf-8");
  assertNoKeyValues(rawFile, "the profile file");
  assertNoKeyValues(JSON.stringify(loaded), "loadProfile()");
  assertNoKeyValues(JSON.stringify(await profile.exportProfileRedacted(TEST_PROFILE_ID)), "exportProfileRedacted()");
  assert(loaded.hasTypesafeKey === true && loaded.hasTextModelKey === true, "loadProfile must report the stored-ness booleans");
  assertNoCredentialFieldNames(loaded, "the loaded profile");
});

await check("snapshotForRun requires both keys and a complete text-model configuration", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");

  // No text-model configuration: INVALID_PROFILE, never a credential question.
  let code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `expected INVALID_PROFILE before any key is read, got ${code}`);

  await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID });
  code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  } catch (err) {
    code = err.code;
  }
  assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL with no keys, got ${code}`);

  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  } catch (err) {
    code = err.code;
  }
  assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL with only the TypeSafe key, got ${code}`);

  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
  const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  assert(snapshot.typesafe.apiKey === TYPESAFE_KEY && snapshot.textModel.apiKey === TEXT_MODEL_KEY, "both merged keys must reach the snapshot");

  // A model outside the profile's list is a profile error, not a credential one.
  code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "not-a-listed-model");
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `expected INVALID_PROFILE for an unlisted model, got ${code}`);
});

await check("anthropic and chatgpt snapshots are unchanged by the typesafe addition", async () => {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-x", label: "Claude X" }],
    defaultModelId: "claude-x"
  });
  await profile.setCredential(TEST_PROFILE_ID, "sk-ant-test-only-anthropic-0001", { memoryOnly: true });
  const anthropicSnapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "claude-x");
  assert(!("runtime" in anthropicSnapshot), "an anthropic snapshot must not gain a runtime field");
  assert(
    JSON.stringify(anthropicSnapshot.env) === JSON.stringify({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-test-only-anthropic-0001" }),
    `an anthropic snapshot's env must be unchanged, got ${JSON.stringify(anthropicSnapshot.env)}`
  );

  // The chatgpt branch still points the SDK at its loopback gateway.
  const gw = createChatgptGateway({
    upstreamUrl: "http://127.0.0.1:1/never",
    getAccessToken: async () => ({ accessToken: "fake-chatgpt-access-token", accountId: "acc-mock" }),
    loadProfile: () => profile.loadProfile()
  });
  _setActiveGatewayForTests(gw);
  try {
    useScratchConfigDir();
    await profile.saveProfile({
      profileId: TEST_PROFILE_ID,
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "gpt-5.5", label: "gpt-5.5" }],
      defaultModelId: "gpt-5.5"
    });
    await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
    await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "typesafe-test@example.com", planType: "plus", backend: "memory" });
    const chatgptSnapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "gpt-5.5");
    assert(!("runtime" in chatgptSnapshot), "a chatgpt snapshot must not gain a runtime field");
    assert(Object.keys(chatgptSnapshot.env).sort().join(",") === "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL", JSON.stringify(chatgptSnapshot.env));
    assert(chatgptSnapshot.env.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:"), chatgptSnapshot.env.ANTHROPIC_BASE_URL);
    chatgptSnapshot.releaseGatewayToken();
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
  }
});

await check("setTypesafeCredentials merges, rotates, and removes keys, reporting booleans only", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");

  const stored = await profile.setTypesafeCredentials(TEST_PROFILE_ID, {
    typesafeApiKey: TYPESAFE_KEY,
    textModelApiKey: TEXT_MODEL_KEY,
    memoryOnly: true
  });
  assert(JSON.stringify(stored) === JSON.stringify({ backend: "memory", hasTypesafeKey: true, hasTextModelKey: true }), `unexpected reply ${JSON.stringify(stored)}`);
  assertNoKeyValues(JSON.stringify(stored), "the set_typesafe_credentials reply");
  assertNoCredentialFieldNames(stored, "the set_typesafe_credentials reply");
  assert(JSON.stringify(await storedTypesafeSecret()) === JSON.stringify({ v: 1, typesafe_api_key: TYPESAFE_KEY, text_model_api_key: TEXT_MODEL_KEY }), "both keys must live in ONE merged JSON record");
  const afterFirst = await profile.loadProfile();
  assert(afterFirst.hasCredential === true && afterFirst.memoryOnlyCredential === true && afterFirst.secretBackend === "memory", JSON.stringify(afterFirst));
  assert(afterFirst.hasTypesafeKey === true && afterFirst.hasTextModelKey === true, "both stored-ness booleans must be set");

  // Rotating one key keeps the other — and an unchanged call must not bump the
  // credential revision (that would invalidate a capability result for nothing).
  const rotated = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY_2, memoryOnly: true });
  assert(rotated.hasTypesafeKey === true && rotated.hasTextModelKey === true, JSON.stringify(rotated));
  const afterRotate = await profile.loadProfile();
  assert(afterRotate.credentialRevision === afterFirst.credentialRevision + 1, "a rotation must bump the credential revision once");
  assert((await storedTypesafeSecret()).text_model_api_key === TEXT_MODEL_KEY, "rotating one key must keep the other");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY_2, memoryOnly: true });
  assert((await profile.loadProfile()).credentialRevision === afterRotate.credentialRevision, "an unchanged call must not bump the credential revision");

  // An explicit empty string removes exactly that key.
  const removedOne = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: "", memoryOnly: true });
  assert(removedOne.hasTypesafeKey === false && removedOne.hasTextModelKey === true, JSON.stringify(removedOne));
  const secret = await storedTypesafeSecret();
  assert(secret.typesafe_api_key === "" && secret.text_model_api_key === TEXT_MODEL_KEY, `a removed key must be the empty string, got ${JSON.stringify(secret)}`);
  assert((await profile.loadProfile()).hasCredential === true, "one remaining key still counts as a stored credential");

  // Removing the last key IS a revocation: the record is deleted and the listeners fire.
  const seen = [];
  profile.onCredentialRevoked((event) => seen.push(event.profileId));
  const removedAll = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { textModelApiKey: "", memoryOnly: true });
  assert(JSON.stringify(removedAll) === JSON.stringify({ backend: null, hasTypesafeKey: false, hasTextModelKey: false }), JSON.stringify(removedAll));
  assert(await storedTypesafeSecret() === null, "the secret record must be deleted when the last key is cleared");
  const afterClear = await profile.loadProfile();
  assert(afterClear.hasCredential === false && afterClear.hasTypesafeKey === false && afterClear.hasTextModelKey === false, JSON.stringify(afterClear));
  assert(seen.includes(TEST_PROFILE_ID), "clearing the last key must fire onCredentialRevoked");
});

await check("an oversize merged secret fails as SECRET_TOO_LARGE on the memory-only path, storing nothing", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
  const before = await profile.loadProfile();

  // The memory-only path reaches no backend that could enforce a limit, so
  // the ceiling has to be measured by the caller (specs/typesafe-jev-provider
  // "Credential and configuration storage": a secret that does not fit the
  // store's size limit fails with SECRET_TOO_LARGE and is never truncated).
  //
  // The boundary first: a record of exactly the 2560-byte ceiling IS stored —
  // the rule is "does not fit", not "at the limit" — which also proves the
  // check is measured on the serialized record, not on some other quantity.
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, typesafe_api_key: "", text_model_api_key: TEXT_MODEL_KEY }), "utf-8");
  const atLimitKey = "k".repeat(2560 - overhead);
  const atLimit = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: atLimitKey, memoryOnly: true });
  assert(atLimit.hasTypesafeKey === true && atLimit.hasTextModelKey === true, JSON.stringify(atLimit));
  const atLimitStored = await storedTypesafeSecret();
  const atLimitBytes = Buffer.byteLength(JSON.stringify(atLimitStored), "utf-8");
  assert(atLimitBytes === 2560, `a record of exactly the ceiling must be stored (got ${atLimitBytes} bytes)`);
  const beforeRefusal = await profile.loadProfile();

  // One byte more does not fit: nothing is stored, the prior record and the
  // credential revision are exactly as they were.
  const oversize = `${atLimitKey}k`;
  let error = null;
  try {
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: oversize, memoryOnly: true });
  } catch (err) {
    error = err;
  }
  assert(error && error.code === "SECRET_TOO_LARGE", `expected SECRET_TOO_LARGE, got ${error && error.code}: ${error && error.message}`);
  assert(!String(error.message).includes(oversize), "the failure message must never echo the secret");
  assert(
    JSON.stringify(await storedTypesafeSecret()) === JSON.stringify(atLimitStored),
    "an oversize call must leave the previously stored record exactly as it was"
  );
  const after = await profile.loadProfile();
  assert(after.credentialRevision === beforeRefusal.credentialRevision, "a refused store must not bump the credential revision");
  assert(after.hasTypesafeKey === true && after.hasTextModelKey === true, JSON.stringify(after));
});

await check("an oversize merged secret fails as SECRET_TOO_LARGE before any OS backend is reached", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
  const before = await profile.loadProfile();

  // The OS path is proven WITHOUT touching a real credential store: every
  // platform backend's write (the store's own availability probe included) is
  // replaced by a spy, so a guard that ran too late — or not at all — fails
  // here instead of writing a junk secret into this machine's keychain.
  const writes = [];
  const restore = [];
  for (const [name, backend] of Object.entries(OS_BACKENDS)) {
    restore.push([backend, backend.write]);
    backend.write = async () => {
      writes.push(name);
      throw new Error(`the ${name} backend must never be reached for an oversize secret`);
    };
  }
  let error = null;
  try {
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: "k".repeat(2600), memoryOnly: false });
  } catch (err) {
    error = err;
  } finally {
    for (const [backend, write] of restore) backend.write = write;
  }
  assert(error && error.code === "SECRET_TOO_LARGE", `expected SECRET_TOO_LARGE, got ${error && error.code}: ${error && error.message}`);
  assert(writes.length === 0, `no OS backend may be reached for an oversize secret (reached: ${writes.join(", ")})`);
  assert(
    JSON.stringify(await storedTypesafeSecret()) === JSON.stringify({ v: 1, typesafe_api_key: TYPESAFE_KEY, text_model_api_key: TEXT_MODEL_KEY }),
    "the prior record must be untouched"
  );
  const after = await profile.loadProfile();
  assert(after.credentialRevision === before.credentialRevision && after.secretBackend === "memory", JSON.stringify(after));
});

await check("removeTypesafeCredentials clears the record, the flags, and fires revocation", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
  const before = readProfileFromDisk();
  writeProfileToDisk({ ...before, lastCapabilityTest: { "stale|key": { status: "pass" } } });

  const seen = [];
  const off = profile.onCredentialRevoked((event) => seen.push(event.profileId));
  await profile.removeTypesafeCredentials(TEST_PROFILE_ID);
  off();

  assert(await storedTypesafeSecret() === null, "the merged secret record must be deleted");
  const after = await profile.loadProfile();
  assert(after.hasCredential === false && after.memoryOnlyCredential === false && after.secretBackend === null, JSON.stringify(after));
  assert(after.hasTypesafeKey === false && after.hasTextModelKey === false, "both stored-ness booleans must be cleared");
  assert(after.credentialRevision === before.credentialRevision + 1, "removal must bump the credential revision");
  assert(Object.keys(after.lastCapabilityTest).length === 0, "removal must clear recorded capability results");
  assert(seen.filter((id) => id === TEST_PROFILE_ID).length === 1, "removal must fire onCredentialRevoked exactly once");

  // A removal for a profile that does not exist is a no-op, not a throw.
  await profile.removeTypesafeCredentials("no-such-profile");
});

await check("testCapability runs both stages against the real endpoints and reports them separately", async () => {
  useScratchConfigDir();
  const server = await startFixtureTypesafeServer();
  try {
    await freshProfile();
    await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { baseUrl: server.url, textModelBaseUrl: server.url, textModelId: TEXT_MODEL_ID });
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });

    // Both stages pass, and each request carried its own key.
    const passed = await profile.testCapability(TEST_PROFILE_ID, "jev-latest");
    assert(passed.status === "pass", `expected a pass, got ${JSON.stringify(passed)}`);
    assert(passed.capabilities.systemone === "pass" && passed.capabilities.textModel === "pass", JSON.stringify(passed.capabilities));
    // This profile's decision model speaks Chat Completions, which has no
    // provider-side server tools: the search stage is reported unavailable and
    // gates nothing.
    assert(passed.capabilities.search === "fail" && passed.errors.search?.code === "SEARCH_UNAVAILABLE", JSON.stringify(passed));
    assert(!passed.errors.systemone && !passed.errors.textModel && !passed.errors.image, JSON.stringify(passed.errors));
    assertNoKeyValues(JSON.stringify(passed), "the capability result");
    const systemoneCall = server.calls.find((call) => call.route === "systemone");
    const completionCall = server.calls.find((call) => call.route === "completion");
    assert(systemoneCall && systemoneCall.headers.authorization === `Bearer ${TYPESAFE_KEY}`, "the TypeSafe stage must authenticate with the TypeSafe key");
    assert(completionCall && completionCall.headers.authorization === `Bearer ${TEXT_MODEL_KEY}`, "the text-model stage must authenticate with the text-model key");

    // Recorded under the exact (endpoint, model, credential revision) key.
    const stored = readProfileFromDisk();
    const key = capabilityTestKey({ baseUrl: server.url, modelId: "jev-latest", credentialRevision: stored.credentialRevision });
    assert(stored.lastCapabilityTest[key] && stored.lastCapabilityTest[key].status === "pass", `expected a pass under ${key}, got ${JSON.stringify(Object.keys(stored.lastCapabilityTest))}`);
    assert(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest"), "a passing test makes the profile runnable");

    // A structurally invalid choice answer is INVALID_RESPONSE for stage one —
    // and stage two is still attempted and still passes.
    server.setScenario("invalid-response", "systemone");
    const invalid = await profile.testCapability(TEST_PROFILE_ID, "jev-latest");
    assert(invalid.status === "fail", `expected fail, got ${JSON.stringify(invalid)}`);
    assert(invalid.capabilities.systemone === "fail" && invalid.capabilities.textModel === "pass", JSON.stringify(invalid.capabilities));
    assert(invalid.errors.systemone && invalid.errors.systemone.code === "INVALID_RESPONSE", `expected INVALID_RESPONSE, got ${JSON.stringify(invalid.errors)}`);
    assert(!(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest")), "a failing test must not leave the profile runnable");

    // The reverse: stage one passes while the text model is unreachable, and
    // the failure code names the connectivity family.
    server.setScenario("success", "systemone");
    server.setScenario("error-401", "completion");
    const textFailed = await profile.testCapability(TEST_PROFILE_ID, "jev-latest");
    assert(textFailed.status === "fail", JSON.stringify(textFailed));
    assert(textFailed.capabilities.systemone === "pass" && textFailed.capabilities.textModel === "fail", JSON.stringify(textFailed.capabilities));
    assert(textFailed.errors.textModel && textFailed.errors.textModel.code === "AUTH_ERROR", `expected AUTH_ERROR for the text stage, got ${JSON.stringify(textFailed.errors)}`);
  } finally {
    await server.close();
  }
});

await check("the Jev source switches endpoint, seed, and capability wire together", async () => {
  useScratchConfigDir();
  const server = await startFixtureTypesafeServer();
  try {
    await freshProfile();
    await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
    const initial = await profile.loadProfile();
    assert(initial.typesafeSource === "typesafe", `a fresh typesafe profile is the direct source, got ${initial.typesafeSource}`);

    // Switching the source against the fixture endpoint: the untouched seed
    // list follows the source, and the capability test speaks the gateway's
    // wire.
    const switched = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
      typesafeSource: "vercel",
      baseUrl: server.url,
      textModelBaseUrl: server.url,
      textModelId: TEXT_MODEL_ID
    });
    assert(switched.typesafeSource === "vercel", `expected the vercel source, got ${switched.typesafeSource}`);
    assert(
      switched.models.length === 1 && switched.models[0].id === "typesafe-ai/jev",
      `the untouched seed follows the source: ${JSON.stringify(switched.models)}`
    );
    assert(switched.defaultModelId === "typesafe-ai/jev", switched.defaultModelId);

    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
    const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "typesafe-ai/jev");
    assert(snapshot.typesafe.source === "vercel", `the snapshot must carry the resolved source, got ${snapshot.typesafe.source}`);
    assert(snapshot.typesafe.endpoint === server.url, snapshot.typesafe.endpoint);

    const passed = await profile.testCapability(TEST_PROFILE_ID, "typesafe-ai/jev");
    assert(passed.status === "pass", JSON.stringify(passed));
    const gatewayCall = server.calls.find((call) => call.route === "vercel");
    assert(gatewayCall && gatewayCall.headers["ai-model-id"] === "typesafe-ai/jev", "the capability stage must speak the gateway wire");
    assert(gatewayCall && gatewayCall.headers.authorization === `Bearer ${TYPESAFE_KEY}`, "with the TypeSafe credential slot's key");
    assert(await profile.isRunnable(TEST_PROFILE_ID, "typesafe-ai/jev"), "a passing gateway test makes the profile runnable");
  } finally {
    await server.close();
  }
});

await check("a source switch moves only still-default endpoints and untouched seeds", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");

  // Both endpoints here are documented defaults, so each switch moves them;
  // switching back returns to the starting default.
  const toVercel = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "vercel",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(toVercel.baseUrl === "https://ai-gateway.vercel.sh", `expected the gateway default, got ${toVercel.baseUrl}`);
  const backDirect = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "typesafe",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(backDirect.baseUrl === "https://api.typesafe.ai", `expected the direct default back, got ${backDirect.baseUrl}`);

  // A custom endpoint never follows the source.
  await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    baseUrl: "https://custom.example.com",
    typesafeSource: "vercel",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  const customKept = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "typesafe",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(customKept.baseUrl === "https://custom.example.com", `a custom endpoint must survive: ${customKept.baseUrl}`);

  // An edited model list never follows the source either.
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: customKept.baseUrl,
    models: [{ id: "my-jev", label: "Mine" }],
    defaultModelId: "my-jev"
  });
  const kept = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "vercel",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(
    kept.models.length === 1 && kept.models[0].id === "my-jev" && kept.defaultModelId === "my-jev",
    `an edited list must survive: ${JSON.stringify(kept.models)}`
  );

  // The OpenRouter source is known: selecting it from a still-default
  // endpoint lands on its own documented default, and its model seed is the
  // namespaced id that route answers to.
  await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    baseUrl: "https://api.typesafe.ai",
    typesafeSource: "typesafe",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  const openrouter = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "openrouter",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(openrouter.typesafeSource === "openrouter", `expected the openrouter source, got ${openrouter.typesafeSource}`);
  assert(
    openrouter.baseUrl === "https://openrouter.ai",
    `expected the OpenRouter default endpoint, got ${openrouter.baseUrl}`
  );
  // And a profile sitting on that new default is not stranded there: the next
  // source change moves it on, exactly as the other defaults do.
  const backFromOpenrouter = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "typesafe",
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(
    backFromOpenrouter.baseUrl === "https://api.typesafe.ai",
    `the OpenRouter default must follow a source change too: ${backFromOpenrouter.baseUrl}`
  );

  // A source that is not one of the known wires is refused with
  // INVALID_PROFILE — nothing is coerced into a protocol it does not speak.
  let code = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, {
      typesafeSource: "not-a-jev-wire",
      textModelBaseUrl: "https://text.example.com",
      textModelId: TEXT_MODEL_ID
    });
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${code}`);
});

await check("the decision-model source decides what a typesafe profile must configure", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });

  // A profile stored before the choice existed loads as the OpenAI-compatible
  // source with its text-model configuration untouched.
  const openai = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    textModelBaseUrl: "https://text.example.com",
    textModelId: TEXT_MODEL_ID
  });
  assert(openai.typesafeDecisionSource === "openai", `expected the default source, got ${openai.typesafeDecisionSource}`);
  assert(openai.textModelId === TEXT_MODEL_ID, "its text model is kept exactly");

  // Anthropic: its own two fields are required, and the text model is not.
  let code = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { decisionSource: "anthropic", decisionModelId: "claude-x" });
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `a missing decision base URL must be refused, got ${code}`);

  const anthropic = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    decisionSource: "anthropic",
    decisionBaseUrl: "https://api.anthropic.com",
    decisionModelId: "claude-x"
  });
  assert(anthropic.typesafeDecisionSource === "anthropic", JSON.stringify(anthropic.typesafeDecisionSource));
  assert(anthropic.typesafeDecisionModelId === "claude-x", JSON.stringify(anthropic.typesafeDecisionModelId));
  // The deselected source's values survive the switch.
  assert(anthropic.textModelId === TEXT_MODEL_ID, "a deselected source's configuration must be kept, not cleared");

  // An unknown source is refused before anything is written.
  let unknown = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { decisionSource: "gemini", decisionModelId: "x" });
  } catch (err) {
    unknown = err.code;
  }
  assert(unknown === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${unknown}`);
});

await check("an anthropic decision source runs on the profile's own Anthropic key, with no text-model key", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    decisionSource: "anthropic",
    decisionBaseUrl: "https://api.anthropic.com",
    decisionModelId: "claude-x"
  });

  // No Anthropic key yet: the run is refused, naming the missing credential
  // rather than failing later at the wire.
  let code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  } catch (err) {
    code = err.code;
  }
  assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL, got ${code}`);

  await profile.setCredential(TEST_PROFILE_ID, "sk-ant-test-only-decision-0001", { memoryOnly: true });
  const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  assert(snapshot.runtime === "typesafe", JSON.stringify(snapshot.runtime));
  assert(snapshot.decisionSource === "anthropic", JSON.stringify(snapshot.decisionSource));
  assert(snapshot.textModel.kind === "anthropic", `the decision model speaks the Anthropic wire: ${JSON.stringify(snapshot.textModel.kind)}`);
  assert(snapshot.textModel.baseUrl === "https://api.anthropic.com" && snapshot.textModel.model === "claude-x", JSON.stringify(snapshot.textModel));
  assert(snapshot.textModel.apiKey === "sk-ant-test-only-decision-0001", "the profile's own Anthropic key is the decision credential");
  // The identity marker is untouched: this is still a typesafe conversation.
  assert(snapshot.env.ANTHROPIC_BASE_URL === "typesafe:jev" && snapshot.env.ANTHROPIC_API_KEY === "", JSON.stringify(snapshot.env));
});

await check("the Anthropic key's own stored-ness survives a TypeSafe credential write", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");

  // The decision model runs on the profile's Anthropic key; the TypeSafe key
  // is a different secret in a different record. Saving the second must not
  // make the surface claim the first is stored — nor forget it once it is.
  const before = await profile.loadProfile();
  assert(before.hasAnthropicKey === false, "no Anthropic key is stored yet");

  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  const typesafeOnly = await profile.loadProfile();
  assert(typesafeOnly.hasTypesafeKey === true, "the TypeSafe key is stored");
  assert(typesafeOnly.hasAnthropicKey === false, "saving the TypeSafe key must not claim the Anthropic key is saved");

  await profile.setCredential(TEST_PROFILE_ID, "sk-ant-test-only-decision-0002", { memoryOnly: true });
  const both = await profile.loadProfile();
  assert(both.hasAnthropicKey === true, "the Anthropic key is stored");

  // A later TypeSafe write must not clobber it.
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
  const after = await profile.loadProfile();
  assert(after.hasAnthropicKey === true, "a TypeSafe credential write must not clear the Anthropic key's own flag");
  assert(after.hasCredential === true, "at least one secret is stored");

  await profile.removeCredential(TEST_PROFILE_ID);
  const removed = await profile.loadProfile();
  assert(removed.hasAnthropicKey === false, "removing the Anthropic key clears its own flag");
});

await check("isRunnable requires a passing result for the current configuration and credential", async () => {
  useScratchConfigDir();
  const server = await startFixtureTypesafeServer();
  try {
    await freshProfile();
    await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { baseUrl: server.url, textModelBaseUrl: server.url, textModelId: TEXT_MODEL_ID });
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });

    assert(!(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest")), "must not be runnable before any test");
    assert((await profile.testCapability(TEST_PROFILE_ID, "jev-latest")).status === "pass", "setup: the capability test passes");
    assert(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest"), "a passing result makes the profile runnable");

    // Rotating a key invalidates it through the credential revision...
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY_2, memoryOnly: true });
    assert(!(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest")), "a key rotation must invalidate the prior result");

    // ...and so does a configuration change.
    assert((await profile.testCapability(TEST_PROFILE_ID, "jev-latest")).status === "pass", "setup: the rotated configuration passes");
    assert(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest"), "the rotated configuration is runnable once tested");
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: server.url, textModelId: "another-text-model" });
    assert(!(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest")), "a changed text-model configuration must invalidate the prior result");
  } finally {
    await server.close();
  }
});

await check("the screenshot toggle persists, defaults on, and never discards a recorded capability result", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setProviderType(TEST_PROFILE_ID, "typesafe");

  // A profile stored by a version that predates the field loads ENABLED (the
  // documented default), and the run snapshot carries that resolved default.
  const legacy = readProfileFromDisk();
  delete legacy.sendScreenshots;
  writeProfileToDisk(legacy);
  assert(!("sendScreenshots" in readProfileFromDisk()), "setup: the stored profile predates the toggle");
  assert((await profile.loadProfile()).sendScreenshots === true, "an absent toggle must load as enabled");

  await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID });
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });
  const onSnapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest");
  assert(onSnapshot.sendScreenshots === true, `the run snapshot must carry the resolved toggle (got ${onSnapshot.sendScreenshots})`);

  // Off persists, the snapshot follows, and an OMITTED value keeps the stored
  // one (so a settings page that predates the field cannot flip it).
  const off = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID, sendScreenshots: false });
  assert(off.sendScreenshots === false, `expected the resolved toggle, got ${JSON.stringify(off.sendScreenshots)}`);
  assert(readProfileFromDisk().sendScreenshots === false, "the toggle must be persisted, not just echoed");
  assert((await profile.snapshotForRun(TEST_PROFILE_ID, "jev-latest")).sendScreenshots === false, "and the run snapshot must carry the off state");
  const kept = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID });
  assert(kept.sendScreenshots === false, `an omitted toggle must keep the stored value, got ${kept.sendScreenshots}`);
  const backOn = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID, sendScreenshots: true });
  assert(backOn.sendScreenshots === true, `expected the toggle back on, got ${JSON.stringify(backOn.sendScreenshots)}`);

  // A non-boolean is refused rather than coerced, and the stored value stands.
  let code = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID, sendScreenshots: "off" });
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `expected INVALID_PROFILE for a non-boolean toggle, got ${code}`);
  assert(readProfileFromDisk().sendScreenshots === true, "a refused call must leave the stored toggle untouched");

  // The toggle is NOT a capability-affecting configuration change: the
  // recorded (endpoint, model, credential revision) result survives a flip,
  // because the toggle does not change what the test talks to.
  const withResult = readProfileFromDisk();
  writeProfileToDisk({ ...withResult, lastCapabilityTest: { keep: { status: "pass" } } });
  const flipped = await profile.setTypesafeConfig(TEST_PROFILE_ID, { textModelBaseUrl: "https://text.example.com", textModelId: TEXT_MODEL_ID, sendScreenshots: false });
  assert(Boolean(flipped.lastCapabilityTest.keep), `flipping the toggle must not discard a recorded capability result (${JSON.stringify(flipped.lastCapabilityTest)})`);
});

await check("the capability test records three stages and a failed image stage never strands the profile", async () => {
  useScratchConfigDir();
  const server = await startFixtureTypesafeServer();
  try {
    await freshProfile();
    await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { baseUrl: server.url, textModelBaseUrl: server.url, textModelId: TEXT_MODEL_ID });
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, textModelApiKey: TEXT_MODEL_KEY, memoryOnly: true });

    // A pass records all three stages, and the image stage's own request
    // carries the embedded PNG as multimodal content on the text-model key.
    const passed = await profile.testCapability(TEST_PROFILE_ID, "jev-latest");
    assert(passed.status === "pass", JSON.stringify(passed));
    assert(passed.capabilities.image === "pass", JSON.stringify(passed.capabilities));
    const completions = server.calls.filter((call) => call.route === "completion");
    assert(completions.length === 2, `the text stage and the image stage each issue one completion (got ${completions.length})`);
    const imageCall = completions.find((call) => Array.isArray(JSON.parse(call.body).messages[1].content));
    assert(imageCall, "one completion must carry the image part");
    assert(imageCall.headers.authorization === `Bearer ${TEXT_MODEL_KEY}`, "the image stage authenticates with the text-model key");
    assert(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest"), "a pass with the image stage makes the profile runnable");

    // A TEXT-ONLY model: the text stage passes, the image stage fails, and the
    // profile STAYS runnable — the toggle is the control, not the stage.
    server.setScenario("reject-image", "completion");
    const textOnly = await profile.testCapability(TEST_PROFILE_ID, "jev-latest");
    assert(textOnly.status === "pass", `the gating stages passed, so the profile stays runnable: ${JSON.stringify(textOnly)}`);
    assert(textOnly.capabilities.textModel === "pass" && textOnly.capabilities.image === "fail", JSON.stringify(textOnly.capabilities));
    assert(textOnly.errors.image && textOnly.errors.image.code === "INVALID_RESPONSE", JSON.stringify(textOnly.errors));
    assert(textOnly.errors.textModel === undefined, "the working stage must not be reported as failing");
    assert(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest"), "a text-only model remains runnable with screenshots disabled");

    // A result recorded BEFORE this change has no image key at all, still reads
    // as verified, and is never rewritten to invent one: an old pass is "image:
    // not tested" until the next test.
    const stored = readProfileFromDisk();
    const key = capabilityTestKey({ baseUrl: server.url, modelId: "jev-latest", credentialRevision: stored.credentialRevision });
    writeProfileToDisk({ ...stored, lastCapabilityTest: { [key]: { status: "pass", capabilities: { systemone: "pass", textModel: "pass" }, errors: {} } } });
    assert(await profile.isRunnable(TEST_PROFILE_ID, "jev-latest"), "an old result without the image stage stays runnable");
    const reread = (await profile.loadProfile()).lastCapabilityTest[key];
    assert(!("image" in reread.capabilities) && reread.errors.image === undefined, `the host must not fabricate an image stage for an old result (${JSON.stringify(reread)})`);
  } finally {
    await server.close();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

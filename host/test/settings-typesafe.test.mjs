#!/usr/bin/env node
//
// The Jev transport's own secret record, host half: what survives the
// removal of the standalone `typesafe` provider type. The Jev browser tools
// (`extract_page`, `browser_subgoal`) still gate on ONE saved key —
// `setTypesafeCredentials`'s `typesafeApiKey` — stored in the same merged
// JSON record (`browzy-in-chrome/typesafe/<profileId>`) the removed
// standalone provider used; the record's legacy `text_model_api_key` slot
// stays in the file, inert, never written or read by anything any more.
// `setTypesafeConfig`'s remaining branch (the "Jev browser tools" settings
// section on an `anthropic`/`chatgpt` profile) persists only
// `typesafeSource`/`jevToolsSendScreenshots`.
//
// Provider-type migration itself (a stored `typesafe` profile loading as
// `anthropic`) is covered by host/test/settings-typesafe-migration.test.mjs;
// this file never switches a profile to the removed type.
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
import { PROVIDER_TYPES, isKnownProviderType } from "../agent/settings/profile-schema.js";
import { memoryClearAll, memoryRead } from "../agent/secrets/memory-store.js";
import { OS_BACKENDS } from "../agent/secrets/secret-store.js";

const TEST_PROFILE_ID = "ocic-test-typesafe";
const TYPESAFE_KEY = "ts-test-only-not-a-real-key-0001";
const TYPESAFE_KEY_2 = "ts-test-only-rotation-key-0002";

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

/** An `anthropic` profile with an empty model list, exactly as a fresh install saves it. */
async function freshProfile(profileId = TEST_PROFILE_ID) {
  await profile.saveProfile({ profileId, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
}

function assertNoKeyValues(serialized, where) {
  for (const key of [TYPESAFE_KEY, TYPESAFE_KEY_2]) {
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

console.log("\nJev transport secret record settings (host)\n");

await check("PROVIDER_TYPES no longer includes the removed typesafe provider", async () => {
  assert(PROVIDER_TYPES.length === 2 && PROVIDER_TYPES.includes("anthropic") && PROVIDER_TYPES.includes("chatgpt"), JSON.stringify(PROVIDER_TYPES));
  assert(isKnownProviderType("typesafe") === false, "typesafe must no longer be a known provider type");
  assert(isKnownProviderType("openai") === false, "an unrelated unknown type stays unknown");
});

await check("setTypesafeConfig on an anthropic profile persists only typesafeSource/jevToolsSendScreenshots, ignoring every legacy field", async () => {
  useScratchConfigDir();
  await freshProfile();
  const before = await profile.loadProfile();

  const updated = await profile.setTypesafeConfig(TEST_PROFILE_ID, {
    typesafeSource: "vercel",
    jevToolsSendScreenshots: true,
    // Legacy fields a pre-removal settings page might still send: shape-
    // checked upstream in companion.js, but never read here.
    baseUrl: "https://ignored.example",
    textModelBaseUrl: "https://ignored.example/v1",
    textModelId: "ignored-model",
    decisionSource: "openai",
    sendScreenshots: false,
    consultSources: false
  });
  assert(updated.typesafeSource === "vercel", `expected the vercel source, got ${updated.typesafeSource}`);
  assert(updated.jevToolsSendScreenshots === true, "the Jev-tools toggle must persist");
  assert(updated.baseUrl === before.baseUrl, "the primary endpoint must be untouched");
  assert(JSON.stringify(updated.models) === JSON.stringify(before.models), "the primary model list must be untouched");
  assert(updated.defaultModelId === before.defaultModelId, "the primary default model must be untouched");
  assert(JSON.stringify(updated.lastCapabilityTest) === JSON.stringify(before.lastCapabilityTest), "a recorded primary capability test must survive a Jev-transport-only save");
  assert(!("sendScreenshots" in updated), "the removed standalone provider's own screenshot toggle no longer exists");
  assert(!("consultSources" in updated), "the removed standalone provider's own consult-sources toggle no longer exists");

  // An omitted field on a later call keeps the stored value.
  const keptOnOmit = await profile.setTypesafeConfig(TEST_PROFILE_ID, {});
  assert(keptOnOmit.typesafeSource === "vercel", "an omitted typesafeSource keeps the previously stored value");
  assert(keptOnOmit.jevToolsSendScreenshots === true, "an omitted jevToolsSendScreenshots keeps the previously stored value");

  let code = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { jevToolsSendScreenshots: "yes" });
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `a non-boolean toggle must be refused, got ${code}`);

  let sourceCode = null;
  try {
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { typesafeSource: "not-a-jev-wire" });
  } catch (err) {
    sourceCode = err.code;
  }
  assert(sourceCode === "INVALID_PROFILE", `an unknown source must be refused, got ${sourceCode}`);
});

await check("setTypesafeCredentials stores, rotates, and removes the transport key, reporting booleans only", async () => {
  useScratchConfigDir();
  await freshProfile();

  const stored = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  assert(JSON.stringify(stored) === JSON.stringify({ backend: "memory", hasTypesafeKey: true, hasTextModelKey: false }), `unexpected reply ${JSON.stringify(stored)}`);
  assertNoKeyValues(JSON.stringify(stored), "the set_typesafe_credentials reply");
  assertNoCredentialFieldNames(stored, "the set_typesafe_credentials reply");
  assert(JSON.stringify(await storedTypesafeSecret()) === JSON.stringify({ v: 1, typesafe_api_key: TYPESAFE_KEY, text_model_api_key: "" }), "the transport key must land in the merged JSON record, the legacy slot empty");
  const afterFirst = await profile.loadProfile();
  assert(afterFirst.hasCredential === true && afterFirst.memoryOnlyCredential === true && afterFirst.secretBackend === "memory", JSON.stringify(afterFirst));
  assert(afterFirst.hasTypesafeKey === true && afterFirst.hasTextModelKey === false, "only the transport key's stored-ness flag is set");

  // Rotating the key: an unchanged call must not bump the credential
  // revision (that would invalidate a capability result for nothing).
  const rotated = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY_2, memoryOnly: true });
  assert(rotated.hasTypesafeKey === true, JSON.stringify(rotated));
  const afterRotate = await profile.loadProfile();
  assert(afterRotate.credentialRevision === afterFirst.credentialRevision + 1, "a rotation must bump the credential revision once");
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY_2, memoryOnly: true });
  assert((await profile.loadProfile()).credentialRevision === afterRotate.credentialRevision, "an unchanged call must not bump the credential revision");

  // Removing the only key IS a revocation: the record is deleted and the listeners fire.
  const seen = [];
  profile.onCredentialRevoked((event) => seen.push(event.profileId));
  const removedAll = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: "", memoryOnly: true });
  assert(JSON.stringify(removedAll) === JSON.stringify({ backend: null, hasTypesafeKey: false, hasTextModelKey: false }), JSON.stringify(removedAll));
  assert((await storedTypesafeSecret()) === null, "the secret record must be deleted when the transport key is cleared");
  const afterClear = await profile.loadProfile();
  assert(afterClear.hasCredential === false && afterClear.hasTypesafeKey === false, JSON.stringify(afterClear));
  assert(seen.includes(TEST_PROFILE_ID), "clearing the key must fire onCredentialRevoked");
});

await check("a legacy text-model key already on disk survives every transport-key write, inert", async () => {
  useScratchConfigDir();
  await freshProfile();
  // Simulate a record saved before this change, still carrying the legacy
  // key: the secret record directly (this op can no longer write that slot)
  // plus the profile's own `hasTextModelKey` bookkeeping flag, exactly as an
  // earlier version's setTypesafeCredentials would have left both.
  const { storeSecret } = await import("../agent/secrets/secret-store.js");
  const { readProfileFromDisk, writeProfileToDisk } = await import("../agent/settings/profile-store.js");
  await storeSecret(`browzy-in-chrome/typesafe/${TEST_PROFILE_ID}`, JSON.stringify({ v: 1, typesafe_api_key: "", text_model_api_key: "tm-legacy-inert-key" }), { memoryOnly: true });
  writeProfileToDisk({ ...readProfileFromDisk(), hasTextModelKey: true, memoryOnlyCredential: true, secretBackend: "memory" });

  const withLegacy = await profile.loadProfile();
  assert(withLegacy.hasTextModelKey === true, "a pre-existing legacy key is still reported as stored");

  // Setting/rotating the transport key must never touch the legacy slot.
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  const secret = await storedTypesafeSecret();
  assert(secret.text_model_api_key === "tm-legacy-inert-key", "the legacy key must be carried forward untouched");
  assert(secret.typesafe_api_key === TYPESAFE_KEY, "the transport key must be the newly stored one");
  assert((await profile.loadProfile()).hasTextModelKey === true, "the legacy key's stored-ness flag survives a transport-key write");
});

await check("an oversize secret fails as SECRET_TOO_LARGE on the memory-only path, storing nothing", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });

  // The memory-only path reaches no backend that could enforce a limit, so
  // the ceiling has to be measured by the caller. The boundary first: a
  // record of exactly the 2560-byte ceiling IS stored — the rule is "does
  // not fit", not "at the limit".
  const overhead = Buffer.byteLength(JSON.stringify({ v: 1, typesafe_api_key: "", text_model_api_key: "" }), "utf-8");
  const atLimitKey = "k".repeat(2560 - overhead);
  const atLimit = await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: atLimitKey, memoryOnly: true });
  assert(atLimit.hasTypesafeKey === true, JSON.stringify(atLimit));
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
  assert(JSON.stringify(await storedTypesafeSecret()) === JSON.stringify(atLimitStored), "an oversize call must leave the previously stored record exactly as it was");
  const after = await profile.loadProfile();
  assert(after.credentialRevision === beforeRefusal.credentialRevision, "a refused store must not bump the credential revision");
  assert(after.hasTypesafeKey === true, JSON.stringify(after));
});

await check("an oversize secret fails as SECRET_TOO_LARGE before any OS backend is reached", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  const before = await profile.loadProfile();

  // The OS path is proven WITHOUT touching a real credential store: every
  // platform backend's write is replaced by a spy, so a guard that ran too
  // late — or not at all — fails here instead of writing a junk secret into
  // this machine's keychain.
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
  assert(JSON.stringify(await storedTypesafeSecret()) === JSON.stringify({ v: 1, typesafe_api_key: TYPESAFE_KEY, text_model_api_key: "" }), "the prior record must be untouched");
  const after = await profile.loadProfile();
  assert(after.credentialRevision === before.credentialRevision && after.secretBackend === "memory", JSON.stringify(after));
});

await check("removeTypesafeCredentials clears the record, the flags, and fires revocation", async () => {
  useScratchConfigDir();
  await freshProfile();
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });

  const seen = [];
  const off = profile.onCredentialRevoked((event) => seen.push(event.profileId));
  await profile.removeTypesafeCredentials(TEST_PROFILE_ID);
  off();

  assert((await storedTypesafeSecret()) === null, "the merged secret record must be deleted");
  const after = await profile.loadProfile();
  assert(after.hasCredential === false && after.memoryOnlyCredential === false && after.secretBackend === null, JSON.stringify(after));
  assert(after.hasTypesafeKey === false && after.hasTextModelKey === false, "both stored-ness booleans must be cleared");
  assert(seen.filter((id) => id === TEST_PROFILE_ID).length === 1, "removal must fire onCredentialRevoked exactly once");

  // A removal for a profile that does not exist is a no-op, not a throw.
  await profile.removeTypesafeCredentials("no-such-profile");
});

await check("the Anthropic key's own stored-ness is independent of the Jev transport key", async () => {
  useScratchConfigDir();
  await freshProfile();

  const before = await profile.loadProfile();
  assert(before.hasAnthropicKey === false, "no Anthropic key is stored yet");

  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });
  const transportOnly = await profile.loadProfile();
  assert(transportOnly.hasTypesafeKey === true, "the transport key is stored");
  assert(transportOnly.hasAnthropicKey === false, "saving the transport key must not claim the Anthropic key is saved");

  await profile.setCredential(TEST_PROFILE_ID, "sk-ant-test-only-decision-0002", { memoryOnly: true });
  const both = await profile.loadProfile();
  assert(both.hasAnthropicKey === true, "the Anthropic key is stored");

  // A later transport-key rotation must not clobber it.
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY_2, memoryOnly: true });
  const after = await profile.loadProfile();
  assert(after.hasAnthropicKey === true, "a transport-key write must not clear the Anthropic key's own flag");

  await profile.removeCredential(TEST_PROFILE_ID);
  const removed = await profile.loadProfile();
  assert(removed.hasAnthropicKey === false, "removing the Anthropic key clears its own flag");
  assert(removed.hasTypesafeKey === true, "removing the Anthropic key must not touch the transport key");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

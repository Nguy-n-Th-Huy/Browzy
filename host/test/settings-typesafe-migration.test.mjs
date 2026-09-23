#!/usr/bin/env node
//
// The one-time migration of a profile stored with the removed standalone
// `typesafe` provider type to `anthropic` (host/agent/settings/profile-
// schema.js's migrateStoredTypesafeProfile, applied by profile-store.js's
// readProfileFromDisk() — the single point every reader of the stored
// profile goes through — and by named-profiles.js's migrateLegacyProfile()
// for the one-time legacy-to-collection copy).
//
// A `typesafe` profile can no longer be CREATED through the public API
// (setProviderType/isKnownProviderType both reject it), so every check here
// writes the raw stored shape directly through profile-store.js's
// writeProfileToDisk — exactly what an older binary version's file on disk
// looks like the first time this version reads it.
//
// Isolation: every check gets its own scratch config directory via
// OCIC_AGENT_CONFIG_DIR; every credential is memoryOnly:true.
//
// Run: node host/test/settings-typesafe-migration.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as profile from "../agent/settings/profile.js";
import { readProfileFromDisk, writeProfileToDisk } from "../agent/settings/profile-store.js";
import { PROVIDER_TYPES } from "../agent/settings/profile-schema.js";
import * as namedProfiles from "../agent/settings/named-profiles.js";
import { memoryClearAll, memoryRead } from "../agent/secrets/memory-store.js";
import { storeSecret } from "../agent/secrets/secret-store.js";

const TEST_PROFILE_ID = "ocic-test-typesafe-migration";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-typesafe-migration-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  profile._clearCredentialRevokedListenersForTests();
  namedProfiles._clearProfileRevokedListenersForTests();
  return dir;
}

/** A raw stored profile shape exactly as an older binary version wrote it. */
function storedLegacyProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    profileId: TEST_PROFILE_ID,
    providerType: "typesafe",
    baseUrl: "https://api.typesafe.ai",
    models: [{ id: "jev-latest", label: "Jev (ultrafast)" }],
    defaultModelId: "jev-latest",
    revision: 3,
    credentialRevision: 0,
    memoryOnlyCredential: false,
    lastCapabilityTest: { "https://api.typesafe.ai jev-latest 0": { status: "pass" } },
    chatgptAccount: null,
    textModelBaseUrl: "https://text.example.com/v1",
    textModelId: "deepseek-chat",
    hasTypesafeKey: true,
    hasTextModelKey: true,
    typesafeSource: "typesafe",
    typesafeDecisionSource: "openai",
    typesafeDecisionBaseUrl: "",
    typesafeDecisionModelId: "",
    sendScreenshots: false,
    jevToolsSendScreenshots: true,
    consultSources: false,
    ...overrides
  };
}

console.log("\nStandalone typesafe provider migration (host)\n");

await check("a stored typesafe profile with the untouched jev-latest seed migrates to anthropic once, seed models cleared", async () => {
  useScratchConfigDir();
  writeProfileToDisk(storedLegacyProfile());
  await storeSecret(`browzy-in-chrome/typesafe/${TEST_PROFILE_ID}`, JSON.stringify({ v: 1, typesafe_api_key: "ts-migration-test-key", text_model_api_key: "" }), { memoryOnly: true });

  const loaded = await profile.loadProfile();
  assert(loaded.providerType === "anthropic", `expected anthropic, got ${loaded.providerType}`);
  assert(loaded.baseUrl === "https://api.anthropic.com", `expected the default Anthropic base URL, got ${loaded.baseUrl}`);
  assert(loaded.models.length === 0, `the untouched jev-latest seed must be cleared, got ${JSON.stringify(loaded.models)}`);
  assert(loaded.defaultModelId === null, `defaultModelId must be cleared alongside the seed, got ${loaded.defaultModelId}`);
  assert(Object.keys(loaded.lastCapabilityTest).length === 0, "a capability result recorded against the Jev transport must be cleared");
  assert(loaded.typesafeSource === "typesafe", "typesafeSource must survive the migration for the Jev browser tools");
  assert(loaded.jevToolsSendScreenshots === true, "jevToolsSendScreenshots must survive the migration");

  // Raw stored file: the standalone-only fields are actually gone, not just
  // defaulted at read time.
  const rawAfter = readProfileFromDisk();
  assert(rawAfter.providerType === "anthropic", "the raw stored file must be rewritten, not just the read-time view");
  assert(!("typesafeDecisionSource" in rawAfter), "typesafeDecisionSource must be dropped from the stored file");
  assert(!("typesafeDecisionBaseUrl" in rawAfter), "typesafeDecisionBaseUrl must be dropped from the stored file");
  assert(!("typesafeDecisionModelId" in rawAfter), "typesafeDecisionModelId must be dropped from the stored file");
  assert(!("sendScreenshots" in rawAfter), "the removed primary screenshot toggle must be dropped from the stored file");
  assert(!("consultSources" in rawAfter), "the removed consult-sources toggle must be dropped from the stored file");
  assert(rawAfter.revision === 4, `the migration is a real edit and must bump revision once (3 -> 4), got ${rawAfter.revision}`);

  // The Jev transport secret record is never touched by the migration.
  const secretRaw = await memoryRead(`browzy-in-chrome/typesafe/${TEST_PROFILE_ID}`, { memoryOnly: true });
  assert(JSON.parse(secretRaw).typesafe_api_key === "ts-migration-test-key", "the Jev transport key must survive the migration untouched");
  assert(loaded.hasTypesafeKey === true, "the transport key's stored-ness flag must survive the migration");

  // Written ONCE: a second read must not bump the revision or rewrite the
  // file again — providerType is now anthropic, so the migration's own
  // guard (providerType !== "typesafe") makes every later read a no-op.
  const rawFilePath = path.join(process.env.OCIC_AGENT_CONFIG_DIR, "agent-profile.json");
  const bytesAfterFirstRead = fs.readFileSync(rawFilePath, "utf-8");
  const loadedAgain = await profile.loadProfile();
  assert(loadedAgain.revision === loaded.revision, `a second read must not bump the revision again, got ${loadedAgain.revision} vs ${loaded.revision}`);
  const bytesAfterSecondRead = fs.readFileSync(rawFilePath, "utf-8");
  assert(bytesAfterSecondRead === bytesAfterFirstRead, "a second read must not rewrite the stored file at all");
});

await check("a stored typesafe profile with a custom (non-seed) model list keeps it exactly", async () => {
  useScratchConfigDir();
  writeProfileToDisk(
    storedLegacyProfile({
      models: [
        { id: "jev-custom-1", label: "Custom One" },
        { id: "jev-custom-2", label: "Custom Two" }
      ],
      defaultModelId: "jev-custom-2"
    })
  );

  const loaded = await profile.loadProfile();
  assert(loaded.providerType === "anthropic", loaded.providerType);
  assert(
    JSON.stringify(loaded.models) === JSON.stringify([
      { id: "jev-custom-1", label: "Custom One" },
      { id: "jev-custom-2", label: "Custom Two" }
    ]),
    `a custom model list must survive the migration exactly, got ${JSON.stringify(loaded.models)}`
  );
  assert(loaded.defaultModelId === "jev-custom-2", `a custom default model must survive, got ${loaded.defaultModelId}`);
});

await check("a stored typesafe profile on the vercel or openrouter seed also has its seed cleared", async () => {
  useScratchConfigDir();
  writeProfileToDisk(
    storedLegacyProfile({
      typesafeSource: "vercel",
      baseUrl: "https://ai-gateway.vercel.sh",
      models: [{ id: "typesafe-ai/jev", label: "Jev (Vercel AI Gateway)" }],
      defaultModelId: "typesafe-ai/jev"
    })
  );
  const loaded = await profile.loadProfile();
  assert(loaded.models.length === 0, `the vercel seed must also be recognized and cleared, got ${JSON.stringify(loaded.models)}`);
  assert(loaded.defaultModelId === null, loaded.defaultModelId);
  assert(loaded.typesafeSource === "vercel", "typesafeSource itself must survive — only the seed model list is cleared");
});

await check("a stored anthropic or chatgpt profile is never touched by the migration", async () => {
  useScratchConfigDir();
  const anthropicProfile = { ...storedLegacyProfile(), providerType: "anthropic", baseUrl: "https://api.anthropic.com" };
  writeProfileToDisk(anthropicProfile);
  const loaded = await profile.loadProfile();
  assert(loaded.providerType === "anthropic", loaded.providerType);
  assert(loaded.revision === anthropicProfile.revision, "an already-anthropic profile must not be rewritten by the migration");
  assert(loaded.models.length === 1 && loaded.models[0].id === "jev-latest", "a non-typesafe profile's model list is never touched by this migration, whatever it contains");
});

await check("setProviderType and isKnownProviderType both reject the removed typesafe provider type", async () => {
  useScratchConfigDir();
  assert(PROVIDER_TYPES.includes("typesafe") === false, "PROVIDER_TYPES must not list typesafe");
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  let code = null;
  try {
    await profile.setProviderType(TEST_PROFILE_ID, "typesafe");
  } catch (err) {
    code = err.message;
  }
  assert(code && /unknown provider type/i.test(code), `setProviderType("typesafe") must be rejected, got ${code}`);
  assert((await profile.loadProfile()).providerType === "anthropic", "a rejected switch must never persist");
});

await check("a stored named-profile collection is unaffected (it never carried a providerType)", async () => {
  useScratchConfigDir();
  namedProfiles.createProfile({ profileId: "np-1", baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const before = namedProfiles.getProfile("np-1");
  assert(before.baseUrl === "https://api.anthropic.com", "a plain named profile is untouched by the typesafe migration");
});

await check("migrating the legacy single profile into the named collection carries the migrated (anthropic) values, and never rewrites the legacy file", async () => {
  useScratchConfigDir();
  // Written directly — never through loadProfile()/snapshotForRun(), so the
  // legacy file on disk is still the RAW, unmigrated `typesafe` shape at the
  // moment migrateLegacyProfile() runs, exactly like a fresh install of this
  // version reading a file an older version left behind.
  writeProfileToDisk(storedLegacyProfile());
  const rawFilePath = path.join(process.env.OCIC_AGENT_CONFIG_DIR, "agent-profile.json");
  const rawBefore = fs.readFileSync(rawFilePath, "utf-8");
  assert(JSON.parse(rawBefore).providerType === "typesafe", "setup: the legacy file must still be the raw typesafe shape");

  const outcome = namedProfiles.migrateLegacyProfile();
  assert(outcome.migrated === true && outcome.profileId === TEST_PROFILE_ID, JSON.stringify(outcome));

  const copied = namedProfiles.getProfile(TEST_PROFILE_ID);
  assert(copied, "the legacy profile must be copied into the collection");
  assert(copied.baseUrl === "https://api.anthropic.com", `the copied record must carry the migrated (anthropic) base URL, got ${copied.baseUrl}`);
  assert(copied.models.length === 0, `the copied record must carry the seed-cleared model list, got ${JSON.stringify(copied.models)}`);
  assert(Object.keys(copied.lastCapabilityTest).length === 0, "the copied record must not carry a capability result recorded against the Jev transport");

  // The legacy file itself is untouched — migrateLegacyProfile()'s own
  // contract ("never modifies or deletes the legacy file"), unaffected by
  // this migration running inside it.
  const rawAfter = fs.readFileSync(rawFilePath, "utf-8");
  assert(rawAfter === rawBefore, "migrateLegacyProfile() must never rewrite the legacy single-profile file");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

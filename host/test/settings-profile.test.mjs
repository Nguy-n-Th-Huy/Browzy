#!/usr/bin/env node
//
// Profile orchestration contract (host/agent/settings/profile.js):
// loadProfile / snapshotForRun / onCredentialRevoked, plus the surrounding
// save/credential/isRunnable behavior task group 4 requires.
//
// Every check gets its own scratch config directory via
// OCIC_AGENT_CONFIG_DIR so this never touches a real profile, and every
// credential in this file uses memoryOnly:true. It also uses a dedicated,
// obviously test-only profileId (never the production default) throughout:
// a credential lookup for a profile that never had a credential set (or
// just had one removed) falls through to the real OS credential store by
// default (see the comment on TEST_PROFILE_ID below), so memoryOnly:true
// alone is not sufficient isolation — the profileId matters too. Real
// (non-memory) OS-backend exercise is covered separately in
// host/test/secrets-store.test.mjs.
//
// Run: node host/test/settings-profile.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as profile from "../agent/settings/profile.js";
import { writeProfileToDisk, readProfileFromDisk, createEmptyProfile } from "../agent/settings/profile-store.js";
import { capabilityTestKey } from "../agent/settings/profile-schema.js";
import { memoryClearAll } from "../agent/secrets/memory-store.js";

// A dedicated, obviously test-only profileId — deliberately never the
// literal string that host/agent/settings/profile-schema.js's
// DEFAULT_PROFILE_ID holds (the exact profileId every real installation
// uses). Even though every credential in this file is memoryOnly:true,
// several checks resolve a credential for a profile that either never had
// one set or just had one removed; in both cases profile.js's
// memoryOnlyCredential/secretBackend fields read back as "unset", which
// makes the credential lookup fall through to the REAL OS credential store
// by default. Using the production profileId here would make that fallback
// probe the exact same global Windows Credential Manager entry a real
// installation on this machine uses — reproduced live: see
// reports/09-live-gate-evidence.md and reports/04-settings-evidence.md. A
// structural guard also now exists in host/agent/secrets/secret-store.js
// that throws instead of silently reading/writing/deleting that real
// target while OCIC_AGENT_CONFIG_DIR is set; using a dedicated profileId
// here keeps this file's own checks meaningful (a truly empty test target)
// rather than merely relying on that guard to fail loudly.
const TEST_PROFILE_ID = "ocic-test-settings-profile";

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
  if (!cond) throw new Error(msg);
}

function useScratchConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-profile-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  return dir;
}

console.log("\nProfile orchestration contract\n");

await check("loadProfile() returns null before any profile is saved", async () => {
  useScratchConfigDir();
  const loaded = await profile.loadProfile();
  assert(loaded === null, JSON.stringify(loaded));
});

await check("saveProfile persists offline (no network) and loadProfile reflects it", async () => {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-x", label: "Claude X" }],
    defaultModelId: "claude-x"
  });
  const loaded = await profile.loadProfile();
  assert(loaded.baseUrl === "https://api.anthropic.com");
  assert(loaded.models.length === 1);
  assert(loaded.defaultModelId === "claude-x");
  assert(loaded.revision === 1, `expected revision 1, got ${loaded.revision}`);
});

await check("loadProfile's shape matches the fixed contract fields", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const loaded = await profile.loadProfile();
  for (const field of ["profileId", "baseUrl", "models", "defaultModelId", "revision", "lastCapabilityTest"]) {
    assert(field in loaded, `missing contract field: ${field}`);
  }
});

await check("an invalid save (bad URL) leaves the last saved profile intact", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  let threw = false;
  try {
    await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "not a url", models: [], defaultModelId: null });
  } catch {
    threw = true;
  }
  assert(threw, "expected the invalid save to throw");
  const loaded = await profile.loadProfile();
  assert(loaded.baseUrl === "https://api.anthropic.com", "last good profile must survive a rejected save");
});

await check("saveProfile revision increments on every successful save", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const loaded = await profile.loadProfile();
  assert(loaded.revision === 2, `expected revision 2, got ${loaded.revision}`);
});

await check("setCredential (memory-only) marks hasCredential and bumps credentialRevision", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const { backend } = await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-1", { memoryOnly: true });
  assert(backend === "memory");
  const loaded = await profile.loadProfile();
  assert(loaded.hasCredential === true);
  assert(loaded.memoryOnlyCredential === true);
  assert(loaded.credentialRevision === 1, `expected credentialRevision 1, got ${loaded.credentialRevision}`);
});

await check("setCredential rejects an empty credential", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  let threw = false;
  try {
    await profile.setCredential(TEST_PROFILE_ID, "   ", { memoryOnly: true });
  } catch {
    threw = true;
  }
  assert(threw);
});

await check("snapshotForRun throws NO_CREDENTIAL when no credential is stored", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-x", label: "X" }], defaultModelId: "claude-x" });
  let code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "claude-x");
  } catch (err) {
    code = err.code;
  }
  assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL, got ${code}`);
});

await check("snapshotForRun returns the exact contract shape with the requested model", async () => {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-a", label: "A" },
      { id: "claude-b", label: "B" }
    ],
    defaultModelId: "claude-a"
  });
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-2", { memoryOnly: true });
  const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID, "claude-b");
  assert(snapshot.model === "claude-b");
  assert(snapshot.env.ANTHROPIC_BASE_URL === "https://api.anthropic.com");
  assert(snapshot.env.ANTHROPIC_API_KEY === "sk-test-key-2");
  assert(typeof snapshot.revision === "number");
  assert(snapshot.profileId === TEST_PROFILE_ID);
  assert(Object.keys(snapshot.env).sort().join(",") === "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL", Object.keys(snapshot.env).join(","));
});

await check("snapshotForRun's credentialRevision reflects the credential's own revision counter — non-secret, distinct from the whole-profile revision (tasks.md 2.1)", async () => {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-a", label: "A" }],
    defaultModelId: "claude-a"
  });
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-cred-rev-1", { memoryOnly: true });
  const first = await profile.snapshotForRun(TEST_PROFILE_ID);
  assert(typeof first.credentialRevision === "number", `credentialRevision must be a number, got ${JSON.stringify(first.credentialRevision)}`);
  assert(first.credentialRevision === 1, `first credential set must be revision 1, got ${first.credentialRevision}`);

  // A non-credential edit (saveProfile) bumps the whole-profile `revision`
  // but must NOT bump `credentialRevision` — they are distinct counters.
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-a", label: "A" },
      { id: "claude-b", label: "B" }
    ],
    defaultModelId: "claude-a"
  });
  const afterProfileEdit = await profile.snapshotForRun(TEST_PROFILE_ID);
  assert(afterProfileEdit.credentialRevision === 1, `an unrelated profile edit must not bump credentialRevision, got ${afterProfileEdit.credentialRevision}`);
  assert(afterProfileEdit.revision > first.revision, "the unrelated profile edit DOES bump the whole-profile revision — the two counters are independent");

  // Replacing the credential bumps credentialRevision.
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-cred-rev-2", { memoryOnly: true });
  const afterCredentialReplace = await profile.snapshotForRun(TEST_PROFILE_ID);
  assert(afterCredentialReplace.credentialRevision === 2, `replacing the credential must bump credentialRevision, got ${afterCredentialReplace.credentialRevision}`);
});

await check("snapshotForRun falls back to the profile's default model when none is requested", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-3", { memoryOnly: true });
  const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID);
  assert(snapshot.model === "claude-a");
});

await check("snapshotForRun rejects a model not present in the profile's list", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-4", { memoryOnly: true });
  let code = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "claude-does-not-exist");
  } catch (err) {
    code = err.code;
  }
  assert(code === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${code}`);
});

await check("snapshotForRun's env REPLACES the ambient environment — no ambient ANTHROPIC_* leaks in", async () => {
  useScratchConfigDir();
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_BASE_URL = "https://attacker-controlled.example.com";
  process.env.ANTHROPIC_API_KEY = "sk-ambient-should-never-be-used";
  process.env.ANTHROPIC_AUTH_TOKEN = "should-never-appear-either";
  try {
    await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
    await profile.setCredential(TEST_PROFILE_ID, "sk-the-real-stored-secret", { memoryOnly: true });
    const snapshot = await profile.snapshotForRun(TEST_PROFILE_ID);
    assert(snapshot.env.ANTHROPIC_BASE_URL === "https://api.anthropic.com", `ambient base URL leaked: ${snapshot.env.ANTHROPIC_BASE_URL}`);
    assert(snapshot.env.ANTHROPIC_API_KEY === "sk-the-real-stored-secret", `ambient key leaked: ${snapshot.env.ANTHROPIC_API_KEY}`);
    assert(!("ANTHROPIC_AUTH_TOKEN" in snapshot.env), "an ambient auth token must never appear in the run snapshot");
    assert(JSON.stringify(snapshot.env).indexOf("attacker-controlled") === -1, "ambient value must not appear anywhere in the snapshot");
    assert(JSON.stringify(snapshot.env).indexOf("sk-ambient-should-never-be-used") === -1);
  } finally {
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
  }
});

await check("removeCredential fires onCredentialRevoked and clears the stored secret", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-5", { memoryOnly: true });

  let revokedEvent = null;
  const unsubscribe = profile.onCredentialRevoked((event) => {
    revokedEvent = event;
  });
  try {
    await profile.removeCredential(TEST_PROFILE_ID);
    assert(revokedEvent && revokedEvent.profileId === TEST_PROFILE_ID, `expected a revocation event, got ${JSON.stringify(revokedEvent)}`);

    const loaded = await profile.loadProfile();
    assert(loaded.hasCredential === false);

    let code = null;
    try {
      await profile.snapshotForRun(TEST_PROFILE_ID);
    } catch (err) {
      code = err.code;
    }
    assert(code === "NO_CREDENTIAL", "credential must actually be gone, not just flagged");
  } finally {
    unsubscribe();
  }
});

await check("replacing a credential invalidates prior capability-test results (key no longer matches the new credentialRevision)", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  await profile.setCredential(TEST_PROFILE_ID, "sk-first-key", { memoryOnly: true });

  // Simulate a recorded PASS the way testCapability() would, without a real
  // network call (the real capability-test path is covered end-to-end
  // against a fixture server in settings-capability-test.test.mjs).
  let stored = readProfileFromDisk();
  const key1 = capabilityTestKey({ baseUrl: stored.baseUrl, modelId: "claude-a", credentialRevision: stored.credentialRevision });
  writeProfileToDisk({ ...stored, lastCapabilityTest: { [key1]: { status: "pass" } } });
  assert(await profile.isRunnable(TEST_PROFILE_ID, "claude-a"), "expected runnable after a recorded pass");

  await profile.setCredential(TEST_PROFILE_ID, "sk-second-key", { memoryOnly: true });
  assert(!(await profile.isRunnable(TEST_PROFILE_ID, "claude-a")), "a replaced credential must invalidate the prior capability-test result");
});

await check("isRunnable is false until a passing capability-test result is recorded for this exact endpoint/model/credential", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  await profile.setCredential(TEST_PROFILE_ID, "sk-test-key-6", { memoryOnly: true });
  assert(!(await profile.isRunnable(TEST_PROFILE_ID, "claude-a")), "must not be runnable before any capability test");
});

await check("exportProfileRedacted never includes the stored secret (the profile file never held one to begin with)", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  await profile.setCredential(TEST_PROFILE_ID, "sk-should-never-be-exported", { memoryOnly: true });
  const exported = await profile.exportProfileRedacted(TEST_PROFILE_ID);
  const serialized = JSON.stringify(exported);
  assert(!serialized.includes("sk-should-never-be-exported"), `secret leaked into export: ${serialized}`);
});

await check("loadProfile defaults providerType to anthropic and chatgptAccount to null when absent", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const loaded = await profile.loadProfile();
  assert(loaded.providerType === "anthropic", `expected anthropic, got ${loaded.providerType}`);
  assert(loaded.chatgptAccount === null, `expected null chatgptAccount, got ${JSON.stringify(loaded.chatgptAccount)}`);
});

await check("a legacy profile file with no providerType/chatgptAccount field loads unchanged as anthropic (upgrade migration)", async () => {
  useScratchConfigDir();
  // A profile shaped exactly as one saved before provider types existed —
  // no providerType, no chatgptAccount field at all, not even as undefined.
  const legacy = createEmptyProfile(TEST_PROFILE_ID);
  delete legacy.providerType;
  delete legacy.chatgptAccount;
  legacy.baseUrl = "https://api.anthropic.com";
  legacy.models = [{ id: "claude-legacy", label: "Legacy" }];
  legacy.defaultModelId = "claude-legacy";
  legacy.revision = 7;
  legacy.credentialRevision = 2;
  writeProfileToDisk(legacy);

  const loaded = await profile.loadProfile();
  assert(loaded.providerType === "anthropic", `expected anthropic, got ${loaded.providerType}`);
  assert(loaded.chatgptAccount === null, `expected null chatgptAccount, got ${JSON.stringify(loaded.chatgptAccount)}`);
  // Every other field survives byte-for-byte equivalent.
  assert(loaded.baseUrl === "https://api.anthropic.com");
  assert(loaded.models.length === 1 && loaded.models[0].id === "claude-legacy");
  assert(loaded.defaultModelId === "claude-legacy", `defaultModelId: ${loaded.defaultModelId}`);
  assert(loaded.revision === 7, `expected revision 7, got ${loaded.revision}`);
  assert(loaded.credentialRevision === 2, `expected credentialRevision 2, got ${loaded.credentialRevision}`);
});

await check("setProviderType switches a profile's provider type and bumps revision", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const before = await profile.loadProfile();
  const after = await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  assert(after.providerType === "chatgpt", `expected chatgpt, got ${after.providerType}`);
  assert(after.revision > before.revision, "setProviderType must bump the profile revision");
});

await check("setProviderType rejects an unknown provider type", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  let threw = false;
  try {
    await profile.setProviderType(TEST_PROFILE_ID, "openai");
  } catch {
    threw = true;
  }
  assert(threw, "expected setProviderType to reject an unrecognized provider type");
});

await check("setChatgptAccount stores and clears the non-secret email/plan fields", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  const withAccount = await profile.setChatgptAccount(TEST_PROFILE_ID, { email: "user@example.com", planType: "plus" });
  assert(withAccount.chatgptAccount && withAccount.chatgptAccount.email === "user@example.com", JSON.stringify(withAccount.chatgptAccount));
  assert(withAccount.chatgptAccount.planType === "plus", JSON.stringify(withAccount.chatgptAccount));
  const cleared = await profile.setChatgptAccount(TEST_PROFILE_ID, null);
  assert(cleared.chatgptAccount === null, JSON.stringify(cleared.chatgptAccount));
});

await check("seedChatgptModelsForPlan seeds the plan's Codex model ids only when the model list is empty", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");

  const seeded = await profile.seedChatgptModelsForPlan(TEST_PROFILE_ID, "plus");
  assert(seeded.models.length > 0, "expected the plan's Codex models to be seeded");
  assert(seeded.models.some((m) => m.id === "gpt-6-astra"), "expected a paid-plan model id, got " + JSON.stringify(seeded.models));
  assert(seeded.defaultModelId === seeded.models[0].id, "expected the first seeded model to become the default");

  // A second call — even for a different plan — must never overwrite a
  // model list that is no longer empty (manual edits stay manual).
  const reseeded = await profile.seedChatgptModelsForPlan(TEST_PROFILE_ID, "free");
  assert(JSON.stringify(reseeded.models) === JSON.stringify(seeded.models), "a nonempty model list must never be reseeded");
});

await check("seedChatgptModelsForPlan falls back to the free-plan seed list for an unrecognized plan", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  const seeded = await profile.seedChatgptModelsForPlan(TEST_PROFILE_ID, "some-unrecognized-plan");
  assert(!seeded.models.some((m) => m.id === "gpt-6-astra"), "an unrecognized plan must not get the paid-only model id");
  assert(seeded.models.some((m) => m.id === "gpt-5.6-terra"), JSON.stringify(seeded.models));
});

await check("loadProfile defaults chatgptSessionState to signed_out when absent", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  const loaded = await profile.loadProfile();
  assert(loaded.chatgptSessionState === "signed_out", `expected signed_out, got ${loaded.chatgptSessionState}`);
});

await check("recordChatgptSignIn sets the account, seeds models, bumps credentialRevision, and records the backend (host/agent/chatgpt/auth.js's contract)", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  const before = await profile.loadProfile();
  assert(before.credentialRevision === 0);

  const after = await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "signed-in@example.com", planType: "pro", backend: "fake-os" });
  assert(after.chatgptAccount && after.chatgptAccount.email === "signed-in@example.com", JSON.stringify(after.chatgptAccount));
  assert(after.chatgptAccount.planType === "pro", JSON.stringify(after.chatgptAccount));
  assert(after.models.length > 0, "expected the plan's Codex models to be seeded on sign-in");
  assert(after.credentialRevision === 1, `expected credentialRevision 1, got ${after.credentialRevision}`);
  assert(after.hasCredential === true);
  assert(after.memoryOnlyCredential === false, "a non-memory backend must not be reported as memoryOnlyCredential");
  assert(after.secretBackend === "fake-os", after.secretBackend);
  assert(after.chatgptSessionState === "signed_in", after.chatgptSessionState);
});

await check("recordChatgptSignIn marks memoryOnlyCredential true for the memory backend", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  const after = await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "mem@example.com", planType: "free", backend: "memory" });
  assert(after.memoryOnlyCredential === true);
  assert(after.secretBackend === "memory");
});

await check("recordChatgptSignOut clears the account, credential flags, fires onCredentialRevoked, and sets chatgptSessionState to signed_out", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "bye@example.com", planType: "plus", backend: "memory" });

  let revokedEvent = null;
  const unsubscribe = profile.onCredentialRevoked((event) => {
    revokedEvent = event;
  });
  try {
    await profile.recordChatgptSignOut(TEST_PROFILE_ID);
    assert(revokedEvent && revokedEvent.profileId === TEST_PROFILE_ID, `expected a revocation event, got ${JSON.stringify(revokedEvent)}`);

    const after = await profile.loadProfile();
    assert(after.chatgptAccount === null, JSON.stringify(after.chatgptAccount));
    assert(after.hasCredential === false);
    assert(after.memoryOnlyCredential === false);
    assert(after.secretBackend === null);
    assert(after.chatgptSessionState === "signed_out", after.chatgptSessionState);
    assert(after.credentialRevision === 2, `expected credentialRevision 2 (1 sign-in + 1 sign-out), got ${after.credentialRevision}`);
  } finally {
    unsubscribe();
  }
});

await check("recordChatgptSessionExpired keeps the account visible but revokes the credential and fires onCredentialRevoked", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "expired@example.com", planType: "plus", backend: "memory" });

  let revokedEvent = null;
  const unsubscribe = profile.onCredentialRevoked((event) => {
    revokedEvent = event;
  });
  try {
    await profile.recordChatgptSessionExpired(TEST_PROFILE_ID);
    assert(revokedEvent && revokedEvent.profileId === TEST_PROFILE_ID, `expected a revocation event, got ${JSON.stringify(revokedEvent)}`);

    const after = await profile.loadProfile();
    // Unlike sign-out, the account stays visible so the side panel can name
    // who needs to sign in again.
    assert(after.chatgptAccount && after.chatgptAccount.email === "expired@example.com", JSON.stringify(after.chatgptAccount));
    assert(after.hasCredential === false);
    assert(after.memoryOnlyCredential === false);
    assert(after.secretBackend === null);
    assert(after.chatgptSessionState === "session_expired", after.chatgptSessionState);
  } finally {
    unsubscribe();
  }
});

await check("recordChatgptSessionExpired is idempotent: overlapping calls bump the revision and fire listeners exactly once", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  const signedIn = await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "burst@example.com", planType: "plus", backend: "memory" });
  const revisionBefore = signedIn.credentialRevision;

  let revocationEvents = 0;
  const unsubscribe = profile.onCredentialRevoked((event) => {
    if (event.profileId === TEST_PROFILE_ID) revocationEvents++;
  });
  try {
    // Several in-flight requests can each be answered 401 after their own
    // refresh retry and each ask for this same transition.
    await Promise.all([
      profile.recordChatgptSessionExpired(TEST_PROFILE_ID),
      profile.recordChatgptSessionExpired(TEST_PROFILE_ID),
      profile.recordChatgptSessionExpired(TEST_PROFILE_ID)
    ]);
    assert(revocationEvents === 1, `expected exactly one revocation event for the burst, got ${revocationEvents}`);
    const after = await profile.loadProfile();
    assert(after.chatgptSessionState === "session_expired", after.chatgptSessionState);
    assert(
      after.credentialRevision === revisionBefore + 1,
      `expected exactly one revision bump from ${revisionBefore}, got ${after.credentialRevision}`
    );
  } finally {
    unsubscribe();
  }
});

await check("recordChatgptSessionExpired for an unknown profileId is a no-op", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "noop@example.com", planType: "plus", backend: "memory" });

  const before = await profile.loadProfile();
  await profile.recordChatgptSessionExpired("ocic-test-not-this-profile");
  const after = await profile.loadProfile();
  assert(after.chatgptSessionState === "signed_in", `an unrelated profileId must not expire this profile, got ${after.chatgptSessionState}`);
  assert(after.credentialRevision === before.credentialRevision, "and must not bump its revision");
});

await check("snapshotForRun fails with NO_CREDENTIAL and a sign-in message for a chatgpt profile (gateway lands in a later batch)", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "gpt-5.5", label: "gpt-5.5" }], defaultModelId: "gpt-5.5" });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  let code = null;
  let message = "";
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "gpt-5.5");
  } catch (err) {
    code = err.code;
    message = err.message;
  }
  assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL, got ${code}`);
  assert(/sign.?in/i.test(message), `expected a sign-in message, got: ${message}`);
});

await check("testCapability fails with NO_CREDENTIAL and a sign-in message for a chatgpt profile (gateway lands in a later batch)", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "gpt-5.5", label: "gpt-5.5" }], defaultModelId: "gpt-5.5" });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  let code = null;
  let message = "";
  try {
    await profile.testCapability(TEST_PROFILE_ID, "gpt-5.5");
  } catch (err) {
    code = err.code;
    message = err.message;
  }
  assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL, got ${code}`);
  assert(/sign.?in/i.test(message), `expected a sign-in message, got: ${message}`);
});

await check("snapshotForRun and testCapability refuse an unrecognized providerType with INVALID_PROFILE, never a crash", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "claude-a", label: "A" }], defaultModelId: "claude-a" });
  const stored = readProfileFromDisk();
  writeProfileToDisk({ ...stored, providerType: "some-future-provider" });

  let snapshotCode = null;
  try {
    await profile.snapshotForRun(TEST_PROFILE_ID, "claude-a");
  } catch (err) {
    snapshotCode = err.code;
  }
  assert(snapshotCode === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${snapshotCode}`);

  let testCode = null;
  try {
    await profile.testCapability(TEST_PROFILE_ID, "claude-a");
  } catch (err) {
    testCode = err.code;
  }
  assert(testCode === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${testCode}`);

  assert(!(await profile.isRunnable(TEST_PROFILE_ID, "claude-a")), "an unrecognized provider type must never be runnable");
});

await check("refreshDiscoveredModels reports unsupported for a chatgpt profile without requiring a credential", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  // No credential of any kind was ever stored for this profile — discovery
  // must still answer "unsupported" rather than throwing NO_CREDENTIAL.
  const result = await profile.refreshDiscoveredModels(TEST_PROFILE_ID);
  assert(result.supported === false, JSON.stringify(result));
  assert(typeof result.reason === "string" && result.reason.length > 0, JSON.stringify(result));
});

await check("isRunnable for a chatgpt profile keys its capability-test lookup on the chatgpt:codex marker, not the baseUrl", async () => {
  useScratchConfigDir();
  await profile.saveProfile({ profileId: TEST_PROFILE_ID, baseUrl: "https://api.anthropic.com", models: [{ id: "gpt-5.5", label: "gpt-5.5" }], defaultModelId: "gpt-5.5" });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");

  // Not runnable before any recorded result.
  assert(!(await profile.isRunnable(TEST_PROFILE_ID, "gpt-5.5")), "must not be runnable before any capability test");

  // Simulate a recorded PASS the way a chatgpt-aware testCapability() will
  // (a later batch) — keyed by the fixed marker, not profile.baseUrl.
  const stored = readProfileFromDisk();
  const key = capabilityTestKey({ baseUrl: "chatgpt:codex", modelId: "gpt-5.5", credentialRevision: stored.credentialRevision || 0 });
  writeProfileToDisk({ ...stored, lastCapabilityTest: { [key]: { status: "pass" } } });
  assert(await profile.isRunnable(TEST_PROFILE_ID, "gpt-5.5"), "expected runnable once a pass is recorded under the chatgpt:codex marker key");

  // A result recorded under the real baseUrl (the anthropic key shape) must
  // never make a chatgpt profile look runnable.
  const wrongKey = capabilityTestKey({ baseUrl: stored.baseUrl, modelId: "gpt-5.5", credentialRevision: stored.credentialRevision || 0 });
  writeProfileToDisk({ ...stored, lastCapabilityTest: { [wrongKey]: { status: "pass" } } });
  assert(!(await profile.isRunnable(TEST_PROFILE_ID, "gpt-5.5")), "a result keyed by the real baseUrl must not count for a chatgpt profile");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;

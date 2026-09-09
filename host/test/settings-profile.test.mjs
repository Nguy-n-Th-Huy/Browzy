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

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;

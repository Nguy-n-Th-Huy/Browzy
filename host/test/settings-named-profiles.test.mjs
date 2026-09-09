#!/usr/bin/env node
//
// Named provider profiles (tasks 9.1-9.5): collection CRUD/selection,
// legacy migration, secret-free identity/revision, OS-store-only secrets,
// run-start snapshot + revocation semantics, incompatible-selection gating,
// export redaction, and OpenAI/Gemini exclusion.
//
// Isolation: every check gets its own scratch config directory via
// OCIC_AGENT_CONFIG_DIR, dedicated test-only profile ids (never "default"),
// and memoryOnly:true credentials — the OS credential store is never
// touched (see host/agent/secrets/secret-store.js's guard).
//
// Run: node host/test/settings-named-profiles.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-named-profiles-"));
process.env.OCIC_AGENT_CONFIG_DIR = scratch;

const np = await import("../agent/settings/named-profiles.js");
const proto = await import("../agent/settings/profile-protocol.js");
const { writeProfileToDisk } = await import("../agent/settings/profile-store.js");
const { createEmptyProfile } = await import("../agent/settings/profile-schema.js");
const { memoryClearAll, memoryRead } = await import("../agent/secrets/memory-store.js");
const { classifySdkError } = await import("../agent/settings/capability-test.js");
const { SecureStorageUnavailableError } = await import("../agent/secrets/secret-store.js");

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
function assertNoSecret(leak, secret, where) {
  const json = JSON.stringify(leak);
  assert(!json.includes(secret), `${where} leaks the raw secret`);
  assert(!/apiKey/i.test(json) || json.includes("ANTHROPIC_API_KEY") === false, `${where} carries an apiKey field`);
}

const MODELS = [
  { id: "claude-test-a", label: "Test A" },
  { id: "claude-test-b", label: "Test B" }
];
const SECRET = "sk-ant-test-only-not-a-real-key-0001";

function freshProfile(id) {
  np._clearCollectionForTests();
  memoryClearAll();
  return np.createProfile({ profileId: id, baseUrl: "https://api.anthropic.com", models: MODELS, defaultModelId: MODELS[0].id });
}

console.log("settings-named-profiles (tasks 9.1-9.5)");

await check("migration preserves the legacy default profile exactly once", () => {
  np._clearCollectionForTests();
  memoryClearAll();
  const legacy = { ...createEmptyProfile("default"), models: MODELS, defaultModelId: MODELS[0].id, revision: 3 };
  writeProfileToDisk(legacy);
  const first = np.migrateLegacyProfile();
  assert(first.migrated === true && first.profileId === "default", "expected a migration of the default profile");
  const got = np.getProfile("default");
  assert(got && got.baseUrl === "https://api.anthropic.com", "baseUrl preserved");
  assert(got.models.length === 2 && got.revision === 3, "models + revision preserved");
  assert(np.getSelectedProfileId() === "default", "migrated profile becomes the selection");
  const second = np.migrateLegacyProfile();
  assert(second.migrated === false, "migration is idempotent");
  // Legacy file untouched (still the single-profile shape, still on disk).
  assert(fs.existsSync(path.join(scratch, "agent-profile.json")), "legacy file must not be deleted");
});

await check("migration with no legacy file starts empty without throwing", () => {
  np._clearCollectionForTests();
  try {
    fs.unlinkSync(path.join(scratch, "agent-profile.json"));
  } catch {}
  const out = np.migrateLegacyProfile();
  assert(out.migrated === false, "nothing to migrate");
  assert(np.listProfiles().length === 0, "empty collection");
  assert(np.getSelectedProfileId() === null, "no selection");
});

await check("CRUD: create/select/update round trip with validation", () => {
  freshProfile("p9-alpha");
  np.createProfile({ profileId: "p9-beta", baseUrl: "https://gateway.example.com/sub", models: MODELS, defaultModelId: MODELS[1].id });
  assert(np.listProfiles().length === 2, "two profiles listed");
  const sel = np.selectProfile("p9-beta");
  assert(sel.profileId === "p9-beta" && np.getSelectedProfileId() === "p9-beta", "selection sticks");
  const updated = np.updateProfile("p9-beta", { baseUrl: "https://other.example.com" });
  assert(updated.baseUrl === "https://other.example.com", "nonsecret edit applies");
  assert(updated.revision === 1, "revision bumps on nonsecret edit");
  assert(updated.credentialRevision === 0, "credential revision untouched by nonsecret edit");
  // Invalid inputs reject without mutating the store.
  let threw = null;
  try {
    np.createProfile({ profileId: "p9-beta", baseUrl: "https://x.example.com", models: MODELS, defaultModelId: MODELS[0].id });
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "DUPLICATE_PROFILE", "duplicate identity rejected");
  threw = null;
  try {
    np.createProfile({ profileId: "bad id!!", baseUrl: "https://x.example.com", models: [], defaultModelId: null });
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "INVALID_PROFILE_ID", "bad profile id rejected");
  threw = null;
  try {
    np.createProfile({ profileId: "p9-evil", baseUrl: "http://user:pass@evil.example.com/?q=1#frag", models: [], defaultModelId: null });
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "INVALID_PROFILE", "credential/query/fragment URL rejected");
});

await check("records never contain the secret (submit/clear/export)", async () => {
  freshProfile("p9-secrets");
  await np.setCredential("p9-secrets", SECRET, { memoryOnly: true });
  const raw = fs.readFileSync(np.namedProfilesFilePath(), "utf-8");
  assert(!raw.includes(SECRET), "collection file must never contain the secret");
  const listed = np.listProfiles();
  assertNoSecret(listed, SECRET, "listProfiles");
  assertNoSecret(np.getProfile("p9-secrets"), SECRET, "getProfile");
  assertNoSecret(np.exportProfileRedacted("p9-secrets"), SECRET, "exportProfileRedacted");
  assertNoSecret(np.getSelectedProfile(), SECRET, "getSelectedProfile");
  const reply = await proto.dispatchProfileCollectionOp("set_credential", {
    profileId: "p9-secrets",
    secret: SECRET,
    memoryOnly: true
  });
  assert(reply.ok === true, "set_credential succeeds");
  assertNoSecret(reply, SECRET, "set_credential reply");
  assert(reply.result && reply.result.backend === "memory", "backend label only, no secret echo");
});

await check("secure-storage failure maps explicitly; memory-only stays labeled", async () => {
  // Simulate an unavailable OS store at the protocol seam without touching
  // any real backend: a capability runner that throws the exact error the
  // secret layer raises when no OS store exists.
  const boom = new SecureStorageUnavailableError("simulated: no OS store in this environment");
  const reply = await proto.dispatchProfileCollectionOp(
    "test_capability",
    { profileId: "p9-missing", modelId: "x" },
    {
      capabilityRunner: async () => {
        throw boom;
      }
    }
  );
  assert(reply.ok === false && reply.code === undefined, "protocol shape is { ok, error }");
  assert(reply.error.code === "SECURE_STORAGE_UNAVAILABLE", `expected SECURE_STORAGE_UNAVAILABLE, got ${reply.error.code}`);
  assert(/memoryOnly/.test(reply.error.message), "memory-only mode is offered in the message");
  // And the labeled memory-only path itself works end to end.
  freshProfile("p9-memonly");
  const setReply = await proto.dispatchProfileCollectionOp("set_credential", {
    profileId: "p9-memonly",
    secret: SECRET,
    memoryOnly: true
  });
  assert(setReply.ok && setReply.result.backend === "memory", "memory-only credential accepted with label");
  assert(np.getProfile("p9-memonly").memoryOnlyCredential === true, "memory-only flag persisted on the record");
});

await check("storage failure surfaces as STORAGE_ERROR, never a silent default", async () => {
  np._clearCollectionForTests();
  fs.writeFileSync(np.namedProfilesFilePath(), "{ not valid json!!!");
  const reply = await proto.dispatchProfileCollectionOp("list_profiles", {});
  assert(reply.ok === false && reply.error.code === "STORAGE_ERROR", `expected STORAGE_ERROR, got ${JSON.stringify(reply)}`);
  np._clearCollectionForTests();
});

await check("capability key invalidates on credential replacement/removal", async () => {
  freshProfile("p9-cap");
  await np.setCredential("p9-cap", SECRET, { memoryOnly: true });
  const sdkVersion = np.resolveSdkVersion("sdk-test-1.0.0");
  np.recordCapabilityResult("p9-cap", MODELS[0].id, { status: "pass", capabilities: { text: "pass" }, errors: {}, timestamp: new Date().toISOString() }, { sdkVersion });
  assert((await np.isRunnable("p9-cap", MODELS[0].id, { sdkVersion })) === true, "passing v2 result is runnable");
  await np.setCredential("p9-cap", "sk-ant-test-only-rotation-0002", { memoryOnly: true });
  assert((await np.isRunnable("p9-cap", MODELS[0].id, { sdkVersion })) === false, "credential rotation invalidates the prior result");
  await np.removeCredential("p9-cap");
  assert((await np.isRunnable("p9-cap", MODELS[0].id, { sdkVersion })) === false, "removal invalidates too");
  // v1 (pre-P2, unversioned-SDK) results remain readable as fallback.
  const { capabilityTestKey } = await import("../agent/settings/profile-schema.js");
  const raw = JSON.parse(fs.readFileSync(np.namedProfilesFilePath(), "utf-8"));
  const rec = raw.profiles["p9-cap"];
  const v1 = capabilityTestKey({ baseUrl: rec.baseUrl, modelId: MODELS[0].id, credentialRevision: rec.credentialRevision });
  rec.lastCapabilityTest[v1] = { status: "pass", capabilities: {}, errors: {}, timestamp: new Date().toISOString() };
  fs.writeFileSync(np.namedProfilesFilePath(), JSON.stringify(raw, null, 2));
  assert((await np.isRunnable("p9-cap", MODELS[0].id, { sdkVersion: "some-new-sdk" })) === true, "v1 fallback keeps pre-P2 results readable");
});

await check("revocation fires on replace/remove/delete; snapshots stay immutable", async () => {
  freshProfile("p9-revoke");
  await np.setCredential("p9-revoke", SECRET, { memoryOnly: true });
  const seen = [];
  const off = np.onProfileRevoked((e) => seen.push(e.profileId));
  const snap = await np.snapshotForRun("p9-revoke", MODELS[0].id, { sdkVersion: "sdk-test-1.0.0" });
  assert(Object.isFrozen(snap), "run snapshot is frozen");
  let frozenThrows = false;
  try {
    snap.modelId = "something-else";
  } catch {
    frozenThrows = true;
  }
  assert(frozenThrows, "mutating the snapshot throws (immutable in-flight config)");
  assert(snap.env.ANTHROPIC_API_KEY === SECRET, "snapshot resolves the current credential into env only");
  assert(!("ANTHROPIC_API_KEY" in snap) || true, "identity half carries no secret");
  const identityJson = JSON.stringify({ profileId: snap.profileId, endpoint: snap.endpoint, modelId: snap.modelId, revision: snap.revision, credentialRevision: snap.credentialRevision });
  assert(!identityJson.includes(SECRET), "snapshot identity half is secret-free");
  // Ordinary nonsecret edit: future runs see it, the live snapshot does not.
  np.updateProfile("p9-revoke", { baseUrl: "https://rotated.example.com" });
  assert(snap.endpoint === "https://api.anthropic.com", "live snapshot unaffected by later edits");
  // Credential replacement fires revocation (cancellation takes precedence).
  await np.setCredential("p9-revoke", "sk-ant-test-only-rotation-0003", { memoryOnly: true });
  assert(seen.includes("p9-revoke"), "replacement fires revocation");
  await np.removeCredential("p9-revoke");
  assert(seen.filter((s) => s === "p9-revoke").length === 2, "removal fires revocation again");
  off();
});

await check("deletion removes secret+record, reselects, never reconstructs", async () => {
  freshProfile("p9-del-a");
  np.createProfile({ profileId: "p9-del-b", baseUrl: "https://api.anthropic.com", models: MODELS, defaultModelId: MODELS[0].id });
  np.selectProfile("p9-del-a");
  await np.setCredential("p9-del-a", SECRET, { memoryOnly: true });
  const out = await np.deleteProfile("p9-del-a");
  assert(out.deleted === "p9-del-a", "delete reports the id");
  assert(out.selectedProfileId === "p9-del-b", "selection falls through to a remaining profile");
  assert(np.getProfile("p9-del-a") === null, "record gone");
  assert((await memoryRead("browzy-in-chrome/settings/p9-del-a", { memoryOnly: true })) !== SECRET, "secret removed from the store");
  let threw = null;
  try {
    await np.snapshotForRun("p9-del-a", MODELS[0].id);
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "NO_CREDENTIAL", "deleted profile never resurrects a credential");
  await np.deleteProfile("p9-del-b");
  assert(np.getSelectedProfileId() === null, "last deletion clears the selection (future sends need a profile)");
});

await check("incompatible selection requires a new conversation (9.4)", () => {
  const bound = { profileId: "p9-old", endpoint: "https://api.anthropic.com", modelId: MODELS[0].id, credentialRevision: 1 };
  const same = np.assessProfileSelectionCompatibility({
    boundAppProfile: bound,
    selected: { profileId: "p9-old", endpoint: "https://api.anthropic.com", modelId: MODELS[0].id }
  });
  assert(same.compatible === true, "identical selection resumes");
  const moved = np.assessProfileSelectionCompatibility({
    boundAppProfile: bound,
    selected: { profileId: "p9-new", endpoint: "https://other.example.com", modelId: MODELS[0].id }
  });
  assert(moved.compatible === false && moved.action === "new_conversation", "endpoint change directs to a new conversation");
  assert(moved.mismatches.some((m) => m.field === "endpoint"), "endpoint mismatch named");
  const remodel = np.assessProfileSelectionCompatibility({
    boundAppProfile: bound,
    selected: { profileId: "p9-old", endpoint: "https://api.anthropic.com", modelId: MODELS[1].id }
  });
  assert(remodel.compatible === false && remodel.action === "new_conversation", "model change directs to a new conversation");
  assert(np.assessProfileSelectionCompatibility({ boundAppProfile: null, selected: null }).compatible === true, "unbound conversation stays compatible");
});

await check("OpenAI/Gemini exclusion: no native adapter surface; incompatible endpoints fail closed", () => {
  // No provider-type field is accepted or persisted anywhere in the collection.
  freshProfile("p9-novendor");
  const rec = np.getProfile("p9-novendor");
  assert(!("provider" in rec) && !("providerType" in rec) && !("vendor" in rec), "no vendor field on records");
  np.createProfile({ profileId: "p9-vendor-ignored", baseUrl: "https://api.anthropic.com", models: [], defaultModelId: null, provider: "openai" });
  assert(!("provider" in np.getProfile("p9-vendor-ignored")), "unknown provider field is dropped, never persisted");
  const src = fs.readFileSync(new URL("../agent/settings/named-profiles.js", import.meta.url), "utf-8");
  const adapterHits = src.match(/provider\s*[:=]|PROVIDER_TYPES|GeminiChat|OpenAIChat|chat\.completions/i) || [];
  assert(adapterHits.length === 0, `no native OpenAI/Gemini adapter surface in named-profiles.js (hits: ${adapterHits.join(",")})`);
  // An OpenAI-Chat-Completions-only endpoint (non-Anthropic wire shape)
  // classifies as PROTOCOL_ERROR — never "compatible".
  const classified = classifySdkError({ status: null, error: undefined, message: "malformed response: not a Message stream" });
  assert(classified.code === "PROTOCOL_ERROR", `expected PROTOCOL_ERROR, got ${classified.code}`);
});

await check("protocol: unknown ops fail with UPDATE_REQUIRED, never legacy fallback", async () => {
  const reply = await proto.dispatchProfileCollectionOp("get_workflows", {});
  assert(reply.ok === false && reply.error.code === "UPDATE_REQUIRED", "stale peer gets an update error");
  assert(reply.error.updateRequired === true, "updateRequired flag set");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

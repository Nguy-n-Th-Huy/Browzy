// Named provider-profile collection (P2 provider profiles, tasks 9.1-9.5).
//
// Generalizes the single default profile (profile-schema.js / profile.js)
// into a named collection of Anthropic-compatible profiles while preserving
// the single record through a one-time migration. Design decision 7:
//
//   - Named profiles over the existing backend: every per-profile record
//     keeps the exact secret-free shape profile-schema.js already persists
//     (profileId, baseUrl, models, defaultModelId, revision,
//     credentialRevision, hasCredential, memoryOnlyCredential,
//     secretBackend, lastCapabilityTest). Secrets stay in the existing OS
//     store keyed by profile id (`browzy-in-chrome/settings/<profileId>` —
//     the same target convention profile.js uses), never in these records.
//   - Secret-free identity + credential revision: conversation metadata
//     carries only profileId/endpoint/modelId/credentialRevision (see
//     snapshotProfileForRun() below); it never reconstructs a deleted
//     historical credential.
//   - Run-start snapshot: selection sends only profile id/model id; the
//     companion resolves the current credential and freezes an immutable
//     snapshot for the run. Ordinary nonsecret edits affect future runs;
//     credential replacement/removal/revocation invalidates capability
//     results and cancels affected active runs (via onProfileRevoked — the
//     session-manager wiring that consumes this event lives in dirty,
//     out-of-scope files; see the residual note at the bottom).
//   - Capability keyed by endpoint/model/revision/SDK: capabilityTestKeyV2()
//     extends profile-schema.js's key with the SDK version; v1 keys remain
//     readable as a fallback so migration does not orphan prior results.
//
// What this module does NOT do (explicit non-goals, spec agent-settings):
// native OpenAI/Gemini adapters. There is no provider-type field anywhere
// in this file; every profile is Anthropic-compatible by construction and
// capability-test failures with PROTOCOL_ERROR are how
// OpenAI-Chat-Completions-only endpoints are reported (see
// capability-test.js classifySdkError). A test in
// host/test/settings-named-profiles.test.mjs asserts no OpenAI/Gemini
// provider surface exists here.
//
// Storage: one JSON document `agent-profiles.json` beside the legacy
// `agent-profile.json` (paths.js configDir()), written atomically through
// atomic-store.js. The legacy single-profile file is NEVER modified here —
// migration reads it once and copies the record into the collection.
//
// RESIDUAL (dirty-file wiring, out of scope for this session):
// protocol.js / extension/background.js must route the collection ops
// (see profile-protocol.js dispatchProfileCollectionOp) and the session
// manager must subscribe onProfileRevoked() to cancel affected active runs
// and gate resume through assessProfileSelectionCompatibility(). Until then
// this module is fully functional host-side and covered by structural tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { writeJsonAtomic, readJsonAtomic, cleanupStaleTempFiles } from "./atomic-store.js";
import { ensureConfigDir, configDir, profileFilePath } from "./paths.js";
import {
  PROFILE_SCHEMA_VERSION,
  DEFAULT_PROFILE_ID,
  createEmptyProfile,
  isPlausibleProfile,
  capabilityTestKey
} from "./profile-schema.js";
import { normalizeBaseUrl } from "./url.js";
import { validateModels } from "./models.js";
import { runCapabilityTest } from "./capability-test.js";
import { discoverModels } from "./discovery.js";
import {
  storeSecret,
  readSecret,
  deleteSecret,
  SecureStorageUnavailableError
} from "../secrets/secret-store.js";
import { redactSecretsDeep } from "../secrets/redact.js";
import { ProviderError } from "./errors.js";

export { SecureStorageUnavailableError };

export const NAMED_PROFILES_COLLECTION_VERSION = 1;

/** Collection file: beside the legacy single-profile file, never replacing it. */
export function namedProfilesFilePath() {
  return path.join(configDir(), "agent-profiles.json");
}

export class NamedProfileError extends Error {
  // codes: INVALID_PROFILE_ID, DUPLICATE_PROFILE, PROFILE_NOT_FOUND,
  // INVALID_PROFILE, NO_CREDENTIAL, STORAGE_ERROR, NO_SELECTION
  constructor(code, message, details) {
    super(message);
    this.name = "NamedProfileError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a profile id: filesystem/OS-store safe segment, never empty,
 * never a traversal. Mirrors skills/paths.js assertSafeSegment (same
 * rationale, independent copy — this module must not depend on another
 * work stream's paths module).
 * @throws {NamedProfileError} INVALID_PROFILE_ID
 */
export function validateProfileId(profileId) {
  if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new NamedProfileError(
      "INVALID_PROFILE_ID",
      `profile id must be 1-64 letters, digits, "_" or "-" (got ${JSON.stringify(profileId)})`
    );
  }
  return profileId;
}

function credentialTarget(profileId) {
  return `browzy-in-chrome/settings/${profileId}`;
}

function blankCollection() {
  return {
    schemaVersion: NAMED_PROFILES_COLLECTION_VERSION,
    selectedProfileId: null,
    profiles: {},
    migratedFromLegacy: false
  };
}

function isPlausibleCollection(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.selectedProfileId !== "undefined" &&
      value.profiles &&
      typeof value.profiles === "object" &&
      !Array.isArray(value.profiles)
  );
}

function readCollection() {
  ensureConfigDir();
  const filePath = namedProfilesFilePath();
  cleanupStaleTempFiles(filePath);
  let loaded;
  try {
    loaded = readJsonAtomic(filePath);
  } catch (err) {
    throw new NamedProfileError("STORAGE_ERROR", `profile collection at ${filePath} is not valid JSON: ${err.message}`);
  }
  if (loaded === null) return null;
  if (!isPlausibleCollection(loaded)) {
    throw new NamedProfileError("STORAGE_ERROR", `profile collection at ${filePath} is not a well-formed collection object`);
  }
  if (loaded.schemaVersion > NAMED_PROFILES_COLLECTION_VERSION) {
    throw new NamedProfileError(
      "STORAGE_ERROR",
      `profile collection at ${filePath} was written by a newer schema version (${loaded.schemaVersion} > ${NAMED_PROFILES_COLLECTION_VERSION})`
    );
  }
  return loaded;
}

function writeCollection(collection) {
  try {
    writeJsonAtomic(namedProfilesFilePath(), collection);
  } catch (err) {
    throw new NamedProfileError("STORAGE_ERROR", `failed to persist the profile collection: ${err.message}`);
  }
}

/** Secret-free public view of one record (what list/get/selection expose). */
function publicProfile(record) {
  return {
    profileId: record.profileId,
    baseUrl: record.baseUrl,
    models: record.models.map((m) => ({ ...m })),
    defaultModelId: record.defaultModelId,
    revision: record.revision,
    credentialRevision: record.credentialRevision || 0,
    hasCredential: Boolean(record.hasCredential),
    memoryOnlyCredential: Boolean(record.memoryOnlyCredential),
    secretBackend: record.secretBackend || null,
    lastCapabilityTest: record.lastCapabilityTest || {},
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null
  };
}

/**
 * One-time migration of the legacy single profile (agent-profile.json)
 * into the collection. Idempotent: when the collection file already exists
 * this is a no-op returning { migrated: false }. Never modifies or deletes
 * the legacy file.
 * @returns {{ migrated: boolean, profileId?: string }}
 */
export function migrateLegacyProfile() {
  if (readCollection() !== null) return { migrated: false };
  let legacy = null;
  try {
    const raw = readJsonAtomic(profileFilePath());
    if (raw !== null && isPlausibleProfile(raw)) legacy = raw;
  } catch {
    legacy = null; // corrupt legacy file: start empty, never crash migration
  }
  const collection = blankCollection();
  if (legacy) {
    const now = new Date().toISOString();
    const profileId =
      typeof legacy.profileId === "string" && PROFILE_ID_PATTERN.test(legacy.profileId)
        ? legacy.profileId
        : DEFAULT_PROFILE_ID;
    collection.profiles[profileId] = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profileId,
      baseUrl: legacy.baseUrl,
      models: Array.isArray(legacy.models) ? legacy.models : [],
      defaultModelId: legacy.defaultModelId ?? null,
      revision: typeof legacy.revision === "number" ? legacy.revision : 0,
      credentialRevision: legacy.credentialRevision || 0,
      hasCredential: Boolean(legacy.hasCredential),
      memoryOnlyCredential: Boolean(legacy.memoryOnlyCredential),
      secretBackend: legacy.secretBackend || null,
      lastCapabilityTest: legacy.lastCapabilityTest || {},
      createdAt: now,
      updatedAt: now
    };
    collection.selectedProfileId = profileId;
    collection.migratedFromLegacy = true;
    writeCollection(collection);
    return { migrated: true, profileId };
  }
  collection.selectedProfileId = null;
  writeCollection(collection);
  return { migrated: false };
}

function requireCollection() {
  const collection = readCollection();
  if (!collection) {
    // No collection yet and no legacy file: behave as an empty store rather
    // than forcing every caller to migrate first. migrateLegacyProfile()
    // remains the explicit entry point tests and first-run setup call.
    const empty = blankCollection();
    writeCollection(empty);
    return empty;
  }
  return collection;
}

/** @returns {Array<object>} secret-free summaries, selected profile first. */
export function listProfiles() {
  const collection = requireCollection();
  const all = Object.values(collection.profiles).map(publicProfile);
  all.sort((a, b) => {
    if (a.profileId === collection.selectedProfileId) return -1;
    if (b.profileId === collection.selectedProfileId) return 1;
    return a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0;
  });
  return all;
}

/** @returns {object|null} secret-free record or null. */
export function getProfile(profileId) {
  validateProfileId(profileId);
  const collection = requireCollection();
  const record = collection.profiles[profileId];
  return record ? publicProfile(record) : null;
}

/** @returns {string|null} the selected profile id, or null when none. */
export function getSelectedProfileId() {
  return requireCollection().selectedProfileId || null;
}

/** @returns {object|null} secret-free selected record, or null. */
export function getSelectedProfile() {
  const collection = requireCollection();
  const id = collection.selectedProfileId;
  if (!id || !collection.profiles[id]) return null;
  return publicProfile(collection.profiles[id]);
}

/**
 * Create a named profile. Validates and atomically persists fully offline
 * (no network call). Rejects duplicate ids without touching the store.
 * @param {{ profileId: string, baseUrl: string, models?: Array, defaultModelId?: string|null }} input
 */
export function createProfile(input) {
  const { profileId, baseUrl, models = [], defaultModelId = null } = input || {};
  validateProfileId(profileId);
  let normalized;
  let cleanModels;
  let cleanDefault;
  try {
    ({ normalized } = normalizeBaseUrl(baseUrl));
  } catch (err) {
    throw new NamedProfileError("INVALID_PROFILE", err.message, { cause: err.code || "INVALID_BASE_URL" });
  }
  try {
    ({ models: cleanModels, defaultModelId: cleanDefault } = validateModels(models, defaultModelId));
  } catch (err) {
    throw new NamedProfileError("INVALID_PROFILE", err.message, { cause: err.code || "INVALID_MODELS" });
  }
  const collection = requireCollection();
  if (collection.profiles[profileId]) {
    throw new NamedProfileError("DUPLICATE_PROFILE", `a profile named "${profileId}" already exists`);
  }
  const now = new Date().toISOString();
  const record = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId,
    baseUrl: normalized,
    models: cleanModels,
    defaultModelId: cleanDefault,
    revision: 0,
    credentialRevision: 0,
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    lastCapabilityTest: {},
    createdAt: now,
    updatedAt: now
  };
  const next = {
    ...collection,
    profiles: { ...collection.profiles, [profileId]: record },
    // First profile ever created becomes the selection so Send has an owner.
    selectedProfileId: collection.selectedProfileId || profileId
  };
  writeCollection(next);
  return publicProfile(record);
}

/**
 * Ordinary nonsecret edit (baseUrl/models/default). Bumps `revision`
 * (never `credentialRevision`), clears stale capability entries when the
 * endpoint or model list changed, and affects FUTURE runs only — an active
 * run keeps its immutable snapshot (task 9.3). Never cancels active work.
 */
export function updateProfile(profileId, input) {
  validateProfileId(profileId);
  const { baseUrl, models, defaultModelId } = input || {};
  const collection = requireCollection();
  const existing = collection.profiles[profileId];
  if (!existing) throw new NamedProfileError("PROFILE_NOT_FOUND", `no profile named "${profileId}"`);
  let normalized = existing.baseUrl;
  let cleanModels = existing.models;
  let cleanDefault = existing.defaultModelId;
  if (baseUrl !== undefined) {
    try {
      ({ normalized } = normalizeBaseUrl(baseUrl));
    } catch (err) {
      throw new NamedProfileError("INVALID_PROFILE", err.message, { cause: err.code || "INVALID_BASE_URL" });
    }
  }
  if (models !== undefined || defaultModelId !== undefined) {
    try {
      ({ models: cleanModels, defaultModelId: cleanDefault } = validateModels(
        models !== undefined ? models : existing.models,
        defaultModelId !== undefined ? defaultModelId : existing.defaultModelId
      ));
    } catch (err) {
      throw new NamedProfileError("INVALID_PROFILE", err.message, { cause: err.code || "INVALID_MODELS" });
    }
  }
  const endpointOrModelsChanged =
    existing.baseUrl !== normalized ||
    JSON.stringify(existing.models) !== JSON.stringify(cleanModels) ||
    existing.defaultModelId !== cleanDefault;
  const next = {
    ...existing,
    baseUrl: normalized,
    models: cleanModels,
    defaultModelId: cleanDefault,
    revision: existing.revision + 1,
    lastCapabilityTest: endpointOrModelsChanged ? {} : existing.lastCapabilityTest,
    updatedAt: new Date().toISOString()
  };
  writeCollection({ ...collection, profiles: { ...collection.profiles, [profileId]: next } });
  return publicProfile(next);
}

/** Select the profile future runs resolve credentials/snapshots from. */
export function selectProfile(profileId) {
  validateProfileId(profileId);
  const collection = requireCollection();
  if (!collection.profiles[profileId]) {
    throw new NamedProfileError("PROFILE_NOT_FOUND", `no profile named "${profileId}"`);
  }
  writeCollection({ ...collection, selectedProfileId: profileId });
  return publicProfile(collection.profiles[profileId]);
}

const revokedListeners = new Set();

function fireRevoked(profileId) {
  for (const listener of revokedListeners) {
    try {
      listener({ profileId });
    } catch {
      // A listener throwing must never prevent the other listeners (or the
      // caller) from observing the revocation.
    }
  }
}

/** Subscribe to credential replacement/removal (cancels affected active runs). */
export function onProfileRevoked(listener) {
  revokedListeners.add(listener);
  return () => revokedListeners.delete(listener);
}

/** Test-only: drop every registered listener between test cases. */
export function _clearProfileRevokedListenersForTests() {
  revokedListeners.clear();
}

/**
 * Store (or replace) the credential for a profile. Bumps
 * `credentialRevision`, which naturally invalidates prior capability results
 * (they are keyed by revision), and fires revocation so active runs using
 * the previous credential are cancelled — cancellation takes precedence
 * over continuation (task 9.3). Secrets go only to the OS store (or an
 * explicitly labeled memory-only mode), never into the collection file.
 * @throws {SecureStorageUnavailableError} without silent plaintext fallback.
 */
export async function setCredential(profileId, secret, opts = {}) {
  validateProfileId(profileId);
  if (typeof secret !== "string" || !secret.trim()) {
    throw new NamedProfileError("INVALID_PROFILE", "credential must be a nonempty string");
  }
  const collection = requireCollection();
  if (!collection.profiles[profileId]) {
    throw new NamedProfileError("PROFILE_NOT_FOUND", `no profile named "${profileId}"`);
  }
  const { backend } = await storeSecret(credentialTarget(profileId), secret.trim(), opts);
  const existing = collection.profiles[profileId];
  const next = {
    ...existing,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    hasCredential: true,
    memoryOnlyCredential: backend === "memory",
    secretBackend: backend,
    updatedAt: new Date().toISOString()
  };
  writeCollection({ ...collection, profiles: { ...collection.profiles, [profileId]: next } });
  fireRevoked(profileId);
  return { backend };
}

/**
 * Remove the stored credential: deletes the OS secret, bumps
 * `credentialRevision`, clears capability results, fires revocation (active
 * runs using it are cancelled), and clears in-memory copies as far as
 * practical (memory-store delete; caller-held strings are the caller's).
 */
export async function removeCredential(profileId) {
  validateProfileId(profileId);
  const collection = requireCollection();
  const existing = collection.profiles[profileId];
  if (!existing) throw new NamedProfileError("PROFILE_NOT_FOUND", `no profile named "${profileId}"`);
  await deleteSecret(credentialTarget(profileId), {
    memoryOnly: existing.memoryOnlyCredential,
    backend: existing.secretBackend
  });
  const next = {
    ...existing,
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    lastCapabilityTest: {},
    updatedAt: new Date().toISOString()
  };
  writeCollection({ ...collection, profiles: { ...collection.profiles, [profileId]: next } });
  fireRevoked(profileId);
}

/**
 * Delete a profile: removes the OS-stored secret first, then the record.
 * Fires revocation so affected active work is cancelled; active runs keep
 * their immutable snapshot and finish/stop under it, while no new turn may
 * resolve this profile afterwards. If the deleted profile was selected,
 * selection falls through to another remaining profile (or null when none
 * remains) so future sends fail with NO_SELECTION rather than silently
 * using a deleted identity.
 */
export async function deleteProfile(profileId) {
  validateProfileId(profileId);
  const collection = requireCollection();
  const existing = collection.profiles[profileId];
  if (!existing) throw new NamedProfileError("PROFILE_NOT_FOUND", `no profile named "${profileId}"`);
  if (existing.hasCredential) {
    try {
      await deleteSecret(credentialTarget(profileId), {
        memoryOnly: existing.memoryOnlyCredential,
        backend: existing.secretBackend
      });
    } catch {
      // Deletion of the record must not be blocked by an already-absent
      // secret; the record removal below is the authoritative step.
    }
  }
  const profiles = { ...collection.profiles };
  delete profiles[profileId];
  let selectedProfileId = collection.selectedProfileId;
  if (selectedProfileId === profileId) {
    const remaining = Object.keys(profiles).sort();
    selectedProfileId = remaining.length ? remaining[0] : null;
  }
  writeCollection({ ...collection, profiles, selectedProfileId });
  fireRevoked(profileId);
  return { deleted: profileId, selectedProfileId };
}

/**
 * Resolve the installed SDK version for capability-result keying. Best
 * effort: falls back to "unknown" (still a stable, comparable key) when the
 * SDK package metadata is unreadable. `override` exists so tests never touch
 * the real node_modules.
 */
export function resolveSdkVersion(override) {
  if (typeof override === "string" && override) return override;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json");
    if (pkg && typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // fall through to unknown — keying must never crash for lack of metadata
  }
  return "unknown";
}

/**
 * Capability-test key: endpoint + model + credential revision + SDK version
 * (task 9.1). Extends profile-schema.js's v1 key; v1 keys remain readable
 * via lookupCapabilityResult() so pre-P2 results are not orphaned.
 */
export function capabilityTestKeyV2({ baseUrl, modelId, credentialRevision, sdkVersion }) {
  return `${baseUrl} ${modelId} ${credentialRevision} ${sdkVersion || "unknown"}`;
}

/**
 * Look up the capability result for the exact current triple, preferring a
 * v2 (SDK-versioned) entry and falling back to a v1 entry. Returns null
 * when no entry applies — a stale/failed/missing result is never presented
 * as current.
 */
export function lookupCapabilityResult(record, { modelId, sdkVersion } = {}) {
  const table = (record && record.lastCapabilityTest) || {};
  const keys = Object.keys(table);
  if (!keys.length) return null;
  const baseUrl = record.baseUrl;
  const credentialRevision = record.credentialRevision || 0;
  const v2 = capabilityTestKeyV2({ baseUrl, modelId, credentialRevision, sdkVersion });
  if (table[v2]) return { key: v2, entry: table[v2], version: 2 };
  const v1 = capabilityTestKey({ baseUrl, modelId, credentialRevision });
  if (table[v1]) return { key: v1, entry: table[v1], version: 1 };
  return null;
}

async function readRecordOrThrow(profileId) {
  validateProfileId(profileId);
  const collection = requireCollection();
  const record = collection.profiles[profileId];
  if (!record) throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  return { collection, record };
}

/**
 * Snapshot a profile into the isolated model/env values a run needs — the
 * run-start snapshot (task 9.3). The returned object is frozen: an active
 * run's configuration is immutable for its lifetime. `env` REPLACES the
 * ambient environment; callers must never spread process.env over it. The
 * secret itself appears only in `env` (for SDK transport), never in the
 * identity half a resume check may compare.
 *
 * Never reconstructs a deleted historical credential: when the OS store no
 * longer has the secret, this throws NO_CREDENTIAL instead of inventing one.
 */
export async function snapshotForRun(profileId, modelId, opts = {}) {
  const { collection, record } = await readRecordOrThrow(profileId);
  const model = modelId || record.defaultModelId;
  if (!model) {
    throw new ProviderError("NO_CREDENTIAL", "no model was requested and the profile has no default model");
  }
  if (!record.models.some((entry) => entry.id === model)) {
    throw new ProviderError("INVALID_PROFILE", `model "${model}" is not in the profile's model list`);
  }
  const apiKey = await readSecret(credentialTarget(profileId), {
    memoryOnly: record.memoryOnlyCredential,
    backend: record.secretBackend
  });
  if (!apiKey) {
    throw new ProviderError(
      "NO_CREDENTIAL",
      `no credential is available for profile "${profileId}" — enter an API key before running`
    );
  }
  const sdkVersion = resolveSdkVersion(opts.sdkVersion);
  const identity = {
    profileId,
    endpoint: record.baseUrl,
    modelId: model,
    revision: record.revision,
    credentialRevision: record.credentialRevision || 0,
    sdkVersion,
    capabilityKey: capabilityTestKeyV2({
      baseUrl: record.baseUrl,
      modelId: model,
      credentialRevision: record.credentialRevision || 0,
      sdkVersion
    }),
    capabilityStanding: capabilityStandingFor(record, model, sdkVersion)
  };
  return Object.freeze({
    ...Object.freeze(identity),
    model,
    env: Object.freeze({
      ANTHROPIC_BASE_URL: record.baseUrl,
      ANTHROPIC_API_KEY: apiKey
    })
  });
}

function capabilityStandingFor(record, modelId, sdkVersion) {
  const found = lookupCapabilityResult(record, { modelId, sdkVersion });
  if (!found) return { state: "untested" };
  if (found.entry && found.entry.status === "pass") return { state: "pass", keyVersion: found.version };
  return {
    state: "fail",
    keyVersion: found.version,
    capabilities: (found.entry && found.entry.capabilities) || {},
    errors: (found.entry && found.entry.errors) || {}
  };
}

/**
 * Assess whether selecting `selected` (a public profile + model id) may
 * resume a conversation bound to `boundAppProfile`
 * ({ profileId, endpoint, modelId, ... }), mirroring
 * storage/conversation-metadata.js assessResumeCompatibility's field
 * selection for the profile half (endpoint + model identity). An
 * incompatible selection must NOT resume — the caller directs the user to a
 * new conversation (task 9.4) and never reconstructs an unavailable old
 * credential to force compatibility.
 *
 * @param {{ boundAppProfile: object|null, selected: { profileId: string, endpoint: string, modelId: string } }} args
 * @returns {{ compatible: true } | { compatible: false, mismatches: Array, action: "new_conversation" }}
 */
export function assessProfileSelectionCompatibility({ boundAppProfile, selected }) {
  if (!boundAppProfile) return { compatible: true };
  const mismatches = [];
  if ((boundAppProfile.endpoint ?? null) !== ((selected && selected.endpoint) ?? null)) {
    mismatches.push({
      field: "endpoint",
      bound: boundAppProfile.endpoint ?? null,
      current: (selected && selected.endpoint) ?? null
    });
  }
  if ((boundAppProfile.modelId ?? null) !== ((selected && selected.modelId) ?? null)) {
    mismatches.push({
      field: "modelId",
      bound: boundAppProfile.modelId ?? null,
      current: (selected && selected.modelId) ?? null
    });
  }
  if (!mismatches.length) return { compatible: true };
  return { compatible: false, mismatches, action: "new_conversation" };
}

/**
 * Record a capability-test result under the v2 key (used by testCapability()
 * after a live run; exported so tests and future sync paths can record
 * without network exercise).
 */
export function recordCapabilityResult(profileId, modelId, result, opts = {}) {
  validateProfileId(profileId);
  const collection = requireCollection();
  const record = collection.profiles[profileId];
  if (!record) throw new NamedProfileError("PROFILE_NOT_FOUND", `no profile named "${profileId}"`);
  const sdkVersion = resolveSdkVersion(opts.sdkVersion);
  const key = capabilityTestKeyV2({
    baseUrl: record.baseUrl,
    modelId,
    credentialRevision: record.credentialRevision || 0,
    sdkVersion
  });
  const next = {
    ...record,
    lastCapabilityTest: { ...(record.lastCapabilityTest || {}), [key]: result },
    updatedAt: new Date().toISOString()
  };
  writeCollection({ ...collection, profiles: { ...collection.profiles, [profileId]: next } });
  return { key, sdkVersion };
}

/**
 * Run the bounded synthetic capability test for the profile's model and
 * record the result under the v2 key. Real SDK transport (same as
 * profile.js testCapability); network exercise is the caller's choice.
 */
export async function testCapability(profileId, modelId, opts = {}) {
  const { collection, record } = await readRecordOrThrow(profileId);
  const apiKey = await readSecret(credentialTarget(profileId), {
    memoryOnly: record.memoryOnlyCredential,
    backend: record.secretBackend
  });
  if (!apiKey) {
    throw new ProviderError("NO_CREDENTIAL", "the capability test requires a saved credential");
  }
  const sdk = opts.sdk || (await import("@anthropic-ai/claude-agent-sdk"));
  const z = opts.z || (await import("zod")).default || (await import("zod"));
  const result = await runCapabilityTest({
    baseUrl: record.baseUrl,
    apiKey,
    modelId,
    sdk,
    z,
    ...(opts.startupBudgetMs ? { startupBudgetMs: opts.startupBudgetMs } : {}),
    ...(opts.testBudgetMs ? { testBudgetMs: opts.testBudgetMs } : {}),
    ...(opts.onMessage ? { onMessage: opts.onMessage } : {})
  });
  const sdkVersion = resolveSdkVersion(opts.sdkVersion);
  const key = capabilityTestKeyV2({
    baseUrl: record.baseUrl,
    modelId,
    credentialRevision: record.credentialRevision || 0,
    sdkVersion
  });
  const next = {
    ...record,
    lastCapabilityTest: { ...(record.lastCapabilityTest || {}), [key]: result },
    updatedAt: new Date().toISOString()
  };
  writeCollection({ ...collection, profiles: { ...collection.profiles, [profileId]: next } });
  return result;
}

/** True only if the most recent test for the exact current triple passed. */
export async function isRunnable(profileId, modelId, opts = {}) {
  const { record } = await readRecordOrThrow(profileId).catch(() => ({ record: null }));
  if (!record) return false;
  const sdkVersion = resolveSdkVersion(opts.sdkVersion);
  const found = lookupCapabilityResult(record, { modelId, sdkVersion });
  return Boolean(found && found.entry && found.entry.status === "pass");
}

/** Optional paginated discovery; never erases manual entries (cf. profile.js). */
export async function refreshDiscoveredModels(profileId) {
  const { collection, record } = await readRecordOrThrow(profileId);
  const apiKey = await readSecret(credentialTarget(profileId), {
    memoryOnly: record.memoryOnlyCredential,
    backend: record.secretBackend
  });
  if (!apiKey) {
    throw new ProviderError("NO_CREDENTIAL", "discovery requires a saved credential");
  }
  const result = await discoverModels({ baseUrl: record.baseUrl, apiKey });
  if (!result.supported) return { supported: false, reason: result.reason };
  const manualById = new Map(record.models.map((m) => [m.id, m]));
  for (const discovered of result.models) {
    if (!manualById.has(discovered.id)) manualById.set(discovered.id, discovered);
  }
  const merged = [...manualById.values()];
  const next = { ...record, models: merged, revision: record.revision + 1, updatedAt: new Date().toISOString() };
  writeCollection({ ...collection, profiles: { ...collection.profiles, [profileId]: next } });
  return { supported: true, models: merged };
}

/**
 * Redacted export/diagnostics snapshot. The collection file never contains
 * a secret to begin with; this is a defensive second layer that also drops
 * the OS-store target name and backend labels a diagnostic reader does not
 * need. Imported settings always require a separate credential entry.
 */
export function exportProfileRedacted(profileId) {
  validateProfileId(profileId);
  const collection = requireCollection();
  const record = collection.profiles[profileId];
  if (!record) return null;
  const redacted = redactSecretsDeep(
    {
      profileId: record.profileId,
      baseUrl: record.baseUrl,
      models: record.models,
      defaultModelId: record.defaultModelId,
      revision: record.revision,
      credentialRevision: record.credentialRevision || 0,
      hasCredential: Boolean(record.hasCredential),
      lastCapabilityTest: record.lastCapabilityTest || {},
      createdAt: record.createdAt || null,
      updatedAt: record.updatedAt || null
    },
    []
  );
  return redacted;
}

/** Test-only: remove the whole collection file (isolates test cases). */
export function _clearCollectionForTests() {
  try {
    fs.unlinkSync(namedProfilesFilePath());
  } catch {}
}

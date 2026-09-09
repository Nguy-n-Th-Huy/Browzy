// Provider settings orchestration — the contract group 3's session
// orchestration codes against (see task group 4 in tasks.md).
//
// This module is the single place that combines the non-secret profile
// (profile-store.js) with the OS-backed secret (host/agent/secrets/) into
// the values an actual SDK run needs, and is the only place that decides
// when a stored credential is "revoked" (cancels runs) versus merely
// "rotated" (existing runs keep their original snapshot; only a *new* run
// picks up the change — see design.md decision 4, last paragraph).
//
// Exported contract (signatures fixed; see tasks.md task group 4 and the
// osf-apply prompt this was implemented from):
//   loadProfile()
//   snapshotForRun(profileId, modelId)
//   onCredentialRevoked(listener)

import { readProfileFromDisk, writeProfileToDisk } from "./profile-store.js";
import { createEmptyProfile, capabilityTestKey, DEFAULT_PROFILE_ID } from "./profile-schema.js";
import { normalizeBaseUrl } from "./url.js";
import { validateModels } from "./models.js";
import { storeSecret, readSecret, deleteSecret, SecureStorageUnavailableError } from "../secrets/secret-store.js";
import { redactSecretsDeep } from "../secrets/redact.js";
import { ProviderError } from "./errors.js";
import { discoverModels } from "./discovery.js";
import { runCapabilityTest } from "./capability-test.js";

export { SecureStorageUnavailableError };

const revokedListeners = new Set();

function credentialTarget(profileId) {
  return `browzy-in-chrome/settings/${profileId}`;
}

/**
 * @returns {Promise<{
 *   profileId: string, baseUrl: string,
 *   models: Array<{id:string,label:string}>, defaultModelId: string|null,
 *   revision: number, lastCapabilityTest: Record<string, unknown>
 * } | null>}
 */
export async function loadProfile() {
  const stored = readProfileFromDisk();
  if (!stored) return null;
  return {
    profileId: stored.profileId,
    baseUrl: stored.baseUrl,
    models: stored.models,
    defaultModelId: stored.defaultModelId,
    revision: stored.revision,
    lastCapabilityTest: stored.lastCapabilityTest || {},
    // Additional fields kept alongside the fixed five above — safe to
    // destructure past, per the contract ("add further exports freely").
    credentialRevision: stored.credentialRevision || 0,
    hasCredential: Boolean(stored.hasCredential),
    memoryOnlyCredential: Boolean(stored.memoryOnlyCredential),
    secretBackend: stored.secretBackend || null
  };
}

/**
 * Validate and atomically persist the non-secret parts of a profile. Never
 * touches the credential. Allowed fully offline (no network call).
 *
 * @param {{ profileId?: string, baseUrl: string, models: Array<{id:string,label:string}>, defaultModelId: string|null }} input
 */
export async function saveProfile(input) {
  const { profileId = DEFAULT_PROFILE_ID, baseUrl, models, defaultModelId } = input || {};
  const { normalized } = normalizeBaseUrl(baseUrl);
  const { models: cleanModels, defaultModelId: cleanDefault } = validateModels(models, defaultModelId);

  const existing = readProfileFromDisk() || createEmptyProfile(profileId);
  const endpointOrModelsChanged =
    existing.baseUrl !== normalized || JSON.stringify(existing.models) !== JSON.stringify(cleanModels) || existing.defaultModelId !== cleanDefault;

  const next = {
    ...existing,
    profileId,
    baseUrl: normalized,
    models: cleanModels,
    defaultModelId: cleanDefault,
    revision: existing.revision + 1,
    // A changed endpoint or model list invalidates prior capability results
    // for entries that no longer apply; capabilityTestKey already scopes
    // results to (baseUrl, modelId, credentialRevision), so a changed
        // baseUrl alone already orphans old keys — clearing here just keeps
    // the stored file from accumulating stale, unreachable entries.
    lastCapabilityTest: endpointOrModelsChanged ? {} : existing.lastCapabilityTest
  };
  writeProfileToDisk(next);
  return loadProfile();
}

/**
 * Store (or replace) the credential for `profileId`. Bumps
 * `credentialRevision`, which — because capability-test results are keyed by
 * credential revision — naturally invalidates every previously recorded
 * compatibility result without needing a separate "invalidate" step.
 *
 * @param {string} profileId
 * @param {string} secret
 * @param {{ memoryOnly?: boolean }} [opts]
 * @returns {Promise<{ backend: string }>}
 * @throws {SecureStorageUnavailableError} if no OS store is available and
 *   `memoryOnly` was not explicitly requested — never silently falls back to
 *   plaintext.
 */
export async function setCredential(profileId, secret, opts = {}) {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new Error("credential must be a nonempty string");
  }
  const trimmed = secret.trim();
  const existing = readProfileFromDisk() || createEmptyProfile(profileId);
  const target = credentialTarget(profileId);
  const { backend } = await storeSecret(target, trimmed, opts);

  const next = {
    ...existing,
    profileId,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    hasCredential: true,
    memoryOnlyCredential: backend === "memory",
    secretBackend: backend
  };
  writeProfileToDisk(next);
  return { backend };
}

/**
 * Remove the stored credential. Cancels associated runs (fires
 * `onCredentialRevoked`) and removes the OS-stored secret.
 * @param {string} profileId
 */
export async function removeCredential(profileId) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) return;
  const target = credentialTarget(profileId);
  await deleteSecret(target, { memoryOnly: existing.memoryOnlyCredential, backend: existing.secretBackend });

  const next = {
    ...existing,
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    lastCapabilityTest: {}
  };
  writeProfileToDisk(next);

  for (const listener of revokedListeners) {
    try {
      listener({ profileId });
    } catch {
      // A listener throwing must never prevent the other listeners (or the
      // caller) from observing the revocation.
    }
  }
}

/**
 * @param {(event: { profileId: string }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onCredentialRevoked(listener) {
  revokedListeners.add(listener);
  return () => revokedListeners.delete(listener);
}

/** Test-only: drop every registered listener between test cases. */
export function _clearCredentialRevokedListenersForTests() {
  revokedListeners.clear();
}

/**
 * Snapshot the profile into the isolated `model`/`env` values a run needs.
 * `env` REPLACES the ambient environment (see host/agent/spike/lib/query-options.mjs
 * for the same isolation contract used by the SDK query-options builder) —
 * callers must never spread `process.env` over this result.
 *
 * @param {string} profileId
 * @param {string} [modelId] defaults to the profile's default model
 * @returns {Promise<{ model: string, env: { ANTHROPIC_BASE_URL: string, ANTHROPIC_API_KEY: string }, revision: number, profileId: string, credentialRevision: number }>}
 * @throws {ProviderError} code NO_CREDENTIAL if no credential is available.
 */
export async function snapshotForRun(profileId, modelId) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }

  const model = modelId || profile.defaultModelId;
  if (!model) {
    throw new ProviderError("NO_CREDENTIAL", "no model was requested and the profile has no default model");
  }
  if (!profile.models.some((entry) => entry.id === model)) {
    throw new ProviderError("INVALID_PROFILE", `model "${model}" is not in the profile's model list`);
  }

  const target = credentialTarget(profileId);
  const apiKey = await readSecret(target, { memoryOnly: profile.memoryOnlyCredential, backend: profile.secretBackend });
  if (!apiKey) {
    throw new ProviderError("NO_CREDENTIAL", `no credential is available for profile "${profileId}" — enter an API key before running`);
  }

  return {
    model,
    env: {
      ANTHROPIC_BASE_URL: profile.baseUrl,
      ANTHROPIC_API_KEY: apiKey
    },
    revision: profile.revision,
    profileId,
    // Additive (tasks.md 2.1's "secret-free app profile identity ...
    // credential revision"): the credential's OWN revision counter (bumped
    // only by setCredential/removeCredential — see loadProfile()'s identical
    // field above), distinct from `revision` (the whole profile record's,
    // bumped by ANY edit including baseUrl/model-list changes). Never the
    // secret itself — this is the non-secret counter a resume-compatibility
    // check (tasks.md 2.4) can compare against without ever reading `env`.
    credentialRevision: profile.credentialRevision || 0
  };
}

/**
 * Optional paginated model discovery (task 4.3). Never erases the existing
 * manual list: merges newly discovered entries in, preserving any manual
 * entry discovery didn't return, and leaves the list untouched entirely
 * when discovery is unsupported.
 *
 * @param {string} profileId
 * @returns {Promise<{ supported: boolean, models?: Array<{id:string,label:string}>, reason?: string }>}
 */
export async function refreshDiscoveredModels(profileId) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const target = credentialTarget(profileId);
  const apiKey = await readSecret(target, { memoryOnly: profile.memoryOnlyCredential, backend: profile.secretBackend });
  if (!apiKey) {
    throw new ProviderError("NO_CREDENTIAL", "discovery requires a saved credential");
  }

  const result = await discoverModels({ baseUrl: profile.baseUrl, apiKey });
  if (!result.supported) {
    return { supported: false, reason: result.reason };
  }

  const manualById = new Map(profile.models.map((m) => [m.id, m]));
  for (const discovered of result.models) {
    // Preserve a manual label override; only add the discovered entry
    // outright when this id wasn't already present.
    if (!manualById.has(discovered.id)) {
      manualById.set(discovered.id, discovered);
    }
  }
  const merged = [...manualById.values()];
  writeProfileToDisk({ ...profile, models: merged, revision: profile.revision + 1 });
  return { supported: true, models: merged };
}

/**
 * Run the bounded synthetic capability test for the given model and record
 * the result, keyed by (baseUrl, modelId, credentialRevision) so a later key
 * or endpoint change naturally invalidates it.
 *
 * @param {string} profileId
 * @param {string} modelId
 * @returns {Promise<ReturnType<typeof runCapabilityTest>>}
 */
export async function testCapability(profileId, modelId) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const target = credentialTarget(profileId);
  const apiKey = await readSecret(target, { memoryOnly: profile.memoryOnlyCredential, backend: profile.secretBackend });
  if (!apiKey) {
    throw new ProviderError("NO_CREDENTIAL", "the capability test requires a saved credential");
  }

  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const z = await import("zod");
  const result = await runCapabilityTest({ baseUrl: profile.baseUrl, apiKey, modelId, sdk, z: z.default || z });

  const key = capabilityTestKey({ baseUrl: profile.baseUrl, modelId, credentialRevision: profile.credentialRevision || 0 });
  const lastCapabilityTest = { ...(profile.lastCapabilityTest || {}), [key]: result };
  writeProfileToDisk({ ...profile, lastCapabilityTest });
  return result;
}

/**
 * @param {string} profileId
 * @param {string} modelId
 * @returns {Promise<boolean>} true only if the most recent capability test
 *   for this exact (endpoint, model, credential) combination passed.
 *   "Saving is allowed offline; running the assistant requires a successful
 *   capability test for the current endpoint/model" (spec).
 */
export async function isRunnable(profileId, modelId) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) return false;
  const key = capabilityTestKey({ baseUrl: profile.baseUrl, modelId, credentialRevision: profile.credentialRevision || 0 });
  const entry = (profile.lastCapabilityTest || {})[key];
  return Boolean(entry && entry.status === "pass");
}

/**
 * A redacted snapshot of the profile suitable for export/diagnostics. The
 * stored profile file never contains a secret to begin with (the credential
 * lives only in the OS store / memory store — see host/agent/secrets/), so
 * this is a defensive second layer, not the only one.
 * @param {string} profileId
 */
export async function exportProfileRedacted(profileId) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) return null;
  return redactSecretsDeep(profile, []);
}

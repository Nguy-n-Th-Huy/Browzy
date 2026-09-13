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
import {
  createEmptyProfile,
  capabilityTestKey,
  DEFAULT_PROFILE_ID,
  isKnownProviderType,
  resolveProviderType,
  CHATGPT_CAPABILITY_TEST_MARKER
} from "./profile-schema.js";
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
    secretBackend: stored.secretBackend || null,
    // Provider type: a profile with no stored field is a profile saved
    // before provider types existed — it loads as `anthropic` unchanged
    // (spec: "Existing profile after upgrade"). `chatgptAccount` is the
    // ChatGPT profile's non-secret email/plan companion field; always null
    // for an `anthropic` profile.
    providerType: resolveProviderType(stored),
    chatgptAccount: stored.chatgptAccount || null,
    // Non-secret ChatGPT session state (add-chatgpt-subscription-provider
    // design.md decision 3) — lets readiness show `SESSION_EXPIRED` distinctly
    // from "never signed in" without reading the credential. A profile saved
    // before this field existed (or an `anthropic` profile, which never sets
    // it) loads as `signed_out`, the same default a fresh chatgpt profile
    // that has never completed a sign-in would have.
    chatgptSessionState: stored.chatgptSessionState || "signed_out"
  };
}

/**
 * Switch a profile's provider type between `anthropic` and `chatgpt`. Only
 * changes the type field — it never touches the model list, credential, or
 * (for `chatgpt`) the signed-in account; switching back and forth is
 * nondestructive. Rejects any value other than the two known types so a
 * caller can never persist a typo that would later load as `INVALID_PROFILE`.
 *
 * @param {string} profileId
 * @param {string} providerType `anthropic` or `chatgpt`
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 */
export async function setProviderType(profileId, providerType) {
  if (!isKnownProviderType(providerType)) {
    throw new Error(`unknown provider type: ${providerType}`);
  }
  const existing = readProfileFromDisk() || createEmptyProfile(profileId);
  const next = {
    ...existing,
    profileId,
    providerType,
    revision: existing.revision + 1
  };
  writeProfileToDisk(next);
  return loadProfile();
}

/**
 * Store (or clear) the ChatGPT account's non-secret display fields — email
 * and plan type, read once from the ID token's
 * `https://api.openai.com/auth` claims by host/agent/chatgpt/auth.js. Never
 * touches the credential itself (the refresh token lives in the OS secret
 * store under a separate target — see design.md decision 3).
 *
 * @param {string} profileId
 * @param {{ email: string, planType: string } | null} account
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 */
export async function setChatgptAccount(profileId, account) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const next = {
    ...existing,
    chatgptAccount: account ? { email: String(account.email), planType: String(account.planType) } : null,
    revision: existing.revision + 1
  };
  writeProfileToDisk(next);
  return loadProfile();
}

// Codex model seed table (CLIProxyAPI registry snapshot, researched
// 2026-09-13) — the known model ids offered on first ChatGPT sign-in, keyed
// by plan bucket. Every plan's ID-token `plan_type` claim that isn't
// recognized here falls back to the free-plan (smaller) list: offering a
// model the account can't actually reach only surfaces later as an ordinary
// capability-test/run failure naming that model, whereas guessing "paid" for
// an unrecognized plan could silently offer models the account never had
// access to.
const PAID_CODEX_MODEL_SEEDS = [
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-6-astra", label: "gpt-6-astra" },
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
  { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
  { id: "gpt-5.6-luna", label: "gpt-5.6-luna" }
];
const FREE_CODEX_MODEL_SEEDS = [
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.6-terra", label: "gpt-5.6-terra" },
  { id: "gpt-5.6-luna", label: "gpt-5.6-luna" }
];

export const CODEX_MODEL_SEEDS_BY_PLAN = {
  free: FREE_CODEX_MODEL_SEEDS,
  plus: PAID_CODEX_MODEL_SEEDS,
  pro: PAID_CODEX_MODEL_SEEDS,
  team: PAID_CODEX_MODEL_SEEDS,
  enterprise: PAID_CODEX_MODEL_SEEDS
};

/**
 * @param {string} planType the ID token's `plan_type` claim
 * @returns {Array<{id:string,label:string}>} a fresh copy — callers persist
 *   it directly, so this must never hand back a table entry a later seed
 *   call could then mutate.
 */
function codexModelSeedsForPlan(planType) {
  const seeds = CODEX_MODEL_SEEDS_BY_PLAN[planType] || FREE_CODEX_MODEL_SEEDS;
  return seeds.map((model) => ({ ...model }));
}

/**
 * Seed a `chatgpt` profile's model list with the known Codex model ids for
 * its plan — but only when the list is still empty. A user's own edits (or
 * an earlier seed) are never overwritten (spec: "seeded on first sign-in ...
 * and stay manually editable").
 *
 * @param {string} profileId
 * @param {string} planType
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 */
export async function seedChatgptModelsForPlan(profileId, planType) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  if (Array.isArray(existing.models) && existing.models.length > 0) {
    return loadProfile();
  }
  const seeds = codexModelSeedsForPlan(planType);
  const next = {
    ...existing,
    models: seeds,
    defaultModelId: existing.defaultModelId || (seeds[0] ? seeds[0].id : null),
    revision: existing.revision + 1
  };
  writeProfileToDisk(next);
  return loadProfile();
}

/**
 * Record a successful ChatGPT sign-in (host/agent/chatgpt/auth.js calls this
 * right after IT stores the refresh-token secret at its own target,
 * `browzy-in-chrome/chatgpt/<profileId>` — this function never touches that
 * secret itself). Composes the existing `setChatgptAccount` /
 * `seedChatgptModelsForPlan` helpers (so their behaviour, including "only
 * seed an empty model list", is exercised exactly once, unchanged) and then
 * applies the same credential-bookkeeping fields `setCredential` applies for
 * an `anthropic` profile — `hasCredential`, `memoryOnlyCredential`,
 * `secretBackend`, and a bumped `credentialRevision` (invalidating any prior
 * capability-test result the same way `setCredential`'s bump does) — plus
 * `chatgptSessionState: "signed_in"`.
 *
 * @param {string} profileId
 * @param {{ email: string, planType: string, backend: string }} account
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 */
export async function recordChatgptSignIn(profileId, { email, planType, backend }) {
  await setChatgptAccount(profileId, { email, planType });
  await seedChatgptModelsForPlan(profileId, planType);

  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const next = {
    ...existing,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    hasCredential: true,
    memoryOnlyCredential: backend === "memory",
    secretBackend: backend,
    chatgptSessionState: "signed_in"
  };
  writeProfileToDisk(next);
  return loadProfile();
}

/**
 * Record an explicit ChatGPT sign-out for `profileId`. Mirrors
 * `removeCredential`'s bookkeeping and listener-firing (see its doc comment
 * for why a revoked credential must both clear the stored-ness flags AND
 * fire `onCredentialRevoked` — cancelling in-flight runs and revoking gateway
 * tokens), but also clears the signed-in account display fields and sets
 * `chatgptSessionState` to `"signed_out"`. Never touches the actual secret at
 * `browzy-in-chrome/chatgpt/<profileId>` — the caller
 * (host/agent/chatgpt/auth.js's `signOut()`) removes that itself; this only
 * updates the profile record and fires the revocation listeners.
 *
 * @param {string} profileId
 */
export async function recordChatgptSignOut(profileId) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) return;
  const next = {
    ...existing,
    chatgptAccount: null,
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    chatgptSessionState: "signed_out",
    lastCapabilityTest: {}
  };
  writeProfileToDisk(next);

  for (const listener of revokedListeners) {
    try {
      listener({ profileId });
    } catch {
      // A listener throwing must never prevent the other listeners (or the
      // caller) from observing the revocation — see removeCredential above.
    }
  }
}

/**
 * Record that a ChatGPT session expired. Two producers share this one state
 * edge: a refresh rejected as `invalid_grant`/`refresh_token_reused`
 * (design.md decision 3, host/agent/chatgpt/auth.js), and a request answered
 * 401 again after its single refresh retry (spec: "Upstream error mapping",
 * host/agent/chatgpt/gateway.js). Unlike `recordChatgptSignOut`, the signed-in
 * account display fields are KEPT: the side panel's `SESSION_EXPIRED` state
 * names the account that needs to sign in again. Otherwise this is treated
 * exactly like a credential revocation — bumped `credentialRevision`,
 * cleared `hasCredential`/`memoryOnlyCredential`/`secretBackend`, and the
 * existing `onCredentialRevoked` listeners fire so in-flight runs are
 * cancelled and gateway tokens get revoked. The actual secret removal at
 * `browzy-in-chrome/chatgpt/<profileId>` is done by the caller, not here.
 *
 * IDEMPOTENT by contract: `signed_in -> session_expired` is a state edge, and
 * recording an edge that is already recorded is a no-op. That matters because
 * the callers are concurrent request paths — several in-flight requests can
 * each be answered with a 401 after their own refresh (the gateway's
 * post-refresh 401 rule) and each then asks for this same transition. Exactly
 * one of them observes `signed_in` and does the work (revision bump +
 * revocation listeners); every later one returns immediately, so a burst of
 * 401s cannot thrash the credential revision or re-fire the listeners. A
 * fresh sign-in (`recordChatgptSignIn`) sets `signed_in` again, so the NEXT
 * genuine expiry still transitions.
 *
 * @param {string} profileId
 */
export async function recordChatgptSessionExpired(profileId) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) return;
  if (existing.chatgptSessionState === "session_expired") return;
  const next = {
    ...existing,
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    chatgptSessionState: "session_expired",
    lastCapabilityTest: {}
  };
  writeProfileToDisk(next);

  for (const listener of revokedListeners) {
    try {
      listener({ profileId });
    } catch {
      // Same non-fatal-listener rule as removeCredential/recordChatgptSignOut.
    }
  }
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
 * Preconditions shared by `snapshotForChatgptRun` and
 * `testCapabilityForChatgpt` (add-chatgpt-subscription-provider spec: "ChatGPT
 * profile not signed in" / model validation). Resolves the model to actually
 * use, or throws the exact `ProviderError` the spec names for each failure
 * mode — never reads or refreshes the actual ChatGPT credential itself: the
 * gateway/auth module (host/agent/chatgpt/auth.js, via the gateway) owns that
 * entirely, so this only needs the non-secret profile fields already on
 * `profile` (chatgptSessionState/hasCredential/models/defaultModelId).
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} [modelId]
 * @returns {string} the resolved model id
 */
function requireChatgptEligible(profile, modelId) {
  if (profile.chatgptSessionState === "session_expired") {
    throw new ProviderError("SESSION_EXPIRED", "the ChatGPT session expired — sign in with ChatGPT again");
  }
  if (profile.chatgptSessionState !== "signed_in" || !profile.hasCredential) {
    throw new ProviderError("NO_CREDENTIAL", "ChatGPT sign-in is required before this profile can run");
  }
  const model = modelId || profile.defaultModelId;
  if (!model) {
    throw new ProviderError("NO_CREDENTIAL", "no model was requested and the profile has no default model");
  }
  if (!profile.models.some((entry) => entry.id === model)) {
    throw new ProviderError("INVALID_PROFILE", `model "${model}" is not in the profile's model list`);
  }
  return model;
}

/**
 * The `chatgpt` branch of `snapshotForRun` (design.md decision 2 / decision
 * 5). Ensures the loopback gateway is running, issues a run-scoped gateway
 * token bound to this profile/model/credential revision, and returns the
 * SAME snapshot shape an `anthropic` profile returns — `env.ANTHROPIC_BASE_URL`
 * points at the gateway instead of a real endpoint, and
 * `env.ANTHROPIC_API_KEY` is the gateway token, never a ChatGPT token (spec:
 * "no ChatGPT token appears in the SDK environment"). `releaseGatewayToken`
 * is an additive field alongside the fixed five — safe to destructure past,
 * exactly like `credentialRevision` above; existing consumers that only ever
 * read `model`/`env`/`revision`/`profileId`/`credentialRevision` are
 * unaffected (host/agent/tools/query-options.js's `buildIsolatedOptions`
 * only reads `env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_API_KEY`/`model`).
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} [modelId]
 */
async function snapshotForChatgptRun(profile, modelId) {
  const model = requireChatgptEligible(profile, modelId);
  const gateway = await import("../chatgpt/gateway.js");
  const { port } = await gateway.ensureGatewayStarted();
  const credentialRevision = profile.credentialRevision || 0;
  const { token, release } = gateway.issueGatewayToken({
    profileId: profile.profileId,
    model,
    credentialRevision,
    purpose: "run"
  });
  return {
    model,
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: token
    },
    revision: profile.revision,
    profileId: profile.profileId,
    credentialRevision,
    releaseGatewayToken: release
  };
}

/**
 * The `chatgpt` branch of `testCapability` (spec: "For a chatgpt profile,
 * the same test SHALL run through the companion's ChatGPT gateway with a
 * test-scoped gateway token"). Issues a `purpose:"capability-test"` token,
 * runs the SAME `runCapabilityTest` an `anthropic` profile uses (proving the
 * real SDK transport, not a bespoke client), and always revokes the token
 * afterward regardless of outcome. Records the result under the
 * `CHATGPT_CAPABILITY_TEST_MARKER` key — the same key shape `isRunnable`
 * already expects for a `chatgpt` profile (profile-schema.js).
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} [modelId]
 */
async function testCapabilityForChatgpt(profile, modelId) {
  const model = requireChatgptEligible(profile, modelId);
  const gateway = await import("../chatgpt/gateway.js");
  const { port } = await gateway.ensureGatewayStarted();
  const credentialRevision = profile.credentialRevision || 0;
  const { token, release } = gateway.issueGatewayToken({
    profileId: profile.profileId,
    model,
    credentialRevision,
    purpose: "capability-test"
  });

  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const z = await import("zod");
  let result;
  try {
    result = await runCapabilityTest({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: token,
      modelId: model,
      sdk,
      z: z.default || z
    });
  } finally {
    release();
  }

  const key = capabilityTestKey({ baseUrl: CHATGPT_CAPABILITY_TEST_MARKER, modelId: model, credentialRevision });
  const lastCapabilityTest = { ...(profile.lastCapabilityTest || {}), [key]: result };
  writeProfileToDisk({ ...profile, lastCapabilityTest });
  return result;
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
  const providerType = resolveProviderType(profile);
  if (providerType === "chatgpt") {
    return snapshotForChatgptRun(profile, modelId);
  }
  if (providerType !== "anthropic") {
    throw new ProviderError("INVALID_PROFILE", `profile "${profileId}" has an unknown provider type "${providerType}"`);
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
  const providerType = resolveProviderType(profile);
  if (providerType === "chatgpt") {
    // No credential needed to answer this — Codex has no model-listing
    // endpoint at all (spec: "For a chatgpt profile, discovery SHALL report
    // unsupported and the manual list SHALL remain editable").
    return { supported: false, reason: "ChatGPT profiles have no model-listing endpoint; the model list stays manually editable" };
  }
  if (providerType !== "anthropic") {
    throw new ProviderError("INVALID_PROFILE", `profile "${profileId}" has an unknown provider type "${providerType}"`);
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
  const providerType = resolveProviderType(profile);
  if (providerType === "chatgpt") {
    return testCapabilityForChatgpt(profile, modelId);
  }
  if (providerType !== "anthropic") {
    throw new ProviderError("INVALID_PROFILE", `profile "${profileId}" has an unknown provider type "${providerType}"`);
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
  const providerType = resolveProviderType(profile);
  if (providerType !== "anthropic" && providerType !== "chatgpt") return false;
  // A `chatgpt` profile's capability-test results are keyed by a fixed
  // marker rather than a real endpoint URL (profile-schema.js), so this key
  // computation must match whatever a `chatgpt` testCapability() eventually
  // records it under, even though no `chatgpt` profile can pass a
  // capability test yet.
  const baseUrlForKey = providerType === "chatgpt" ? CHATGPT_CAPABILITY_TEST_MARKER : profile.baseUrl;
  const key = capabilityTestKey({ baseUrl: baseUrlForKey, modelId, credentialRevision: profile.credentialRevision || 0 });
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

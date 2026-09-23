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
//
// Provider types: `anthropic` and `chatgpt` only. The Jev engine is reached
// only through the `extract_page`/`browser_subgoal` tools on either type,
// never as a provider type of its own — see resolveJevBrowserSubgoalConfig/
// resolveJevExtractPageConfig below. Those tools' own configuration is ONE
// merged secret record (the Jev transport key, plus a now-inert legacy
// text-model key kept only so nothing already stored is discarded) under
// `browzy-in-chrome/typesafe/<profileId>` — a target of its own, never the
// `anthropic` credential target above — and never in the profile record
// (therefore never in exportProfileRedacted/the profile file), and never in
// a run snapshot's `env`.
//
// A profile stored with the removed `typesafe` provider type is migrated to
// `anthropic` the moment it is read (profile-store.js's readProfileFromDisk,
// via profile-schema.js's migrateStoredTypesafeProfile) — this module never
// sees a `typesafe` providerType itself.

import { readProfileFromDisk, writeProfileToDisk } from "./profile-store.js";
import {
  createEmptyProfile,
  capabilityTestKey,
  DEFAULT_PROFILE_ID,
  DEFAULT_TYPESAFE_BASE_URL,
  DEFAULT_TYPESAFE_GATEWAY_BASE_URL,
  DEFAULT_TYPESAFE_OPENROUTER_BASE_URL,
  DEFAULT_TYPESAFE_SOURCE,
  TYPESAFE_MODEL_SEEDS,
  isKnownProviderType,
  isKnownTypesafeSource,
  resolveProviderType,
  resolveJevToolsSendScreenshots,
  CHATGPT_CAPABILITY_TEST_MARKER
} from "./profile-schema.js";
import { normalizeBaseUrl, DEFAULT_BASE_URL } from "./url.js";
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

// --- The Jev transport's own secret record (used by extract_page/browser_subgoal) ---
//
// The TypeSafe API key and the text-model API key are stored as ONE secret
// record per profile, under a target of its own — deliberately not the
// `browzy-in-chrome/settings/<profileId>` target above, so removing or
// rotating one provider's credential can never touch the other's. The record
// is JSON (`{v:1, typesafe_api_key, text_model_api_key}`), and a key that was
// never set — or was explicitly removed — is the EMPTY STRING, never null and
// never absent, so the merge in setTypesafeCredentials() has one canonical
// "no value" shape to compare against.
const TYPESAFE_CREDENTIAL_TARGET_PREFIX = "browzy-in-chrome/typesafe/";
const TYPESAFE_SECRET_VERSION = 1;

// The merged record's size ceiling, enforced BEFORE either storage path
// stores it: Windows Credential Manager's CRED_MAX_CREDENTIAL_BLOB_SIZE
// (5 * 512 bytes), applied to every backend as the same fixed,
// backend-agnostic limit the ChatGPT credential path uses
// (host/agent/chatgpt/auth.js's DEFAULT_MAX_SECRET_BYTES) with the same
// existing `SECRET_TOO_LARGE` outcome the settings UI already explains.
// Measuring here is what makes that outcome real on this path: without it an
// oversize record fails in the OS backend with whatever raw error that
// backend raises (not a classified code the UI can explain), and the
// memory-only path — which never reaches a backend that could impose any
// limit at all — accepts unbounded input. Nothing is ever truncated.
const TYPESAFE_MAX_SECRET_BYTES = 2560;

/** @param {string} profileId */
function typesafeCredentialTarget(profileId) {
  return `${TYPESAFE_CREDENTIAL_TARGET_PREFIX}${profileId}`;
}

/** @returns {{ v: number, typesafe_api_key: string, text_model_api_key: string }} */
function emptyTypesafeSecret() {
  return { v: TYPESAFE_SECRET_VERSION, typesafe_api_key: "", text_model_api_key: "" };
}

/**
 * Parse a stored typesafe secret. Anything that is not the expected JSON
 * object (absent, empty, hand-edited, written by a future version) degrades
 * to "no keys stored" rather than throwing: the caller then reports
 * NO_CREDENTIAL, which is exactly what an unreadable secret means to it.
 *
 * @param {string|null} raw
 * @returns {{ v: number, typesafe_api_key: string, text_model_api_key: string }}
 */
function parseTypesafeSecret(raw) {
  if (!raw) return emptyTypesafeSecret();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyTypesafeSecret();
  }
  if (!parsed || typeof parsed !== "object") return emptyTypesafeSecret();
  return {
    v: TYPESAFE_SECRET_VERSION,
    typesafe_api_key: typeof parsed.typesafe_api_key === "string" ? parsed.typesafe_api_key : "",
    text_model_api_key: typeof parsed.text_model_api_key === "string" ? parsed.text_model_api_key : ""
  };
}

/**
 * @param {{ typesafe_api_key?: string, text_model_api_key?: string }} secret
 * @returns {string} the canonical serialized form — always both keys, always
 *   strings (`""` for "not set").
 */
function serializeTypesafeSecret(secret) {
  return JSON.stringify({
    v: TYPESAFE_SECRET_VERSION,
    typesafe_api_key: secret.typesafe_api_key || "",
    text_model_api_key: secret.text_model_api_key || ""
  });
}

/**
 * A fresh copy of the seed table for one Jev source (TYPESAFE_MODEL_SEEDS,
 * profile-schema.js) — never the table entry itself, since a caller persists
 * the returned array. An unknown source falls back to the default source's
 * seed, matching resolveTypesafeSource(). The Jev browser tools' resolvers
 * use this for the Jev transport's own fixed model id; it is unrelated to
 * the profile's own conversation `models`/`defaultModelId`.
 */
function typesafeModelSeeds(source = DEFAULT_TYPESAFE_SOURCE) {
  const table = TYPESAFE_MODEL_SEEDS[source] || TYPESAFE_MODEL_SEEDS[DEFAULT_TYPESAFE_SOURCE];
  return table.map((model) => ({ ...model }));
}

/**
 * The profile's persisted Jev source, defaulted for a profile saved before
 * the field existed (or not carrying one). A value that is not in
 * TYPESAFE_SOURCES loads as the default: the source is a configuration
 * choice with a documented default, not a runnability gate like
 * providerType's unknown values (which load verbatim so the run path can
 * refuse them with INVALID_PROFILE). Writers validate before persisting, so
 * an invalid stored value can only come from a hand-edited file.
 */
function resolveTypesafeSource(profile) {
  const stored = profile && profile.typesafeSource;
  return isKnownTypesafeSource(stored) ? stored : DEFAULT_TYPESAFE_SOURCE;
}

/** The documented endpoint default for one Jev source. */
function typesafeDefaultForSource(source) {
  if (source === "vercel") return DEFAULT_TYPESAFE_GATEWAY_BASE_URL;
  if (source === "openrouter") return DEFAULT_TYPESAFE_OPENROUTER_BASE_URL;
  return DEFAULT_TYPESAFE_BASE_URL;
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
    // The Anthropic key's own stored-ness (see setCredential): the flat flag
    // above also folds in the Jev transport key's own stored-ness
    // (setTypesafeCredentials), so this field is what tells the settings
    // surface whether THIS key specifically is saved.
    hasAnthropicKey: Boolean(stored.hasAnthropicKey),
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
    chatgptSessionState: stored.chatgptSessionState || "signed_out",
    // Non-secret Jev-tools fields. `textModelBaseUrl`/`textModelId` are the
    // now-inert legacy text-model fields — kept only so a profile that stored
    // them before the standalone Jev provider was removed does not lose them;
    // nothing reads them to build a request any more. `hasTypesafeKey`/
    // `hasTextModelKey` are the stored-ness bookkeeping setTypesafeCredentials()
    // maintains, so the settings surface can report "key saved" without a key
    // ever crossing a reply. A profile that predates these fields loads with
    // the empty defaults.
    textModelBaseUrl: stored.textModelBaseUrl || null,
    textModelId: stored.textModelId || null,
    hasTypesafeKey: Boolean(stored.hasTypesafeKey),
    hasTextModelKey: Boolean(stored.hasTextModelKey),
    // The persisted Jev source ("typesafe" | "vercel" | "openrouter"), read
    // by the Jev browser tools' resolvers; a profile saved before the field
    // existed loads as the default source (resolveTypesafeSource(),
    // profile-schema.js's TYPESAFE_SOURCES).
    typesafeSource: resolveTypesafeSource(stored),
    // The Jev-tools screenshot toggle: resolved here so every reader (the
    // settings surface and resolveJevBrowserSubgoalConfig below) sees the
    // documented default (disabled) on a profile stored before this field
    // existed.
    jevToolsSendScreenshots: resolveJevToolsSendScreenshots(stored)
  };
}

/**
 * Switch a profile's provider type between `anthropic` and `chatgpt`. It
 * never touches the credential or (for `chatgpt`) the signed-in account, and
 * a user-chosen endpoint survives every switch; switching back and forth is
 * nondestructive. Rejects any value other than the known types (`typesafe`
 * included — the removed standalone Jev provider is never selectable again)
 * so a caller can never persist a typo that would later load as
 * `INVALID_PROFILE`.
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
    // `hasCredential` is one flat flag over every secret a profile can hold,
    // and `setTypesafeCredentials` rewrites it from the TypeSafe record alone.
    // A `typesafe` profile whose decision model runs on THIS key would then
    // report "key saved" the moment its TypeSafe key was saved, whether or not
    // this one ever was. This field is that key's own stored-ness, so the
    // settings surface can report it honestly.
    hasAnthropicKey: true,
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
    hasAnthropicKey: false,
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
 * Persist the "Jev browser tools" settings section for an `anthropic`/
 * `chatgpt` profile: the Jev transport source (`typesafe` direct, `vercel`
 * AI Gateway, or `openrouter`) and the Jev-tools screenshot toggle. Never
 * touches a key — that lives only in the merged secret record below.
 *
 * Scoped down sharply: this section's text/decision model is the profile's
 * OWN primary provider — resolved at run/test time from the run snapshot
 * (primaryTextModelFromSnapshot below), never a second stored configuration.
 * Only `typesafeSource` and `jevToolsSendScreenshots` are ever written;
 * every other argument (a caller's stale `baseUrl`, legacy text-model or
 * decision-model fields from a settings page that predates their removal) is
 * silently ignored — never validated, never persisted — because none of it
 * means anything here: the primary provider's own endpoint/model
 * list/default model/recorded capability test belong to a different save
 * path (`saveProfile`/`testCapability`) and must never be touched by a
 * Jev-transport-only save.
 *
 * @param {string} profileId
 * @param {{ typesafeSource?: string, jevToolsSendScreenshots?: boolean }} input
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 * @throws {ProviderError} INVALID_PROFILE when the source is unknown or the screenshot toggle is not a boolean
 */
export async function setTypesafeConfig(profileId, { typesafeSource, jevToolsSendScreenshots } = {}) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  if (typesafeSource !== undefined && !isKnownTypesafeSource(typesafeSource)) {
    throw new ProviderError("INVALID_PROFILE", `unknown TypeSafe source "${typesafeSource}"`);
  }
  if (jevToolsSendScreenshots !== undefined && typeof jevToolsSendScreenshots !== "boolean") {
    throw new ProviderError("INVALID_PROFILE", "the jevToolsSendScreenshots toggle must be a boolean");
  }
  const cleanJevToolsSendScreenshots =
    jevToolsSendScreenshots === undefined ? resolveJevToolsSendScreenshots(existing) : jevToolsSendScreenshots;
  const cleanSource = typesafeSource === undefined ? resolveTypesafeSource(existing) : typesafeSource;

  const next = {
    ...existing,
    profileId,
    typesafeSource: cleanSource,
    jevToolsSendScreenshots: cleanJevToolsSendScreenshots,
    revision: existing.revision + 1
  };
  writeProfileToDisk(next);
  return loadProfile();
}

/**
 * Store (or replace) the Jev transport key the Jev browser tools
 * (`extract_page`, `browser_subgoal`) use. Write-only: the caller hands over
 * a value, and all that ever comes back are booleans — never a key, old or
 * new.
 *
 * The key lives in a JSON secret record at
 * `browzy-in-chrome/typesafe/<profileId>`, alongside a now-inert legacy
 * text-model key this op no longer writes (the standalone Jev provider that
 * used it was removed) — that field, and the resulting `hasTextModelKey`
 * flag, are read back and carried forward untouched, so a profile that saved
 * one before the removal does not lose it. An OMITTED `typesafeApiKey` keeps
 * its stored value; an explicit empty string REMOVES it. Clearing it while
 * no legacy text-model key remains stored removes the whole record
 * (delegating to removeTypesafeCredentials, which also fires the revocation
 * listeners — a run in flight just lost its key).
 *
 * `storeSecret` is the existing OS-store path, with the existing outcomes:
 * `memoryOnly:true` is honored and labeled, and `SECURE_STORAGE_UNAVAILABLE`
 * is thrown when no OS store exists and memory-only was not chosen. The
 * serialized record is measured before it reaches EITHER path, and one that
 * exceeds TYPESAFE_MAX_SECRET_BYTES fails with the existing
 * `SECRET_TOO_LARGE` outcome — the value is never truncated, nothing is
 * stored, and the memory-only path is bounded by the same ceiling.
 *
 * @param {string} profileId
 * @param {{ typesafeApiKey?: string, memoryOnly?: boolean }} input
 * @returns {Promise<{ backend: string|null, hasTypesafeKey: boolean, hasTextModelKey: boolean }>}
 */
export async function setTypesafeCredentials(profileId, { typesafeApiKey, memoryOnly = false } = {}) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const target = typesafeCredentialTarget(profileId);
  const readOpts = { memoryOnly: existing.memoryOnlyCredential, backend: existing.secretBackend };
  const current = parseTypesafeSecret(await readSecret(target, readOpts));

  // API keys never carry meaningful surrounding whitespace; trimming accepts
  // a paste with a stray newline and keeps an all-whitespace value meaning
  // "remove", the same normalization setCredential applies. The legacy
  // text-model key is never written by this op any more — only carried
  // forward exactly as stored.
  const nextSecret = {
    typesafe_api_key: typesafeApiKey === undefined ? current.typesafe_api_key : String(typesafeApiKey).trim(),
    text_model_api_key: current.text_model_api_key
  };
  const hasTypesafeKey = nextSecret.typesafe_api_key !== "";
  const hasTextModelKey = nextSecret.text_model_api_key !== "";
  const storedHadAny = current.typesafe_api_key !== "" || current.text_model_api_key !== "";
  const changed = nextSecret.typesafe_api_key !== current.typesafe_api_key;

  if (!changed) {
    // Rewriting identical values would bump credentialRevision for nothing and
    // invalidate a capability result the caller did not actually change.
    return { backend: existing.secretBackend || null, hasTypesafeKey, hasTextModelKey };
  }
  if (!hasTypesafeKey && !hasTextModelKey && storedHadAny) {
    // The transport key is now gone and no legacy text-model key remains —
    // this IS a credential removal, so it takes the revocation path (record
    // deleted, listeners fired) rather than leaving an empty JSON record
    // behind.
    await removeTypesafeCredentials(profileId);
    return { backend: null, hasTypesafeKey: false, hasTextModelKey: false };
  }

  const secretJson = serializeTypesafeSecret(nextSecret);
  const sizeBytes = Buffer.byteLength(secretJson, "utf-8");
  if (sizeBytes > TYPESAFE_MAX_SECRET_BYTES) {
    throw new ProviderError(
      "SECRET_TOO_LARGE",
      `the TypeSafe credential (${sizeBytes} bytes) exceeds the secret store's ${TYPESAFE_MAX_SECRET_BYTES}-byte limit and was not stored`
    );
  }

  const { backend } = await storeSecret(target, secretJson, { memoryOnly });

  const next = {
    ...existing,
    profileId,
    credentialRevision: (existing.credentialRevision || 0) + 1,
    // `hasCredential` means "at least one key is stored" across every
    // secret this profile can hold; the two per-key flags below exist so the
    // settings surface can report the Jev transport key's own stored-ness
    // specifically.
    hasCredential: hasTypesafeKey || hasTextModelKey || Boolean(existing.hasAnthropicKey),
    memoryOnlyCredential: backend === "memory",
    secretBackend: backend,
    hasTypesafeKey,
    hasTextModelKey
  };
  writeProfileToDisk(next);
  return { backend, hasTypesafeKey, hasTextModelKey };
}

/**
 * Remove the Jev transport secret record entirely (both the transport key
 * and the now-inert legacy text-model key it may still carry). Mirrors
 * `removeCredential` exactly: deletes the secret from whichever backend it
 * was stored in, clears the stored-ness flags, bumps `credentialRevision`
 * (so every capability result recorded for the old credential is invalidated
 * by key mismatch), clears `lastCapabilityTest`, and fires
 * `onCredentialRevoked` so in-flight runs are cancelled through the existing
 * revocation path (spec: "Credential removal during a run").
 *
 * @param {string} profileId
 */
export async function removeTypesafeCredentials(profileId) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) return;
  await deleteSecret(typesafeCredentialTarget(profileId), { memoryOnly: existing.memoryOnlyCredential, backend: existing.secretBackend });

  const next = {
    ...existing,
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    hasTypesafeKey: false,
    hasTextModelKey: false,
    credentialRevision: (existing.credentialRevision || 0) + 1,
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
 * The decision model the Jev-tools capability test (`testCapabilityForJevTools`
 * below) resolves to the transport it will actually speak, for whichever of
 * the two remaining provider types the profile is. The returned field keeps
 * its `textModel` name because every consumer already reads it under that
 * name; `kind` is what tells the runtime which wire to speak.
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {{decisionSource: "anthropic"|"chatgpt", decisionBaseUrl?: string, decisionModelId?: string}} eligible
 * @param {{decisionApiKey: string|null, purpose: "run"|"capability-test"}} opts
 */
async function resolveTypesafeDecisionModel(profile, eligible, { decisionApiKey, purpose }) {
  const { decisionSource } = eligible;
  if (decisionSource === "anthropic") {
    return {
      textModel: { kind: "anthropic", baseUrl: eligible.decisionBaseUrl, model: eligible.decisionModelId, apiKey: decisionApiKey }
    };
  }
  // decisionSource === "chatgpt": the ChatGPT subscription, through the
  // companion's own gateway — the same loopback endpoint and scoped token a
  // `chatgpt` profile's own runs use, so no ChatGPT token ever reaches this
  // snapshot.
  const gateway = await import("../chatgpt/gateway.js");
  const { port } = await gateway.ensureGatewayStarted();
  const issued = gateway.issueGatewayToken({
    profileId: profile.profileId,
    model: eligible.decisionModelId,
    credentialRevision: profile.credentialRevision || 0,
    purpose
  });
  return {
    textModel: { kind: "anthropic", baseUrl: `http://127.0.0.1:${port}`, model: eligible.decisionModelId, apiKey: issued.token },
    releaseGatewayToken: issued.release
  };
}

/**
 * The Anthropic-wire text model an `anthropic`/`chatgpt` run's Jev tools
 * (`extract_page`, `browser_subgoal`) reuse as their own text/decision model
 * (jev-tools-reuse-primary-provider design.md decision 1): the run's OWN
 * primary provider and model, derived once from the already-resolved run
 * snapshot — never a second, separately configured endpoint/model/key. For
 * an `anthropic` run this is the profile's real endpoint and API key; for a
 * `chatgpt` run it is the companion's loopback gateway with the run's own
 * already-issued gateway token (`snapshotForChatgptRun` above) — either way
 * `snapshot.env.ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` already speak the
 * Anthropic Messages wire `host/agent/jev/text-helper.js` posts a
 * `kind:"anthropic"` text model to.
 *
 * `null` for an incomplete snapshot missing a model or either env value.
 * Both resolvers below treat `null` exactly like every other unmet gate: the
 * tool is simply not offered, no error.
 *
 * @param {{ model?: string, env?: { ANTHROPIC_BASE_URL?: string, ANTHROPIC_API_KEY?: string } }} [snapshot]
 * @returns {{ kind: "anthropic", baseUrl: string, model: string, apiKey: string } | null}
 */
export function primaryTextModelFromSnapshot(snapshot) {
  if (!snapshot) return null;
  const baseUrl = snapshot.env && snapshot.env.ANTHROPIC_BASE_URL;
  const apiKey = snapshot.env && snapshot.env.ANTHROPIC_API_KEY;
  const model = snapshot.model;
  if (!baseUrl || !apiKey || !model) return null;
  return { kind: "anthropic", baseUrl, model, apiKey };
}

/**
 * The resolved Jev configuration a `browser_subgoal` sub-run needs, for an
 * `anthropic`/`chatgpt` profile — or `null` when the gate is unmet
 * (jev-tools-reuse-primary-provider design.md decision 2). ONE resolver
 * serves both the tool's registration gate (the caller treats a non-null
 * return as "offer the tool") and the sub-run's `provider` construction, so
 * the two can never disagree about what "configured" means.
 *
 * The gate is the Jev transport alone: the profile's provider type must be
 * `anthropic`/`chatgpt`, the caller must supply a `textModel` (built once by
 * `primaryTextModelFromSnapshot` from the run's own snapshot — this resolver
 * never derives one itself), and the typesafe secret record must carry a
 * saved `typesafe_api_key`. The legacy `textModel*` profile fields (kept only
 * because a profile that stored them before the standalone provider was
 * removed should not lose them) are never read here: the primary credential
 * IS the text model, and only the Jev transport keeps its own, separate key.
 *
 * The endpoint is ALWAYS `typesafeDefaultForSource(resolveTypesafeSource(profile))`
 * — never `profile.baseUrl`, which on an `anthropic`/`chatgpt` profile holds
 * the Anthropic endpoint, not a Jev one.
 *
 * `model` (the Jev transport's own model id, e.g. "jev-latest") is the fixed
 * per-source seed (`typesafeModelSeeds`) — the SAME table a `typesafe`
 * profile's model list is seeded from at provider-type switch — because an
 * `anthropic`/`chatgpt` profile's own `models`/`defaultModelId` hold its
 * conversation model, never a Jev one, and this resolver adds no new
 * persisted field to carry one (no schema-shape change). Every decision
 * request body carries `model` regardless of source (questions.js's
 * `buildSelectionRequest`/`buildDecisionRequest`), so this is not a
 * transport-specific nicety — it is required on every wire.
 *
 * This function never throws for a missing/invalid configuration — it is a
 * gate, not a run path.
 *
 * @param {string} profileId
 * @param {{ textModel?: { kind: "anthropic", baseUrl: string, model: string, apiKey: string } | null }} [opts]
 * @returns {Promise<null | {
 *   source: "typesafe"|"vercel"|"openrouter", endpoint: string, apiKey: string, model: string,
 *   decisionSource: "anthropic"|"chatgpt",
 *   textModel: { kind: "anthropic", baseUrl: string, model: string, apiKey: string },
 *   sendScreenshots: boolean, consultSources: boolean, searchSources: boolean
 * }>}
 */
export async function resolveJevBrowserSubgoalConfig(profileId, { textModel } = {}) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) return null;
  // Belt-and-suspenders: this resolver exists for an `anthropic`/`chatgpt`
  // profile only — a caller must not be able to make it resolve for any
  // other stored providerType value.
  const providerType = resolveProviderType(profile);
  if (providerType !== "anthropic" && providerType !== "chatgpt") return null;
  if (!textModel) return null;
  const secret = parseTypesafeSecret(
    await readSecret(typesafeCredentialTarget(profile.profileId), {
      memoryOnly: profile.memoryOnlyCredential,
      backend: profile.secretBackend
    })
  );
  if (!secret.typesafe_api_key) return null;
  const source = resolveTypesafeSource(profile);
  return {
    source,
    endpoint: typesafeDefaultForSource(source),
    apiKey: secret.typesafe_api_key,
    model: typesafeModelSeeds(source)[0].id,
    decisionSource: providerType,
    textModel,
    // Sourced from the DISTINCT Jev-tools toggle (default false). A
    // browser_subgoal sub-run is text-only unless the operator opts in
    // through the Jev-tools section.
    sendScreenshots: resolveJevToolsSendScreenshots(profile),
    // A subgoal never reaches the completion-check/report path that would
    // consult a source beyond the page it drives (runtime.js's subgoal mode
    // skips that path entirely), so this is always off.
    consultSources: false,
    searchSources: false
  };
}

/**
 * The resolved Jev configuration a `extract_page` SDK tool call needs, for an
 * `anthropic`/`chatgpt` profile — or `null` when the gate is unmet
 * (jev-tools-reuse-primary-provider design.md decision 2). Shares the EXACT
 * same gate as `resolveJevBrowserSubgoalConfig` above — the saved Jev
 * transport key — so the two tools are always offered together: there is no
 * longer an "extract_page only" configuration state. `extract_page` never
 * dispatches a browser action and never sends a request to the Jev
 * transport itself; it needs only the resolved text model, supplied by the
 * caller exactly like `resolveJevBrowserSubgoalConfig` receives it.
 *
 * This function never throws for a missing/invalid configuration — it is a
 * gate, not a run path.
 *
 * @param {string} profileId
 * @param {{ textModel?: { kind: "anthropic", baseUrl: string, model: string, apiKey: string } | null }} [opts]
 * @returns {Promise<null | { textModel: { kind: "anthropic", baseUrl: string, model: string, apiKey: string } }>}
 */
export async function resolveJevExtractPageConfig(profileId, { textModel } = {}) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) return null;
  // Belt-and-suspenders, same as resolveJevBrowserSubgoalConfig above: this
  // resolver exists for an `anthropic`/`chatgpt` profile only.
  const providerType = resolveProviderType(profile);
  if (providerType !== "anthropic" && providerType !== "chatgpt") return null;
  if (!textModel) return null;
  const secret = parseTypesafeSecret(
    await readSecret(typesafeCredentialTarget(profile.profileId), {
      memoryOnly: profile.memoryOnlyCredential,
      backend: profile.secretBackend
    })
  );
  if (!secret.typesafe_api_key) return null;
  return { textModel };
}

/**
 * The Jev-tools capability test for an `anthropic`/`chatgpt` profile: tests
 * the transport the Jev browser tools (`extract_page`, `browser_subgoal`)
 * actually speak. There is no run snapshot at test time, so this builds its
 * own primary text model for the profile's `defaultModelId` rather than
 * calling `primaryTextModelFromSnapshot`: for `anthropic`, `profile.baseUrl`
 * plus the primary key read from `credentialTarget`; for `chatgpt`, a
 * `purpose:"capability-test"` gateway token issued through
 * `resolveTypesafeDecisionModel`'s `chatgpt` branch, released in `finally`
 * whatever the outcome. It is then run through the shared transport sub-test
 * (`runTypesafeCapabilityTest` from host/agent/jev/capability.js): no second
 * transport is invented, and nothing here persists a profile write.
 *
 * Both tools share one gate (the saved Jev transport key) and one text
 * model, so they are reported enabled together, only when BOTH stages pass.
 * A missing default model, or a missing/rejected primary credential,
 * resolves to a text model with an empty `apiKey` (and possibly an empty
 * `baseUrl`/`model`): `postJson` (host/agent/jev/client.js) refuses a falsy
 * `apiKey` before any network attempt, so this reports a bounded
 * `textModel`-stage AUTH_ERROR — host-authored, no secret — rather than
 * throwing or making a request with a malformed body.
 *
 * The two result keys are `systemone`/`textModel`; `systemone` names the
 * TypeSafe transport probe because that is literally what it is (the same
 * `/v1/systemone` structured-choice request `resolveJevBrowserSubgoalConfig`'s
 * transport speaks).
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {{ fetchImpl?: Function, sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts] test injection only
 * @returns {Promise<{
 *   status: "pass"|"fail"|"not_configured",
 *   tools: { extract_page: boolean, browser_subgoal: boolean },
 *   capabilities: { textModel: "pass"|"fail"|"not_run", systemone: "pass"|"fail"|"not_run" },
 *   errors: { textModel?: {code:string,message:string}, systemone?: {code:string,message:string} },
 *   timestamp: string
 * }>}
 */
async function testCapabilityForJevTools(profile, { fetchImpl, sleep, now } = {}) {
  const secret = parseTypesafeSecret(
    await readSecret(typesafeCredentialTarget(profile.profileId), {
      memoryOnly: profile.memoryOnlyCredential,
      backend: profile.secretBackend
    })
  );
  if (!secret.typesafe_api_key) {
    return {
      status: "not_configured",
      tools: { extract_page: false, browser_subgoal: false },
      capabilities: { textModel: "not_run", systemone: "not_run" },
      errors: {},
      timestamp: new Date((now ? now() : Date.now())).toISOString()
    };
  }

  const providerType = resolveProviderType(profile);
  const model = profile.defaultModelId;
  const modelKnown = typeof model === "string" && model !== "" && Array.isArray(profile.models) && profile.models.some((entry) => entry.id === model);

  // A fail-closed placeholder: an empty `apiKey` makes `postJson` refuse the
  // textModel-stage request before any network attempt (AUTH_ERROR), which
  // is exactly the bounded, host-authored, secret-free failure a missing
  // default model or an unavailable primary credential should report. Only
  // replaced below when a real credential/token is actually available.
  let textModel = { kind: "anthropic", baseUrl: "", model: model || "", apiKey: "" };
  let releaseGatewayToken = null;

  if (modelKnown) {
    if (providerType === "anthropic") {
      const apiKey = await readSecret(credentialTarget(profile.profileId), {
        memoryOnly: profile.memoryOnlyCredential,
        backend: profile.secretBackend
      });
      const resolved = await resolveTypesafeDecisionModel(
        profile,
        { decisionSource: "anthropic", decisionBaseUrl: profile.baseUrl, decisionModelId: model },
        { decisionApiKey: apiKey || "", purpose: "capability-test" }
      );
      textModel = resolved.textModel;
    } else if (providerType === "chatgpt") {
      try {
        if (profile.chatgptSessionState !== "signed_in" || !profile.hasCredential) {
          throw new ProviderError("NO_CREDENTIAL", "ChatGPT sign-in is required before this test can run");
        }
        const resolved = await resolveTypesafeDecisionModel(
          profile,
          { decisionSource: "chatgpt", decisionModelId: model },
          { decisionApiKey: null, purpose: "capability-test" }
        );
        textModel = resolved.textModel;
        releaseGatewayToken = resolved.releaseGatewayToken || null;
      } catch {
        // Not signed in, or the gateway could not be reached — the fail-closed
        // placeholder above stands, reported as a bounded textModel failure
        // rather than a throw.
      }
    }
  }

  const source = resolveTypesafeSource(profile);
  const { runTypesafeCapabilityTest } = await import("../jev/capability.js");
  let raw;
  try {
    raw = await runTypesafeCapabilityTest({
      source,
      endpoint: typesafeDefaultForSource(source),
      apiKey: secret.typesafe_api_key,
      model: typesafeModelSeeds(source)[0].id,
      textModel,
      fetchImpl,
      sleep,
      now
    });
  } finally {
    // A test-scoped gateway token outlives nothing: it is released whatever
    // the stages reported.
    if (releaseGatewayToken) releaseGatewayToken();
  }

  const bothPass = raw.capabilities.textModel === "pass" && raw.capabilities.systemone === "pass";
  const tools = { extract_page: bothPass, browser_subgoal: bothPass };
  const capabilities = { textModel: raw.capabilities.textModel, systemone: raw.capabilities.systemone };
  const errors = {};
  if (raw.errors.textModel) errors.textModel = raw.errors.textModel;
  if (raw.errors.systemone) errors.systemone = raw.errors.systemone;

  return { status: bothPass ? "pass" : "fail", tools, capabilities, errors, timestamp: raw.timestamp };
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
 * The `test_capability` envelope's `target: "jev-tools"` branch
 * (jev-tools-connection-test-and-preference tasks.md 1.1/1.2): tests the Jev
 * browser-tools config attached to an `anthropic`/`chatgpt` profile,
 * separate from `testCapability()`'s own primary-provider test (spec
 * `agent-settings`: "distinct from the primary provider's connection test").
 * A profile whose provider type is neither reports `not_configured` rather
 * than throwing — the Jev-tools section is only ever shown for those two
 * provider types.
 *
 * @param {string} profileId
 * @param {{ fetchImpl?: Function, sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts] test injection only
 * @returns {ReturnType<typeof testCapabilityForJevTools>}
 */
export async function testJevToolsCapability(profileId, opts) {
  const profile = readProfileFromDisk();
  if (!profile || profile.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const providerType = resolveProviderType(profile);
  if (providerType !== "anthropic" && providerType !== "chatgpt") {
    return {
      status: "not_configured",
      tools: { extract_page: false, browser_subgoal: false },
      capabilities: { textModel: "not_run", systemone: "not_run" },
      errors: {},
      timestamp: new Date().toISOString()
    };
  }
  return testCapabilityForJevTools(profile, opts);
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

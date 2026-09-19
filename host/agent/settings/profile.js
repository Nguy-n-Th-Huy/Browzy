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
// Provider types (add-typesafe-jev-provider design.md decision 1): the two
// existing types keep their exact behavior. A `typesafe` profile additionally
// owns the non-secret text-model fields and ONE merged secret record holding
// both the TypeSafe API key and the text-model API key under
// `browzy-in-chrome/typesafe/<profileId>` — a target of its own, never the
// `anthropic` credential target above. Every typesafe entry point here keeps
// keys out of the profile record (and therefore out of
// exportProfileRedacted/the profile file by construction) and out of the
// run snapshot's `env`; only `typesafe.apiKey` / `textModel.apiKey` ever
// carry one.

import { readProfileFromDisk, writeProfileToDisk } from "./profile-store.js";
import {
  createEmptyProfile,
  capabilityTestKey,
  DEFAULT_PROFILE_ID,
  DEFAULT_TYPESAFE_BASE_URL,
  DEFAULT_TYPESAFE_GATEWAY_BASE_URL,
  DEFAULT_TYPESAFE_OPENROUTER_BASE_URL,
  DEFAULT_TYPESAFE_SOURCE,
  DEFAULT_TYPESAFE_DECISION_SOURCE,
  isKnownProviderType,
  isKnownTypesafeDecisionSource,
  isKnownTypesafeSource,
  resolveTypesafeDecisionSource,
  resolveProviderType,
  resolveConsultSources,
  resolveSendScreenshots,
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

// --- TypeSafe/Jev provider (add-typesafe-jev-provider design.md decision 1) ---
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

// The `typesafe` snapshot's `env.ANTHROPIC_BASE_URL` value (add-typesafe-jev-
// provider design.md decision 1). It is an identity MARKER, not an endpoint:
// no SDK call is ever built from a typesafe snapshot, and this exact string
// is what `buildAppProfileIdentity` records so a conversation bound to a
// typesafe profile is distinguishable from (and incompatible with) one bound
// to a real anthropic/chatgpt endpoint. `env.ANTHROPIC_API_KEY` is always the
// empty string for the same reason.
const TYPESAFE_SNAPSHOT_ENV_MARKER = "typesafe:jev";

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

// The provider's documented model entry (add-typesafe-jev-provider design.md
// decision 9 / specs/typesafe-jev-provider "Provider type and configuration
// surface"): seeded ONCE into an empty model list at the moment the provider
// type is switched to `typesafe`. Mirrors the Codex seed table below,
// including its fresh-copy rule — a caller persists the returned array, so it
// must never hand back the table entry a later switch could then mutate.
const TYPESAFE_MODEL_SEEDS = Object.freeze({
  typesafe: [{ id: "jev-latest", label: "Jev (ultrafast)" }],
  vercel: [{ id: "typesafe-ai/jev", label: "Jev (Vercel AI Gateway)" }],
  openrouter: [{ id: "typesafe/jev-1.13", label: "Jev (OpenRouter, alpha)" }]
});

/**
 * A fresh copy of the seed table for one Jev source — never the table entry
 * itself (a caller persists the returned array, exactly like the Codex seed
 * table's fresh-copy rule). An unknown source falls back to the default
 * source's seed, matching resolveTypesafeSource().
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

/**
 * The endpoint a provider-type switch should leave on the profile.
 *
 * The settings surface for a `typesafe` profile has no Anthropic Base URL
 * field (specs/agent-settings "Editable provider profile": the Base URL and
 * API-key fields are hidden for this type), so the TypeSafe endpoint comes
 * from `profile.baseUrl` — whose documented default is
 * `https://api.typesafe.ai` for the direct source and
 * `https://ai-gateway.vercel.sh` for the Vercel gateway source
 * (profile-schema.js). Only KNOWN defaults are mapped: a user-chosen
 * endpoint (a proxy, a local fixture, a custom gateway prefix) is left
 * exactly as it is in both directions, so switching types never silently
 * redirects a configured endpoint and the anthropic <-> typesafe round trip
 * returns the profile to the value it started with. The switch TO `typesafe`
 * lands on the profile's own source default, so it can never leave a
 * `vercel` profile pointing at the direct endpoint or vice versa.
 *
 * @param {string} baseUrl the profile's current endpoint
 * @param {string} providerType the type being switched TO
 * @param {string} [typesafeSource] the profile's Jev source (default direct)
 * @returns {string}
 */
function endpointForProviderSwitch(baseUrl, providerType, typesafeSource = DEFAULT_TYPESAFE_SOURCE) {
  const isTypesafeDefault = isDefaultTypesafeEndpoint(baseUrl);
  if (providerType === "typesafe" && (baseUrl === DEFAULT_BASE_URL || isTypesafeDefault)) {
    return typesafeDefaultForSource(typesafeSource);
  }
  if (providerType === "anthropic" && isTypesafeDefault) return DEFAULT_BASE_URL;
  return baseUrl;
}

/**
 * True for an endpoint still equal to SOME Jev source's documented default —
 * the test that decides whether an endpoint follows a source change or is
 * left alone as the operator's own choice. One list, so adding a source can
 * never strand a profile sitting on that source's default.
 */
function isDefaultTypesafeEndpoint(baseUrl) {
  return (
    baseUrl === DEFAULT_TYPESAFE_BASE_URL ||
    baseUrl === DEFAULT_TYPESAFE_GATEWAY_BASE_URL ||
    baseUrl === DEFAULT_TYPESAFE_OPENROUTER_BASE_URL
  );
}

/** The documented endpoint default for one Jev source. */
function typesafeDefaultForSource(source) {
  if (source === "vercel") return DEFAULT_TYPESAFE_GATEWAY_BASE_URL;
  if (source === "openrouter") return DEFAULT_TYPESAFE_OPENROUTER_BASE_URL;
  return DEFAULT_TYPESAFE_BASE_URL;
}

/**
 * Normalize an OpenAI-compatible text-model base URL.
 *
 * `normalizeBaseUrl` (url.js) deliberately strips a terminal `/v1` segment
 * because ANTHROPIC_BASE_URL is the prefix the SDK itself appends `/v1/...`
 * to. An OpenAI-compatible base URL is the opposite kind of value: the
 * text-model client posts to `{textModel.baseUrl}/chat/completions`
 * (add-typesafe-jev-provider design.md decision 5), so `/v1` IS part of the
 * configured root (`https://api.deepseek.com/v1` in the reference project)
 * and stripping it 404s every text-model call. This keeps ONE set of URL
 * rules — the same validation, loopback allowance, and trailing-slash
 * normalization — and restores the version segment when the caller's input
 * actually had one.
 *
 * @param {string} raw
 * @returns {string}
 * @throws {import("./url.js").InvalidBaseUrlError} for the same reasons normalizeBaseUrl does
 */
function normalizeTextModelBaseUrl(raw) {
  const { normalized } = normalizeBaseUrl(raw);
  let inputPath = "";
  try {
    inputPath = new URL(String(raw).trim()).pathname.replace(/\/+$/, "");
  } catch {
    // normalizeBaseUrl already rejected anything unparseable above.
  }
  return inputPath === "/v1" || inputPath.endsWith("/v1") ? `${normalized}/v1` : normalized;
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
    // The Anthropic key's own stored-ness (see setCredential): a `typesafe`
    // profile whose decision-model source is `anthropic` reuses that key, and
    // the flat flag above cannot tell the settings surface whether THIS key is
    // the one that is saved.
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
    // Non-secret TypeSafe/Jev fields (add-typesafe-jev-provider design.md
    // decision 1). `textModelBaseUrl`/`textModelId` are what a run's snapshot
    // and the capability test use; `hasTypesafeKey`/`hasTextModelKey` are the
    // stored-ness bookkeeping setTypesafeCredentials() maintains, so the
    // settings surface can report "key saved" without a key ever crossing a
    // reply. A profile that predates these fields (or is not `typesafe`)
    // loads with the empty defaults.
    textModelBaseUrl: stored.textModelBaseUrl || null,
    textModelId: stored.textModelId || null,
    hasTypesafeKey: Boolean(stored.hasTypesafeKey),
    hasTextModelKey: Boolean(stored.hasTextModelKey),
    // The persisted Jev source ("typesafe" | "vercel"); a profile saved
    // before the field existed loads as the default source
    // (resolveTypesafeSource(), profile-schema.js's TYPESAFE_SOURCES).
    typesafeSource: resolveTypesafeSource(stored),
    // The decision-model source and its own two non-secret fields. A profile
    // saved before the choice existed loads as `openai` with its text-model
    // configuration unchanged, so its behaviour is exactly what it was.
    typesafeDecisionSource: resolveTypesafeDecisionSource(stored),
    typesafeDecisionBaseUrl: stored.typesafeDecisionBaseUrl || null,
    typesafeDecisionModelId: stored.typesafeDecisionModelId || null,
    // The screenshot toggle (openspec/changes/add-jev-run-screenshots
    // design.md decision 4): resolved here, so every reader of this snapshot —
    // the settings surface and the run snapshot — sees the documented default
    // (enabled) on a profile stored before the field existed.
    sendScreenshots: resolveSendScreenshots(stored),
    // Whether runs on this profile may read documents beyond the page they
    // drive; resolved here so every reader sees the documented default.
    consultSources: resolveConsultSources(stored)
  };
}

/**
 * Switch a profile's provider type between `anthropic`, `chatgpt`, and
 * `typesafe`. It never touches the credential or (for `chatgpt`) the
 * signed-in account, and a user-chosen endpoint survives every switch;
 * switching back and forth is nondestructive. Rejects any value other than
 * the known types so a caller can never persist a typo that would later load
 * as `INVALID_PROFILE`.
 *
 * Two additions for `typesafe` (specs/typesafe-jev-provider "Provider type
 * and configuration surface"):
 *   - when — and only when — the model list is STILL EMPTY at the moment of
 *     the switch, it is seeded with the documented entry for the profile's
 *     Jev source (`jev-latest` direct, `typesafe-ai/jev` for the Vercel
 *     gateway) as both the list and the default model. An existing or
 *     user-edited list is never overwritten, so switching back and forth
 *     cannot clobber a manual list and re-selecting `typesafe` cannot re-seed
 *     it.
 *   - the endpoint follows the provider's documented default (see
 *     `endpointForProviderSwitch`).
 *
 * @param {string} profileId
 * @param {string} providerType `anthropic`, `chatgpt`, or `typesafe`
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 */
export async function setProviderType(profileId, providerType) {
  if (!isKnownProviderType(providerType)) {
    throw new Error(`unknown provider type: ${providerType}`);
  }
  const existing = readProfileFromDisk() || createEmptyProfile(profileId);
  const seed =
    providerType === "typesafe" && (!Array.isArray(existing.models) || existing.models.length === 0)
      ? typesafeModelSeeds(resolveTypesafeSource(existing))
      : null;
  const next = {
    ...existing,
    profileId,
    providerType,
    baseUrl: endpointForProviderSwitch(existing.baseUrl, providerType, resolveTypesafeSource(existing)),
    models: seed || existing.models,
    defaultModelId: seed ? seed[0].id : existing.defaultModelId,
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
 * Persist a `typesafe` profile's NON-SECRET configuration
 * (add-typesafe-jev-provider design.md decision 9): the Jev source
 * (`typesafe` direct or `vercel` AI Gateway), the TypeSafe endpoint
 * (reusing `profile.baseUrl`, so a caller that does not send one keeps the
 * endpoint the profile already had), the text-model base URL / model ID, and
 * the screenshot toggle
 * (openspec/changes/add-jev-run-screenshots). Never touches either key —
 * those live only in the merged secret record below.
 *
 * The endpoint follows the source, exactly as `endpointForProviderSwitch`
 * makes it follow a provider-type switch: when the caller sends no endpoint
 * and the stored one is still a KNOWN default, a source change moves it to
 * the new source's default (`https://api.typesafe.ai` <->
 * `https://ai-gateway.vercel.sh`); a user-chosen endpoint is never
 * redirected. The model list gets the same treatment in miniature — a source
 * change replaces it ONLY when it is exactly the previous source's untouched
 * seed, so a user-edited list always survives.
 *
 * The text-model base URL goes through the SAME `normalizeBaseUrl` rules as
 * the anthropic Base URL (HTTPS, or plain HTTP only to an explicit loopback
 * host; no userinfo/query/fragment), and the model ID must be nonempty: both
 * are required before a run or a capability test is attempted (specs/
 * typesafe-jev-provider "Provider type and configuration surface").
 *
 * A configuration change CLEARS `lastCapabilityTest` — the same rule
 * `saveProfile` applies to an endpoint/model edit. A recorded pass must not
 * survive the configuration it was recorded against, and the stored keys are
 * scoped to (baseUrl, modelId, credentialRevision) anyway, so clearing only
 * prevents the file from accumulating entries no longer reachable.
 *
 * @param {string} profileId
 * @param {{ baseUrl?: string, typesafeSource?: string, textModelBaseUrl: string, textModelId: string, sendScreenshots?: boolean }} input
 * @returns {Promise<ReturnType<typeof loadProfile>>}
 * @throws {import("./url.js").InvalidBaseUrlError} code INVALID_BASE_URL on a bad URL (field-level for the UI)
 * @throws {ProviderError} INVALID_PROFILE when the source is unknown, the text-model ID is empty, or the screenshot toggle is not a boolean
 */
export async function setTypesafeConfig(
  profileId,
  { baseUrl, typesafeSource, textModelBaseUrl, textModelId, sendScreenshots, consultSources, decisionSource, decisionBaseUrl, decisionModelId } = {}
) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  if (typesafeSource !== undefined && !isKnownTypesafeSource(typesafeSource)) {
    throw new ProviderError("INVALID_PROFILE", `unknown TypeSafe source "${typesafeSource}"`);
  }
  if (decisionSource !== undefined && !isKnownTypesafeDecisionSource(decisionSource)) {
    throw new ProviderError("INVALID_PROFILE", `unknown decision-model source "${decisionSource}"`);
  }
  // The screenshot toggle (add-jev-run-screenshots design.md decision 4). An
  // OMITTED value keeps the stored one (resolved, so a profile that predates
  // the field persists the documented enabled default the first time this
  // runs); a non-boolean is refused rather than coerced, like every other
  // field here. It is NOT part of `configChanged` below: the toggle does not
  // change what the capability test talks to, so flipping it must not discard
  // a recorded (endpoint, model, credential revision) result.
  if (sendScreenshots !== undefined && typeof sendScreenshots !== "boolean") {
    throw new ProviderError("INVALID_PROFILE", "the sendScreenshots toggle must be a boolean");
  }
  if (consultSources !== undefined && typeof consultSources !== "boolean") {
    throw new ProviderError("INVALID_PROFILE", "the consultSources toggle must be a boolean");
  }
  const cleanSendScreenshots = sendScreenshots === undefined ? resolveSendScreenshots(existing) : sendScreenshots;
  const cleanConsultSources = consultSources === undefined ? resolveConsultSources(existing) : consultSources;
  const previousSource = resolveTypesafeSource(existing);
  const cleanSource = typesafeSource === undefined ? previousSource : typesafeSource;
  const sourceChanged = cleanSource !== previousSource;

  const previousDecisionSource = resolveTypesafeDecisionSource(existing);
  const cleanDecisionSource = decisionSource === undefined ? previousDecisionSource : decisionSource;

  // The OpenAI-compatible text model is required only while it IS the decision
  // model. On the other sources its stored values are carried forward
  // untouched, so switching back does not ask for them again.
  // An empty pair from a surface that is showing another source's fields is
  // "not given", not "cleared": normalizing "" would fail URL validation and
  // block a save that has nothing to do with the text model.
  const textFieldsGiven =
    (typeof textModelBaseUrl === "string" && textModelBaseUrl.trim() !== "") ||
    (typeof textModelId === "string" && textModelId.trim() !== "");
  let normalizedTextModelBaseUrl = existing.textModelBaseUrl || "";
  let cleanTextModelId = typeof existing.textModelId === "string" ? existing.textModelId.trim() : "";
  if (cleanDecisionSource === "openai" || textFieldsGiven) {
    normalizedTextModelBaseUrl = normalizeTextModelBaseUrl(textModelBaseUrl);
    cleanTextModelId = typeof textModelId === "string" ? textModelId.trim() : "";
    if (cleanDecisionSource === "openai" && !cleanTextModelId) {
      throw new ProviderError("INVALID_PROFILE", "the text-model model ID must be a nonempty model id");
    }
  }

  // The Anthropic-standard sources' own two non-secret fields, validated only
  // when that source is the selected one.
  let cleanDecisionBaseUrl = existing.typesafeDecisionBaseUrl || "";
  if (decisionBaseUrl !== undefined && decisionBaseUrl !== null) {
    cleanDecisionBaseUrl = decisionBaseUrl === "" ? "" : normalizeBaseUrl(decisionBaseUrl).normalized;
  }
  let cleanDecisionModelId =
    typeof existing.typesafeDecisionModelId === "string" ? existing.typesafeDecisionModelId.trim() : "";
  if (decisionModelId !== undefined && decisionModelId !== null) {
    cleanDecisionModelId = typeof decisionModelId === "string" ? decisionModelId.trim() : "";
  }
  if (cleanDecisionSource !== "openai" && !cleanDecisionModelId) {
    throw new ProviderError("INVALID_PROFILE", "the decision model's model ID must be a nonempty model id");
  }
  if (cleanDecisionSource === "anthropic" && !cleanDecisionBaseUrl) {
    throw new ProviderError("INVALID_PROFILE", "the decision model's base URL must be configured");
  }

  let cleanBaseUrl;
  if (baseUrl !== undefined && baseUrl !== null) {
    cleanBaseUrl = normalizeBaseUrl(baseUrl).normalized;
  } else if (sourceChanged && isDefaultTypesafeEndpoint(existing.baseUrl)) {
    cleanBaseUrl = typesafeDefaultForSource(cleanSource);
  } else {
    cleanBaseUrl = existing.baseUrl;
  }

  // A model list still exactly equal to the previous source's seed follows
  // the source; anything the user edited or added never does.
  let cleanModels = existing.models;
  let cleanDefaultModelId = existing.defaultModelId;
  if (sourceChanged) {
    const previousSeed = typesafeModelSeeds(previousSource);
    const untouchedSeed =
      Array.isArray(existing.models) &&
      existing.models.length === previousSeed.length &&
      existing.models.every((m, i) => m && m.id === previousSeed[i].id && m.label === previousSeed[i].label);
    if (untouchedSeed) {
      const nextSeed = typesafeModelSeeds(cleanSource);
      cleanModels = nextSeed;
      cleanDefaultModelId = nextSeed[0].id;
    }
  }

  const configChanged =
    existing.baseUrl !== cleanBaseUrl ||
    previousSource !== cleanSource ||
    existing.textModelBaseUrl !== normalizedTextModelBaseUrl ||
    existing.textModelId !== cleanTextModelId ||
    cleanModels !== existing.models;

  const next = {
    ...existing,
    profileId,
    baseUrl: cleanBaseUrl,
    typesafeSource: cleanSource,
    models: cleanModels,
    defaultModelId: cleanDefaultModelId,
    textModelBaseUrl: normalizedTextModelBaseUrl,
    typesafeDecisionSource: cleanDecisionSource,
    typesafeDecisionBaseUrl: cleanDecisionBaseUrl,
    typesafeDecisionModelId: cleanDecisionModelId,
    textModelId: cleanTextModelId,
    sendScreenshots: cleanSendScreenshots,
    consultSources: cleanConsultSources,
    revision: existing.revision + 1,
    lastCapabilityTest: configChanged ? {} : existing.lastCapabilityTest
  };
  writeProfileToDisk(next);
  return loadProfile();
}

/**
 * Store (or replace) the `typesafe` profile's TypeSafe and/or text-model API
 * key (add-typesafe-jev-provider design.md decisions 1 and 9). Write-only:
 * the caller hands over values, and all that ever comes back are booleans —
 * never a key, old or new.
 *
 * Both keys live in ONE JSON secret record at
 * `browzy-in-chrome/typesafe/<profileId>`. An OMITTED key keeps its stored
 * value; an explicit empty string REMOVES it. The merge is computed against
 * the parsed stored record, so a caller can rotate one key without having to
 * resend the other, and clearing the last remaining key removes the whole
 * record (delegating to removeTypesafeCredentials, which also fires the
 * revocation listeners — a run in flight just lost its key).
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
 * @param {{ typesafeApiKey?: string, textModelApiKey?: string, memoryOnly?: boolean }} input
 * @returns {Promise<{ backend: string|null, hasTypesafeKey: boolean, hasTextModelKey: boolean }>}
 */
export async function setTypesafeCredentials(profileId, { typesafeApiKey, textModelApiKey, memoryOnly = false } = {}) {
  const existing = readProfileFromDisk();
  if (!existing || existing.profileId !== profileId) {
    throw new ProviderError("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
  }
  const target = typesafeCredentialTarget(profileId);
  const readOpts = { memoryOnly: existing.memoryOnlyCredential, backend: existing.secretBackend };
  const current = parseTypesafeSecret(await readSecret(target, readOpts));

  // API keys never carry meaningful surrounding whitespace; trimming both
  // accepts a paste with a stray newline and keeps an all-whitespace value
  // meaning "remove", the same normalization setCredential applies.
  const nextSecret = {
    typesafe_api_key: typesafeApiKey === undefined ? current.typesafe_api_key : String(typesafeApiKey).trim(),
    text_model_api_key: textModelApiKey === undefined ? current.text_model_api_key : String(textModelApiKey).trim()
  };
  const hasTypesafeKey = nextSecret.typesafe_api_key !== "";
  const hasTextModelKey = nextSecret.text_model_api_key !== "";
  const storedHadAny = current.typesafe_api_key !== "" || current.text_model_api_key !== "";
  const changed = nextSecret.typesafe_api_key !== current.typesafe_api_key || nextSecret.text_model_api_key !== current.text_model_api_key;

  if (!changed) {
    // Rewriting identical values would bump credentialRevision for nothing and
    // invalidate a capability result the caller did not actually change.
    return { backend: existing.secretBackend || null, hasTypesafeKey, hasTextModelKey };
  }
  if (!hasTypesafeKey && !hasTextModelKey && storedHadAny) {
    // Both keys are now gone — this IS a credential removal, so it takes the
    // revocation path (record deleted, listeners fired) rather than leaving an
    // empty JSON record behind.
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
    // One profile record, one stored-ness triple: for a `typesafe` profile
    // this secret is the only one, so the generic flags describe it.
    // `hasCredential` means "at least one key is stored"; a run additionally
    // requires BOTH (snapshotForRun's NO_CREDENTIAL), which is why the two
    // per-key flags exist for the settings surface to gate on.
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
 * Remove the `typesafe` profile's stored key record. Mirrors
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
 * Preconditions shared by `snapshotForTypesafeRun` and
 * `testCapabilityForTypesafe` (specs/typesafe-jev-provider "Provider type and
 * configuration surface": the text-model base URL and ID are required,
 * nonempty settings before a run or a capability test is attempted). Resolves
 * the model to use and asserts the text-model configuration exists — never
 * reads a key, so both callers can report `INVALID_PROFILE` before any
 * credential question is asked.
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} [modelId]
 * @returns {{ model: string, textModelId: string, textModelBaseUrl: string }}
 */
function requireTypesafeEligible(profile, modelId) {
  const model = modelId || profile.defaultModelId;
  if (!model) {
    throw new ProviderError("NO_CREDENTIAL", "no model was requested and the profile has no default model");
  }
  if (!profile.models.some((entry) => entry.id === model)) {
    throw new ProviderError("INVALID_PROFILE", `model "${model}" is not in the profile's model list`);
  }
  // Only the SELECTED decision source has to be configured: an operator who
  // runs decisions on their Anthropic key or their ChatGPT subscription is
  // never asked for an OpenAI-compatible text model as well.
  const decisionSource = resolveTypesafeDecisionSource(profile);
  if (decisionSource === "openai") {
    if (!profile.textModelBaseUrl) {
      throw new ProviderError("INVALID_PROFILE", "the text-model base URL must be configured before running");
    }
    const textModelId = typeof profile.textModelId === "string" ? profile.textModelId.trim() : "";
    if (!textModelId) {
      throw new ProviderError("INVALID_PROFILE", "the text-model model ID must be configured before running");
    }
    return { model, decisionSource, textModelId, textModelBaseUrl: profile.textModelBaseUrl };
  }
  const decisionModelId = typeof profile.typesafeDecisionModelId === "string" ? profile.typesafeDecisionModelId.trim() : "";
  if (!decisionModelId) {
    throw new ProviderError("INVALID_PROFILE", "the decision model's model ID must be configured before running");
  }
  if (decisionSource === "anthropic" && !profile.typesafeDecisionBaseUrl) {
    throw new ProviderError("INVALID_PROFILE", "the decision model's base URL must be configured before running");
  }
  if (decisionSource === "chatgpt") {
    // The same sign-in state a `chatgpt` profile's runs require, checked here
    // so the failure names the sign-in rather than surfacing as a gateway 401
    // in the middle of a run.
    if (profile.chatgptSessionState === "session_expired") {
      throw new ProviderError("SESSION_EXPIRED", "the ChatGPT session expired — sign in with ChatGPT again");
    }
    if (profile.chatgptSessionState !== "signed_in" || !profile.hasCredential) {
      throw new ProviderError("NO_CREDENTIAL", "ChatGPT sign-in is required before this profile can run its decisions");
    }
  }
  return { model, decisionSource, decisionModelId, decisionBaseUrl: profile.typesafeDecisionBaseUrl };
}

/**
 * Read the merged typesafe secret and require BOTH keys.
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @returns {Promise<{ typesafeApiKey: string, textModelApiKey: string }>}
 * @throws {ProviderError} NO_CREDENTIAL naming whichever key is missing.
 */
async function readTypesafeKeys(profile, { decisionSource = DEFAULT_TYPESAFE_DECISION_SOURCE } = {}) {
  const target = typesafeCredentialTarget(profile.profileId);
  const secret = parseTypesafeSecret(
    await readSecret(target, { memoryOnly: profile.memoryOnlyCredential, backend: profile.secretBackend })
  );
  if (!secret.typesafe_api_key) {
    throw new ProviderError("NO_CREDENTIAL", "the TypeSafe API key must be saved before this profile can run");
  }
  // The decision model's credential follows its source: the text-model key in
  // this same record for `openai`, the profile's own Anthropic key for
  // `anthropic`, and a gateway token issued per run for `chatgpt` (resolved by
  // the snapshot, not here — it is not a stored secret).
  if (decisionSource === "openai") {
    if (!secret.text_model_api_key) {
      throw new ProviderError("NO_CREDENTIAL", "the text-model API key must be saved before this profile can run");
    }
    return { typesafeApiKey: secret.typesafe_api_key, decisionApiKey: secret.text_model_api_key };
  }
  if (decisionSource === "anthropic") {
    const key = await readSecret(credentialTarget(profile.profileId), {
      memoryOnly: profile.memoryOnlyCredential,
      backend: profile.secretBackend
    });
    if (!key) {
      throw new ProviderError("NO_CREDENTIAL", "the decision model's Anthropic API key must be saved before this profile can run");
    }
    return { typesafeApiKey: secret.typesafe_api_key, decisionApiKey: key };
  }
  return { typesafeApiKey: secret.typesafe_api_key, decisionApiKey: null };
}

/**
 * The `typesafe` branch of `snapshotForRun` (add-typesafe-jev-provider
 * design.md decision 1). Returns the pinned superset shape: `runtime` marks
 * the snapshot as belonging to the Jev path (`companion.js` branches on it
 * and never builds an SDK query from this snapshot), `env` carries ONLY the
 * identity marker — a fixed non-URL string plus an empty key — so the shared
 * identity machinery records a stable conversation identity without a key
 * ever entering the SDK environment, and the two real keys sit under
 * `typesafe.apiKey` / `textModel.apiKey`, which exist only in this
 * host-memory object. `typesafe.source` carries the resolved Jev source
 * (`typesafe` | `vercel`) so the companion hands the runtime exactly the wire
 * the capability test proved, and `sendScreenshots` carries the resolved
 * screenshot toggle the companion passes on to the runtime's provider object
 * (add-jev-run-screenshots design.md decision 4).
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} [modelId]
 */
/**
 * The decision model of a `typesafe` profile, resolved to the transport a
 * caller will actually speak. ONE resolver serves the run snapshot and the
 * settings capability test, so a probe can never prove a wire the run does
 * not use.
 *
 * The returned field keeps its `textModel` name because every consumer
 * already reads it under that name, and it is still the model that writes the
 * run's text answers; `kind` is what tells the runtime which wire to speak.
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {{decisionSource: string, textModelBaseUrl?: string, textModelId?: string, decisionBaseUrl?: string, decisionModelId?: string}} eligible
 * @param {{decisionApiKey: string|null, purpose: "run"|"capability-test"}} opts
 */
async function resolveTypesafeDecisionModel(profile, eligible, { decisionApiKey, purpose }) {
  const { decisionSource } = eligible;
  if (decisionSource === "openai") {
    return {
      textModel: { kind: "openai", baseUrl: eligible.textModelBaseUrl, model: eligible.textModelId, apiKey: decisionApiKey }
    };
  }
  if (decisionSource === "anthropic") {
    return {
      textModel: { kind: "anthropic", baseUrl: eligible.decisionBaseUrl, model: eligible.decisionModelId, apiKey: decisionApiKey }
    };
  }
  // The ChatGPT subscription, through the companion's own gateway — the same
  // loopback endpoint and scoped token a `chatgpt` profile uses, so no ChatGPT
  // token ever reaches this snapshot.
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
 * The stored `search` capability for one profile/model pair, or false when no
 * test covering this exact configuration has passed it.
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} model
 */
function resolveSearchCapability(profile, model) {
  const key = capabilityTestKey({ baseUrl: profile.baseUrl, modelId: model, credentialRevision: profile.credentialRevision || 0 });
  return profile.lastCapabilityTest?.[key]?.capabilities?.search === "pass";
}

async function snapshotForTypesafeRun(profile, modelId) {
  const eligible = requireTypesafeEligible(profile, modelId);
  const { model, decisionSource } = eligible;
  const { typesafeApiKey, decisionApiKey } = await readTypesafeKeys(profile, { decisionSource });
  const { textModel, releaseGatewayToken } = await resolveTypesafeDecisionModel(profile, eligible, {
    decisionApiKey,
    purpose: "run"
  });

  return {
    runtime: "typesafe",
    model,
    env: {
      ANTHROPIC_BASE_URL: TYPESAFE_SNAPSHOT_ENV_MARKER,
      ANTHROPIC_API_KEY: ""
    },
    typesafe: { source: resolveTypesafeSource(profile), endpoint: profile.baseUrl, apiKey: typesafeApiKey },
    decisionSource,
    textModel,
    ...(releaseGatewayToken ? { releaseGatewayToken } : {}),
    // The screenshot toggle (add-jev-run-screenshots design.md decision 4),
    // resolved to the documented default so the companion hands the runtime a
    // plain boolean and never re-derives the profile's default itself.
    sendScreenshots: resolveSendScreenshots(profile),
    consultSources: resolveConsultSources(profile),
    // Whether the decision-model source can run a provider-side web search,
    // taken from the capability test this exact configuration passed — never
    // from the source's name, and never a claim this function makes on its
    // own. The stored result is keyed by (baseUrl, modelId, credentialRevision),
    // so changing the endpoint, the model, or the credential drops the claim
    // with it and a profile that was never tested simply reports false.
    searchSources: resolveSearchCapability(profile, model),
    revision: profile.revision,
    profileId: profile.profileId,
    credentialRevision: profile.credentialRevision || 0
  };
}

/**
 * The `typesafe` branch of `testCapability` (spec: "For a `typesafe`
 * profile, the test SHALL issue one trivial structured-choice request to the
 * configured TypeSafe endpoint and one minimal completion to the configured
 * text model, reporting their outcomes separately under the same result
 * shape used for other providers"). Delegates the two stages to
 * host/agent/jev/capability.js — which always attempts both independently and
 * classifies provider failures into the result instead of throwing — and
 * records the combined result under the SAME
 * (baseUrl, modelId, credentialRevision) key the anthropic branch uses, so a
 * changed endpoint, model, or credential invalidates it naturally.
 *
 * @param {ReturnType<typeof readProfileFromDisk>} profile
 * @param {string} [modelId]
 */
async function testCapabilityForTypesafe(profile, modelId) {
  const eligible = requireTypesafeEligible(profile, modelId);
  const { model, decisionSource } = eligible;
  const { typesafeApiKey, decisionApiKey } = await readTypesafeKeys(profile, { decisionSource });
  const { textModel, releaseGatewayToken } = await resolveTypesafeDecisionModel(profile, eligible, {
    decisionApiKey,
    purpose: "capability-test"
  });
  const { runTypesafeCapabilityTest } = await import("../jev/capability.js");
  let result;
  try {
    result = await runTypesafeCapabilityTest({
      source: resolveTypesafeSource(profile),
      endpoint: profile.baseUrl,
      apiKey: typesafeApiKey,
      model,
      textModel
    });
  } finally {
    // A test-scoped gateway token outlives nothing: it is released whatever
    // the stages reported.
    if (releaseGatewayToken) releaseGatewayToken();
  }

  const key = capabilityTestKey({ baseUrl: profile.baseUrl, modelId: model, credentialRevision: profile.credentialRevision || 0 });
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
 * A `typesafe` profile returns a SUPERSET of this shape instead (see
 * `snapshotForTypesafeRun`): same `model`/`revision`/`profileId`/
 * `credentialRevision`, but `runtime: "typesafe"` plus the `typesafe`/
 * `textModel` keyed sub-objects, with `env` reduced to the identity marker.
 * An `anthropic`/`chatgpt` snapshot is unchanged by that addition.
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
  if (providerType === "typesafe") {
    return snapshotForTypesafeRun(profile, modelId);
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
  if (providerType === "typesafe") {
    // Same answer, for the same reason: TypeSafe/Jev offers no model-listing
    // endpoint either, so discovery reports unsupported and the manual list
    // (seeded with `jev-latest` on switch) stays editable
    // (add-typesafe-jev-provider specs/agent-settings "Manual model catalog
    // with optional discovery"). No credential is read to answer this.
    return { supported: false, reason: "TypeSafe profiles have no model-listing endpoint; the model list stays manually editable" };
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
  if (providerType === "typesafe") {
    return testCapabilityForTypesafe(profile, modelId);
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
  if (providerType !== "anthropic" && providerType !== "chatgpt" && providerType !== "typesafe") return false;
  // A `chatgpt` profile's capability-test results are keyed by a fixed
  // marker rather than a real endpoint URL (profile-schema.js), so this key
  // computation must match whatever a `chatgpt` testCapability() eventually
  // records it under, even though no `chatgpt` profile can pass a
  // capability test yet. A `typesafe` result is keyed by the profile's real
  // endpoint (its decision requests go straight to that host), exactly like
  // `anthropic`.
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

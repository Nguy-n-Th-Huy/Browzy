// Non-secret profile schema (design.md decision 4).
//
// Persisted fields: profile ID, normalized base URL, model entries
// `{id, label}`, default model ID, revision, and last capability-test result
// keyed by endpoint/model/credential revision. No secret ever lives in this
// object — see host/agent/secrets/ for the credential, which is stored
// separately in the OS credential store (or memory-only) and never
// serialized here.
//
// Provider type (add-chatgpt-subscription-provider design.md decision 5):
// a profile also carries `providerType`, either `anthropic` (the only type
// that ever existed before, and the default a profile with no such field
// loads as) or `chatgpt`. `chatgptAccount` is the ChatGPT profile's
// non-secret companion field — signed-in email and plan type, read once from
// the ID token by host/agent/chatgpt/auth.js — never the credential itself.
//
// The Jev engine is reached only through the `extract_page`/`browser_subgoal`
// tools on an `anthropic`/`chatgpt` profile, never as a provider type of its
// own. Those tools reuse the profile's own primary text model, and need only
// ONE piece of profile state of their own: a saved Jev transport key. That
// key (plus a now-inert legacy text-model key kept only so nothing already
// stored is discarded) lives in ONE secret record under the dedicated target
// `browzy-in-chrome/typesafe/<profileId>` (host/agent/settings/profile.js) —
// never in this object, never in `baseUrl`'s place. A profile stored with the
// removed `typesafe` provider type migrates to `anthropic` the first time it
// is read (migrateStoredTypesafeProfile below) — that secret record is never
// touched by the migration, so a saved Jev transport key keeps enabling the
// Jev browser tools exactly as before.

import { DEFAULT_BASE_URL } from "./url.js";

export const PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE_ID = "default";

export const PROVIDER_TYPES = /** @type {const} */ (["anthropic", "chatgpt"]);
export const DEFAULT_PROVIDER_TYPE = "anthropic";

// The Jev transport's documented endpoint default for its own System One
// source. Exported so the Jev browser tools' resolvers (host/agent/settings/
// profile.js's `typesafeDefaultForSource`) never guess an endpoint of their
// own — the endpoint always follows the profile's persisted `typesafeSource`.
export const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai";

// The Vercel AI Gateway endpoint the Jev transport uses when its source is
// `vercel` (see TYPESAFE_SOURCES below). Exported for the same reason as the
// direct default above.
export const DEFAULT_TYPESAFE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

// The OpenRouter endpoint the Jev transport uses when its source is
// `openrouter`. Exported for the same reason as the other two defaults.
// OpenRouter publishes the decision route under `/api/alpha/`, so this source
// is the one whose protocol is expected to move.
export const DEFAULT_TYPESAFE_OPENROUTER_BASE_URL = "https://openrouter.ai";

// The ways the Jev browser tools (`extract_page`, `browser_subgoal`) reach
// the Jev transport. `typesafe` is the provider's own System One endpoint
// (`POST /v1/systemone`, a TypeSafe API key); `vercel` is the Vercel AI
// Gateway's evaluation endpoint (`POST /v4/ai/evaluation-model`, a Vercel AI
// Gateway key); `openrouter` is OpenRouter's decision route
// (`POST /api/alpha/decisions`, an OpenRouter key) — the same typed questions
// and answers over different wire protocols (see host/agent/jev/client.js's
// source paths). Jev is never reachable through any of these providers'
// chat-completion or Messages ports: it is an evaluation model, and those
// ports refuse it. The profile persists the choice; every consumer branches
// on it, and nothing sniffs the endpoint URL to guess.
export const TYPESAFE_SOURCES = /** @type {const} */ (["typesafe", "vercel", "openrouter"]);
export const DEFAULT_TYPESAFE_SOURCE = "typesafe";

// The Jev-tools screenshot toggle: controls ONLY whether a `browser_subgoal`
// sub-run (on an `anthropic`/`chatgpt` profile) captures a screenshot for its
// optional planning/content model — Jev's own action selection never
// receives it either way. Opt-IN: only an explicit `true` enables it, so a
// profile stored before this field existed (or one that never touched it)
// loads DISABLED, and a `browser_subgoal` sub-run is text-only by default.
export const DEFAULT_JEV_TOOLS_SEND_SCREENSHOTS = false;

/**
 * @param {{ jevToolsSendScreenshots?: unknown }} profile
 * @returns {boolean} the resolved toggle: disabled unless explicitly on.
 */
export function resolveJevToolsSendScreenshots(profile) {
  return Boolean(profile && profile.jevToolsSendScreenshots === true);
}

/**
 * @param {unknown} source
 * @returns {boolean} true only for one of the exact known Jev sources.
 */
export function isKnownTypesafeSource(source) {
  return TYPESAFE_SOURCES.includes(source);
}

// The capability-test key (see capabilityTestKey() below) is normally keyed
// by the real endpoint URL. A `chatgpt` profile has no endpoint URL of its
// own — every request goes through the loopback gateway on a port that
// changes every companion start — so its capability-test results are keyed
// by this fixed marker instead. A new sign-in still invalidates any prior
// result naturally, because it bumps `credentialRevision`, which is also
// part of the key.
export const CHATGPT_CAPABILITY_TEST_MARKER = "chatgpt:codex";

/**
 * @param {unknown} providerType
 * @returns {boolean} true only for one of the exact known provider types.
 */
export function isKnownProviderType(providerType) {
  return PROVIDER_TYPES.includes(providerType);
}

/**
 * A profile persisted before provider types existed has no `providerType`
 * field at all; it loads as `anthropic`, unchanged in every other field
 * (spec: "Existing profile after upgrade"). A profile that already carries
 * some other value — including one this version doesn't recognize — keeps it
 * verbatim: only *absence* is defaulted, so an unrecognized stored value
 * stays visible to isKnownProviderType() instead of being silently coerced
 * into looking valid. Callers on the run path use this to decide a stored
 * profile is not runnable (`INVALID_PROFILE`) rather than crashing.
 * @param {{ providerType?: unknown }} profile
 * @returns {string}
 */
export function resolveProviderType(profile) {
  return (profile && profile.providerType) || DEFAULT_PROVIDER_TYPE;
}

/**
 * @param {string} [profileId]
 * @returns the initial, empty profile: default Base URL, no models, no
 *   credential revision yet, never a guessed model, `anthropic` provider
 *   type, no ChatGPT account, no Jev transport key, and the Jev-tools
 *   screenshot toggle at its disabled default.
 */
export function createEmptyProfile(profileId = DEFAULT_PROFILE_ID) {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId,
    providerType: DEFAULT_PROVIDER_TYPE,
    baseUrl: DEFAULT_BASE_URL,
    models: [],
    defaultModelId: null,
    revision: 0,
    credentialRevision: 0,
    memoryOnlyCredential: false,
    lastCapabilityTest: {},
    chatgptAccount: null,
    // The now-inert legacy text-model fields, kept only so a profile that
    // stored one before the standalone Jev provider was removed does not
    // lose it. Nothing reads these to build a request any more.
    textModelBaseUrl: null,
    textModelId: null,
    // The Jev transport key's own stored-ness (settings surface reads this
    // instead of ever seeing the key). `hasTextModelKey` is the same
    // now-inert bookkeeping as `textModelBaseUrl`/`textModelId` above.
    hasTypesafeKey: false,
    hasTextModelKey: false,
    // The persisted Jev source choice (TYPESAFE_SOURCES above), read by the
    // Jev browser tools' resolvers; absent on a profile saved before it
    // existed, which every reader treats as this default.
    typesafeSource: DEFAULT_TYPESAFE_SOURCE,
    // The Jev-tools screenshot toggle (DEFAULT_JEV_TOOLS_SEND_SCREENSHOTS
    // below) — stored as a plain boolean and resolved through
    // resolveJevToolsSendScreenshots() on every read, so "absent" and
    // "explicitly disabled" are the same state.
    jevToolsSendScreenshots: DEFAULT_JEV_TOOLS_SEND_SCREENSHOTS
  };
}

// The Jev transport's documented model entry per source — seeded ONCE into
// an `anthropic`/`chatgpt` run's Jev-tools resolvers (host/agent/settings/
// profile.js's `typesafeModelSeeds`/`typesafeDefaultForSource`) as the fixed
// model id every decision request on that source carries. Also the shape a
// stored model list is compared against by `migrateStoredTypesafeProfile`
// below, to tell an untouched seed apart from a list the operator edited.
export const TYPESAFE_MODEL_SEEDS = Object.freeze({
  typesafe: [{ id: "jev-latest", label: "Jev (ultrafast)" }],
  vercel: [{ id: "typesafe-ai/jev", label: "Jev (Vercel AI Gateway)" }],
  openrouter: [{ id: "typesafe/jev-1.13", label: "Jev (OpenRouter, alpha)" }]
});

/**
 * True when `models` is exactly one Jev source's untouched seed list — the
 * test `migrateStoredTypesafeProfile` uses to tell an operator-edited model
 * list apart from a list nobody ever touched after the switch that seeded it.
 * @param {unknown} models
 * @returns {boolean}
 */
function isTypesafeSeedModelList(models) {
  if (!Array.isArray(models)) return false;
  return Object.values(TYPESAFE_MODEL_SEEDS).some(
    (seed) => models.length === seed.length && models.every((m, i) => m && m.id === seed[i].id && m.label === seed[i].label)
  );
}

/**
 * One-time migration of a stored `typesafe` profile (the removed standalone
 * Jev provider) to `anthropic`. A profile whose `providerType` is anything
 * else is returned BY REFERENCE, unchanged, so a caller can cheaply detect
 * "nothing to migrate" with `result === stored` and skip a write-back.
 *
 * The rules:
 *   - `providerType` becomes `anthropic`;
 *   - `baseUrl` becomes the default Anthropic base URL — the TypeSafe
 *     endpoint (direct, Vercel, or OpenRouter) meant nothing to an Anthropic
 *     run;
 *   - `models`/`defaultModelId` are cleared ONLY when the list is exactly a
 *     Jev seed the operator never edited; any other list (including one the
 *     operator added to or edited) is kept exactly as stored;
 *   - `lastCapabilityTest` is cleared — a result recorded against the Jev
 *     transport means nothing for an Anthropic endpoint;
 *   - the standalone-only fields (`typesafeDecisionSource`,
 *     `typesafeDecisionBaseUrl`, `typesafeDecisionModelId`, `sendScreenshots`,
 *     `consultSources`) are dropped — nothing reads them once the standalone
 *     run path is gone;
 *   - `revision` is bumped, since this is a real, once-only edit.
 *
 * The Jev transport secret record (`browzy-in-chrome/typesafe/<profileId>`)
 * is never touched here — the caller (profile-store.js) only rewrites the
 * non-secret profile file — so `hasTypesafeKey`/`typesafeSource`/
 * `jevToolsSendScreenshots` and a saved Jev transport key all keep working
 * exactly as before for the migrated profile's Jev browser tools.
 *
 * @param {Record<string, unknown> | null} stored
 * @returns {Record<string, unknown> | null}
 */
export function migrateStoredTypesafeProfile(stored) {
  if (!stored || stored.providerType !== "typesafe") return stored;
  const seedList = isTypesafeSeedModelList(stored.models);
  const { typesafeDecisionSource, typesafeDecisionBaseUrl, typesafeDecisionModelId, sendScreenshots, consultSources, ...rest } = stored;
  return {
    ...rest,
    providerType: DEFAULT_PROVIDER_TYPE,
    baseUrl: DEFAULT_BASE_URL,
    models: seedList ? [] : stored.models,
    defaultModelId: seedList ? null : stored.defaultModelId,
    lastCapabilityTest: {},
    revision: (typeof stored.revision === "number" ? stored.revision : 0) + 1
  };
}

/**
 * The key `lastCapabilityTest` results are stored under: a capability test
 * result is only valid for the exact (endpoint, model, credential) triple it
 * was run against. Replacing the key (a new credential) or changing the
 * endpoint/model naturally invalidates any prior result because the key no
 * longer matches — no separate "invalidate" step is needed.
 *
 * @param {{ baseUrl: string, modelId: string, credentialRevision: number }} args
 * @returns {string}
 */
export function capabilityTestKey({ baseUrl, modelId, credentialRevision }) {
  return `${baseUrl} ${modelId} ${credentialRevision}`;
}

/**
 * Basic structural validation of a loaded profile object — enough to catch a
 * corrupt or hand-edited file before it's trusted, without re-running full
 * URL/model validation (callers that mutate the profile go through
 * url.js/models.js already; this just guards the load path).
 *
 * `providerType` and `chatgptAccount` are optional here on purpose: a
 * pre-existing (legacy) profile file has neither field, and that must load
 * as plausible, not corrupt. When present, only their basic shape is
 * checked — an unrecognized `providerType` VALUE (e.g. a hand-edited typo)
 * is still plausible at this layer; it is profile.js's job to refuse to run
 * it (`INVALID_PROFILE`), not this structural guard's job to reject the file
 * outright.
 * @param {unknown} profile
 * @returns {boolean}
 */
export function isPlausibleProfile(profile) {
  return Boolean(
    profile &&
      typeof profile === "object" &&
      typeof profile.profileId === "string" &&
      typeof profile.baseUrl === "string" &&
      Array.isArray(profile.models) &&
      typeof profile.revision === "number" &&
      (profile.providerType === undefined || typeof profile.providerType === "string") &&
      (profile.chatgptAccount === undefined || profile.chatgptAccount === null || typeof profile.chatgptAccount === "object")
  );
}

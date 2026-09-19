// Transport wrapper between the settings page and the native companion.
//
// WIRE CONTRACT (documented here because it does not exist yet anywhere else
// in the tree — see the note below):
//
//   chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })
//   -> { ok: true, result } | { ok: false, error: { code, message } }
//
// Operations (1:1 with host/agent/settings/profile.js's exported contract,
// reports/04-settings-evidence.md, "Contract group 3 codes against"):
//   op: "get_profile"          payload: { profileId }
//   op: "save_profile"         payload: { profileId, baseUrl, models, defaultModelId }
//   op: "set_credential"       payload: { profileId, secret, memoryOnly? }
//   op: "remove_credential"    payload: { profileId }
//   op: "test_capability"      payload: { profileId, modelId }
//   op: "discover_models"      payload: { profileId }
//   op: "export_profile"       payload: { profileId }
//
// ChatGPT subscription provider ops (add-chatgpt-subscription-provider,
// design.md decisions 3/5/7 — see this change's
// reports/implementation-evidence.md, "Batch E2 — wire contract" for the
// exact shapes this was implemented against; host/agent/settings/
// profile-protocol.js's companion-side dispatch matches this verbatim):
//   op: "set_provider_type"      payload: { profileId, providerType: "anthropic"|"chatgpt" }
//                                 -> result: the updated secret-free profile
//                                 (same result shape as "save_profile")
//   op: "chatgpt_sign_in_start"  payload: { profileId, memoryOnly? }
//                                 -> result: { signInId, authUrl }
//   op: "chatgpt_device_start"   payload: { profileId, memoryOnly? }
//                                 -> result: { signInId, userCode, verificationUrl, expiresAt }
//                                 (expiresAt is an epoch-millisecond number)
//   `memoryOnly: true` is sent ONLY for an explicit, user-confirmed retry
//   after the companion reported SECURE_STORAGE_UNAVAILABLE, and means the
//   same thing it means for `set_credential`: hold the ChatGPT refresh
//   credential in memory only, never in the OS credential store (specs/
//   agent-settings "Secret isolation"). Omitted on every ordinary sign-in.
//   op: "chatgpt_sign_in_status" payload: { signInId }
//                                 -> result: { state: "pending" }
//                                          | { state: "signed_in", account: { email, planType } }
//                                          | { state: "failed", code, message }
//   op: "chatgpt_sign_in_cancel" payload: { signInId }
//                                 -> result: { cancelled: true }
//   op: "chatgpt_sign_out"       payload: { profileId }
//                                 -> result: the updated secret-free profile
//                                 (same result shape as "save_profile")
//   op: "chatgpt_usage"          payload: { profileId }
//                                 -> result: { planType, allowed, limitReached,
//                                    primary, secondary, credits }
//                                 `planType` is the backend's plan string;
//                                 `allowed`/`limitReached` are booleans;
//                                 `primary`/`secondary` are each either null or
//                                 { usedPercent, limitWindowSeconds,
//                                   resetAfterSeconds, resetAt } (resetAt is
//                                 epoch-ms or null); `credits` is either null
//                                 or { hasCredits, unlimited, balance } — only
//                                 when the account has credits. A read-only
//                                 op: it changes no profile field, so the
//                                 companion's reply is never mirrored, and a
//                                 body the backend did not shape as expected
//                                 comes back as the USAGE_UNAVAILABLE code
//                                 rather than as PROTOCOL_ERROR.
// No ChatGPT op ever carries a token/credential value in either direction —
// the companion resolves and stores those itself (host/agent/chatgpt/auth.js).
// The usage reply additionally carries no account identity at all: no account
// id, no user id, and no email — the page already shows the profile's own
// email and plan, so every extra identity field would be a leak surface.
//
// TypeSafe / Jev provider ops (add-typesafe-jev-provider design.md decisions
// 1/5/9 — the host side is host/agent/settings/profile.js's
// setTypesafeConfig()/setTypesafeCredentials(), which persist
// `textModelBaseUrl`/`textModelId` on the profile and the two keys in ONE
// merged JSON secret at `browzy-in-chrome/typesafe/<profileId>`):
//   op: "set_typesafe_config"      payload: { profileId, baseUrl?, typesafeSource?, textModelBaseUrl?, textModelId?, sendScreenshots?, consultSources?, decisionSource?, decisionBaseUrl?, decisionModelId? }
//                                 -> result: the updated secret-free profile
//                                 (same result shape as "get_profile":
//                                 `textModelBaseUrl`, `textModelId`,
//                                 `hasTypesafeKey`, `hasTextModelKey`
//                                 booleans, alongside the pre-existing
//                                 fields). `baseUrl` is the TypeSafe endpoint
//                                 (design.md decision 1 reuses the profile's
//                                 own Base URL for it, defaulting to
//                                 https://api.typesafe.ai host-side) and is
//                                 OPTIONAL: the settings page DOES have a
//                                 TypeSafe endpoint field now
//                                 (add-typesafe-endpoint-field) and the
//                                 endpoint is persisted through `save_profile`
//                                 from the same draft, so this client forwards
//                                 a caller-supplied `baseUrl` only when one is
//                                 passed — `set_typesafe_config` is not the
//                                 endpoint writer in the shipped flow; an
//                                 omitted `baseUrl` never clears what is
//                                 stored.
//                                 `sendScreenshots` (add-jev-run-screenshots
//                                 design.md decision 4) is this profile's
//                                 screenshot toggle: a non-secret boolean,
//                                 persisted with the rest of the config and
//                                 resolved to the documented default (enabled)
//                                 on load, so `get_profile` always answers a
//                                 boolean — absent on an older companion, which
//                                 the settings page reads as enabled. An
//                                 OMITTED value keeps the stored one.
//                                 `consultSources`
//                                 (jev-runs-consult-sources-beyond-the-page
//                                 task 5.1/5.2) is this profile's source-
//                                 consultation toggle: a non-secret boolean,
//                                 same rules as `sendScreenshots` above —
//                                 persisted with the rest of the config,
//                                 resolved to the documented default (enabled)
//                                 on load, and an OMITTED value keeps the
//                                 stored one. When on, a run may fetch, read-
//                                 only and without credentials, at most 3 URLs
//                                 it saw on the driven page or that the goal
//                                 named.
//                                 `textModelBaseUrl` is the OpenAI-compatible
//                                 root the text helper appends
//                                 "/chat/completions" to, so a terminal "/v1"
//                                 is SIGNIFICANT and preserved (unlike the
//                                 Anthropic Base URL above, whose /v1 the SDK
//                                 appends itself).
//                                 `decisionSource` (task 3.6) is the
//                                 `typesafe` profile's decision-model source —
//                                 `openai` (the documented default; the pair
//                                 above), `anthropic` (the profile's EXISTING
//                                 Anthropic credential, set/removed through
//                                 the pre-existing set_credential/
//                                 remove_credential ops, never this one — plus
//                                 `decisionBaseUrl`, an Anthropic-standard
//                                 endpoint), or `chatgpt` (the existing
//                                 ChatGPT sign-in/gateway, reused verbatim —
//                                 no key rides this op for it either).
//                                 `decisionModelId` is required by BOTH
//                                 `anthropic` and `chatgpt`. The settings page
//                                 sends only the ACTIVE source's own subset of
//                                 these keys (settings-controller.js's
//                                 validateDecisionSourceFields()) — an omitted
//                                 key, exactly like `baseUrl` above, keeps
//                                 whatever the companion already has stored
//                                 for a deselected source, so switching away
//                                 and back never re-asks for it.
//   op: "set_typesafe_credentials" payload: { profileId, typesafeApiKey?, textModelApiKey?, memoryOnly? }
//                                 -> result: { backend, hasTypesafeKey, hasTextModelKey }
//                                 WRITE-ONLY, in this direction only: the raw
//                                 key value travels out exactly like
//                                 `set_credential`'s, is never echoed back,
//                                 and the reply is booleans plus the
//                                 non-secret storage-backend label. An
//                                 OMITTED key keeps the key already stored for
//                                 that half; an explicit "" removes it, and
//                                 removal is what the two "Xóa key" actions
//                                 below send (never a delete of the other
//                                 half). `memoryOnly: true` means exactly what
//                                 it means for `set_credential`: hold the keys
//                                 in the companion's memory only, never in the
//                                 OS credential store (specs/agent-settings
//                                 "Secret isolation"), and is sent only for an
//                                 explicit, user-confirmed retry after
//                                 SECURE_STORAGE_UNAVAILABLE.
//
// IMPORTANT — scope note: design.md decision 1 says the real transport for
// agent traffic is a native-messaging port relay owned by
// extension/background.js (the "ocic-agent" port, hello/version handshake,
// sequenced stream events). That relay's exact internal shape is being built
// by a parallel session in this same change and is explicitly out of this
// task's file-ownership (`extension/background.js` is listed under "Files
// you MUST NOT touch"). This module deliberately talks to the background
// service worker through the generic, stable `chrome.runtime.sendMessage`
// surface instead of assuming any detail of that port's internals, so it
// needs exactly one thing from whoever wires `extension/background.js` up
// to `host/agent/settings/profile.js`: a `chrome.runtime.onMessage` listener
// that recognizes `{ type: "agent_settings", op, ... }` and replies with the
// `{ ok, result }` / `{ ok: false, error }` shape above (forwarding op/payload
// to the identically-named function in host/agent/settings/profile.js one
// layer down through the native-messaging channel and NativeLeaseGuard/agent
// envelope machinery already documented in host/agent/protocol.js). Until
// that listener exists, every call here rejects with a NETWORK_ERROR-shaped
// ProviderErrorLike — never a false "success" (see `send()` below).
//
// This file's own responsibility is narrow and fully covered by
// test/settings-ui-*.test.mjs: build the right outgoing message, translate a
// well-formed response back into a plain JS value or a typed error, and
// never let a secret pass through it in either direction (the wire shapes
// above only ever carry `secret` in the OUTBOUND set_credential call, which
// is the one place the spec allows the trusted settings page to hold a
// just-entered key transiently for native transport — see
// settings-controller.js's `save()`, which clears its own copy of the raw
// value immediately after this call resolves or rejects).

/** Mirrors host/agent/settings/errors.js's ProviderError shape without
 * importing any Node module (this file runs in the browser). */
export class ProviderErrorLike extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ProviderErrorLike";
    this.code = code;
  }
}

function defaultSendMessage(message) {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    return Promise.reject(new ProviderErrorLike("NETWORK_ERROR", "extension messaging is not available on this page"));
  }
  return chrome.runtime.sendMessage(message);
}

/**
 * @param {{ sendMessage?: (msg: object) => Promise<any> }} [opts]
 */
export function createSettingsClient(opts = {}) {
  const sendMessage = opts.sendMessage || defaultSendMessage;

  async function call(op, payload = {}) {
    let response;
    try {
      response = await sendMessage({ type: "agent_settings", op, ...payload });
    } catch (err) {
      // A missing listener, a disconnected native port, or a thrown error in
      // the relay all land here — never silently reported as success.
      throw new ProviderErrorLike("NETWORK_ERROR", (err && err.message) || "no response from companion");
    }
    if (!response || typeof response !== "object") {
      throw new ProviderErrorLike("NETWORK_ERROR", "malformed response from companion");
    }
    if (response.ok) return response.result;
    const err = response.error || {};
    throw new ProviderErrorLike(err.code || "NETWORK_ERROR", err.message || "unknown companion error");
  }

  return {
    getProfile: (profileId) => call("get_profile", { profileId }),
    saveProfile: (profileId, patch) => call("save_profile", { profileId, ...patch }),
    setCredential: (profileId, secret, options) => call("set_credential", { profileId, secret, ...(options || {}) }),
    removeCredential: (profileId) => call("remove_credential", { profileId }),
    testCapability: (profileId, modelId) => call("test_capability", { profileId, modelId }),
    discoverModels: (profileId) => call("discover_models", { profileId }),
    exportProfile: (profileId) => call("export_profile", { profileId }),
    // Named-profile collection ops (P2, task 9.2): same `agent_settings`
    // transport, routed by the background relay to
    // host/agent/settings/profile-protocol.js's dispatchProfileCollectionOp.
    // Selection sends only profile id/model id; the companion resolves the
    // credential and snapshots it for the run. Until the relay maps these
    // ops, every call rejects with NETWORK_ERROR — never false success.
    listProfiles: () => call("list_profiles", {}),
    getSelected: () => call("get_selected", {}),
    createProfile: (input) => call("create_profile", { ...(input || {}) }),
    updateProfile: (profileId, patch) => call("update_profile", { profileId, ...(patch || {}) }),
    deleteProfile: (profileId) => call("delete_profile", { profileId }),
    selectProfile: (profileId) => call("select_profile", { profileId }),

    // ChatGPT subscription provider (add-chatgpt-subscription-provider) —
    // see the wire-contract block above this class for the exact request/
    // reply shapes. Never sends or receives a token/credential value.
    setProviderType: (profileId, providerType) => call("set_provider_type", { profileId, providerType }),
    chatgptSignInStart: (profileId, options) => call("chatgpt_sign_in_start", { profileId, ...(options || {}) }),
    chatgptDeviceStart: (profileId, options) => call("chatgpt_device_start", { profileId, ...(options || {}) }),
    chatgptSignInStatus: (signInId) => call("chatgpt_sign_in_status", { signInId }),
    chatgptSignInCancel: (signInId) => call("chatgpt_sign_in_cancel", { signInId }),
    chatgptSignOut: (profileId) => call("chatgpt_sign_out", { profileId }),
    // Account-usage read (add-chatgpt-usage-check): display-shaped reply only
    // — the plan, the limit flags, each window's percent/reset timing, and a
    // credits summary when the account has one. Sends nothing but the
    // profileId; the companion resolves the credential (see the wire-contract
    // block above for the exact reply shape).
    chatgptUsage: (profileId) => call("chatgpt_usage", { profileId }),

    // TypeSafe / Jev provider (add-typesafe-jev-provider): the non-secret
    // text-model configuration, and the two write-only keys. Both are
    // documented in the wire-contract block above; `setTypesafeConfig` only
    // forwards the keys its caller actually set, so an omitted `baseUrl`
    // never overwrites what is stored — the TypeSafe endpoint is written by
    // `save_profile` from the page's draft (add-typesafe-endpoint-field),
    // and `setTypesafeCredentials`'s explicit "" is the removal signal (an
    // omitted key keeps what is stored). Neither method ever reads a key
    // back out of a reply — the reply is booleans only.
    setTypesafeConfig: (profileId, config) => call("set_typesafe_config", { profileId, ...(config || {}) }),
    setTypesafeCredentials: (profileId, keys, options) => call("set_typesafe_credentials", { profileId, ...(keys || {}), ...(options || {}) })
  };
}

// A deterministic, in-memory fake companion CLIENT for controller-level
// tests (test/settings-ui-controller.test.mjs, test/settings-ui-errors.test.mjs,
// test/settings-ui-secrets.test.mjs). It implements the exact same duck-typed
// interface settings-client.js's createSettingsClient() returns
// (getProfile/saveProfile/setCredential/removeCredential/testCapability/
// discoverModels/exportProfile, plus the six ChatGPT subscription ops
// setProviderType/chatgptSignInStart/chatgptDeviceStart/chatgptSignInStatus/
// chatgptSignInCancel/chatgptSignOut and the account-usage read
// chatgptUsage, plus the TypeSafe provider's setTypesafeConfig/
// setTypesafeCredentials), so SettingsController never knows the difference —
// the same class this test drives is the one settings-app.js instantiates in
// production.
//
// This is intentionally SEPARATE from
// test/settings-ui-real-companion-harness.mjs (which wraps the real,
// already-tested host/agent/settings/profile.js): this file exists to make
// the large combinatorial error-taxonomy / state-machine matrix fast and
// fully deterministic (no real SDK retry/backoff timing, no OS credential
// store), while the real-companion harness proves the wire contract holds
// end-to-end against production host code. Every error code and response
// shape scripted here is copied verbatim from host/agent/settings/errors.js
// and reports/04-settings-evidence.md's own documented taxonomy — nothing
// here is invented.
import { ProviderErrorLike } from "../extension/settings/settings-client.js";

/**
 * @param {object} [initialProfile] shape matching profile.js's loadProfile()
 *   return value, or null for "no profile yet" (first run).
 */
export function createScriptedCompanion(initialProfile = null) {
  let profile = initialProfile;
  const calls = []; // every op invoked, in order — lets a test assert what was (or wasn't) called
  const scripts = {
    testCapability: null, // (profileId, modelId) => result | throws
    discoverModels: null, // (profileId) => result | throws
    setCredential: null, // (profileId, secret, opts) => result | throws — override to script SECURE_STORAGE_UNAVAILABLE etc.
    // ChatGPT subscription ops (add-chatgpt-subscription-provider). Each
    // override receives the same arguments the real settings-client.js method
    // would send and must return the same reply shape the wire contract
    // documents; leaving one null uses the deterministic default below.
    chatgptSignInStart: null, // (profileId, opts) => { signInId, authUrl } | throws
    chatgptDeviceStart: null, // (profileId, opts) => { signInId, userCode, verificationUrl, expiresAt } | throws
    chatgptSignInStatus: null, // (signInId) => { state, ... } | throws
    chatgptSignInCancel: null, // (signInId) => { cancelled: true } | throws
    chatgptSignOut: null, // (profileId) => updated profile | throws
    // ChatGPT account-usage read (add-chatgpt-usage-check). Override to script
    // the six-key display result — or any of the reader's failure codes
    // (SESSION_EXPIRED / NO_CREDENTIAL / RATE_LIMIT_ERROR / AUTH_ERROR /
    // NETWORK_ERROR / TIMEOUT_ERROR / USAGE_UNAVAILABLE) — without a network.
    chatgptUsage: null, // (profileId) => usage result | throws
    // TypeSafe / Jev provider (add-typesafe-jev-provider task 5.5). Override to
    // script a stale companion (PROTOCOL_ERROR) or a
    // SECURE_STORAGE_UNAVAILABLE on the key save — neither needs a network.
    setTypesafeConfig: null, // (profileId, config) => updated profile | throws
    setTypesafeCredentials: null // (profileId, keys, opts) => { backend, hasTypesafeKey, hasTextModelKey } | throws
  };

  function requireProfile(profileId) {
    if (!profile || profile.profileId !== profileId) {
      throw new ProviderErrorLike("NO_CREDENTIAL", `no profile found for profileId "${profileId}"`);
    }
    return profile;
  }

  const client = {
    async getProfile(profileId) {
      calls.push({ op: "get_profile", profileId });
      if (!profile || profile.profileId !== profileId) return null;
      return { ...profile, models: profile.models.map((m) => ({ ...m })) };
    },

    async saveProfile(profileId, patch) {
      calls.push({ op: "save_profile", profileId, patch: { ...patch } });
      // Spread the existing profile first: the real host's save_profile
      // replies with the WHOLE secret-free profile (loadProfile()'s shape),
      // provider fields included, not just the four it was handed.
      profile = {
        ...(profile || {}),
        profileId,
        baseUrl: patch.baseUrl,
        models: patch.models.map((m) => ({ ...m })),
        defaultModelId: patch.defaultModelId,
        hasCredential: profile ? profile.hasCredential : false,
        memoryOnlyCredential: profile ? profile.memoryOnlyCredential : false,
        secretBackend: profile ? profile.secretBackend : null,
        revision: profile ? profile.revision + 1 : 1
      };
      return { ...profile, models: profile.models.map((m) => ({ ...m })) };
    },

    async setCredential(profileId, secret, opts) {
      calls.push({ op: "set_credential", profileId, secretLength: secret.length, opts });
      if (scripts.setCredential) return scripts.setCredential(profileId, secret, opts);
      const backend = opts && opts.memoryOnly ? "memory" : "windows-credential-manager";
      profile = requireProfile(profileId);
      profile.hasCredential = true;
      profile.memoryOnlyCredential = backend === "memory";
      profile.secretBackend = backend;
      return { backend };
    },

    async removeCredential(profileId) {
      calls.push({ op: "remove_credential", profileId });
      profile = requireProfile(profileId);
      profile.hasCredential = false;
      profile.memoryOnlyCredential = false;
      profile.secretBackend = null;
    },

    async testCapability(profileId, modelId) {
      calls.push({ op: "test_capability", profileId, modelId });
      requireProfile(profileId);
      if (scripts.testCapability) return scripts.testCapability(profileId, modelId);
      return { status: "pass", capabilities: { text: "pass", tool: "pass", vision: "pass" }, errors: {}, timestamp: new Date().toISOString() };
    },

    async discoverModels(profileId) {
      calls.push({ op: "discover_models", profileId });
      requireProfile(profileId);
      if (scripts.discoverModels) return scripts.discoverModels(profileId);
      return { supported: false, reason: "the endpoint does not implement the Anthropic models listing API (HTTP 404)" };
    },

    async exportProfile(profileId) {
      calls.push({ op: "export_profile", profileId });
      const p = requireProfile(profileId);
      // Mirrors host's redactSecretsDeep(profile, []) — the stored profile
      // object never contains a secret field to begin with.
      return { ...p, models: p.models.map((m) => ({ ...m })) };
    },

    // --- ChatGPT subscription ops (add-chatgpt-subscription-provider) ------
    // Reply shapes match the wire contract recorded in reports/
    // implementation-evidence.md (Batch E2 table) and host/agent/companion.js's
    // dispatch. Never a token/credential value in either direction.

    async setProviderType(profileId, providerType) {
      calls.push({ op: "set_provider_type", profileId, providerType });
      profile = requireProfile(profileId);
      profile = { ...profile, providerType, revision: (profile.revision || 0) + 1 };
      return { ...profile, models: profile.models.map((m) => ({ ...m })) };
    },

    async chatgptSignInStart(profileId, opts) {
      // Same outbound shape settings-client.js produces: `memoryOnly` only
      // ever appears when the caller explicitly asked for it (the
      // user-confirmed memory-only retry), never as an explicit false.
      calls.push({ op: "chatgpt_sign_in_start", profileId, ...(opts && opts.memoryOnly ? { memoryOnly: true } : {}) });
      requireProfile(profileId);
      if (scripts.chatgptSignInStart) return scripts.chatgptSignInStart(profileId, opts);
      return { signInId: "signin-browser-1", authUrl: "https://auth.openai.com/oauth/authorize?state=scripted" };
    },

    async chatgptDeviceStart(profileId, opts) {
      calls.push({ op: "chatgpt_device_start", profileId, ...(opts && opts.memoryOnly ? { memoryOnly: true } : {}) });
      requireProfile(profileId);
      if (scripts.chatgptDeviceStart) return scripts.chatgptDeviceStart(profileId, opts);
      return {
        signInId: "signin-device-1",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
        expiresAt: Date.now() + 15 * 60 * 1000
      };
    },

    async chatgptSignInStatus(signInId) {
      calls.push({ op: "chatgpt_sign_in_status", signInId });
      if (scripts.chatgptSignInStatus) return scripts.chatgptSignInStatus(signInId);
      return { state: "pending" };
    },

    async chatgptSignInCancel(signInId) {
      calls.push({ op: "chatgpt_sign_in_cancel", signInId });
      if (scripts.chatgptSignInCancel) return scripts.chatgptSignInCancel(signInId);
      return { cancelled: true };
    },

    async chatgptSignOut(profileId) {
      calls.push({ op: "chatgpt_sign_out", profileId });
      profile = requireProfile(profileId);
      // Mirrors recordChatgptSignOut: clears the account and credential
      // presence, bumps credentialRevision, keeps the model list.
      profile = {
        ...profile,
        chatgptAccount: null,
        chatgptSessionState: "signed_out",
        hasCredential: false,
        memoryOnlyCredential: false,
        secretBackend: null,
        credentialRevision: (profile.credentialRevision || 0) + 1
      };
      return { ...profile, models: profile.models.map((m) => ({ ...m })) };
    },

    // --- ChatGPT account-usage read (add-chatgpt-usage-check) -------------
    // Reply shape is the six-key display result settings-client.js's wire
    // contract documents and host/agent/chatgpt/usage.js produces: the plan,
    // the limit flags, each window's percent/reset timing, and credits only
    // when the account has them. Never a token, account id, user id, or email.
    async chatgptUsage(profileId) {
      calls.push({ op: "chatgpt_usage", profileId });
      requireProfile(profileId);
      if (scripts.chatgptUsage) return scripts.chatgptUsage(profileId);
      return {
        planType: "plus",
        allowed: true,
        limitReached: false,
        primary: { usedPercent: 3, limitWindowSeconds: 2592000, resetAfterSeconds: 1209600, resetAt: null },
        secondary: null,
        credits: null
      };
    },

    // --- TypeSafe / Jev provider (add-typesafe-jev-provider task 5.5) -----
    // Same two op shapes settings-client.js's wire contract documents: the
    // config op replies the whole updated secret-free profile; the credential
    // op replies booleans plus the backend label and NEVER echoes a key. The
    // default below mirrors host/agent/settings/profile.js's merge rule — an
    // omitted key keeps its stored value, an explicit "" removes it, and
    // `hasCredential` tracks "both halves present", which is what the page's
    // first-run state reads.
    async setTypesafeConfig(profileId, config) {
      // Flat, exactly like the real client's `call("set_typesafe_config",
      // { profileId, ...config })` — a nested copy here would let a test pass
      // against a shape the companion never sees.
      calls.push({ op: "set_typesafe_config", profileId, ...config });
      profile = requireProfile(profileId);
      if (scripts.setTypesafeConfig) return scripts.setTypesafeConfig(profileId, config);
      // Mirrors host/agent/settings/profile.js's setTypesafeConfig() merge
      // rule (task 3.6): an OMITTED key keeps the value already stored —
      // load-bearing for "switching source does not discard configuration"
      // tests, where the deselected source's fields must never be sent (see
      // settings-controller.js's validateDecisionSourceFields()) and must
      // therefore survive here exactly as the real host leaves them.
      profile = {
        ...profile,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        typesafeSource: config.typesafeSource === undefined ? profile.typesafeSource : config.typesafeSource,
        textModelBaseUrl: config.textModelBaseUrl === undefined ? profile.textModelBaseUrl : config.textModelBaseUrl,
        textModelId: config.textModelId === undefined ? profile.textModelId : config.textModelId,
        typesafeDecisionSource: config.decisionSource === undefined ? (profile.typesafeDecisionSource || "openai") : config.decisionSource,
        typesafeDecisionBaseUrl: config.decisionBaseUrl === undefined ? profile.typesafeDecisionBaseUrl : config.decisionBaseUrl,
        typesafeDecisionModelId: config.decisionModelId === undefined ? profile.typesafeDecisionModelId : config.decisionModelId,
        // The screenshot toggle (add-jev-run-screenshots task 3.2): OMITTED
        // keeps the stored value, exactly like the real host's
        // setTypesafeConfig — so a test can tell "the page sent it" from "the
        // page left it alone".
        ...(config.sendScreenshots === undefined ? {} : { sendScreenshots: Boolean(config.sendScreenshots) }),
        // The consult-sources toggle
        // (jev-runs-consult-sources-beyond-the-page task 5.1/5.2): OMITTED
        // keeps the stored value, exactly like the real host's
        // setTypesafeConfig — same rule as sendScreenshots above.
        ...(config.consultSources === undefined ? {} : { consultSources: Boolean(config.consultSources) }),
        revision: (profile.revision || 0) + 1
      };
      return { ...profile, models: profile.models.map((m) => ({ ...m })) };
    },

    async setTypesafeCredentials(profileId, keys, opts) {
      calls.push({
        op: "set_typesafe_credentials",
        profileId,
        // Lengths, never the values: what a wire assertion needs is that the
        // real secret travelled, not a copy of it in this test's own log.
        typesafeKeyLength: typeof keys.typesafeApiKey === "string" ? keys.typesafeApiKey.length : null,
        textModelKeyLength: typeof keys.textModelApiKey === "string" ? keys.textModelApiKey.length : null,
        opts
      });
      profile = requireProfile(profileId);
      if (scripts.setTypesafeCredentials) return scripts.setTypesafeCredentials(profileId, keys, opts);
      const backend = opts && opts.memoryOnly ? "memory" : "windows-credential-manager";
      const hasTypesafeKey = keys.typesafeApiKey === undefined
        ? Boolean(profile.hasTypesafeKey)
        : Boolean(keys.typesafeApiKey.trim());
      const hasTextModelKey = keys.textModelApiKey === undefined
        ? Boolean(profile.hasTextModelKey)
        : Boolean(keys.textModelApiKey.trim());
      profile = {
        ...profile,
        hasTypesafeKey,
        hasTextModelKey,
        hasCredential: hasTypesafeKey && hasTextModelKey,
        memoryOnlyCredential: backend === "memory",
        secretBackend: backend,
        credentialRevision: (profile.credentialRevision || 0) + 1
      };
      return { backend, hasTypesafeKey, hasTextModelKey };
    }
  };

  return { client, calls, scripts, getInternalProfile: () => profile };
}

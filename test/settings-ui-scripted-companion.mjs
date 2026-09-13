// A deterministic, in-memory fake companion CLIENT for controller-level
// tests (test/settings-ui-controller.test.mjs, test/settings-ui-errors.test.mjs,
// test/settings-ui-secrets.test.mjs). It implements the exact same duck-typed
// interface settings-client.js's createSettingsClient() returns
// (getProfile/saveProfile/setCredential/removeCredential/testCapability/
// discoverModels/exportProfile, plus the six ChatGPT subscription ops
// setProviderType/chatgptSignInStart/chatgptDeviceStart/chatgptSignInStatus/
// chatgptSignInCancel/chatgptSignOut), so SettingsController never knows the
// difference — the same class this test drives is the one settings-app.js
// instantiates in production.
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
    chatgptSignOut: null // (profileId) => updated profile | throws
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
      profile = {
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
    }
  };

  return { client, calls, scripts, getInternalProfile: () => profile };
}

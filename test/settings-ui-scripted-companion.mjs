// A deterministic, in-memory fake companion CLIENT for controller-level
// tests (test/settings-ui-controller.test.mjs, test/settings-ui-errors.test.mjs,
// test/settings-ui-secrets.test.mjs). It implements the exact same duck-typed
// interface settings-client.js's createSettingsClient() returns
// (getProfile/saveProfile/setCredential/removeCredential/testCapability/
// discoverModels/exportProfile), so SettingsController never knows the
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
    setCredential: null // (profileId, secret, opts) => result | throws — override to script SECURE_STORAGE_UNAVAILABLE etc.
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
    }
  };

  return { client, calls, scripts, getInternalProfile: () => profile };
}

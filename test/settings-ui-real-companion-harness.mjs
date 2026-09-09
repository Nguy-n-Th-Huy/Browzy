// A companion "sendMessage" implementation that wraps the REAL, already
// independently-tested host/agent/settings/profile.js (task group 4;
// reports/04-settings-evidence.md) — used by
// test/settings-ui-real-companion.test.mjs to prove settings-client.js +
// settings-controller.js's message contract holds end-to-end against
// production host code, not just against the deterministic scripted double
// in test/settings-ui-scripted-companion.mjs.
//
// This is the closest thing to "drive the UI against a faithful fake
// companion harness speaking the real message shapes" available without a
// live installed extension + native-messaging pipe + real companion
// subprocess (none of which exist in this environment — see this task's
// "Environment constraint"): the op-dispatch table below IS the documented
// wire contract from settings-client.js's file header, and every op it
// implements is a direct, unmodified call into the real profile.js exports.
//
// Isolation, carefully: uses OCIC_AGENT_CONFIG_DIR to redirect the profile
// JSON to a scratch directory (never a developer's real
// ~/.config/browzy-in-chrome/), a profileId that is NEVER "default"
// (avoiding the exact real credential-collision bug reports/04-settings-
// evidence.md documents in secrets-redaction.test.mjs -- see its "CRITICAL
// finding"), and memoryOnly:true for every credential set here so no real OS
// credential-store entry is ever touched by this test suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let profileModule = null;
let configDir = null;

/**
 * @param {{ profileId: string }} opts
 * @returns {Promise<{ sendMessage: (msg: object) => Promise<any>, configDir: string, profileId: string, teardown: () => void }>}
 */
export async function createRealCompanionHarness(opts = {}) {
  const profileId = opts.profileId || `settings-ui-real-test-${process.pid}-${Date.now()}`;
  if (profileId === "default") {
    throw new Error("refusing to use the real 'default' profileId in a test harness — see file header");
  }
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-settings-ui-real-"));
  process.env.OCIC_AGENT_CONFIG_DIR = configDir;

  // Dynamic import AFTER setting the env var, and fresh per harness (Node's
  // ESM cache is per-resolved-URL, but profile.js reads the env var lazily
  // via paths.js's configDir() on every call, not at import time, so a
  // single cached module instance is safe to reuse across harnesses too --
  // still importing once here for clarity).
  profileModule = await import(`../host/agent/settings/profile.js?t=${Date.now()}-${Math.random()}`);

  async function sendMessage(msg) {
    if (!msg || msg.type !== "agent_settings") {
      return { ok: false, error: { code: "PROTOCOL_ERROR", message: "not an agent_settings message" } };
    }
    try {
      let result;
      switch (msg.op) {
        case "get_profile":
          result = await profileModule.loadProfile();
          break;
        case "save_profile":
          result = await profileModule.saveProfile({
            profileId: msg.profileId,
            baseUrl: msg.baseUrl,
            models: msg.models,
            defaultModelId: msg.defaultModelId
          });
          break;
        case "set_credential":
          result = await profileModule.setCredential(msg.profileId, msg.secret, { memoryOnly: true }); // memoryOnly forced true — see file header
          break;
        case "remove_credential":
          result = await profileModule.removeCredential(msg.profileId);
          break;
        case "test_capability":
          result = await profileModule.testCapability(msg.profileId, msg.modelId);
          break;
        case "discover_models":
          result = await profileModule.refreshDiscoveredModels(msg.profileId);
          break;
        case "export_profile":
          result = await profileModule.exportProfileRedacted(msg.profileId);
          break;
        default:
          return { ok: false, error: { code: "PROTOCOL_ERROR", message: `unknown op "${msg.op}"` } };
      }
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: err.code || "NETWORK_ERROR", message: err.message } };
    }
  }

  function teardown() {
    delete process.env.OCIC_AGENT_CONFIG_DIR;
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {}
  }

  return { sendMessage, configDir, profileId, teardown };
}

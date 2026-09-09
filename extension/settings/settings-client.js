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
    selectProfile: (profileId) => call("select_profile", { profileId })
  };
}

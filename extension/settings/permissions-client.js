// Transport wrapper between Settings > Approved sites (task 7.8) and the
// native companion.
//
// WIRE CONTRACT (openspec/changes/add-permission-modes-and-threat-signals/
// reports/wave1-contracts.md — the ground truth for these op shapes):
//
//   chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })
//   -> { ok: true, result } | { ok: false, error: { code, message } }
//
//   op: "get_permission_state"      payload: {}
//     -> { mode, modeSource, sites: [...], managedPolicy: {...} }
//   op: "set_permission_mode"       payload: { mode }
//     -> { mode } | error { code: "INVALID_MODE" | "MANAGED_POLICY_PINNED" }
//   op: "revoke_site_entry"         payload: { origin, actionClass }
//     -> { revoked: true } | error { code: "PROTOCOL_ERROR" | "MANAGED_ENTRY_LOCKED" | "NOT_FOUND" }
//   op: "revoke_all_site_entries"   payload: {}
//     -> { removed: <count> }
//
// Mirrors extension/settings/skills-client.js's shape (same "agent_settings"
// envelope, no addition to host/agent/protocol.js needed) and intentionally
// duplicates extension/sidepanel/permissions-client.js rather than sharing a
// module across the sidepanel/settings directory boundary — see that file's
// own header for the precedent this follows.

export class PermissionsErrorLike extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = "PermissionsErrorLike";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function defaultSendMessage(message) {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    return Promise.reject(new PermissionsErrorLike("NETWORK_ERROR", "extension messaging is not available on this page"));
  }
  return chrome.runtime.sendMessage(message);
}

/** @param {{ sendMessage?: (msg: object) => Promise<any> }} [opts] */
export function createPermissionsClient(opts = {}) {
  const sendMessage = opts.sendMessage || defaultSendMessage;

  async function call(op, payload = {}) {
    let response;
    try {
      response = await sendMessage({ type: "agent_settings", op, ...payload });
    } catch (err) {
      throw new PermissionsErrorLike("NETWORK_ERROR", (err && err.message) || "no response from companion");
    }
    if (!response || typeof response !== "object") {
      throw new PermissionsErrorLike("NETWORK_ERROR", "malformed response from companion");
    }
    if (response.ok) return response.result;
    const err = response.error || {};
    throw new PermissionsErrorLike(err.code || "NETWORK_ERROR", err.message || "unknown companion error", err.details);
  }

  return {
    getPermissionState: () => call("get_permission_state"),
    setPermissionMode: (mode) => call("set_permission_mode", { mode }),
    revokeSiteEntry: (origin, actionClass) => call("revoke_site_entry", { origin, actionClass }),
    revokeAllSiteEntries: () => call("revoke_all_site_entries")
  };
}

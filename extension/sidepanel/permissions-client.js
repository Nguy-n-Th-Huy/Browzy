// Transport wrapper between the sidepanel's permission-mode badge (task 7.1
// — "wherever a run can act") and the native companion.
//
// WIRE CONTRACT (openspec/changes/add-permission-modes-and-threat-signals/
// reports/wave1-contracts.md — the ground truth for these op shapes):
//
//   chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })
//   -> { ok: true, result } | { ok: false, error: { code, message } }
//
// Reuses the SAME "agent_settings" op-dispatch envelope
// extension/settings/settings-client.js and extension/sidepanel/
// skills-client.js already speak — no addition to
// host/agent/protocol.js's AGENT_MESSAGE_TYPES needed, only new `op` names:
//
//   op: "get_permission_state"   payload: {}
//     -> { mode, modeSource, sites: [...], managedPolicy: {...} }
//   op: "set_permission_mode"    payload: { mode: "manual"|"auto"|"skip" }
//     -> { mode } | error { code: "INVALID_MODE" | "MANAGED_POLICY_PINNED" }
//
// This file intentionally duplicates extension/settings/permissions-client.js
// rather than sharing a module across the settings/sidepanel directory
// boundary — this project's existing convention (compare
// extension/sidepanel/skills-client.js vs extension/settings/
// skills-client.js, two separate files for the same op family).

/** Mirrors host error `.code` values without importing any Node module. */
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
    setPermissionMode: (mode) => call("set_permission_mode", { mode })
  };
}

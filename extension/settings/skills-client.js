// Transport wrapper between Settings > Skills and the native companion.
//
// WIRE CONTRACT (documented here for the same reason settings-client.js
// documents its own — see that file's header for the precedent this copies):
//
//   chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })
//   -> { ok: true, result } | { ok: false, error: { code, message } }
//
// This reuses the SAME message type ("agent_settings") settings-client.js
// already sends, rather than inventing a new one, so no addition to
// host/agent/protocol.js's AGENT_MESSAGE_TYPES is needed for this feature —
// "agent_settings" is already a generic op-dispatch envelope there (see
// protocol.js's own comment: "extension/settings/settings-client.js ... and
// extension/background.js's createAgentSettingsRelay() already speak this
// exact envelope shape"). Only the `op` names below are new.
//
// Operations (1:1 with host/agent/companion.js's `_handleAgentSettings()`
// skills_* case branches, which delegate to host/agent/skills/index.js's
// exported catalog-lifecycle contract — listCatalog/authorSkill/enableSkill/
// disableSkill/removeSkill/setInvocationFlags — plus the read-back
// composition described below):
//   op: "skills_list"                  payload: {}
//   op: "skills_read_source"           payload: { name }
//   op: "skills_author"                payload: { name, description, body, userInvocable?, modelInvocable?, allowedTools? }
//   op: "skills_enable"                payload: { name }
//   op: "skills_disable"               payload: { name }
//   op: "skills_remove"                payload: { name }
//   op: "skills_set_invocation_flags"  payload: { name, userInvocable?, modelInvocable? }
//
// No operation here takes a filesystem path (openspec/changes/
// redesign-settings-typed-only-skills, design.md decision D1): composing a
// skill in the app (`skills_author`) is the only way one enters the catalog.
// `skills_read_source` takes a catalog `name` and nothing else — it is what
// makes "Sửa" (edit) and "Nhân bản" (duplicate) possible without ever
// reading a directory the app does not own: it resolves the skill's own
// approved snapshot host-side and returns
// `{ name, description, body, allowedTools, userInvocable, modelInvocable }`.
//
// This file's own responsibility is narrow and fully covered by
// test/settings-ui-skills-*.test.mjs: build the right outgoing message,
// translate a well-formed response back into a plain JS value or a typed
// error.

/** Mirrors host/agent/skills/errors.js's error `.code` values without
 * importing any Node module (this file runs in the browser). */
export class SkillsErrorLike extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details) {
    super(message);
    this.name = "SkillsErrorLike";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function defaultSendMessage(message) {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    return Promise.reject(new SkillsErrorLike("NETWORK_ERROR", "extension messaging is not available on this page"));
  }
  return chrome.runtime.sendMessage(message);
}

/**
 * @param {{ sendMessage?: (msg: object) => Promise<any> }} [opts]
 */
export function createSkillsClient(opts = {}) {
  const sendMessage = opts.sendMessage || defaultSendMessage;

  async function call(op, payload = {}) {
    let response;
    try {
      response = await sendMessage({ type: "agent_settings", op, ...payload });
    } catch (err) {
      throw new SkillsErrorLike("NETWORK_ERROR", (err && err.message) || "no response from companion");
    }
    if (!response || typeof response !== "object") {
      throw new SkillsErrorLike("NETWORK_ERROR", "malformed response from companion");
    }
    if (response.ok) return response.result;
    const err = response.error || {};
    throw new SkillsErrorLike(err.code || "NETWORK_ERROR", err.message || "unknown companion error", err.details);
  }

  return {
    listCatalog: () => call("skills_list"),
    readSkillSource: (name) => call("skills_read_source", { name }),
    authorSkill: (fields) => call("skills_author", { ...fields }),
    enableSkill: (name) => call("skills_enable", { name }),
    disableSkill: (name) => call("skills_disable", { name }),
    removeSkill: (name) => call("skills_remove", { name }),
    setInvocationFlags: (name, flags) => call("skills_set_invocation_flags", { name, ...flags })
  };
}

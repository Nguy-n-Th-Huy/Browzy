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
// Operations (1:1 with host/agent/skills/index.js's exported catalog-lifecycle
// contract — listCatalog/importSkill/refreshSkill/authorSkill/enableSkill/
// disableSkill/removeSkill/setInvocationFlags — see that file and
// manage.js/import.js/author.js):
//   op: "skills_list"                  payload: {}
//   op: "skills_import"                payload: { sourceDir }
//   op: "skills_refresh"               payload: { name }
//   op: "skills_author"                payload: { name, description, body, userInvocable?, modelInvocable?, allowedTools? }
//   op: "skills_enable"                payload: { name }
//   op: "skills_disable"               payload: { name }
//   op: "skills_remove"                payload: { name }
//   op: "skills_set_invocation_flags"  payload: { name, userInvocable?, modelInvocable? }
//
// IMPORTANT — scope note (mirrors settings-client.js's own, for the same
// reason): design.md decision 1 puts the real native-messaging relay in
// extension/background.js, owned by a parallel session in this same change
// (`extension/background.js` is listed under this task's "Files you MUST NOT
// touch"). host/agent/companion.js's `_handleAgentSettings()` also does not
// yet have case branches for the `skills_*` ops above — see reports/
// 07-skills-ui-evidence.md's "Wire contract and companion wiring gap"
// section. Both are host-owned/background-owned follow-up work, not this
// task's file scope. Until they exist, every call here rejects with a
// NETWORK_ERROR-shaped SkillsErrorLike — never a false "success" — exactly
// like settings-client.js's own `send()` already behaves for the same
// not-yet-wired reason.
//
// This file's own responsibility is narrow and fully covered by
// test/settings-ui-skills-*.test.mjs: build the right outgoing message,
// translate a well-formed response back into a plain JS value or a typed
// error. It never executes anything from a source folder itself — the
// `sourceDir` payload is just a string path the user picked/typed; all
// actual file reads/copies happen host-side in host/agent/skills/import.js,
// which never executes package scripts (see that file's own header).

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
    importSkill: (sourceDir) => call("skills_import", { sourceDir }),
    refreshSkill: (name) => call("skills_refresh", { name }),
    authorSkill: (fields) => call("skills_author", { ...fields }),
    enableSkill: (name) => call("skills_enable", { name }),
    disableSkill: (name) => call("skills_disable", { name }),
    removeSkill: (name) => call("skills_remove", { name }),
    setInvocationFlags: (name, flags) => call("skills_set_invocation_flags", { name, ...flags })
  };
}

// Read-only transport for the slash picker's skill catalog.
//
// Speaks the exact same `{ type: "agent_settings", op: "skills_list" }` wire
// contract extension/settings/skills-client.js documents (see that file's
// header for the full contract and the scope note on why the companion-side
// `skills_list` op handler and extension/background.js's relay do not exist
// yet — both are out of this task's file scope). Deliberately a SEPARATE,
// smaller module rather than an import of extension/settings/skills-client.js:
// this product's convention (extension/settings/settings-client.js vs.
// extension/sidepanel/protocol-client.js) is that the settings page and the
// panel never share a module across their two directories, since each is a
// standalone extension page loaded independently with no build step to
// dedupe an import across them.
//
// The picker only ever needs to READ the catalog (list), never mutate it —
// import/enable/disable/refresh/remove stay exclusively Settings > Skills'
// responsibility (extension/settings/skills-client.js).

export class SkillsErrorLike extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillsErrorLike";
    this.code = code;
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
export function createPanelSkillsClient(opts = {}) {
  const sendMessage = opts.sendMessage || defaultSendMessage;

  async function listCatalog() {
    let response;
    try {
      response = await sendMessage({ type: "agent_settings", op: "skills_list" });
    } catch (err) {
      throw new SkillsErrorLike("NETWORK_ERROR", (err && err.message) || "no response from companion");
    }
    if (!response || typeof response !== "object") {
      throw new SkillsErrorLike("NETWORK_ERROR", "malformed response from companion");
    }
    if (response.ok) return response.result;
    const err = response.error || {};
    throw new SkillsErrorLike(err.code || "NETWORK_ERROR", err.message || "unknown companion error");
  }

  // repair-slash-dispatch-and-builtin-commands (design.md decision 5 /
  // tasks.md 3.1): the read-only companion-side record of what the SDK
  // itself advertised as its supported slash commands (host/agent/settings/
  // advertised-commands.js), fetched alongside listCatalog() so the picker
  // can compute its built-in section. Same `{type:"agent_settings", op}`
  // wire shape and SkillsErrorLike error translation as listCatalog()
  // above — this module stays read-only, no mutation op is added here.
  // `result` is `null` when nothing has been observed yet (a normal,
  // honest first-run state — never an error), which skills-model.js's
  // deriveBuiltinCommands() treats as "no built-ins yet".
  async function getAdvertisedCommands() {
    let response;
    try {
      response = await sendMessage({ type: "agent_settings", op: "get_advertised_commands" });
    } catch (err) {
      throw new SkillsErrorLike("NETWORK_ERROR", (err && err.message) || "no response from companion");
    }
    if (!response || typeof response !== "object") {
      throw new SkillsErrorLike("NETWORK_ERROR", "malformed response from companion");
    }
    if (response.ok) return response.result;
    const err = response.error || {};
    throw new SkillsErrorLike(err.code || "NETWORK_ERROR", err.message || "unknown companion error");
  }

  return { listCatalog, getAdvertisedCommands };
}

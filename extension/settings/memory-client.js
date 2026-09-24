// Transport wrapper between Settings > Bộ nhớ cách làm việc and the native
// companion (openspec/changes/add-task-memory tasks.md 6.4 / 7.3-7.4).
//
// WIRE CONTRACT (host/agent/companion.js's _handleTaskMemoryOp):
//
//   chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })
//   -> { ok: true, result } | { ok: false, error: { code, message } }
//
//   op: "task_memory_get_settings"  payload: {}              -> { enabled }
//   op: "task_memory_set_settings"  payload: { enabled }     -> { enabled }
//   op: "task_memory_list"          payload: {}
//     -> { sites: [{ host, memories: [{ id, intent, stepCount, actionCount,
//          lastConfirmedAt, useCount, state }] }], invalid }
//   op: "task_memory_forget"        payload: { host } | { all: true } -> { forgotten }
//
// Same "agent_settings" envelope and error shape as permissions-client.js,
// duplicated rather than shared per that file's own precedent.

export class MemoryErrorLike extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "MemoryErrorLike";
    this.code = code;
  }
}

function defaultSendMessage(message) {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    return Promise.reject(new MemoryErrorLike("NETWORK_ERROR", "extension messaging is not available on this page"));
  }
  return chrome.runtime.sendMessage(message);
}

/** @param {{ sendMessage?: (msg: object) => Promise<any> }} [opts] */
export function createMemoryClient(opts = {}) {
  const sendMessage = opts.sendMessage || defaultSendMessage;

  async function call(op, payload = {}) {
    let response;
    try {
      response = await sendMessage({ type: "agent_settings", op, ...payload });
    } catch (err) {
      throw new MemoryErrorLike("NETWORK_ERROR", (err && err.message) || "no response from companion");
    }
    if (!response || typeof response !== "object") throw new MemoryErrorLike("NETWORK_ERROR", "malformed response from companion");
    if (response.ok) return response.result;
    const err = response.error || {};
    throw new MemoryErrorLike(err.code || "NETWORK_ERROR", err.message || "unknown companion error");
  }

  return {
    getSettings: () => call("task_memory_get_settings"),
    setEnabled: (enabled) => call("task_memory_set_settings", { enabled }),
    list: () => call("task_memory_list"),
    forgetHost: (host) => call("task_memory_forget", { host }),
    forgetAll: () => call("task_memory_forget", { all: true })
  };
}

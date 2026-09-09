// Run-scoped bridge from the SDK tool adapter to the existing
// host/tool-runtime.js + host/tool-definitions.js dispatch path.
//
// Two jobs, both required by task 3.4 ("Integrate host/tool-runtime.js,
// host/tool-definitions.js, host/endpoint.js, and host/parent-watch.js with
// run IDs, scope enforcement, and a single browser lease"):
//   1. Attach the run-identifying metadata (run id, conversation id, browser
//      identity, tab scope, unique request id) to every dispatched call.
//   2. Distinguish "the browser told us no" from "we dispatched and the
//      connection dropped before we heard back" — the latter must be
//      reported as result-unknown and NEVER retried automatically (spec:
//      "Recover without duplicate side effects").
//
// This module holds no process-global state: `init`/`callTool`/`shutdown`
// are injected (normally host/tool-runtime.js's real exports) so a test can
// substitute a fake without ever touching the real bridge, and so a
// companion process is free to use exactly one tool-runtime.js instance for
// its whole lifetime (see companion.js's single-init guard, which is what
// makes the group-1 ESM module-caching bug structurally impossible here:
// one companion process is permanently bound to one bridge/pipe for its
// entire life, and never re-imports tool-runtime.js for a different one).

import { HOST_DROPPED_ERROR } from "../../tool-runtime.js";

/**
 * @param {string} resultText - the text content of a callTool() result
 *   (host/tool-runtime.js collapses transport errors into
 *   `Error: ${err.message}` text content — see its callTool()).
 */
export function isResultUnknown(resultText) {
  return typeof resultText === "string" && resultText.includes(HOST_DROPPED_ERROR.split(".")[0]);
}

function firstText(result) {
  const block = Array.isArray(result?.content) ? result.content.find((b) => b.type === "text") : null;
  return block ? block.text : "";
}

export class ToolBridge {
  /**
   * @param {object} deps
   * @param {() => Promise<void>} deps.init
   * @param {(name: string, args: object, meta?: object) => Promise<object>} deps.callTool
   * @param {() => void} deps.shutdown
   */
  constructor(deps) {
    this._init = deps.init;
    this._callTool = deps.callTool;
    this._shutdown = deps.shutdown;
    this._initialized = false;
  }

  async ensureInit() {
    if (this._initialized) return;
    this._initialized = true;
    await this._init();
  }

  /**
   * @returns {Promise<{ result: object, resultUnknown: boolean }>}
   */
  async call(toolName, args, meta) {
    await this.ensureInit();
    const result = await this._callTool(toolName, args, meta);
    return { result, resultUnknown: isResultUnknown(firstText(result)) };
  }

  shutdown() {
    this._shutdown();
  }
}

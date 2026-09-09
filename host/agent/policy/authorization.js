// Unconditional handler-side authorization.
//
// design.md decision 2: "Validate run state, arguments, browser lease, and
// tab scope inside each tool handler, even when SDK permission checks
// preapprove the tool." The SDK's own permission callback is a UX gate (did
// a human agree to let this run act at all); it is not a substitute for this
// check, which runs on every single dispatch regardless of what the SDK
// already decided, and cannot be short-circuited by anything a page or a
// model said.
//
// This module holds no state of its own — every check is a pure function
// over the caller-supplied run/lease/scope/allowlist snapshot, so it is
// trivial to unit test every rejection path without standing up a real SDK
// run or a real browser.

import { isTabInScope } from "../broker/browser-lease.js";

export class AuthorizationError extends Error {
  constructor(reason, detail = {}) {
    super(`authorization rejected: ${reason}`);
    this.name = "AuthorizationError";
    this.reason = reason;
    this.detail = detail;
  }
}

// Tools whose args carry a tab identity that must be checked against the
// run's tab scope. Tools not in this map are scope-free (e.g. get_config,
// shortcuts_list) and are authorized purely on run-state grounds.
const TAB_ARG_KEYS = {
  navigate: ["tabId"],
  computer: ["tabId"],
  find: ["tabId"],
  form_input: ["tabId"],
  get_page_text: ["tabId"],
  javascript_tool: ["tabId"],
  read_console_messages: ["tabId"],
  read_network_requests: ["tabId"],
  read_page: ["tabId"],
  set_tab_focus: ["tabId"],
  upload_image: ["tabId"],
  file_upload: ["tabId"],
  tabs_close_mcp: ["tabId", "tabIds"]
};

/**
 * Per-run allowlist of local filesystem paths a user has explicitly selected
 * for upload in this run. `file_upload` takes arbitrary absolute paths by
 * contract (existing tool schema), so this is the only thing standing between
 * "browse the user's whole filesystem" and "attach the file the user picked".
 * Nothing populates this except an explicit user selection surfaced by the
 * (future) panel UI; a model asking for a path never adds it.
 */
export class RunUploadAllowlist {
  constructor() {
    this._paths = new Set();
  }
  allow(absolutePath) {
    this._paths.add(normalizePath(absolutePath));
  }
  isAllowed(absolutePath) {
    return this._paths.has(normalizePath(absolutePath));
  }
}

function normalizePath(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * @param {object} ctx
 * @param {string} ctx.toolName
 * @param {object} ctx.args
 * @param {"queued"|"running"|"stopped"|"done"} ctx.runState
 * @param {boolean} ctx.leaseHeldByThisRun
 * @param {Array<number>|'any'} ctx.tabScope
 * @param {RunUploadAllowlist} [ctx.uploadAllowlist]
 * @param {Set<string>} ctx.knownToolNames
 * @throws {AuthorizationError}
 */
export function authorizeToolCall(ctx) {
  const { toolName, args = {}, runState, leaseHeldByThisRun, tabScope, uploadAllowlist, knownToolNames } = ctx;

  if (!knownToolNames || !knownToolNames.has(toolName)) {
    throw new AuthorizationError("unknown_tool", { toolName });
  }

  // Stop blocks subsequent dispatch (spec: "Stop during execution" scenario).
  if (runState === "stopped" || runState === "done") {
    throw new AuthorizationError("run_not_active", { runState });
  }

  if (!leaseHeldByThisRun) {
    throw new AuthorizationError("lease_not_held", {});
  }

  const tabArgKeys = TAB_ARG_KEYS[toolName];
  if (tabArgKeys) {
    for (const key of tabArgKeys) {
      const value = args[key];
      if (value === undefined || value === null) continue;
      const ids = Array.isArray(value) ? value : [value];
      for (const tabId of ids) {
        if (typeof tabId !== "number" || !isTabInScope(tabScope, tabId)) {
          throw new AuthorizationError("tab_out_of_scope", { toolName, tabId, tabScope });
        }
      }
    }
  }

  if (toolName === "file_upload") {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    if (paths.length === 0) throw new AuthorizationError("missing_paths", { toolName });
    for (const p of paths) {
      if (typeof p !== "string" || !path_isAbsolute(p)) {
        throw new AuthorizationError("path_not_absolute", { toolName, path: p });
      }
      if (!uploadAllowlist || !uploadAllowlist.isAllowed(p)) {
        throw new AuthorizationError("path_not_allowlisted", { toolName, path: p });
      }
    }
  }

  if (toolName === "upload_image") {
    if (typeof args.imageId !== "string" || !args.imageId) {
      throw new AuthorizationError("missing_image_id", { toolName });
    }
    // imageId references an in-memory, already-captured screenshot/user
    // upload keyed by id inside the extension (see extension/background.js's
    // screenshotStore) — not a filesystem path — so there is nothing further
    // to allowlist here beyond the tab scope check above.
  }

  return { ok: true };
}

// A tiny absolute-path check that works for both POSIX ("/...") and Windows
// ("C:\..." / "C:/...") without pulling in node:path (this module has no
// other Node built-in dependency and stays platform-agnostic on purpose so
// it can be unit tested identically on every CI platform).
function path_isAbsolute(p) {
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p);
}

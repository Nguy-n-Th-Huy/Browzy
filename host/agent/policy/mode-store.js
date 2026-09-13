// Local persistence for the active permission mode (task: production wiring
// / local persistence half of add-permission-modes-and-threat-signals).
//
// A single global setting — one mode for the whole local profile, default
// "auto" — written atomically through the project's existing crash-safe
// helper (host/agent/settings/atomic-store.js's write-temp-then-rename), so
// a process killed mid-write can never leave a truncated mode file the next
// read observes. Stored alongside the per-site store (site-store.js) under
// the same `agentRoot()/permissions/` directory, since both are local
// permission-policy state read at decision time by the same callers
// (host/agent/companion.js's live `policySnapshot` getter).
//
// A managed mode pin is NEVER written here: managed policy lives only in
// memory (see companion.js), is re-read on every decision, and never
// persists as if it had been chosen locally (design.md decision 7 / task
// 4.3). This file has no notion of "managed" at all — it is local-only by
// construction.
import path from "node:path";
import { agentRoot } from "../skills/paths.js";
import { writeJsonAtomic, readJsonAtomic } from "../settings/atomic-store.js";
import { PERMISSION_MODES, DEFAULT_MODE, normalizeMode } from "./permission-modes.js";

function modeFile(root = agentRoot()) {
  return path.join(root, "permissions", "mode.json");
}

/**
 * @param {string} [root]
 * @returns {string} the persisted local mode, or DEFAULT_MODE ("auto") when
 *   nothing has been chosen yet, or when the stored file is missing/corrupt/
 *   holds a value outside PERMISSION_MODES — a bad LOCAL file is treated the
 *   same as "unconfigured", never surfaced as an error (unlike a malformed
 *   MANAGED policy, which task 4.4 requires to be reported rather than
 *   silently treated as absent: there is no administrator to fail loudly for
 *   here, and a corrupt local file should not brick the runtime's default).
 */
export function readLocalMode(root = agentRoot()) {
  let parsed;
  try {
    parsed = readJsonAtomic(modeFile(root));
  } catch {
    return DEFAULT_MODE;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_MODE;
  if (typeof parsed.mode !== "string" || !PERMISSION_MODES.includes(parsed.mode)) return DEFAULT_MODE;
  return parsed.mode;
}

/**
 * @param {string} mode - must be one of PERMISSION_MODES; normalized via
 *   normalizeMode() (an invalid value falls back to DEFAULT_MODE rather than
 *   persisting garbage — callers that need to reject an invalid mode outright
 *   validate BEFORE calling this, e.g. companion.js's set_permission_mode op).
 * @param {string} [root]
 */
export function writeLocalMode(mode, root = agentRoot()) {
  const normalized = normalizeMode(mode);
  writeJsonAtomic(modeFile(root), { mode: normalized });
  return normalized;
}

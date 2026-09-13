// Per-site permission store: remembered user decisions, origin-scoped.
//
// A remembered decision is consulted to PRODUCE a decision; it never
// substitutes for an approval token (design non-goal 1). Entries cover
// mutating/send action classes only — protected actions are never storable
// (enforced here by shape, and upstream by never calling record() for one).
//
// Persistence lives under OCIC_AGENT_HOME/permissions/sites.json (same root
// convention as host/agent/skills/paths.js), so tests isolate with a temp
// dir. Managed entries are NOT stored here: the resolver merges managed
// site entries at read time from the validated managed policy, so a
// withdrawn policy leaves no local residue (task 4.3).
//
// Writes go through the project's existing crash-safe atomic-write helper
// (host/agent/settings/atomic-store.js's write-temp-then-rename), the same
// one host/agent/settings/profile-store.js and this module's sibling
// mode-store.js use — a process killed mid-write can never leave a
// truncated store the next read observes. Reads stay a tolerant
// fs.readFileSync + JSON.parse (not atomic-store's readJsonAtomic, which
// THROWS on invalid JSON by design): a corrupt file here must read back as
// an empty store, never throw — this is a best-effort LOCAL cache, not a
// document whose corruption an administrator needs to be told about (that
// distinction is what task 4.4's managed-policy handling is for).
import fs from "node:fs";
import path from "node:path";
import { agentRoot } from "../skills/paths.js";
import { writeJsonAtomic } from "../settings/atomic-store.js";
import { REMEMBERABLE_CLASSES } from "./permission-modes.js";

function storeFile(root = agentRoot()) {
  return path.join(root, "permissions", "sites.json");
}

function normalizeOrigin(origin) {
  const u = new URL(String(origin || ""));
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`unsupported protocol in origin "${origin}"`);
  return u.origin;
}

export function readSiteStore(root = agentRoot()) {
  try {
    const raw = fs.readFileSync(storeFile(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e.origin === "string" &&
        REMEMBERABLE_CLASSES.includes(e.actionClass) &&
        (e.decision === "allow" || e.decision === "deny")
    );
  } catch {
    return [];
  }
}

function writeSiteStore(entries, root = agentRoot()) {
  writeJsonAtomic(storeFile(root), entries);
}

/**
 * Find the entry for an exact origin + action class. Origin-scoped: no
 * match across a different origin (including a different subdomain) and no
 * match across a different action class (task 3.3).
 */
export function matchSiteEntry(entries, origin, actionClass) {
  let want = null;
  try {
    want = normalizeOrigin(origin);
  } catch {
    return null;
  }
  return entries.find((e) => e.origin === want && e.actionClass === actionClass) || null;
}

/**
 * Record a decision. Call ONLY from the explicit user-decision channel
 * (the approval_decision reply handler): page content, tool output, and
 * skill instructions have no path to this function, and nothing else in the
 * codebase imports it — see test/site-store.test.mjs's import-graph check.
 */
export function recordSiteEntry({ origin, actionClass, decision }, root = agentRoot()) {
  const entry = {
    origin: normalizeOrigin(origin),
    actionClass,
    decision,
    at: new Date().toISOString(),
    source: "local"
  };
  if (!REMEMBERABLE_CLASSES.includes(actionClass)) {
    throw new Error(`action class "${actionClass}" is not rememberable`);
  }
  if (decision !== "allow" && decision !== "deny") throw new Error(`decision must be allow or deny`);
  const entries = readSiteStore(root).filter((e) => !(e.origin === entry.origin && e.actionClass === entry.actionClass));
  entries.push(entry);
  writeSiteStore(entries, root);
  return entry;
}

export function revokeSiteEntry(origin, actionClass, root = agentRoot()) {
  const want = normalizeOrigin(origin);
  const entries = readSiteStore(root);
  const kept = entries.filter((e) => !(e.origin === want && (actionClass === undefined || e.actionClass === actionClass)));
  const removed = entries.length - kept.length;
  if (removed) writeSiteStore(kept, root);
  return removed;
}

export function revokeAllSiteEntries(root = agentRoot()) {
  const entries = readSiteStore(root);
  if (entries.length) writeSiteStore([], root);
  return entries.length;
}

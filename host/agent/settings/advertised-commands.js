// The advertised-slash-command record (design.md decision 4 / tasks.md
// group 2): what the SDK itself told this installation it supports, as
// observed on the `system`/`init` message of a real `query()` run - never a
// hardcoded guess about which slash commands a given SDK build/provider
// combination happens to support (proposal.md: "Nothing in this codebase
// reads [slash_commands/terminal_slash_commands] today").
//
// One JSON document, replaced WHOLESALE on every observation - this matches
// sdk.d.ts's own documented semantics for `SDKCommandsChangedMessage`
// ("Clients should REPLACE their cached command list with this payload"),
// so a later change adding that mid-session push needs no new record shape,
// only a second call site into recordAdvertisedCommands() below.
//
// Path convention: this module writes under the SAME per-user root
// host/agent/skills/paths.js and host/agent/storage/paths.js both call
// `agentRoot()` (`OCIC_AGENT_HOME`, else `~/.config/browzy-in-chrome/agent`)
// - design.md decision 4 says the record lives "under the agent root,
// alongside the existing per-area stores" (conversations/, skills/), not
// under settings/paths.js's flat `configDir()` (no "agent" subdirectory,
// used only by the single profile file). Like skills/paths.js, this module
// deliberately does NOT import either existing agentRoot() implementation
// and instead restates the same two-line convention locally: skills/paths.js
// took the same approach for the same reason (see its own header) - two
// concurrently-active work streams each depending on the OTHER's paths
// module would mean an edit to one could silently change the other's
// behaviour. Both existing copies are already byte-identical; this is a
// third, equally-independent copy of the same convention, not a new one.
//
// Persisted (not in-memory) on purpose: the companion process restarts
// routinely (native-host.js forks a fresh one per bridge), and an in-memory
// record would silently regress "available after the first observation" to
// "available until the host next restarts" - see design.md's Goals/
// Non-Goals and Risks sections.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic, readJsonAtomic, cleanupStaleTempFiles } from "./atomic-store.js";

function agentRoot() {
  if (process.env.OCIC_AGENT_HOME) return process.env.OCIC_AGENT_HOME;
  return path.join(os.homedir(), ".config", "browzy-in-chrome", "agent");
}

function advertisedCommandsFilePath() {
  return path.join(agentRoot(), "slash-commands.json");
}

// The application-approved built-in slash-command allowlist (design.md
// decision 5 / tasks.md 2.5, EMPTIED by decision 8 / tasks.md 5.6): the
// candidate was exactly `cost` - `/compact`, `/context`, `/clear` and
// `/model` were considered and explicitly not approved (proposal.md's "Out
// of scope, deliberately"; `/clear` and `/model` duplicate panel-owned
// surfaces). A command being in this list is NEVER itself authorization - it
// only narrows which advertised, non-terminal command the picker/gate may
// treat as a built-in at all (see deriveApprovedBuiltinCommands() below and
// specs/agent-skills/spec.md's "Advertisement is not authorization").
//
// THIS IS DELIBERATELY EMPTY - not unfinished work. A real advertised record
// captured from this operator's configuration was read (design.md decision
// 8) and contained `usage`, `context`, `compact`, `clear`, `model`, `effort`,
// `recap` and others, but NO `cost` - so `["cost"]` would leave the built-in
// section permanently and silently empty anyway. Given that evidence, the
// operator's decision was to keep the entire discovery/approval mechanism
// (this record, its persistence, the read op, deriveApprovedBuiltinCommands(),
// and the gate's built-in branch all stay) and empty the allowlist rather
// than substitute a different command. A later reader must not "fix" this
// back to a non-empty guess without a new, evidenced approval decision.
export const APPROVED_BUILTIN_COMMANDS = Object.freeze([]);

function toStringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/**
 * Persist the SDK's advertised slash-command list, replacing whatever was
 * recorded before. Called from every place this product starts a real
 * `query()` and observes a `system`/`init` message (companion.js's
 * `_runQuery()` message loop, capability-test.js's `runSubTest()`).
 *
 * Recording is strictly observational (design.md decision 4): a caller MUST
 * wrap this in its own try/catch and swallow a failure - this function
 * itself does not swallow, so a write failure is still visible to whichever
 * caller chooses to log it, but it must never be allowed to fail a run or a
 * connection test.
 *
 * @param {{ commands: string[], terminalCommands?: string[] }} params -
 *   `commands` is the `system`/`init` message's `slash_commands` field;
 *   `terminalCommands` is its `terminal_slash_commands` field, when present.
 *   Non-string entries are dropped rather than corrupting the stored record.
 * @returns {{ commands: string[], terminalCommands: string[], observedAt: string }}
 *   the record actually written.
 */
export function recordAdvertisedCommands({ commands, terminalCommands } = {}) {
  const record = {
    commands: toStringArray(commands),
    terminalCommands: toStringArray(terminalCommands),
    observedAt: new Date().toISOString()
  };
  const filePath = advertisedCommandsFilePath();
  cleanupStaleTempFiles(filePath);
  writeJsonAtomic(filePath, record);
  return record;
}

/**
 * Read the persisted record.
 *
 * @returns {{ commands: string[], terminalCommands: string[], observedAt: string } | null}
 *   `null` when no record has ever been written (a normal, first-run state -
 *   design.md's migration plan: "The persisted record is created on first
 *   observation; its absence is a normal state, not an error") OR when the
 *   file on disk is missing/corrupt/not a plausible record - a malformed
 *   file is treated exactly like "no record yet" rather than thrown, since
 *   the next successful observation replaces it wholesale anyway.
 */
export function readAdvertisedCommands() {
  const filePath = advertisedCommandsFilePath();
  let loaded;
  try {
    cleanupStaleTempFiles(filePath);
    loaded = readJsonAtomic(filePath);
  } catch {
    return null; // corrupt JSON on disk - treated as "no record yet", never thrown
  }
  if (loaded === null || typeof loaded !== "object") return null;
  if (!Array.isArray(loaded.commands)) return null;
  return {
    commands: toStringArray(loaded.commands),
    terminalCommands: toStringArray(loaded.terminalCommands),
    observedAt: typeof loaded.observedAt === "string" ? loaded.observedAt : null
  };
}

/**
 * The picker/gate's approved built-in set for a given advertised record
 * (design.md decision 3/5): `advertised - terminalCommands ∩ allowlist`.
 * Pure and side-effect-free so both the host-side gate (task 1.2's third
 * argument) and any test can call it directly against a record value
 * without touching disk.
 *
 * An empty, missing (`null`), or malformed record yields an empty result -
 * the honest "no built-ins yet" outcome specs/agent-skills/spec.md's "No
 * advertised list yet" scenario requires, never a guessed fallback.
 *
 * @param {{ commands: string[], terminalCommands: string[] } | null} record
 * @param {Iterable<string>} [allowlist] defaults to APPROVED_BUILTIN_COMMANDS
 * @returns {string[]} approved built-in command names, in allowlist order
 */
export function deriveApprovedBuiltinCommands(record, allowlist = APPROVED_BUILTIN_COMMANDS) {
  if (!record || !Array.isArray(record.commands)) return [];
  const terminal = new Set(Array.isArray(record.terminalCommands) ? record.terminalCommands : []);
  const advertised = new Set(record.commands.filter((c) => typeof c === "string" && !terminal.has(c)));
  return Array.from(allowlist || []).filter((name) => advertised.has(name));
}

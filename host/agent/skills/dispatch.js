// The application-side authorization gate: SDK-discovered skill metadata is
// not itself an authorization list (design.md section 7, superseded by
// decision 9). Whatever the SDK can see via the session's own materialized
// skill plugin (host/agent/skills/session-workspace.js's buildSessionSkills()),
// only a command that is present, enabled, and user-invocable in the
// session's OWN bound catalogSnapshot may be dispatched - checked here,
// before anything reaches the SDK, including a manually typed command.

import { SkillDispatchError, SkillSnapshotMismatchError } from "./errors.js";
import { listCatalog } from "./manage.js";
import { SESSION_SKILLS_PLUGIN_NAME } from "./session-workspace.js";

// Single place that decides where a typed/selected command's name ends and
// its task-argument text begins - both normalizeCommandName() (name only,
// used by the gate above) and buildSkillDispatchPrompt() (name + verbatim
// argsText, used by the conveyance builder below) call this instead of each
// re-parsing the leading "/" and first-token boundary their own way
// (tasks.md 1.1: "reuse the module's existing normalizeCommandName()
// parsing rather than re-parsing ... a second time"). Only ONE separator
// character (the whitespace that ends the command token) is ever consumed,
// so argsText is exactly the rest of the input, byte-for-byte - a caller
// that wants a fully-trimmed command overall (composer text always is,
// since extractSlashCommand() in companion.js already trims the whole
// prompt before this runs) still gets that; the argument text itself is
// never trimmed, so embedded/trailing whitespace, newlines and unicode the
// operator actually typed survive untouched.
function splitCommandText(commandName) {
  if (typeof commandName !== "string" || commandName.trim() === "") return { name: "", argsText: "" };
  let cmd = commandName.trim();
  if (cmd.startsWith("/")) cmd = cmd.slice(1);
  // Tolerate a caller passing the raw typed composer text
  // ("/name task arguments here") - only the first token is the command.
  const spaceIdx = cmd.search(/\s/);
  if (spaceIdx === -1) return { name: cmd, argsText: "" };
  return { name: cmd.slice(0, spaceIdx), argsText: cmd.slice(spaceIdx + 1) };
}

function normalizeCommandName(commandName) {
  return splitCommandText(commandName).name;
}

/**
 * @param {string} commandName - the slash command as typed or selected, with
 *   or without its leading "/" and trailing arguments
 * @param {object[]} catalogSnapshot - the bound snapshot for this
 *   conversation/run, as returned by buildSessionSkills()
 * @param {Iterable<string>} [approvedBuiltins] - the run's approved built-in
 *   command names (design.md decision 3/5: the host-side intersection of
 *   what the SDK advertised, minus its terminal-bound subset, intersected
 *   with the application allowlist). Absent or empty preserves today's
 *   behaviour exactly - every command not in the skill catalog is
 *   UNKNOWN_COMMAND, the same as before this parameter existed.
 * @returns {object} the matching, allowed entry, tagged `kind: "skill"` for
 *   a catalog match or `kind: "builtin"` for an approved built-in match.
 *   Every existing property of a skill entry (name, enabled,
 *   userInvocable, ...) is preserved on the returned object.
 * @throws {SkillDispatchError} UNKNOWN_COMMAND, DISABLED, NOT_USER_INVOCABLE,
 *   or UNSUPPORTED_CAPABILITY
 */
export function assertSlashDispatchAllowed(commandName, catalogSnapshot, approvedBuiltins) {
  const cmd = normalizeCommandName(commandName);
  if (!cmd) {
    throw new SkillDispatchError("UNKNOWN_COMMAND", "No command name was provided.");
  }

  const entries = Array.isArray(catalogSnapshot) ? catalogSnapshot : [];
  const entry = entries.find((s) => s && s.name === cmd);
  // Precedence: the skill catalog is checked FIRST, unconditionally - a
  // skill can never be shadowed by a same-named built-in (design.md
  // decision 3). Only when there is no skill by this name do we consult
  // the approved built-in set at all.
  if (entry) {
    if (entry.enabled !== true) {
      throw new SkillDispatchError(
        "DISABLED",
        `The "/${cmd}" skill is disabled and cannot be run. Enable it in Settings > Skills first.`
      );
    }
    if (entry.userInvocable === false) {
      throw new SkillDispatchError(
        "NOT_USER_INVOCABLE",
        `The "/${cmd}" skill does not support direct slash invocation.`
      );
    }
    if (entry.unsupportedCapabilities && entry.unsupportedCapabilities.length > 0) {
      throw new SkillDispatchError(
        "UNSUPPORTED_CAPABILITY",
        `The "/${cmd}" skill requires unsupported capabilities (${entry.unsupportedCapabilities.join(", ")}) and cannot be run.`
      );
    }
    return { ...entry, kind: "skill" };
  }

  const builtins = approvedBuiltins instanceof Set ? approvedBuiltins : new Set(approvedBuiltins || []);
  if (builtins.has(cmd)) {
    return { name: cmd, kind: "builtin" };
  }

  throw new SkillDispatchError(
    "UNKNOWN_COMMAND",
    `Unknown command "/${cmd}". No imported, approved skill has this name.`
  );
}

/**
 * Builds the fixed, inspectable prompt actually sent to query() for an
 * AUTHORIZED skill dispatch (design.md decision 1 / tasks.md 1.1). Call this
 * ONLY after assertSlashDispatchAllowed() has already returned a `kind:
 * "skill"` match for the exact same `commandText` - never before the gate,
 * and never for a built-in (a built-in must reach the SDK exactly as typed).
 *
 * Shape: `Use the "<name>" skill.` followed by a blank line and the
 * operator's own text after the command, copied byte-for-byte (including
 * embedded newlines, quotes and unicode - see splitCommandText() above) -
 * the trailing block is omitted entirely, not left as an empty line, when
 * the operator typed no arguments.
 *
 * `<name>` is the skill's PLUGIN-QUALIFIED canonical name
 * ("${SESSION_SKILLS_PLUGIN_NAME}:<name>"), never the bare name the operator
 * typed - design.md decision 9's empirical finding is that this is the exact
 * identity the `Skill` tool resolves against, since
 * host/agent/skills/session-workspace.js's buildSessionSkills() materializes
 * every session's approved snapshots as a local plugin under that fixed
 * constant name. This qualification is purely an SDK-facing conveyance
 * detail: the operator's own typed `/name` text, the composer, and the
 * conversation transcript are entirely unaffected (they are already fixed by
 * the time this function is ever called - see companion.js's
 * `_handleStart()`), and assertSlashDispatchAllowed() below still matches
 * the operator's BARE command name against the application's own bare
 * catalog.
 *
 * @param {string} commandText - the same command text (with or without a
 *   leading "/") that was just passed to assertSlashDispatchAllowed().
 * @returns {string} the prompt to send to query() in place of the raw
 *   command text.
 */
export function buildSkillDispatchPrompt(commandText) {
  const { name, argsText } = splitCommandText(commandText);
  const header = `Use the "${SESSION_SKILLS_PLUGIN_NAME}:${name}" skill.`;
  return argsText ? `${header}\n\n${argsText}` : header;
}

/**
 * Bonus helper beyond the three mandatory exports - implements design.md's
 * "resume rechecks the enabled catalog; if a required snapshot is
 * unavailable or disabled, require a new conversation rather than silently
 * swapping instructions." Not wired into any resume flow by this change
 * (conversation resume is owned by group 3); exported so whichever code
 * handles resume can call it. See reports/07-skills-evidence.md.
 *
 * @param {object[]} boundCatalogSnapshot - the catalogSnapshot that was
 *   bound to the conversation being resumed (persisted alongside its
 *   transcript by whichever code owns that persistence)
 * @throws {SkillSnapshotMismatchError} if any bound skill is now removed,
 *   disabled, or changed (different snapshotId or hash) in the live catalog
 */
export async function assertResumeSnapshotAvailable(boundCatalogSnapshot) {
  const current = await listCatalog();
  const currentByName = new Map(current.map((s) => [s.name, s]));
  const mismatches = [];
  for (const bound of boundCatalogSnapshot || []) {
    const now = currentByName.get(bound.name);
    if (!now) {
      mismatches.push({ name: bound.name, reason: "removed" });
    } else if (now.enabled !== true) {
      mismatches.push({ name: bound.name, reason: "disabled" });
    } else if (now.snapshotId !== bound.snapshotId || now.hash !== bound.hash) {
      mismatches.push({ name: bound.name, reason: "changed" });
    }
  }
  if (mismatches.length > 0) {
    throw new SkillSnapshotMismatchError(
      `This conversation's skill snapshot is no longer available (${mismatches
        .map((m) => `${m.name}: ${m.reason}`)
        .join(", ")}). Start a new conversation to use the current catalog.`,
      { mismatches }
    );
  }
  return true;
}

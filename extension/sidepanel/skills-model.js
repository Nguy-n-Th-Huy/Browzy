// DOM-free logic for the composer's slash picker (specs/agent-skills.md
// "Searchable slash picker"; design.md section 7). Kept pure so it is
// directly unit-testable (test/sidepanel-slash-picker-model.test.mjs)
// without any chrome.*/document dependency, the same convention
// extension/sidepanel/conversation-model.js and page-context.js already use.

/**
 * The application-approved built-in slash-command allowlist
 * (repair-slash-dispatch-and-builtin-commands, design.md decision 5 /
 * tasks.md 3.2, EMPTIED by decision 8 / tasks.md 5.6). The candidate was
 * exactly `cost`. `/compact`, `/context`, `/clear` and `/model` were
 * considered and explicitly not approved (proposal.md's "Out of scope,
 * deliberately" — `/clear` and `/model` duplicate panel-owned surfaces).
 *
 * A plain array of command NAMES only (not `{name, description}` objects),
 * deliberately kept the exact same shape as the host-side constant of the
 * same name (host/agent/settings/advertised-commands.js's
 * APPROVED_BUILTIN_COMMANDS) — test/sidepanel-slash-picker-model.test.mjs
 * asserts the two hold the identical value, so the two copies (one per
 * side, since the extension and the native host never share a module
 * across that boundary) cannot silently drift apart. Being IN this list is
 * never itself authorization: the picker only ever offers one of these
 * names when the SDK has ALSO actually advertised it and not marked it
 * terminal-bound — see deriveBuiltinCommands() below and
 * specs/agent-skills/spec.md's "Advertisement is not authorization".
 *
 * THIS IS DELIBERATELY EMPTY - not unfinished work. A real advertised record
 * captured from this operator's configuration contained `usage`, `context`,
 * `compact`, `clear`, `model`, `effort`, `recap` and others, but NO `cost` -
 * so `["cost"]` would leave the built-in section permanently and silently
 * empty anyway. The operator's decision, given that evidence, was to keep
 * the entire mechanism (this constant, deriveBuiltinCommands(), the
 * `kind: "builtin"` wiring in buildPickerItems()) and empty the allowlist
 * rather than substitute a different command. Do not "fix" this back to a
 * non-empty guess without a new, evidenced approval decision.
 */
export const APPROVED_BUILTIN_COMMANDS = [];

// Display copy for an approved built-in, shown in the picker exactly like a
// skill's own description (Vietnamese, matching this panel's existing
// composer/picker copy). Deliberately separate from the allowlist above so
// that constant stays a plain, directly-comparable array of names.
const BUILTIN_COMMAND_DESCRIPTIONS = {
  cost: "Xem chi phí và mức sử dụng token của phiên hiện tại."
};

/**
 * The picker's built-in entries for one advertised-command record
 * (design.md decision 5): `advertised − terminalCommands ∩
 * APPROVED_BUILTIN_COMMANDS`, each returned as a picker item tagged
 * `kind: "builtin"`.
 *
 * An empty, missing (`null`/`undefined`), or malformed record — e.g. no
 * `commands` array at all, the shape a companion that predates this op
 * replies with, or simply "the SDK has never advertised anything for this
 * installation yet" — yields NO built-ins. That is the honest outcome
 * specs/agent-skills/spec.md's "No advertised list yet" scenario requires,
 * never a guessed fallback that would offer a command the SDK might not
 * actually support for this operator's configuration.
 *
 * `allowlist` defaults to APPROVED_BUILTIN_COMMANDS (mirroring the host
 * side's `deriveApprovedBuiltinCommands(record, allowlist =
 * APPROVED_BUILTIN_COMMANDS)`), and exists so a test can exercise the
 * intersection/terminal-bound-exclusion logic against an injected non-empty
 * allowlist even while the shipped default constant is empty (design.md
 * decision 8 / tasks.md 5.7) — without this parameter, an empty constant
 * would leave that logic itself untestable.
 *
 * @param {{ commands?: string[], terminalCommands?: string[] } | null | undefined} advertisedRecord
 * @param {string[]} [allowlist] defaults to APPROVED_BUILTIN_COMMANDS
 * @returns {{ name: string, description: string, kind: "builtin" }[]}
 */
export function deriveBuiltinCommands(advertisedRecord, allowlist = APPROVED_BUILTIN_COMMANDS) {
  if (!advertisedRecord || !Array.isArray(advertisedRecord.commands)) return [];
  const terminal = new Set(Array.isArray(advertisedRecord.terminalCommands) ? advertisedRecord.terminalCommands : []);
  const advertised = new Set(advertisedRecord.commands.filter((c) => typeof c === "string" && !terminal.has(c)));
  return Array.from(allowlist || [])
    .filter((name) => advertised.has(name))
    .map((name) => ({
      name,
      description: BUILTIN_COMMAND_DESCRIPTIONS[name] || "",
      kind: "builtin"
    }));
}

/**
 * @param {object} skill - one entry from listCatalog()'s result shape
 *   (name, description, enabled, userInvocable, modelInvocable,
 *   unsupportedCapabilities, ...).
 */
export function isPickerEligible(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (skill.enabled !== true) return false;
  if (skill.userInvocable === false) return false;
  if (Array.isArray(skill.unsupportedCapabilities) && skill.unsupportedCapabilities.length > 0) return false;
  return true;
}

/**
 * Builds the full picker item list from a raw catalog: enabled + user-
 * invocable skills only (spec: "a hidden automatic-only skill can be enabled
 * without appearing in the picker" — a skill with userInvocable === false is
 * filtered out here regardless of modelInvocable/enabled), each tagged
 * `kind: "skill"`, prefixed by any approved built-in commands tagged
 * `kind: "builtin"` (see deriveBuiltinCommands() above) so the picker can
 * render a visually distinct affordance for the two kinds without
 * re-deriving it, and so built-ins render ahead of skills.
 *
 * @param {object[]} catalog - listCatalog()'s raw result (may include
 *   disabled/non-user-invocable/unsupported entries — this function is the
 *   filter).
 * @param {{ commands?: string[], terminalCommands?: string[] } | null} [advertisedRecord] -
 *   getAdvertisedCommands()'s raw result. Omitted/null yields no built-ins
 *   (deriveBuiltinCommands()'s own honest-empty-result rule) — a caller
 *   that has not fetched it yet (or whose fetch failed) still gets a
 *   correct, skills-only picker rather than an error.
 */
export function buildPickerItems(catalog, advertisedRecord) {
  const builtins = deriveBuiltinCommands(advertisedRecord);
  const skills = (Array.isArray(catalog) ? catalog : [])
    .filter(isPickerEligible)
    .map((s) => ({ name: s.name, description: s.description || "", kind: "skill" }));
  return [...builtins, ...skills];
}

/**
 * Filters an already-built item list by the query typed after "/" (matches
 * name or description, case-insensitive substring — spec: "filtering by name
 * or description"). An empty query returns every item.
 */
export function filterPickerItems(items, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.name.toLowerCase().includes(q) || (item.description || "").toLowerCase().includes(q)
  );
}

/**
 * Extracts the raw "/query" text typed in the composer, or null when the
 * composer does not currently look like an in-progress slash command (spec:
 * "Typing `/` in the composer SHALL open a picker"). Only fires while the
 * WHOLE composer value is a single leading-slash token with no space yet —
 * once the user has typed a space (i.e. is now typing task arguments after
 * a chosen/typed command), the picker should not still be intercepting
 * keystrokes as a filter query.
 *
 * @returns {{ query: string } | null}
 */
export function parseSlashQuery(composerValue) {
  const m = /^\/(\S*)$/.exec(composerValue || "");
  if (!m) return null;
  return { query: m[1] };
}

/**
 * Builds the exact invocation text inserted into the composer on selection
 * (spec: "Selection SHALL insert the exact invocation for review before
 * Send" — never auto-submits). A trailing space positions the cursor ready
 * for the user to type task arguments.
 */
export function buildInvocationText(item) {
  return `/${item.name} `;
}

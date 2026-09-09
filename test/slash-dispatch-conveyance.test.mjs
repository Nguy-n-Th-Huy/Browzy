#!/usr/bin/env node
// repair-slash-dispatch-and-builtin-commands, tasks.md 1.4.
//
// Pure, host-side coverage for host/agent/skills/dispatch.js's two changes:
//   - buildSkillDispatchPrompt(): the fixed conveyance wrapper (design.md
//     decision 1) that makes an authorized skill dispatch actually invoke
//     the SDK's Skill tool instead of landing in the SDK's own unrelated
//     slash-command namespace and failing with "Unknown command".
//   - assertSlashDispatchAllowed()'s widened built-in precedence (design.md
//     decision 3): a third, optional approvedBuiltins argument that must
//     leave every existing caller/test's behaviour untouched when absent.
//
// No companion, no transport, no SDK — matches host/test/skills-dispatch.test.mjs's
// own "pure gate function, no process" convention exactly.
//
// Run: node test/slash-dispatch-conveyance.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertSlashDispatchAllowed,
  buildSkillDispatchPrompt,
  SkillDispatchError,
  SESSION_SKILLS_PLUGIN_NAME
} from "../host/agent/skills/index.js";

// design.md decision 9: buildSkillDispatchPrompt() names the skill by its
// plugin-qualified canonical name (the empirically-observed form the SDK's
// Skill tool actually resolves), never the operator's bare typed name.
const Q = (name) => `${SESSION_SKILLS_PLUGIN_NAME}:${name}`;

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function assertThrowsCode(fn, expectedCode, label) {
  try {
    fn();
  } catch (err) {
    ok(err instanceof SkillDispatchError, `${label}: throws a SkillDispatchError`);
    ok(err.code === expectedCode, `${label}: code is ${expectedCode}, got ${err.code}`);
    return;
  }
  ok(false, `${label}: expected a SkillDispatchError(${expectedCode}) to be thrown, nothing was`);
}

// Pure functions under test touch no disk, but every other test file in
// this repo isolates OCIC_AGENT_HOME regardless — matching that convention
// costs nothing and keeps this file safe to run alongside any other.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-slash-dispatch-conveyance-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

const sampleSnapshot = [
  { name: "enabled-skill", enabled: true, userInvocable: true, unsupportedCapabilities: [] },
  { name: "disabled-skill", enabled: false, userInvocable: true, unsupportedCapabilities: [] },
  { name: "hidden-skill", enabled: true, userInvocable: false, unsupportedCapabilities: [] },
  { name: "risky-skill", enabled: true, userInvocable: true, unsupportedCapabilities: ["Bash"] },
  { name: "cost", enabled: true, userInvocable: true, unsupportedCapabilities: [] } // shadow case below
];

console.log("== buildSkillDispatchPrompt: with and without arguments ==");
{
  ok(
    buildSkillDispatchPrompt("/marketing-research do the thing") ===
      `Use the "${Q("marketing-research")}" skill.\n\ndo the thing`,
    "with arguments: header (plugin-qualified name), blank line, then the operator's text verbatim"
  );
  ok(
    buildSkillDispatchPrompt("/marketing-research") === `Use the "${Q("marketing-research")}" skill.`,
    "with no arguments: the trailing block is omitted entirely, not left as an empty line"
  );
  ok(
    buildSkillDispatchPrompt("marketing-research") === `Use the "${Q("marketing-research")}" skill.`,
    "tolerates a missing leading slash, same as normalizeCommandName()"
  );
}

console.log("\n== buildSkillDispatchPrompt: arguments copied byte-for-byte ==");
{
  const withNewlines = "/task-runner line one\nline two\n\nline four";
  ok(
    buildSkillDispatchPrompt(withNewlines) === `Use the "${Q("task-runner")}" skill.\n\nline one\nline two\n\nline four`,
    "embedded newlines in the argument text survive exactly, including a blank line inside them"
  );

  const withQuotes = '/task-runner say "hello" and \'goodbye\'';
  ok(
    buildSkillDispatchPrompt(withQuotes) === `Use the "${Q("task-runner")}" skill.\n\nsay "hello" and 'goodbye'`,
    "double and single quotes in the argument text are not escaped or stripped"
  );

  const withUnicode = "/task-runner Tóm tắt trang này 🎉 — 中文";
  ok(
    buildSkillDispatchPrompt(withUnicode) === `Use the "${Q("task-runner")}" skill.\n\nTóm tắt trang này 🎉 — 中文`,
    "unicode (accents, CJK, emoji) in the argument text is preserved byte-for-byte"
  );

  const withInternalSlash = "/task-runner open /etc/hosts please";
  ok(
    buildSkillDispatchPrompt(withInternalSlash) === `Use the "${Q("task-runner")}" skill.\n\nopen /etc/hosts please`,
    "a slash appearing INSIDE the argument text (not at the very start) is just ordinary argument content"
  );
}

console.log("\n== assertSlashDispatchAllowed: absent/empty built-in set preserves today's exact behaviour ==");
{
  assertThrowsCode(() => assertSlashDispatchAllowed("/does-not-exist", sampleSnapshot), "UNKNOWN_COMMAND", "no 3rd arg, unknown command");
  assertThrowsCode(() => assertSlashDispatchAllowed("/does-not-exist", sampleSnapshot, []), "UNKNOWN_COMMAND", "empty 3rd arg, unknown command");
  assertThrowsCode(() => assertSlashDispatchAllowed("/disabled-skill", sampleSnapshot), "DISABLED", "DISABLED code is unchanged");
  assertThrowsCode(() => assertSlashDispatchAllowed("/hidden-skill", sampleSnapshot), "NOT_USER_INVOCABLE", "NOT_USER_INVOCABLE code is unchanged");
  assertThrowsCode(() => assertSlashDispatchAllowed("/risky-skill", sampleSnapshot), "UNSUPPORTED_CAPABILITY", "UNSUPPORTED_CAPABILITY code is unchanged");

  const entry = assertSlashDispatchAllowed("/enabled-skill do it", sampleSnapshot);
  ok(entry.name === "enabled-skill", "a plain skill match still resolves to the right entry");
  ok(entry.kind === "skill", "a skill match is now tagged kind: \"skill\"");
}

console.log("\n== assertSlashDispatchAllowed: an approved built-in is accepted ==");
{
  const entry = assertSlashDispatchAllowed("/cost", [], ["cost"]);
  ok(entry.name === "cost", "an approved built-in absent from the catalog resolves by name");
  ok(entry.kind === "builtin", "a built-in match is tagged kind: \"builtin\"");

  assertThrowsCode(
    () => assertSlashDispatchAllowed("/context", [], ["cost"]),
    "UNKNOWN_COMMAND",
    "a command NOT in the approved built-in set is still UNKNOWN_COMMAND"
  );

  // Accepts a Set too, not just an array (companion.js derives a Set-shaped
  // approved-builtins value from deriveApprovedBuiltinCommands()'s array —
  // both call shapes must work).
  const fromSet = assertSlashDispatchAllowed("/cost", [], new Set(["cost"]));
  ok(fromSet.kind === "builtin", "a Set of approved built-ins works the same as an array");
}

console.log("\n== assertSlashDispatchAllowed: gate precedence — a skill can never be shadowed by a same-named built-in ==");
{
  // sampleSnapshot above includes a real, enabled, user-invocable skill
  // literally named "cost" — the approved built-in set also contains "cost".
  // The skill MUST win (design.md decision 3: "skill catalog first, then
  // built-ins ... a skill can never be shadowed by a built-in name").
  const entry = assertSlashDispatchAllowed("/cost", sampleSnapshot, ["cost"]);
  ok(entry.kind === "skill", `the skill catalog entry wins over the same-named built-in — got kind: ${entry.kind}`);
  ok(entry.name === "cost", "and it is still the correct entry");
}

console.log("\n== assertSlashDispatchAllowed: a disabled/non-invocable/unsupported SKILL is still rejected even when its name is also an approved built-in ==");
{
  // Precedence means the catalog's OWN checks (disabled/user-invocable/
  // capability) still run for a name that happens to collide with a
  // built-in — the built-in path is never used as a bypass around a skill's
  // own gating.
  const collidingSnapshot = [{ name: "cost", enabled: false, userInvocable: true, unsupportedCapabilities: [] }];
  assertThrowsCode(
    () => assertSlashDispatchAllowed("/cost", collidingSnapshot, ["cost"]),
    "DISABLED",
    "a disabled skill named the same as an approved built-in is still rejected as DISABLED, not silently allowed as a built-in"
  );
}

console.log("\n== assertSlashDispatchAllowed: empty/missing command name is still rejected regardless of built-ins ==");
{
  assertThrowsCode(() => assertSlashDispatchAllowed("", sampleSnapshot, ["cost"]), "UNKNOWN_COMMAND", "empty command name");
  assertThrowsCode(() => assertSlashDispatchAllowed("/", sampleSnapshot, ["cost"]), "UNKNOWN_COMMAND", "bare slash");
}

console.log(fail === 0 ? "\nALL SLASH DISPATCH CONVEYANCE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

// Task 7.4: extension/sidepanel/skills-model.js pure-function tests — no
// DOM, no companion, deterministic. Mirrors the "DOM-free logic tested
// directly" convention test/sidepanel-page-context.test.mjs and
// test/sidepanel-conversation-model.test.mjs already use.
//
// repair-slash-dispatch-and-builtin-commands (tasks.md 3.6) extends this
// file with the built-in-command intersection: deriveBuiltinCommands() and
// the APPROVED_BUILTIN_COMMANDS allowlist that replaced the previously
// always-empty BUILTIN_COMMANDS.
//
// Run: node test/sidepanel-slash-picker-model.test.mjs
import {
  APPROVED_BUILTIN_COMMANDS,
  deriveBuiltinCommands,
  isPickerEligible,
  buildPickerItems,
  filterPickerItems,
  parseSlashQuery,
  buildInvocationText
} from "../extension/sidepanel/skills-model.js";
import { APPROVED_BUILTIN_COMMANDS as HOST_APPROVED_BUILTIN_COMMANDS } from "../host/agent/settings/advertised-commands.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

function skill(overrides = {}) {
  return {
    name: "tom-tat-trang",
    description: "Tóm tắt nội dung trang hiện tại.",
    enabled: true,
    userInvocable: true,
    modelInvocable: true,
    unsupportedCapabilities: [],
    ...overrides
  };
}

console.log("== isPickerEligible: enabled + user-invocable + no unsupported capability ==");
{
  ok(isPickerEligible(skill()) === true, "a plain enabled, user-invocable skill is eligible");
  ok(isPickerEligible(skill({ enabled: false })) === false, "a disabled skill is never eligible");
  ok(isPickerEligible(skill({ userInvocable: false })) === false, "a non-user-invocable skill is never eligible, even if enabled");
  ok(isPickerEligible(skill({ userInvocable: false, modelInvocable: true })) === false, "a hidden automatic-only skill (userInvocable:false, modelInvocable:true) does NOT appear in the picker even though it can still be enabled/auto-invoked");
  ok(isPickerEligible(skill({ unsupportedCapabilities: ["Bash"] })) === false, "an unsupported-capability skill is never eligible even if somehow marked enabled");
  ok(isPickerEligible(null) === false, "null is not eligible");
  ok(isPickerEligible(undefined) === false, "undefined is not eligible");
}

console.log("== buildPickerItems: filters the raw catalog down to eligible skills, tagged kind:\"skill\" ==");
{
  const catalog = [
    skill({ name: "a-enabled", description: "A" }),
    skill({ name: "b-disabled", enabled: false }),
    skill({ name: "c-hidden-auto", userInvocable: false, modelInvocable: true }),
    skill({ name: "d-unsupported", unsupportedCapabilities: ["Bash"] })
  ];
  const items = buildPickerItems(catalog); // no advertisedRecord -> no built-ins
  ok(items.length === 1 && items[0].name === "a-enabled", "only the eligible skill appears");
  ok(items[0].kind === "skill", "eligible skill items are tagged kind: \"skill\"");
}

console.log("== buildPickerItems: empty/malformed catalog never throws ==");
{
  ok(Array.isArray(buildPickerItems([])) && buildPickerItems([]).length === 0, "empty catalog -> empty items, the picker's own empty state renders");
  ok(Array.isArray(buildPickerItems(null)) && buildPickerItems(null).length === 0, "null catalog handled gracefully");
  ok(Array.isArray(buildPickerItems(undefined)) && buildPickerItems(undefined).length === 0, "undefined catalog handled gracefully");
}

console.log("== APPROVED_BUILTIN_COMMANDS: deliberately empty (design.md decision 8 / tasks.md 5.6), and identical between the panel and the host ==");
{
  // The candidate was exactly "cost", but a real advertised record for this
  // operator's configuration never contained "cost" — so the allowlist was
  // emptied rather than substituted, keeping the whole mechanism intact but
  // currently inert. See the constant's own header comment in
  // extension/sidepanel/skills-model.js. This is a deliberate approval
  // decision, not unfinished work.
  ok(APPROVED_BUILTIN_COMMANDS.length === 0, `panel allowlist is empty — got ${JSON.stringify(APPROVED_BUILTIN_COMMANDS)}`);
  ok(
    JSON.stringify(APPROVED_BUILTIN_COMMANDS) === JSON.stringify(HOST_APPROVED_BUILTIN_COMMANDS),
    // design.md's own stated risk: "The approved allowlist exists in two
    // places (panel and host) ... a test asserts they match, so drift is
    // caught rather than shipped." Still true with both sides empty.
    `panel and host allowlists must hold the identical value — panel: ${JSON.stringify(APPROVED_BUILTIN_COMMANDS)}, host: ${JSON.stringify(HOST_APPROVED_BUILTIN_COMMANDS)}`
  );
}

console.log("== deriveBuiltinCommands: happy path — advertised, non-terminal, and allowlisted (allowlist injected — the shipped default is empty; see the dedicated default-is-empty test below) ==");
{
  const record = { commands: ["cost", "compact", "context"], terminalCommands: [] };
  const builtins = deriveBuiltinCommands(record, ["cost"]);
  ok(builtins.length === 1 && builtins[0].name === "cost", `only the allowlisted, advertised command is offered — got ${JSON.stringify(builtins)}`);
  ok(builtins[0].kind === "builtin", "a built-in entry is tagged kind: \"builtin\"");
  ok(typeof builtins[0].description === "string" && builtins[0].description.length > 0, "a built-in entry carries a real, non-empty description for the picker to render/filter on");
}

console.log("== deriveBuiltinCommands: a terminal-bound command is excluded even if advertised and allowlisted (allowlist injected) ==");
{
  const record = { commands: ["cost"], terminalCommands: ["cost"] };
  ok(deriveBuiltinCommands(record, ["cost"]).length === 0, "a command the SDK marks terminal-bound is never offered as a built-in");
}

console.log("== deriveBuiltinCommands: an advertised, non-terminal command absent from the allowlist is excluded (allowlist injected) ==");
{
  const record = { commands: ["compact", "context", "clear", "model"], terminalCommands: [] };
  ok(deriveBuiltinCommands(record, ["cost"]).length === 0, "the SDK advertising a command is not itself authorization — the picker's own allowlist still governs");
}

console.log("== deriveBuiltinCommands: empty, missing, or malformed advertised list yields no built-ins (allowlist injected) ==");
{
  ok(deriveBuiltinCommands({ commands: [], terminalCommands: [] }, ["cost"]).length === 0, "empty commands array -> no built-ins");
  ok(deriveBuiltinCommands(null, ["cost"]).length === 0, "null record (never observed yet) -> no built-ins, not a throw");
  ok(deriveBuiltinCommands(undefined, ["cost"]).length === 0, "undefined record -> no built-ins, not a throw");
  ok(deriveBuiltinCommands({}, ["cost"]).length === 0, "a record missing its commands array entirely -> no built-ins, not a throw");
  ok(deriveBuiltinCommands({ commands: "not-an-array" }, ["cost"]).length === 0, "a malformed (non-array) commands field -> no built-ins, not a throw");
}

console.log("== deriveBuiltinCommands: the shipped default (no allowlist argument) is APPROVED_BUILTIN_COMMANDS, currently empty, so it yields no built-ins even when \"cost\" is advertised ==");
{
  // design.md decision 8 / tasks.md 5.6-5.7. This is the real production
  // call shape (buildPickerItems below calls deriveBuiltinCommands with no
  // second argument), so this must be exercised with NO allowlist passed.
  const record = { commands: ["cost", "usage", "context", "compact", "clear", "model", "effort", "recap"], terminalCommands: [] };
  ok(deriveBuiltinCommands(record).length === 0, "the real shipped default allowlist approves nothing, even though \"cost\" is advertised");
}

console.log("== buildPickerItems: with the shipped (empty) default allowlist, an advertised \"cost\" yields NO built-in — the honest current effect of decision 8 ==");
{
  const catalog = [skill({ name: "tom-tat-trang", description: "Tóm tắt nội dung trang." })];
  const advertisedRecord = { commands: ["cost"], terminalCommands: [] };
  const items = buildPickerItems(catalog, advertisedRecord);
  ok(items.length === 1 && items[0].kind === "skill" && items[0].name === "tom-tat-trang", `only the skill appears, no built-in — got ${JSON.stringify(items)}`);
}

console.log("== buildPickerItems + deriveBuiltinCommands (allowlist injected): built-ins render ahead of skills, correctly tagged, when a built-in IS approved ==");
{
  // buildPickerItems() itself has no allowlist parameter (only
  // deriveBuiltinCommands() gained one — design.md decision 8 / tasks.md
  // 5.7) — it always composes `[...deriveBuiltinCommands(advertisedRecord), ...skills]`
  // using the shipped (currently empty) default. This proves that
  // composition's ordering/tagging invariant using deriveBuiltinCommands's
  // own injectable seam directly, exactly mirroring buildPickerItems's own
  // `[...builtins, ...skills]` shape, so the "built-ins first" coverage
  // this change originally added is not lost just because the shipped
  // allowlist is now empty.
  const record = { commands: ["cost", "compact", "context"], terminalCommands: [] };
  const builtins = deriveBuiltinCommands(record, ["cost"]);
  const catalog = [skill({ name: "tom-tat-trang", description: "Tóm tắt nội dung trang." })];
  const skillsOnly = buildPickerItems(catalog); // no advertisedRecord -> skills only, same filter buildPickerItems applies
  const items = [...builtins, ...skillsOnly];
  ok(items.length === 2, `both the built-in and the skill appear — got ${JSON.stringify(items)}`);
  ok(items[0].kind === "builtin" && items[0].name === "cost", "the built-in is FIRST in the composed list");
  ok(items[1].kind === "skill" && items[1].name === "tom-tat-trang", "the skill follows it");
}

console.log("== filterPickerItems: filters by name or description substring, case-insensitive ==");
{
  const items = [
    { name: "tom-tat-trang", description: "Tóm tắt nội dung trang hiện tại", kind: "skill" },
    { name: "dien-bieu-mau", description: "Điền và gửi biểu mẫu trên trang", kind: "skill" },
    { name: "so-sanh-gia", description: "So sánh giá sản phẩm giữa các tab", kind: "skill" }
  ];
  ok(filterPickerItems(items, "").length === 3, "empty query returns every item");
  ok(filterPickerItems(items, "tom").length === 1 && filterPickerItems(items, "tom")[0].name === "tom-tat-trang", "filters by name substring");
  ok(filterPickerItems(items, "TOM").length === 1, "name filtering is case-insensitive");
  ok(filterPickerItems(items, "biểu mẫu").length === 1 && filterPickerItems(items, "biểu mẫu")[0].name === "dien-bieu-mau", "filters by description substring");
  ok(filterPickerItems(items, "no-such-thing-at-all").length === 0, "a query matching nothing returns an empty array — the picker's own empty state renders");
}

console.log("== parseSlashQuery: only a single leading-slash token with no space yet counts as an in-progress command ==");
{
  ok(parseSlashQuery("/").query === "", "bare \"/\" -> empty query, picker opens");
  ok(parseSlashQuery("/tom").query === "tom", "\"/tom\" -> query \"tom\"");
  ok(parseSlashQuery("hello") === null, "plain text with no leading slash is not a slash command");
  ok(parseSlashQuery("/tom hello") === null, "once a space follows the command, this is no longer a live filter query (task arguments being typed)");
  ok(parseSlashQuery("") === null, "empty composer is not a slash command");
  ok(parseSlashQuery("//x") !== null, "\"//x\" still matches the single-token shape (the dispatch-time validator, not this parser, is the authorization boundary)");
}

console.log("== buildInvocationText: exact insertable invocation, trailing space for arguments ==");
{
  ok(buildInvocationText({ name: "tom-tat-trang" }) === "/tom-tat-trang ", "invocation text is \"/name \" — exact, reviewable, ready for arguments");
}

console.log(fail === 0 ? "\nALL SLASH PICKER MODEL TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

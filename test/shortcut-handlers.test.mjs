// Unit tests for the shortcuts extension side (extension/background.js):
// validateShortcutsExecuteArgs() parity with the companion's contract and
// runShortcutToolSteps() execution semantics. The validator is pure; the
// runner takes its tool table as an injected dependency so no browser is
// needed. Shipped code is exercised via test/_extract.mjs, never copied.
import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const validate = compile(
  extractFunction("validateShortcutsExecuteArgs"),
  {},
  "{ validateShortcutsExecuteArgs }"
).validateShortcutsExecuteArgs;

console.log("== argument parity with the companion contract ==");
{
  // Messages must match host/agent/skills/workflows-mcp.js byte for byte.
  const cases = [
    [null, "shortcuts_execute requires an arguments object with tabId"],
    ["x", "shortcuts_execute requires an arguments object with tabId"],
    [{}, "shortcuts_execute requires a numeric tabId"],
    [{ tabId: "1", command: "x" }, "shortcuts_execute requires a numeric tabId"],
    [{ tabId: 1 }, "shortcuts_execute requires shortcutId or command"],
    [{ tabId: 1, shortcutId: "  " }, "shortcutId, when given, must be a nonempty string"],
    [{ tabId: 1, command: "" }, "command, when given, must be a nonempty string"],
  ];
  for (const [args, message] of cases) {
    const r = validate(args);
    ok(r.ok === false && r.message === message, `rejects ${JSON.stringify(args)} with "${message}"`);
  }
  const good = validate({ tabId: 7, shortcutId: "  deploy  " });
  ok(
    good.ok === true && good.target === "deploy" && good.shortcutId === "deploy" && good.command === null,
    "trims the identifier and derives the target"
  );
  const byCommand = validate({ tabId: 7, command: "summarize" });
  ok(byCommand.ok === true && byCommand.target === "summarize", "a command alone addresses the shortcut");
}

console.log("== step runner semantics ==");
{
  const calls = [];
  const fakeTools = {
    read_page: async (a) => {
      calls.push(["read_page", a]);
      return { content: [{ type: "text", text: "page text here" }] };
    },
    navigate: async (a) => {
      calls.push(["navigate", a]);
      return { content: [{ type: "text", text: "navigated" }] };
    },
    boom: async () => {
      calls.push(["boom", {}]);
      throw new Error("kaput");
    },
  };
  const scoped = new Set(["navigate", "read_page"]);
  const run = compile(
    extractFunction("runShortcutToolSteps"),
    { toolHandlers: fakeTools, SHORTCUT_TAB_SCOPED_TOOLS: scoped },
    "{ runShortcutToolSteps }"
  ).runShortcutToolSteps;

  const def = (steps) => ({ id: "demo", steps });

  // Happy path: missing tabId defaults to the addressed tab.
  calls.length = 0;
  const r1 = await run(def([
    { kind: "tool", ref: "read_page", args: {} },
    { kind: "tool", ref: "navigate", args: { url: "https://example.com", tabId: 99 } },
  ]), 42);
  ok(r1.ok === true && r1.lines.length === 2, "runs every tool step in order");
  ok(calls[0][1].tabId === 42, "a step without tabId inherits the addressed tab");
  ok(calls[1][1].tabId === 99, "an explicit step tabId is kept, never overwritten");

  // Unknown tool: nothing ran.
  calls.length = 0;
  const r2 = await run(def([{ kind: "tool", ref: "nope", args: {} }]), 42);
  ok(r2.ok === false && /unknown tool "nope"/.test(r2.error) && calls.length === 0, "unknown tool refuses before anything runs");

  // Non-tool step: nothing ran.
  const r3 = await run(def([{ kind: "skill", ref: "summarize", args: {} }]), 42);
  ok(r3.ok === false && /skill step/.test(r3.error) && calls.length === 0, "skill steps are refused explicitly");

  // Nested execution refused.
  const r4 = await run(def([{ kind: "tool", ref: "shortcuts_execute", args: {} }]), 42);
  ok(r4.ok === false && /nested execution is refused/.test(r4.error), "shortcuts_execute steps are refused");

  // Failure stops the run with the completed steps reported.
  calls.length = 0;
  const r5 = await run(def([
    { kind: "tool", ref: "read_page", args: {} },
    { kind: "tool", ref: "boom", args: {} },
    { kind: "tool", ref: "navigate", args: {} },
  ]), 42);
  ok(
    r5.ok === false && r5.lines.length === 2 && /failed at step 2/.test(r5.error) && calls.length === 2,
    "a throwing step stops the run and keeps the completed lines"
  );
}

console.log(fail === 0 ? "\nALL SHORTCUT HANDLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

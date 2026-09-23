#!/usr/bin/env node
//
// jev-tools-connection-test-and-preference tasks.md 3.1/4.2: the preference
// nudge that tells the model to prefer the Jev browser tools
// (`browser_subgoal`/`extract_page`) over driving the same thing inline with
// the native tools, ONLY when the tool is actually registered for the run
// (`extraToolNames`). Proven two ways:
//
//   1. `renderJevToolsPreferenceSystemPrompt()` directly — the pure function,
//      exercised over every membership combination.
//   2. `buildIsolatedOptions()` end to end — the assembled `systemPrompt.prompt`
//      is BYTE-FOR-BYTE identical whether `extraToolNames` is empty or
//      carries only unrelated tool names (neither Jev tool present), and
//      gains exactly the expected section otherwise. This is the scenario the
//      spec (`agent-browser-runtime`) states in these words: "A run without
//      either Jev tool SHALL receive exactly the guidance it received before
//      this capability existed."
//
// No live SDK, browser, or credential is used anywhere here — buildIsolatedOptions()
// only ever assembles a plain options object.
//
// Run: node host/test/jev-tools-preference-nudge.test.mjs

import {
  buildIsolatedOptions,
  renderJevToolsPreferenceSystemPrompt,
  renderBrowserAutomationSystemPrompt
} from "../agent/tools/query-options.js";
import { BROWSER_SUBGOAL_TOOL_NAME } from "../agent/tools/browser-subgoal.js";
import { EXTRACT_PAGE_TOOL_NAME } from "../agent/tools/extract-page.js";
import { SDK_MCP_SERVER_NAME } from "../agent/tools/adapter.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fakeSnapshot() {
  return { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } };
}
function fakeSkills() {
  return {
    cwd: "/scratch/conv-jev-nudge",
    configDir: "/scratch/conv-jev-nudge/claude-config",
    pluginDir: "/scratch/conv-jev-nudge/skills-plugin",
    allowedSkillNames: [],
    skillOverrides: {}
  };
}

console.log("\nJev-tools preference nudge\n");

// --- renderJevToolsPreferenceSystemPrompt (the pure function) --------------

await test("neither tool present returns null (not an empty string)", () => {
  assert(renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, []) === null, "must be null so .filter(Boolean) drops it");
  assert(renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, ["ask_user", "create_document"]) === null, "unrelated tool names must not trigger the nudge");
  assert(renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, undefined) === null, "a missing extraToolNames must not throw or trigger the nudge");
});

await test("browser_subgoal present names only browser_subgoal, never extract_page", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [BROWSER_SUBGOAL_TOOL_NAME]);
  assert(typeof text === "string" && text.length > 0, "expected nudge text");
  assert(text.includes(`__${BROWSER_SUBGOAL_TOOL_NAME}`), "must name the qualified browser_subgoal tool");
  assert(!text.includes(`__${EXTRACT_PAGE_TOOL_NAME}`), "must never name extract_page when it is absent");
});

await test("browser_subgoal present states it is the primary/default for every page interaction, native tools fallback-only", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [BROWSER_SUBGOAL_TOOL_NAME]);
  assert(/\b(primary|default)\b/i.test(text), "must state browser_subgoal is the primary/default path, not a soft preference");
  assert(/click/i.test(text) && /type/i.test(text) && /select/i.test(text) && (/submit/i.test(text) || /navigat/i.test(text)), "must cover the full set of page interactions: click, type, select, submit, in-page navigation");
  assert(/\bonly\b.*(fail|blocked|cannot express)|\b(fail|blocked|cannot express)\b.*\bonly\b/i.test(text), "must state native tools are used only as a fallback when browser_subgoal fails, is blocked, or cannot express the step");
  assert(/do not fall back/i.test(text) && /read_page/i.test(text) && /find/i.test(text) && /computer/i.test(text), "must discourage the read_page-then-find-then-computer-click interaction pattern");
});

await test("browser_subgoal present adds the batching instruction (group related interactions into one subgoal)", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [BROWSER_SUBGOAL_TOOL_NAME]);
  assert(/\bgroup\b/i.test(text) && /\bone\b/i.test(text) && new RegExp(`__${BROWSER_SUBGOAL_TOOL_NAME}\\b`).test(text), "must instruct grouping a coherent sequence of related interactions into one browser_subgoal call");
  assert(/not one (subgoal )?per (field|click)/i.test(text), "must contrast batching against one subgoal per field/click");
  assert(/real decision point/i.test(text) && /blocked/i.test(text), "must instruct returning to the driving model's own reasoning only at a real decision point or when a subgoal reports blocked");
});

await test("extract_page present WITHOUT browser_subgoal never adds the batching instruction", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [EXTRACT_PAGE_TOOL_NAME]);
  assert(!/\bgroup\b/i.test(text), "batching guidance must not appear when browser_subgoal is not registered");
});

await test("extract_page present names only extract_page, never browser_subgoal", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [EXTRACT_PAGE_TOOL_NAME]);
  assert(typeof text === "string" && text.length > 0, "expected nudge text");
  assert(text.includes(`__${EXTRACT_PAGE_TOOL_NAME}`), "must name the qualified extract_page tool");
  assert(!text.includes(`__${BROWSER_SUBGOAL_TOOL_NAME}`), "must never name browser_subgoal when it is absent");
});

await test("extract_page present states it is the primary/default for structured reads, native reading tools kept for free-text/inspection only", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [EXTRACT_PAGE_TOOL_NAME]);
  assert(/\b(primary|default)\b/i.test(text), "must state extract_page is the primary/default path, not a soft preference");
  assert(/structured|field/i.test(text), "must scope the default to structured/field data reads");
  assert(/free-text|free text|inspection/i.test(text), "must keep read_page/get_page_text for free-text/inspection reads only");
});

await test("both present names both, and native tools remain described as an explicit fallback", () => {
  const text = renderJevToolsPreferenceSystemPrompt(SDK_MCP_SERVER_NAME, [BROWSER_SUBGOAL_TOOL_NAME, EXTRACT_PAGE_TOOL_NAME, "ask_user"]);
  assert(text.includes(`__${BROWSER_SUBGOAL_TOOL_NAME}`) && text.includes(`__${EXTRACT_PAGE_TOOL_NAME}`), "both tools must be named");
  assert(/fall back/i.test(text), "guidance must be additive, never a hard constraint — native tools stay available");
  assert(/\b(primary|default)\b/i.test(text), "guidance must frame the registered Jev tool(s) as primary/default, not merely preferred");
});

// --- buildIsolatedOptions end to end ----------------------------------------

await test("byte-for-byte unchanged systemPrompt when neither Jev tool is registered", () => {
  const baseline = buildIsolatedOptions({
    mcpServer: {},
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills()
  });
  const withUnrelatedExtra = buildIsolatedOptions({
    mcpServer: {},
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills(),
    extraToolNames: ["ask_user", "create_document", "page_snapshots", "propose_workflow_heal"]
  });
  assert(baseline.systemPrompt.prompt === withUnrelatedExtra.systemPrompt.prompt, "a run with no Jev tool registered must get byte-identical guidance regardless of which OTHER extra tools are registered");
  assert(
    baseline.systemPrompt.prompt === [renderBrowserAutomationSystemPrompt(SDK_MCP_SERVER_NAME)].join("\n\n"),
    "the prompt must be exactly what a run without this capability produced — no Jev section appended at all"
  );
  assert(!baseline.systemPrompt.prompt.includes(BROWSER_SUBGOAL_TOOL_NAME), "browser_subgoal must never be named");
  assert(!baseline.systemPrompt.prompt.includes(EXTRACT_PAGE_TOOL_NAME), "extract_page must never be named");
});

await test("registering browser_subgoal appends exactly the browser_subgoal guidance", () => {
  const options = buildIsolatedOptions({
    mcpServer: {},
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills(),
    extraToolNames: [BROWSER_SUBGOAL_TOOL_NAME]
  });
  assert(options.systemPrompt.prompt.includes(`mcp__${SDK_MCP_SERVER_NAME}__${BROWSER_SUBGOAL_TOOL_NAME}`), "must reference the fully-qualified browser_subgoal name, the one the model can actually call");
  assert(!options.systemPrompt.prompt.includes(`mcp__${SDK_MCP_SERVER_NAME}__${EXTRACT_PAGE_TOOL_NAME}`), "must not reference extract_page — it was never registered for this run");
});

await test("registering extract_page appends exactly the extract_page guidance", () => {
  const options = buildIsolatedOptions({
    mcpServer: {},
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills(),
    extraToolNames: [EXTRACT_PAGE_TOOL_NAME]
  });
  assert(options.systemPrompt.prompt.includes(`mcp__${SDK_MCP_SERVER_NAME}__${EXTRACT_PAGE_TOOL_NAME}`), "must reference the fully-qualified extract_page name");
  assert(!options.systemPrompt.prompt.includes(`mcp__${SDK_MCP_SERVER_NAME}__${BROWSER_SUBGOAL_TOOL_NAME}`), "must not reference browser_subgoal — it was never registered for this run");
});

await test("the existing browser-automation guidance is present and unchanged regardless of the nudge", () => {
  const withNudge = buildIsolatedOptions({
    mcpServer: {},
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills(),
    extraToolNames: [BROWSER_SUBGOAL_TOOL_NAME, EXTRACT_PAGE_TOOL_NAME]
  });
  const automationSection = renderBrowserAutomationSystemPrompt(SDK_MCP_SERVER_NAME);
  assert(withNudge.systemPrompt.prompt.startsWith(automationSection), "the pre-existing browser-automation section must still lead the prompt, byte-identical");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exitCode = failed.length ? 1 : 0;

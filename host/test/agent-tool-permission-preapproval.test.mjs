#!/usr/bin/env node
//
// Regression, two passes:
//
// Pass 1 (fixed, then found incomplete): host/agent/tools/query-options.js's
// SDK `tools` allowlist used to be `["Skill"]` only. Per sdk.d.ts's own
// docstring, `Options.tools` ("Specify the base set of available built-in
// tools... Array of specific tool names") gates every tool the SDK will
// consider *available* at all. Every application-owned browser MCP tool this
// adapter registers (host/agent/tools/adapter.js's `buildSdkTools()` —
// `mcp__browzy-in-chrome-browser__read_page`, `__navigate`,
// `__computer`, etc.) was outside that array, so it was not even available.
//
// Pass 2 (this suite's real subject): adding those tools to `tools` alone
// was NOT enough — `tools` (availability) and `allowedTools` (auto-approval,
// sdk.d.ts:1443-1449: "List of tool names that are auto-allowed without
// prompting for permission... To restrict which tools are available, use the
// `tools` option instead") are two separate axes. With every browser tool
// present in `tools` but absent from `allowedTools`, and no `canUseTool`/
// `permissionMode` configured, every call still fell through to the SDK's
// default permission-prompt path and was denied — the exact live regression
// reproduced by a user asking to read a page ("Claude requested permissions
// to use mcp__browzy-in-chrome-browser__get_page_text, but you haven't
// granted it yet"), which survived a full browser restart and a companion
// respawn because the bug was in the `query()` options themselves.
//
// This suite proves, fully offline (constructed `query()` options only, no
// SDK/network/credential):
//   1. All 26 registry-backed browser tools, namespaced under this run's mcp
//      server name, plus "Skill", are present in the SDK's `tools`
//      (availability) allowlist.
//   2. All 26 registry-backed browser tools are ALSO present in `allowedTools`
//      (auto-approval) — and "Skill" is deliberately NOT, since passing
//      'Skill' through `allowedTools` is itself deprecated (sdk.d.ts:1447) —
//      the `skills` option (already wired) covers it instead. `tools` (minus
//      "Skill") and `allowedTools` must name the identical set, so the two
//      can never drift apart.
//   3. HIGH_RISK_BUILTINS remain disallowed from both `tools` and
//      `allowedTools`, and every other isolation guarantee (settingSources:
//      [], strictMcpConfig: true, single application-owned mcp server) is
//      untouched by the fix.
//   4. A hand-typed/stale browser tool list is caught in both `tools` and
//      `allowedTools` — the expected lists are computed directly from
//      host/tool-definitions.js's TOOLS export (the actual source of truth),
//      independent of whatever host/agent/tools/adapter.js or
//      query-options.js do internally, so a future registry addition that
//      isn't reflected in either allowlist fails this test rather than
//      passing by construction.
//   5. SDK preapproval is not the security boundary: the real registered SDK
//      tool handler still rejects a call against a tab outside this run's
//      scope, even though that same tool's fully-qualified name is present
//      in both the SDK-preapproved `tools` and `allowedTools` arrays proven
//      above.
//
// A real, live, billed `query()` end-to-end check (an actual tool call that
// must pass the SDK permission gate without a prompt) is NOT in this offline
// suite — see openspec/changes/migrate-to-claude-agent-sdk/reports/
// 11-tool-permission-fix.md for that evidence; the previous fix's offline-only
// assertions on `tools` alone are exactly what let this regression ship, so
// this file's coverage is deliberately not treated as sufficient by itself.
//
// Run: node host/test/agent-tool-permission-preapproval.test.mjs

import { TOOLS } from "../tool-definitions.js";
import { createBrowserMcpServer, buildSdkTools, SDK_MCP_SERVER_NAME } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import { buildIsolatedOptions, HIGH_RISK_BUILTINS } from "../agent/tools/query-options.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function makeRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_perm_preapproval", lease, approvals, tabScope });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `ok:${name}` }] }),
    shutdown: () => {}
  });
  return { run, toolBridge };
}

function fakeSnapshot() {
  return { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } };
}
function fakeSkills() {
  return {
    cwd: "/scratch/conv-perm-preapproval",
    configDir: "/scratch/conv-perm-preapproval/claude-config",
    pluginDir: "/scratch/conv-perm-preapproval/skills-plugin",
    allowedSkillNames: [],
    skillOverrides: {}
  };
}

console.log("\nSDK tool preapproval — every browser tool must be in the allowlist alongside Skill\n");

await test("all 26 registry-backed browser tools, namespaced under this run's mcp server, plus Skill, are preapproved — nothing silently missing", async () => {
  assert(
    TOOLS.length === 26,
    `expected the known 26-entry registry baseline, got ${TOOLS.length} — if the registry grew or shrank on purpose, this assertion must be updated deliberately, not silently`
  );

  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });

  const options = buildIsolatedOptions({
    mcpServer,
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills()
  });

  assert(Array.isArray(options.tools), "options.tools must be an explicit array, never a preset or omitted");
  assert(options.tools.includes("Skill"), "Skill must remain preapproved");

  // Computed straight from host/tool-definitions.js, NOT from any helper
  // inside host/agent/tools/adapter.js or query-options.js: this is the
  // independent check that catches drift if a future tool is added to the
  // registry but the allowlist derivation is ever changed to something that
  // no longer tracks it.
  for (const t of TOOLS) {
    const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${t.name}`;
    assert(
      options.tools.includes(qualified),
      `registry tool "${t.name}" must be preapproved as "${qualified}" — this exact omission is the regression that denied every browser tool call`
    );
  }
  // Skill plus the three later-enabled SDK built-ins (WebSearch, WebFetch,
  // Task — see query-options.js's `tools` comment) are the only non-registry
  // entries expected here.
  assert(
    options.tools.length === TOOLS.length + 4,
    `tools list must contain exactly every registry tool plus Skill/WebSearch/WebFetch/Task (${TOOLS.length + 4}) — got ${options.tools.length}: ${JSON.stringify(options.tools)}`
  );
});

await test("all 24 always-automatic browser tools are auto-approved via allowedTools; computer & javascript_tool stay available through tools only (task 9.1)", async () => {
  // Task 9.1 (design.md section 8) narrowed `allowedTools`: `computer` and
  // `javascript_tool` are each capable of producing both an always-automatic
  // call AND a send/submit-class call under the identical tool name, so they
  // MUST be removed from `allowedTools` (auto-approval at the grain of a
  // whole tool name would preapprove the submit case alongside everything
  // else). They remain in `tools` for availability and reach `canUseTool`,
  // where `isSendClassCall()` decides per call. The remaining 24 browser
  // tools stay in `allowedTools` unchanged — zero added latency, no
  // dependency on `canUseTool` being invoked for them. The first-pass
  // regression this suite caught (tools in `tools` only, never in
  // `allowedTools`) is still caught here for the 24 always-automatic tools.
  assert(
    TOOLS.length === 26,
    `expected the known 26-entry registry baseline, got ${TOOLS.length} — if the registry grew or shrank on purpose, this assertion must be updated deliberately, not silently`
  );

  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });

  const options = buildIsolatedOptions({
    mcpServer,
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills()
  });

  assert(Array.isArray(options.allowedTools), "options.allowedTools must be an explicit array, never omitted");

  const sendClassToolNames = new Set(["computer", "javascript_tool"]);
  const alwaysAutomatic = TOOLS.filter((t) => !sendClassToolNames.has(t.name));
  assert(alwaysAutomatic.length === 24, `internal sanity: 24 always-automatic tools expected, got ${alwaysAutomatic.length}`);

  // Every always-automatic tool MUST be in allowedTools (the regression this
  // suite originally caught — any always-automatic tool absent here would
  // fall through to the SDK default permission-prompt path and be denied).
  for (const t of alwaysAutomatic) {
    const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${t.name}`;
    assert(
      options.allowedTools.includes(qualified),
      `always-automatic tool "${t.name}" must be auto-approved as "${qualified}" via allowedTools — being present only in \`tools\` still leaves it behind a permission prompt nothing can answer`
    );
  }
  // WebSearch and Task are auto-approved alongside the 24 always-automatic
  // browser tools (see query-options.js's `allowedTools` comment); WebFetch
  // is deliberately excluded so its calls route through canUseTool's URL
  // guard instead.
  assert(
    options.allowedTools.length === alwaysAutomatic.length + 2,
    `allowedTools must contain exactly the 24 always-automatic browser tools plus WebSearch and Task (${alwaysAutomatic.length + 2}), no more and no fewer — got ${options.allowedTools.length}: ${JSON.stringify(options.allowedTools)}`
  );
  assert(options.allowedTools.includes("WebSearch"), "WebSearch must be auto-approved");
  assert(options.allowedTools.includes("Task"), "Task must be auto-approved");
  assert(!options.allowedTools.includes("WebFetch"), "WebFetch must NOT be auto-approved — it must route through canUseTool's URL guard");

  // `computer` and `javascript_tool` MUST be in `tools` (availability) but
  // ABSENT from `allowedTools` — this is the load-bearing consequence of task
  // 9.1: removing them from `allowedTools` routes every one of their calls
  // through `canUseTool`, where `isSendClassCall()` decides per call rather
  // than the SDK preapproving the submit case wholesale.
  for (const name of sendClassToolNames) {
    const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${name}`;
    assert(options.tools.includes(qualified), `"${name}" must remain AVAILABLE in tools (availability) — design 8: they stay in tools`);
    assert(!options.allowedTools.includes(qualified), `"${name}" must NOT be in allowedTools — task 9.1 routes it through canUseTool instead`);
  }

  // `Skill` must be available (tools) via the `skills` option's own channel,
  // but never routed through the deprecated `allowedTools` usage
  // (sdk.d.ts:1447: "passing 'Skill' here is deprecated — use the `skills`
  // option instead").
  assert(options.tools.includes("Skill"), "Skill must still be present in tools (availability)");
  assert(Array.isArray(options.skills), "options.skills must be the skills allowlist channel Skill actually uses");
  assert(!options.allowedTools.includes("Skill"), "'Skill' must never be passed through allowedTools — that specific usage is deprecated per sdk.d.ts:1447");
});

await test("HIGH_RISK_BUILTINS remain disallowed and every other isolation guarantee is untouched by the preapproval fix", async () => {
  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });

  const options = buildIsolatedOptions({
    mcpServer,
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills()
  });

  for (const risky of HIGH_RISK_BUILTINS) {
    assert(options.disallowedTools.includes(risky), `${risky} must remain disallowed`);
    assert(!options.tools.includes(risky), `${risky} must never be preapproved (available)`);
    assert(!options.allowedTools.includes(risky), `${risky} must never be preapproved (auto-approved)`);
  }
  assert(options.settingSources.length === 0, "settingSources isolation ([]) must be untouched");
  assert(options.strictMcpConfig === true, "strictMcpConfig isolation (true) must be untouched");
  const serverNames = Object.keys(options.mcpServers);
  assert(serverNames.length === 1 && serverNames[0] === SDK_MCP_SERVER_NAME, "exactly one, application-owned mcp server must be configured — no inherited user MCP servers");
  assert(options.mcpServers[SDK_MCP_SERVER_NAME] === mcpServer, "the configured server must be this run's own instance");
});

await test("a hand-typed/stale browser tool list would be caught by this suite — proving the check is not vacuous", async () => {
  const staleList = TOOLS.map((t) => t.name).slice(1); // deliberately drop one entry
  const options = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills(),
    browserToolNames: staleList
  });
  const droppedTool = TOOLS[0].name;
  assert(
    !options.tools.includes(`mcp__${SDK_MCP_SERVER_NAME}__${droppedTool}`),
    "sanity check failed: the deliberately-incomplete list must actually omit the dropped tool from tools (availability), or this test proves nothing"
  );
  assert(
    !options.allowedTools.includes(`mcp__${SDK_MCP_SERVER_NAME}__${droppedTool}`),
    "sanity check failed: the deliberately-incomplete list must actually omit the dropped tool from allowedTools (auto-approval), or this test proves nothing"
  );
  // Production never passes `browserToolNames` explicitly — it always gets
  // the live, TOOLS-derived default (see query-options.js) — so this failure
  // mode can only happen if someone later hand-types a list. This test
  // exists so that if they do, the suite above catches it for both tools and
  // allowedTools.
});

await test("SDK preapproval is not the security boundary: the real tool handler still rejects an out-of-scope tab", async () => {
  const { run, toolBridge } = await makeRun({ tabScope: [111, 222] });
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });

  // First, prove this exact tool is SDK-preapproved (same proof as test 1,
  // scoped to one tool, to make the connection between the two facts explicit
  // within a single test).
  const options = buildIsolatedOptions({
    mcpServer,
    serverName: SDK_MCP_SERVER_NAME,
    snapshot: fakeSnapshot(),
    skills: fakeSkills()
  });
  assert(
    options.tools.includes(`mcp__${SDK_MCP_SERVER_NAME}__read_page`),
    "read_page must be SDK-preapproved for this test to prove anything about preapproval not being sufficient"
  );

  // Now call the REAL registered handler (the same handler the SDK would
  // invoke once it lets the call through) against a tab outside this run's
  // scope, and prove it is still rejected — design.md: "Validate run state,
  // arguments, browser lease, and tab scope inside each tool handler, even
  // when SDK permission checks preapprove the tool."
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const readPage = sdkTools.find((t) => t.name === "read_page");
  assert(readPage, "read_page must be registered on the SDK server");
  const result = await readPage.handler({ tabId: 999 });
  assert(result.isError === true, "a call against an out-of-scope tab must be rejected by the handler regardless of SDK preapproval");
  assert(/rejected/.test(result.content[0].text), "the rejection reason must be visible in the tool result text");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

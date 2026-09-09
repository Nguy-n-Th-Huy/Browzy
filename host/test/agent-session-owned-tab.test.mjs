#!/usr/bin/env node
//
// Regression: a run could not use a tab it had just created itself.
//
// Reproduced live by the operator against dauthau.asia. The panel binds
// tabScope to the single page tab open at Send (sidepanel.js), so the run
// held tabScope [boundTab]. Navigating that bound tab was correctly refused
// (borrowed_tab_mutation — it is the operator's own page, read-only by
// design), so the model did exactly what tabs_create_mcp's own description
// tells it to do and opened a fresh tab. Every later call against that new
// tab then failed tab_out_of_scope, because Run.tabScope was fixed at
// construction and nothing could ever extend it. Net effect: a run could
// never reach a second page at all.
//
// specs/agent-browser-runtime "Confined tool execution and browser scope"
// authorises "the authorized browser bridge and session-owned tabs, the
// current tab bound at user submission, or explicitly selected tabs" — the
// session-owned clause was simply never enforced.
//
// Run: node host/test/agent-session-owned-tab.test.mjs

import { buildSdkTools } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const BOUND_TAB = 1300524375;   // the operator's page tab, bound at Send
const CREATED_TAB = 1300524393; // the tab the run opens for itself
const STRANGER_TAB = 999123;    // an unrelated tab of the operator's

async function makeRun({ tabScope, callTool }) {
  const lease = new BrowserLease();
  const run = new Run({
    conversationId: "conv_scope",
    lease,
    approvals: new ApprovalRegistry(),
    tabScope
  });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool,
    shutdown: () => {}
  });
  return { run, tools: buildSdkTools({ toolBridge, coerceArgs: (a) => a, run }) };
}

// Mirrors extension/background.js's shipped tabs_create_mcp result text,
// which mapping.js's extractCreatedTabId parses.
const createResult = (id) => ({
  content: [{ type: "text", text: `Created new tab. Tab ID: ${id}\n\nUse navigate to load a URL.` }]
});

function textOf(result) {
  return (result?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

console.log("\nSession-owned tab scope\n");

await test("the live deadlock is gone: a run can navigate the tab it just created", async () => {
  const seen = [];
  const { tools } = await makeRun({
    tabScope: [BOUND_TAB],
    callTool: async (name, args) => {
      seen.push({ name, args });
      if (name === "tabs_create_mcp") return createResult(CREATED_TAB);
      return { content: [{ type: "text", text: `ok:${name}` }] };
    }
  });
  const create = tools.find((t) => t.name === "tabs_create_mcp");
  const navigate = tools.find((t) => t.name === "navigate");

  await create.handler({});
  const result = await navigate.handler({ tabId: CREATED_TAB, url: "https://dauthau.asia/thongbao/moithau/" });

  assert(!/tab_out_of_scope/.test(textOf(result)), `navigate on the run's own new tab must not be rejected, got: ${textOf(result)}`);
  assert(seen.some((c) => c.name === "navigate" && c.args.tabId === CREATED_TAB), "navigate must actually reach the bridge for the created tab");
});

await test("the created tab is admitted to tabScope, and the wire meta carries it", async () => {
  const { run, tools } = await makeRun({
    tabScope: [BOUND_TAB],
    callTool: async (name) => (name === "tabs_create_mcp" ? createResult(CREATED_TAB) : { content: [{ type: "text", text: "ok" }] })
  });
  assert(!run.tabScope.includes(CREATED_TAB), "precondition: the new tab is not in scope before it exists");
  await tools.find((t) => t.name === "tabs_create_mcp").handler({});
  assert(run.tabScope.includes(BOUND_TAB), "the originally bound tab must stay in scope");
  assert(run.tabScope.includes(CREATED_TAB), "the created tab must be admitted to scope");
  assert(run.describeRequestForWire().tabScope.includes(CREATED_TAB), "the extension-side wire meta must carry the widened scope");
});

await test("admitting is idempotent and never widens to an unrelated tab", async () => {
  const { run, tools } = await makeRun({
    tabScope: [BOUND_TAB],
    callTool: async (name) => (name === "tabs_create_mcp" ? createResult(CREATED_TAB) : { content: [{ type: "text", text: "ok" }] })
  });
  const create = tools.find((t) => t.name === "tabs_create_mcp");
  await create.handler({});
  await create.handler({});
  const occurrences = run.tabScope.filter((id) => id === CREATED_TAB).length;
  assert(occurrences === 1, `expected the created tab once in scope, got ${occurrences}`);
  assert(!run.tabScope.includes(STRANGER_TAB), "an unrelated tab must never appear in scope");
});

await test("an unrelated tab is still rejected — the boundary did not move", async () => {
  const { tools } = await makeRun({
    tabScope: [BOUND_TAB],
    callTool: async (name) => (name === "tabs_create_mcp" ? createResult(CREATED_TAB) : { content: [{ type: "text", text: "ok" }] })
  });
  await tools.find((t) => t.name === "tabs_create_mcp").handler({});
  const result = await tools.find((t) => t.name === "navigate").handler({ tabId: STRANGER_TAB, url: "https://example.com" });
  assert(/tab_out_of_scope/.test(textOf(result)), `an unrelated tab must still be refused, got: ${textOf(result)}`);
});

await test("the bound page tab stays read-only: creating a tab does not unlock mutating it", async () => {
  const { tools } = await makeRun({
    tabScope: [BOUND_TAB],
    callTool: async (name) => (name === "tabs_create_mcp" ? createResult(CREATED_TAB) : { content: [{ type: "text", text: "ok" }] })
  });
  await tools.find((t) => t.name === "tabs_create_mcp").handler({});
  const result = await tools.find((t) => t.name === "navigate").handler({ tabId: BOUND_TAB, url: "https://dauthau.asia/thongbao/moithau/" });
  assert(/borrowed page tab/.test(textOf(result)) && /read-only by default/.test(textOf(result)), `the operator's bound tab must remain read-only, got: ${textOf(result)}`);
});

await test("an unrestricted run ('any') is unaffected", async () => {
  const { run, tools } = await makeRun({
    tabScope: "any",
    callTool: async (name) => (name === "tabs_create_mcp" ? createResult(CREATED_TAB) : { content: [{ type: "text", text: "ok" }] })
  });
  await tools.find((t) => t.name === "tabs_create_mcp").handler({});
  assert(run.tabScope === "any", "an 'any' scope must stay 'any', never become an array");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

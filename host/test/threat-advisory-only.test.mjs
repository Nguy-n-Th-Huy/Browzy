#!/usr/bin/env node
//
// add-permission-modes-and-threat-signals tasks.md 5.5 / 6.5: proves findings
// and tab risk categories are ADVISORY ONLY — the same action resolves
// identically with and without a finding/elevated category present, and no
// permission-deciding module ever imports the threat machinery.
//
// Run: node host/test/threat-advisory-only.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSdkTools } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import { TabRiskRegistry } from "../agent/threat/tab-risk.js";
import { recordAgentCreatedTab } from "../agent/tools/mapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

console.log("\nthreat signals are advisory only\n");

console.log("== structural: no permission-deciding module imports the threat machinery ==");
{
  const guardedFiles = [
    "../agent/policy/authorization.js",
    "../agent/policy/can-use-tool.js",
    "../agent/policy/permission-modes.js",
    "../agent/tools/mapping.js",
    "../agent/tools/query-options.js"
  ];
  for (const rel of guardedFiles) {
    const abs = path.resolve(__dirname, rel);
    const src = fs.readFileSync(abs, "utf8");
    ok(!/threat\//.test(src), `${rel} never references host/agent/threat/*`);
  }
}

async function makeRun({ tabScope = "any", callTool } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_threat_1", lease, approvals, tabScope });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: callTool || (async (name) => ({ content: [{ type: "text", text: `ok:${name}` }] })),
    shutdown: () => {}
  });
  return { run, toolBridge };
}

console.log("== a protected action resolves identically whether or not the SAME tab carries a finding/elevated category ==");
{
  // gif_creator export+download is classified PROTECTED (FILE_WRITE)
  // directly from its own args — no page/target hint needed — so this
  // exercises the real protected-action backstop in
  // host/agent/tools/adapter.js's runHostSideChecks, unaffected by anything
  // this test seeds into the tab-risk registry for the exact same tab.
  const protectedArgs = { action: "export", tabId: 42, download: true };

  const cleanRegistry = new TabRiskRegistry();
  const { run: run1, toolBridge: bridge1 } = await makeRun();
  const tools1 = buildSdkTools({ toolBridge: bridge1, coerceArgs: (a) => a, run: run1, tabRiskRegistry: cleanRegistry });
  const gif1 = tools1.find((t) => t.name === "gif_creator");
  const result1 = await gif1.handler(protectedArgs);

  const contaminatedRegistry = new TabRiskRegistry();
  contaminatedRegistry.recordSignal(42, {
    kind: "injection_finding",
    severity: "elevated",
    label: "possible agent-directed instruction found in page content",
    patternId: "ignore_prior_instructions",
    matchedText: "ignore all previous instructions"
  });
  contaminatedRegistry.recordSignal(42, { kind: "credential_content", severity: "elevated", label: "credential-related content observed on this tab" });
  ok(contaminatedRegistry.getState(42).category === "elevated", "sanity: tab 42 really is elevated with a real finding recorded before the call");

  const { run: run2, toolBridge: bridge2 } = await makeRun();
  const tools2 = buildSdkTools({ toolBridge: bridge2, coerceArgs: (a) => a, run: run2, tabRiskRegistry: contaminatedRegistry });
  const gif2 = tools2.find((t) => t.name === "gif_creator");
  const result2 = await gif2.handler(protectedArgs);

  ok(result1.isError === true && result2.isError === true, "the protected action is refused for want of a decision in BOTH cases");
  ok(result1.content[0].text === result2.content[0].text, "the refusal text is byte-identical with and without a finding/elevated category on the tab");
  ok(/protected:file-write/.test(result1.content[0].text) === true, "sanity: the refusal really is the protected-action backstop, not an unrelated rejection");
}

console.log("== an ordinary mutating action dispatches identically whether or not the SAME tab carries a finding/elevated category ==");
{
  const navigateArgs = { url: "https://example.com/", tabId: 42 };

  const cleanRegistry = new TabRiskRegistry();
  const { run: run1, toolBridge: bridge1 } = await makeRun({ callTool: async (name) => ({ content: [{ type: "text", text: `dispatched:${name}` }] }) });
  // Mark tab 42 as agent-created (not borrowed) on this run so the call
  // exercises ordinary mutating dispatch rather than the unrelated
  // borrowed-tab authorization gate — the thing under test here is threat
  // signals, not borrowed-tab mechanics.
  recordAgentCreatedTab(run1, 42);
  const tools1 = buildSdkTools({ toolBridge: bridge1, coerceArgs: (a) => a, run: run1, tabRiskRegistry: cleanRegistry });
  const nav1 = tools1.find((t) => t.name === "navigate");
  const result1 = await nav1.handler(navigateArgs);

  const contaminatedRegistry = new TabRiskRegistry();
  contaminatedRegistry.recordSignal(42, { kind: "injection_finding", severity: "elevated", label: "possible agent-directed instruction", matchedText: "ignore all previous instructions" });
  const { run: run2, toolBridge: bridge2 } = await makeRun({ callTool: async (name) => ({ content: [{ type: "text", text: `dispatched:${name}` }] }) });
  recordAgentCreatedTab(run2, 42);
  const tools2 = buildSdkTools({ toolBridge: bridge2, coerceArgs: (a) => a, run: run2, tabRiskRegistry: contaminatedRegistry });
  const nav2 = tools2.find((t) => t.name === "navigate");
  const result2 = await nav2.handler(navigateArgs);

  ok(result1.isError === undefined && result2.isError === undefined, "the ordinary mutating call dispatches successfully in both cases");
  ok(result1.content[0].text === result2.content[0].text, "the dispatched result is byte-identical with and without a finding/elevated category on the tab");
}

console.log("== no code path reads a tab-risk category or an injection finding to decide whether an action proceeds ==");
{
  // Direct behavioral corollary of the structural check above: feeding the
  // exact same tabRiskRegistry instance (already contaminated) through many
  // more dispatches never changes outcomes for calls against OTHER tabs
  // either, since nothing in the dispatch path ever looks the registry up
  // by anything other than a tabId this test itself chose to seed.
  const registry = new TabRiskRegistry();
  registry.recordSignal(99, { kind: "injection_finding", severity: "elevated", label: "x", matchedText: "ignore all previous instructions" });
  const { run, toolBridge } = await makeRun();
  const tools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run, tabRiskRegistry: registry });
  const getConfig = tools.find((t) => t.name === "get_config");
  const result = await getConfig.handler({});
  ok(result.isError !== true, "an unrelated read-only call on a different tab is unaffected by another tab's elevated category");
}

console.log(fail === 0 ? "\nALL THREAT-ADVISORY-ONLY TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// CRITICAL fix (add-permission-modes-and-threat-signals verification): a
// TabRiskRegistry must outlive a single run. Before this fix,
// host/agent/tools/adapter.js's buildSdkTools() defaulted `tabRiskRegistry`
// to `new TabRiskRegistry()` whenever its caller supplied none, and
// host/agent/companion.js's only call site (createBrowserMcpServer inside
// its per-run query setup) never supplied one — so every startRun() built a
// brand-new, empty registry, and an injection finding that elevated a tab in
// turn 1 silently reset to "uncategorized" in turn 2 of the SAME
// conversation, on the SAME still-open, non-navigated tab.
//
// This proves, against the REAL CompanionCore (no SDK/network/credential —
// same harness host/test/permission-mode-companion-wiring.test.mjs already
// uses):
//   1. `CompanionCore._tabRiskRegistryFor(conversationId)` returns the SAME
//      TabRiskRegistry instance for the same conversationId every time, and
//      a DIFFERENT instance for a different conversationId.
//   2. A tab's category/signals recorded through one `buildSdkTools()` call
//      (simulating turn 1's run) are still there, unchanged, when a SECOND,
//      freshly-built `buildSdkTools()` call (simulating turn 2's run) looks
//      the SAME tab up — because both turns are handed the SAME
//      conversation-scoped registry, not two independent per-run ones.
//   3. That persistence does NOT defeat the reset-on-navigation rule: a real
//      `navigate` dispatch against that tab, through the SAME registry,
//      still resets it to uncategorized with no carried-forward signals —
//      proving this fix only widens how long "no change yet" means "carry
//      forward", never weakens the actual reset trigger.
//   4. Deleting the conversation removes its registry from
//      `_tabRiskByConversation`, so a long-lived companion does not
//      accumulate one entry per conversation forever.
//
// Run: node host/test/tab-risk-conversation-persistence.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";
import { Run } from "../agent/session/run.js";
import { buildSdkTools } from "../agent/tools/adapter.js";
import { recordAgentCreatedTab } from "../agent/tools/mapping.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-tab-risk-persist-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

let fail = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function buildCore() {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name, args) => {
      if (name === "navigate") return { content: [{ type: "text", text: `navigated:${args && args.url}` }] };
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: { async *query() {} },
    profileProvider: { async snapshotForRun() { throw new Error("not used by this suite"); } }
  });
}

async function newConversation(core) {
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }));
  assert(reply && reply.conversationId, `expected a conversationId from NEW, got ${JSON.stringify(reply)}`);
  return reply.conversationId;
}

/** One standalone Run's worth of REAL registered browser tools, sharing
 * `registry` — exactly the shape companion.js's real `_runQuery` builds for
 * one turn (a fresh Run, a fresh buildSdkTools() call, but a registry handed
 * in from outside rather than defaulted). */
async function toolsForTurn(registry, { tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_unused_by_this_helper", lease, approvals, tabScope });
  await run.begin();
  recordAgentCreatedTab(run, 7); // avoid the unrelated borrowed-tab gate — not what this suite tests
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name, args) => {
      if (name === "navigate") return { content: [{ type: "text", text: `navigated:${args && args.url}` }] };
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    shutdown: () => {}
  });
  return buildSdkTools({ toolBridge, coerceArgs: (a) => a, run, tabRiskRegistry: registry });
}

console.log("\nTabRiskRegistry survives across a conversation's turns (CompanionCore wiring)\n");

const core = buildCore();
await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));

await test("_tabRiskRegistryFor() returns the SAME instance for the same conversationId, a DIFFERENT one for another", async () => {
  const convA = await newConversation(core);
  const convB = await newConversation(core);

  const a1 = core._tabRiskRegistryFor(convA);
  const a2 = core._tabRiskRegistryFor(convA);
  const b1 = core._tabRiskRegistryFor(convB);

  assert(a1 === a2, "the same conversationId must always get back the identical registry instance");
  assert(a1 !== b1, "a different conversationId must get its own, separate registry instance");
});

await test("a signal recorded in turn 1 is still there, unreset, when turn 2's freshly-built tools look up the same tab", async () => {
  const conversationId = await newConversation(core);
  const registry = core._tabRiskRegistryFor(conversationId);

  // Turn 1: an injection finding elevates tab 7 (mirrors observe.js's own
  // recordSignal call for a real probe finding — using the registry API
  // directly here since the wiring under test is companion.js's persistence
  // of the INSTANCE across turns, not the probe itself).
  const turn1Tools = await toolsForTurn(registry);
  registry.recordSignal(7, {
    kind: "injection_finding",
    severity: "elevated",
    label: "possible agent-directed instruction found in page content",
    matchedText: "ignore all previous instructions"
  });
  assert(registry.getState(7).category === "elevated", "sanity: tab 7 is really elevated at the end of turn 1");
  void turn1Tools;

  // Turn 2: a BRAND NEW Run and a BRAND NEW buildSdkTools() call — exactly
  // what happens on the next startRun() of the SAME conversation — but
  // looking up the SAME conversation-scoped registry companion.js's
  // _tabRiskRegistryFor() now returns, instead of getting a fresh empty
  // default. Before this fix, this next line would have been a NEW empty
  // TabRiskRegistry and tab 7 would already have silently reset to
  // uncategorized here, despite never having navigated.
  const registryForTurn2 = core._tabRiskRegistryFor(conversationId);
  assert(registryForTurn2 === registry, "turn 2 must be handed the exact same registry instance turn 1 used");
  const turn2Tools = await toolsForTurn(registryForTurn2);
  const getPageText = turn2Tools.find((t) => t.name === "get_page_text");
  await getPageText.handler({ tabId: 7 });
  assert(registryForTurn2.getState(7).category === "elevated", "tab 7's elevated category from turn 1 survives into turn 2 on the same still-open, non-navigated tab");
  assert(
    registryForTurn2.getState(7).signals.some((s) => s.kind === "injection_finding"),
    "the actual contributing signal from turn 1 is still inspectable in turn 2, not just the category"
  );
});

await test("that persistence never defeats the reset-on-navigation rule: a real navigate dispatch still resets the tab", async () => {
  const conversationId = await newConversation(core);
  const registry = core._tabRiskRegistryFor(conversationId);
  registry.recordSignal(7, { kind: "injection_finding", severity: "elevated", label: "x", matchedText: "ignore all previous instructions" });
  assert(registry.getState(7).category === "elevated", "sanity: tab 7 starts elevated");

  const tools = await toolsForTurn(registry);
  const navigate = tools.find((t) => t.name === "navigate");
  const result = await navigate.handler({ tabId: 7, url: "https://example.com/fresh" });
  assert(result.isError !== true, `navigate must dispatch successfully — got ${JSON.stringify(result)}`);

  const state = registry.getState(7);
  assert(state.category === "uncategorized", `navigate must reset the category to uncategorized (a reload/new document never carries the old category forward) — got ${state.category}`);
  assert(state.signals.length === 0, "navigate must also clear the contributing signals, not just the category label");
});

await test("deleting the conversation removes its TabRiskRegistry so a long-lived companion does not accumulate one per conversation forever", async () => {
  const conversationId = await newConversation(core);
  core._tabRiskRegistryFor(conversationId); // create it
  assert(core._tabRiskByConversation.has(conversationId), "sanity: the registry exists before deletion");

  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId }));
  assert(reply && reply.deleted === true, `expected the conversation to be deleted, got ${JSON.stringify(reply)}`);
  assert(!core._tabRiskByConversation.has(conversationId), "the registry entry must be removed once its conversation is deleted");
});

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.name}\n    ${f.err}`);
}
console.log(failed.length === 0 ? "ALL TAB-RISK CONVERSATION-PERSISTENCE TESTS PASSED" : `${failed.length} FAILED`);
process.exit(failed.length ? 1 : 0);

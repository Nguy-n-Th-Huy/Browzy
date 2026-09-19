#!/usr/bin/env node
//
// Rerunnable workflows, host half: the five wire operations end to end through
// CompanionCore (draft derive/save, prove across the existing bridge, enable,
// heal decision), the heal proposal tool, and the drift consumer that reads
// the executor's versioned result marker.
//
// Everything here runs against fakes for the SDK and the bridge and a REAL
// registry under a scratch OCIC_AGENT_HOME — the same harness discipline
// agent-companion-core.test.mjs established. No live browser, no API key.
//
// Run: node host/test/workflow-prove-bridge.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-prove-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { Run } from "../agent/session/run.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";
import { buildSdkTools } from "../agent/tools/adapter.js";
import { authorizeBorrowedTabMutation } from "../agent/tools/mapping.js";
import { createProposeWorkflowHealTool } from "../agent/tools/propose-workflow-heal.js";

const store = await import("../agent/skills/workflows-store.js");
const proof = await import("../agent/skills/workflows-proof.js");
const heal = await import("../agent/skills/workflows-heal.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

function fakeSdk({ messages = [] } = {}) {
  return {
    async *query() {
      for (const m of messages) yield m;
    }
  };
}

function hangingSdk() {
  return {
    async *query() {
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  };
}

/** Build a CompanionCore with a recording bridge fake. */
function buildCore({ sdk, callTool, toolBridge, healProposals } = {}) {
  const transcript = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store: transcript, lease, approvals });
  const calls = [];
  const bridge =
    toolBridge ||
    new ToolBridge({
      init: async () => {},
      callTool:
        callTool ||
        (async (name, args, meta) => {
          calls.push({ name, args, meta });
          return { content: [{ type: "text", text: `fake:${name}` }] };
        }),
      shutdown: () => {}
    });
  const core = new CompanionCore({
    toolBridge: bridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || fakeSdk(),
    profileProvider: fakeProfileProvider(),
    ...(healProposals ? { healProposals } : {})
  });
  return { core, sessionManager, lease, calls, transcript };
}

function toolUse(name, input, id) {
  return { type: "tool_use", id: id || `tu_${name}`, name, input };
}

/** One completed run's stored trail, appended directly (the run lifecycle
 *  itself is covered elsewhere; this isolates the derivation input). */
function seedRun(sessionManager, conversationId, { runId = "run_seed_1", blocks = [], terminal = true } = {}) {
  const store_ = sessionManager.store;
  store_.appendEvent(conversationId, { type: "run_created", runId, tabScope: "any" });
  for (const [index, block] of blocks.entries()) {
    store_.appendEvent(conversationId, {
      type: "stream_message",
      runId,
      message: { type: "assistant", message: { id: `msg_${index}`, content: [block] }, session_id: "s1" }
    });
  }
  if (terminal) store_.appendEvent(conversationId, { type: "run_done", runId });
  return runId;
}

async function conversation(core, meta = {}) {
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta }));
  return reply.conversationId;
}

const DEFINITION = {
  id: "wf-prove-cart",
  owner: "local-operator",
  name: "Cart helper",
  description: "Opens the cart and finds the checkout control.",
  domainConstraints: ["shop.example.com"],
  steps: [
    { kind: "tool", ref: "navigate", args: { url: "https://shop.example.com/cart" } },
    { kind: "tool", ref: "find", args: { query: "Checkout" } }
  ]
};

const PROVE_REPLY = {
  ok: true,
  outcomes: [
    { index: 0, ref: "navigate", status: "ok", note: "cart loaded", url: "https://shop.example.com/cart", fetchedAt: "2026-01-01T00:00:00.000Z" },
    { index: 1, ref: "find", status: "ok", note: "1 match", url: "https://shop.example.com/cart", fetchedAt: "2026-01-01T00:00:01.000Z" }
  ],
  finalUrl: "https://shop.example.com/cart"
};

console.log("\nworkflow prove bridge (host half)\n");

await test("draft_request: an unknown run, an unfinished run and a bookkeeping-only trail are refused distinguishably", async () => {
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);

  const unknown = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId: "run_nope", requestId: "r1" })
  );
  assert(unknown.type === AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST && unknown.ok === false, "a structured refusal");
  assert(unknown.reason === "unknown_run" && unknown.requestId === "r1", "the reason names the unknown run and the requestId is echoed");

  seedRun(sessionManager, conversationId, { runId: "run_open", blocks: [toolUse("read_page", {})], terminal: false });
  const unfinished = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId: "run_open" })
  );
  assert(unfinished.ok === false && unfinished.reason === "run_not_completed", "an unterminated run is not a completed run");

  seedRun(sessionManager, conversationId, {
    runId: "run_bookkeeping",
    blocks: [toolUse("update_plan", { plan: "x" }), toolUse("read_console_messages", { tabId: 1 })]
  });
  const noTrail = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId: "run_bookkeeping" })
  );
  assert(noTrail.ok === false && noTrail.reason === "no_trail", "bookkeeping alone is no trail");

  const missingConversation = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId: "conv_missing", runId: "x" })
  );
  assert(missingConversation.ok === false && missingConversation.reason === "unknown_conversation", "an unknown conversation is refused, never derived");
});

await test("draft_request: a completed run derives draft + review from the recorded trail", async () => {
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core, { hostname: "shop.example.com" });
  seedRun(sessionManager, conversationId, {
    runId: "run_ok",
    blocks: [
      // The SDK's own qualified name is what the transcript records; the
      // derivation must resolve it back to the registry tool.
      toolUse("mcp__browzy-in-chrome-browser__navigate", { url: "https://shop.example.com/cart", tabId: 7 }),
      toolUse("mcp__browzy-in-chrome-browser__find", { query: "Checkout", tabId: 7 }),
      toolUse("update_plan", { plan: "internal bookkeeping" })
    ]
  });
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId: "run_ok", requestId: "r2" })
  );
  assert(reply.ok === true, `a completed run derives: ${JSON.stringify(reply)}`);
  assert(reply.draft.workflowId && reply.draft.name, "the draft carries an editable identity suggestion");
  assert(reply.draft.steps.length === 2, "only operator actions become steps");
  assert(reply.draft.steps[0].ref === "navigate" && reply.draft.steps[0].args.url === "https://shop.example.com/cart", "arguments are the recorded literals");
  assert(reply.draft.steps[0].args.tabId === undefined, "run-scoped tabs are never frozen");
  assert(reply.draft.domain === "shop.example.com", "the domain binding comes from the recorded trail");
  assert(reply.draft.document === null, "no recorded document binding means no fabricated one");
  assert(reply.review.steps.length === 2 && reply.review.domain === "shop.example.com", "the review surface mirrors the draft");
});

await test("draft_request/save: Jev actions reach the review and disabled registry without auxiliary calls or stale handles", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager, calls } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core); // derive the host from the recorded observation
  const runId = "run_jev_workflow";
  const rows = [
    { type: "run_created" },
    { type: "action_event", event: { runId, actionId: "snapshot", action: { tool: "page_snapshot" } } },
    { type: "jev_step", step: 1, operation: "CLICK", tool: "computer", argsSummary: { action: "left_click", ref: "ref_1", tabId: 7 }, target: { index: "1", label: "Orders" }, observed: { url: "https://shop.example.com/" } },
    { type: "jev_step", step: 2, operation: "HOVER", tool: "computer", argsSummary: { action: "hover", ref: "ref_1", tabId: 7 }, target: { index: "1", label: "Details", role: "button" }, observed: { url: "https://shop.example.com/orders" } },
    { type: "jev_step", step: 3, operation: "DONE", tool: null, argsSummary: null, skippedReason: "done" },
    { type: "run_done" },
    { type: "action_event", event: { runId, actionId: "snapshot", action: { tool: "page_snapshot" } } }
  ];
  for (const row of rows) sessionManager.store.appendEvent(conversationId, { ...row, runId });
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId }));
  assert(reply.ok && reply.draft.steps.length === 3, JSON.stringify(reply));
  assert(reply.draft.steps[0].args.url === "https://shop.example.com/", "the run's own starting page is retained");
  assert(reply.draft.steps[1].args.target.name === "Orders" && reply.draft.steps[2].args.target.name === "Details", "ref reuse never overwrites a call's target");
  assert(reply.draft.steps.every((step) => step.args.ref === undefined && step.args.tabId === undefined), "no ephemeral bindings reach review");
  assert(reply.draft.domain === "shop.example.com" && reply.review.steps.length === 3, "domain and review are derived from the same trail");
  const saved = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_SAVE, {
    conversationId, runId,
    definition: { id: "wf-jev-derived", name: reply.draft.name, domainConstraints: reply.draft.domains, steps: reply.draft.steps }
  }));
  assert(saved.ok && saved.version === 1, JSON.stringify(saved));
  const record = store.getWorkflow("wf-jev-derived");
  assert(record.enabled === false && record.steps.length === 3 && record.provenance.materializedFromRun === runId, "registry validation and provenance use the existing save path");
  assert(calls.length === 0, "derivation and saving do not execute the workflow");
});

await test("draft_request: a trail with no URL-bearing call falls back to the conversation's recorded hostname", async () => {
  // The common case the live bug hit (2026-09-14): a find/read-only run has
  // no URL anywhere in its tool calls, so the domain MUST come from the
  // conversation's recorded hostname — the raw meta's `hostname`, never the
  // versioned conversationMetadata envelope (which never carries it).
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core, { hostname: "dauthau.asia" });
  seedRun(sessionManager, conversationId, {
    runId: "run_no_url",
    blocks: [
      toolUse("mcp__browzy-in-chrome-browser__find", { query: "Hà Nội" }),
      toolUse("mcp__browzy-in-chrome-browser__get_page_text", {})
    ]
  });
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId: "run_no_url", requestId: "r3" })
  );
  assert(reply.ok === true, `a URL-less trail still derives via the recorded hostname: ${JSON.stringify(reply)}`);
  assert(reply.draft.domain === "dauthau.asia", "the domain binding falls back to the conversation's recorded hostname");
  assert(reply.draft.domains.length === 1 && reply.draft.domains[0] === "dauthau.asia", "the recorded domains carry the fallback host");
  assert(reply.draft.steps.length === 2, "find + read become steps");
});

await test("draft_request: no hostname and no URL is an honest incompleteness reason, never a guess", async () => {
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core); // no hostname recorded
  seedRun(sessionManager, conversationId, {
    runId: "run_bare",
    blocks: [toolUse("mcp__browzy-in-chrome-browser__find", { query: "x" })]
  });
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_REQUEST, { conversationId, runId: "run_bare" })
  );
  assert(reply.ok === false, "without any recorded host the draft is withheld");
  assert(
    Array.isArray(reply.incomplete) && reply.incomplete.some((r) => /no page host/i.test(r)),
    `the reason names the missing host: ${JSON.stringify(reply)}`
  );
});

await test("draft_save: the definition is validated, saved DISABLED under the local operator, and recorded", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  seedRun(sessionManager, conversationId, { runId: "run_save", blocks: [toolUse("navigate", { url: "https://shop.example.com/cart" })] });

  const saved = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_SAVE, {
      conversationId,
      runId: "run_save",
      requestId: "s1",
      definition: {
        ...DEFINITION,
        // A caller cannot smuggle state past the host: these are ignored.
        owner: "someone-else",
        version: 9,
        enabled: true,
        provenance: { claimedBy: "caller" }
      }
    })
  );
  assert(saved.ok === true && saved.version === 1 && saved.workflowId === DEFINITION.id, `saved as v1: ${JSON.stringify(saved)}`);
  const record = store.getWorkflow(DEFINITION.id);
  assert(record.owner === "local-operator", "the owner is the documented host constant");
  assert(record.enabled === false, "a derived draft is never enabled by its own save");
  assert(record.provenance.materializedFromRun === "run_save" && record.provenance.conversationId === conversationId, "provenance is host-written");
  assert(record.provenance.claimedBy === undefined, "a caller-supplied provenance is not trusted");
  const events = sessionManager.store.allEvents(conversationId);
  const event = events.find((e) => e.type === "workflow_draft_saved");
  assert(event && event.workflowId === DEFINITION.id && event.version === 1 && event.stepsCount === 2, "the transcript records the save");

  const bumped = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_SAVE, { conversationId, runId: "run_save", definition: { ...DEFINITION, id: DEFINITION.id } })
  );
  assert(
    bumped.ok === true && bumped.version === 2,
    `a resubmitted draft of an existing workflow is saved as the NEXT version (a save always stores what was reviewed): ${JSON.stringify(bumped)}`
  );
  const v2 = store.getWorkflow(DEFINITION.id, 2);
  assert(v2 && v2.enabled === false, "the bumped version is stored disabled, exactly like a first save");
  assert(v2.provenance.supersededVersion === 1 && v2.provenance.materializedFromRun === "run_save", "its provenance names the version it replaced and stays host-written");
  assert(store.getWorkflow(DEFINITION.id, 1) !== null, "the previous version stays addressable");
  const saveEvents = sessionManager.store.allEvents(conversationId).filter((e) => e.type === "workflow_draft_saved");
  assert(saveEvents.length === 2 && saveEvents[1].version === 2, "the transcript records the bumped save with its new version");

  const unsafe = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_DRAFT_SAVE, {
      conversationId,
      runId: "run_save",
      definition: { ...DEFINITION, id: "wf-unsafe", steps: [{ kind: "shell", ref: "rm -rf /" }] }
    })
  );
  assert(unsafe.ok === false && unsafe.errors.some((e) => e.code === "UNSUPPORTED_STEP"), "an unsupported kind is refused with its own code");
  assert(store.getWorkflow("wf-unsafe") === null, "nothing was saved");
});

await test("workflow_edit_request: the stored steps come back for editing; unknown workflows are refused", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store.createWorkflow({ ...DEFINITION, enabled: false });

  const got = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_REQUEST, { conversationId, workflowId: DEFINITION.id, version: 1, requestId: "e1" })
  );
  assert(got.ok === true && got.workflowId === DEFINITION.id && got.version === 1, `the record is resolved for editing: ${JSON.stringify(got).slice(0, 200)}`);
  assert(Array.isArray(got.steps) && got.steps.length === DEFINITION.steps.length, "its stored steps come back");

  const unknown = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_REQUEST, { conversationId, workflowId: "wf-nope", requestId: "e2" })
  );
  assert(unknown.ok === false && unknown.reason === "unknown_workflow", "an unknown workflow is refused by name");
});

await test("workflow_edit_save: operator edits validate through the registry and persist as the next version", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store.createWorkflow({ ...DEFINITION, enabled: false });

  // Drop the second step and re-aim the first — the operator's kind of fix.
  const edited = [{ kind: "tool", ref: "navigate", args: { url: "https://shop.example.com/orders" } }];
  const saved = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_SAVE, { conversationId, workflowId: DEFINITION.id, version: 1, steps: edited, requestId: "e3" })
  );
  assert(saved.ok === true && saved.version === 2, `the edit is stored as v2: ${JSON.stringify(saved)}`);
  const v2 = store.getWorkflow(DEFINITION.id, 2);
  assert(v2.steps.length === 1 && v2.steps[0].args.url === "https://shop.example.com/orders", "the edited steps replaced the record's");
  assert(v2.provenance.editedFrom === 1, "its provenance names the version it was edited from");
  assert(store.getWorkflow(DEFINITION.id, 1) !== null, "the previous version stays addressable");
  const events = sessionManager.store.allEvents(conversationId).filter((e) => e.type === "workflow_updated");
  assert(events.length === 1 && events[0].fromVersion === 1 && events[0].toVersion === 2, "the transcript records the update with both versions");

  const stale = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_SAVE, { conversationId, workflowId: DEFINITION.id, version: 1, steps: edited, requestId: "e4" })
  );
  assert(stale.ok === false && stale.reason === "stale_version" && stale.latest === 2, `a stale edit is refused with the latest disclosed: ${JSON.stringify(stale)}`);

  const nochange = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_SAVE, { conversationId, workflowId: DEFINITION.id, version: 2, steps: v2.steps, requestId: "e5" })
  );
  assert(nochange.ok === false && nochange.errors.some((e) => e.code === "NO_CHANGE"), "an identical steps array is refused as NO_CHANGE, never minted as another version");

  const unsafe = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_SAVE, { conversationId, workflowId: DEFINITION.id, version: 2, steps: [{ kind: "shell", ref: "rm -rf /" }], requestId: "e6" })
  );
  assert(unsafe.ok === false && unsafe.errors.some((e) => e.code === "UNSUPPORTED_STEP"), "an unsafe kind is refused with its registry code");
  assert(store.getWorkflow(DEFINITION.id).version === 2, "nothing was written on any refusal");

  // The edit never flips the enablement state (same rule as heal approval).
  store.setWorkflowEnabled(DEFINITION.id, true, { owner: "local-operator" });
  const editedWhileEnabled = [{ kind: "tool", ref: "navigate", args: { url: "https://shop.example.com/cart" } }, { kind: "tool", ref: "find", args: { query: "Checkout" } }];
  const done = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_EDIT_SAVE, { conversationId, workflowId: DEFINITION.id, version: 3, steps: editedWhileEnabled, requestId: "e7" })
  );
  assert(done.ok === true && done.version === 4, "an edit of an enabled line saves the next version");
  assert(store.getWorkflow(DEFINITION.id).enabled === true, "...and the enablement state is unchanged by the edit");
});

await test("prove: refuses with a distinguishable busy reason while a run holds the lease — and never dispatches", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager, calls } = buildCore({ sdk: hangingSdk() });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store.createWorkflow({ ...DEFINITION, enabled: true });
  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p", modelId: "m", prompt: "hello", mode: "queue" })
  );
  // Wait until the run actually holds the lease.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !core.lease.isHeld()) await new Promise((r) => setTimeout(r, 10));
  assert(core.lease.isHeld(), "the fixture run holds the lease");

  const busy = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId, workflowId: DEFINITION.id, version: 1, tabId: 42, requestId: "p1" })
  );
  assert(busy.ok === false && busy.reason === "busy", `prove must refuse while a run is active: ${JSON.stringify(busy)}`);
  assert(/lease|active run/.test(busy.detail), "the refusal names what holds the browser");
  assert(calls.length === 0, "nothing was dispatched to the extension");
  assert(!fs.existsSync(path.join(scratchRoot, "workflows", "proof")), "no evidence was written for a refused prove");
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("prove: runs through the existing bridge with no lease meta, writes evidence, records the proof", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager, calls } = buildCore({
    callTool: async (name, args, meta) => {
      calls.push({ name, args, meta });
      return { content: [{ type: "text", text: JSON.stringify(PROVE_REPLY) }] };
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store.createWorkflow({ ...DEFINITION, enabled: false });

  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId, workflowId: DEFINITION.id, version: 1, tabId: 42, requestId: "p2" })
  );
  assert(reply.ok === true, `proof succeeds: ${JSON.stringify(reply)}`);
  assert(calls.length === 1 && calls[0].name === "workflow_prove", "exactly one prove request crossed the bridge");
  assert(calls[0].meta === undefined, "the prove request carries no lease-bearing meta");
  assert(calls[0].args.tabId === 42 && calls[0].args.workflowId === DEFINITION.id && calls[0].args.version === 1, "the request names the tab and the exact version");
  assert(calls[0].args.definition.steps.length === 2, "the stored definition is what is proven");
  assert(reply.outcomes.length === 2 && reply.allOk === true, "per-step outcomes come back");
  assert(reply.evidenceFile === "workflows/proof/wf-prove-cart@1.json", `logical evidence path only: ${reply.evidenceFile}`);
  const evidence = proof.readProofEvidence(DEFINITION.id, 1);
  assert(evidence && evidence.source === PROVE_REPLY.finalUrl && evidence.fetchedAt, "evidence keeps the live source + fetch time");
  assert(evidence.outcomes.length === 2 && evidence.ranAt, "evidence keeps every step outcome");
  const event = sessionManager.store.allEvents(conversationId).find((e) => e.type === "workflow_proof");
  assert(event && event.ok === true && event.version === 1 && /nguồn:/.test(event.summary), "the transcript records the proof with its source summary");
});

await test("prove: already-satisfied expansion reaches the panel and retained evidence without claiming a click", async () => {
  store._clearWorkflowsForTests();
  const outcome = { index: 0, ref: "computer", status: "ok", state: "already_satisfied", note: "Expansion already satisfied; no click dispatched." };
  const { core } = buildCore({
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, outcomes: [outcome], finalUrl: "https://shop.example.com/cart" }) }] })
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store.createWorkflow({
    ...DEFINITION,
    enabled: false,
    steps: [{ kind: "tool", ref: "computer", args: { action: "left_click", target: { role: "button", name: "Advanced search" } } }]
  });
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId, workflowId: DEFINITION.id, version: 1, tabId: 42 })
  );
  assert(reply.ok === true && reply.allOk === true, "an already-open expansion satisfies its proof step");
  assert(reply.outcomes[0].state === "already_satisfied" && reply.outcomes[0].note === outcome.note, "the panel receives the explicit no-click outcome");
  const evidence = proof.readProofEvidence(DEFINITION.id, 1);
  assert(evidence && JSON.stringify(evidence.outcomes[0]) === JSON.stringify(reply.outcomes[0]), "the evidence roundtrip retains the same status, state and explanation as the panel reply");
});

await test("prove normalization: already-satisfied state requires a successful step and unsupported states are dropped", async () => {
  const normalized = proof.normalizeProveReply(JSON.stringify({
    outcomes: [
      { status: "ok", state: "already_satisfied" },
      { status: "failed", state: "already_satisfied", reason: "target_no_longer_resolves" },
      { status: "unexecutable", state: "already_satisfied" },
      { status: "unknown", state: "already_satisfied" },
      { status: "ok", state: "future_unrecognized_state" }
    ]
  }));
  assert(normalized.ok && normalized.outcomes[0].state === "already_satisfied", "only the supported success state survives normalization");
  assert(normalized.outcomes.slice(1).every((outcome) => !("state" in outcome)), "failure, unexecutable, invalid status and unsupported state cannot claim already satisfied");
  assert(normalized.outcomes[1].status === "failed" && normalized.outcomes[1].reason === "target_no_longer_resolves", "an inconsistent state never erases a real failure");
});

await test("prove: failure modes keep their own reasons (unknown workflow, extension refusal, busy bounce, garbage)", async () => {
  store._clearWorkflowsForTests();
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  const prove = (extra) =>
    core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId, workflowId: DEFINITION.id, version: 1, tabId: 1, ...extra })
    );

  const unknown = await prove({});
  assert(unknown.ok === false && unknown.reason === "unknown_workflow", "an unknown workflow is refused before dispatch");

  const malformed = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId, workflowId: DEFINITION.id, tabId: "seven" })
  );
  assert(malformed.type === AGENT_MESSAGE_TYPES.ERROR && malformed.reason === "malformed_workflow_prove", "a malformed tab is a protocol error");

  store.createWorkflow({ ...DEFINITION, enabled: false });
  const failing = buildCore({ callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, reason: "not_in_group", detail: "Tab 1 is not in the MCP group." }) }] }) });
  await failing.core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const failConversation = await conversation(failing.core);
  const refused = await failing.core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId: failConversation, workflowId: DEFINITION.id, tabId: 1 })
  );
  assert(refused.ok === false && refused.reason === "not_in_group" && /not in the MCP group/.test(refused.detail), "the extension's own reason survives");

  const garbage = buildCore({ callTool: async () => ({ content: [{ type: "text", text: "Error: Unknown tool: workflow_prove" }] }) });
  await garbage.core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const garbageConversation = await conversation(garbage.core);
  const unparseable = await garbage.core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId: garbageConversation, workflowId: DEFINITION.id, tabId: 1 })
  );
  assert(unparseable.ok === false && unparseable.reason === "extension_error", "a non-JSON reply is its own reason, never a fake success");
  assert(/Unknown tool/.test(unparseable.detail), "…with what the extension actually said");

  // The bridge's own lease arbitration is the second line of defence for the
  // race window the companion's pre-check cannot close: tool-runtime collapses
  // the refusal into "Error: Browser is busy: …" text, and that must map to
  // the same distinguishable reason rather than a generic bridge failure.
  const bounced = buildCore({
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: "Error: Browser is busy: another conversation currently owns the browser lease. This is retryable — wait for it to release and try again."
        }
      ]
    })
  });
  await bounced.core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const bouncedConversation = await conversation(bounced.core);
  const bouncedReply = await bounced.core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId: bouncedConversation, workflowId: DEFINITION.id, tabId: 1 })
  );
  assert(bouncedReply.ok === false && bouncedReply.reason === "busy", `a bridge busy bounce keeps the busy reason: ${JSON.stringify(bouncedReply)}`);
  assert(/Browser is busy/.test(bouncedReply.detail), "…and says what the bridge said");
});

await test("enable: unknown, stale, one version bump with a recorded event, and the already-enabled no-op", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store.createWorkflow({ ...DEFINITION, enabled: false, description: "v1" });
  store.updateWorkflow(DEFINITION.id, { description: "v2" }, { owner: "local-operator" });

  const stale = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_ENABLE, { conversationId, workflowId: DEFINITION.id, version: 1 })
  );
  assert(stale.ok === false && stale.reason === "stale_version" && stale.latest === 2, "a stale version is refused with the latest disclosed");

  const enabled = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_ENABLE, { conversationId, workflowId: DEFINITION.id, version: 2 })
  );
  assert(enabled.ok === true && enabled.version === 3, `enabling bumps one version: ${JSON.stringify(enabled)}`);
  assert(store.getWorkflow(DEFINITION.id).enabled === true, "the line's latest version is enabled");
  const event = sessionManager.store.allEvents(conversationId).find((e) => e.type === "workflow_enabled");
  assert(event && event.workflowId === DEFINITION.id && event.version === 3, "the transcript records which version was enabled");

  const again = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_ENABLE, { conversationId, workflowId: DEFINITION.id, version: 3 })
  );
  assert(again.ok === true && again.version === 3 && again.alreadyEnabled === true, "an already-enabled workflow is reported, not re-versioned");
  assert(store.listWorkflows().length === 3, "no empty version bump");

  const unknown = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_ENABLE, { conversationId, workflowId: "wf_missing_one", version: 1 })
  );
  assert(unknown.ok === false && unknown.reason === "unknown_workflow", "an unknown workflow is refused");
});

await test("heal_decide: allow saves exactly one version with provenance; deny records; both are distinguishable", async () => {
  store._clearWorkflowsForTests();
  const { core, sessionManager } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  const current = store.createWorkflow({ ...DEFINITION, enabled: true });

  const { proposal } = core.healProposals.propose({
    conversationId,
    workflowId: current.id,
    owner: current.owner,
    baseVersion: current.version,
    steps: [current.steps[0], { kind: "tool", ref: "find", args: { query: "Checkout now" } }],
    reason: "the checkout control moved",
    evidence: "step 2 reported target_no_longer_resolves",
    enabled: true
  });
  const approved = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_HEAL_DECIDE, { conversationId, proposalId: proposal.proposalId, decision: "allow", requestId: "h1" })
  );
  assert(approved.ok === true && approved.decision === "allow", `approval saves: ${JSON.stringify(approved)}`);
  assert(approved.fromVersion === 1 && approved.toVersion === 2, "exactly one version bump, named");
  const saved = store.getWorkflow(current.id);
  assert(saved.provenance.healedFrom === 1 && saved.provenance.healReason === "the checkout control moved", "provenance names the healed version and the reason");
  assert(/target_no_longer_resolves/.test(saved.provenance.healEvidence), "provenance keeps the drift evidence");
  assert(saved.steps[1].args.query === "Checkout now", "the healed steps are stored");
  assert(saved.enabled === true, "the enabled state is unchanged by the save");
  assert(store.getWorkflow(current.id, 1).steps[1].args.query === "Checkout", "the previous version is still addressable, untouched");
  const healEvent = sessionManager.store.allEvents(conversationId).find((e) => e.type === "workflow_heal_saved");
  assert(healEvent && healEvent.proposalId === proposal.proposalId && healEvent.toVersion === 2, "the save is recorded with its proposal");

  const late = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_HEAL_DECIDE, { conversationId, proposalId: proposal.proposalId, decision: "deny" })
  );
  assert(late.ok === false && late.reason === "unknown_proposal" && late.state.status === "approved", "a late decision is refused with the state disclosed");
  assert(store.listWorkflows().length === 2, "the late decision saved nothing");

  const { proposal: second } = core.healProposals.propose({
    conversationId,
    workflowId: current.id,
    owner: current.owner,
    baseVersion: 2,
    steps: [current.steps[0], { kind: "tool", ref: "find", args: { query: "Checkout (third)" } }],
    reason: "again",
    evidence: null,
    enabled: true
  });
  const denied = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_HEAL_DECIDE, { conversationId, proposalId: second.proposalId, decision: "deny" })
  );
  assert(denied.ok === true && denied.decision === "deny", "deny resolves");
  assert(store.listWorkflows().length === 2, "a rejection saves nothing");
  assert(JSON.stringify(store.getWorkflow(current.id)) === JSON.stringify(saved), "the stored definition is untouched by a rejection");
  const rejectedEvent = sessionManager.store.allEvents(conversationId).find((e) => e.type === "workflow_heal_rejected");
  assert(rejectedEvent && rejectedEvent.proposalId === second.proposalId, "the rejection is distinguishable in the record");
});

await test("heal_decide: unknown, superseded and expired proposals are refused with their state", async () => {
  let fakeNow = Date.now();
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0, now: () => fakeNow, ttlMs: 10 * 60_000 });
  const { core } = buildCore({ healProposals: proposals });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store._clearWorkflowsForTests();
  const current = store.createWorkflow({ ...DEFINITION, enabled: true });
  const decide = (proposalId, decision = "allow") =>
    core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_HEAL_DECIDE, { conversationId, proposalId, decision }));

  const unknown = await decide("heal_nope");
  assert(unknown.ok === false && unknown.reason === "unknown_proposal" && unknown.state.status === "unknown", "an unknown proposal discloses that");

  const first = proposals.propose({
    conversationId,
    workflowId: current.id,
    owner: current.owner,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "one" } }],
    reason: "r1",
    evidence: null
  });
  const second = proposals.propose({
    conversationId,
    workflowId: current.id,
    owner: current.owner,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "two" } }],
    reason: "r2",
    evidence: null
  });
  const superseded = await decide(first.proposal.proposalId);
  assert(superseded.ok === false && superseded.reason === "superseded", "the superseded proposal cannot be approved");
  assert(superseded.state.supersededBy === second.proposal.proposalId, "the replacement is disclosed");
  // (The `workflow_heal_superseded` EVENT is emitted by the propose tool, the
  // only producer of proposals — asserted in the propose-tool test below.)

  // Expiry, observed by a decision that arrives after the bounded window.
  const expiring = proposals.propose({
    conversationId,
    workflowId: current.id,
    owner: current.owner,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "three" } }],
    reason: "r3",
    evidence: null
  });
  fakeNow += 11 * 60_000;
  const expired = await decide(expiring.proposal.proposalId);
  assert(expired.ok === false && expired.reason === "expired", `an expired proposal is refused as expired: ${JSON.stringify(expired)}`);
  assert(expired.state.status === "expired", "…with its state disclosed");
  const expiredEvent = core.sessionManager.store.allEvents(conversationId).find((e) => e.type === "workflow_heal_expired");
  assert(expiredEvent && expiredEvent.proposalId === expiring.proposal.proposalId, "the expiry is recorded distinguishably");
  assert(store.listWorkflows().length === 1, "nothing was saved by an expiry");
  proposals.dispose();
});

await test("heal_decide: a base version that moved under a proposal is refused, never silently rebased", async () => {
  store._clearWorkflowsForTests();
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  const current = store.createWorkflow({ ...DEFINITION, enabled: false });
  const { proposal } = core.healProposals.propose({
    conversationId,
    workflowId: current.id,
    owner: current.owner,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "repaired" } }],
    reason: "drift",
    evidence: null
  });
  store.updateWorkflow(current.id, { description: "operator edited meanwhile" }, { owner: "local-operator" });
  const decided = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_HEAL_DECIDE, { conversationId, proposalId: proposal.proposalId, decision: "allow" })
  );
  assert(decided.ok === false && decided.reason === "stale_base" && decided.latest === 2, `a moved base is refused: ${JSON.stringify(decided)}`);
  assert(store.getWorkflow(current.id).steps[1].args.query === "Checkout", "the operator's version was not overwritten");
  assert(core.healProposals.get(proposal.proposalId).status === "pending", "the proposal stays decidable after a refusal");
});

await test("propose tool: validates against the registry, files the proposal, emits the events, never saves", async () => {
  const current = store.createWorkflow({ ...DEFINITION, id: "wf-tool-heal", enabled: true });
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const events = [];
  const run = { runId: "run_tool", emit: (event) => events.push(event) };
  const toolFactory = (name, description, shape, handler) => ({ name, description, inputSchema: shape, handler });
  const tool = await createProposeWorkflowHealTool({
    run,
    proposals,
    conversationId: "conv_tool",
    owner: "local-operator",
    toolFactory
  });
  assert(tool.name === "propose_workflow_heal", "the tool registers under the exported name");
  assert(/never applies/i.test(tool.description) && /operator/i.test(tool.description), "the description states it never auto-applies and the operator approves");

  const invalid = await tool.handler({ workflowId: current.id, version: 1, steps: [{ kind: "shell", ref: "rm" }], reason: "x" });
  assert(invalid.isError === true && /UNSUPPORTED_STEP/.test(invalid.content[0].text), "an unsupported kind is refused with the schema's own code");
  assert(proposals.size() === 0, "nothing was filed");
  assert(events.length === 0, "nothing was recorded");

  const stale = await tool.handler({ workflowId: current.id, version: 7, steps: [{ kind: "tool", ref: "find", args: { query: "y" } }], reason: "x" });
  assert(stale.isError === true && /version 1/.test(stale.content[0].text), "proposing against the wrong version names the current one");

  const ok = await tool.handler({
    workflowId: current.id,
    version: 1,
    steps: [current.steps[0], { kind: "tool", ref: "find", args: { query: "Checkout!" } }],
    reason: "the button moved",
    evidence: { step: 1, reason: "target_no_longer_resolves" }
  });
  assert(ok.isError === false && /heal_/.test(ok.content[0].text), "the model gets the proposal id back");
  assert(proposals.size() === 1, "the proposal is filed");
  const proposed = events.find((e) => e.type === "workflow_heal_proposed");
  assert(proposed && proposed.workflowId === current.id && proposed.baseVersion === 1 && proposed.expiresAt, "the proposal event carries restore data");
  assert(JSON.stringify(proposed.evidence).includes("target_no_longer_resolves"), "evidence travels with the proposal");
  assert(store.getWorkflow(current.id).steps.length === 2, "the registry is untouched by a proposal");

  const second = await tool.handler({
    workflowId: current.id,
    version: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "Checkout!!" } }],
    reason: "still drifting",
    evidence: "second look"
  });
  assert(second.isError === false, "a second proposal is accepted");
  const supersede = events.find((e) => e.type === "workflow_heal_superseded");
  assert(supersede && supersede.oldProposalId === proposed.proposalId, "the supersede is recorded for the panel that showed the old card");
  proposals.dispose();
});

await test("drift consumer: the adapter records drift from the marker at dispatch, and nothing else", async () => {
  const marker = (payload) => `Shortcut "wf-prove-cart" failed at step 2 (find).\nOCIC_WORKFLOW_RESULT ${JSON.stringify(payload)}`;
  const events = [];
  const run = new Run({
    conversationId: "conv_drift",
    lease: new BrowserLease(),
    approvals: new ApprovalRegistry(),
    onEvent: (event) => events.push(event)
  });
  await run.begin();
  // `shortcuts_execute` mutates the addressed (borrowed) tab, so the handler
  // refuses it without the operator's authorization — exactly as it did before
  // this change. Authorizing the tab here models the approval that gates a
  // real workflow execution; it is what lets the call reach the executor whose
  // result this hook reads.
  authorizeBorrowedTabMutation(run, 9);

  const build = (resultText) => {
    const toolBridge = new ToolBridge({
      init: async () => {},
      callTool: async () => ({ content: [{ type: "text", text: resultText }] }),
      shutdown: () => {}
    });
    return buildSdkTools({ toolBridge, coerceArgs: (a) => a, run }).find((t) => t.name === "shortcuts_execute");
  };

  const drifted = build(
    marker({
      outcome: "drift",
      steps: [{ index: 0, ref: "navigate", status: "ok" }, { index: 1, ref: "find", status: "failed", reason: "target_no_longer_resolves" }],
      drift: { step: 1, ref: "find", reason: "target_no_longer_resolves", evidence: "ref e12 is gone" }
    })
  );
  await drifted.handler({ tabId: 9, shortcutId: "wf-prove-cart" });
  const driftEvent = events.find((e) => e.type === "workflow_drift");
  assert(driftEvent, "a drifted execution is recorded as drift");
  assert(driftEvent.workflowId === "wf-prove-cart", "the workflow id comes from the dispatched args");
  assert(driftEvent.step === 1 && driftEvent.ref === "find" && driftEvent.reason === "target_no_longer_resolves", "the step, target and reason are named");
  assert(driftEvent.evidence === "ref e12 is gone", "the evidence travels with the event");

  const before = events.length;
  await build(marker({ outcome: "failed", steps: [{ index: 1, ref: "find", status: "failed", reason: "transient" }] })).handler({
    tabId: 9,
    shortcutId: "wf-prove-cart"
  });
  assert(!events.slice(before).some((e) => e.type === "workflow_drift"), "a transient failure is never drift");
  await build("Shortcut finished: 2 step(s) ran.").handler({ tabId: 9, shortcutId: "wf-prove-cart" });
  assert(!events.slice(before).some((e) => e.type === "workflow_drift"), "a healthy rerun records nothing");
  await build(marker({ outcome: "drift", steps: [], drift: { step: 0, ref: "x", reason: "transient" } })).handler({
    tabId: 9,
    shortcutId: "wf-prove-cart"
  });
  assert(!events.slice(before).some((e) => e.type === "workflow_drift"), "a drift claim outside the frozen reason vocabulary is not recorded");

  const dropped = build(`Error: ${(await import("../tool-runtime.js")).HOST_DROPPED_ERROR}`);
  await dropped.handler({ tabId: 9, shortcutId: "wf-prove-cart" });
  assert(!events.slice(before).some((e) => e.type === "workflow_drift"), "a lost-response dispatch carries no drift");
});

await test("prove: a run whose steps failed is still a completed run — outcomes beat the extension's ok flag", async () => {
  const { core, sessionManager } = buildCore({
    callTool: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            reason: "unexecutable_step",
            workflowId: DEFINITION.id,
            version: 1,
            outcomes: [
              { index: 0, ref: "navigate", status: "ok", url: "https://shop.example.com/cart", fetchedAt: "2026-01-01T00:00:00.000Z" },
              { index: 1, ref: "message", status: "unexecutable", reason: "this executor runs tool steps only" }
            ],
            finalUrl: "https://shop.example.com/cart"
          })
        }
      ]
    })
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await conversation(core);
  store._clearWorkflowsForTests();
  store.createWorkflow({ ...DEFINITION, enabled: false });
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.WORKFLOW_PROVE, { conversationId, workflowId: DEFINITION.id, version: 1, tabId: 3 })
  );
  assert(reply.ok === true && reply.allOk === false, "the proof RAN (its outcomes are the verdict), so the op succeeds with allOk false");
  assert(reply.outcomes[1].status === "unexecutable" && /tool steps only/.test(reply.outcomes[1].reason), "the unexecutable step's own reason reaches the panel");
  const event = sessionManager.store.allEvents(conversationId).find((e) => e.type === "workflow_proof");
  assert(event && event.ok === false, "the recorded proof verdict is false — a draft that cannot be validated is never presented as runnable");
  const evidence = proof.readProofEvidence(DEFINITION.id, 1);
  assert(evidence && evidence.outcomes.length === 2, "the evidence keeps the honest per-step verdict");
});

await test("drift consumer: a pre-flight binding mismatch (no step ran) is recorded with a null step", async () => {
  const events = [];
  const run = new Run({
    conversationId: "conv_binding",
    lease: new BrowserLease(),
    approvals: new ApprovalRegistry(),
    onEvent: (event) => events.push(event)
  });
  await run.begin();
  authorizeBorrowedTabMutation(run, 4);
  const marker = `Shortcut "wf-prove-cart" refused.\nOCIC_WORKFLOW_RESULT ${JSON.stringify({
    outcome: "drift",
    steps: [],
    drift: { step: null, ref: "page", reason: "binding_mismatch", evidence: { expected: ["shop.example.com"], actualHost: "other.example.com" } }
  })}`;
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => ({ content: [{ type: "text", text: marker }] }),
    shutdown: () => {}
  });
  const tool = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run }).find((t) => t.name === "shortcuts_execute");
  await tool.handler({ tabId: 4, shortcutId: "wf-prove-cart" });
  const drift = events.find((e) => e.type === "workflow_drift");
  assert(drift && drift.step === null && drift.reason === "binding_mismatch", `a pre-flight mismatch records drift without inventing a step: ${JSON.stringify(drift)}`);
  assert(/actualHost/.test(drift.evidence), "the evidence is preserved for the repair flow");
});

await test("marker parsing: versioned, bounded, and never invented", () => {
  assert(proof.parseWorkflowResultMarker("no marker here") === null, "prose is not a marker");
  assert(proof.parseWorkflowResultMarker("OCIC_WORKFLOW_RESULT {not json") === null, "malformed json yields no outcome");
  assert(proof.parseWorkflowResultMarker('OCIC_WORKFLOW_RESULT {"outcome":"teleported"}') === null, "an unknown outcome is not an outcome");
  const marker = proof.parseWorkflowResultMarker(
    'prefix\nOCIC_WORKFLOW_RESULT {"outcome":"drift","steps":[{"index":0}],"drift":{"step":0,"ref":"navigate","reason":"binding_mismatch","evidence":"host changed"}}\n'
  );
  assert(marker && marker.outcome === "drift" && marker.drift.reason === "binding_mismatch", "a well-formed drift marker parses");
  const ok = proof.parseWorkflowResultMarker('OCIC_WORKFLOW_RESULT {"outcome":"ok","steps":[{"index":0,"status":"ok","url":"https://x.test/","fetchedAt":"2026-01-01T00:00:00Z"}]}');
  assert(ok && ok.outcome === "ok" && ok.drift === null && ok.steps[0].url === "https://x.test/", "an ok marker carries freshness evidence and no drift");
  const nullStep = proof.parseWorkflowResultMarker(
    'OCIC_WORKFLOW_RESULT {"outcome":"drift","steps":[],"drift":{"step":null,"ref":"page","reason":"binding_mismatch","evidence":"host changed"}}'
  );
  assert(nullStep && nullStep.drift.step === null, "a binding mismatch that stopped before any step parses with a null step");
  const stringStep = proof.parseWorkflowResultMarker(
    'OCIC_WORKFLOW_RESULT {"outcome":"drift","steps":[],"drift":{"step":"1","ref":"find","reason":"target_no_longer_resolves"}}'
  );
  assert(stringStep && stringStep.drift === null, "a malformed step index is not a drift claim this host records");
  assert(proof.readWorkflowDrift({ toolName: "read_page", args: {}, resultText: "x" }) === null, "only shortcuts_execute is read");
  assert(proof.readWorkflowDrift({ toolName: "shortcuts_execute", args: {}, resultText: "x" }) === null, "a targetless invocation has no workflow id");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

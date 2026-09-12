#!/usr/bin/env node
//
// add-browser-batch-tool: the send/submit-class gate must see INSIDE a batch.
//
// A batch is one SDK tool call. These tests prove that batching cannot become
// a route around the gate that a standalone call goes through:
//   - a batch containing a click on a submit control is rejected whole,
//     before anything executes;
//   - a batch containing a submit-activating key with no resolvable target is
//     rejected whole;
//   - a batch of non-send-class items is accepted;
//   - a nested batch is rejected;
//   - a batch never gets a panel approval card, and no approval/grant issued
//     for anything else authorizes a send-class item inside a batch.
//
// The resolver is exercised too: the per-item target hint the gate resolves
// is what lets a ref click be allowed, and without it the same batch is
// rejected — the same evidence pipeline a standalone call uses.
//
// Run: node test/browser-batch-policy.test.mjs

import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { createCanUseTool, RequestIdTracker } from "../host/agent/policy/can-use-tool.js";
import {
  classifyBrowserBatch,
  normalizeApprovalArgs,
  fingerprintNormalizedArgs
} from "../host/agent/tools/mapping.js";
import { buildSdkTools } from "../host/agent/tools/adapter.js";
import { Run } from "../host/agent/session/run.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";

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

console.log("\nadd-browser-batch-tool — batch send/submit gate\n");

function makeRun({ tabScope = [42], ttlMs = 5000 } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry({ defaultTtlMs: ttlMs });
  return new Run({ conversationId: "conv_batch_policy", lease, approvals, tabScope });
}
async function begunRun(opts) {
  const run = makeRun(opts);
  await run.begin();
  return run;
}

const SUBMIT_CLICK = { name: "computer", input: { action: "left_click", coordinate: [10, 10], description: "submit the form", tabId: 42 } };
const SUBMIT_KEY_HINTLESS = { name: "computer", input: { action: "key", text: "Enter", tabId: 42 } };
const CLEAN_BATCH = [
  { name: "computer", input: { action: "screenshot", tabId: 42 } },
  { name: "form_input", input: { ref: "ref_1", value: "hello", tabId: 42 } }
];

// --- the classifier --------------------------------------------------------

await test("classifyBrowserBatch(): a submit-click item rejects the whole batch and names its 1-based position and tool", () => {
  const batch = classifyBrowserBatch([{ name: "computer", input: { action: "screenshot" } }, SUBMIT_CLICK]);
  assert(batch.ok === false, "a batch containing a submit click must not be ok");
  assert(batch.itemNumber === 2, `the offending item is the 2nd (1-based), got ${batch.itemNumber}`);
  assert(batch.toolName === "computer", `the offending tool must be named, got ${batch.toolName}`);
  assert(/must be issued on its own call/i.test(batch.reason), `the reason must say it needs its own call: ${batch.reason}`);
});

await test("classifyBrowserBatch(): a hintless submit-activating key rejects the whole batch", () => {
  const batch = classifyBrowserBatch([SUBMIT_KEY_HINTLESS]);
  assert(batch.ok === false, "a hintless Enter item must not be ok");
  assert(batch.itemNumber === 1, `position must be 1-based, got ${batch.itemNumber}`);
  assert(/key/i.test(batch.reason), `the reason must identify the key call: ${batch.reason}`);
});

await test("classifyBrowserBatch(): a batch of non-send-class items is accepted, in order", () => {
  const batch = classifyBrowserBatch(CLEAN_BATCH);
  assert(batch.ok === true, `a clean batch must be ok: ${JSON.stringify(batch)}`);
  assert(batch.items.length === 2, "both items are returned");
  assert(batch.items[0].legacyName === "computer" && batch.items[1].legacyName === "form_input", "items keep their order and resolved legacy names");
});

await test("classifyBrowserBatch(): a nested batch is rejected", () => {
  const batch = classifyBrowserBatch([{ name: "browser_batch", input: { actions: CLEAN_BATCH } }]);
  assert(batch.ok === false, "a nested batch must be rejected");
  assert(/cannot contain another batch/i.test(batch.reason), `reason must say nesting is rejected: ${batch.reason}`);
});

await test("classifyBrowserBatch(): classify:false validates structure/nesting only (used when the gate already classified with more evidence)", () => {
  const structural = classifyBrowserBatch([SUBMIT_CLICK], [], { classify: false });
  assert(structural.ok === true, "with classification skipped, a structurally-valid item is accepted");
  const nested = classifyBrowserBatch([{ name: "browser_batch", input: {} }], [], { classify: false });
  assert(nested.ok === false, "nesting is still rejected when classification is skipped");
});

// --- canUseTool: the gate itself -------------------------------------------

await test("gate: a batch containing a submit control is denied whole — no card, no pending decision, nothing runs", async () => {
  const run = await begunRun();
  const events = [];
  run._onEvent = (e) => events.push(e);
  const tracker = new RequestIdTracker();
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });

  const result = await canUseTool({
    toolName: "mcp__browzy-in-chrome-browser__browser_batch",
    toolUseID: "req_batch_submit",
    input: { actions: [{ name: "computer", input: { action: "screenshot", tabId: 42 } }, SUBMIT_CLICK] }
  });

  assert(result.behavior === "deny", `the whole batch must be denied, got ${JSON.stringify(result)}`);
  assert(/item 2/i.test(result.message), `the denial must name the offending item: ${result.message}`);
  assert(tracker.size() === 0, "a batch must never register a pending approval decision");
  assert(!events.some((e) => e.type === "approval_request"), "a batch must never emit an approval_request card");
});

await test("gate: a batch containing a hintless submit-activating key is denied whole", async () => {
  const run = await begunRun();
  const tracker = new RequestIdTracker();
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });
  const result = await canUseTool({
    toolName: "browser_batch",
    toolUseID: "req_batch_key",
    input: { actions: [SUBMIT_KEY_HINTLESS] }
  });
  assert(result.behavior === "deny", `got ${JSON.stringify(result)}`);
  assert(tracker.size() === 0, "no pending decision is registered for a rejected batch");
});

await test("gate: a clean batch is allowed with no approval card", async () => {
  const run = await begunRun();
  const events = [];
  run._onEvent = (e) => events.push(e);
  const tracker = new RequestIdTracker();
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });
  const result = await canUseTool({
    toolName: "browser_batch",
    toolUseID: "req_batch_clean",
    input: { actions: CLEAN_BATCH }
  });
  assert(result.behavior === "allow", `a clean batch must be allowed, got ${JSON.stringify(result)}`);
  assert(tracker.size() === 0, "an allowed batch must not request an approval");
  assert(!events.some((e) => e.type === "approval_request"), "an allowed batch must not emit an approval card");
});

await test("gate: the per-item resolved hint is what lets a ref click through; without it the same batch is denied", async () => {
  const batchInput = {
    actions: [{ name: "computer", input: { action: "left_click", ref: "ref_1", coordinate: [8, 8], tabId: 42 } }]
  };

  // With a bridge that resolves the ref to an ordinary link, the batch is a
  // plain navigation click and is allowed.
  const runHinted = await begunRun();
  const trackerHinted = new RequestIdTracker();
  const canUseToolHinted = createCanUseTool({
    run: runHinted,
    approvals: runHinted.approvals,
    requestIdTracker: trackerHinted,
    resolveHint: async (toolName, args) => {
      if (toolName === "computer" && args && args.ref === "ref_1") {
        return { accessibleName: "Watch video", tagName: "a", attributes: { href: "/watch" } };
      }
      return null;
    }
  });
  const hinted = await canUseToolHinted({ toolName: "browser_batch", toolUseID: "req_hint", input: { actions: [...batchInput.actions] } });
  assert(hinted.behavior === "allow", `a resolved non-submit ref must let the batch through, got ${JSON.stringify(hinted)}`);

  // With no bridge (or a bridge that cannot resolve it), the same ref click is
  // approve-unknown, so the batch is denied.
  const runHintless = await begunRun();
  const trackerHintless = new RequestIdTracker();
  const canUseToolHintless = createCanUseTool({ run: runHintless, approvals: runHintless.approvals, requestIdTracker: trackerHintless });
  const hintless = await canUseToolHintless({ toolName: "browser_batch", toolUseID: "req_nohint", input: { actions: [...batchInput.actions] } });
  assert(hintless.behavior === "deny", `an unresolved-ref click must deny the batch, got ${JSON.stringify(hintless)}`);
});

// --- handler-side: a batch never inherits someone else's authorization -----

await test("no batch approval authorizes a send-class item: a send-class grant cannot make a bypassed batch dispatch it", async () => {
  const run = await begunRun();
  // Mint exactly the kind of single-use grant an approved STANDALONE submit
  // click would receive...
  run.recordApprovalGrant(fingerprintNormalizedArgs(normalizeApprovalArgs("computer", SUBMIT_CLICK.input)), { requestId: "standalone-submit" });

  let dispatched = null;
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => { dispatched = name; return { content: [{ type: "text", text: "should never run" }] }; },
    shutdown: () => {}
  });
  const handlers = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const batchHandler = handlers.find((h) => h.name === "browser_batch");

  // ...and invoke the batch handler directly, WITHOUT passing canUseTool (the
  // bypass case). The batch's own hintless pre-flight must refuse the
  // send-class item, so the standalone grant is never consulted and nothing
  // dispatches.
  const result = await batchHandler.handler({ actions: [SUBMIT_CLICK] });
  assert(result.isError === true, `a bypassed batch containing a submit must be refused, got ${JSON.stringify(result)}`);
  assert(/item 1/i.test(result.content[0].text), `the refusal must name the item: ${result.content[0].text}`);
  assert(dispatched === null, "the executor must never be reached for a refused batch");
});

await test("clean batch through the real adapter: the gate's verdict is honoured and the batch dispatches exactly once", async () => {
  const run = await begunRun();
  const tracker = new RequestIdTracker();
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });
  const actions = [...CLEAN_BATCH];
  const gate = await canUseTool({ toolName: "browser_batch", toolUseID: "req_clean_dispatch", input: { actions } });
  assert(gate.behavior === "allow", "clean batch must be allowed by the gate");

  const calls = [];
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: "ok" }] }; },
    shutdown: () => {}
  });
  const handlers = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const batchHandler = handlers.find((h) => h.name === "browser_batch");
  const result = await batchHandler.handler({ actions });
  assert(!result.isError, `a clean batch must dispatch, got ${JSON.stringify(result)}`);
  assert(calls.length === 1 && calls[0].name === "browser_batch", "the batch dispatches to the executor once, as one call");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
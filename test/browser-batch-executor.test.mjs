#!/usr/bin/env node
//
// add-browser-batch-tool: the batch executor in extension/background.js.
//
// Exercises the SHIPPED browser_batch handler (and the shipped
// sampleBatchTabState helper) by extracting them from background.js with
// test/_extract.mjs, so this is the real implementation, not a paraphrase.
//
//   - items run in order, through the existing per-tool handlers;
//   - an erroring item stops the rest;
//   - a URL change stops the rest;
//   - a focus change stops the rest;
//   - an undisturbed batch runs to completion;
//   - a stopped batch reports the stopping item, the reason, and the results
//     of the items that did run;
//   - a stale ref's EXISTING error text trips stop-on-error (no new
//     ref-validation code);
//   - sampleBatchTabState is background-only and best-effort.
//
// Run: node test/browser-batch-executor.test.mjs

import { extractMethod, extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

console.log("\nbrowser_batch executor\n");

// --- extraction ------------------------------------------------------------

function buildBatch({ toolHandlers, sampleBatchTabState }) {
  const src = [
    extractFunction("batchItemResultFailed"),
    extractFunction("batchStopReasonText"),
    extractFunction("formatBatchResult"),
    `const H = { ${extractMethod("browser_batch")} };`
  ].join("\n\n");
  return compile(src, { toolHandlers, sampleBatchTabState }, "({ browser_batch: H.browser_batch, batchItemResultFailed })");
}

function buildState({ chrome, cdp }) {
  const src = extractFunction("sampleBatchTabState");
  return compile(src, { chrome, cdp }, "({ sampleBatchTabState })");
}

function makeHandlers(map) {
  const calls = [];
  const toolHandlers = {};
  for (const [name, fn] of Object.entries(map)) {
    toolHandlers[name] = async (args) => { calls.push({ name, args }); return fn(args); };
  }
  return { toolHandlers, calls };
}

function scriptedSampler(states) {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)];
}

const text = (result) => result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
const okText = (t) => ({ content: [{ type: "text", text: t }] });

const CONST_STATE = { url: "https://example.com/", focus: "INPUT|email" };

// --- ordering / completion -------------------------------------------------

{
  const { toolHandlers, calls } = makeHandlers({
    computer: () => okText("Successfully captured screenshot"),
    form_input: () => okText('Set ref_1 to "hello"')
  });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({
    actions: [
      { name: "computer", input: { action: "screenshot", tabId: 1 } },
      { name: "form_input", input: { ref: "ref_1", value: "hello", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 2, "every item dispatched exactly once");
  ok(calls[0].name === "computer" && calls[1].name === "form_input", "items dispatch in the given order");
  ok(calls[0].args.action === "screenshot" && calls[1].args.value === "hello", "each item's own input is passed through unchanged");
  ok(/completed: all 2 item\(s\) ran/i.test(t), `undisturbed batch reports completion: ${t.split("\n")[0]}`);
  ok(t.includes("--- item 0 (computer) ---") && t.includes("--- item 1 (form_input) ---"), "every item's real result is returned, labelled and in order");
  ok(t.includes("Successfully captured screenshot") && t.includes('Set ref_1 to "hello"'), "the items' actual result text is carried through");
}

// --- error stops the rest --------------------------------------------------

{
  const { toolHandlers, calls } = makeHandlers({
    computer: () => okText("Error: element is detached"),
    form_input: () => okText("should not run")
  });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({
    actions: [
      { name: "computer", input: { action: "left_click", ref: "ref_1", tabId: 1 } },
      { name: "form_input", input: { ref: "ref_1", value: "x", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 1 && calls[0].name === "computer", "the item after an erroring item does not run");
  ok(/stopped after item 1 \(computer\)/i.test(t), `the response names the stopping item: ${t.split("\n")[0]}`);
  ok(/returned an error/i.test(t), "the response names the error condition");
  ok(t.includes("Error: element is detached"), "the earlier item's real (erroring) result is still returned");
}

// --- a thrown handler is an error too --------------------------------------

{
  const { toolHandlers, calls } = makeHandlers({
    computer: () => { throw new Error("boom"); },
    form_input: () => okText("should not run")
  });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({
    actions: [
      { name: "computer", input: { action: "left_click", tabId: 1 } },
      { name: "form_input", input: { ref: "ref_1", value: "x", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 1, "a throwing handler stops the batch");
  ok(/stopped after item 1 \(computer\)/i.test(t) && /returned an error/i.test(t), "a thrown error is reported as a stop");
}

// --- stale ref: the EXISTING error text trips stop-on-error ----------------

{
  const staleText =
    'Ref "ref_1" no longer exists on the page — the element was removed since it was found. ' +
    "This happens to items inside a dropdown or popup once it closes.";
  const { toolHandlers, calls } = makeHandlers({
    computer: () => okText(staleText),
    form_input: () => okText("should not run")
  });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({
    actions: [
      { name: "computer", input: { action: "left_click", ref: "ref_1", tabId: 1 } },
      { name: "form_input", input: { ref: "ref_1", value: "x", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 1, "the existing stale-ref error stops the batch — no new ref-validation code needed");
  ok(/stopped after item 1 \(computer\)/i.test(t), "the stale-ref stop is reported");
  ok(t.includes("no longer exists on the page"), "the existing error text is surfaced to the caller");
}

// --- URL change stops the rest ---------------------------------------------

{
  const { toolHandlers, calls } = makeHandlers({
    computer: () => okText("Clicked at (1,1)"),
    find: () => okText("found things")
  });
  const built = buildBatch({
    toolHandlers,
    sampleBatchTabState: scriptedSampler([
      { url: "https://example.com/form", focus: null },
      { url: "https://example.com/done", focus: null }
    ])
  });
  const result = await built.browser_batch({
    actions: [
      { name: "computer", input: { action: "left_click", coordinate: [1, 1], tabId: 1 } },
      { name: "find", input: { query: "x", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 1 && calls[0].name === "computer", "a URL change stops later items");
  ok(/stopped after item 1 \(computer\)/i.test(t), "the stopping item is named");
  ok(/URL changed/i.test(t), `the URL condition is named: ${t.split("\n")[0]}`);
}

// --- focus change stops the rest -------------------------------------------

{
  const { toolHandlers, calls } = makeHandlers({
    computer: () => okText("typed"),
    form_input: () => okText("should not run")
  });
  const built = buildBatch({
    toolHandlers,
    sampleBatchTabState: scriptedSampler([
      { url: "https://example.com/", focus: "INPUT|email" },
      { url: "https://example.com/", focus: "INPUT|password" }
    ])
  });
  const result = await built.browser_batch({
    actions: [
      { name: "computer", input: { action: "type", text: "a", tabId: 1 } },
      { name: "form_input", input: { ref: "ref_2", value: "x", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 1 && calls[0].name === "computer", "a focus change stops later items");
  ok(/stopped after item 1 \(computer\)/i.test(t), "the stopping item is named");
  ok(/focused element changed/i.test(t), `the focus condition is named: ${t.split("\n")[0]}`);
}

// --- unknown tool / empty batch --------------------------------------------

{
  const { toolHandlers, calls } = makeHandlers({ computer: () => okText("ok") });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({
    actions: [
      { name: "not_a_tool", input: {} },
      { name: "computer", input: { action: "screenshot", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 0, "an unknown item does not run, and the following item does not run either");
  ok(/unknown tool/i.test(t) && /stopped after item 1/i.test(t), `an unknown tool stops the batch: ${t.split("\n")[0]}`);
}

{
  const { toolHandlers, calls } = makeHandlers({ computer: () => okText("ok") });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({
    actions: [
      { name: "browser_batch", input: { actions: [{ name: "computer", input: { action: "screenshot" } }] } },
      { name: "computer", input: { action: "screenshot", tabId: 1 } }
    ]
  });
  const t = text(result);
  ok(calls.length === 0, "a nested batch never recurses and the following item does not run");
  ok(/cannot contain another browser_batch/i.test(t) && /stopped after item 1/i.test(t), `a nested batch is a fail-closed stop: ${t.split("\n")[0]}`);
}

{
  const { toolHandlers } = makeHandlers({ computer: () => okText("ok") });
  const built = buildBatch({ toolHandlers, sampleBatchTabState: scriptedSampler([CONST_STATE]) });
  const result = await built.browser_batch({ actions: [] });
  ok(result.isError === true, "an empty batch is a fail-closed error, never a silent success");
}

// --- the SHIPPED sampleBatchTabState ---------------------------------------

{
  const cdpCalls = [];
  const chrome = { tabs: { get: async (id) => ({ id, url: "https://example.com/page" }) } };
  const cdp = async (tabId, method, params) => {
    cdpCalls.push({ tabId, method, params });
    return { result: { value: "INPUT|email|user|text|Email|you@example.com" } };
  };
  const built = buildState({ chrome, cdp });
  const state = await built.sampleBatchTabState(7);
  ok(state.url === "https://example.com/page", "sampleBatchTabState reports the tab URL via chrome.tabs.get");
  ok(state.focus === "INPUT|email|user|text|Email|you@example.com", "sampleBatchTabState reports the focus descriptor");
  ok(cdpCalls.length === 1 && cdpCalls[0].method === "Runtime.evaluate", "focus sampling is one background-only Runtime.evaluate");
  ok(cdpCalls[0].params.returnByValue === true, "the focus probe returns by value");
  ok(String(cdpCalls[0].params.expression).includes("document.activeElement"), "the probe reads the page's activeElement, not content-script state");
}

{
  const chrome = { tabs: { get: async () => { throw new Error("no tab"); } } };
  const cdp = async () => { throw new Error("detached"); };
  const built = buildState({ chrome, cdp });
  const state = await built.sampleBatchTabState(7);
  ok(state.url === null && state.focus === null, "an unqueryable tab yields nulls (best-effort; equal nulls do not stop a batch)");
}

{
  const chrome = { tabs: { get: async () => { throw new Error("should not be called"); } } };
  const cdp = async () => { throw new Error("should not be called"); };
  const built = buildState({ chrome, cdp });
  const state = await built.sampleBatchTabState(undefined);
  ok(state.url === null && state.focus === null, "a non-numeric tab id is not sampled at all");
}

console.log(fail === 0 ? "\nALL BROWSER_BATCH EXECUTOR TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
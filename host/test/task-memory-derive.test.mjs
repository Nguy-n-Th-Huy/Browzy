#!/usr/bin/env node
//
// Deriving a task memory from a completed run
// (openspec/changes/add-task-memory tasks.md 2.1-2.2).
//
// Pins: only a clean `run_done` derives (run_error — which finishRun() also
// follows with run_done — run_stopped, a Jev non-done end and drift derive
// nothing); both the SDK transcript trail and a Jev step trail derive;
// bookkeeping tools are dropped; credential-shaped keys, opaque values and
// typed text never reach the record; element identity is frozen as
// role/name; no tool RESULT or assistant text appears in the record; the
// privacy control pauses writing; the record passes the store's own schema.
//
// Run: node host/test/task-memory-derive.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-task-memory-derive-"));
process.env.OCIC_AGENT_HOME = scratch;

const { deriveTaskMemory, runSucceeded, MEMORY_EXCLUDED_TOOL_REFS } = await import("../agent/memory/derive.js");
const { validateMemoryRecord } = await import("../agent/memory/store.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const RUN_ID = "run_mem_1";
const CONV = "conv_mem";
const PAGE_TEXT = "RESULT-ONLY page text that must never be remembered";
const ANSWER = "ASSISTANT-ONLY reply text that must never be remembered";

function toolUse(id, name, input) {
  return { type: "tool_use", id, name: `mcp__browzy-in-chrome-browser__${name}`, input };
}

/** An SDK run on dauthau.asia: list tabs, find, click (identity from the
 *  find result), fill a field, read, answer. */
function sdkTrail({ terminal = ["run_done"], extra = [] } = {}) {
  const events = [];
  let seq = 0;
  const push = (event) => events.push({ seq: (seq += 1), runId: RUN_ID, conversationId: CONV, ...event });
  push({ type: "run_created", ts: 1_000 });
  const assistant = (blocks) => push({ type: "stream_message", message: { type: "assistant", message: { content: blocks } } });
  const result = (id, text, isError = false) =>
    push({
      type: "stream_message",
      message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } }
    });
  assistant([toolUse("t1", "tabs_context_mcp", {})]);
  result("t1", '{"availableTabs":[{"tabId":7,"title":"Thông báo mời thầu","url":"https://dauthau.asia/thongbao/moithau/"}]}');
  assistant([toolUse("t2", "update_plan", { plan: "bookkeeping" })]);
  assistant([toolUse("t3", "find", { query: "nút tìm kiếm", tabId: 7 })]);
  result("t3", '[ref_12] button "Tìm kiếm"\n[ref_13] textbox "Mật khẩu"');
  assistant([toolUse("t4", "computer", { action: "left_click", ref: "ref_12", tabId: 7 })]);
  result("t4", "Clicked.");
  assistant([toolUse("t5", "form_input", { ref: "ref_13", value: "hunter2-typed-value", tabId: 7 })]);
  assistant([toolUse("t6", "computer", { action: "type", text: "Hải Phòng typed text", tabId: 7 })]);
  assistant([toolUse("t7", "form_input", { ref: "ref_20", password: "p4ss", tabId: 7 })]);
  assistant([toolUse("t8", "get_page_text", { tabId: 7 })]);
  result("t8", PAGE_TEXT);
  assistant([toolUse("t9", "ask_user", { question: "Which one?" })]);
  assistant([{ type: "text", text: ANSWER }]);
  for (const event of extra) push(event);
  for (const type of terminal) push({ type, ts: 20_000 });
  return events;
}

function derive(events, overrides = {}) {
  return deriveTaskMemory({
    conversationEvents: events,
    conversationId: CONV,
    runId: RUN_ID,
    request: "phân tích TBMT có nơi thực hiện tại Hải Phòng giúp mình",
    boundHost: "dauthau.asia",
    now: () => 99_999,
    ...overrides
  });
}

console.log("\n== what counts as a completed run ==");

await test("a clean run_done derives a memory that passes the store schema", () => {
  const out = derive(sdkTrail());
  assert(out.ok, JSON.stringify(out));
  validateMemoryRecord(out.memory);
  assert(out.memory.host === "dauthau.asia");
  assert(out.memory.outcome.durationMs === 19_000, `duration from run_created→run_done: ${out.memory.outcome.durationMs}`);
  assert(out.memory.provenance.conversationId === CONV && out.memory.provenance.runId === RUN_ID);
  assert(out.memory.stats.state === "fresh" && out.memory.stats.useCount === 0);
});

await test("run_error followed by finishRun()'s run_done derives nothing", () => {
  const out = derive(sdkTrail({ terminal: ["run_error", "run_done"] }));
  assert(!out.ok && out.reason === "run_error", JSON.stringify(out));
});

await test("run_stopped derives nothing", () => {
  const out = derive(sdkTrail({ terminal: ["run_stopped"] }));
  assert(!out.ok && out.reason === "run_stopped", JSON.stringify(out));
});

await test("a Jev subgoal that ended blocked derives nothing", () => {
  const out = derive(sdkTrail({ extra: [{ type: "jev_end", outcome: "blocked", reason: "decision_budget" }] }));
  assert(!out.ok && out.reason === "jev_blocked", JSON.stringify(out));
});

await test("a workflow drift outcome derives nothing", () => {
  const out = derive(sdkTrail({ extra: [{ type: "workflow_drift" }] }));
  assert(!out.ok && out.reason === "drift", JSON.stringify(out));
});

await test("an unfinished run derives nothing", () => {
  const events = sdkTrail({ terminal: [] });
  assert(!runSucceeded({ conversationEvents: events, runId: RUN_ID }).ok);
  assert(!derive(events).ok);
});

await test("a chat-only run (no tool calls) derives nothing", () => {
  const events = [
    { seq: 1, type: "run_created", runId: RUN_ID },
    { seq: 2, type: "stream_message", runId: RUN_ID, message: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } } },
    { seq: 3, type: "run_done", runId: RUN_ID }
  ];
  const out = derive(events);
  assert(!out.ok, JSON.stringify(out));
});

console.log("\n== what the record keeps ==");

await test("steps follow the dispatched order and drop bookkeeping and conversation tools", () => {
  const { memory } = derive(sdkTrail());
  const tools = memory.steps.map((step) => step.tool);
  assert(JSON.stringify(tools) === JSON.stringify(["tabs_context_mcp", "find", "computer", "form_input", "computer", "form_input", "get_page_text"]), tools.join(","));
  assert(!tools.includes("update_plan") && !tools.includes("ask_user"));
  assert(MEMORY_EXCLUDED_TOOL_REFS.includes("task_memory"), "the memory tool never remembers itself");
  memory.steps.forEach((step, index) => assert(step.index === index + 1, "indices are 1-based and contiguous"));
});

await test("the starting page is the run's own first tab listing", () => {
  const { memory } = derive(sdkTrail());
  assert(memory.startUrl === "https://dauthau.asia/thongbao/moithau/", memory.startUrl);
});

await test("a clicked ref is frozen as its role/name identity and the dead handle is dropped", () => {
  const { memory } = derive(sdkTrail());
  const click = memory.steps[2];
  assert(click.tool === "computer" && click.action === "left_click");
  assert(click.target && click.target.role === "button" && click.target.name === "Tìm kiếm", JSON.stringify(click));
  assert(!("ref" in click.args) && !("tabId" in click.args), JSON.stringify(click.args));
});

await test("typed values are never stored, and the step says a value was typed", () => {
  const { memory } = derive(sdkTrail());
  const serialized = JSON.stringify(memory);
  assert(!serialized.includes("hunter2-typed-value"), "form_input value leaked");
  assert(!serialized.includes("Hải Phòng typed text"), "computer type text leaked");
  assert(memory.steps[3].valueOmitted === true && memory.steps[4].valueOmitted === true, JSON.stringify(memory.steps.slice(3, 5)));
});

await test("a credential-shaped control name is not kept as an identity", () => {
  const { memory } = derive(sdkTrail());
  assert(!memory.steps[3].target, `the "Mật khẩu" field identity must not be kept: ${JSON.stringify(memory.steps[3])}`);
});

await test("a credential-shaped argument key makes that step omitted, naming the key and not the value", () => {
  const { memory } = derive(sdkTrail());
  const step = memory.steps[5];
  assert(step.omitted === true && /args\.password/.test(step.reason), JSON.stringify(step));
  assert(!JSON.stringify(memory).includes("p4ss"));
});

await test("no tool result and no assistant text reaches the record", () => {
  const serialized = JSON.stringify(derive(sdkTrail()).memory);
  assert(!serialized.includes(PAGE_TEXT), "page text leaked");
  assert(!serialized.includes(ANSWER), "assistant text leaked");
  assert(!serialized.includes("Clicked."), "a click result leaked");
});

await test("the intent is the operator's request, summarized and tokenized", () => {
  const { memory } = derive(sdkTrail());
  assert(memory.intent.text === "phân tích TBMT có nơi thực hiện tại Hải Phòng giúp mình", memory.intent.text);
  for (const token of ["phân", "tích", "tbmt", "hải", "phòng"]) assert(memory.intent.tokens.includes(token), `missing ${token}`);
  assert(!memory.intent.tokens.includes("giúp") && !memory.intent.tokens.includes("mình"), "politeness is not intent");
});

await test("the privacy control pauses writing entirely", () => {
  const out = derive(sdkTrail(), { privacy: { rawPromptCaching: false } });
  assert(!out.ok && out.reason === "privacy_paused", JSON.stringify(out));
  assert(derive(sdkTrail(), { privacy: { rawPromptCaching: true } }).ok);
});

await test("the site falls back to the recorded start page when no bound host was given", () => {
  const out = derive(sdkTrail(), { boundHost: null });
  assert(out.ok && out.memory.host === "dauthau.asia", JSON.stringify(out));
});

console.log("\n== a Jev step trail ==");

await test("a Jev-only trail derives, with the click identity from the step's own target", () => {
  const events = [
    { type: "run_created", runId: RUN_ID, ts: 0 },
    {
      type: "jev_step", runId: RUN_ID, step: 1, operation: "CLICK", tool: "computer",
      argsSummary: { action: "left_click", ref: "ref_1", tabId: 7 },
      target: { index: "1", label: "Đơn hàng", role: "link" },
      observed: { url: "https://shop.example.com/", elements: 3, sample: ["Page output must not be saved"] }
    },
    {
      type: "jev_step", runId: RUN_ID, step: 2, operation: "TYPE_TEXT", tool: "form_input",
      argsSummary: { ref: "ref_2" }, target: { index: "2", label: "Tìm" },
      observed: { url: "https://shop.example.com/orders" }
    },
    { type: "jev_end", runId: RUN_ID, outcome: "done" },
    { type: "run_done", runId: RUN_ID, ts: 5_000 }
  ].map((event, index) => ({ ...event, seq: index + 1 }));
  const out = derive(events, { boundHost: "shop.example.com" });
  assert(out.ok, JSON.stringify(out));
  const [click, typed] = out.memory.steps;
  assert(click.target?.name === "Đơn hàng", JSON.stringify(click));
  assert(typed.omitted === true && /TYPE_TEXT/.test(typed.reason), JSON.stringify(typed));
  assert(out.memory.startUrl === "https://shop.example.com/", out.memory.startUrl);
  assert(!JSON.stringify(out.memory).includes("Page output must not be saved"));
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} TASK MEMORY DERIVE TESTS PASSED`);
process.exit(failed.length ? 1 : 0);

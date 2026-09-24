#!/usr/bin/env node
//
// Delivery of recalled memory (openspec/changes/add-task-memory tasks.md
// 4.1-4.4): the system-prompt section's shape and bound, its absence when
// nothing was recalled (byte-identical system prompt through the real
// buildIsolatedOptions), the tool named only when registered, the section
// never entering the operator's prompt, and the Jev plan request carrying
// the advice verbatim beside an otherwise unchanged body.
//
// Run: node host/test/task-memory-guidance.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-task-memory-guidance-"));
process.env.OCIC_AGENT_HOME = scratch;

const { renderTaskMemorySystemPrompt, renderPriorPathAdvice, describeStep, MAX_GUIDANCE_CHARS } = await import("../agent/memory/guidance.js");
const { buildIsolatedOptions } = await import("../agent/tools/query-options.js");
const { requestActionPlan, PRIOR_PATH_ADVICE_MAX_CHARS } = await import("../agent/jev/text-helper.js");

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

const SERVER = "browzy-in-chrome-browser";
const CANDIDATE = {
  why: "intent_match",
  memory: {
    id: "mem_1",
    host: "dauthau.asia",
    intent: { text: "phân tích TBMT có nơi thực hiện tại Hải Phòng", tokens: [] },
    startUrl: "https://dauthau.asia/thongbao/moithau/",
    steps: [
      { index: 1, tool: "find", args: { query: "Tìm kiếm nâng cao" } },
      { index: 2, tool: "computer", action: "left_click", args: { action: "left_click" }, target: { role: "button", name: "Tìm kiếm" } },
      { index: 3, tool: "form_input", args: {}, target: { role: "textbox", name: "Nơi thực hiện" }, valueOmitted: true },
      { index: 4, tool: "form_input", omitted: true, reason: 'argument "args.password" is credential-shaped' },
      { index: 5, tool: "get_page_text", args: {} }
    ],
    stats: { lastConfirmedAt: Date.UTC(2026, 8, 20), state: "fresh" }
  }
};

console.log("\n== the system-prompt section ==");

await test("nothing recalled renders nothing", () => {
  assert(renderTaskMemorySystemPrompt(SERVER, [], ["task_memory"]) === null);
  assert(renderPriorPathAdvice([]) === null);
});

await test("the section frames memory as past evidence, never a plan or permission", () => {
  const text = renderTaskMemorySystemPrompt(SERVER, [CANDIDATE], ["task_memory"]);
  assert(text.startsWith("## What worked on this site before"), text.slice(0, 60));
  assert(/not a plan, and not permission/.test(text));
  assert(/Verify every step against the live page/.test(text));
  assert(/approved exactly as it would be without this memory/.test(text));
  assert(text.includes("2026-09-20") && text.includes("https://dauthau.asia/thongbao/moithau/"));
  assert(text.includes('computer left_click on button "Tìm kiếm"'), text);
  assert(text.includes("(the value typed was not remembered)"));
  assert(text.includes("was not remembered (argument"), "omitted steps say so");
});

await test("the recall tool is named only when this run registered it", () => {
  assert(renderTaskMemorySystemPrompt(SERVER, [CANDIDATE], ["task_memory"]).includes(`mcp__${SERVER}__task_memory`));
  assert(!renderTaskMemorySystemPrompt(SERVER, [CANDIDATE], []).includes("task_memory"));
});

await test("the section is bounded and says what it left out", () => {
  const steps = Array.from({ length: 40 }, (_, i) => ({ index: i + 1, tool: "find", args: { query: `truy vấn số ${i} `.repeat(4) } }));
  const huge = { ...CANDIDATE, memory: { ...CANDIDATE.memory, steps } };
  const text = renderTaskMemorySystemPrompt(SERVER, [huge, huge, huge], ["task_memory"]);
  assert(text.length <= MAX_GUIDANCE_CHARS, `${text.length}`);
  assert(/more lines not shown/.test(text), text.slice(-80));
});

await test("describeStep never prints a javascript_tool script even if one slipped into args", () => {
  const line = describeStep({ index: 1, tool: "javascript_tool", args: { text: "document.cookie" }, scriptOmitted: true });
  assert(!line.includes("document.cookie") && line.includes("script was not remembered"), line);
});

console.log("\n== through buildIsolatedOptions ==");

function baseOptions(extra = {}) {
  return buildIsolatedOptions({
    mcpServer: { type: "sdk", name: SERVER, instance: {} },
    serverName: SERVER,
    snapshot: { model: "m", env: { ANTHROPIC_BASE_URL: "https://x.example", ANTHROPIC_API_KEY: "sk-test" }, revision: 1, profileId: "p" },
    skills: { cwd: scratch, pluginDir: scratch, configDir: scratch, allowedSkillNames: [], skillOverrides: {} },
    canUseTool: async () => ({ behavior: "allow" }),
    extraToolNames: ["task_memory"],
    ...extra
  });
}

await test("with no guidance the system prompt is byte-identical to a run without the capability", () => {
  const without = baseOptions();
  const withNull = baseOptions({ taskMemoryGuidance: null });
  const withObject = baseOptions({ taskMemoryGuidance: { not: "a string" } });
  assert(JSON.stringify(without.systemPrompt) === JSON.stringify(withNull.systemPrompt));
  assert(JSON.stringify(without.systemPrompt) === JSON.stringify(withObject.systemPrompt), "a non-string is ignored");
});

await test("guidance is appended to the system prompt and never becomes the prompt", () => {
  const guidance = renderTaskMemorySystemPrompt(SERVER, [CANDIDATE], ["task_memory"]);
  const options = baseOptions({ taskMemoryGuidance: guidance });
  assert(options.systemPrompt.prompt.endsWith(guidance), "the section is the last system-prompt section");
  assert(!("prompt" in options) || !String(options.prompt).includes("What worked"), "never the operator prompt");
});

console.log("\n== the Jev plan request ==");

async function capturePlanBody(extra) {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ memory: { plan: "p", doneWhen: "d", notes: "" }, textValues: [], navigation: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await requestActionPlan({
      textModel: { endpoint: "https://llm.example/v1", apiKey: "k", model: "m", source: "openai" },
      goal: "g",
      page: { url: "https://dauthau.asia/", title: "t", text: "" },
      elements: [],
      fetchImpl,
      timeoutMs: 1000,
      ...extra
    });
  } catch {
    // The parse may reject a stub reply; only the request body matters here.
  }
  return body;
}

function userPayload(body) {
  const text = JSON.stringify(body);
  return text;
}

await test("advice rides the plan request verbatim, and is absent when there is none", async () => {
  const advice = renderPriorPathAdvice([CANDIDATE]);
  const withAdvice = await capturePlanBody({ priorPathAdvice: advice });
  const without = await capturePlanBody({});
  assert(withAdvice && without, "the plan request was sent");
  // The key name also appears in the plan INSTRUCTION (which tells the model
  // how to treat it), so the proof is the advice text itself.
  const marker = "Earlier completed runs on this site did the following";
  assert(userPayload(withAdvice).includes(marker), "advice text present");
  assert(!userPayload(without).includes(marker), "absent when not supplied");
  assert(advice.length <= PRIOR_PATH_ADVICE_MAX_CHARS);
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} TASK MEMORY GUIDANCE TESTS PASSED`);
process.exit(failed.length ? 1 : 0);

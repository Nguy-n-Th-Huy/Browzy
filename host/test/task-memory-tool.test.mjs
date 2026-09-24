#!/usr/bin/env node
//
// The `task_memory` tool (openspec/changes/add-task-memory tasks.md 5.1-5.2):
// both actions through the factory with a scratch store, the site pin, named
// non-throwing errors, and structural proof that the tool has no write path.
//
// Run: node host/test/task-memory-tool.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-task-memory-tool-"));
process.env.OCIC_AGENT_HOME = scratch;

const { createTaskMemoryTool, TASK_MEMORY_TOOL_NAME } = await import("../agent/tools/task-memory.js");
const { TaskMemoryStore } = await import("../agent/memory/store.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
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

function fakeToolFactory() {
  const captured = {};
  const factory = (name, description, paramShape, handler) => {
    Object.assign(captured, { name, description, paramShape, handler });
    return { name };
  };
  return { factory, captured };
}

const store = new TaskMemoryStore();
const stored = store.write({
  schemaVersion: 1,
  id: "mem_tool_1",
  host: "dauthau.asia",
  intent: { text: "phân tích TBMT Hải Phòng", tokens: ["phân", "tích", "tbmt", "hải", "phòng"] },
  startUrl: "https://dauthau.asia/",
  steps: [{ index: 1, tool: "find", args: { query: "Tìm kiếm" }, host: "dauthau.asia" }],
  outcome: { status: "completed", actionCount: 1, durationMs: 1000 },
  provenance: { conversationId: "conv_t", runId: "run_t", completedAt: 5, deriveVersion: 1 },
  stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: Date.UTC(2026, 8, 1), state: "fresh" }
}).memory;

async function build(host, candidates = []) {
  const { factory, captured } = fakeToolFactory();
  await createTaskMemoryTool({ run: { runId: "r" }, store, host, getCandidates: () => candidates, toolFactory: factory });
  return captured;
}

await test("registers under its constant name with recall/list only", async () => {
  const tool = await build("dauthau.asia");
  assert(tool.name === TASK_MEMORY_TOOL_NAME && TASK_MEMORY_TOOL_NAME === "task_memory");
  const actions = tool.paramShape.action.options;
  assert(JSON.stringify(actions) === JSON.stringify(["recall", "list"]), JSON.stringify(actions));
});

await test("recall returns the offered memories' full steps", async () => {
  const tool = await build("dauthau.asia", [{ memory: stored, why: "intent_match" }]);
  const out = await tool.handler({ action: "recall" });
  assert(!out.isError, JSON.stringify(out));
  const body = JSON.parse(out.content[0].text);
  assert(body.site === "dauthau.asia" && body.memories[0].id === "mem_tool_1");
  assert(body.memories[0].steps[0].includes('find query="Tìm kiếm"'), JSON.stringify(body));
});

await test("recall with nothing offered says so without error", async () => {
  const tool = await build("dauthau.asia", []);
  const out = await tool.handler({ action: "recall" });
  assert(!out.isError && /No memory was offered/.test(out.content[0].text));
});

await test("list returns this site's fresh summaries", async () => {
  const tool = await build("dauthau.asia");
  const out = await tool.handler({ action: "list" });
  const body = JSON.parse(out.content[0].text);
  assert(body.memories.length === 1 && body.memories[0].lastConfirmed === "2026-09-01", out.content[0].text);
});

await test("another site is refused with a named reason", async () => {
  const tool = await build("dauthau.asia");
  const out = await tool.handler({ action: "list", host: "muasamcong.mpi.gov.vn" });
  assert(out.isError && /other_site/.test(out.content[0].text), JSON.stringify(out));
});

await test("a run bound to no page gets a named, non-throwing error", async () => {
  const tool = await build(null);
  const out = await tool.handler({ action: "list" });
  assert(out.isError && /no_bound_site/.test(out.content[0].text));
});

await test("calling the tool never changes the store", async () => {
  const before = fs.readFileSync(store.listAll()[0].file, "utf8");
  const tool = await build("dauthau.asia", [{ memory: stored, why: "intent_match" }]);
  await tool.handler({ action: "recall" });
  await tool.handler({ action: "list" });
  assert(fs.readFileSync(store.listAll()[0].file, "utf8") === before);
});

await test("the tool module has no code path that writes to the store", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "agent", "tools", "task-memory.js"), "utf8");
  for (const writer of ["write(", "reinforce(", "markStale(", "forget(", "forgetHost(", "forgetAll(", "forgetByConversation("]) {
    assert(!source.includes(`store.${writer}`), `task-memory.js calls store.${writer}`);
  }
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} TASK MEMORY TOOL TESTS PASSED`);
process.exit(failed.length ? 1 : 0);

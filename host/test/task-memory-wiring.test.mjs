#!/usr/bin/env node
//
// Task memory wired through the REAL CompanionCore
// (openspec/changes/add-task-memory tasks.md 6.1-6.5), with an injected fake
// SDK and profile provider — no live model, browser or credential.
//
// Proves end to end:
//   - a completed run writes a memory; nothing is recalled on a first visit;
//   - a later run on the same site, in a NEW conversation, receives the
//     memory as system-prompt guidance (never in `prompt`), sees the recall
//     tool registered AND visible, and leaves one durable `memory_recalled`
//     event; its completion reinforces the memory instead of duplicating it;
//   - a run that errors after being offered a memory marks it stale;
//   - the switch off means no recall, no write, no tool;
//   - the privacy control means recall but no write;
//   - a malformed privacy field is refused before any run exists;
//   - deleting a conversation forgets the memories it produced;
//   - the settings-relay ops list/forget/get/set;
//   - no approval/policy module can read the memory store (import graph).
//
// Run: node host/test/task-memory-wiring.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-task-memory-wiring-"));
process.env.OCIC_AGENT_HOME = scratch;

const { CompanionCore } = await import("../agent/companion.js");
const { TranscriptStore } = await import("../agent/storage/transcript-store.js");
const { BrowserLease } = await import("../agent/broker/browser-lease.js");
const { ApprovalRegistry } = await import("../agent/policy/approvals.js");
const { SessionManager } = await import("../agent/session/manager.js");
const { ToolBridge } = await import("../agent/broker/tool-bridge.js");
const { AGENT_MESSAGE_TYPES, makeEnvelope } = await import("../agent/protocol.js");
const { TaskMemoryStore } = await import("../agent/memory/store.js");
const { SDK_MCP_SERVER_NAME } = await import("../agent/tools/adapter.js");

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

const QUALIFIED_TOOL = `mcp__${SDK_MCP_SERVER_NAME}__task_memory`;
const q = (name) => `mcp__${SDK_MCP_SERVER_NAME}__${name}`;

/** A fake SDK whose run finds and clicks the search button, then reads. */
function trailSdk({ fail = false } = {}) {
  const calls = [];
  const sdk = {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: q("find"), input: { query: "nút tìm kiếm" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '[ref_4] button "Tìm kiếm"' }] }] } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: q("computer"), input: { action: "left_click", ref: "ref_4" } }] } };
      if (fail) throw new Error("upstream exploded");
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: q("get_page_text"), input: {} }] } };
      yield { type: "assistant", message: { content: [{ type: "text", text: "Xong." }] } };
    }
  };
  return { sdk, calls };
}

function profileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return { model: modelId || "m", env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "k" }, revision: 1, profileId: profileId || "p" };
    }
  };
}

let settingsState = { enabled: true };
const memoryStore = new TaskMemoryStore();

function buildCore(sdk) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }), shutdown: () => {} });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk,
    profileProvider: profileProvider(),
    taskMemoryStore: memoryStore,
    taskMemorySettings: { load: () => ({ ...settingsState }), save: (next) => (settingsState = { ...next }) }
  });
}

async function waitFor(core, conversationId, predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = core.sessionManager.snapshotSince(conversationId, 0).events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for event");
}

/** Every tool name the run's options make visible to the model. */
function visibleTools(options) {
  return [...(Array.isArray(options.allowedTools) ? options.allowedTools : []), ...(Array.isArray(options.tools) ? options.tools : [])];
}

const settle = () => new Promise((r) => setTimeout(r, 60));

const CONTEXT = {
  tabId: 7,
  url: "https://dauthau.asia/thongbao/moithau/",
  title: "Thông báo mời thầu",
  hostname: "dauthau.asia",
  revision: 1,
  boundAt: 1,
  restricted: false,
  pinned: false,
  mustRead: false
};

async function runOnce(core, { prompt, context = CONTEXT, privacy, conversationId: existing } = {}) {
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = existing || (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}))).conversationId;
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, tabScope: [7], prompt, context, ...(privacy !== undefined ? { privacy } : {}) })
  );
  if (reply?.type === AGENT_MESSAGE_TYPES.ERROR) return { conversationId, reply };
  await waitFor(core, conversationId, (e) => e.type === "run_done");
  await settle();
  return { conversationId, reply, events: core.sessionManager.snapshotSince(conversationId, 0).events };
}

let firstConversation = null;

await test("a first completed run writes a memory and recalls nothing", async () => {
  const { sdk, calls } = trailSdk();
  const core = buildCore(sdk);
  const { conversationId, events } = await runOnce(core, { prompt: "phân tích TBMT có nơi thực hiện tại Hải Phòng" });
  firstConversation = conversationId;
  assert(!calls[0].options.systemPrompt.prompt.includes("What worked on this site before"), "nothing to recall on a first visit");
  assert(!events.some((e) => e.type === "memory_recalled"), "no disclosure event without a recall");
  const stored = memoryStore.freshForHost("dauthau.asia");
  assert(stored.length === 1, `one memory, got ${stored.length}`);
  assert(stored[0].provenance.conversationId === conversationId);
  assert(stored[0].steps.some((step) => step.target?.name === "Tìm kiếm"), JSON.stringify(stored[0].steps));
  assert(visibleTools(calls[0].options).includes(QUALIFIED_TOOL), `the recall tool is registered and visible whenever memory is on: ${visibleTools(calls[0].options).join(", ")}`);
});

let secondConversation = null;

await test("a later run on the same site gets the memory as guidance, and its success reinforces it", async () => {
  const { sdk, calls } = trailSdk();
  const core = buildCore(sdk);
  const { conversationId, events } = await runOnce(core, { prompt: "phân tích TBMT thực hiện tại Hải Phòng" });
  secondConversation = conversationId;
  const system = calls[0].options.systemPrompt.prompt;
  assert(system.includes("## What worked on this site before"), "guidance section present");
  assert(system.includes('computer left_click on button "Tìm kiếm"'), system.slice(system.indexOf("## What worked")));
  assert(system.includes(QUALIFIED_TOOL), "the section names the recall tool it can use");
  assert(calls[0].prompt === "phân tích TBMT thực hiện tại Hải Phòng", "the operator's prompt is untouched");
  const recalled = events.filter((e) => e.type === "memory_recalled");
  assert(recalled.length === 1 && recalled[0].host === "dauthau.asia" && recalled[0].memoryIds.length === 1, JSON.stringify(recalled));
  const stored = memoryStore.freshForHost("dauthau.asia");
  assert(stored.length === 1, `the repeat did not pile up a copy: ${stored.length}`);
  assert(stored[0].stats.useCount === 1, JSON.stringify(stored[0].stats));
});

await test("a run that errors after being offered the memory marks it stale", async () => {
  const { sdk } = trailSdk({ fail: true });
  const core = buildCore(sdk);
  const { events } = await runOnce(core, { prompt: "phân tích TBMT tại Hải Phòng" });
  assert(events.some((e) => e.type === "memory_recalled"), "it was offered");
  assert(events.some((e) => e.type === "run_error"), "the run errored");
  assert(memoryStore.freshForHost("dauthau.asia").length === 0, "stale memories are no longer fresh");
  const all = memoryStore.listForHost("dauthau.asia");
  assert(all.length === 1 && all[0].memory.stats.state === "stale", JSON.stringify(all.map((e) => e.memory?.stats)));
});

await test("a later success re-confirms the stale memory", async () => {
  const { sdk, calls } = trailSdk();
  const core = buildCore(sdk);
  await runOnce(core, { prompt: "phân tích TBMT có nơi thực hiện tại Hải Phòng" });
  assert(!calls[0].options.systemPrompt.prompt.includes("What worked"), "a stale memory is not offered");
  const fresh = memoryStore.freshForHost("dauthau.asia");
  assert(fresh.length === 1 && fresh[0].stats.state === "fresh", JSON.stringify(memoryStore.listForHost("dauthau.asia").map((e) => e.memory?.stats)));
});

await test("with the switch off: no recall, no write, no tool", async () => {
  settingsState = { enabled: false };
  try {
    const { sdk, calls } = trailSdk();
    const core = buildCore(sdk);
    const before = memoryStore.listAll().length;
    const { events } = await runOnce(core, { prompt: "phân tích TBMT Hải Phòng", context: { ...CONTEXT, hostname: "off.example", url: "https://off.example/" } });
    assert(!calls[0].options.systemPrompt.prompt.includes("What worked"));
    assert(!visibleTools(calls[0].options).includes(QUALIFIED_TOOL), "tool not registered when off");
    assert(!events.some((e) => e.type === "memory_recalled"));
    assert(memoryStore.listAll().length === before, "nothing written");
  } finally {
    settingsState = { enabled: true };
  }
});

await test("with the privacy control on: stored memories are recalled but nothing new is written", async () => {
  const { sdk, calls } = trailSdk();
  const core = buildCore(sdk);
  const before = memoryStore.listAll().length;
  await runOnce(core, { prompt: "phân tích TBMT Hải Phòng", privacy: { rawPromptCaching: false } });
  assert(calls[0].options.systemPrompt.prompt.includes("What worked"), "recall continues");
  const { sdk: sdk2 } = trailSdk();
  await runOnce(buildCore(sdk2), {
    prompt: "một việc hoàn toàn mới",
    privacy: { rawPromptCaching: false },
    context: { ...CONTEXT, hostname: "private.example", url: "https://private.example/" }
  });
  assert(memoryStore.listForHost("private.example").length === 0, "no new memory while paused");
  assert(memoryStore.listAll().length === before);
});

await test("a malformed privacy field is refused before any run exists", async () => {
  const { sdk, calls } = trailSdk();
  const core = buildCore(sdk);
  const { reply } = await runOnce(core, { prompt: "x", privacy: { rawPromptCaching: "no" } });
  assert(reply.type === AGENT_MESSAGE_TYPES.ERROR && reply.reason === "malformed_privacy", JSON.stringify(reply));
  assert(calls.length === 0);
});

await test("the settings relay lists, toggles and forgets", async () => {
  const core = buildCore(trailSdk().sdk);
  const call = (payload) => core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r", ...payload }));
  const listed = await call({ op: "task_memory_list" });
  assert(listed.ok && listed.result.sites.some((site) => site.host === "dauthau.asia"), JSON.stringify(listed));
  const entry = listed.result.sites.find((site) => site.host === "dauthau.asia").memories[0];
  assert(entry.stepCount >= 1 && typeof entry.intent === "string" && !("steps" in entry), JSON.stringify(entry));
  const off = await call({ op: "task_memory_set_settings", enabled: false });
  assert(off.ok && off.result.enabled === false && (await call({ op: "task_memory_get_settings" })).result.enabled === false);
  await call({ op: "task_memory_set_settings", enabled: true });
  const bad = await call({ op: "task_memory_set_settings", enabled: "yes" });
  assert(!bad.ok, "a non-boolean is refused");
  const badForget = await call({ op: "task_memory_forget" });
  assert(!badForget.ok, "forget needs a host or all:true");
  memoryStore.write({ ...memoryStore.freshForHost("dauthau.asia")[0], id: "mem_extra", host: "extra.example" });
  const forgotten = await call({ op: "task_memory_forget", host: "extra.example" });
  assert(forgotten.ok && forgotten.result.forgotten === 1, JSON.stringify(forgotten));
});

await test("deleting a conversation forgets the memories it produced", async () => {
  const core = buildCore(trailSdk().sdk);
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const owner = memoryStore.freshForHost("dauthau.asia")[0].provenance.conversationId;
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId: owner }));
  assert(reply.deleted === true, JSON.stringify(reply));
  assert(memoryStore.listForHost("dauthau.asia").every((entry) => entry.memory?.provenance.conversationId !== owner), "memories of the deleted conversation are gone");
});

await test("no approval or policy module can read task memory", () => {
  const policyDir = path.join(HERE, "..", "agent", "policy");
  for (const file of fs.readdirSync(policyDir).filter((name) => name.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(policyDir, file), "utf8");
    assert(!/from\s+["'][^"']*memory\//.test(source), `${file} imports the memory modules`);
  }
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} TASK MEMORY WIRING TESTS PASSED`);
process.exit(failed.length ? 1 : 0);

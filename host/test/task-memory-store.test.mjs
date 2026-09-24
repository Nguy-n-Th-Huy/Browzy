#!/usr/bin/env node
//
// TaskMemoryStore (openspec/changes/add-task-memory tasks.md 1.1-1.3):
// round-trip, per-site listing, rejecting guards, forbidden authority keys,
// supersede-on-repeat, eviction order, forgetting, corrupt-entry tolerance,
// and path containment — all against a scratch OCIC_AGENT_HOME.
//
// Run: node host/test/task-memory-store.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-task-memory-store-"));
process.env.OCIC_AGENT_HOME = scratch;

const {
  TaskMemoryStore,
  TaskMemoryError,
  hostHash,
  validateMemoryRecord,
  stepSequenceSimilarity,
  MAX_STEPS,
  MAX_MEMORY_BYTES
} = await import("../agent/memory/store.js");
const { memoryRoot, memoryHostDir } = await import("../agent/storage/paths.js");
const { loadTaskMemorySettings, saveTaskMemorySettings } = await import("../agent/memory/settings.js");

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
function expectReason(fn, reason) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof TaskMemoryError, `expected TaskMemoryError, got ${err.name}: ${err.message}`);
    assert(err.reason === reason, `expected reason ${reason}, got ${err.reason}: ${err.message}`);
    return err;
  }
  throw new Error(`expected ${reason}, but nothing threw`);
}

let idCounter = 0;
function record(overrides = {}) {
  idCounter += 1;
  return {
    schemaVersion: 1,
    id: `mem_test_${idCounter}`,
    host: "dauthau.asia",
    intent: { text: "phân tích TBMT có nơi thực hiện tại Hải Phòng", tokens: ["phân", "tích", "tbmt", "nơi", "thực", "hiện", "hải", "phòng"] },
    startUrl: "https://dauthau.asia/thongbao/moithau/",
    steps: [
      { index: 1, tool: "find", args: { query: "Tìm kiếm nâng cao" }, host: "dauthau.asia" },
      { index: 2, tool: "computer", action: "left_click", args: { action: "left_click" }, target: { role: "button", name: "Tìm kiếm" }, host: "dauthau.asia" },
      { index: 3, tool: "get_page_text", args: {}, host: "dauthau.asia" }
    ],
    outcome: { status: "completed", actionCount: 3, durationMs: 19000 },
    provenance: { conversationId: "conv_a", runId: "run_a", completedAt: 1000, deriveVersion: 1 },
    stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: 1000, state: "fresh" },
    ...overrides
  };
}

function reset() {
  fs.rmSync(memoryRoot(), { recursive: true, force: true });
}

console.log("\n== writing and reading ==");

await test("a written memory round-trips and lists for its site", () => {
  reset();
  const store = new TaskMemoryStore();
  const written = store.write(record());
  const listed = store.listForHost("dauthau.asia");
  assert(listed.length === 1 && listed[0].ok, JSON.stringify(listed));
  assert(listed[0].memory.id === written.memory.id);
  assert(store.get(written.memory.id).intent.text.includes("Hải Phòng"), "get returns the record");
  assert(store.listForHost("DAUTHAU.ASIA.").length === 1, "host lookup is normalized");
  assert(store.listForHost("other.example").length === 0, "another site sees nothing");
});

await test("the file lives under memory/<host-hash>/<id>.json and nowhere else", () => {
  reset();
  const store = new TaskMemoryStore();
  const { memory } = store.write(record());
  const expected = path.join(memoryHostDir(hostHash("dauthau.asia")), `${memory.id}.json`);
  assert(fs.existsSync(expected), `expected ${expected}`);
  const all = fs.readdirSync(scratch, { recursive: true });
  assert(all.every((entry) => String(entry).startsWith("memory")), `unexpected files: ${all.join(", ")}`);
});

await test("an absent root lists as empty, not as an error", () => {
  reset();
  const store = new TaskMemoryStore();
  assert(store.listAll().length === 0);
  assert(store.listForHost("dauthau.asia").length === 0);
});

console.log("\n== rejecting guards ==");

await test("too many steps is rejected, not truncated", () => {
  reset();
  const steps = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({ index: i + 1, tool: "find", args: { query: `q${i}` }, host: null }));
  expectReason(() => new TaskMemoryStore().write(record({ steps })), "too_many_steps");
  assert(new TaskMemoryStore().listAll().length === 0, "nothing was written");
});

await test("an overlong intent is rejected", () => {
  expectReason(() => validateMemoryRecord(record({ intent: { text: "x".repeat(201), tokens: [] } })), "intent_too_long");
});

await test("an oversize record is rejected", () => {
  const big = [{ index: 1, tool: "find", args: { query: "y".repeat(MAX_MEMORY_BYTES) }, host: null }];
  expectReason(() => validateMemoryRecord(record({ steps: big })), "too_large");
});

await test("hostile ids are rejected", () => {
  expectReason(() => validateMemoryRecord(record({ id: "../../etc/passwd" })), "invalid_id");
  expectReason(() => validateMemoryRecord(record({ id: ".." })), "invalid_id");
});

await test("authority-shaped keys are rejected wherever the record itself carries them", () => {
  expectReason(() => validateMemoryRecord({ ...record(), approve: true }), "authority_key");
  expectReason(() => validateMemoryRecord(record({ stats: { ...record().stats, remember: true } })), "authority_key");
  const steps = record().steps.map((step, i) => (i === 1 ? { ...step, permission: "allow" } : step));
  expectReason(() => validateMemoryRecord(record({ steps })), "authority_key");
});

await test("a recorded tool argument named like an authority key is the tool's vocabulary, not the memory's", () => {
  const steps = [{ index: 1, tool: "find", args: { query: "x", scope: "page" }, host: null }];
  validateMemoryRecord(record({ steps }));
});

await test("only a completed outcome can be stored", () => {
  expectReason(() => validateMemoryRecord(record({ outcome: { status: "failed", actionCount: 1, durationMs: null } })), "invalid_outcome");
});

console.log("\n== repeats, eviction, staleness ==");

await test("a repeat of the same task replaces the stored memory and keeps its history", () => {
  reset();
  const store = new TaskMemoryStore();
  const first = store.write(record()).memory;
  store.reinforce(first.id, { usedAt: 1500, confirmed: false });
  const second = store.write(record({ id: "mem_repeat", stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: 2000, state: "fresh" } }));
  assert(second.replacedId === first.id, JSON.stringify(second));
  const listed = store.listForHost("dauthau.asia");
  assert(listed.length === 1, `one entry, got ${listed.length}`);
  assert(listed[0].memory.stats.useCount === 1 && listed[0].memory.stats.lastConfirmedAt === 2000, JSON.stringify(listed[0].memory.stats));
});

await test("a stale memory is re-confirmed by a matching new derivation", () => {
  reset();
  const store = new TaskMemoryStore();
  const first = store.write(record()).memory;
  store.markStale(first.id, "run_error");
  assert(store.freshForHost("dauthau.asia").length === 0, "stale is not offered");
  store.write(record({ id: "mem_confirm", stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: 3000, state: "fresh" } }));
  const fresh = store.freshForHost("dauthau.asia");
  assert(fresh.length === 1 && fresh[0].id === first.id && fresh[0].stats.state === "fresh", JSON.stringify(fresh));
});

await test("a different task on the same site is stored beside, not over, the first", () => {
  reset();
  const store = new TaskMemoryStore();
  store.write(record());
  store.write(
    record({
      intent: { text: "tải file hồ sơ mời thầu", tokens: ["tải", "file", "hồ", "sơ", "mời", "thầu"] },
      steps: [{ index: 1, tool: "navigate", args: { url: "https://dauthau.asia/x" }, host: "dauthau.asia" }]
    })
  );
  assert(store.listForHost("dauthau.asia").length === 2);
});

await test("the per-site cap evicts stale first, then the least recently confirmed", () => {
  reset();
  const store = new TaskMemoryStore({ limits: { maxPerHost: 3 } });
  const distinct = (n, confirmedAt) =>
    record({
      id: `mem_cap_${n}`,
      intent: { text: `task ${n}`, tokens: [`task${n}`] },
      steps: [{ index: 1, tool: "navigate", args: { url: `https://dauthau.asia/${n}` }, host: "dauthau.asia" }],
      stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: confirmedAt, state: "fresh" }
    });
  store.write(distinct(1, 100));
  store.write(distinct(2, 200));
  store.write(distinct(3, 300));
  store.markStale("mem_cap_3", "drift");
  const { evicted } = store.write(distinct(4, 400));
  assert(evicted.length === 1 && evicted[0] === "mem_cap_3", `stale evicted first: ${evicted}`);
  const { evicted: next } = store.write(distinct(5, 500));
  assert(next.length === 1 && next[0] === "mem_cap_1", `then oldest confirmed: ${next}`);
});

await test("the global cap applies across sites", () => {
  reset();
  const store = new TaskMemoryStore({ limits: { maxTotal: 2 } });
  store.write(record({ id: "mem_g1", host: "a.example", stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: 1, state: "fresh" } }));
  store.write(record({ id: "mem_g2", host: "b.example", stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: 2, state: "fresh" } }));
  const { evicted } = store.write(record({ id: "mem_g3", host: "c.example", stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: 3, state: "fresh" } }));
  assert(evicted.includes("mem_g1"), JSON.stringify(evicted));
  assert(store.listAll().length === 2);
});

await test("step-sequence similarity compares tool+action order", () => {
  const a = [{ tool: "find" }, { tool: "computer", action: "left_click" }, { tool: "get_page_text" }];
  assert(stepSequenceSimilarity(a, a) === 1);
  assert(stepSequenceSimilarity(a, [{ tool: "navigate" }]) === 0);
  assert(Math.abs(stepSequenceSimilarity(a, a.slice(0, 2)) - 2 / 3) < 1e-9);
});

console.log("\n== forgetting ==");

await test("forget, forgetHost, forgetAll and forgetByConversation remove exactly what they name", () => {
  reset();
  const store = new TaskMemoryStore();
  const one = store.write(record({ id: "mem_f1" })).memory;
  store.write(record({ id: "mem_f2", host: "b.example", provenance: { conversationId: "conv_b", runId: "r", completedAt: 1, deriveVersion: 1 } }));
  store.write(record({ id: "mem_f3", host: "c.example", provenance: { conversationId: "conv_b", runId: "r2", completedAt: 2, deriveVersion: 1 } }));
  store.write(record({ id: "mem_f4", host: "d.example" }));
  assert(store.forget(one.id) === true && store.get(one.id) === null);
  assert(store.forget("mem_missing") === false);
  assert(store.forgetByConversation("conv_b") === 2);
  assert(store.listAll().length === 1 && store.listAll()[0].memory.id === "mem_f4");
  assert(store.forgetHost("d.example") === 1);
  store.write(record({ id: "mem_f5" }));
  saveTaskMemorySettings({ enabled: false });
  assert(store.forgetAll() === 1 && store.listAll().length === 0);
  assert(loadTaskMemorySettings().enabled === false, "forgetting everything keeps the settings file");
  const leftover = fs.readdirSync(memoryRoot());
  assert(leftover.length === 1 && leftover[0] === "settings.json", `empty host dirs pruned: ${leftover}`);
});

console.log("\n== corruption ==");

await test("a corrupt file lists as invalid and never fails the listing", () => {
  reset();
  const store = new TaskMemoryStore();
  store.write(record({ id: "mem_ok" }));
  const dir = memoryHostDir(hostHash("dauthau.asia"));
  fs.writeFileSync(path.join(dir, "mem_bad.json"), "{not json");
  const listed = store.listForHost("dauthau.asia");
  assert(listed.length === 2, JSON.stringify(listed));
  assert(listed[0].ok && listed[0].memory.id === "mem_ok");
  assert(!listed[1].ok && /invalid JSON/.test(listed[1].reason));
  assert(store.freshForHost("dauthau.asia").length === 1, "recall ignores the invalid entry");
});

console.log("\n== settings ==");

await test("the switch defaults on and persists", () => {
  reset();
  assert(loadTaskMemorySettings().enabled === true, "default on");
  saveTaskMemorySettings({ enabled: false });
  assert(loadTaskMemorySettings().enabled === false);
  let threw = false;
  try {
    saveTaskMemorySettings({ enabled: "yes" });
  } catch {
    threw = true;
  }
  assert(threw, "a non-boolean is refused");
});

fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} TASK MEMORY STORE TESTS PASSED`);
process.exit(failed.length ? 1 : 0);

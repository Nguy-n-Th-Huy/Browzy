#!/usr/bin/env node
// Scripted performance checks for openspec/changes/optimize-chat-history task
// 5.3: "run extension parse/CSP and manual performance checks with 1, 100, and
// 1000 conversations ... latency, storage writes, and memory remain within
// agreed budgets".
//
// The budgets this file holds the implementation to, and why each number is
// what it is:
//
//   * COLD LIST READ (1 storage read, 0 writes). Opening the history screen
//     must not rewrite the index (tasks.md 2.1) — a read that writes is the
//     regression the whole per-conversation-key design exists to prevent.
//   * ONE UPDATE = ONE WRITE, ONE KEY. With 1000 cached conversations, a
//     conversation update writes only that conversation's key. This is the
//     O(1)-write claim; a whole-index rewrite would show up as 1000 keys.
//   * OPEN ≤ 250 ms and SEARCH ≤ 150 ms at 1000 conversations. Both are
//     synchronous work on the panel's own thread, so they have to stay well
//     under a frame-ish budget; measured values are one to two orders of
//     magnitude below this (prints below), so the cap catches a real
//     regression without flaking on a slow machine.
//   * RENDERED ROWS ≤ pageSize + 1 at any count. That is what "paginated /
//     virtualized" means observably (spec chat-history-browsing "Incremental
//     rendering": "only the first visible page is rendered").
//   * CACHE ≤ 12 MB for 1000 conversations and ≤ 8 MB for a 5000-event
//     transcript window. The transcript cap is tasks.md 3.3's bound; the
//     history bound is the "lightweight metadata index" design.md's risk
//     section requires for large host directories.
//
// Run: node test/sidepanel-chat-history-perf.test.mjs
// (add --expose-gc for a lower-noise memory number; it is optional.)

import { HistoryStore } from "../extension/sidepanel/history-store.js";
import { HistoryListView } from "../extension/sidepanel/history-view.js";
import { ConversationModel } from "../extension/sidepanel/conversation-model.js";
import { buildConversationArtifact } from "../extension/sidepanel/history-export.js";
import { createDocument } from "./_fake-dom.mjs";

const SIZES = [1, 100, 1000];
const BUDGETS = {
  openMs: 250,
  searchMs: 150,
  filterMs: 150,
  coldLoadMs: 750,
  renderedRows: 26, // HISTORY_PAGE_SIZE(25) + the "load more" control
  cacheBytesPer1000: 12 * 1024 * 1024,
  windowEvents: 1000,
  windowBytes: 8 * 1024 * 1024,
  exportMs: 300
};

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

const timings = [];
function record(label, ms) {
  timings.push({ label, ms });
  return ms;
}

function now() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function heap() {
  if (typeof global.gc === "function") global.gc();
  return process.memoryUsage().heapUsed;
}

/** chrome.storage.local-shaped in-memory backend that counts every call and
 * every key touched, so "no whole-index rewrite" is a measured fact. */
function countingStorage() {
  const data = {};
  const counters = { gets: 0, sets: 0, removes: 0, keysWritten: 0, keysPerSet: [] };
  return {
    counters,
    async get(key) {
      counters.gets += 1;
      if (key == null) return { ...data };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in data) out[k] = data[k];
        return out;
      }
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      counters.sets += 1;
      const keys = Object.keys(obj);
      counters.keysWritten += keys.length;
      counters.keysPerSet.push(keys.length);
      Object.assign(data, obj);
    },
    async remove(keys) {
      counters.removes += 1;
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function fakeEntry(index, { hostnames = 12 } = {}) {
  return {
    conversationId: `conv_${String(index).padStart(5, "0")}`,
    title: `Cuộc trò chuyện ${index} về ${["báo cáo", "lịch sử", "giá vàng", "thời tiết", "du lịch"][index % 5]}`,
    hostname: `site${index % hostnames}.example`,
    createdAt: Date.now() - index * 60_000,
    updatedAt: Date.now() - index * 60_000,
    pinned: index % 97 === 0,
    archived: index % 211 === 0,
    interrupted: false,
    revision: 1 + (index % 7),
    prompts: { [`run_${index}`]: `câu hỏi số ${index} về chủ đề ${index % 13}` }
  };
}

function buildView(pageSize = 25) {
  const doc = createDocument();
  const container = doc.createElement("div");
  const scroller = doc.createElement("div");
  scroller.appendChild(container);
  scroller.scrollHeight = 20_000;
  scroller.clientHeight = 600;
  const view = new HistoryListView({ container, scrollContainer: scroller, document: doc, pageSize, actions: {} });
  return { view, container };
}

function rowNodes(container) {
  return container.children.filter((child) => child.getAttribute("data-conversation-id") != null).length;
}

async function coldStore(size) {
  const storage = countingStorage();
  const seed = new HistoryStore({ storage });
  // Seed through the same code path the panel uses, then re-open the store the
  // way the next panel document does.
  for (let i = 0; i < size; i += 1) {
    const entry = fakeEntry(i);
    await seed.upsert(entry);
  }
  await seed.flushNow();
  return { storage, seed };
}

async function main() {
  console.log("\nHistory performance budgets — 1, 100, 1000 conversations\n");
  console.log(`  (node ${process.version}, gc ${typeof global.gc === "function" ? "available" : "not exposed"})\n`);

  const table = [];

  for (const size of SIZES) {
    const { storage, seed } = await coldStore(size);
    const seeded = await seed.list();
    ok(seeded.length === size, `[${size}] the cache holds exactly ${size} conversations`);

    // --- cold open: one read, no writes ------------------------------------
    const coldStorage = storage;
    coldStorage.counters.gets = 0;
    coldStorage.counters.sets = 0;
    const coldStart = now();
    const reopened = new HistoryStore({ storage: coldStorage });
    const list = await reopened.list();
    const coldMs = record(`cold load ${size}`, now() - coldStart);
    ok(list.length === size, `[${size}] a fresh panel document (cold store read) sees all ${size}`);
    ok(coldStorage.counters.gets === 1, `[${size}] …with exactly ONE storage read (${coldStorage.counters.gets})`);
    ok(coldStorage.counters.sets === 0, `[${size}] …and NO write while merely listing`);
    ok(coldMs <= BUDGETS.coldLoadMs, `[${size}] cold load stays within budget (${coldMs.toFixed(1)}ms <= ${BUDGETS.coldLoadMs}ms)`);

    // --- open the screen: first page only ----------------------------------
    const { view, container } = buildView();
    const openStart = now();
    view.setEntries(list);
    view.render();
    const openMs = record(`open ${size}`, now() - openStart);
    const rows = rowNodes(container);
    ok(openMs <= BUDGETS.openMs, `[${size}] rendering the history screen stays within budget (${openMs.toFixed(1)}ms <= ${BUDGETS.openMs}ms)`);
    ok(rows <= BUDGETS.renderedRows, `[${size}] only the first page is rendered (${rows} row nodes, budget ${BUDGETS.renderedRows})`);
    ok(view.report().truncated === Math.max(0, size - 25), `[${size}] the rest is left unrendered (${view.report().truncated})`);

    // --- search: local metadata, over the whole list ------------------------
    const searchStart = now();
    view.setQuery("lich su");
    view.flushQuery();
    const searchMs = record(`search ${size}`, now() - searchStart);
    const matched = view.report().matched;
    ok(searchMs <= BUDGETS.searchMs, `[${size}] a metadata search stays within budget (${searchMs.toFixed(1)}ms <= ${BUDGETS.searchMs}ms, ${matched} matches)`);
    ok(rowNodes(container) <= BUDGETS.renderedRows, `[${size}] …and still renders at most one page (${rowNodes(container)})`);

    const filterStart = now();
    view.clearFilters();
    view.setDomain("site3.example");
    view.render();
    const filterMs = record(`domain filter ${size}`, now() - filterStart);
    ok(filterMs <= BUDGETS.filterMs, `[${size}] a domain filter stays within budget (${filterMs.toFixed(1)}ms <= ${BUDGETS.filterMs}ms)`);

    // --- one update = one write, one key -----------------------------------
    coldStorage.counters.sets = 0;
    coldStorage.counters.keysPerSet = [];
    const target = list[Math.floor(size / 2)].conversationId;
    await reopened.upsert({ conversationId: target, title: "đã cập nhật" });
    await reopened.flushNow();
    const keysPerSet = coldStorage.counters.keysPerSet;
    ok(coldStorage.counters.sets === 1, `[${size}] updating one conversation with ${size} cached writes once (${coldStorage.counters.sets})`);
    ok(keysPerSet.length === 1 && keysPerSet[0] === 1, `[${size}] …and touches exactly one key, never the whole index (keys per set: ${keysPerSet.join(",")})`);

    // --- a streaming burst coalesces ---------------------------------------
    coldStorage.counters.sets = 0;
    coldStorage.counters.keysPerSet = [];
    for (let i = 0; i < 20; i += 1) await reopened.recordPrompt(target, `run_burst_${i}`, `mảnh ${i}`);
    await reopened.flushNow();
    ok(coldStorage.counters.sets === 1, `[${size}] 20 rapid prompt updates coalesce into 1 write (${coldStorage.counters.sets})`);

    // --- memory of the cache itself ----------------------------------------
    const before = heap();
    const copy = await reopened.list();
    void copy;
    const cacheBytes = Math.max(0, heap() - before);
    table.push({ size, coldMs, openMs, searchMs, filterMs, rows, cacheBytes });
    if (size === 1000) {
      ok(cacheBytes <= BUDGETS.cacheBytesPer1000, `[1000] listing the whole cache costs at most the budget (${(cacheBytes / 1024 / 1024).toFixed(2)} MB <= ${(BUDGETS.cacheBytesPer1000 / 1024 / 1024).toFixed(0)} MB)`);
    } else {
      ok(true, `[${size}] cache footprint for ${size} conversations: ${(cacheBytes / 1024).toFixed(1)} KB`);
    }
  }

  console.log("\n== transcript window: a 5000-event conversation stays bounded (tasks.md 3.3) ==");
  {
    const model = new ConversationModel("conv_perf", {});
    const before = heap();
    const start = now();
    for (let seq = 1; seq <= 5000; seq += 1) {
      model.applyEvent({
        seq,
        type: seq % 500 === 1 ? "run_created" : "stream_message",
        runId: `run_${Math.floor(seq / 500)}`,
        ...(seq % 500 === 1 ? {} : { message: { type: "assistant", message: { content: [{ type: "text", text: `mảnh ${seq} ` }] } } })
      });
    }
    const streamMs = record("5000 events", now() - start);
    const windowBytes = Math.max(0, heap() - before);
    console.log(`  (streamed 5000 events in ${streamMs.toFixed(1)}ms)`);
    ok(model.windowSize() <= BUDGETS.windowEvents, `a 5000-event transcript keeps at most ${BUDGETS.windowEvents} events (${model.windowSize()} retained)`);
    ok(windowBytes <= BUDGETS.windowBytes, `…and at most ${(BUDGETS.windowBytes / 1024 / 1024).toFixed(0)} MB of heap (${(windowBytes / 1024 / 1024).toFixed(2)} MB)`);
    ok(model.hasOlderEvents() === true, "…and it still knows there is older history below the window");
    ok(streamMs <= 2000, `streaming 5000 events stays responsive (${streamMs.toFixed(1)}ms for the whole run)`);
  }

  console.log("\n== export: building the artifact for a 2000-event conversation ==");
  {
    const summary = { conversationId: "conv_export", title: "Xuất thử", hostname: "site.example", revision: 3, createdAt: Date.now(), updatedAt: Date.now() };
    const events = [];
    for (let seq = 1; seq <= 2000; seq += 1) {
      events.push({
        seq,
        type: "stream_message",
        runId: `run_${Math.floor(seq / 200)}`,
        message: { type: "assistant", message: { content: [{ type: "text", text: `đoạn ${seq}. ` }] } }
      });
    }
    const start = now();
    const artifact = buildConversationArtifact({ summary, events, format: "md" });
    const exportMs = record("export 2000 events", now() - start);
    ok(artifact.eventCount === 2000 && artifact.content.length > 2000, `the artifact holds all 2000 events (${(artifact.content.length / 1024).toFixed(1)} KB of Markdown)`);
    ok(exportMs <= BUDGETS.exportMs, `building it stays within budget (${exportMs.toFixed(1)}ms <= ${BUDGETS.exportMs}ms)`);
  }

  console.log("\n== recorded numbers ==");
  console.log("  conversations | cold load | open screen | search | domain filter | rows rendered | cache heap");
  for (const row of table) {
    console.log(
      `  ${String(row.size).padStart(13)} | ${row.coldMs.toFixed(1).padStart(9)}ms | ${row.openMs.toFixed(1).padStart(11)}ms | ${row.searchMs
        .toFixed(1)
        .padStart(6)}ms | ${row.filterMs.toFixed(1).padStart(13)}ms | ${String(row.rows).padStart(13)} | ${(row.cacheBytes / 1024).toFixed(1).padStart(9)} KB`
    );
  }
  console.log("");
  for (const t of timings) console.log(`  ${t.label.padEnd(24)} ${t.ms.toFixed(1)}ms`);

  console.log(fail === 0 ? "\nALL SIDEPANEL CHAT-HISTORY PERF CHECKS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

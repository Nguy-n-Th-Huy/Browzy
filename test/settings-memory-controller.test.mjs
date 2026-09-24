#!/usr/bin/env node
//
// Settings > Bộ nhớ cách làm việc (openspec/changes/add-task-memory tasks.md
// 7.3-7.5): the DOM-free controller against a fake client, and the client's
// exact wire ops. Pins: load reads switch + list; the switch round-trips; a
// forget only removes what the host confirmed; failures never read as
// success; the empty state; intent-less memories say so; stale is labelled.
//
// Run: node test/settings-memory-controller.test.mjs

import fs from "node:fs";

import { MemoryController, lastConfirmedLabel } from "../extension/settings/memory-controller.js";
import { createMemoryClient, MemoryErrorLike } from "../extension/settings/memory-client.js";

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail += 1;
};

const NOW = Date.UTC(2026, 8, 24, 12);
const DAY = 86_400_000;

function fakeClient(overrides = {}) {
  const calls = [];
  let enabled = true;
  let sites = [
    {
      host: "dauthau.asia",
      memories: [
        { id: "m1", intent: "phân tích TBMT Hải Phòng", stepCount: 5, actionCount: 4, lastConfirmedAt: NOW - DAY, useCount: 2, state: "fresh" },
        { id: "m2", intent: null, stepCount: 3, actionCount: 3, lastConfirmedAt: NOW - 3 * DAY, useCount: 0, state: "stale" }
      ]
    },
    { host: "shop.example.com", memories: [{ id: "m3", intent: "xem đơn hàng", stepCount: 2, actionCount: 2, lastConfirmedAt: NOW, useCount: 0, state: "fresh" }] }
  ];
  return {
    calls,
    getSettings: async () => (calls.push(["getSettings"]), { enabled }),
    setEnabled: async (next) => (calls.push(["setEnabled", next]), (enabled = next), { enabled }),
    list: async () => (calls.push(["list"]), { sites, invalid: 1 }),
    forgetHost: async (host) => {
      calls.push(["forgetHost", host]);
      const before = sites.length;
      sites = sites.filter((s) => s.host !== host);
      return { forgotten: before - sites.length };
    },
    forgetAll: async () => (calls.push(["forgetAll"]), (sites = []), { forgotten: 3 }),
    ...overrides
  };
}

console.log("\n== loading and rows ==");
{
  const controller = new MemoryController(fakeClient(), { now: () => NOW });
  await controller.load();
  ok(controller.state.loaded && controller.state.enabled === true, "load reads the switch");
  ok(controller.state.sites.length === 2 && controller.state.invalid === 1, "load reads the per-site list and the invalid count");
  const rows = controller.siteRows();
  ok(rows[0].host === "dauthau.asia" && rows[0].memories.length === 2, "one row per site, host order kept");
  ok(rows[0].memories[0].stepsLabel === "5 bước" && rows[0].memories[0].confirmedLabel === "Xác nhận hôm qua", "labels: steps and last confirmed");
  ok(rows[0].memories[0].usedLabel === "Đã dùng lại 2 lần", "reuse count shown when non-zero");
  ok(rows[0].memories[1].intentLabel === "(nội dung yêu cầu không được lưu)", "an intent-less memory says the request was not stored");
  ok(rows[0].memories[1].stale && /không được gợi ý/.test(rows[0].memories[1].stateLabel), "stale memories are labelled as not offered");
  ok(!controller.isEmpty(), "not empty");
}

console.log("\n== the switch ==");
{
  const client = fakeClient();
  const controller = new MemoryController(client, { now: () => NOW });
  await controller.load();
  await controller.setEnabled(false);
  ok(controller.state.enabled === false && client.calls.some(([op, v]) => op === "setEnabled" && v === false), "turning off round-trips through the host");
  const failing = new MemoryController(fakeClient({ setEnabled: async () => { throw new MemoryErrorLike("NETWORK_ERROR", "down"); } }), { now: () => NOW });
  await failing.load();
  await failing.setEnabled(false);
  ok(failing.state.enabled === true && failing.state.banner?.kind === "error", "a failed save keeps the old value and shows an error");
}

console.log("\n== forgetting ==");
{
  const client = fakeClient();
  const controller = new MemoryController(client, { now: () => NOW });
  await controller.load();
  await controller.forgetHost("dauthau.asia");
  ok(controller.state.sites.length === 1 && controller.state.sites[0].host === "shop.example.com", "forgetting one site leaves the others");
  ok(controller.state.banner?.kind === "success", "success is reported");
  await controller.forgetAll();
  ok(controller.isEmpty(), "forgetting all empties the list");

  const broken = new MemoryController(fakeClient({ forgetHost: async () => { throw new MemoryErrorLike("STORAGE_ERROR", "disk"); } }), { now: () => NOW });
  await broken.load();
  await broken.forgetHost("dauthau.asia");
  ok(broken.state.sites.length === 2 && broken.state.banner?.kind === "error", "a failed forget removes nothing and reports the failure");
}

console.log("\n== empty and error states ==");
{
  const empty = new MemoryController(fakeClient({ list: async () => ({ sites: [], invalid: 0 }) }), { now: () => NOW });
  await empty.load();
  ok(empty.isEmpty(), "no memories is the explained empty state");
  const down = new MemoryController(fakeClient({ getSettings: async () => { throw new MemoryErrorLike("NETWORK_ERROR", "x"); } }), { now: () => NOW });
  await down.load();
  ok(down.state.banner?.kind === "error" && /companion/.test(down.state.banner.message), "an unreachable companion is named");
  ok(lastConfirmedLabel(NOW, NOW) === "Xác nhận hôm nay" && /ngày trước/.test(lastConfirmedLabel(NOW - 5 * DAY, NOW)), "relative labels");
}

console.log("\n== the client's wire ops ==");
{
  const sent = [];
  const client = createMemoryClient({ sendMessage: async (msg) => (sent.push(msg), { ok: true, result: { ok: 1 } }) });
  await client.getSettings();
  await client.setEnabled(true);
  await client.list();
  await client.forgetHost("dauthau.asia");
  await client.forgetAll();
  ok(sent.every((m) => m.type === "agent_settings"), "every call rides agent_settings");
  ok(JSON.stringify(sent.map((m) => m.op)) === JSON.stringify(["task_memory_get_settings", "task_memory_set_settings", "task_memory_list", "task_memory_forget", "task_memory_forget"]), "exact op names");
  ok(sent[1].enabled === true && sent[3].host === "dauthau.asia" && sent[4].all === true, "exact payloads");
  const failing = createMemoryClient({ sendMessage: async () => ({ ok: false, error: { code: "VALIDATION_ERROR", message: "bad" } }) });
  let code = null;
  try {
    await failing.list();
  } catch (err) {
    code = err.code;
  }
  ok(code === "VALIDATION_ERROR", "host errors surface with their code");
}

console.log("\n== the page ==");
{
  const html = fs.readFileSync(new URL("../extension/settings/memory.html", import.meta.url), "utf8");
  ok(/không cấp quyền gì/.test(html), "the page states memories grant nothing");
  ok(/Không lưu nội dung câu hỏi/.test(html), "the page explains the privacy control pauses new memories");
  ok(/id="memory-empty"/.test(html) && /Chưa ghi nhớ cách làm nào/.test(html), "the page has an explained empty state");
  ok(/\.memory-empty\[hidden\]/.test(html), "the empty state really hides when there are memories (its display rule would otherwise beat [hidden])");
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(html.replace(/&#\d+;/g, "")), "the page's own styles use tokens, not raw colours");
  const settings = fs.readFileSync(new URL("../extension/settings/settings.html", import.meta.url), "utf8");
  ok(/id="nav-memory"/.test(settings), "Settings links to the memory page");
}

console.log(fail === 0 ? "\nALL SETTINGS MEMORY TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

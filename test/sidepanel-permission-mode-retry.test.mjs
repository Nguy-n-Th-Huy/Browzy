#!/usr/bin/env node
// extension/sidepanel/sidepanel.js's permission-mode retry ladder —
// schedulePermissionModeRetry() + loadPermissionMode(), extracted from the
// REAL shipped source via test/_extract.mjs's brace-matching extractor (the
// same technique test/sidepanel-threat-warnings.test.mjs uses; sidepanel.js
// as a whole touches `document`/`chrome.*` at module scope and cannot be
// imported in plain Node).
//
// The acceptance-critical property: a failed get_permission_state must NEVER
// leave the badge silently dead. The live "click Auto, nothing opens"
// regression shipped exactly that — one transient failure, then no retry
// ever (syncPermissionMode() attempts one load per ok handshake), so the
// menu stayed empty forever while everything else looked healthy. This pins:
//   1. failure surfaces on the trigger title and schedules a retry;
//   2. consecutive failures back off (2s, 4s, ... capped) with one timer in
//      flight at a time;
//   3. a success cancels a pending retry, resets the ladder, and renders the
//      menu (which rewrites the title to the real mode description);
//   4. a retry that fires while the handshake is down does NOT call load —
//      the fresh-handshake path owns that reload.
//
// Run: node test/sidepanel-permission-mode-retry.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction, compile } from "./_extract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL_FILE = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const SRC = fs.readFileSync(SIDEPANEL_FILE, "utf8");

// The ladder bounds come from the shipped source, not a hand-typed copy, so
// a deliberate retune there cannot silently drift out of this test's math.
const BASE = Number((SRC.match(/PERMISSION_MODE_RETRY_BASE_MS\s*=\s*(\d+)/) || [])[1]);
const MAX = Number((SRC.match(/PERMISSION_MODE_RETRY_MAX_MS\s*=\s*(\d+)/) || [])[1]);

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

// --- Harness -----------------------------------------------------------------

// Mutable state shared between the two extracted functions and the test.
const permissionMode = { mode: "auto", modeSource: "local", loaded: false, syncing: false };
const permissionModeRetry = { timer: null, delayMs: BASE };
const timers = []; // { id, cb, ms, cleared }
let nextTimerId = 1;
let handshake = "ok";
let clientCalls = 0;
let renders = 0;
const client = {
  fail: true,
  result: { mode: "auto", modeSource: "local" },
  async getPermissionState() {
    clientCalls += 1;
    if (client.fail) throw new Error("PROTOCOL_ERROR: unknown agent_settings op");
    return client.result;
  }
};

const deps = {
  permissionMode,
  permissionModeRetry,
  permissionsClient: client,
  el: { modeTrigger: { title: "" } },
  renderModeMenu: () => {
    renders += 1;
  },
  panel: { protocol: { handshakeState: () => handshake } },
  setTimeout: (cb, ms) => {
    const t = { id: nextTimerId++, cb, ms, cleared: false };
    timers.push(t);
    return t.id;
  },
  clearTimeout: (id) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  },
  PERMISSION_MODE_RETRY_BASE_MS: BASE,
  PERMISSION_MODE_RETRY_MAX_MS: MAX
};

const factory = compile(
  [extractFunction("schedulePermissionModeRetry", SIDEPANEL_FILE), extractFunction("loadPermissionMode", SIDEPANEL_FILE)].join("\n\n"),
  deps,
  "{ schedulePermissionModeRetry, loadPermissionMode }"
);
const { loadPermissionMode: runLoad } = factory;

const settle = () => new Promise((r) => setTimeout(r, 5));

console.log("== the ladder bounds were found in the shipped source ==");
ok(Number.isFinite(BASE) && BASE > 0, `PERMISSION_MODE_RETRY_BASE_MS read from sidepanel.js (=${BASE})`);
ok(Number.isFinite(MAX) && MAX >= BASE * 2, `PERMISSION_MODE_RETRY_MAX_MS read from sidepanel.js (=${MAX})`);

console.log("== a failed load surfaces on the trigger and schedules the first retry ==");
{
  client.fail = true;
  await runLoad();
  ok(/Không tải được/.test(deps.el.modeTrigger.title), "the failure is surfaced on the trigger title, never swallowed");
  ok(/thử lại/.test(deps.el.modeTrigger.title), "...and says a retry is coming");
  ok(timers.length === 1 && timers[0].ms === BASE, `the first retry is scheduled at the base delay (${BASE}ms)`);
  ok(renders === 0, "renderModeMenu did NOT run on failure (an empty menu is never presented as loaded)");
  ok(permissionMode.syncing === false, "syncing is released so the retry can actually run");
  ok(permissionModeRetry.delayMs === Math.min(BASE * 2, MAX), "the ladder doubled for the next failure");
}

console.log("== one retry in flight at a time: a second failure before the timer fires neither stacks nor doubles ==");
{
  const before = timers.length;
  await runLoad();
  ok(timers.length === before, "a second failure while a retry is pending does not stack a second timer");
  ok(permissionModeRetry.delayMs === Math.min(BASE * 2, MAX), "...and does not grow the ladder mid-flight");
}

console.log("== the retry fires, still fails, and the next attempt backs off ==");
{
  const before = timers.length;
  timers[timers.length - 1].cb();
  await settle();
  ok(timers.length === before + 1 && timers[timers.length - 1].ms === Math.min(BASE * 2, MAX), `the next failure backs off to 2×base (${Math.min(BASE * 2, MAX)}ms)`);
}

console.log("== a success renders the menu and resets the ladder ==");
{
  client.fail = false;
  client.result = { mode: "manual", modeSource: "local" };
  timers[timers.length - 1].cb();
  await settle();
  ok(renders === 1, "a successful retry renders the menu");
  ok(permissionModeRetry.timer === null, "no retry remains scheduled after success");
  ok(permissionModeRetry.delayMs === BASE, "the ladder resets to base for the next unrelated failure");
}

console.log("== a success while a retry is pending cancels that retry ==");
{
  client.fail = true;
  await runLoad();
  const pending = timers[timers.length - 1];
  ok(!pending.cleared, "a retry is pending after the failure");
  client.fail = false;
  await runLoad();
  ok(pending.cleared === true, "the pending retry was cancelled by the successful load");
  ok(permissionModeRetry.timer === null && permissionModeRetry.delayMs === BASE, "timer reference cleared and ladder reset");
}

console.log("== a retry firing while the handshake is down does not call load ==");
{
  client.fail = true;
  await runLoad();
  handshake = "down";
  const calls = clientCalls;
  timers[timers.length - 1].cb();
  await settle();
  ok(clientCalls === calls, "no get_permission_state was attempted while disconnected — the fresh-handshake path owns the reload");
}

console.log("");
if (fail) {
  console.log(`${fail} FAILED`);
  process.exit(1);
}
console.log("ALL PERMISSION-MODE RETRY TESTS PASSED");

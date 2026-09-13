// Unit tests for the agent pointer overlay (extension/overlay/pointer-overlay.js
// — design.md 5c / task 5.9, redesigned per
// openspec/changes/redesign-remote-control-overlay). Same extraction
// technique test/handlers.test.mjs and test/action-events-emission.test.mjs
// already use for extension/background.js (test/_extract.mjs's brace-matching
// extractor), pointed at this file instead — see that file's own header
// comment for exactly why it is a classic (non-module) script rather than an
// ES module, which is what makes this the right way to test it (no bundler,
// no second copy of the logic, runs the REAL shipped source).
//
// No jsdom/puppeteer dependency exists in this repo (grepped package-lock.json
// — none), so DOM-touching functions are tested against a small hand-rolled
// fake `document`, matching the rest of this codebase's convention
// (test/handlers.test.mjs's fake chrome.*, etc.) rather than pulling in a new
// dependency for this one file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction, compile } from "./_extract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY_FILE = path.join(ROOT, "extension", "overlay", "pointer-overlay.js");
const SRC = fs.readFileSync(OVERLAY_FILE, "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const extract = (name) => extractFunction(name, OVERLAY_FILE);

// Every pure-function test below that touches computeRenderModel needs the
// same label maps the shipped source defines at module scope (design.md D1) —
// these are the REAL values, copied here once so the label-coverage
// assertions below are checking the real taxonomy, not a stand-in.
const ACTION_LABELS = {
  open_page: "Đang mở trang", read: "Đang đọc trang", find: "Đang tìm nội dung",
  click: "Đang nhấp", hover: "Đang di chuột", scroll: "Đang cuộn trang",
  type: "Đang nhập nội dung", wait: "Đang chờ", drag: "Đang kéo",
  capture: "Đang chụp trang", script: "Đang chạy script", other: "Đang thao tác"
};
const IDLE_ACTION_LABEL = "Đang nghĩ…";
const POINTER_ACTION_TYPES = { click: true, hover: true, scroll: true, drag: true };
const CURSOR_ACTION_LABELS = { click: "click", hover: "di chuột", scroll: "cuộn", drag: "kéo" };
const CURSOR_IDLE_LABEL = "đang nghĩ";
// Task 7.7: same real values as the shipped RISK_LABELS/DEFAULT_RISK_CATEGORY.
const RISK_LABELS = { uncategorized: "Chưa phân loại", low: "Rủi ro thấp", elevated: "Rủi ro cao" };
const DEFAULT_RISK_CATEGORY = "uncategorized";
const computeRenderModelDeps = {
  HEARTBEAT_MAX_AGE_MS: 2700,
  CLICK_RING_DURATION_MS: 350,
  ACTION_LABELS, IDLE_ACTION_LABEL, POINTER_ACTION_TYPES, CURSOR_ACTION_LABELS, CURSOR_IDLE_LABEL,
  RISK_LABELS, DEFAULT_RISK_CATEGORY
};

// =============================================================================
// 1. Pure geometry: pointer.points[].x/.y already ARE the exact dispatched
//    CSS-pixel viewport coordinates (action-events.js's own contract) — the
//    same coordinate space `position:fixed` uses — so scroll/zoom/DPR need NO
//    transform. Proven by showing resolveViewportPoint is a pure function of
//    (point, frame) alone: it has no scroll/zoom/DPR parameter to feed a
//    wrong value into in the first place, and passes coordinates through
//    unchanged except for a genuinely-declared frame offset.
// =============================================================================
console.log("== resolveViewportPoint: identity passthrough, forward-declared frame offset ==");
{
  const resolveViewportPoint = compile(extract("resolveViewportPoint"), {}, "resolveViewportPoint");
  ok(!/scrollX|scrollY|devicePixelRatio|innerWidth|innerHeight/.test(extract("resolveViewportPoint")),
     "the function's own source never reads scroll/DPR/viewport globals — nothing to get backwards");

  const same = resolveViewportPoint({ x: 412, y: 220, t: 1, phase: "move" }, { frameId: 0, isMainFrame: true });
  ok(same.x === 412 && same.y === 220, "today's always-{frameId:0,isMainFrame:true} frame -> exact passthrough (no double-counted transform)");

  const noFrame = resolveViewportPoint({ x: 5, y: 9 }, null);
  ok(noFrame.x === 5 && noFrame.y === 9, "a missing frame object is also identity, never a thrown error");

  const withOffset = resolveViewportPoint({ x: 100, y: 100 }, { offsetX: 30, offsetY: -10 });
  ok(withOffset.x === 130 && withOffset.y === 90, "a future real per-frame offset (once content.js starts populating it) is additive, not ignored");

  // Regression guard: this must NEVER independently re-derive a "corrected"
  // coordinate from scroll/zoom/DPR — that would double-count values the
  // dispatch coordinate already accounts for (the exact bug class design.md
  // 5c's coordinate-math requirement exists to prevent).
  const zoomedLikeInput = resolveViewportPoint({ x: 800, y: 600 }, { frameId: 0, isMainFrame: true });
  ok(zoomedLikeInput.x === 800 && zoomedLikeInput.y === 600,
     "a coordinate from a zoomed/high-DPR/scrolled page (already resolved by the browser+CDP) is not re-transformed a second time");
}

// =============================================================================
// 2. Heartbeat expiry — the "at most 3 seconds" hard bound, and the two
//    tuned constants that implement it.
// =============================================================================
console.log("\n== isHeartbeatExpired + the <=3s bound the two tuned constants implement ==");
{
  const isHeartbeatExpired = compile(extract("isHeartbeatExpired"), {}, "isHeartbeatExpired");
  ok(isHeartbeatExpired(1000, null, 3000) === true, "never having seen an event at all is NOT active");
  ok(isHeartbeatExpired(1000, 1000, 3000) === false, "an event that just happened is fresh");
  ok(isHeartbeatExpired(4000, 1000, 3000) === false, "exactly at the boundary (3000ms elapsed) is still NOT expired (strictly greater-than)");
  ok(isHeartbeatExpired(4001, 1000, 3000) === true, "one ms past the bound IS expired");

  const maxAgeMatch = SRC.match(/HEARTBEAT_MAX_AGE_MS\s*=\s*(\d+)/);
  const intervalMatch = SRC.match(/HEARTBEAT_CHECK_INTERVAL_MS\s*=\s*(\d+)/);
  ok(!!maxAgeMatch && !!intervalMatch, "both tuned constants found in the shipped source");
  const maxAge = Number(maxAgeMatch[1]);
  const interval = Number(intervalMatch[1]);
  ok(maxAge + interval <= 3000,
     `HEARTBEAT_MAX_AGE_MS(${maxAge}) + HEARTBEAT_CHECK_INTERVAL_MS(${interval}) = ${maxAge + interval} <= 3000 — ` +
     `the periodic re-check (not just a new event) is what actually clears a stale badge when NOTHING more arrives, ` +
     `and this arithmetic is what keeps the worst-case observed staleness under the 3s requirement`);
}

console.log("\n== isCaptureHideInForce: a lost restore cannot hide the overlay for the rest of the run ==");
// The screenshot path hides this layer and restores it with a second,
// fire-and-forget message. That message can be lost outright — injection
// refused mid-navigation, the tab busy, the service worker torn down between
// the two halves — and nothing but another capture ever writes the flag again.
// The overlay then sat at visibility:hidden on a live run, drawing nothing: the
// probe's `present:true, vis:hidden` state, indistinguishable to the operator
// from no overlay at all. So the hide expires here the same way the heartbeat
// does, and the 250ms re-check timer is what actually notices.
{
  const isCaptureHideInForce = compile(extract("isCaptureHideInForce"), {}, "isCaptureHideInForce");
  ok(isCaptureHideInForce(1000, null, 2000) === false, "no hide outstanding is not hidden");
  ok(isCaptureHideInForce(1000, 1000, 2000) === true, "a hide that just arrived holds — a real capture must not catch the overlay in its own image");
  ok(isCaptureHideInForce(3000, 1000, 2000) === true, "exactly at the bound it still holds");
  ok(isCaptureHideInForce(3001, 1000, 2000) === false, "one ms past it, the restore is never coming and the overlay comes back on its own");

  const hideMatch = SRC.match(/CAPTURE_HIDE_MAX_AGE_MS\s*=\s*(\d+)/);
  ok(!!hideMatch, "the tuned constant is found in the shipped source");
  const hideMaxAge = Number(hideMatch[1]);
  const heartbeatMaxAge = Number(SRC.match(/HEARTBEAT_MAX_AGE_MS\s*=\s*(\d+)/)[1]);
  ok(hideMaxAge >= 1000,
     `CAPTURE_HIDE_MAX_AGE_MS(${hideMaxAge}) leaves room for a real screenshot round trip — expiring mid-capture would put the overlay INTO the image the agent reads coordinates off`);
  ok(hideMaxAge <= heartbeatMaxAge,
     `and never outlives the heartbeat itself(${heartbeatMaxAge}): a hidden overlay must not be the thing that survives longest after the host goes quiet`);

  // The expiry is only reachable if the paint actually consults it, and the
  // periodic timer is what re-paints when no further message ever arrives.
  // design.md D3: the bound is now the LEASE's own maxMs (background mints
  // it), not a hardcoded constant — updated shape per task 11.1.
  ok(/isCaptureHideInForce\(\s*now,\s*capturedHiddenAt,\s*capturedMaxMs\s*\)/.test(SRC), "paintNow asks the clock (with the lease's own bound) rather than reading a sticky boolean");
  ok(/capturedHiddenAt = hidden \? Date\.now\(\) : null;/.test(SRC), "and the capture message records WHEN it was hidden, not merely that it was");
}

// =============================================================================
// 3. The overlay state machine: no fabricated pointer motion for a DOM/
//    script-only action, movement only from a real dispatched `progress`
//    event, click-ring/drag-held derivation, step count / start time
//    accumulation, approval pending/resolved, and immediate teardown.
// =============================================================================
console.log("\n== reduceOverlayState: never fabricates, only reflects real dispatched events ==");
{
  const reduceOverlayState = compile(
    [extract("resolveViewportPoint"), extract("reduceOverlayState")].join("\n\n"),
    {},
    "reduceOverlayState"
  );
  const initial = {
    lastEventAt: null, cursor: null, clickAt: null, dragHeld: false,
    runId: null, conversationId: null, tabId: null, lastActionType: null,
    stepCount: 0, startedAt: null, pendingApproval: null, actionInFlight: false
  };

  // A pointer click: start (no pointer), then a progress carrying a real
  // dispatched down+move+up batch.
  let s = reduceOverlayState(initial, { kind: "start", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "click", tool: "computer", op: "left_click" }, timing: { startedAt: 999 } }, 1000);
  ok(s.cursor === null, "a `start` event alone never invents a cursor position");
  ok(s.stepCount === 1, "a `start` event increments the step counter (design.md D2)");
  ok(s.startedAt === 999, "the first event's own timing.startedAt is captured as the run's start time");
  ok(s.actionInFlight === true, "a `start` event marks an action in flight (Finding 2)");
  s = reduceOverlayState(s, {
    kind: "progress", runId: "r1", conversationId: "c1", tabId: 7,
    action: { type: "click" },
    pointer: { points: [{ x: 10, y: 10, t: 1001, phase: "move" }, { x: 12, y: 12, t: 1002, phase: "down" }, { x: 12, y: 12, t: 1003, phase: "up" }], frame: { frameId: 0, isMainFrame: true } }
  }, 1003);
  ok(s.cursor.x === 12 && s.cursor.y === 12, "cursor moves to the LAST real dispatched point in the batch, not the first or an average");
  ok(s.clickAt === 1003, "a `down` phase anywhere in the batch marks the click-ring timestamp");
  ok(s.dragHeld === false, "a plain click never sets drag-held");
  ok(s.stepCount === 1, "a `progress` event never increments the step counter — only `start` does");
  ok(s.startedAt === 999, "startedAt is captured once and never overwritten by a later event");
  ok(s.actionInFlight === true, "still in flight through its progress event");
  s = reduceOverlayState(s, { kind: "complete", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "click" }, pointer: null, outcome: { status: "success", detail: null } }, 1004);
  ok(s.actionInFlight === false, "`complete` settles the action — actionInFlight clears (Finding 2)");
  ok(s.lastActionType === "click", "...while lastActionType stays \"click\" — the bar's label and step counter still need it");

  // DOM/script-only action: no pointer field at all — cursor must be left
  // exactly where it was (never reset to null, never moved).
  const beforeScript = s;
  s = reduceOverlayState(s, { kind: "start", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "script", tool: "javascript_tool", op: null }, pointer: null }, 2000);
  ok(s.cursor.x === beforeScript.cursor.x && s.cursor.y === beforeScript.cursor.y,
     "a script-only action's `start` never moves or clears the cursor — the pointer genuinely did not move");
  ok(s.stepCount === 2, "a second `start` (this one a script call) still counts as a step");
  s = reduceOverlayState(s, { kind: "complete", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "script" }, pointer: null }, 2010);
  ok(s.cursor.x === beforeScript.cursor.x && s.cursor.y === beforeScript.cursor.y,
     "...nor does its `complete` — no fabricated motion at either end of a DOM/script-only action");

  // Drag: held true while progress carries pointer samples, cleared on complete.
  let d = reduceOverlayState(initial, { kind: "start", runId: "r2", conversationId: "c1", tabId: 7, action: { type: "drag", tool: "computer", op: "left_click_drag" } }, 3000);
  d = reduceOverlayState(d, { kind: "progress", runId: "r2", conversationId: "c1", tabId: 7, action: { type: "drag" }, pointer: { points: [{ x: 1, y: 1, phase: "down" }, { x: 50, y: 50, phase: "move" }] } }, 3010);
  ok(d.dragHeld === true, "a drag action's progress sets dragHeld");
  ok(reduceOverlayState(initial, { kind: "start", runId: "r2", conversationId: "c1", tabId: 7, action: { type: "drag", tool: "computer", op: "left_click_drag" } }, 3000).actionInFlight === true,
     "a drag's own `start` also marks an action in flight");
  d = reduceOverlayState(d, { kind: "complete", runId: "r2", conversationId: "c1", tabId: 7, action: { type: "drag" }, pointer: null, outcome: { status: "success", detail: null } }, 3050);
  ok(d.dragHeld === false, "dragHeld clears the instant the drag action settles (complete)");
  ok(d.actionInFlight === false, "...and actionInFlight clears alongside it");

  // Hover/scroll are pointer-capable too, per action-events.js's own
  // POINTER_ACTION_TYPES — the overlay must accept their pointer payload
  // exactly like click/drag, never treating them as DOM-only.
  let h = reduceOverlayState(initial, { kind: "progress", runId: "r3", conversationId: "c1", tabId: 7, action: { type: "hover" }, pointer: { points: [{ x: 77, y: 88, phase: "move" }] } }, 4000);
  ok(h.cursor.x === 77 && h.cursor.y === 88, "hover's dispatched point moves the cursor too, not just click/drag");

  // Approval: pending sets it, refreshes liveness, never touches cursor/click.
  const beforeApproval = d;
  const pending = reduceOverlayState(beforeApproval, { kind: "approval", phase: "pending", requestId: "req_1", action: "computer click (submit-type control)", target: { tabId: 7 } }, 4000);
  ok(pending.pendingApproval && pending.pendingApproval.requestId === "req_1", "a pending approval is recorded verbatim");
  ok(pending.pendingApproval.action === "computer click (submit-type control)", "...with the real action descriptor the host sent, never invented text");
  ok(pending.lastEventAt === 4000, "a pending approval refreshes liveness — it is proof the run is alive");
  ok(pending.cursor && pending.cursor.x === beforeApproval.cursor.x && pending.cursor.y === beforeApproval.cursor.y,
     "an approval signal never touches the cursor — a run waiting for permission has not moved the pointer");
  ok(pending.clickAt === beforeApproval.clickAt && pending.dragHeld === beforeApproval.dragHeld,
     "...nor the click ring or drag-held state");
  ok(pending.stepCount === beforeApproval.stepCount && pending.startedAt === beforeApproval.startedAt,
     "...nor the step count or start time — approval is not a dispatched action");

  // Resolved for the SAME requestId clears it.
  const resolvedMatching = reduceOverlayState(pending, { kind: "approval", phase: "resolved", requestId: "req_1" }, 4100);
  ok(resolvedMatching.pendingApproval === null, "a resolved decision for the matching requestId clears the pending approval");

  // Resolved for an unknown/mismatched requestId is a silent no-op.
  const resolvedMismatch = reduceOverlayState(pending, { kind: "approval", phase: "resolved", requestId: "some_other_request" }, 4100);
  ok(resolvedMismatch.pendingApproval && resolvedMismatch.pendingApproval.requestId === "req_1",
     "a resolved decision for a DIFFERENT requestId never clears an unrelated pending approval — silent no-op, not an error");
  const resolvedNoneWaiting = reduceOverlayState(beforeApproval, { kind: "approval", phase: "resolved", requestId: "req_never_pending" }, 4100);
  ok(resolvedNoneWaiting.pendingApproval === null, "a resolved decision when nothing is pending is also a silent no-op, not a crash");

  // Teardown: immediate, hard clear — the overlay's local heartbeat would
  // eventually reach the same result, but an explicit signal (Stop,
  // debugger detach, companion loss — extension/background.js's
  // teardownOverlayForRun/teardownAllOverlays) must not have to wait for it.
  const torn = reduceOverlayState(pending, { kind: "teardown" }, 3100);
  ok(torn.lastEventAt === null, "teardown hard-clears lastEventAt — the very next render check reports inactive with no timer to wait out");
  ok(torn.cursor && torn.cursor.x === 50 || torn.dragHeld === false, "teardown does not fabricate a NEW cursor position either — it only stops claiming activity");
  ok(torn.pendingApproval === null, "teardown also clears a pending approval — it never outlives the run that raised it");
  ok(torn.stepCount === pending.stepCount && torn.startedAt === pending.startedAt,
     "teardown preserves the step count/start time it already had (nothing left to show once inactive, but nothing corrupted either)");
}

console.log("\n== reduceOverlayState: task 7.7 riskUpdate — a real signal, never a fabricated category ==");
{
  const reduceOverlayState = compile(
    [extract("resolveViewportPoint"), extract("reduceOverlayState")].join("\n\n"),
    {},
    "reduceOverlayState"
  );
  const initial = {
    lastEventAt: null, cursor: null, clickAt: null, dragHeld: false,
    runId: null, conversationId: null, tabId: null, lastActionType: null,
    stepCount: 0, startedAt: null, pendingApproval: null, actionInFlight: false, riskCategory: null
  };
  const low = reduceOverlayState(initial, { kind: "riskUpdate", tabId: 7, category: "low" }, 1000);
  ok(low.riskCategory === "low", "a real riskUpdate event records the reported category");
  ok(low.lastEventAt === 1000, "a riskUpdate refreshes liveness — it is proof the run is alive");
  ok(low.tabId === 7, "...and it can carry the tabId along with it");

  const elevated = reduceOverlayState(low, { kind: "riskUpdate", tabId: 7, category: "elevated" }, 1100);
  ok(elevated.riskCategory === "elevated", "a later riskUpdate overwrites the category with the new one");

  const backToUncategorized = reduceOverlayState(elevated, { kind: "riskUpdate", tabId: 7, category: "uncategorized" }, 1200);
  ok(backToUncategorized.riskCategory === "uncategorized",
     "a navigation-driven reset back to uncategorized is accepted like any other real value — not treated as an error state");

  const bogus = reduceOverlayState(elevated, { kind: "riskUpdate", tabId: 7, category: "not_a_real_category" }, 1300);
  ok(bogus.riskCategory === "elevated", "an unrecognized category value is dropped, never accepted verbatim — the previous real value stands");

  // A riskUpdate must never touch anything an ordinary dispatched action or
  // approval owns.
  const dispatchState = reduceOverlayState(initial, { kind: "start", runId: "r1", tabId: 7, action: { type: "click" } }, 500);
  const withRisk = reduceOverlayState(dispatchState, { kind: "riskUpdate", tabId: 7, category: "low" }, 600);
  ok(withRisk.cursor === dispatchState.cursor && withRisk.stepCount === dispatchState.stepCount && withRisk.actionInFlight === dispatchState.actionInFlight,
     "a riskUpdate never touches cursor/step count/actionInFlight — it is state about the page, not a dispatched action");

  // An ordinary dispatched action never clears or invents a risk category.
  const afterAction = reduceOverlayState(withRisk, { kind: "complete", runId: "r1", tabId: 7, action: { type: "click" }, pointer: null }, 700);
  ok(afterAction.riskCategory === "low", "an ordinary action event passes the risk category through unchanged");

  const afterTeardown = reduceOverlayState(withRisk, { kind: "teardown" }, 800);
  ok(afterTeardown.riskCategory === "low", "teardown preserves the last known risk category — it is a fact about the page, not the run that just ended");
}

// =============================================================================
// 4. computeRenderModel: active/inactive derivation, click-ring fade window,
//    cursor label per action.type (including the non-pointer fallback), the
//    three cursor states, the three bar states, and step count / elapsed
//    time formatting.
// =============================================================================
console.log("\n== computeRenderModel: active is DERIVED from recency, not a stored flag ==");
{
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const freshState = { lastEventAt: 1000, cursor: { x: 5, y: 5 }, clickAt: 1000, dragHeld: false, lastActionType: "click", stepCount: 1, startedAt: 1000, pendingApproval: null };
  const fresh = computeRenderModel(freshState, 1100, 3000);
  ok(fresh.active === true && fresh.cursor.x === 5, "recent activity -> active, cursor surfaced");
  ok(fresh.clickRing === true, "click ring still visible just after the click");

  const laterSameState = computeRenderModel(freshState, 1600, 3000);
  ok(laterSameState.clickRing === false, "click ring fades out on its own short timer, well before heartbeat expiry — the SAME underlying state, only `nowMs` changed");
  ok(laterSameState.active === true, "...while `active` itself is still true (only the ring faded, not the whole overlay)");

  const stale = computeRenderModel(freshState, 5000, 3000);
  ok(stale.active === false && stale.cursor === null && stale.badge === false,
     "once the heartbeat window has elapsed with NO new event, computeRenderModel reports fully inactive — this is what makes a disconnected host stop showing a misleading badge");
  ok(stale.approval === null && stale.barState === "idle",
     "an inactive render model never surfaces a pending approval either — it shares the same heartbeat-driven clearing as everything else");
}

console.log("\n== computeRenderModel: task 7.7 risk chip — uncategorized distinguishable from low, never fabricated ==");
{
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const base = { lastEventAt: 1000, cursor: null, clickAt: null, dragHeld: false, lastActionType: null, stepCount: 0, startedAt: null, pendingApproval: null, actionInFlight: false };

  const never = computeRenderModel({ ...base, riskCategory: null }, 1050, 3000);
  ok(never.riskCategory === "uncategorized" && never.riskLabel === RISK_LABELS.uncategorized,
     "no riskUpdate ever seen -> the render model defaults to uncategorized, never fabricating low/elevated");

  const low = computeRenderModel({ ...base, riskCategory: "low" }, 1050, 3000);
  ok(low.riskCategory === "low" && low.riskLabel === RISK_LABELS.low && low.riskLabel !== never.riskLabel,
     "a real 'low' category renders its OWN distinct label — never collapsed into uncategorized's wording (spec: distinguishable)");

  const elevated = computeRenderModel({ ...base, riskCategory: "elevated" }, 1050, 3000);
  ok(elevated.riskCategory === "elevated" && elevated.riskLabel === RISK_LABELS.elevated, "elevated renders its own distinct label too");

  const inactive = computeRenderModel({ ...base, riskCategory: "elevated" }, 9000, 3000);
  ok(inactive.active === false && inactive.riskCategory === null && inactive.riskLabel === "",
     "once the heartbeat has expired, the risk chip shows nothing — same fate as every other field once the run is gone");
}

console.log("\n== computeRenderModel: cursor label per action.type, including the non-pointer fallback ==");
{
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const base = { lastEventAt: 1000, cursor: { x: 1, y: 1 }, clickAt: null, dragHeld: false, stepCount: 1, startedAt: 500, pendingApproval: null, actionInFlight: true };

  for (const type of Object.keys(POINTER_ACTION_TYPES)) {
    const m = computeRenderModel({ ...base, lastActionType: type }, 1050, 3000);
    ok(m.cursorLabel === CURSOR_ACTION_LABELS[type], `cursor label for pointer-capable "${type}" is "${CURSOR_ACTION_LABELS[type]}"`);
    ok(m.actionLabel === ACTION_LABELS[type], `bar action label for "${type}" is the real map entry, not the cursor's short form`);

    // Finding 2: the SAME pointer-capable type, once settled (actionInFlight
    // false), must fall back to the idle cursor wording — lastActionType
    // alone is never enough to claim "acting".
    const settled = computeRenderModel({ ...base, lastActionType: type, actionInFlight: false }, 1050, 3000);
    ok(settled.cursorState === "idle" && settled.cursorLabel === CURSOR_IDLE_LABEL,
       `a settled (no longer in-flight) "${type}" falls back to the idle cursor, never re-claiming the action (Finding 2)`);
    ok(settled.actionLabel === ACTION_LABELS[type], `...while the BAR's action label is unaffected by actionInFlight — only the cursor's claim is constrained`);
  }

  // A read/script/capture/type/wait/find/open_page/other event moves no
  // pointer — the cursor's OWN label must fall back to the idle wording
  // even while the cursor dot may still be drawn at its last known
  // position (task 2.5's "never fabricate the label" rule).
  for (const type of ["read", "script", "capture", "type", "wait", "find", "open_page", "other"]) {
    const m = computeRenderModel({ ...base, lastActionType: type }, 1050, 3000);
    ok(m.cursorLabel === CURSOR_IDLE_LABEL, `cursor label for non-pointer "${type}" falls back to the idle wording, never claiming an action`);
    ok(m.cursorState === "idle", `cursor state for non-pointer "${type}" is idle, not "acting"`);
    ok(m.actionLabel === ACTION_LABELS[type], `the BAR's action label still reports the real "${type}" activity — only the cursor's label is constrained`);
  }

  const dragging = computeRenderModel({ ...base, lastActionType: "drag", dragHeld: true }, 1050, 3000);
  ok(dragging.cursorState === "dragging", "dragHeld -> cursorState is dragging, distinct from a plain pointer action");

  const neverActed = computeRenderModel({ ...base, lastActionType: null }, 1050, 3000);
  ok(neverActed.cursorLabel === CURSOR_IDLE_LABEL && neverActed.actionLabel === IDLE_ACTION_LABEL,
     "no action ever seen yet -> idle wording on both the cursor and the bar");
}

console.log("\n== computeRenderModel: three bar states, step count, elapsed time ==");
{
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const running = computeRenderModel(
    { lastEventAt: 5000, cursor: null, clickAt: null, dragHeld: false, lastActionType: "read", stepCount: 3, startedAt: 2000, pendingApproval: null },
    5000, 3000
  );
  ok(running.barState === "running", "a real action already dispatched, no pending approval -> running");
  ok(running.stepCount === 3, "step count passed through from state");
  ok(running.elapsedLabel === "3s", "elapsed time formatted in whole seconds under a minute");

  const longRunning = computeRenderModel(
    { lastEventAt: 70000, cursor: null, clickAt: null, dragHeld: false, lastActionType: "read", stepCount: 9, startedAt: 5000, pendingApproval: null },
    70000, 3000
  );
  ok(longRunning.elapsedLabel === "1m 5s", "elapsed time over a minute formats as minutes and seconds");

  const idle = computeRenderModel(
    { lastEventAt: 1000, cursor: null, clickAt: null, dragHeld: false, lastActionType: null, stepCount: 0, startedAt: null, pendingApproval: null },
    1000, 3000
  );
  ok(idle.barState === "idle", "active, but no action dispatched yet on this attach -> idle, not running");

  const waiting = computeRenderModel(
    {
      lastEventAt: 5000, cursor: null, clickAt: null, dragHeld: false, lastActionType: "click", stepCount: 2, startedAt: 2000,
      pendingApproval: { requestId: "req_9", action: "computer click (submit-type control)", target: { tabId: 7 } }
    },
    5000, 3000
  );
  ok(waiting.barState === "waiting", "a pending approval takes priority over a real in-flight action label");
  ok(waiting.approval.requestId === "req_9" && waiting.approval.action === "computer click (submit-type control)",
     "the waiting render model carries the real requestId/action the host sent, never a summary invented here");
}

// =============================================================================
// 5. Render throttle: proves the SAME thing action-events.js's emission bus
//    proves for dispatch (Batch 1) — a subscriber can be slow/coalesced
//    without the underlying stream being altered. Here: many render requests
//    before a frame fires collapse to exactly one scheduled callback, and it
//    always reflects the LATEST request, never a stale one.
// =============================================================================
console.log("\n== createRenderScheduler: coalesces paint calls, never the state update itself ==");
{
  const createRenderScheduler = compile(extract("createRenderScheduler"), {}, "createRenderScheduler");
  const pendingFrames = [];
  const fakeScheduleFrame = (fn) => pendingFrames.push(fn);
  const requestRender = createRenderScheduler(fakeScheduleFrame);

  let renderCount = 0;
  let lastValueSeen = null;
  let currentValue = "v0";
  requestRender(() => { renderCount++; lastValueSeen = currentValue; });
  currentValue = "v1";
  requestRender(() => { renderCount++; lastValueSeen = currentValue; }); // coalesced — scheduleFrame must NOT be called again
  currentValue = "v2";
  requestRender(() => { renderCount++; lastValueSeen = currentValue; });

  ok(pendingFrames.length === 1, `three rapid requestRender() calls scheduled exactly one frame callback (got ${pendingFrames.length})`);
  ok(renderCount === 0, "nothing has actually painted yet — requestRender() itself never runs the callback synchronously (never delays the CALLER either)");
  pendingFrames[0](); // manually "fire" the animation frame
  ok(renderCount === 1, "exactly one paint happened once the frame actually fired");
  ok(lastValueSeen === "v2", "the paint reflects the LATEST state at flush time, not the first stale request that happened to schedule the frame");

  // After a flush, a new request schedules a NEW frame — the throttle isn't
  // a one-shot latch.
  requestRender(() => { renderCount++; });
  ok(pendingFrames.length === 2, "a request AFTER a flush schedules a fresh frame");
}

// =============================================================================
// 6. Wiring: state updates happen SYNCHRONOUSLY on every real event, and only
//    the (expensive, visual) paint step is deferred — proving the throttle
//    never alters the action schedule. This exercises handleOverlayEvent/
//    attach/scheduleRepaint/setCapturedHidden TOGETHER (they share the same
//    module-level `state`/`refs`/`capturedHiddenAt` closure in the real file),
//    against a hand-rolled fake DOM/chrome/window — no jsdom dependency.
// =============================================================================
// Shared fake-DOM element factory — used by the wiring harness below AND by
// the smaller, isolated harnesses further down (eager mount, capture lease)
// so every harness gets a fully-functional fake element (appendChild,
// removeChild/parentNode, classList) rather than a partial stub.
function makeFakeElement(tag) {
  const el = {
    tag,
    style: {},
    attrs: {},
    children: [],
    listeners: {},
    hidden: false,
    textContent: "",
    innerHTML: "",
    className: "",
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(child) { this.children.push(child); child.__parent = this; child.parentNode = this; return child; },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      child.parentNode = null;
      child.__parent = undefined;
      return child;
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({})); },
    classList: {
      _set: new Set(),
      toggle(name, force) {
        const has = this._set.has(name);
        const want = force === undefined ? !has : !!force;
        if (want) this._set.add(name); else this._set.delete(name);
        return want;
      },
      contains(name) { return this._set.has(name); },
      remove(name) { this._set.delete(name); }
    },
    attachShadow() {
      const shadow = makeFakeElement("#shadow-root");
      this.__shadow = shadow;
      return shadow;
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some((c) => c === node || (typeof c.contains === "function" && c.contains(node)));
    }
  };
  return el;
}

console.log("\n== wiring: state is updated the instant an event is handled, painting is what's throttled ==");
{
  const documentElement = makeFakeElement("html");
  const head = makeFakeElement("head");
  const fakeDocument = {
    documentElement,
    head,
    body: makeFakeElement("body"),
    createElement: makeFakeElement
  };
  const sentMessages = [];
  const fakeChrome = {
    runtime: {
      sendMessage: (msg) => sentMessages.push(msg),
      onMessage: { addListener() {} }
    }
  };
  // requestAnimationFrame/cancelAnimationFrame are a REAL (fake) queue, not
  // `undefined` — task 11.9 requires this so the D5 cursor-easing loop and
  // D8's window.addEventListener-based blockers are both exercisable.
  // cancelAnimationFrame really removes the pending callback (matching a
  // real browser) so stopCursorAnimation()'s cancellation is provable rather
  // than merely trusted.
  let frameId = 0;
  const frameQueue = [];
  const windowListeners = {};
  const fakeWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    requestAnimationFrame: (fn) => { const id = ++frameId; frameQueue.push({ id, fn }); return id; },
    cancelAnimationFrame: (id) => {
      const idx = frameQueue.findIndex((f) => f.id === id);
      if (idx !== -1) frameQueue.splice(idx, 1);
    },
    addEventListener(type, fn, opts) { (windowListeners[type] = windowListeners[type] || []).push({ fn, opts }); },
    removeEventListener(type, fn) {
      if (!windowListeners[type]) return;
      windowListeners[type] = windowListeners[type].filter((l) => l.fn !== fn);
    }
  };
  /** Fire exactly the frames queued AT THE MOMENT this is called — not
   * whatever firing them enqueues next (the cursor-easing loop reschedules
   * itself every time it runs while visible, so an unbounded drain would
   * never terminate). Calling this twice reliably settles both the
   * coalesced paint AND the cursor-easing loop's own next frame, in
   * whichever order they happen to queue in. */
  function drainFrames() {
    const n = frameQueue.length;
    for (let i = 0; i < n; i++) {
      const item = frameQueue.shift();
      if (item) item.fn();
    }
  }
  function settle() { drainFrames(); drainFrames(); }
  function dispatchWindowEvent(type, evt) {
    (windowListeners[type] || []).forEach(({ fn }) => fn(evt));
  }
  function makeFakeEvent(type, overrides) {
    const evt = {
      type,
      isTrusted: true,
      target: fakeDocument.body,
      _prevented: false,
      _stopped: false,
      preventDefault() { evt._prevented = true; },
      stopImmediatePropagation() { evt._stopped = true; }
    };
    return Object.assign(evt, overrides || {});
  }

  const varBlockStart = SRC.indexOf("var state = {");
  const rrMarker = "var requestRender = createRenderScheduler(";
  // The naive `indexOf(");")` would stop at the FIRST occurrence, which is
  // inside the ternary's own inline function bodies
  // (`function (fn) { window.requestAnimationFrame(fn); }`) — anchor on the
  // real closing line's own exact indentation instead (this file's IIFE
  // body is 2-space indented) so the slice captures the WHOLE call.
  const varBlockEnd = SRC.indexOf("\n  );", SRC.indexOf(rrMarker)) + "\n  );".length;
  const varBlock = SRC.slice(varBlockStart, varBlockEnd);
  ok(varBlockStart !== -1 && varBlockEnd > varBlockStart, "located the real wiring var-declaration block in the shipped source");

  const wiringSrc = [
    extract("createRenderScheduler"),
    extract("resolveViewportPoint"),
    extract("reduceOverlayState"),
    extract("isHeartbeatExpired"),
    extract("isCaptureHideInForce"),
    extract("easeTowardTarget"),
    extract("shouldBlockInput"),
    extract("computeRenderModel"),
    extract("createOverlayHost"),
    extract("paintOverlay"),
    extract("paintCursorPosition"),
    varBlock,
    extract("attach"),
    extract("setWaitCursorActive"),
    extract("stopCursorAnimation"),
    extract("stepCursorAnimation"),
    extract("ensureCursorAnimation"),
    extract("handleBlockableEvent"),
    extract("registerInputBlockers"),
    extract("removeInputBlockers"),
    extract("reportSuppressedInput"),
    extract("paintNow"),
    extract("scheduleRepaint"),
    extract("handleOverlayEvent"),
    extract("setCapturedHidden"),
    extract("handleCaptureMessage"),
    "registerInputBlockers();"
  ].join("\n\n");

  const scheduledTimeouts = [];
  const fakeSetTimeout = (fn) => scheduledTimeouts.push(fn);

  const W = compile(
    wiringSrc,
    {
      document: fakeDocument,
      window: fakeWindow,
      chrome: fakeChrome,
      OVERLAY_CSS: "/* test css */",
      CURSOR_SVG: "<svg></svg>",
      CORNER_SVGS: "<svg></svg>",
      BADGE_TRACE_SVG: "<svg></svg>",
      HEARTBEAT_MAX_AGE_MS: 2700,
      CLICK_RING_DURATION_MS: 350,
      CAPTURE_HIDE_MAX_AGE_MS: 2000,
      CURSOR_EASE_FACTOR: 0.2,
      CURSOR_SNAP_PX: 2,
      CURSOR_LABEL_FLIP_MARGIN_X: 200,
      CURSOR_LABEL_FLIP_MARGIN_Y: 60,
      INPUT_SUPPRESSION_REPORT_WINDOW_MS: 500,
      SCROLL_ACK_TAIL_MS: 300,
      BLOCKABLE_EVENT_TYPES: [
        "pointerdown", "pointerup", "pointermove",
        "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu",
        "wheel",
        "keydown", "keypress", "keyup", "beforeinput",
        "touchstart", "touchmove", "touchend",
        "paste", "drop"
      ],
      WAIT_CURSOR_CSS: "*, *::before, *::after { cursor: wait !important; }",
      ...computeRenderModelDeps,
      setTimeout: fakeSetTimeout
    },
    "({ handleOverlayEvent, setCapturedHidden, handleCaptureMessage, " +
    "get state(){ return state; }, get refs(){ return refs; }, get capturedHiddenAt(){ return capturedHiddenAt; }, " +
    "get drawnCursor(){ return drawnCursor; }, get waitCursorStyleEl(){ return waitCursorStyleEl; } })"
  );

  // Order-of-operations proof: state reflects event N immediately, even
  // though the paint for it has not run (frameQueue still empty of FIRED
  // callbacks — only queued).
  W.handleOverlayEvent({ kind: "start", runId: "run_1", conversationId: "conv_1", tabId: 42, action: { type: "click", tool: "computer", op: "left_click" } });
  ok(W.state.runId === "run_1" && W.state.tabId === 42, "state reflects the event synchronously, the instant handleOverlayEvent returns");
  ok(frameQueue.length === 1, "exactly one paint frame was scheduled for this burst so far");

  W.handleOverlayEvent({
    kind: "progress", runId: "run_1", conversationId: "conv_1", tabId: 42,
    action: { type: "click" }, pointer: { points: [{ x: 20, y: 30, phase: "down" }] }
  });
  ok(W.state.cursor.x === 20 && W.state.cursor.y === 30, "a SECOND event's state update ALSO happens synchronously and immediately");
  ok(frameQueue.length === 1, "the second event did NOT schedule a second paint frame — the throttle coalesced it, exactly like createRenderScheduler's own unit test above");

  ok(W.refs && W.refs.host, "attach() created the overlay host on the first real event");
  ok(documentElement.children.includes(W.refs.host), "the host is attached under documentElement...");
  ok(!fakeDocument.body.children.includes(W.refs.host), "...and NEVER under document.body — this is what keeps it outside the model-facing accessibility/DOM extraction walk (extension/content.js's generateAccessibilityTree starts at document.body)");
  ok(W.refs.host.style.pointerEvents === "none", "the host itself is pointer-events:none — never intercepts page input");

  settle(); // fires the coalesced paint AND the cursor-easing loop's own next frame
  ok(W.refs.host.style.visibility === "visible", "once painted, an active state with a recent event shows the host");
  ok(W.refs.cursorEl.style.left === "20px" && W.refs.cursorEl.style.top === "30px",
     "the painted cursor position matches the LAST real dispatched point — written by the cursor-easing loop (design.md D5), not paintOverlay itself");
  ok(W.refs.cursorEl.attrs["data-state"] === "acting", "a real dispatched click paints the cursor as 'acting'");
  ok(W.refs.badgeEl.attrs["data-state"] === "running", "and the bar as 'running'");
  ok(W.refs.stopButtonEl.hidden === false, "...with the Stop control visible");
  ok(W.refs.openPanelButtonEl.hidden === true, "...and the Open-panel control hidden while running");

  // Task 7.7: the risk chip through the FULL wiring (handleOverlayEvent ->
  // reduceOverlayState -> computeRenderModel -> paintOverlay), not just the
  // pure functions in isolation.
  ok(W.refs.riskEl && W.refs.riskEl.tag === "span", "the risk chip is a plain <span> — not a button, not any interactive element");
  ok(Object.keys(W.refs.riskEl.listeners).length === 0, "...and it has NO event listener of any kind — nothing to click, nothing to acknowledge, nothing to dismiss");
  ok(W.refs.riskEl.attrs["data-level"] === "uncategorized" && W.refs.riskEl.textContent === RISK_LABELS.uncategorized,
     "before any real riskUpdate arrives, the chip shows uncategorized — never fabricated as low");
  W.handleOverlayEvent({ kind: "riskUpdate", tabId: 42, category: "elevated" });
  settle();
  ok(W.refs.riskEl.attrs["data-level"] === "elevated" && W.refs.riskEl.textContent === RISK_LABELS.elevated,
     "a real riskUpdate paints the chip's level and label");
  ok(W.state.pendingApproval === null && W.refs.badgeEl.attrs["data-state"] !== "waiting",
     "a risk-category update never raises a decision — no approval is pending, the bar state is untouched by it");

  // design.md D8/task 7.5: while the agent's own action is genuinely in
  // flight (no `complete`/`error` has settled this click yet), a trusted
  // event on the page must NOT be suppressed — the agent's own CDP
  // dispatch must never be blocked by its own overlay.
  const evtInFlight = makeFakeEvent("click");
  dispatchWindowEvent("click", evtInFlight);
  ok(!evtInFlight._prevented, "a trusted event passes through while state.actionInFlight is true (task 7.5)");

  // Capture exclusion: hides immediately, WITHOUT touching cursor/click state.
  const cursorBefore = { ...W.state.cursor };
  W.setCapturedHidden(true);
  ok(W.refs.host.style.visibility === "hidden", "capture-hide takes effect synchronously, not via the render scheduler (a screenshot cannot wait a frame)");
  ok(W.state.cursor.x === cursorBefore.x && W.state.cursor.y === cursorBefore.y, "hiding for capture never touches the cursor/state — restoring afterward cannot possibly \"change cursor state\"");
  W.setCapturedHidden(false);
  ok(W.refs.host.style.visibility === "visible", "restoring after capture shows the host again, still reflecting the SAME state");

  // Stop button reaches the overlay's own message channel with the run's
  // identity, never a stolen/incorrect one.
  W.refs.stopButtonEl.dispatch("click");
  ok(sentMessages.length === 1 && sentMessages[0].type === "browzyOverlayStop", "clicking Stop sends exactly one browzyOverlayStop message");
  ok(sentMessages[0].conversationId === "conv_1" && sentMessages[0].runId === "run_1", "...carrying the CURRENT run's own identity, not a fabricated or stale one");
  ok(!!fakeDocument.body === true && sentMessages[0].reason === "user_stop", "reason is the standard user_stop label");

  // Approval wiring: a pending approval flips the bar to 'waiting' and shows
  // ONLY the Open-panel control — this is the regression net for task 5.5 /
  // design.md D6 (no Allow/Deny anywhere on this surface).
  sentMessages.length = 0;
  W.handleOverlayEvent({ kind: "approval", phase: "pending", requestId: "req_5", action: "computer click (submit-type control)", target: { tabId: 42 } });
  settle();
  ok(W.refs.badgeEl.attrs["data-state"] === "waiting", "a pending approval flips the bar to the waiting state");
  ok(W.refs.stopButtonEl.hidden === true, "Stop is hidden while waiting — it is not the approval control");
  ok(W.refs.openPanelButtonEl.hidden === false, "Open-panel is the ONLY visible control while waiting");
  ok(W.refs.textEl.textContent.indexOf("computer click (submit-type control)") !== -1,
     "the waiting text names the real action awaiting a decision, not a placeholder");
  // design.md D8/task 7.11: input blocking is lifted while an approval is
  // pending — the operator must be able to read the page before deciding.
  {
    const evtWhileWaiting = makeFakeEvent("click");
    dispatchWindowEvent("click", evtWhileWaiting);
    ok(!evtWhileWaiting._prevented, "a trusted event is NOT suppressed while an approval is pending (task 7.11)");
  }
  // Exhaustively confirm no grant/deny control exists anywhere in the built
  // DOM at all — not just that the known ones are hidden, but that nothing
  // resembling Allow/Deny was ever created in the first place.
  (function assertNoGrantControl(el, seen) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    const cls = String(el.className || "");
    const text = String(el.textContent || "");
    ok(!/allow|deny|cho phép|từ chối|grant/i.test(cls) && !/cho phép|từ chối/i.test(text),
       `no element anywhere in the overlay's DOM is an Allow/Deny control (checked className="${cls}" textContent="${text}")`);
    (el.children || []).forEach((c) => assertNoGrantControl(c, seen));
  })(W.refs.host, new Set());

  openPanelClickCheck: {
    W.refs.openPanelButtonEl.dispatch("click");
    ok(sentMessages.length === 1 && sentMessages[0].type === "browzyOverlayOpenPanel",
       "clicking Open-panel sends exactly one browzyOverlayOpenPanel message");
    ok(sentMessages[0].requestId === "req_5", "...carrying the pending approval's own requestId");
  }

  // Resolving clears it back to running, with the real prior action label.
  W.handleOverlayEvent({ kind: "approval", phase: "resolved", requestId: "req_5" });
  settle();
  ok(W.refs.badgeEl.attrs["data-state"] === "running", "resolving the approval returns the bar to its ordinary active-control indication");
  ok(W.refs.openPanelButtonEl.hidden === true && W.refs.stopButtonEl.hidden === false, "Open-panel hides again, Stop reappears");

  // design.md D10/task 8.1-8.2: while locked (a run holds the page, no
  // pending approval), the page-level wait-cursor style element is present.
  ok(W.waitCursorStyleEl !== null, "the wait-cursor style element is present while the page is locked (task 8.1)");
  ok(head.children.includes(W.waitCursorStyleEl), "...appended to the page's own document, not the overlay's shadow root");
  ok(W.waitCursorStyleEl.attrs["data-browzy-overlay"] === "1", "...and it carries data-browzy-overlay, so D4's extraction exclusion already covers it");
  ok(W.waitCursorStyleEl.textContent.indexOf("cursor: wait") !== -1 && !/color|display|user-select/.test(W.waitCursorStyleEl.textContent),
     "it sets cursor and nothing else — no color, layout, visibility or user-select (task 8.1)");

  // Settle the in-flight click so D8's blocking predicate can be observed
  // cleanly (task 7.5's gate: no blocking while the agent's own action is
  // still open).
  W.handleOverlayEvent({ kind: "complete", runId: "run_1", conversationId: "conv_1", tabId: 42, action: { type: "click" }, pointer: null, outcome: { status: "success", detail: null } });
  settle();

  // design.md D8: the general blocking case — a trusted event aimed at page
  // content, no action in flight, a live run, no pending approval.
  {
    const evtBlocked = makeFakeEvent("click");
    dispatchWindowEvent("click", evtBlocked);
    ok(evtBlocked._prevented && evtBlocked._stopped, "a trusted event on page content is suppressed while the run holds the page and nothing is in flight (task 7.1/7.5)");
  }
  // task 7.2: untrusted (page-script-generated) events are never touched —
  // this is what keeps extension/content.js's OWN setFormValue()'s
  // target.click() working, and the page's own scripts in general.
  {
    const evtUntrusted = makeFakeEvent("click", { isTrusted: false });
    dispatchWindowEvent("click", evtUntrusted);
    ok(!evtUntrusted._prevented, "an untrusted (page-script) event is never suppressed (task 7.2)");
  }
  // task 7.4: the overlay's own host is exempt (its Stop/Open-panel controls
  // must stay reachable while the page is locked), and so is Tab/Shift+Tab
  // (the keyboard route into the shadow root, since keydown on page targets
  // is otherwise suppressed).
  {
    const evtOnHost = makeFakeEvent("click", { target: W.refs.host });
    dispatchWindowEvent("click", evtOnHost);
    ok(!evtOnHost._prevented, "an event whose target is the overlay's own host is exempt (task 7.4)");

    const evtTab = makeFakeEvent("keydown", { key: "Tab" });
    dispatchWindowEvent("keydown", evtTab);
    ok(!evtTab._prevented, "a Tab keydown is exempt — the operator's only keyboard route to Stop (task 7.4)");
  }
  // task 7.7: a suppression correlated with a `start` arriving shortly after
  // is reported to background as a possible swallowed dispatch.
  {
    sentMessages.length = 0;
    const evtRaced = makeFakeEvent("click");
    dispatchWindowEvent("click", evtRaced);
    ok(evtRaced._prevented, "sanity: this event really was suppressed");
    ok(sentMessages.length === 0, "suppression alone reports nothing — only correlated with a start arriving shortly after (task 7.7)");
    W.handleOverlayEvent({ kind: "start", runId: "run_1", conversationId: "conv_1", tabId: 42, action: { type: "click", tool: "computer", op: "left_click" } });
    ok(sentMessages.length === 1 && sentMessages[0].type === "browzyOverlayInputSuppressed",
       "a `start` for this run arriving shortly after a suppression reports it (task 7.7 — the delivery-race detector)");
    ok(sentMessages[0].runId === "run_1", "...carrying the run's own identity");
    // Settle this action again before the remaining blocking checks.
    W.handleOverlayEvent({ kind: "complete", runId: "run_1", conversationId: "conv_1", tabId: 42, action: { type: "click" }, pointer: null, outcome: { status: "success", detail: null } });
    settle();
    sentMessages.length = 0;
    const evtNotRaced = makeFakeEvent("click");
    dispatchWindowEvent("click", evtNotRaced);
    ok(evtNotRaced._prevented, "sanity: still suppressed");
    W.handleOverlayEvent({ kind: "keepalive", runId: "run_1", tabId: 42 });
    ok(sentMessages.length === 0, "a keepalive (not a `start`) arriving after a suppression never triggers a report — only a real dispatched action does");
  }
  // task 7.6: Brave never acknowledges mouseWheel and applies it late — a
  // trailing wheel event just after a scroll action settles must still pass
  // through, or the agent's own delayed dispatch would be suppressed.
  {
    W.handleOverlayEvent({ kind: "complete", runId: "run_1", conversationId: "conv_1", tabId: 42, action: { type: "scroll" }, pointer: null, outcome: { status: "success", detail: null } });
    const evtWheelTail = makeFakeEvent("wheel");
    dispatchWindowEvent("wheel", evtWheelTail);
    ok(!evtWheelTail._prevented, "a trailing wheel event right after a scroll action settles is NOT suppressed (task 7.6)");
  }
  // task 7.1: passive:false / capture:true registration — behavioral proof
  // that preventDefault() actually took effect above already covers the
  // functional half; the registration OPTIONS themselves cannot be observed
  // from this fake DOM (task 11.11), so they are asserted structurally
  // against the shipped source in the "structural: input blocking" block
  // below.

  // Teardown clears the visible state AND lifts input blocking — no run
  // left to guard once the heartbeat is hard-cleared (task 7.8/7.9).
  W.handleOverlayEvent({ kind: "teardown" });
  ok(W.state.lastEventAt === null, "the teardown synthetic event is handled through the exact same handleOverlayEvent path as a real one");
  {
    const evtAfterTeardown = makeFakeEvent("click");
    dispatchWindowEvent("click", evtAfterTeardown);
    ok(!evtAfterTeardown._prevented, "input blocking clears the instant the run tears down — no run left to guard (task 7.8/7.9)");
  }
}

console.log("\n== structural: input blocking registration (task 7.1) ==");
{
  ok(/\{\s*capture:\s*true,\s*passive:\s*false\s*\}/.test(SRC),
     "every BLOCKABLE_EVENT_TYPES listener is registered with {capture:true, passive:false} — mandatory: wheel/touch* are passive by default on window in Chrome, and preventDefault() is ignored on a passive listener");
  const typesMatch = SRC.match(/var BLOCKABLE_EVENT_TYPES = \[([\s\S]*?)\];/);
  ok(!!typesMatch, "found the BLOCKABLE_EVENT_TYPES list in the shipped source");
  const listedTypes = typesMatch[1];
  for (const t of [
    "pointerdown", "pointerup", "pointermove",
    "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu",
    "wheel", "keydown", "keypress", "keyup", "beforeinput",
    "touchstart", "touchmove", "touchend", "paste", "drop"
  ]) {
    ok(listedTypes.includes(`"${t}"`), `"${t}" is in the suppressed event list — pointer events must be present (mousedown alone leaves React/pointer-event libraries interactive), and beforeinput/keypress/paste are what IME composition and paste bypass a plain keydown preventDefault()`);
  }
  ok(/window\.addEventListener\(BLOCKABLE_EVENT_TYPES\[i\], handleBlockableEvent/.test(SRC),
     "registerInputBlockers() registers ONE named handler for every type, so removeInputBlockers() can remove the exact same function reference");
  ok(/window\.removeEventListener\(BLOCKABLE_EVENT_TYPES\[i\], handleBlockableEvent/.test(SRC),
     "removeInputBlockers() removes the SAME named handler — used by pagehide (task 7.12) and dispose (task 7.13)");
}

console.log("\n== eager mount (task 1.1-1.3): the host exists before any event is ever delivered ==");
{
  const documentElement2 = makeFakeElement("html");
  const fakeDocument2 = { documentElement: documentElement2, createElement: makeFakeElement };
  const eagerSrc = [
    extract("isHeartbeatExpired"),
    extract("computeRenderModel"),
    extract("createOverlayHost"),
    "var refs = null;",
    extract("attach")
  ].join("\n\n");
  const E = compile(
    eagerSrc,
    { document: fakeDocument2, OVERLAY_CSS: "", CURSOR_SVG: "", CORNER_SVGS: "", BADGE_TRACE_SVG: "", ...computeRenderModelDeps },
    "({ attach, get refs(){ return refs; } })"
  );
  ok(E.refs === null, "sanity: before attach() runs, no host exists in this isolated harness");
  E.attach();
  ok(E.refs && E.refs.host, "attach() creates the host node with NO event ever having been delivered — exactly the call the real file makes right after 'script loaded' (task 1.1)");
  ok(documentElement2.children.includes(E.refs.host), "...and it is really attached to the document");

  // The real file calls attach() unconditionally right after logging "script
  // loaded" — BEFORE the message listener is even registered.
  ok(/logOverlayMessage\("script loaded", location\.href\);[\s\S]{0,600}?\n\s*attach\(\);\s*\n\s*registerInputBlockers\(\);/.test(SRC),
     "attach() (and registerInputBlockers()) run right after 'script loaded' is logged, at IIFE load time — not from inside the message handler (task 1.1)");
  ok(/function handleOverlayEvent\(event\) \{\s*\n\s*attach\(\);/.test(SRC),
     "handleOverlayEvent() still calls attach() too — its `if (refs) return` guard makes the second call a no-op (task 1.2)");
}

console.log("\n== single visibility authority (task 2.1-2.3): computeRenderModel().visible, setCapturedHidden() writes no DOM ==");
{
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const activeState = { lastEventAt: 1000, cursor: { x: 1, y: 1 }, clickAt: null, dragHeld: false, runId: "r1", lastActionType: "click", stepCount: 1, startedAt: 500, pendingApproval: null, actionInFlight: true };
  const inactiveState = { ...activeState, lastEventAt: 1000 };

  ok(computeRenderModel(activeState, 1050, 3000, false).visible === true, "active + not captured -> visible");
  ok(computeRenderModel(activeState, 1050, 3000, true).visible === false, "active + captured -> NOT visible");
  ok(computeRenderModel(inactiveState, 9000, 3000, false).visible === false, "inactive + not captured -> NOT visible (there is no run to show)");
  ok(computeRenderModel(inactiveState, 9000, 3000, true).visible === false, "inactive + captured -> NOT visible either way");
  ok(computeRenderModel(activeState, 1050, 3000, undefined).visible === true, "an omitted capture flag defaults to 'not captured' — every pre-existing 3-arg call site in this file stays correct");

  const setCapturedHiddenSrc = extract("setCapturedHidden");
  ok(!/\.style\./.test(setCapturedHiddenSrc), "setCapturedHidden() itself contains no '.style.' assignment — it records state and requests a repaint only (task 2.3); paintOverlay() remains the sole writer of host.style.visibility");
  ok(/paintNow\(\);/.test(setCapturedHiddenSrc), "...and the repaint it requests is the SYNCHRONOUS path (task 2.4) — a capture-driven hide must be on screen before requestOverlayHide() resolves on the background side");

  ok(!/renderModel\.active\)\s*\{\s*\n\s*refs\.host\.style\.visibility = "hidden";\s*\n\s*return;/.test(extract("paintOverlay")),
     "paintOverlay() no longer early-returns on !active before setting visibility from a separately-derived flag — it reads renderModel.visible directly (task 2.2/2.5)");
  ok(/refs\.host\.style\.visibility = renderModel\.visible \? "visible" : "hidden";/.test(SRC),
     "renderModel.visible is the ONE field that decides the host's on-screen state (design.md D2)");

  // task 2.5: the four verdicts remain distinguishable, and they read the
  // model's own fields.
  ok(/!model\.active\s*\n\s*\?\s*"heartbeat expired/.test(SRC), "the 'heartbeat expired' verdict reads model.active");
  ok(/!model\.visible\s*\n\s*\?\s*"hidden for a screenshot"/.test(SRC), "the 'hidden for a screenshot' verdict reads model.visible — not a second, separately re-derived hidden computation");
}

// =============================================================================
// 7. Structural proof: CSS text actually shipped disables pointer-events on
//    every decorative element and enables it ONLY on the deliberate controls
//    (Stop, Open-panel), the reduced-motion media query actually stops the
//    sweep/pulse/ripple/trace animations while leaving the static ring and
//    corner brackets untouched, and the frame is a real, toggled element.
// =============================================================================
console.log("\n== the remote-control frame ==");
// The cursor alone is easy to lose on a busy page, and says nothing at all
// before the first pointer action. A frame around the viewport says the page
// is being driven from the first moment of the run.
{
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const reading = { lastEventAt: 1000, cursor: null, clickAt: null, dragHeld: false, runId: "r1", conversationId: "c1", tabId: 7, lastActionType: "read", stepCount: 1, startedAt: 1000, pendingApproval: null };
  const m = computeRenderModel(reading, 1100, 2700);
  ok(m.frame === true, "a run that has so far only READ the page still shows the frame — it is holding the page either way");
  ok(m.cursor === null, "while the cursor stays absent, because no pointer position was ever dispatched");
  ok(computeRenderModel({ ...reading, lastEventAt: 1000 }, 9000, 2700).frame === false, "an expired run shows no frame");

  const cssMatch = SRC.match(/var OVERLAY_CSS =([\s\S]*?);\n\n\s*var CURSOR_SVG/);
  ok(!!cssMatch, "found the OVERLAY_CSS string literal block in the shipped source");
  const css = cssMatch[1];

  ok(/\.browzy-frame\{[^}]*pointer-events:none/.test(css), "the frame is pointer-events:none — it can never swallow a click meant for the page");
  ok(/\.browzy-frame\{[^}]*position:fixed/.test(css), "and position:fixed, so it adds no scrollbars and shifts no layout");
  ok(/box-shadow:inset/.test(SRC), "the static ring is drawn as an inset shadow rather than a border, which would otherwise change the page box");
  ok(SRC.includes("frameEl"), "and it is a real element the paint step toggles, not CSS nobody applies");

  ok(/\.browzy-frame-sweep\{[^}]*animation:browzy-sweep/.test(css), "the sweep is the animated conic-gradient layer (task 1.2)");
  ok(/\.browzy-frame-ring\{[^}]*box-shadow:inset/.test(css), "beneath it, a static ring that never has an animation property at all (task 1.2)");
  ok(/\.browzy-corner-tl/.test(css) && /\.browzy-corner-tr/.test(css) && /\.browzy-corner-bl/.test(css) && /\.browzy-corner-br/.test(css),
     "all four corner brackets are positioned (task 1.3)");
  ok(!/\.browzy-corner[^-]/.test(css.replace(/\.browzy-corners/g, "")) || /\.browzy-corner\{[^}]*position:absolute/.test(css),
     "corner brackets are plain, non-animated positioned elements");
}

console.log("\n== structural: CSS text — pointer-events and reduced motion ==");
{
  const cssMatch = SRC.match(/var OVERLAY_CSS =([\s\S]*?);\n\n\s*var CURSOR_SVG/);
  ok(!!cssMatch, "found the OVERLAY_CSS string literal block in the shipped source");
  const css = cssMatch[1];
  ok(/\.browzy-cursor\{[^}]*pointer-events:none/.test(css), ".browzy-cursor is pointer-events:none");
  ok(/\.browzy-click-ring\{[^}]*pointer-events:none/.test(css), ".browzy-click-ring is pointer-events:none");
  ok(/\.browzy-badge\{[^}]*pointer-events:none/.test(css), ".browzy-badge (the notice container) is pointer-events:none");
  ok(/\.browzy-stop\{[^}]*pointer-events:auto/.test(css), ".browzy-stop is one of the ONLY two elements re-enabling pointer-events — a deliberate control");
  ok(/\.browzy-open-panel\{[^}]*pointer-events:auto/.test(css), ".browzy-open-panel is the OTHER — and the ONLY control the waiting state ever gets");
  ok(!/\bcho[-_ ]?phep\b/i.test(css) && !/\btu[-_ ]?choi\b/i.test(css) && !/allow|deny/i.test(css),
     "no Allow/Deny class or selector exists anywhere in the shipped CSS — the design mockups draw them, this file never does (task 5.5)");
  ok(/prefers-reduced-motion:reduce\)\{[\s\S]*transition:none/.test(css), "reduced motion actually sets transition:none, not just declares the media query");
  ok(/prefers-reduced-motion:reduce\)\{[\s\S]*\.browzy-frame-sweep\{animation:none/.test(css),
     "reduced motion stops the sweep specifically (task 1.4) — the static ring/corners have no animation property to stop in the first place");
  ok(!/#C4785B/i.test(SRC), "no trace of the old terracotta palette remains anywhere in the file (task 1.1)");
  ok(/oklch\(0\.74 0\.19 215\)/.test(SRC) && /oklch\(0\.74 0\.19 300\)/.test(SRC), "the new cyan/violet pair is present with the exact specified values");
}

// =============================================================================
// 8. Structural proof: the classic-script guard, and the exact injection
//    mechanism this file expects from extension/background.js (matches
//    OVERLAY_SCRIPT_FILES there).
// =============================================================================
console.log("\n== the status bar no longer chases the cursor (task 6.2, inverse of the deleted computeBadgeCorner) ==");
{
  ok(!SRC.includes("computeBadgeCorner"), "computeBadgeCorner() and every reference to it are gone from the shipped source (task 4.1)");
  ok(!SRC.includes("data-corner"), "paintOverlay() no longer writes a data-corner attribute — there is no corner to pick");

  const cssMatch = SRC.match(/var OVERLAY_CSS =([\s\S]*?);\n\n\s*var CURSOR_SVG/);
  const css = cssMatch[1];
  ok(/\.browzy-badge\{[^}]*left:50%/.test(css) && /\.browzy-badge\{[^}]*bottom:26px/.test(css) && /\.browzy-badge\{[^}]*transform:translateX\(-50%\)/.test(css),
     "the bar is anchored bottom-center by fixed CSS (left:50%;bottom:26px;transform:translateX(-50%)), not computed per paint");

  // Functional proof: paintOverlay never reads/writes a position for the
  // badge at all, for any cursor position — its screen position is anchored
  // entirely by CSS, so no sequence of cursor moves can relocate it.
  const paintOverlaySrc = extract("paintOverlay");
  ok(!/badgeEl\.style\.(left|top|right|bottom)/.test(paintOverlaySrc),
     "paintOverlay() never assigns badgeEl.style.left/top/right/bottom for any renderModel — the indicator's position is invariant under pointer movement");
}

console.log("\n== structural: double-injection guard, no ESM syntax (classic script requirement) ==");
{
  // The guard used to be an early `return` on __browzyOverlayLoaded. That made
  // re-injection a no-op in the wrong way: after an extension reload the old
  // listener was dead but the flag survived, so the document could never get a
  // working overlay again. Disposing the predecessor and re-registering handles
  // both cases — the invariant to hold is that a second injection leaves
  // exactly one live listener, not that it returns early.
  ok(/window\.__browzyOverlayDispose\?\.\(\);/.test(SRC) && /window\.__browzyOverlayLoaded = true;/.test(SRC),
     "re-injecting into the SAME document disposes the previous copy first, so it is safe");
  ok(/removeListener\(onOverlayMessage\)/.test(SRC),
     "  ...and that disposal really unregisters the old listener, leaving exactly one live");
  ok(!/^\s*export\s/m.test(SRC) && !/^\s*import\s/m.test(SRC), "no top-level import/export — this MUST remain loadable as a classic chrome.scripting.executeScript file (manifest.json's content_scripts has no \"type\":\"module\" entry, and is frozen for this task)");
}

console.log("\n== structural: every overlay message is acknowledged ==");
// chrome.tabs.sendMessage on the SENDER side (sendOverlayMessage() in
// extension/background.js) is a promise. A listener that handles a message but
// returns without ever calling sendResponse lets the port close unanswered, and
// that promise REJECTS — indistinguishable, from the sender, from "this
// document has no overlay". That drove the inject-then-retry path on EVERY
// message: each action-event was delivered twice (the re-injection itself being
// a no-op thanks to the __browzyOverlayLoaded guard above, so the SAME listener
// answered again), and every event and keepalive tick paid one wasted
// chrome.scripting.executeScript. The acknowledgement is what keeps a rejection
// meaning what the sender assumes it means.
{
  // Named, not anonymous: the disposal path above has to be able to remove it.
  // The assertions below are about what the listener does, not what it is called.
  const OPEN = "const onOverlayMessage = function (";
  const at = SRC.indexOf(OPEN);
  ok(at !== -1, "the onMessage listener is found in the shipped source");
  const params = SRC.slice(at + OPEN.length, SRC.indexOf(")", at));
  ok(params.includes("sendResponse"), "it takes sendResponse — a listener that cannot answer cannot be told apart from an absent overlay");

  const body = SRC.slice(at, SRC.indexOf("\n  };", at));
  const MATCH = 'if (msg.type === "';
  const branches = body.split(MATCH).slice(1);
  // Task 7.7 added a fifth: browzyOverlayRisk (the risk-category relay).
  ok(branches.length === 5, `all five overlay message types are handled (found ${branches.length})`);
  for (const b of branches) {
    ok(b.includes("sendResponse("), `${b.slice(0, b.indexOf('"'))} is acknowledged before its branch returns`);
  }

  // The overlay shares a document with extension/content.js, and BOTH receive
  // every chrome.tabs.sendMessage aimed at the tab. The first sendResponse
  // wins — so acknowledging a message that is not ours would steal content.js's
  // reply out from under sendContentMessage().
  const beforeFirstBranch = body.slice(0, body.indexOf(MATCH));
  ok(!beforeFirstBranch.includes("sendResponse("), "nothing is acknowledged before a browzy message type is matched — content.js shares this document, and the first responder wins");
  ok(beforeFirstBranch.includes("if (!msg) return;"), "and a non-message is still an unconditional no-op");
}

console.log("\n== keepalive: the overlay stays up while the model thinks ==");
// Actions arrive in bursts seconds apart. The heartbeat expiry that stops a
// dead host leaving a misleading badge was also blanking the overlay in every
// gap between them, so a page being driven looked unattended for most of the
// run. A keepalive refreshes liveness WITHOUT pretending anything was
// dispatched — and the expiry itself is untouched, so the moment the pings
// stop the overlay still clears within the same bound.
{
  const reduceOverlayState = compile(
    [extract("resolveViewportPoint"), extract("reduceOverlayState")].join("\n\n"),
    {},
    "reduceOverlayState"
  );
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );

  const initial = {
    lastEventAt: null, cursor: null, clickAt: null, dragHeld: false,
    runId: null, conversationId: null, tabId: null, lastActionType: null,
    stepCount: 0, startedAt: null, pendingApproval: null, actionInFlight: false
  };
  let s = reduceOverlayState(initial, { kind: "progress", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "click" }, pointer: { points: [{ x: 120, y: 240, phase: "down" }] }, timing: { startedAt: 1000 } }, 1000);

  // Five seconds of thinking: without a keepalive this is already dark.
  ok(computeRenderModel(s, 6000, 2700).active === false, "with no signal for five seconds the overlay would have gone dark — the bug being fixed");

  const alive = reduceOverlayState(s, { kind: "keepalive", runId: "r1", tabId: 7 }, 5800);
  ok(computeRenderModel(alive, 6000, 2700).active === true, "a keepalive keeps it up across that same gap");
  ok(alive.cursor && alive.cursor.x === 120 && alive.cursor.y === 240, "and moves the cursor nowhere — the pointer did not move, so neither does what is drawn");
  ok(alive.clickAt === s.clickAt, "nor does it invent a click");
  ok(alive.dragHeld === s.dragHeld && alive.lastActionType === s.lastActionType, "nor change what the last real action was");
  ok(alive.stepCount === s.stepCount, "nor inflate the step count the operator reads (task 4.5)");
  ok(alive.startedAt === s.startedAt, "nor move the run's own start time");
  ok(alive.pendingApproval === s.pendingApproval, "nor touch a pending approval either way");
  ok(alive.actionInFlight === s.actionInFlight, "nor touch whether an action is in flight — the click here never settled, so it correctly stays in flight across the keepalive");

  // The safety property the expiry exists for must survive the fix.
  ok(computeRenderModel(alive, 5800 + 2700 + 1, 2700).active === false, "once the pings stop, the overlay still expires on its own within the same bound");
  const torn = reduceOverlayState(alive, { kind: "teardown" }, 5900);
  ok(computeRenderModel(torn, 5901, 2700).active === false, "and an explicit teardown still clears it immediately, keepalives notwithstanding");

  // A keepalive for a run this tab has not seen yet still binds the ids, so
  // the Stop button has something to send.
  const bound = reduceOverlayState(initial, { kind: "keepalive", runId: "r9", conversationId: "c9", tabId: 3 }, 100);
  ok(bound.runId === "r9" && bound.conversationId === "c9" && bound.tabId === 3, "a keepalive carries the run identity the Stop button needs");
}

// =============================================================================
// 9. Finding 2 regression: the cursor must stop claiming an in-flight action
//    the instant it settles (`complete`/`error`), and must STAY idle across
//    any number of keepalives that follow — `lastActionType` alone (never
//    cleared, by design, since the bar's label and step counter still need
//    it) is NOT a safe proxy for "something is happening right now". Before
//    this fix, cursorState/cursorLabel were derived purely from
//    lastActionType, so the cursor kept pulsing the FIRST action's label
//    ("click"/"cuộn"/etc.) for the rest of the run, including long gaps
//    where only keepalives arrive and nothing is being dispatched — exactly
//    the fabricated-active-state failure this file's own header forbids,
//    and exactly what this test would catch without the actionInFlight fix.
// =============================================================================
console.log("\n== the cursor stops claiming an action once it settles, even across later keepalives (Finding 2) ==");
{
  const reduceOverlayState = compile(
    [extract("resolveViewportPoint"), extract("reduceOverlayState")].join("\n\n"),
    {},
    "reduceOverlayState"
  );
  const computeRenderModel = compile(
    [extract("isHeartbeatExpired"), extract("computeRenderModel")].join("\n\n"),
    computeRenderModelDeps,
    "computeRenderModel"
  );
  const initial = {
    lastEventAt: null, cursor: null, clickAt: null, dragHeld: false,
    runId: null, conversationId: null, tabId: null, lastActionType: null,
    stepCount: 0, startedAt: null, pendingApproval: null, actionInFlight: false
  };

  // An action dispatches and is genuinely in flight: cursor reads acting/click.
  let s = reduceOverlayState(initial, { kind: "start", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "click", tool: "computer", op: "left_click" } }, 1000);
  s = reduceOverlayState(s, {
    kind: "progress", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "click" },
    pointer: { points: [{ x: 12, y: 12, phase: "down" }] }
  }, 1005);
  let m = computeRenderModel(s, 1010, 3000);
  ok(m.cursorState === "acting" && m.cursorLabel === "click", "while the click is actually in flight, the cursor reads acting/\"click\"");

  // The action settles.
  s = reduceOverlayState(s, { kind: "complete", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "click" }, pointer: null, outcome: { status: "success", detail: null } }, 1020);
  m = computeRenderModel(s, 1025, 3000);
  ok(m.cursorState === "idle" && m.cursorLabel === CURSOR_IDLE_LABEL,
     "the instant the click settles (complete), the cursor stops claiming an action — even though lastActionType is still \"click\"");

  // Nothing but keepalives arrive for a long stretch afterward. The cursor
  // must STAY idle: a keepalive never revives a settled action's cursor claim.
  s = reduceOverlayState(s, { kind: "keepalive", runId: "r1", tabId: 7 }, 3000);
  m = computeRenderModel(s, 3000, 3000);
  ok(m.active === true, "the run is still alive — the keepalive refreshed liveness");
  ok(m.cursorState === "idle" && m.cursorLabel === CURSOR_IDLE_LABEL,
     "...but the cursor still reads idle, not \"click\", while the model is thinking with nothing dispatched (the exact bug this fix closes)");
  ok(m.barState === "running", "barState is untouched by this fix — a run holding the page between actions is still \"running\", per design.md's existing (correct) definition, left alone as instructed");

  s = reduceOverlayState(s, { kind: "keepalive", runId: "r1", tabId: 7 }, 4800);
  m = computeRenderModel(s, 4800, 3000);
  ok(m.cursorState === "idle" && m.cursorLabel === CURSOR_IDLE_LABEL, "still idle after a SECOND keepalive — the settled state persists, it is not a one-frame fluke");

  // A brand-new action reaching this same run afterward is shown correctly —
  // the fix does not somehow get "stuck" idle forever.
  s = reduceOverlayState(s, { kind: "start", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "scroll", tool: "computer", op: "scroll" } }, 5000);
  s = reduceOverlayState(s, { kind: "progress", runId: "r1", conversationId: "c1", tabId: 7, action: { type: "scroll" }, pointer: { points: [{ x: 12, y: 12, phase: "move" }] } }, 5005);
  m = computeRenderModel(s, 5010, 3000);
  ok(m.cursorState === "acting" && m.cursorLabel === "cuộn", "a genuinely new in-flight action after the idle gap correctly returns the cursor to acting");
}

// =============================================================================
// 10. Cursor easing (task 5.1-5.5 / design.md D5): the pure step function
//     converges toward the target, snaps at the threshold, and never claims
//     a click/label at an interpolated coordinate.
// =============================================================================
console.log("\n== easeTowardTarget: converges toward the target, snaps, pure ==");
{
  const easeTowardTarget = compile(extract("easeTowardTarget"), {}, "easeTowardTarget");
  ok(easeTowardTarget(null, { x: 100, y: 50 }, 0.2, 2).x === 100, "no current position yet -> jumps straight to the target (nothing to ease FROM)");
  const step1 = easeTowardTarget({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.2, 2);
  ok(step1.x === 20, "one step moves 20% of the remaining distance toward the target (the tuned factor)");
  const step2 = easeTowardTarget(step1, { x: 100, y: 0 }, 0.2, 2);
  ok(step2.x === 36, "a second step continues converging from the NEW position, not restarting from the original");
  ok(easeTowardTarget({ x: 99, y: 0 }, { x: 100, y: 0 }, 0.2, 2).x === 100, "once the remaining distance falls under the snap threshold, it snaps exactly to the target rather than crawling forever");
  ok(easeTowardTarget({ x: 5, y: 5 }, null, 0.2, 2) === null, "no target (nothing dispatched yet / run gone) -> nothing to draw");
  ok(
    JSON.stringify(easeTowardTarget({ x: 10, y: 10 }, { x: 50, y: 90 }, 0.2, 2)) ===
    JSON.stringify(easeTowardTarget({ x: 10, y: 10 }, { x: 50, y: 90 }, 0.2, 2)),
    "pure — the exact same inputs always produce the exact same output"
  );

  // design.md D5's "Resolving the two-writer conflict": paintOverlay() no
  // longer writes cursorEl.style.left/top at all — paintCursorPosition()
  // (driven by the rAF loop) is the sole writer.
  const paintOverlaySrc = extract("paintOverlay");
  ok(!/cursorEl\.style\.(left|top)\s*=/.test(paintOverlaySrc), "paintOverlay() never writes cursorEl.style.left/top (design.md D5) — only paintCursorPosition() does");
  const paintCursorPositionSrc = extract("paintCursorPosition");
  ok(/cursorEl\.style\.left\s*=/.test(paintCursorPositionSrc) && /cursorEl\.style\.top\s*=/.test(paintCursorPositionSrc),
     "paintCursorPosition() is the one function that writes them");

  // task 5.5: the click ripple and action label still fire at the
  // DISPATCHED coordinate, never an interpolated one — paintOverlay()
  // positions the ring from renderModel.cursor (the real dispatched target),
  // not from any eased/drawn position.
  ok(/ringEl\.style\.left = renderModel\.cursor\.x \+ "px";/.test(paintOverlaySrc) && /ringEl\.style\.top = renderModel\.cursor\.y \+ "px";/.test(paintOverlaySrc),
     "the click ripple is positioned from renderModel.cursor (the real dispatched coordinate) — never from the eased drawn position (task 5.5)");

  // task 5.3: the rAF loop stops (and drops the drawn position) once the
  // model is not ACTIVE — no run left to attribute the motion to.
  const stepSrc = extract("stepCursorAnimation");
  ok(/if \(!model\.active\) \{/.test(stepSrc) && /drawnCursor = null;/.test(stepSrc),
     "the cursor loop drops the drawn position once the model is inactive — it never eases toward a resting place with no run behind it (task 5.3)");
  ok(/if \(!model\.visible\) \{/.test(stepSrc), "the loop also stops (but keeps drawnCursor) when only hidden for a capture — it resumes from where it was rather than snapping every screenshot");
}

// =============================================================================
// 11. Correlated, self-expiring capture lease (task 3.1-3.4 / design.md D3):
//     matching show un-hides; a newer hide supersedes; a stale/unknown show
//     is a no-op; a hide delivered after its own show (the exact reorder
//     RC3 exists to close) leaves the overlay visible; an anonymous
//     (id-less) lease is closed by expiry alone.
// =============================================================================
console.log("\n== handleCaptureMessage: the correlated capture lease (design.md D3) ==");
{
  const miniHead = makeFakeElement("head");
  const miniDocEl = makeFakeElement("html");
  const miniDocument = { head: miniHead, documentElement: miniDocEl, createElement: makeFakeElement };
  const miniWindow = { innerWidth: 1000, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };

  const varBlockStart = SRC.indexOf("var state = {");
  const rrMarker = "var requestRender = createRenderScheduler(";
  const varBlockEnd = SRC.indexOf("\n  );", SRC.indexOf(rrMarker)) + "\n  );".length;
  const varBlock = SRC.slice(varBlockStart, varBlockEnd);

  const miniSrc = [
    extract("createRenderScheduler"),
    extract("isHeartbeatExpired"),
    extract("isCaptureHideInForce"),
    extract("easeTowardTarget"),
    extract("computeRenderModel"),
    extract("paintOverlay"),
    extract("paintCursorPosition"),
    varBlock,
    extract("setWaitCursorActive"),
    extract("stopCursorAnimation"),
    extract("stepCursorAnimation"),
    extract("ensureCursorAnimation"),
    extract("paintNow"),
    extract("setCapturedHidden"),
    extract("handleCaptureMessage")
  ].join("\n\n");

  const CL = compile(
    miniSrc,
    {
      document: miniDocument,
      window: miniWindow,
      HEARTBEAT_MAX_AGE_MS: 2700,
      CLICK_RING_DURATION_MS: 350,
      CAPTURE_HIDE_MAX_AGE_MS: 2000,
      CURSOR_EASE_FACTOR: 0.2,
      CURSOR_SNAP_PX: 2,
      CURSOR_LABEL_FLIP_MARGIN_X: 200,
      CURSOR_LABEL_FLIP_MARGIN_Y: 60,
      WAIT_CURSOR_CSS: "* { cursor: wait !important; }",
      ...computeRenderModelDeps
    },
    "({ handleCaptureMessage, get capturedHiddenAt(){ return capturedHiddenAt; }, get capturedCaptureId(){ return capturedCaptureId; }, get capturedMaxMs(){ return capturedMaxMs; } })"
  );

  CL.handleCaptureMessage("hide", 1, 500);
  ok(CL.capturedHiddenAt !== null && CL.capturedCaptureId === 1 && CL.capturedMaxMs === 500, "a hide opens the lease with its own id and its own maxMs bound — background mints both (design.md D3)");
  CL.handleCaptureMessage("show", 1);
  ok(CL.capturedHiddenAt === null, "a show whose id matches the lease un-hides it (task 3.2)");

  CL.handleCaptureMessage("hide", 2, 500);
  CL.handleCaptureMessage("hide", 3, 800);
  ok(CL.capturedCaptureId === 3 && CL.capturedMaxMs === 800, "a newer hide (before its predecessor's own show ever arrives) supersedes the current lease, including its own maxMs (task 3.2)");

  CL.handleCaptureMessage("show", 2);
  ok(CL.capturedHiddenAt !== null && CL.capturedCaptureId === 3, "a show for a stale/superseded id is a silent no-op — the current lease stays hidden (task 3.2)");
  CL.handleCaptureMessage("show", 999);
  ok(CL.capturedHiddenAt !== null && CL.capturedCaptureId === 3, "a show for an entirely unknown id is also a silent no-op");
  CL.handleCaptureMessage("show", 3);
  ok(CL.capturedHiddenAt === null, "the show that actually matches the current lease un-hides it");

  // The exact reorder RC3 exists to close: the hide had to inject the
  // overlay first, so its OWN show is delivered before it is.
  CL.handleCaptureMessage("show", 4);
  ok(CL.capturedHiddenAt === null, "a show for an id nothing is currently hidden for is a no-op on visibility, but it still retires that id");
  CL.handleCaptureMessage("hide", 4, 500);
  ok(CL.capturedHiddenAt === null, "a hide delivered AFTER its own show already retired that id leaves the overlay visible, not hidden — this is task 3.4's regression net for RC3's reorder failure");

  // A genuinely later, distinct capture id still hides normally — the
  // reorder guard only rejects a hide whose OWN id was already retired.
  CL.handleCaptureMessage("hide", 5, 500);
  ok(CL.capturedHiddenAt !== null && CL.capturedCaptureId === 5, "a later, distinct capture id still hides normally afterward");
  CL.handleCaptureMessage("show", 5);

  // task 3.3: an anonymous (id-less) lease — an older background that never
  // sends captureId at all — is closed by expiry alone, never by a show.
  CL.handleCaptureMessage("hide", undefined, undefined);
  ok(CL.capturedCaptureId === null && CL.capturedHiddenAt !== null && CL.capturedMaxMs === 2000,
     "an anonymous hide (no captureId) opens with no id and the DEFAULT expiry bound (task 3.3)");
  CL.handleCaptureMessage("show", undefined);
  ok(CL.capturedHiddenAt !== null, "an anonymous lease is NOT cleared by a show — task 3.3's literal 'only expiry clears it'");
}

// =============================================================================
// 12. Ambient glow (task 9.1-9.4 / design.md D11): edge-weighted, additive,
//     pointer-events:none, bound to the same `visible` field, and degrades
//     under reduced motion.
// =============================================================================
console.log("\n== ambient glow: edge-weighted, bound to `visible`, degrades under reduced motion (design.md D11) ==");
{
  const cssMatch = SRC.match(/var OVERLAY_CSS =([\s\S]*?);\n\n\s*var CURSOR_SVG/);
  const css = cssMatch[1];
  ok(/\.browzy-glow\{[^}]*pointer-events:none/.test(css), "the glow layer is pointer-events:none, like every other decorative layer");
  ok(/\.browzy-glow\{[^}]*position:fixed/.test(css), "and position:fixed — it never shifts layout or adds scrollbars");
  ok(/\.browzy-glow\{[^}]*opacity:0/.test(css) && /\.browzy-glow\.is-active\{opacity:1/.test(css),
     "the glow starts at opacity:0 and only becomes visible via the .is-active class");
  ok(/glowEl.*classList.*toggle\("is-active", !!renderModel\.visible\)/.test(SRC),
     "paintOverlay() binds .is-active to renderModel.visible — the SAME field that governs the host's own on-screen state (task 9.3)");
  ok(/radial-gradient\(ellipse[^)]*at top/.test(css) && /radial-gradient\(ellipse[^)]*at bottom/.test(css) &&
     /radial-gradient\(ellipse[^)]*at left/.test(css) && /radial-gradient\(ellipse[^)]*at right/.test(css),
     "the glow is weighted to all four viewport edges, not a single full-viewport wash — a layer covering the content would blink across it on every screenshot cycle (task 9.2)");
  ok(/\.browzy-glow\{transition:none;\}|\.browzy-cursor,\.browzy-frame,\.browzy-glow\{transition:none;\}/.test(css.replace(/\s+/g, "")),
     "reduced motion stops the glow's own transition too");
  ok(/prefers-reduced-motion:reduce\)\{[\s\S]*\.browzy-glow\{animation:none!important;\}/.test(css),
     "reduced motion stops the glow's animation while the static (opacity-only) form remains — the same degradation the swept frame already uses (task 9.4)");

  function zIndexOf(selector) {
    const m = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{[^}]*z-index:(\\d+)"));
    return m ? Number(m[1]) : null;
  }
  const glowZ = zIndexOf(".browzy-glow");
  ok(glowZ !== null && glowZ < zIndexOf(".browzy-frame") && glowZ < zIndexOf(".browzy-click-ring") &&
     glowZ < zIndexOf(".browzy-cursor") && glowZ < zIndexOf(".browzy-badge"),
     "the glow's own z-index sits below the frame, ripples, cursor and badge — task 9.3's stacking order (\"below the cursor, the ripples and the status bar and above nothing else\")");
  ok(SRC.indexOf("glowEl.className") < SRC.indexOf("frameEl.className"),
     "the glow element is created (and appended) first, before the frame — the bottom-most layer");
}

// =============================================================================
// 13. Cursor geometry (task 10.1-10.5 / design.md D9): a constants check, not
//     a layout assertion — this file never touches a real browser.
// =============================================================================
console.log("\n== cursor geometry: size as a CSS variable, hot-spot offset, label-flip thresholds (design.md D9) ==");
{
  ok(/--browzy-cursor-size:\s*72px/.test(SRC), "the cursor size is a CSS custom property, set to ~72px (task 10.1)");
  ok(/width:var\(--browzy-cursor-size\)/.test(SRC) && /height:var\(--browzy-cursor-size\)/.test(SRC),
     "the cursor's own box is drawn from that variable, so a future resize is single-sourced");
  // Hot-spot correction: the SVG's own tip sits at local (4, 3.2) in a 0-26
  // viewBox; scaled into a 72px box that is 72/26 per unit, so the
  // translate must cancel (4*72/26, 3.2*72/26) ≈ (11px, 9px) to keep the
  // rendered tip on the dispatched coordinate — the ONE measurement that
  // silently falsifies every drawn position if it is missed (task 10.2).
  ok(/transform:translate\(-11px,-9px\)/.test(SRC), "the hot-spot transform is retuned for the 72px box (task 10.2)");
  ok(/CURSOR_LABEL_FLIP_MARGIN_X\s*=\s*\d+/.test(SRC) && /CURSOR_LABEL_FLIP_MARGIN_Y\s*=\s*\d+/.test(SRC),
     "the label-flip thresholds are named, tuned constants (task 10.5), not a real layout measurement");
  ok(/is-label-flip-x.*left:auto;right:14px/.test(SRC.replace(/\s+/g, "")) && /is-label-flip-y.*top:auto;bottom:14px/.test(SRC.replace(/\s+/g, "")),
     "the label actually flips to the other side of the arrow via CSS when the threshold is crossed (task 10.5)");
  ok(/\.browzy-ripple\{[^}]*width:96px;height:96px/.test(SRC), "the click ripples are retuned proportionate to the larger cursor, not linearly scaled (task 10.4)");
}

console.log(fail === 0 ? "\nALL OVERLAY POINTER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

// Emission-wiring tests for the action-event schema (design.md 5c / tasks
// 5.9, 5.10): proves the SHIPPED extension/background.js code — extracted
// the same brace-matching way test/handlers.test.mjs and friends already do
// (see test/_extract.mjs) — actually uses action-events.js correctly at the
// real dispatch points, without altering dispatch ordering/timing and
// without ever fabricating pointer motion for a DOM/script-only call.
//
// See reports/05-action-event-schema.md for the contract this checks.

import * as actionEvents from "../extension/events/action-events.js";
import { extractFunction, extractMethod, compile, BACKGROUND } from "./_extract.mjs";
import fs from "node:fs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// =============================================================================
// 1. dispatchPlan's new `onStep` parameter changes NOTHING for a caller that
//    omits it, and adds real-dispatch visibility for a caller that supplies
//    one — without altering the underlying dispatch calls or their order.
// =============================================================================
console.log("== dispatchPlan: onStep is additive, never changes dispatch order/content ==");
{
  function buildHarness() {
    const calls = [];
    const ensureAttached = async () => {};
    const sleep = async (ms) => { calls.push({ fn: "sleep", ms }); };
    const dispatchMouse = async (tabId, type, x, y, opts = {}) => calls.push({ fn: "mouse", type, x, y, ...opts });
    const sendMouseEvent = async (tabId, params) =>
      calls.push({ fn: "mouse", type: params.type, x: params.x, y: params.y, deltaX: params.deltaX, deltaY: params.deltaY });
    const cdp = async (tabId, method, params) => calls.push({ fn: "cdp", method, ...params });
    const cursorByTab = new Map();
    const dispatchPlan = compile(
      "",
      { ensureAttached, sleep, dispatchMouse, sendMouseEvent, cdp, cursorByTab },
      `(${extractFunction("dispatchPlan")})`
    );
    return { dispatchPlan, calls };
  }

  const humanizeMod = await import("../extension/humanize/index.js");
  const s = humanizeMod.createSession(42);
  const plan = humanizeMod.planClick(s, { x: 10, y: 10 }, { x: 400, y: 300 });

  const a = buildHarness();
  await a.dispatchPlan(1, plan, 0); // old 3-arg call site — onStep omitted entirely

  const b = buildHarness();
  const stepsSeen = [];
  await b.dispatchPlan(1, plan, 0, (step) => stepsSeen.push(step));

  ok(JSON.stringify(a.calls) === JSON.stringify(b.calls),
     `identical dispatch calls (count/order/args/timing) whether or not onStep is supplied (${a.calls.length} calls each)`);
  const dispatchedNonSleep = b.calls.filter((c) => c.fn !== "sleep").length;
  ok(stepsSeen.length === dispatchedNonSleep,
     `onStep fired exactly once per real (non-"sleep") dispatch (${stepsSeen.length} vs ${dispatchedNonSleep})`);
  ok(stepsSeen.every((s) => typeof s.k === "string"), "every step handed to onStep is a real plan step, not a synthesized one");
}

// =============================================================================
// 2. Small pure(ish) wiring helpers background.js adds: emitActionStart,
//    emitActionProgress, emitActionSettled, makePointerStepHandler,
//    deriveOutcomeStatus. Extracted together (they call each other) and
//    compiled against the REAL action-events.js plus a real DocumentIdTracker
//    — no fakes for the module under test.
// =============================================================================
console.log("\n== background.js wiring helpers, compiled against the REAL action-events.js ==");
const wiringSrc = [
  extractFunction("deriveOutcomeStatus"),
  extractFunction("emitActionStart"),
  extractFunction("emitActionProgress"),
  extractFunction("makePointerStepHandler"),
  extractFunction("emitActionSettled")
].join("\n\n");
const actionDocTracker = new actionEvents.DocumentIdTracker();
const W = compile(
  wiringSrc,
  { actionEvents, actionDocTracker },
  "({ deriveOutcomeStatus, emitActionStart, emitActionProgress, makePointerStepHandler, emitActionSettled })"
);

console.log("\n-- start precedes execution --");
{
  const seen = [];
  const off = actionEvents.onActionEvent((e) => seen.push(e));
  const before = Date.now();
  const ctx = W.emitActionStart("computer", { action: "left_click", coordinate: [1, 2], tabId: 7 }, { runId: "run_1" });
  // "Precedes execution" is a call-ORDER guarantee (this call happens before
  // any dispatch code runs, by construction of where background.js calls it
  // — see handleToolRequest()), not just a timestamp: assert both.
  ok(seen.length === 1 && seen[0].kind === actionEvents.EVENT_KINDS.START, "emitActionStart synchronously produced exactly one `start` event");
  ok(seen[0].ts >= before, "the start event's timestamp is at/after the call, never backdated");
  ok(seen[0].action.type === actionEvents.ACTION_TYPES.CLICK && seen[0].action.op === "left_click", "action classified correctly");
  ok(seen[0].tabId === 7 && seen[0].runId === "run_1" && seen[0].streamKey === "run:run_1", "identity fields threaded through from tool/args/meta");
  ok(seen[0].documentId === "7:0", "document id comes from the tracker, generation 0 before any navigation");
  ok(ctx.actionId === seen[0].actionId, "the returned ctx carries the SAME actionId the emitted event used");
  off();
}

console.log("\n-- complete/error derive ONLY from what emitActionSettled is actually given --");
{
  const seen = [];
  const off = actionEvents.onActionEvent((e) => seen.push(e));
  const ctx = W.emitActionStart("computer", { action: "left_click", coordinate: [1, 2], tabId: 7 }, {});
  seen.length = 0;
  W.emitActionSettled(ctx, actionEvents.EVENT_KINDS.COMPLETE, { extras: { artifactId: null, outcomeStatus: null, outcomeDetail: null } });
  ok(seen.length === 1 && seen[0].kind === "complete", "exactly one complete event");
  ok(seen[0].outcome.status === "success", "no extras override -> default outcome is success (dispatch went out, nothing said otherwise)");
  ok(seen[0].timing.startedAt === ctx.startedAt && typeof seen[0].timing.endedAt === "number", "timing carries the ORIGINAL start plus a real end stamp");

  seen.length = 0;
  W.emitActionSettled(ctx, actionEvents.EVENT_KINDS.COMPLETE, { extras: { artifactId: "screenshot_123", outcomeStatus: "unknown", outcomeDetail: "covered" } });
  ok(seen[0].capture.artifactId === "screenshot_123", "an explicit artifactId flows into the capture field");
  ok(seen[0].outcome.status === "unknown" && seen[0].outcome.detail === "covered", "an explicit unknown-outcome from the handler's own signal is preserved, not overwritten to success");

  seen.length = 0;
  W.emitActionSettled(ctx, actionEvents.EVENT_KINDS.ERROR, { errorSummary: actionEvents.safeErrorSummary(new Error("tab closed")) });
  ok(seen[0].kind === "error" && seen[0].outcome.status === "error" && seen[0].outcome.detail === "tab closed",
     "an error event's outcome ALWAYS reads error/<message>, never success, regardless of extras");
  off();
}

console.log("\n-- deriveOutcomeStatus: re-labels the EXISTING hitNote signal, invents nothing new --");
{
  ok(W.deriveOutcomeStatus("") === "success", "empty hitNote (no warning) -> success");
  ok(W.deriveOutcomeStatus(" — WARNING: nothing received this.") === "unknown", "a real hitNote warning -> unknown");
}

console.log("\n-- makePointerStepHandler: null for non-pointer types, batches for pointer types --");
{
  const readCtx = W.emitActionStart("read_page", { tabId: 1 }, {});
  ok(W.makePointerStepHandler(readCtx) === null, "read_page's action ctx yields NO step handler at all (nothing to fabricate)");

  const seen = [];
  const off = actionEvents.onActionEvent((e) => seen.push(e));
  const clickCtx = W.emitActionStart("computer", { action: "left_click", coordinate: [5, 5], tabId: 1 }, {});
  const handler = W.makePointerStepHandler(clickCtx);
  ok(typeof handler === "function" && typeof handler.flush === "function", "a pointer-capable ctx yields a real callback with a .flush()");
  seen.length = 0;
  for (let i = 0; i < 25; i++) handler({ k: "move", x: i, y: i });
  ok(seen.length === 1, `25 real moves at the default batch size (20) flush exactly once mid-stream so far (got ${seen.length})`);
  ok(seen[0].pointer.points.length === 20, "the flushed batch carries 20 points, not 25 individual rows");
  ok(seen[0].actionId === clickCtx.actionId, "every point in the batch is grouped under the SAME parent actionId");
  handler.flush();
  ok(seen.length === 2 && seen[1].pointer.points.length === 5, "flush() drains the trailing 5 points as one more grouped event");
  handler.flush();
  ok(seen.length === 2, "flushing an already-empty buffer emits nothing extra");
  // Non-pointer step kinds (keyboard) must never enter the pointer batch.
  seen.length = 0;
  handler({ k: "kdown", key: "a" });
  handler({ k: "text", text: "a" });
  handler({ k: "kup", key: "a" });
  handler.flush();
  ok(seen.length === 0, "keyboard-only steps are ignored by the pointer batcher — never misclassified as movement");
  off();
}

// =============================================================================
// 3. Structural proof: the SHIPPED handler bodies for DOM/script-only tools
//    never reference the pointer-emission primitives at all — the strongest
//    available guarantee, given these handlers' own dependency graphs are far
//    too large to fully execute in this offline harness (real chrome.debugger/
//    chrome.tabs/CDP would be required — see the BLOCKED items in
//    reports/05-action-event-schema.md).
// =============================================================================
console.log("\n== structural: DOM/script-only handlers never call the pointer-emission primitives ==");
for (const name of ["read_page", "get_page_text", "find", "navigate", "javascript_tool"]) {
  const body = extractMethod(name);
  ok(!/onPointerStep|makePointerStepHandler|PointBatcher/.test(body), `${name}'s shipped handler body has no pointer-emission reference`);
}

// =============================================================================
// 4. Structural proof: handleToolRequest() emits `start` strictly BEFORE
//    calling the handler, and `complete`/`error` strictly AFTER it
//    settles/throws — a textual ordering check, since the function's own
//    dependency graph (audit, toolHandlers, sendResponse/sendError, dbg...)
//    is too large to usefully execute here, and a textual guarantee on the
//    SHIPPED source is exactly what "start precedes execution" and
//    "complete/error only from executor results" need to be true of the real
//    dispatch path (the previous section already proves the emit functions
//    THEMSELVES behave correctly once called).
// =============================================================================
console.log("\n== structural: handleToolRequest's call ordering around handler(args) ==");
{
  const src = fs.readFileSync(BACKGROUND, "utf8");
  const fnStart = src.indexOf("async function handleToolRequest(");
  ok(fnStart !== -1, "handleToolRequest found in the shipped source");
  const startCallIdx = src.indexOf("emitActionStart(tool, args, meta)", fnStart);
  // The literal ASSIGNMENT statement, not just the substring "await
  // handler(args)" — several comments in this function's own doc text
  // (correctly) mention that phrase too, and would match earlier.
  const handlerCallIdx = src.indexOf("result = await handler(args);", fnStart);
  const completeCallIdx = src.indexOf("emitActionSettled(actionCtx, actionEvents.EVENT_KINDS.COMPLETE", fnStart);
  const errorCallIdx = src.indexOf("emitActionSettled(actionCtx, actionEvents.EVENT_KINDS.ERROR", fnStart);
  ok(startCallIdx !== -1 && handlerCallIdx !== -1 && completeCallIdx !== -1 && errorCallIdx !== -1,
     "all four call sites present in handleToolRequest");
  ok(startCallIdx < handlerCallIdx, "emitActionStart() is called BEFORE `await handler(args)` — start precedes execution");
  ok(completeCallIdx > handlerCallIdx, "the COMPLETE emission call is textually after `await handler(args)` — never before the result exists");
  ok(errorCallIdx > handlerCallIdx, "the ERROR emission call is textually after `await handler(args)` — inside its catch block, only reachable on an actual throw");
}

console.log(fail === 0 ? "\nALL ACTION-EVENT EMISSION TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// mouse_move / cursor_position — the two pointer actions behind the
// computer-use beta's action set (added so the registry's `computer`
// vocabulary stops being a subset of what the official extension accepts).
//
// What this pins, against the SHIPPED handler body extracted from
// extension/background.js:
//  - mouse_move dispatches a real `mouseMoved` to the coordinate AFTER it is
//    mapped out of the model's screenshot space (screenshotToCssCoordinate),
//    updates cursorByTab, and never probes/click — unlike hover it also never
//    implies a hover state it is not waiting for.
//  - mouse_move under humanize goes through the same curved plan hover uses.
//  - cursor_position reports the tracked position, and reports "not known"
//    rather than inventing (0, 0) on a tab that never had a pointer action.
//  - Both refuse the way every other action does when an input is missing.
//
// Run: node test/computer-pointer-actions.test.mjs

import { extractMethod, compile } from "./_extract.mjs";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Build the shipped `computer` method with a recording dependency set. */
function makeHarness({ humanize = false, pointerKnown = null } = {}) {
  const dispatched = [];
  const plans = [];
  const cursorByTab = new Map();
  if (pointerKnown) cursorByTab.set(7, pointerKnown);
  const calls = { probeHit: 0, humanizeOn: 0 };
  const record = { dispatched, plans, calls };

  const src = [
    `const H_computer = { ${extractMethod("computer")} };`
  ].join("\n\n");

  const W = compile(
    src,
    {
      currentAction: null,
      currentActionExtras: null,
      isInGroup: async () => true,
      // The model supplied [10, 20] in image pixels; the harness's "capture
      // scale" is 2x, so the dispatch must arrive at [20, 40] — proving the
      // mapping is applied and not skipped.
      screenshotToCssCoordinate: (_tabId, c) => (Array.isArray(c) ? [c[0] * 2, c[1] * 2] : undefined),
      parseModifierString: () => 0,
      makePointerStepHandler: () => null,
      humanizeOn: async () => {
        calls.humanizeOn++;
        return humanize;
      },
      human: () => ({}),
      effectiveConfig: () => ({ humanize_speed: "fast", humanize_seed: 1 }),
      humanize: { planHover: (_s, from, to) => ({ from, to }) },
      dispatchPlan: async (tabId, plan) => {
        plans.push(plan);
        cursorByTab.set(tabId, { x: plan.to[0] !== undefined ? plan.to[0] : plan.to.x, y: plan.to[1] !== undefined ? plan.to[1] : plan.to.y });
      },
      dispatchMouse: async (tabId, type, x, y) => {
        dispatched.push({ tabId, type, x, y });
      },
      cursorByTab,
      record,
      probeHit: async () => {
        calls.probeHit++;
        return { ok: true, r: { hit: null } };
      },
      dbg: () => {}
    },
    "{ H_computer, record, cursorByTab }"
  );

  return { computer: W.H_computer.computer, dispatched: record.dispatched, plans: record.plans, cursorByTab: W.cursorByTab, calls: record.calls };
}

console.log("\n== mouse_move ==");

await testAsync("dispatches a real mouseMoved to the MAPPED coordinate (never a click, never a probe)", async () => {
  const h = makeHarness();
  const res = await h.computer({ action: "mouse_move", tabId: 7, coordinate: [10, 20] });

  assertEq(h.dispatched.length, 1, "exactly one pointer event");
  assertEq(h.dispatched[0].type, "mouseMoved", "and it is a move, not a press/release");
  assertEq(h.dispatched[0].x, 20, "x is mapped out of screenshot space");
  assertEq(h.dispatched[0].y, 40, "y is mapped out of screenshot space");
  assertEq(h.calls.probeHit, 0, "a move never hit-probes (there is no click to interpret)");
  assert(/Moved the cursor to \(20, 40\)/.test(res.content[0].text), `result names the position: ${res.content[0].text}`);
});

await testAsync("tracks the position so cursor_position can answer afterwards", async () => {
  const h = makeHarness();
  await h.computer({ action: "mouse_move", tabId: 7, coordinate: [10, 20] });
  assert(h.cursorByTab.get(7) && h.cursorByTab.get(7).x === 20 && h.cursorByTab.get(7).y === 40, "cursorByTab holds the dispatched position");

  const res = await h.computer({ action: "cursor_position", tabId: 7 });
  assert(res.content[0].text.includes("(20, 40)"), `cursor_position reports what mouse_move left: ${res.content[0].text}`);
});

await testAsync("under humanize, moves along the same curved plan hover uses", async () => {
  const h = makeHarness({ humanize: true });
  await h.computer({ action: "mouse_move", tabId: 7, coordinate: [10, 20] });

  assertEq(h.plans.length, 1, "the humanized path ran");
  assertEq(h.dispatched.length, 0, "and dispatched through the plan, not as one jump");
  assert(h.plans[0].to && h.plans[0].to.x === 20 && h.plans[0].to.y === 40, `plan targets the mapped point: ${JSON.stringify(h.plans[0].to)}`);
});

await testAsync("refuses without a coordinate, the way the other coordinate actions do", async () => {
  const h = makeHarness();
  const res = await h.computer({ action: "mouse_move", tabId: 7 });
  assert(/coordinate is required for mouse_move/.test(res.content[0].text), `refusal names the missing argument: ${res.content[0].text}`);
  assertEq(h.dispatched.length, 0, "nothing was dispatched");
});

console.log("\n== cursor_position ==");

await testAsync("reports 'not known' instead of inventing (0, 0) on a tab with no pointer history", async () => {
  const h = makeHarness();
  const res = await h.computer({ action: "cursor_position", tabId: 7 });
  const text = res.content[0].text;
  assert(/not known yet/i.test(text), `says it does not know: ${text}`);
  assert(!/\(0, 0\)/.test(text), "and never fabricates a position");
  assertEq(h.dispatched.length, 0, "reading the position dispatches nothing");
});

await testAsync("reports the tracked position when one exists", async () => {
  const h = makeHarness({ pointerKnown: { x: 123, y: 456 } });
  const res = await h.computer({ action: "cursor_position", tabId: 7 });
  assert(/\(123, 456\)/.test(res.content[0].text), `reports the exact tracked point: ${res.content[0].text}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

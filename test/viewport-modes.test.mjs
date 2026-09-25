#!/usr/bin/env node
//
// Pure-logic coverage for viewportModeParams() (extension/background.js):
// mode + the bound tab's own current size -> the exact CDP command bodies
// applyViewportMode() sends. No chrome.* here — see design.md
// (add-page-viewport-modes) Decisions 1-5 for the numbers this asserts.
//
// Run: node test/viewport-modes.test.mjs

import { extractFunction, compile } from "./_extract.mjs";

let failed = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
}

// Mirrors extension/background.js's own VIEWPORT_MODES table (design.md
// Decision 1) — the same small-constant-duplication test/screenshot-scale.test.mjs
// already uses for MODEL_IMAGE_MAX_EDGE, so viewportModeParams stays testable
// in plain Node without dragging chrome.* or the rest of background.js in.
const VIEWPORT_MODES = Object.freeze({
  mobile: Object.freeze({ width: 390, deviceScaleFactor: 3 }),
  tablet: Object.freeze({ width: 768, deviceScaleFactor: 2 }),
  pc: Object.freeze({ width: 1280, deviceScaleFactor: 0 }),
});
const VIEWPORT_UA_FALLBACK_MAJOR = 131;

const viewportModeParams = compile(
  [extractFunction("coercePositiveNumber"), extractFunction("viewportModeParams")].join("\n\n"),
  { VIEWPORT_MODES, VIEWPORT_UA_FALLBACK_MAJOR },
  "viewportModeParams"
);

console.log("\nthe table values\n");

const mobileBase = viewportModeParams("mobile", 1020, 780, 131);
ok(mobileBase.metrics.width === 390 && mobileBase.metrics.deviceScaleFactor === 3, "mobile: 390px, DPR 3");
const tabletBase = viewportModeParams("tablet", 1020, 780, 131);
ok(tabletBase.metrics.width === 768 && tabletBase.metrics.deviceScaleFactor === 2, "tablet: 768px, DPR 2");
const pcBase = viewportModeParams("pc", 1020, 780, 131);
ok(pcBase.metrics.width === 1280 && pcBase.metrics.deviceScaleFactor === 0, "pc: 1280px, DPR 0 (the window's own)");

console.log("\nmobile at 1020x780\n");

ok(mobileBase.metrics.height === 780, "height follows the tab's own current height");
ok(mobileBase.metrics.mobile === true, "mobile: true");
// Measured with raw CDP against real Chrome (cdp-probe.mjs + a headful screen
// capture): positionX/positionY never centre the painted view — Chrome always
// paints the emulated view at the tab's top-left, and a non-zero positionX
// only misreports the page's own window.screenX/screenLeft. They are
// therefore dropped entirely (design.md Decision 4), not "best-effort".
ok(!("positionX" in mobileBase.metrics), `positionX is not sent (got ${mobileBase.metrics.positionX})`);
ok(!("positionY" in mobileBase.metrics), `positionY is not sent (got ${mobileBase.metrics.positionY})`);
ok(mobileBase.touch.enabled === true && mobileBase.touch.maxTouchPoints === 5, "touch on, maxTouchPoints 5");
ok(mobileBase.emitTouch.enabled === true && mobileBase.emitTouch.configuration === "mobile", "emits touch for mouse input, configuration mobile");

console.log("\ntablet\n");

ok(tabletBase.metrics.mobile === true, "tablet also sets metrics.mobile: true (it is a touch device)");
ok(tabletBase.touch.enabled === true, "touch on");

console.log("\npc scale\n");

const pcNarrow = viewportModeParams("pc", 1020, 780, 131);
ok(Math.abs(pcNarrow.metrics.scale - 0.797) < 0.001, `pc at 1020 wide scales to ~0.797 (got ${pcNarrow.metrics.scale})`);
const pcWide = viewportModeParams("pc", 1600, 900, 131);
ok(pcWide.metrics.scale === 1, `pc at 1600 wide is not magnified past 1 (got ${pcWide.metrics.scale})`);
ok(pcBase.metrics.mobile === false, "pc: metrics.mobile false");
ok(pcBase.userAgent === null, "pc: user agent unchanged (null means \"don't override\")");

console.log("\ntouch off (pc) sends no maxTouchPoints\n");

// Measured with cdp-probe.mjs against real Chrome: Emulation.setTouchEmulationEnabled
// rejects maxTouchPoints outside 1..16 with CDP error -32602, even when
// enabled:false — sending {enabled:false, maxTouchPoints:0} (the previous
// build's literal) made PC always fail to apply. Only {enabled:false}, with
// no maxTouchPoints key at all, clears touch successfully.
ok(pcBase.touch.enabled === false && pcBase.emitTouch.enabled === false, "pc: no touch emulation");
ok(!("maxTouchPoints" in pcBase.touch), `pc touch carries no maxTouchPoints key (got ${JSON.stringify(pcBase.touch)})`);

console.log("\nmobile/tablet in a tab narrower than the device width\n");

// Measured with cdp-probe.mjs against real Chrome: without scaling down,
// setDeviceMetricsOverride for Mobile/Tablet in a tab narrower than the
// device width failed with -32602 "View position should be on the screen"
// (a side effect of the positionX this file no longer sends). Device modes
// must scale down like pc already does, using the exact same rule.
const mobileNarrow = viewportModeParams("mobile", 300, 600, 131);
ok(mobileNarrow.metrics.scale > 0 && mobileNarrow.metrics.scale <= 1, `mobile at 300 wide has scale in (0,1] (got ${mobileNarrow.metrics.scale})`);
ok(mobileNarrow.metrics.scale < 1, `mobile at 300 wide (narrower than 390) is scaled down (got ${mobileNarrow.metrics.scale})`);
ok(Math.abs(mobileNarrow.metrics.scale - 300 / 390) < 0.001, `mobile scale follows min(1, tabWidth/width) (got ${mobileNarrow.metrics.scale})`);
ok(!("positionX" in mobileNarrow.metrics) && !("positionY" in mobileNarrow.metrics), "mobile in a narrow tab still sends no positionX/positionY");

const tabletNarrow = viewportModeParams("tablet", 600, 800, 131);
ok(tabletNarrow.metrics.scale > 0 && tabletNarrow.metrics.scale <= 1, `tablet at 600 wide has scale in (0,1] (got ${tabletNarrow.metrics.scale})`);
ok(tabletNarrow.metrics.scale < 1, `tablet at 600 wide (narrower than 768) is scaled down (got ${tabletNarrow.metrics.scale})`);
ok(Math.abs(tabletNarrow.metrics.scale - 600 / 768) < 0.001, `tablet scale follows min(1, tabWidth/width) (got ${tabletNarrow.metrics.scale})`);

console.log("\nChrome's validated CDP ranges hold across tab widths 200-2000\n");

// Pins the exact ranges chrome.debugger's Emulation domain validates
// (measured with cdp-probe.mjs): maxTouchPoints must be 1..16 or absent,
// positionX/positionY (when sent at all) must be >= 0, and scale must stay
// in (0, 1] — never magnified past 1, never zero or negative.
let rangeFailed = false;
for (let tabWidth = 200; tabWidth <= 2000; tabWidth += 50) {
  for (const mode of ["mobile", "tablet", "pc"]) {
    const p = viewportModeParams(mode, tabWidth, 800, 131);
    if (!p) { rangeFailed = true; continue; }
    if ("maxTouchPoints" in p.touch && (p.touch.maxTouchPoints < 1 || p.touch.maxTouchPoints > 16)) rangeFailed = true;
    if ("positionX" in p.metrics && p.metrics.positionX < 0) rangeFailed = true;
    if ("positionY" in p.metrics && p.metrics.positionY < 0) rangeFailed = true;
    if (!(p.metrics.scale > 0 && p.metrics.scale <= 1)) rangeFailed = true;
    const spec = VIEWPORT_MODES[mode];
    const expectedBelowOne = tabWidth < spec.width;
    if (expectedBelowOne && !(p.metrics.scale < 1)) rangeFailed = true;
  }
}
ok(!rangeFailed, "maxTouchPoints in 1..16 or absent, positionX/positionY absent or >=0, scale in (0,1] and <1 when narrower, for tab widths 200-2000");

console.log("\nuser agent strings\n");

ok(mobileBase.userAgent.includes("Android") && mobileBase.userAgent.includes("Mobile"),
  `phone UA carries Android + Mobile (got ${mobileBase.userAgent})`);
ok(tabletBase.userAgent.includes("Android") && !tabletBase.userAgent.includes("Mobile"),
  `tablet UA carries Android without Mobile (got ${tabletBase.userAgent})`);
ok(mobileBase.userAgent.includes("131") && tabletBase.userAgent.includes("131"),
  "the browser's own major version is used, not a hardcoded one");
ok(mobileBase.userAgentMetadata.mobile === true && tabletBase.userAgentMetadata.mobile === false,
  "userAgentMetadata.mobile agrees with each mode's own UA string");
ok(mobileBase.userAgentMetadata.platform === "Android" && tabletBase.userAgentMetadata.platform === "Android",
  "Client Hints platform is Android for both device modes");

console.log("\nfit and unknown modes\n");

ok(viewportModeParams("fit", 1020, 780, 131) === null, "fit returns null");
ok(viewportModeParams("unknown-mode", 1020, 780, 131) === null, "an unrecognized mode returns null");

console.log("\ngarbage input does not throw\n");

let threw = false;
const garbageCalls = [
  () => viewportModeParams("mobile", NaN, NaN, NaN),
  () => viewportModeParams("mobile", "abc", "def", "ghi"),
  () => viewportModeParams("mobile", -100, -50, -1),
  () => viewportModeParams("mobile", 0, 0, 0),
  () => viewportModeParams("mobile", null, undefined, null),
  () => viewportModeParams(undefined, undefined, undefined, undefined),
  () => viewportModeParams(null, 1020, 780, 131),
  () => viewportModeParams("pc", Infinity, Infinity, 131),
];
for (const call of garbageCalls) {
  try {
    call();
  } catch {
    threw = true;
  }
}
ok(!threw, "no combination of garbage input throws");

const garbageMobile = viewportModeParams("mobile", NaN, NaN, NaN);
ok(garbageMobile && garbageMobile.metrics.width === 390 && Number.isFinite(garbageMobile.metrics.height) && garbageMobile.metrics.height > 0,
  "garbage tab size still falls back to a sane, finite, positive height");
const garbagePc = viewportModeParams("pc", "not a number", 780, 131);
ok(garbagePc && Number.isFinite(garbagePc.metrics.scale) && garbagePc.metrics.scale > 0,
  "garbage tab width still falls back to a finite, positive pc scale");

console.log(failed ? `\n${failed} FAILED\n` : "\nAll passed\n");
process.exit(failed ? 1 : 0);

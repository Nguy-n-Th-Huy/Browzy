#!/usr/bin/env node
//
// A caller can ask for a smaller screenshot, and coordinates still land.
//
// A picture costs the model by AREA, and the browser prompt tells it to look
// after every step that changes the page — so image tokens, not CDP, are where
// a run spends its waiting. Half the width and height is roughly a quarter of
// the cost. That is only safe if a coordinate read off the smaller image still
// reaches the same point on the page, which is the whole of what this checks:
// the requested factor lands in the same `shotScale` that captureScaleByTab
// records, and screenshotToCssCoordinate divides it back out.
//
// Run: node test/screenshot-scale.test.mjs

import { extractFunction, compile } from "./_extract.mjs";

let failed = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
}

const captureScaleByTab = new Map();
const W = compile(
  [
    extractFunction("requestedScale"),
    extractFunction("captureScaleForViewport"),
    extractFunction("screenshotToCssCoordinate")
  ].join("\n\n"),
  { captureScaleByTab, MODEL_IMAGE_MAX_EDGE: 1568, MIN_REQUESTED_SCALE: 0.1 },
  "({ requestedScale, captureScaleForViewport, screenshotToCssCoordinate })"
);

console.log("\nrequested screenshot scale\n");

ok(W.requestedScale(undefined) === 1, "absent means full size");
ok(W.requestedScale(0.5) === 0.5, "a factor in range is taken as given");
ok(W.requestedScale(2) === 1, "above 1 is clamped to full size, never magnified");
ok(W.requestedScale(0.01) === 0.1, "below the floor is clamped, not honoured");
ok(W.requestedScale("nonsense") === 1 && W.requestedScale(0) === 1 && W.requestedScale(-1) === 1,
   "anything unparseable or non-positive falls back to full size — a bad number must not silently shrink the picture");

console.log("\ncoordinates read off a scaled image still reach the page\n");

// A 1200x800 viewport already fits under the model's edge cap, so the cap
// contributes nothing and the caller's factor is the whole scale — the common
// laptop case this option is for.
const capped = W.captureScaleForViewport(1200, 800);
ok(capped === 1, "a viewport under the cap is captured 1:1 before any request");

const shotScale = capped * W.requestedScale(0.5);
captureScaleByTab.set(7, shotScale);
ok(shotScale === 0.5, "the caller's factor is what the tab's capture scale becomes");

const onPage = W.screenshotToCssCoordinate(7, [300, 200]);
ok(onPage[0] === 600 && onPage[1] === 400,
   "a point at (300,200) in the half-size image dispatches to (600,400) on the page");

// A viewport that needs the cap AND a requested shrink: both factors apply, and
// the mapping still has to invert the product, not just one half of it.
const bigCap = W.captureScaleForViewport(3136, 1960);
ok(bigCap === 0.5, "a 3136px-wide viewport is halved by the model-edge cap alone");
captureScaleByTab.set(8, bigCap * W.requestedScale(0.5));
const bothWays = W.screenshotToCssCoordinate(8, [100, 50]);
ok(bothWays[0] === 400 && bothWays[1] === 200,
   "cap and request compound, and the coordinate is mapped back through both");

// No capture yet means no image the model could have read a coordinate off, so
// whatever arrives is already CSS pixels — a ref, typically.
ok(W.screenshotToCssCoordinate(99, [10, 20])[0] === 10,
   "a tab that has never been captured maps nothing");

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
//
// A ref decides where the click goes, even when a coordinate arrives with it.
//
// The two describe the same click and only one of them is measured: the ref is
// resolved against the live element (and scrolled into view, and hit-tested),
// the coordinate is a pixel read off a picture. They arrive together often,
// because the tool schema calls `coordinate` required for left_click and `ref`
// merely an alternative — so a model that located the control with `find`
// still fills in a pixel it eyeballed.
//
// While the resolution was gated on `!coordinate`, that pixel won: no scroll
// into view, no hit probe (the branch below it assumes the resolve already did
// one), a clean `success` outcome, and a log line claiming the ref was
// "reachable" when nothing had resolved it. Every miss from a guessed
// coordinate looked, from the inside, exactly like a click that worked.
//
// Structural proof against the shipped handler body: computer()'s own
// dependency graph (chrome.debugger, CDP, the dispatch planner, the overlay
// bridge) is far too large to execute in this offline harness — the same
// reason action-events-emission.test.mjs proves its ordering textually.
//
// Run: node test/ref-beats-coordinate.test.mjs

import { extractMethod } from "./_extract.mjs";

let failed = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
}

/** Index just past the `{...}` block that opens at or after `from`. */
function endOfBlock(src, from) {
  let depth = 0;
  for (let k = src.indexOf("{", from); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return k;
  }
  throw new Error("unbalanced braces");
}

console.log("\na ref outranks a coordinate sent alongside it\n");

const body = extractMethod("computer");

ok(
  !/if \(args\.ref && !coordinate\)/.test(body),
  "ref resolution is not gated on the coordinate being absent — that gate is what let a guessed pixel win"
);

const guard = body.indexOf("if (args.ref) {");
ok(guard !== -1, "the resolution branch is entered whenever a ref is supplied");

const branchEnd = endOfBlock(body, guard);
const resolve = body.indexOf("resolveRefToCoordinates(tabId, args.ref)");
const assign = body.indexOf("coordinate = [res.x, res.y];");

ok(guard < resolve && resolve < branchEnd, "the ref is resolved inside that branch");
ok(
  guard < assign && assign < branchEnd,
  "and the resolved position overwrites whatever coordinate came in with it"
);

const hitBranch = body.indexOf("if (args.ref && coordinate) {");
ok(hitBranch !== -1, "the hit-note branch for a ref click is still present");
ok(
  hitBranch > branchEnd,
  "it runs after the resolution branch, so its assumption that the ref was already resolved and hit-tested holds"
);

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);

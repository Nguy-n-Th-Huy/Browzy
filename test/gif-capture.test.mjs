// Unit tests for correlateClicksToFrames() in extension/background.js,
// exercising the SHIPPED function via test/_extract.mjs. Plain Node.
import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const correlate = compile(
  extractFunction("correlateClicksToFrames"),
  {},
  "{ correlateClicksToFrames }"
).correlateClicksToFrames;

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("== interval containment ==");
{
  const frames = [1000, 2000, 3000];
  const clicks = [
    { t: 1000, x: 10, y: 10 }, // exactly on a frame start -> that frame
    { t: 1500, x: 20, y: 20 },
    { t: 2000, x: 30, y: 30 }, // boundary -> the later frame, not the earlier
    { t: 2999, x: 40, y: 40 }, // just before the next frame -> still frame 1
  ];
  const per = correlate(frames, clicks, 4000);
  ok(eq(per[0], [{ x: 10, y: 10 }, { x: 20, y: 20 }]), `frame 0 takes [1000,2000) (got ${JSON.stringify(per[0])})`);
  ok(eq(per[1], [{ x: 30, y: 30 }, { x: 40, y: 40 }]), `frame 1 takes [2000,3000), including t=2999 (got ${JSON.stringify(per[1])})`);
  ok(eq(per[2], []), `frame 2 starts at 3000 and takes nothing here (got ${JSON.stringify(per[2])})`);
}

console.log("== out-of-window clicks are dropped, never snapped ==");
{
  const frames = [1000, 2000];
  const per = correlate(
    frames,
    [
      { t: 999, x: 1, y: 1 }, // before the first frame
      { t: 4000, x: 2, y: 2 }, // at windowEnd -> outside (half-open)
      { t: 5000, x: 3, y: 3 }, // after the window
    ],
    4000
  );
  ok(per[0].length === 0 && per[1].length === 0, "no marker invented for any out-of-window click");
}

console.log("== degenerate inputs ==");
{
  ok(eq(correlate([], [{ t: 5, x: 1, y: 1 }], 10), []), "no frames -> no assignments");
  ok(eq(correlate([100], [], 200)[0], []), "no clicks -> empty frame");
  const per = correlate([100], [{ t: 150, x: 1, y: 1 }, { x: 2, y: 2 }, null, { t: "x", x: 1, y: 1 }], 200);
  ok(eq(per[0], [{ x: 1, y: 1 }]), "entries without a numeric timestamp are skipped");
  // No windowEnd: the last frame stays open rather than dropping late clicks.
  const open = correlate([100, 200], [{ t: 9999, x: 9, y: 9 }], undefined);
  ok(eq(open[1], [{ x: 9, y: 9 }]), "missing windowEnd leaves the last frame open-ended");
}

console.log("== coordinates pass through untouched ==");
{
  const per = correlate([0], [{ t: 0, x: 12.7, y: 99.2, phase: "down", extra: true }], 10);
  ok(eq(per[0], [{ x: 12.7, y: 99.2 }]), "only x/y survive; rounding is the drawer's job, not the correlator's");
}

console.log(fail === 0 ? "\nALL GIF CAPTURE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

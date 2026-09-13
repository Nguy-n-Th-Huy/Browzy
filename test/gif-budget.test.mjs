// Unit tests for the export-size ladder in extension/recorder/offscreen.js,
// exercising the SHIPPED gifLadder() via test/_extract.mjs. Plain Node.
import { extractFunction, compile } from "./_extract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(__dirname, "..", "extension", "recorder", "offscreen.js");

const { gifLadder, gifTierWidth } = compile(
  [extractFunction("gifLadder", OFFSCREEN), extractFunction("gifTierWidth", OFFSCREEN)].join("\n\n"),
  {},
  "{ gifLadder, gifTierWidth }"
);

console.log("== the ladder starts where an unconstrained export would ==");
{
  const l = gifLadder(640);
  ok(l[0].w === 640 && l[0].stride === 1, "first rung is the requested tier at full frame rate");
}

console.log("== every rung is cheaper than the one before ==");
{
  for (const base of [640, 480, 320]) {
    const l = gifLadder(base);
    let monotonic = true;
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i];
      // Cost falls if the frame gets smaller or frames get dropped, and
      // neither may ever go back up.
      if (b.w > a.w || b.stride < a.stride) monotonic = false;
      if (b.w === a.w && b.stride === a.stride) monotonic = false;
    }
    ok(monotonic, `base ${base}: each rung strictly cheaper, never wider or denser`);
  }
}

console.log("== width is spent before frames are dropped ==");
{
  const l = gifLadder(640);
  const firstDrop = l.findIndex((s) => s.stride > 1);
  const narrowedBefore = l.slice(0, firstDrop).some((s) => s.w < l[0].w);
  ok(firstDrop > 1, "the ladder narrows at least twice before dropping any frame");
  ok(narrowedBefore, "narrowing happens before the first dropped frame");
}

console.log("== the ladder stays legible at the bottom ==");
{
  for (const base of [640, 480, 320]) {
    const l = gifLadder(base);
    ok(l.every((s) => s.w >= 160), `base ${base}: no rung narrower than 160px`);
    ok(l.every((s) => Number.isInteger(s.w) && s.w > 0), `base ${base}: every width is a positive whole pixel count`);
    ok(l.every((s) => Number.isInteger(s.stride) && s.stride >= 1), `base ${base}: every stride is a whole frame count`);
  }
}

console.log("== the bottom rung is a real reduction ==");
{
  const l = gifLadder(640);
  const last = l[l.length - 1];
  ok(last.w * last.stride > 0 && last.w < 640 && last.stride > 1, "the cheapest rung both narrows and drops frames");
}

console.log("== tier widths the ladder is built on ==");
{
  ok(gifTierWidth(10) === 640 && gifTierWidth(undefined) === 640, "default quality is the widest tier");
  ok(gifTierWidth(20) === 480 && gifTierWidth(30) === 320, "higher quality numbers mean smaller frames");
}

if (fail) { console.error(fail + " FAILURES"); process.exit(1); }
console.log("\nALL GIF BUDGET TESTS PASSED");

#!/usr/bin/env node
//
// A click that lands on the element it aimed at is reported as a success.
//
// probeHit()'s result feeds two different things: the note the caller reads,
// and the outcome label the action timeline records. hitLandedNote_ is part of
// the first and explicitly not part of the second — it says WHICH element
// received a clean click. Routing it through deriveOutcomeStatus(), which
// treats any non-empty note as doubt, marked every successful click "unknown".
// A run reading that timeline saw its own completed work as a page of
// maybe-failures and re-screenshotted, re-clicked and second-guessed it.
//
// Run: node test/hit-outcome.test.mjs

import { extractFunction, compile } from "./_extract.mjs";

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nprobeNotes_ separates the caller's note from the outcome warning\n");

const src = [
  extractFunction("hitNote_"),
  extractFunction("hitLandedNote_"),
  extractFunction("probeNotes_"),
  extractFunction("deriveOutcomeStatus")
].join("\n\n");
const W = compile(src, { actionEvents: { OUTCOME_STATUSES: { SUCCESS: "success", UNKNOWN: "unknown" } } },
  "({ probeNotes_, deriveOutcomeStatus })");

/** A probe result for a click that landed on a real element. */
const landed = { ok: true, r: { hit: { tag: "button", attrs: { type: "submit" }, text: "Tìm kiếm" } } };
/** A probe that found nothing under the point — the genuine warning case. */
const nothing = { ok: true, r: { hit: null } };
/** The probe itself could not run. */
const failed = { ok: false };

test("a click that lands on an element still reports WHICH element", () => {
  const { note } = W.probeNotes_(landed);
  assert(note.includes("landed on <button"), `expected the landed note, got ${JSON.stringify(note)}`);
});

test("...and that note is not treated as a warning", () => {
  const { warning } = W.probeNotes_(landed);
  assert(warning === "", `a clean hit has nothing to warn about, got ${JSON.stringify(warning)}`);
  assert(
    W.deriveOutcomeStatus(warning) === "success",
    "a click that hit its target must record success — labelling it unknown is what made a run doubt its own completed work"
  );
});

test("a click that hit nothing is still a warning, and still unknown", () => {
  const { note, warning } = W.probeNotes_(nothing);
  assert(warning !== "", "nothing under the point is exactly what a warning is for");
  assert(note === warning, "the caller sees the warning itself, not a landed note");
  assert(W.deriveOutcomeStatus(warning) === "unknown", "a real warning must still downgrade the outcome");
});

test("a probe that could not run claims nothing either way", () => {
  const { note, warning } = W.probeNotes_(failed);
  assert(note === "" && warning === "", "no probe result is not evidence of a miss");
  assert(W.deriveOutcomeStatus(warning) === "success", "and must not be reported as doubt on its own");
});

const failedTests = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failedTests.length}/${results.length} passed` +
    (failedTests.length ? `\n\nFailures:\n${failedTests.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failedTests.length ? 1 : 0);

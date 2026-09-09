#!/usr/bin/env node
// The ask-the-user question card must survive text longer than the panel is
// wide.
//
// The panel is a sidebar a few hundred pixels across, and a question option is
// a whole sentence — but `.question-option` is built from `.btn`, and `.btn`
// is `white-space: nowrap` (correct for a two-word button label, wrong for a
// sentence). A long option therefore ran straight off the edge, taking the
// rest of its own text with it. The card head had the matching problem one
// level up: it is a flex row, and a flex item's default `min-width: auto`
// refuses to shrink below its longest unbreakable run.
//
// Neither failure throws, and neither shows up in any behavioural test — the
// text is simply not on screen. So the rules are asserted directly.
//
// Run: node test/question-card-wrapping.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

const components = read("extension/ui/components.css");
const panel = read("extension/sidepanel/sidepanel.css");
const panelJs = read("extension/sidepanel/sidepanel.js");

/** The declaration block for one selector, as shipped. */
function block(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return null;
  return css.slice(at, css.indexOf("}", at) + 1);
}

console.log("\n== the option buttons wrap ==");
{
  // Establish the premise the fix exists for, so this test still means
  // something if .btn ever changes.
  ok(/white-space:\s*nowrap/.test(block(components, ".btn")), ".btn is nowrap — correct for a button, and the reason an option needed an override");
  ok(/question-option/.test(panelJs), "answer options really are rendered with the .question-option class");
  ok(/btn btn-secondary btn-sm question-option/.test(panelJs), "and really do inherit .btn, so that nowrap applies to them");

  const opt = block(panel, ".question-option");
  ok(Boolean(opt), ".question-option has its own rule");
  ok(/white-space:\s*normal/.test(opt), "which overrides nowrap, so a sentence-length option wraps instead of running off the edge");
  ok(/overflow-wrap:\s*anywhere/.test(opt), "and breaks a long unspaced run (a URL, an id) rather than overflowing on it");
  ok(/line-height:\s*1\.4/.test(opt), "with room between the wrapped lines — .btn's line-height:1 assumes a single line");
}

console.log("\n== the question text itself wraps ==");
{
  const head = block(components, ".permission-card-head > *");
  ok(Boolean(head), "the card head's children have a rule of their own");
  ok(/min-width:\s*0/.test(head), "setting min-width:0, without which the text column will not shrink below its longest word");

  ok(/overflow-wrap:\s*anywhere/.test(block(components, ".permission-card-title")), "the card title breaks long runs");
  ok(/overflow-wrap:\s*anywhere/.test(block(components, ".permission-card-detail")), "and so does the question body");
  ok(
    /overflow-wrap:\s*anywhere/.test(block(components, ".permission-card-target")),
    "the target line already did — this fix brings the rest of the card up to it, rather than inventing a new convention"
  );
}

console.log("\n== the option's own two lines are bounded ==");
{
  ok(/max-width:\s*100%/.test(block(panel, ".question-option-label")), "the label cannot exceed its button");
  ok(/max-width:\s*100%/.test(block(panel, ".question-option-desc")), "nor can the description");
}

console.log(fail === 0 ? "\nALL QUESTION-CARD WRAPPING TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

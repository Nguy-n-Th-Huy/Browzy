#!/usr/bin/env node
// A draft longer than the composer's height cap must stay reachable: the
// textarea should scroll to it, not clip it. This regressed once before
// (`overflow: hidden` on `.composer textarea`, meant only to keep the
// composer's rounded box from bleeding, also killed vertical scrolling once
// content passed max-height) and `autoGrow()` in sidepanel.js duplicated the
// CSS cap as a bare `120` literal, so the two could silently drift.
//
// sidepanel.js touches `document` at module scope, so it cannot be imported
// into a plain-Node test without a browser (same constraint as
// test/composer-add-and-effort.test.mjs). This holds source-level assertions
// against the shipped CSS/JS instead.
//
// Run: node test/composer-textarea-scroll.test.mjs

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

const panelCss = read("extension/sidepanel/sidepanel.css");
const panelJs = read("extension/sidepanel/sidepanel.js");

console.log("\n== .composer textarea: capped but scrollable ==");
{
  const block = panelCss.match(/\.composer textarea \{([\s\S]*?)\}/);
  ok(Boolean(block), "sidepanel.css declares .composer textarea");
  const body = block[1];

  ok(/overflow-y:\s*auto/.test(body), "overflow-y is auto, so a draft past the cap can be scrolled to");
  ok(/overflow-x:\s*hidden/.test(body), "overflow-x stays hidden, so nothing bleeds past the rounded composer box horizontally");
  ok(!/overflow:\s*hidden/.test(body), "the old blanket overflow: hidden (which also blocked vertical scrolling) is gone");

  ok(
    /max-height:\s*min\(160px,\s*40vh\)/.test(body),
    "the height cap is min(160px, 40vh), tall enough to be useful but not so tall it breaks the composer layout"
  );
  ok(/min-height:\s*24px/.test(body), "min-height stays 24px");
  ok(/resize:\s*none/.test(body), "resize stays none");

  ok(
    !/(^|[^-])flex:\s*1\b/.test(body),
    "the textarea no longer carries flex: 1 -- in the composer's column layout that would govern height " +
      "distribution and fight the inline height autoGrow() sets directly on the element"
  );
}

console.log("\n== .composer: two-row layout (textarea full width, actions below) ==");
{
  const block = panelCss.match(/\.composer \{([\s\S]*?)\}/);
  ok(Boolean(block), "sidepanel.css declares .composer");
  const body = block[1];

  ok(
    /flex-direction:\s*column/.test(body),
    ".composer stacks its children in a column, so the textarea gets the full inner width on its own row " +
      "instead of sharing one horizontal row with the action buttons"
  );
  ok(/align-items:\s*stretch/.test(body), ".composer stretches its row children to the full width");
}

console.log("\n== .composer-actions: left/right split ==");
{
  const enhanceBlock = panelCss.match(/#btn-enhance\s*\{([\s\S]*?)\}/);
  ok(Boolean(enhanceBlock), "sidepanel.css declares a #btn-enhance rule");
  ok(
    Boolean(enhanceBlock) && /margin-left:\s*auto/.test(enhanceBlock[1]),
    "#btn-enhance carries margin-left: auto, splitting the action row into add/effort/model (left) and " +
      "enhance/send (right)"
  );
}

console.log("\n== autoGrow(): one source of truth for the cap ==");
{
  const block = panelJs.match(/function autoGrow\(\) \{([\s\S]*?)\n\}/);
  ok(Boolean(block), "sidepanel.js declares autoGrow()");
  const body = block[1];

  ok(!/\b120\b/.test(body), "no hardcoded 120px cap left in autoGrow()");
  ok(/getComputedStyle\(el\.composerInput\)\.maxHeight/.test(body), "autoGrow() reads the cap from the element's computed max-height (CSS is the only source of truth)");
  ok(/Number\.isFinite/.test(body), "and falls back safely if the computed value is not a finite number");
}

console.log(fail === 0 ? "\nALL COMPOSER TEXTAREA SCROLL TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

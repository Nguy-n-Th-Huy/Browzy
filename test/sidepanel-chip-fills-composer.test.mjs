#!/usr/bin/env node
// Regression: spec `browser-assistant-panel` "Polished visual design" /
// Scenario "Suggestion chip fills the composer" — the empty-conversation
// suggestion chips installed by sidepanel.js's `wireEmptyStateSuggestions`
// must fill the composer with the chip's text and focus it, AND must NOT
// themselves send a message. Activating a chip is a drafts operation, not
// a send: the user reviews and edits before pressing Send themselves.
//
// sidepanel.js is DOM-only glue (per its own file header and the precedent
// set in test/sidepanel-readiness-states.test.mjs, which verifies the one
// DOM-only property that matters via regex over the source). This file
// follows that exact precedent: assert the click handler's observed
// behavior contract by reading its source, rather than spinning up a DOM
// (which a Node-only test environment cannot meaningfully do for this
// surface anyway — it depends on chrome.runtime, DOM events, and the
// `panel.sendMessage` call chain). The contract is narrow enough that a
// regex check is a stronger assertion than snapshotting a hypothetical
// markup tree.
//
// Run: node test/sidepanel-chip-fills-composer.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL_PATH = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const src = fs.readFileSync(SIDEPANEL_PATH, "utf-8");

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

console.log("== suggestion chip fills the composer, never sends ==");

// (1) The click handler MUST set the composer value to the chip's data-suggest.
// Pattern: el.composerInput.value = btn.getAttribute("data-suggest")
ok(
  /el\.composerInput\.value\s*=\s*btn\.getAttribute\(\s*["']data-suggest["']\s*\)/.test(src),
  "click handler writes the chip's data-suggest text into the composer"
);

// (2) The click handler MUST focus the composer.
ok(
  /el\.composerInput\.focus\(\)/.test(src),
  "click handler focuses the composer"
);

// (3) The chip's click handler MUST NOT itself send the message.
// Pick the body of `wireEmptyStateSuggestions` and assert no panel.sendMessage,
// doSend, el.btnSend.click, or protocol.start call appears inside it.
{
  const m = src.match(/function wireEmptyStateSuggestions\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  ok(!!m, "wireEmptyStateSuggestions function is present in sidepanel.js");
  if (m) {
    const body = m[1];
    ok(
      !/panel\.sendMessage\s*\(/.test(body),
      "click handler does not call panel.sendMessage"
    );
    ok(
      !/\bdoSend\s*\(/.test(body) && !/\bdoSend\.call\b/.test(body),
      "click handler does not call doSend"
    );
    ok(
      !/el\.btnSend\.click\s*\(/.test(body) && !/el\.btnSend\.dispatchEvent\s*\(/.test(body),
      "click handler does not synthesize a Send button activation"
    );
    ok(
      !/protocol\.start\s*\(/.test(body),
      "click handler does not open a START envelope itself"
    );
    // (4) Sanity check that the handler DOES update send-state and autogrow
    // (so an immediate re-click on Send is enabled the moment the composer
    // is filled, matching spec "no message is sent until the user
    // explicitly sends it" — we want the explicit-send path ready).
    ok(/updateSendEnabled\s*\(\s*\)/.test(body), "click handler re-evaluates Send-enabled after filling");
    ok(/autoGrow\s*\(\s*\)/.test(body), "click handler grows the composer to fit the new text");
  }
}

console.log(fail === 0 ? "\nALL SIDEPANEL CHIP-FILLS-COMPOSER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

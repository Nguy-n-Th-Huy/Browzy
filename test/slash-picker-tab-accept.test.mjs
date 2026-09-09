#!/usr/bin/env node
// Tab must accept the highlighted slash-picker entry the same way Enter does,
// so a user typing "/skill" can hit Tab to fill it in instead of reaching for
// Enter. Shift+Tab must keep moving focus out of the composer as normal, and
// Tab must stay a no-op whenever the picker is not visible.
//
// extension/ui/behaviors.js is a vanilla-JS custom-element module
// (`class UiSlashPicker extends HTMLElement`, `customElements.define(...)`)
// that only works in a DOM, so — same constraint as
// test/composer-textarea-scroll.test.mjs and test/composer-add-and-effort.test.mjs —
// this holds source-level assertions against the shipped source instead of
// importing and driving the element directly.
//
// Run: node test/slash-picker-tab-accept.test.mjs

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

const src = read("extension/ui/behaviors.js");

console.log("\n== UiSlashPicker.attachToInput: Tab accepts the highlighted entry ==");
{
  const method = src.match(/attachToInput\(inputEl\) \{([\s\S]*?)\n  \}/);
  ok(Boolean(method), "behaviors.js declares attachToInput(inputEl)");
  const body = method[1];

  ok(/if \(!this\.isVisible\(\)\) return;/.test(body), "the handler still bails out immediately when the picker is not visible, so Tab is untouched outside the picker");

  // Enter and Tab (without Shift) must reach the exact same branch/code path
  // rather than duplicated branches, per DRY.
  const acceptBranch = body.match(/\} else if \((e\.key === "Enter".*?)\) \{([\s\S]*?)\} else if \(e\.key === "Escape"\)/);
  ok(Boolean(acceptBranch), "Enter and Tab share one single 'else if' branch (no duplicated selection logic)");

  const condition = acceptBranch[1];
  ok(/e\.key === "Enter"/.test(condition), "the shared condition still matches Enter");
  ok(/e\.key === "Tab"/.test(condition), "the shared condition also matches Tab");
  ok(/!e\.shiftKey/.test(condition), "Tab is only accepted when Shift is not held (Shift+Tab is excluded from this branch)");

  const branchBody = acceptBranch[2];
  ok(/if \(!this\.current\(\)\) return;/.test(branchBody), "falls through (no preventDefault) when nothing is highlighted, exactly like the old Enter-only behavior");
  ok(/e\.preventDefault\(\);/.test(branchBody), "preventDefault() is called so Tab does not also move focus once it is treated as an accept key");
  ok(
    /dispatchEvent\(new CustomEvent\("ui-slash-select", \{ detail: this\.current\(\) \}\)\);/.test(branchBody),
    "dispatches the same ui-slash-select CustomEvent with detail: this.current() that Enter always dispatched"
  );

  ok(!/e\.key === "Tab"[\s\S]{0,120}e\.shiftKey[\s\S]{0,40}this\.move\(/.test(body), "Shift+Tab is not wired to move()/selection at all — it is left for the browser's normal focus-move behavior");
}

console.log(fail === 0 ? "\nALL SLASH PICKER TAB ACCEPT TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

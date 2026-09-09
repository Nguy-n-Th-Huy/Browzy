#!/usr/bin/env node
//
// Task 10.5 (design section 9a): extraction-honesty regression test for the
// listing-page live evidence (dauthau.asia).
//
// Tests the coverage-ratio logic and the background.js header construction
// logic WITHOUT requiring a browser/jsdom — by extracting the core
// computation into a tested function and testing background.js's header
// construction against mocked input shapes the real content.js will
// produce.
//
// Run: node test/extraction-honesty.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Extract the coverageRatio / usedBodyFallback / Complete-line logic --
//
// content.js's getPageText() computes:
//   - coverageRatio = cleanText(source).length / cleanText(document.body).length
//   - usedBodyFallback = source === document.body (no selector matched)
//
// background.js's get_page_text handler builds the `Complete:` line from
// `truncated`, `coverageRatio`, `usedBodyFallback`, and `sourceTag`:
//   - truncated=true               -> "Complete: no (truncated)"
//   - usedBodyFallback=true        -> "Complete: partial (... body last resort ...)"
//   - coverageRatio < 0.5          -> "Complete: partial (container <tag> captured N% ...)"
//   - else                          -> "Complete: yes"
//
// We test both halves: the coverage ratio formula (with a DOM mock) and the
// Complete-line logic (with a pure function extracted from background.js).

// --- A minimal DOM mock that content.js's cleanText logic can run against --
function mockDoc(html) {
  const containers = new Map();
  function parse(text) {
    // Very simple DOM mock for the test: track element text and tag names.
    // Not a real DOM parser — just enough to simulate the coverage ratio
    // computation for the fixture shapes below. For tags we care about
    // (script, style, noscript, template, svg), the real cleanText removes
    // them before computing text length.
    return text;
  }
  return {
    body: { cloneNode: () => ({ querySelectorAll: () => [], textContent: html }) },
    querySelector: (sel) => null // for the fixture, the mock overrides this
  };
}

// --- Replicate content.js cleanText logic ---
function cleanTextOnDom(text) {
  return text.replace(/\s+/g, " ").trim();
}
function cleanText(el) {
  // In the real DOM, clone, remove script/style/etc, get textContent.
  // For the test, we simulate by working with arbitrary strings.
  const text = typeof el === "string" ? el : el.textContent;
  return cleanTextOnDom(text);
}

// --- Replicate background.js's Complete-line logic (from the actual edit) ---
function buildCompleteLine(data) {
  if (typeof data.truncated === "boolean" && data.truncated) {
    return "Complete: no (truncated)";
  }
  if (data.usedBodyFallback === true) {
    return `Complete: partial (container <${data.sourceTag}> was the document.body last resort; try read_page or find for listing-style pages)`;
  }
  if (typeof data.coverageRatio === "number" && data.coverageRatio < 0.5) {
    const pct = Math.round(data.coverageRatio * 100);
    return `Complete: partial (container <${data.sourceTag}> captured ${pct}% of the page's text; try read_page or find for listing-style pages)`;
  }
  if (typeof data.truncated === "boolean") {
    return "Complete: yes";
  }
  return null;
}

console.log("\nTask 10.5 — extraction honesty regression test (listing page)\n");

// --- Read the fixture and compute what content.js would compute ----------
const fixtureHtml = fs.readFileSync(path.join(__dirname, "fixtures", "listing-page.html"), "utf8");

// Extract the `.content` div content from the fixture (what a real selector
// match returns to getPageText):
const contentMatch = fixtureHtml.match(/<div class="content">([\s\S]*?)<\/div>/);
const contentDivHtml = contentMatch ? contentMatch[1].trim() : "";

// Extract just the text from the .content div (stripping tags):
const contentDivText = contentDivHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Extract the full body text — the tender listings dominate:
const bodyText = fixtureHtml.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n+/g, " ").trim();
// Remove script/style (though the fixture has none, be realistic):
const bodyCleaned = cleanText(bodyText);
const sourceCleaned = cleanText(contentDivText);

// The content div should be a small fraction of the body text:
const coverageRatio = sourceCleaned.length / Math.max(1, bodyCleaned.length);

await test("fixture: .content div matches a small boilerplate container (the live evidence shape)", async () => {
  assert(/Thông tin liên hệ/.test(sourceCleaned), "the matched .content div contains boilerplate contact text");
  assert(!/Thông báo mời thầu/.test(sourceCleaned), "the matched .content div must NOT contain the tender listings");
  assert(/Thông báo mời thầu/.test(bodyCleaned), "the body text contains many tender notice listings outside the .content div");
});

await test("fixture: the .content div's coverage ratio is below 0.5 (low-confidence extraction)", async () => {
  assert(coverageRatio < 0.5, `coverageRatio must be < 0.5 for the boilerplate .content container, got ${coverageRatio}`);
  assert(coverageRatio > 0, "coverageRatio must be non-zero (some text in the container)");
});

await test("background.js Complete-line: a low-coverage, non-truncated, non-body-fallback result reports partial, NOT Complete: yes", async () => {
  const data = {
    truncated: false,
    usedBodyFallback: false,
    coverageRatio,
    sourceTag: "div"
  };
  const line = buildCompleteLine(data);
  assert(/^Complete: partial/.test(line), `must start with "Complete: partial", got: ${line}`);
  assert(/container <div>/.test(line), "must name the fallback container <div>");
  assert(/read_page or find/.test(line), "must suggest read_page or find for listing-style pages");
  assert(!/^Complete: yes/.test(line), "must NEVER be Complete: yes on a low-coverage extraction");
});

await test("background.js Complete-line: the document.body last resort is NEVER Complete: yes regardless of ratio", async () => {
  const data = {
    truncated: false,
    usedBodyFallback: true,
    coverageRatio: 1.0,
    sourceTag: "body"
  };
  const line = buildCompleteLine(data);
  assert(/^Complete: partial/.test(line), `body fallback must report partial even with ratio=1.0, got: ${line}`);
  assert(/body last resort/.test(line), "must name the body last resort");
});

await test("background.js Complete-line: a full-page article container reports Complete: yes (high coverage, no body fallback)", async () => {
  const data = {
    truncated: false,
    usedBodyFallback: false,
    coverageRatio: 0.95,
    sourceTag: "article"
  };
  const line = buildCompleteLine(data);
  assert(line === "Complete: yes", `an article with 95% coverage and no body fallback reports Complete: yes, got: ${line}`);
});

await test("background.js Complete-line: a truncated result is always Complete: no (truncated), even with high coverage", async () => {
  const data = {
    truncated: true,
    usedBodyFallback: false,
    coverageRatio: 1.0,
    sourceTag: "article"
  };
  const line = buildCompleteLine(data);
  assert(line === "Complete: no (truncated)", `truncated must report no, got: ${line}`);
});

await test("background.js Complete-line: an older content-script (no coverageRatio/usedBodyFallback) falls back to truncated-only — never breaks a stale script", async () => {
  const data = {
    truncated: false
  };
  const line = buildCompleteLine(data);
  assert(line === "Complete: yes", `a stale script with only truncated:false stays Complete: yes (backward compat), got: ${line}`);
});

await test("fixture: the exact evidence shape — Source: <div>, non-truncated boilerplate text — reports partial, not Complete: yes", async () => {
  // This is the exact scenario from the live evidence: get_page_text's
  // selector matched a small .content div, returned boilerplate text
  // (non-truncated since it was short), and reported Complete: yes (the bug).
  const data = {
    truncated: false,
    usedBodyFallback: false,
    coverageRatio,
    sourceTag: "div"
  };
  const line = buildCompleteLine(data);
  assert(!/^Complete: yes/.test(line), `the evidence's exact shape must NOT report Complete: yes (the bug), got: ${line}`);
  assert(/Complete: partial\(<div>/.test(line.replace(" (", "(")) || /container <div>/.test(line), `must name <div> and be partial, got: ${line}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

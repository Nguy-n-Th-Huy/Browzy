#!/usr/bin/env node
// New-element marking (openspec/changes/mark-new-page-elements) — exercised
// against the REAL, SHIPPED extension/content.js, loaded whole via `new
// Function("window","document",...)` and driven through the exact surface the
// background page uses (window.__unblockedChrome.generateAccessibilityTree,
// .findElements, .resolveRef). Never a copy of the logic: if content.js's
// marker or watermark behavior drifts, this suite fails.
//
// Covers tasks 5.1/5.2:
//   5.1 (a) elements above the watermark are marked, elements below are not;
//       (b) a second read with no change marks nothing;
//       (c) the first read of a document marks nothing;
//       (d) clearing the watermark (per-document reset) makes the next read
//           mark nothing — driven through the SHIPPED reset owner
//           (bumpDocumentEpoch, reached via the wrapped history.pushState /
//           popstate path), never by re-declaring readWatermark.
//       The `find` path's `isNew` field is held to the same watermark, since
//       it is the other half of "a page read".
//   5.2 the "*" marker never appears inside the ref string: a marked line is
//       `... *[ref_N]`, the ref token is exactly `ref_N`, and the same
//       element's ref is byte-identical whether its line was marked or not
//       and still resolves through the shipped resolveRef.
//
// The fake DOM is deliberately as small as the walk needs (this repo has no
// jsdom/puppeteer dependency; test/webmcp-detect-main.test.mjs and
// test/element-picker-pure.test.mjs establish the hand-rolled-fake
// convention). isVisible() is kept cheaply true via a truthy offsetParent and
// a getComputedStyle stub that never reports display:none/visibility:hidden.
//
// Run: node test/new-element-marking.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// =============================================================================
// Minimal hand-rolled FakeElement — exactly the surface
// generateAccessibilityTree()/findElements() touch.
// =============================================================================
function makeEl(tagName, opts = {}) {
  const el = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentNode: null,
    shadowRoot: null,
    // A truthy offsetParent is what makes isVisible() short-circuit to "now
    // check computed style" without needing layout.
    offsetParent: {},
    _attrs: Object.assign({}, opts.attrs || {}),
    _text: opts.text == null ? "" : String(opts.text),
    id: opts.id || "",
    href: opts.href || "",
    src: opts.src || "",
    value: opts.value == null ? "" : opts.value,
    type: opts.type || "",
    disabled: !!opts.disabled,
    tabIndex: opts.tabIndex == null ? -1 : opts.tabIndex,
    onclick: opts.onclick || null,
    contentEditable: opts.contentEditable || "false",
    placeholder: opts.placeholder == null ? "" : opts.placeholder,
    title: opts.title == null ? "" : opts.title,
    alt: opts.alt == null ? "" : opts.alt,
    className: opts.className || "",
    options: [],
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
    },
    set textContent(v) {
      this.children = [];
      this._text = v == null ? "" : String(v);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    setAttribute(name, v) { this._attrs[name] = String(v); },
    removeAttribute(name) { delete this._attrs[name]; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    // The walk's find path calls these directly (not in a try/catch) for its
    // overlay/aria-hidden exclusions — a plain null is honest ("nothing
    // matches") for this fake.
    closest() { return null; },
    // A control's field-label lookup (fieldLabelText) is only reached through
    // this; none of the fixtures are form controls, so false is accurate and
    // keeps that branch out of the harness without hiding the marker logic.
    matches() { return false; },
    contains(other) {
      for (let n = other; n; n = n.parentNode) if (n === this) return true;
      return false;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
    },
    scrollIntoView() {},
    dispatchEvent() { return true; },
    focus() {},
  };
  return el;
}

/** All descendants of `root` (not root itself) — the shape findElements'
 * collectAll(document) consumes. Excluding body keeps the harness free of a
 * spurious whole-page-text candidate, which is not what these fixtures are
 * about. */
function descendants(root) {
  const out = [];
  const queue = root.children.slice();
  while (queue.length) {
    const el = queue.shift();
    out.push(el);
    for (const c of el.children) queue.push(c);
  }
  return out;
}

// =============================================================================
// Boot the shipped content.js IIFE against a minimal fake browser.
// =============================================================================
function createHarness() {
  const body = makeEl("body");
  const location = { href: "https://app.example/page" };
  const listeners = { popstate: [], hashchange: [] };
  const onMessage = {
    listeners: [],
    addListener(fn) { this.listeners.push(fn); },
    removeListener(fn) {
      const i = this.listeners.indexOf(fn);
      if (i !== -1) this.listeners.splice(i, 1);
    }
  };
  const window_ = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
  };
  const document_ = {
    body,
    documentElement: makeEl("html"),
    title: "Harness",
    readyState: "complete",
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll(sel) { return sel === "*" ? descendants(body) : []; },
    elementFromPoint() { return null; },
    addEventListener() {}
  };
  // Mirrors the real History API: a call that supplies a url changes
  // location.href. installSpaTracking() wraps these; our fakes are the
  // originals it wraps.
  const history = {
    pushState(state, title, url) { if (url) location.href = String(url); },
    replaceState(state, title, url) { if (url) location.href = String(url); }
  };
  const chrome = { runtime: { onMessage } };
  const crypto = { randomUUID: () => "harness-nonce" };
  const getComputedStyle = () => ({ position: "static", display: "block", visibility: "visible" });
  const CSS = { escape: (s) => String(s) };

  // `location`, `history`, `crypto`, `getComputedStyle`, `CSS` and `Event` are
  // passed as parameters so they shadow Node's own globals (or the absence of
  // them) inside the compiled IIFE.
  const run = new Function(
    "window", "document", "location", "history", "chrome", "crypto",
    "getComputedStyle", "CSS", "Event",
    SRC
  );
  run(window_, document_, location, history, chrome, crypto, getComputedStyle, CSS, Event);

  return {
    api: window_.__unblockedChrome,
    body,
    location,
    history,
    listeners,
    addEl(el) { body.appendChild(el); return el; }
  };
}

const lineFor = (tree, name) => tree.split("\n").find((l) => l.includes(`"${name}"`)) || "";
const refOf = (line) => {
  const m = line.match(/ref_\d+/);
  return m ? m[0] : null;
};
const MARKER_RE = /\*\[ref_\d+\]/;
const ANY_MARKER_RE = /\*\[ref_/;

// Sanity: we really compiled the shipped file, not an empty string.
ok(SRC.includes("readWatermark") && SRC.includes("window.__unblockedChrome ="),
  "sanity: the loaded source is the shipped content.js (watermark + global exposure present)");

// =============================================================================
// 5.1 (c) The first read of a document marks nothing.
// =============================================================================
console.log("\n== 5.1(c) first read of a document marks nothing ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));

  const tree = h.api.generateAccessibilityTree();
  ok(!ANY_MARKER_RE.test(tree),
    "the first read marks nothing — there is no previous read to be new relative to");
  ok(/\[ref_\d+\]/.test(tree), "sanity: refs are still rendered (unmarked) on the first read");
  ok(/\bbutton "Alpha" \[ref_\d+\]/.test(tree) && /\bbutton "Beta" \[ref_\d+\]/.test(tree),
    "both pre-existing elements are present and unmarked");
}

// =============================================================================
// 5.1 (a) elements above the watermark are marked, elements below are not.
// 5.1 (b) a second read with no change marks nothing.
// =============================================================================
console.log("\n== 5.1(a)/(b) only elements first seen after the previous read are marked ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));

  const t1 = h.api.generateAccessibilityTree(); // watermark is recorded here
  ok(!ANY_MARKER_RE.test(t1), "baseline read (setup) marks nothing");

  const alphaRefAtFirstRead = refOf(lineFor(t1, "Alpha"));
  const markedEl = h.addEl(makeEl("button", { text: "Gamma" }));

  const t2 = h.api.generateAccessibilityTree();
  const alphaLine = lineFor(t2, "Alpha");
  const betaLine = lineFor(t2, "Beta");
  const gammaLine = lineFor(t2, "Gamma");

  ok(!MARKER_RE.test(alphaLine) && !MARKER_RE.test(betaLine),
    "elements already present at the previous read (below the watermark) are NOT marked");
  ok(MARKER_RE.test(gammaLine),
    "an element that appeared since the previous read (above the watermark) IS marked");
  ok(t2.split("\n").filter((l) => MARKER_RE.test(l)).length === 1,
    "exactly the one newly-appeared element is marked");

  const markedRef = refOf(gammaLine);
  ok(!!markedRef, `the marked element still carries a normal ref token (got: ${markedRef})`);
  ok(refOf(alphaLine) === alphaRefAtFirstRead,
    "an unmarked element keeps the same ref it already had");
  ok(h.api.resolveRef(markedRef) === markedEl,
    "the marked ref resolves to the newly-appeared element");

  // 5.1(b): nothing appeared between this read and the next.
  const t3 = h.api.generateAccessibilityTree();
  ok(!ANY_MARKER_RE.test(t3), "a second read with nothing appearing in between marks nothing");
  ok(lineFor(t3, "Gamma").includes(`[${markedRef}]`),
    "the once-new element is now ordinary — it keeps its ref but loses the marker");
  const unmarkedSameRef = refOf(lineFor(t3, "Gamma"));
  ok(unmarkedSameRef === markedRef,
    `the once-marked element's ref is byte-identical when rendered unmarked (${markedRef} vs ${unmarkedSameRef})`);
}

// =============================================================================
// 5.2 The marker is never part of the ref; a marked ref is byte-identical to
// the same element read unmarked and still resolves.
// =============================================================================
console.log("\n== 5.2 the marker lives on the line, never inside the ref ==");
{
  const h = createHarness(); // same-shape fixture, fresh watermark for a clean marked line
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.api.generateAccessibilityTree();
  const gamma = h.addEl(makeEl("button", { text: "Gamma" }));
  const tree = h.api.generateAccessibilityTree();
  const gammaLine = lineFor(tree, "Gamma");

  ok(MARKER_RE.test(gammaLine), `sanity: the target line is marked (got: ${gammaLine.trim()})`);

  const refToken = refOf(gammaLine);
  ok(refToken !== null, "a ref token can be parsed off the marked line");
  ok(!refToken.includes("*"),
    `the '*' marker is not part of the ref token (got: ${refToken})`);
  ok(!/\*ref_\d+/.test(gammaLine),
    "the '*' is never glued to the ref — it sits outside the bracket, as *[ref_N]");
  ok(new RegExp(`\\*\\[${refToken}\\]`).test(gammaLine),
    "the marked form is exactly *[ref_N], with the ref unchanged by the marker");

  // Byte-identity: run the same element's ref through the shipped resolver on
  // both the marked rendering and an unmarked one. resolveRef is what every
  // consumer (computer/form_input) uses to turn a ref back into an element.
  const resolvedFromMarked = h.api.resolveRef(refToken);
  ok(resolvedFromMarked === gamma,
    "the marked ref resolves to the very element the marker described");

  const unmarkedLine = lineFor(h.api.generateAccessibilityTree(), "Gamma");
  ok(!MARKER_RE.test(unmarkedLine), "the follow-up read renders the same element unmarked");
  const unmarkedRef = refOf(unmarkedLine);
  ok(unmarkedRef === refToken,
    `the element's ref is byte-identical whether its line was marked or not (${refToken} vs ${unmarkedRef})`);
  ok(h.api.resolveRef(unmarkedRef) === gamma,
    "the unmarked rendering of that ref resolves to the same element");
}

// =============================================================================
// 5.1 The find path shares the same per-document watermark: isNew mirrors the
// tree marker.
// =============================================================================
console.log("\n== 5.1 find() isNew mirrors the tree marker (shared watermark) ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));

  const r1 = h.api.findElements("alpha");
  ok(r1.results.length === 1 && r1.results[0].isNew === false,
    "find: the first read marks nothing (isNew false)");

  h.addEl(makeEl("button", { text: "Gamma" }));
  const r2 = h.api.findElements("gamma");
  ok(r2.results.length === 1 && r2.results[0].isNew === true,
    "find: an element that appeared since the previous read is isNew");

  const r3 = h.api.findElements("gamma");
  ok(r3.results.length === 1 && r3.results[0].isNew === false,
    "find: a second read with nothing appearing in between marks nothing");

  // A find must not make previously-seen elements look new just because it
  // advanced the counter for its own results.
  const r4 = h.api.findElements("alpha");
  ok(r4.results.length === 1 && r4.results[0].isNew === false,
    "find: an element seen on an earlier read stays unmarked on a later find");
}

// =============================================================================
// 5.1 (d) A document-identity change clears the watermark, so the next read
// marks nothing. Driven through the SHIPPED reset owner: installSpaTracking
// wraps history.pushState, and a real URL change there calls
// bumpDocumentEpoch(), which clears readWatermark.
// =============================================================================
console.log("\n== 5.1(d) document identity change clears the watermark (shipped reset path) ==");
// A fresh document, read once (so a watermark exists), then a new element
// added but deliberately NOT read yet — the state in which that element would
// be marked on the very next read. Splitting the control and the reset into
// SEPARATE harnesses matters: reading Gamma to "confirm" it would be marked
// also advances the watermark past it, which would make a later "marks
// nothing" assertion pass even if the reset never fired.
function harnessWithUnreadNewElement() {
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));
  h.api.generateAccessibilityTree(); // records the watermark
  h.addEl(makeEl("button", { text: "Gamma" }));
  return h;
}

{
  // Control: with NO document change, the unread new element is marked —
  // proving the fixture is live and the assertion below is discriminating.
  const control = harnessWithUnreadNewElement();
  const tree = control.api.generateAccessibilityTree();
  ok(MARKER_RE.test(lineFor(tree, "Gamma")),
    "control: without a document change, the unread new element IS marked");
}

{
  // Route change through the wrapped History API — the shipped owner of
  // document identity, not a direct poke at readWatermark.
  const h = harnessWithUnreadNewElement();
  h.history.pushState(null, "", "https://app.example/other");
  ok(h.location.href === "https://app.example/other",
    "sanity: the wrapped pushState still performs the navigation");

  const after = h.api.generateAccessibilityTree();
  ok(!ANY_MARKER_RE.test(after),
    "after a document identity change the first read marks nothing — every element is new, so marking all says nothing");
  ok(after.includes('"Gamma"'), "sanity: Gamma is still present in the post-navigation read");
}

{
  // The same reset reached through the popstate event installSpaTracking
  // listens for (back/forward navigation in an SPA).
  const h = harnessWithUnreadNewElement();
  h.location.href = "https://app.example/back"; // browser has already navigated
  for (const fn of h.listeners.popstate) fn();

  const after = h.api.generateAccessibilityTree();
  ok(!ANY_MARKER_RE.test(after),
    "a popstate-driven document change resets the watermark just like pushState");
}

console.log(fail === 0 ? "\nALL NEW-ELEMENT-MARKING TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

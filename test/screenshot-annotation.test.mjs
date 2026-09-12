#!/usr/bin/env node
//
// Screenshot annotation (openspec/changes/annotate-screenshot-elements),
// exercised against the REAL, SHIPPED extension/content.js, loaded whole via
// `new Function("window","document",...)` and driven through the exact surface
// the background page uses (window.__unblockedChrome.annotateElements,
// .clearAnnotation, .generateAccessibilityTree, .findElements, .resolveRef).
// Never a copy of the logic: if content.js's draw/teardown/exclusion behavior
// drifts, this suite fails.
//
// Covers tasks 4.1-4.3:
//   4.1 the draw routine labels an element with the same ref getOrAssignRef()
//       returns for it; the container is excluded from the serialized tree and
//       the find path; teardown removes everything; teardown is safe when
//       nothing was drawn; annotating does not advance the ref counter for the
//       container's own nodes.
//   4.2 no page element's inline style is modified by a draw/teardown cycle.
//   4.3 label sizing accounts for the capture scale, so a reduced-scale capture
//       does not produce labels below the legibility floor.
//
// The fake DOM is deliberately as small as the walk/draw needs (this repo has
// no jsdom/puppeteer dependency; test/new-element-marking.test.mjs and
// test/element-picker-pure.test.mjs establish the hand-rolled-fake convention).
//
// Run: node test/screenshot-annotation.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// The container id and legibility floor are read from the shipped source, not
// re-typed here, so a rename or a changed floor shows up as a failing test
// rather than a test that silently asserts nothing.
const CONTAINER_ID = (SRC.match(/ANNOTATION_CONTAINER_ID\s*=\s*"([^"]+)"/) || [])[1];
const LABEL_FLOOR_PX = Number((SRC.match(/ANNOTATION_LABEL_FLOOR_PX\s*=\s*(\d+)/) || [])[1]);

// =============================================================================
// Minimal hand-rolled FakeElement — exactly the surface content.js touches.
// =============================================================================
function makeEl(tagName, opts = {}) {
  const el = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentNode: null,
    parentElement: null,
    shadowRoot: null,
    // A truthy offsetParent is what makes isVisible() short-circuit to "now
    // check computed style" without needing layout.
    offsetParent: {},
    style: {},
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
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },
    // The find path's overlay/aria-hidden exclusions and the accessible-name
    // label lookup are the only closest() calls; none of the fixtures are
    // those, so null is honest.
    closest() { return null; },
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

/** All descendants of `root` (not root itself) — the shape collectAll(document)
 * consumes via document.querySelectorAll("*"). */
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

function byId(root, id) {
  if (root.id === id) return root;
  for (const c of root.children || []) {
    const found = byId(c, id);
    if (found) return found;
  }
  return null;
}

// =============================================================================
// Boot the shipped content.js IIFE against a minimal fake browser.
// =============================================================================
function createHarness() {
  const body = makeEl("body");
  const documentElement = makeEl("html");
  // body is a real descendant of <html> so document.querySelectorAll("*")
  // reaches both the page's own subtree and the annotation container — exactly
  // the shape the exclusion logic has to cope with.
  documentElement.appendChild(body);

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
    documentElement,
    title: "Harness",
    readyState: "complete",
    createElement(tag) { return makeEl(tag); },
    getElementById(id) { return byId(documentElement, id); },
    querySelector() { return null; },
    querySelectorAll(sel) { return sel === "*" ? descendants(documentElement) : []; },
    elementFromPoint() { return null; },
    addEventListener() {}
  };
  const history = {
    pushState(state, title, url) { if (url) location.href = String(url); },
    replaceState(state, title, url) { if (url) location.href = String(url); }
  };
  const chrome = { runtime: { onMessage } };
  const crypto = { randomUUID: () => "harness-nonce" };
  const getComputedStyle = () => ({ position: "static", display: "block", visibility: "visible" });
  const CSS = { escape: (s) => String(s) };
  const Event = class { constructor(type) { this.type = type; } };

  const run = new Function(
    "window", "document", "location", "history", "chrome", "crypto",
    "getComputedStyle", "CSS", "Event",
    SRC
  );
  run(window_, document_, location, history, chrome, crypto, getComputedStyle, CSS, Event);

  return {
    api: window_.__unblockedChrome,
    document: document_,
    documentElement,
    body,
    addEl(el) { body.appendChild(el); return el; },
    container() { return byId(documentElement, CONTAINER_ID); }
  };
}

function labelsIn(container) {
  if (!container) return [];
  return container.children.filter(
    (c) => typeof c.className === "string" && c.className.includes("browzy-annotation-label")
  );
}
function parsePx(value) {
  const m = /(\d+(?:\.\d+)?)px/.exec(String(value || ""));
  return m ? Number(m[1]) : NaN;
}
const lineFor = (tree, name) => tree.split("\n").find((l) => l.includes(`"${name}"`)) || "";
const refOf = (line) => {
  const m = line.match(/ref_\d+/);
  return m ? m[0] : null;
};

// Sanity: we really compiled the shipped file, and the constants this suite
// depends on are really there.
ok(typeof CONTAINER_ID === "string" && CONTAINER_ID.length > 0,
  `sanity: shipped content.js declares a fixed annotation container id (${CONTAINER_ID})`);
ok(Number.isFinite(LABEL_FLOOR_PX) && LABEL_FLOOR_PX > 0,
  `sanity: shipped content.js declares a label legibility floor (${LABEL_FLOOR_PX}px)`);
ok(SRC.includes("window.__unblockedChrome =") && SRC.includes("annotateElements: drawAnnotation"),
  "sanity: the loaded source exposes the annotation surface");

// =============================================================================
// 4.1 The label is the element's existing ref, not a new identifier.
// =============================================================================
console.log("\n== 4.1 the label is the same ref getOrAssignRef returns ==");
{
  const h = createHarness();
  const alpha = h.addEl(makeEl("button", { text: "Alpha" }));
  const beta = h.addEl(makeEl("button", { text: "Beta" }));

  // A page read first, so the elements already hold refs — an annotated
  // capture is supposed to reuse them, not mint new ones.
  const tree = h.api.generateAccessibilityTree();
  const alphaRef = refOf(lineFor(tree, "Alpha"));
  const betaRef = refOf(lineFor(tree, "Beta"));
  ok(!!alphaRef && !!betaRef, `sanity: the baseline read assigned refs (${alphaRef}, ${betaRef})`);

  const result = h.api.annotateElements({ scale: 1 });
  ok(result && result.drawn === 2, `draw reported both interactive elements (drawn=${result && result.drawn})`);

  const container = h.container();
  ok(!!container && container.id === CONTAINER_ID, "the draw created the fixed-id container");
  ok(container.style.pointerEvents === "none", "the container is pointer-events: none");
  ok(String(container.style.zIndex) === "2147483647", "the container is pinned at max z-index");

  const labels = labelsIn(container);
  const shown = labels.map((l) => l.textContent).sort();
  ok(shown.join(",") === [alphaRef, betaRef].sort().join(","),
    `the labels are exactly the elements' existing refs (shown: ${shown.join(", ")})`);

  // A label resolves through the shipped resolver to the real page element,
  // never to a drawn node.
  const alphaLabel = labels.find((l) => l.textContent === alphaRef);
  ok(alphaLabel && h.api.resolveRef(alphaRef) === alpha,
    "the label's ref resolves to the page element it names, through the shipped resolveRef");

  // Outlines and labels are overlay nodes, not the page element.
  ok(alpha.style && Object.keys(alpha.style).length === 0,
    "drawing did not style the page element itself (positioned overlay only)");
}

// =============================================================================
// 4.1 The container is excluded from the serialized tree and the find path.
// =============================================================================
console.log("\n== 4.1 annotation never becomes page content ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));

  const before = h.api.generateAccessibilityTree();
  h.api.annotateElements({ scale: 1 });
  const after = h.api.generateAccessibilityTree();

  ok(after === before,
    "a read_page straight after an annotated capture is byte-identical — no trace of the annotation");
  ok(!/browzy-annotation/.test(after), "the serialized tree carries no annotation wording");

  // The label's own text ("ref_N") is the strongest thing find() could match
  // on. With the container excluded it must return nothing; without the
  // exclusion the drawn label would be reported as a findable element.
  const labelText = labelsIn(h.container())[0].textContent;
  const found = h.api.findElements("ref");
  ok(found.results.length === 0,
    `find("ref") found no annotation node (query matched the drawn label text "${labelText}" — ${found.results.length} result(s))`);

  const container = h.container();
  const leaked = found.results.filter((r) => {
    const el = h.api.resolveRef(r.ref);
    return el && container.contains(el);
  });
  ok(leaked.length === 0, "no find result resolves to a node inside the annotation container");
}

// =============================================================================
// 4.1 Teardown removes everything, and is safe when nothing was drawn.
// =============================================================================
console.log("\n== 4.1 teardown is complete and safe ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));

  // Safe with nothing drawn.
  let threw = false;
  let cleared;
  try {
    cleared = h.api.clearAnnotation();
  } catch (e) {
    threw = true;
  }
  ok(!threw && cleared && cleared.cleared === false,
    "teardown with nothing drawn does not throw and reports nothing cleared");

  h.api.annotateElements({ scale: 1 });
  const container = h.container();
  ok(!!container, "sanity: the container exists before teardown");
  ok(container.children.length > 0, "sanity: the container holds drawn nodes before teardown");

  const result = h.api.clearAnnotation();
  ok(result && result.cleared === true, "teardown reports it removed the container");
  ok(h.container() === null, "the container is gone from the document after teardown");
  const anyAnnotation = h.document
    .querySelectorAll("*")
    .some((el) => el.id === CONTAINER_ID);
  ok(!anyAnnotation, "no annotation node remains anywhere in the document");
}

// =============================================================================
// 4.1 Annotating must not assign refs to the container's own nodes.
// =============================================================================
console.log("\n== 4.1 the container's own nodes never receive refs ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));
  h.api.generateAccessibilityTree(); // refs assigned to the page elements

  const beforeCount = Object.keys(h.api.elementMap).length;
  h.api.annotateElements({ scale: 1 });
  const afterCount = Object.keys(h.api.elementMap).length;

  ok(afterCount === beforeCount,
    `annotating did not advance the ref map (${beforeCount} -> ${afterCount} entries)`);

  const container = h.container();
  const inside = Object.keys(h.api.elementMap).filter((ref) => {
    const el = h.api.resolveRef(ref);
    return el && container.contains(el);
  });
  ok(inside.length === 0,
    `no ref in the whole map resolves to a node inside the container (found ${inside.length})`);
}

// =============================================================================
// 4.2 No page element's inline style is modified by draw/teardown.
// =============================================================================
console.log("\n== 4.2 draw/teardown does not mutate page elements ==");
{
  const h = createHarness();
  const alpha = h.addEl(makeEl("button", { text: "Alpha" }));
  const field = h.addEl(makeEl("input", { placeholder: "Name" }));
  const pageEls = [alpha, field];

  const styleBefore = pageEls.map((el) => JSON.stringify(el.style));
  const attrsBefore = pageEls.map((el) => JSON.stringify(el._attrs));

  h.api.annotateElements({ scale: 0.5 });
  h.api.clearAnnotation();

  const styleAfter = pageEls.map((el) => JSON.stringify(el.style));
  const attrsAfter = pageEls.map((el) => JSON.stringify(el._attrs));

  ok(styleBefore.join("|") === styleAfter.join("|"),
    "no page element's inline style changed across a draw/teardown cycle");
  ok(attrsBefore.join("|") === attrsAfter.join("|"),
    "no page element's attributes changed across a draw/teardown cycle");
  ok(pageEls.every((el) => !el.getAttribute("data-browzy-annotation")),
    "no page element was marked as annotation content");
}

// =============================================================================
// 4.3 Label sizing accounts for the capture scale.
// =============================================================================
console.log("\n== 4.3 labels stay legible when the capture is scaled ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));

  h.api.annotateElements({ scale: 1 });
  const full = parsePx(labelsIn(h.container())[0].style.fontSize);
  h.api.clearAnnotation();

  h.api.annotateElements({ scale: 0.5 });
  const half = parsePx(labelsIn(h.container())[0].style.fontSize);
  h.api.clearAnnotation();

  h.api.annotateElements({ scale: 0.1 });
  const tenth = parsePx(labelsIn(h.container())[0].style.fontSize);
  h.api.clearAnnotation();

  ok(Number.isFinite(full) && full >= LABEL_FLOOR_PX,
    `a 1:1 capture renders an at-least-floor label (${full}px >= ${LABEL_FLOOR_PX}px)`);
  ok(half > full,
    `a 0.5x capture enlarges the on-page label to compensate (${full}px -> ${half}px)`);
  ok(half * 0.5 >= LABEL_FLOOR_PX,
    `after the 0.5x downscale the label is still at/above the floor (${half * 0.5}px >= ${LABEL_FLOOR_PX}px)`);
  ok(tenth * 0.1 >= LABEL_FLOOR_PX,
    `at the 0.1x floor of the clamped scale the label is still readable (${tenth * 0.1}px >= ${LABEL_FLOOR_PX}px)`);
}

// =============================================================================
// 4.1 Two annotated captures in a row: the previous one is gone first.
// =============================================================================
console.log("\n== 4.1 a second annotated capture does not stack on the first ==");
{
  const h = createHarness();
  h.addEl(makeEl("button", { text: "Alpha" }));
  h.addEl(makeEl("button", { text: "Beta" }));

  h.api.annotateElements({ scale: 1 });
  const first = h.container();
  const firstLabelCount = labelsIn(first).length;

  h.api.annotateElements({ scale: 1 });
  const second = h.container();
  ok(second && second !== first, "the second draw replaces the container rather than nesting it");
  ok(h.document.querySelectorAll("*").filter((el) => el.id === CONTAINER_ID).length === 1,
    "exactly one annotation container exists after two annotated captures");
  ok(labelsIn(second).length === firstLabelCount,
    "the second draw labels only the page's elements, not the first draw's nodes");
}

console.log(fail === 0 ? "\nALL SCREENSHOT-ANNOTATION TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

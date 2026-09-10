#!/usr/bin/env node
// Lifecycle coverage for extension/overlay/element-picker.js (design mode /
// openspec/changes/add-design-mode-element-picker) — task 3.5: after teardown
// by EACH of the four exit routes (selection, Escape, a second activation,
// and background asking the tab to stop), the page's own listener set and
// node count are IDENTICAL to before activation. This is what the spec's
// "the page receives events exactly as it did before the mode began" rests
// on (design.md D2's "Teardown symmetry" risk note) — asserted here against
// the exact listener tuples, not merely a count, per tasks.md 3.5's own
// verify annotation.
//
// Against a hand-rolled fake window/document, matching this codebase's
// existing convention (test/overlay-pointer.test.mjs) — no jsdom/puppeteer
// dependency exists in this repo.
//
// Run: node test/element-picker-lifecycle.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction, compile } from "./_extract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PICKER_FILE = path.join(ROOT, "extension", "overlay", "element-picker.js");
const SRC = fs.readFileSync(PICKER_FILE, "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const extract = (name) => extractFunction(name, PICKER_FILE);

// ---- fake window: records the EXACT (type, fn, opts) tuple on add, and only
// removes a tuple whose type/fn/opts.capture/opts.passive all match — a real
// removeEventListener call with a DIFFERENT options object (e.g. missing
// `capture`) silently fails to remove a capture-phase listener, which is
// exactly the bug class task 3.5 exists to catch. ---------------------------
function makeFakeWindow() {
  const listeners = []; // {type, fn, opts}
  return {
    innerWidth: 1200,
    innerHeight: 900,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts: opts || null }); },
    removeEventListener(type, fn, opts) {
      const o = opts || null;
      const idx = listeners.findIndex(
        (l) => l.type === type && l.fn === fn &&
          !!(l.opts && l.opts.capture) === !!(o && o.capture) &&
          !!(l.opts && l.opts.passive) === !!(o && o.passive)
      );
      if (idx !== -1) listeners.splice(idx, 1);
    },
    _listeners: listeners
  };
}

// ---- fake document/element: enough to create/append/remove the highlight
// node and report documentElement's child count. ----------------------------
function makeFakeElement(tag) {
  const el = {
    tag,
    style: {},
    attrs: {},
    children: [],
    parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    }
  };
  return el;
}

function makeFakeDocument() {
  const documentElement = makeFakeElement("html");
  return {
    documentElement,
    body: makeFakeElement("body"),
    createElement: makeFakeElement
  };
}

function makeFakeChrome(sent) {
  return {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); },
      onMessage: {
        _fns: [],
        addListener(fn) { this._fns.push(fn); },
        removeListener(fn) { this._fns = this._fns.filter((f) => f !== fn); }
      }
    }
  };
}

/** Compile the whole interaction/lifecycle section against fake globals, plus
 * the pure/sanitize functions it calls internally. Returns the harness with
 * direct access to the module-level functions for driving the scenario. */
function buildHarness() {
  const fakeDocument = makeFakeDocument();
  const sent = [];
  const fakeChrome = makeFakeChrome(sent);
  const fakeWindow = makeFakeWindow();

  const src = [
    extract("tagNameOf"),
    extract("attrOf"),
    extract("isPasswordInput"),
    extract("stripValueLike"),
    extract("stripPasswordContainerSiblings"),
    extract("stripSubtree"),
    extract("sanitizeClone"),
    extract("filterStyles"),
    extract("utf8ByteLength"),
    extract("truncateMarkup"),
    extract("rectToRegion"),
    extract("describeSelector"),
    "var active = false;",
    "var highlightEl = null;",
    "var lastHighlightTarget = null;",
    extract("createHighlight"),
    extract("positionHighlight"),
    extract("removeHighlight"),
    extract("onMouseMove"),
    extract("onClick"),
    extract("onKeydown"),
    extract("attachListeners"),
    extract("detachListeners"),
    extract("teardown"),
    extract("activate"),
    extract("selectElement"),
    extract("cancelPicking"),
    extract("handleMessage")
  ].join("\n\n");

  const H = compile(
    src,
    {
      window: fakeWindow,
      document: fakeDocument,
      chrome: fakeChrome,
      STYLE_PROPERTIES: (() => {
        const m = SRC.match(/var STYLE_PROPERTIES = \[([\s\S]*?)\];/);
        return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
      })(),
      MARKUP_CEILING_BYTES: 32 * 1024,
      PICKER_LISTENER_OPTS: { capture: true, passive: false },
      HIGHLIGHT_Z_INDEX: "2147483647"
    },
    "({ activate, teardown, handleMessage, selectElement, cancelPicking, get active(){ return active; }, get highlightEl(){ return highlightEl; } })"
  );
  return { H, fakeDocument, fakeWindow, sent };
}

function makeFakeTarget(tag, attrs) {
  const el = makeFakeElement(tag);
  Object.assign(el.attrs, attrs || {});
  el.tagName = tag.toUpperCase();
  el.getBoundingClientRect = () => ({ left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50 });
  el.cloneNode = () => {
    const clone = makeFakeElement(tag);
    Object.assign(clone.attrs, el.attrs);
    clone.tagName = el.tagName;
    Object.defineProperty(clone, "outerHTML", { get() { return `<${tag.toLowerCase()}></${tag.toLowerCase()}>`; } });
    return clone;
  };
  return el;
}

// =============================================================================
// Snapshot helpers
// =============================================================================
function snapshotListeners(fakeWindow) {
  return fakeWindow._listeners.map((l) => ({ type: l.type, fn: l.fn, capture: !!(l.opts && l.opts.capture), passive: !!(l.opts && l.opts.passive) }));
}
function listenersEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((l, i) => l.type === b[i].type && l.fn === b[i].fn && l.capture === b[i].capture && l.passive === b[i].passive);
}

// =============================================================================
// 1. Selection route
// =============================================================================
console.log("== teardown symmetry: SELECTION route ==");
{
  const { H, fakeDocument, fakeWindow, sent } = buildHarness();
  const before = snapshotListeners(fakeWindow);
  const nodesBefore = fakeDocument.documentElement.children.length;

  H.activate();
  ok(H.active === true, "activate() arms the mode");
  ok(fakeWindow._listeners.length === 3, "three capture-phase listeners are registered: mousemove, click, keydown");
  ok(fakeDocument.documentElement.children.length === nodesBefore + 1, "the highlight node is appended");

  const target = makeFakeTarget("button", { type: "button", name: "buy" });
  H.selectElement(target);

  ok(H.active === false, "selection ends the mode");
  ok(listenersEqual(snapshotListeners(fakeWindow), before), "every listener is removed with the SAME (type, capture, passive) tuple it was added with");
  ok(fakeDocument.documentElement.children.length === nodesBefore, "the highlight node is removed — node count matches pre-activation exactly");
  ok(sent.length === 1 && sent[0].type === "design_mode_selection", "a selection message was sent to background");
}

// =============================================================================
// 2. Escape route
// =============================================================================
console.log("\n== teardown symmetry: ESCAPE route ==");
{
  const { H, fakeDocument, fakeWindow, sent } = buildHarness();
  const before = snapshotListeners(fakeWindow);
  const nodesBefore = fakeDocument.documentElement.children.length;

  H.activate();
  const escEvt = { key: "Escape", _prevented: false, _stopped: false, preventDefault() { this._prevented = true; }, stopPropagation() { this._stopped = true; } };
  const keydownListener = fakeWindow._listeners.find((l) => l.type === "keydown").fn;
  keydownListener(escEvt);

  ok(H.active === false, "Escape ends the mode");
  ok(escEvt._prevented && escEvt._stopped, "Escape is consumed (preventDefault + stopPropagation) so a page-level handler never sees it");
  ok(listenersEqual(snapshotListeners(fakeWindow), before), "listeners restored to the exact pre-activation set");
  ok(fakeDocument.documentElement.children.length === nodesBefore, "the highlight node is gone");
  ok(sent.length === 1 && sent[0].type === "design_mode_ended" && sent[0].reason === "escape", "an ended(escape) message was sent, nothing selected");
}

// =============================================================================
// 3. Second activation (re-arm) route — design_mode_start while already
//    active tears down the first arm before arming the second, cleanly.
// =============================================================================
console.log("\n== teardown symmetry: SECOND ACTIVATION (re-arm) route ==");
{
  const { H, fakeDocument, fakeWindow } = buildHarness();
  const nodesBefore = fakeDocument.documentElement.children.length;

  H.activate();
  const firstListeners = snapshotListeners(fakeWindow);
  ok(fakeDocument.documentElement.children.length === nodesBefore + 1, "one highlight node after the first activation");

  // Simulate background re-sending design_mode_start (a real second
  // activation is a panel-driven design_mode_stop THEN a fresh
  // design_mode_start — handleMessage's design_mode_start branch is also
  // exercised directly here to prove its OWN idempotent re-arm never
  // doubles up listeners or nodes).
  let response = null;
  H.handleMessage({ type: "design_mode_start" }, {}, (r) => { response = r; });
  ok(response && response.ok === true, "design_mode_start acknowledges");
  ok(fakeDocument.documentElement.children.length === nodesBefore + 1, "still exactly one highlight node — re-arming never doubles it");
  ok(listenersEqual(snapshotListeners(fakeWindow), firstListeners), "re-arming ends with the SAME listener tuples as the first arm — not a superset");

  H.teardown();
  ok(H.active === false && fakeDocument.documentElement.children.length === nodesBefore, "final teardown restores the pre-activation state");
}

// =============================================================================
// 4. Background-requested stop (design_mode_stop — e.g. a bound-page change)
// =============================================================================
console.log("\n== teardown symmetry: BACKGROUND-REQUESTED STOP route (design_mode_stop) ==");
{
  const { H, fakeDocument, fakeWindow, sent } = buildHarness();
  const before = snapshotListeners(fakeWindow);
  const nodesBefore = fakeDocument.documentElement.children.length;

  H.activate();
  let response = null;
  H.handleMessage({ type: "design_mode_stop", reason: "page_changed" }, {}, (r) => { response = r; });

  ok(response && response.ok === true, "design_mode_stop acknowledges");
  ok(H.active === false, "the mode ends");
  ok(listenersEqual(snapshotListeners(fakeWindow), before), "listeners restored to the exact pre-activation set");
  ok(fakeDocument.documentElement.children.length === nodesBefore, "the highlight node is gone");
  ok(sent.length === 0, "a background-REQUESTED stop sends nothing further — background already knows why (no self-notification loop)");
}

// =============================================================================
// 5. Idle (never activated) — a message this listener does not own is
//    ignored WITHOUT answering, so it can never fake pointer-overlay.js's
//    own ack (advisor note 2 / tasks.md 7.3's "must not interfere").
// =============================================================================
console.log("\n== a message this script does not own is never acknowledged ==");
{
  const { H } = buildHarness();
  let responded = false;
  H.handleMessage({ type: "browzyOverlayEvent", event: { kind: "keepalive" } }, {}, () => { responded = true; });
  ok(!responded, "an overlay-bridge message is left completely alone — no ok:true fabricated for a message this script does not own");
}

// =============================================================================
// 6. Structural: the exact same options object is used to add and remove
//    every listener (source-level proof, independent of the fake's own
//    matching logic above).
// =============================================================================
console.log("\n== structural: one named PICKER_LISTENER_OPTS constant, used for both add and remove ==");
{
  ok(/var PICKER_LISTENER_OPTS = \{ capture: true, passive: false \};/.test(SRC), "one shared options object is declared once");
  const addCalls = SRC.match(/window\.addEventListener\([^)]*PICKER_LISTENER_OPTS\)/g) || [];
  const removeCalls = SRC.match(/window\.removeEventListener\([^)]*PICKER_LISTENER_OPTS\)/g) || [];
  ok(addCalls.length === 3, "all three listeners (mousemove/click/keydown) are added with PICKER_LISTENER_OPTS");
  ok(removeCalls.length === 3, "and all three are removed with the SAME PICKER_LISTENER_OPTS reference — never a re-literal {capture:true,...} that would fail to match in a real browser");
}

console.log(fail === 0 ? "\nALL ELEMENT-PICKER LIFECYCLE TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

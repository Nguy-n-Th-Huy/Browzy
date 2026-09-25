#!/usr/bin/env node
//
// Regression: live-Chrome report — clicking the "Vừa khung" trigger in the
// context-chip row did nothing. Root cause (extension/sidepanel/sidepanel.js):
//
//   1. The trigger's click handler calls openViewportMenu() -> renderContextChip(),
//      which does `el.contextChipRow.innerHTML = ""` and rebuilds the row
//      SYNCHRONOUSLY, inside the same click handler. This detaches the
//      button the click actually landed on (e.target) from the DOM before
//      the event finishes bubbling.
//   2. The same click then reaches the document-level outside-click listener.
//      There, `el.contextChipRow.contains(e.target)` is false (e.target is
//      detached), so the listener mistakes its own just-opened menu for an
//      outside click and closes it in the same tick — the menu opens and
//      closes within one click, so it never appears to the user.
//
// The fix (see that same file) swaps `e.target` for `e.composedPath()`:
// composedPath() is captured once when the event is dispatched, BEFORE any
// listener runs, so it still lists the original ancestors (the row, in
// particular) even after a listener detaches the target mid-dispatch.
//
// TEST STRATEGY. sidepanel.js is DOM-only glue with no exports (see its own
// file header) — the repo's existing sidepanel-*.test.mjs suites either
// regex-check its source structurally, or extract+compile named functions
// from the SHIPPED file the way test/viewport-modes-wiring.test.mjs already
// does for extension/background.js (test/_extract.mjs). This test follows
// that second, stronger pattern: it extracts the actual viewport-menu
// functions (open/close/select/build*/render) plus the actual document-level
// outside-click/Escape listener block out of the real sidepanel.js source and
// runs them against a small fake DOM.
//
// That fake DOM is written locally in this file rather than by extending the
// shared test/_fake-dom.mjs. _fake-dom.mjs's own header documents "no event
// bubbling" as a deliberate design choice ("a test dispatches on the element
// whose own listener it wants") that its 8 existing consumers rely on; this
// bug is a bubbling/composedPath bug by nature; simulating it needs a fake
// event dispatch that bubbles through a path captured at dispatch time
// (exactly the browser behaviour the fix depends on), which is a real
// behavioural difference from _fake-dom.mjs's dispatchEvent, not a small
// additive capability. Changing the shared dispatchEvent's semantics risked
// altering behaviour those 8 other suites depend on, so this test brings its
// own minimal FakeElement/document instead of touching that shared file.
//
// Run: node test/viewport-modes-menu-open.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { iconMarkup } from "../extension/ui/icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL_PATH = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const SIDEPANEL_SRC = fs.readFileSync(SIDEPANEL_PATH, "utf8");

let failed = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
}

// ---------------------------------------------------------------------------
// Extraction. test/_extract.mjs's own extractFunction() finds a function's
// body by brace-matching from the FIRST "{" after the function name — which
// breaks for closeViewportMenu({ returnFocus = false } = {}): its parameter
// list contains braces of its own (the destructuring default), so the first
// "{" found is that one, and matchBraces returns as soon as THAT balances,
// well before the real function body. Verified empirically against the
// shipped source before writing this. A local, paren-then-brace extractor
// (below) sidesteps that: it balances the parameter list by counting only
// "(" / ")", and only starts brace-matching the body after that list closes.
// Kept local to this file rather than patched into the shared _extract.mjs,
// since another change is actively editing extension/background.js on this
// branch and _extract.mjs is shared test infra.
// ---------------------------------------------------------------------------
function extractFn(name) {
  const marker = `function ${name}(`;
  let start = SIDEPANEL_SRC.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in sidepanel.js`);
  if (SIDEPANEL_SRC.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const parenOpen = SIDEPANEL_SRC.indexOf("(", start);
  let depth = 0;
  let parenClose = parenOpen;
  for (; parenClose < SIDEPANEL_SRC.length; parenClose++) {
    const c = SIDEPANEL_SRC[parenClose];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const braceOpen = SIDEPANEL_SRC.indexOf("{", parenClose);
  depth = 0;
  let braceClose = braceOpen;
  for (; braceClose < SIDEPANEL_SRC.length; braceClose++) {
    const c = SIDEPANEL_SRC[braceClose];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        braceClose++;
        break;
      }
    }
  }
  return SIDEPANEL_SRC.slice(start, braceClose);
}

function extractBlock(anchor) {
  const start = SIDEPANEL_SRC.indexOf(anchor);
  if (start === -1) throw new Error(`anchor not found in sidepanel.js: ${anchor}`);
  const braceOpen = SIDEPANEL_SRC.indexOf("{", start);
  let depth = 0;
  let braceClose = braceOpen;
  for (; braceClose < SIDEPANEL_SRC.length; braceClose++) {
    const c = SIDEPANEL_SRC[braceClose];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        braceClose++;
        break;
      }
    }
  }
  return SIDEPANEL_SRC.slice(start, braceClose);
}

// ---------------------------------------------------------------------------
// Minimal fake DOM: real (captured-at-dispatch) bubbling + composedPath(),
// enough innerHTML parsing to support sidepanel.js's own
// `el.innerHTML = "<span class=...></span>..."` then `el.querySelector(...)`
// pattern, and just enough querySelector/querySelectorAll (class and
// [attr="value"] tokens, space = descendant) to resolve the handful of
// selectors this control actually uses.
// ---------------------------------------------------------------------------
class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName || "div").toUpperCase();
    this._doc = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.title = "";
    this.style = {};
    this._text = "";
    this._listeners = new Map();
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }

  set textContent(v) {
    this._text = v == null ? "" : String(v);
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
  }

  set innerHTML(html) {
    for (const c of this.children.slice()) this.removeChild(c);
    this._text = "";
    const stack = [this];
    const tokenRe = /<[^>]+>|[^<]+/g;
    let m;
    while ((m = tokenRe.exec(String(html || "")))) {
      const tok = m[0];
      if (tok[0] !== "<") continue; // text nodes aren't needed: every real usage sets textContent by property afterward
      if (tok.startsWith("</")) {
        stack.pop();
        continue;
      }
      const selfClose = /\/>\s*$/.test(tok);
      const nameMatch = tok.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/);
      const tagName = nameMatch ? nameMatch[1] : "div";
      const attrsStr = tok.slice(nameMatch[0].length, tok.length - (selfClose ? 2 : 1));
      const node = this._doc.createElement(tagName);
      const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
      let am;
      while ((am = attrRe.exec(attrsStr))) {
        const val = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : "";
        node.setAttribute(am[1], val);
      }
      stack[stack.length - 1].appendChild(node);
      if (!selfClose) stack.push(node);
    }
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value); // innerHTML-parsed nodes only ever get a class via this path
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i !== -1) list.splice(i, 1);
  }

  focus() {
    if (this._doc) this._doc.activeElement = this;
  }

  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  querySelectorAll(selector) {
    const allDescendants = (node, acc) => {
      for (const c of node.children) {
        acc.push(c);
        allDescendants(c, acc);
      }
      return acc;
    };
    const matchesToken = (el, token) => {
      if (token.startsWith(".")) return (el.className || "").split(/\s+/).includes(token.slice(1));
      const m = token.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
      if (m) return el.getAttribute(m[1]) === m[2];
      return false;
    };
    const tokens = selector.trim().split(/\s+/);
    let pool = [this];
    for (let i = 0; i < tokens.length; i++) {
      const next = [];
      for (const c of pool) {
        for (const d of allDescendants(c, [])) {
          if (matchesToken(d, tokens[i])) next.push(d);
        }
      }
      pool = next;
    }
    return pool;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function createDocument() {
  const doc = {
    activeElement: null,
    _listeners: new Map(),
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) doc._listeners.set(type, []);
      doc._listeners.get(type).push(fn);
    },
  };
  return doc;
}

/**
 * Dispatches a click that bubbles the way a real DOM does: the path from
 * target up to (and including) document is captured ONCE, before any
 * listener runs, and every listener along that captured path still runs even
 * if a listener detaches the target (or any ancestor) from the tree
 * mid-dispatch. This is exactly the browser behaviour the bug depends on
 * (the detach happens) and the fix depends on (composedPath() still sees the
 * pre-detach ancestors).
 */
function dispatchClick(doc, target) {
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  path.push(doc);
  const event = {
    type: "click",
    target,
    _stopped: false,
    preventDefault() {},
    stopPropagation() {
      this._stopped = true;
    },
    composedPath() {
      return path.slice();
    },
  };
  for (const node of path) {
    if (event._stopped) break;
    for (const fn of (node._listeners.get("click") || []).slice()) fn(event);
  }
  return event;
}

// ---------------------------------------------------------------------------
// Compile the extracted, SHIPPED viewport-menu logic against the fake DOM.
// ---------------------------------------------------------------------------

// Mirrors sidepanel.js's own VIEWPORT_MODE_ROWS table (design.md
// add-page-viewport-modes Decision 10) — the same small-constant-duplication
// test/viewport-modes.test.mjs and test/viewport-modes-wiring.test.mjs
// already use for background.js's own tables, kept here so this test's
// compiled scope doesn't need to `import` sidepanel.js as a module (it has no
// exports and its top level touches chrome.*/document immediately).
const VIEWPORT_MODE_ROWS = [
  { mode: "fit", label: "Vừa cửa sổ", short: "Vừa khung", desc: "Bỏ giả lập, về kích thước bình thường" },
  { mode: "mobile", label: "Di động", short: "Di động", desc: "390px, có chạm, giao diện điện thoại" },
  { mode: "tablet", label: "Tablet", short: "Tablet", desc: "768px, có chạm, giao diện máy tính bảng" },
  { mode: "pc", label: "PC", short: "PC", desc: "1280px, thu nhỏ nếu cửa sổ hẹp hơn" },
];
function viewportModeRowShortLabel(mode) {
  const row = VIEWPORT_MODE_ROWS.find((r) => r.mode === mode);
  return row ? row.short : VIEWPORT_MODE_ROWS[0].short;
}

const compiledSrc = [
  'let viewportMode = { tabId: null, mode: "fit", overridden: false };',
  "let viewportMenuOpen = false;",
  // selectViewportMode (extracted below, verbatim from the shipped source)
  // now tags its viewport_mode_set with VIEWPORT_PANEL_INSTANCE_ID (design.md
  // Decision 7's port-based panel-close fix, see test/viewport-modes-wiring
  // .test.mjs) — a free variable in the real file that sidepanel.js's module
  // scope provides; this compiled scope provides an equivalent constant so
  // the extracted function body resolves.
  'const VIEWPORT_PANEL_INSTANCE_ID = "test-panel-instance";',
  extractFn("closeViewportMenu"),
  extractFn("openViewportMenu"),
  extractFn("selectViewportMode"),
  extractFn("buildViewportMenu"),
  extractFn("buildViewportModeControl"),
  extractBlock('if (typeof document !== "undefined") {'),
  extractFn("renderContextChip"),
].join("\n\n");

function build({ doc, el, chrome, pageContext }) {
  const referencesCurrentPage = () => false;
  const showAttachmentErrorCalls = [];
  const showAttachmentError = (msg) => showAttachmentErrorCalls.push(msg);
  const requestAnimationFrame = (cb) => cb();
  const contextStaleNotice = null;

  const factory = new Function(
    "document", "el", "chrome", "pageContext", "iconMarkup", "referencesCurrentPage",
    "showAttachmentError", "requestAnimationFrame", "VIEWPORT_MODE_ROWS", "viewportModeRowShortLabel",
    "contextStaleNotice",
    compiledSrc + `
      return {
        renderContextChip, openViewportMenu, closeViewportMenu, selectViewportMode,
        get viewportMenuOpen() { return viewportMenuOpen; },
        get viewportMode() { return viewportMode; },
      };
    `
  );
  const api = factory(
    doc, el, chrome, pageContext, iconMarkup, referencesCurrentPage,
    showAttachmentError, requestAnimationFrame, VIEWPORT_MODE_ROWS, viewportModeRowShortLabel,
    contextStaleNotice
  );
  return { api, showAttachmentErrorCalls };
}

// ---------------------------------------------------------------------------
// Scenario: bind a tab, render the row, click the trigger, assert the menu
// is actually present (the reported bug), then click a mode row and assert
// the right viewport_mode_set goes out.
// ---------------------------------------------------------------------------

console.log("\nclicking the trigger opens the menu and it stays open (the reported bug)\n");

const doc = createDocument();
const contextChipRow = doc.createElement("div");
const composerInput = doc.createElement("textarea");
composerInput.value = "";
const el = { contextChipRow, composerInput };

const sentMessages = [];
const chrome = {
  runtime: {
    sendMessage: async (msg) => {
      sentMessages.push(msg);
      if (msg.type === "viewport_mode_set") return { ok: true, mode: msg.mode };
      return null;
    },
  },
  tabs: { reload: async () => {} },
};

const pageContext = {
  snapshot: () => ({ tabId: 1, hostname: "example.com", title: "Example", restricted: false, pinned: false }),
  wasExplicitlyRemoved: () => false,
  unpin: () => {},
  pinCurrent: () => {},
  clear: () => {},
};

const { api } = build({ doc, el, chrome, pageContext });

api.renderContextChip();
ok(el.contextChipRow.querySelector(".viewport-mode-trigger") != null, "initial render: the trigger button is present");
ok(el.contextChipRow.querySelector('[role="menu"]') == null, "initial render: the menu is not present (closed by default)");

const trigger = el.contextChipRow.querySelector(".viewport-mode-trigger");
dispatchClick(doc, trigger);

ok(api.viewportMenuOpen === true, `menu state stays open after the click (got viewportMenuOpen=${api.viewportMenuOpen})`);
const menu = el.contextChipRow.querySelector('[role="menu"]');
ok(menu != null, "the menu is actually present in the row after the click (this is the reported bug: it was not)");
const rows = el.contextChipRow.querySelectorAll('[role="menuitemradio"]');
ok(rows.length === 4, `the menu has exactly 4 menuitemradio rows (got ${rows.length})`);

console.log("\nclicking a row sends viewport_mode_set with that row's mode\n");

const mobileRow = rows.find((r) => (r.textContent || "").includes("Di động"));
ok(mobileRow != null, "found the 'Di động' (mobile) row by its label text");
sentMessages.length = 0;
dispatchClick(doc, mobileRow);
await new Promise((resolve) => setTimeout(resolve, 0));

ok(api.viewportMenuOpen === false, "picking a mode closes the menu");
ok(
  sentMessages.some((m) => m.type === "viewport_mode_set" && m.tabId === 1 && m.mode === "mobile"),
  `viewport_mode_set was sent for tabId 1, mode "mobile" (got ${JSON.stringify(sentMessages)})`
);
ok(
  sentMessages.some((m) => m.type === "viewport_mode_set" && m.instanceId === "test-panel-instance"),
  `viewport_mode_set carries the panel's own instanceId (design.md Decision 7's port-based panel-close fix) (got ${JSON.stringify(sentMessages)})`
);

console.log("\na second open/click cycle behaves the same way (not a one-shot fluke)\n");

dispatchClick(doc, el.contextChipRow.querySelector(".viewport-mode-trigger"));
ok(api.viewportMenuOpen === true, "menu opens again on a second trigger click");
ok(el.contextChipRow.querySelector('[role="menu"]') != null, "menu is present again");
const pcRow = el.contextChipRow.querySelectorAll('[role="menuitemradio"]').find((r) => (r.textContent || "").includes("PC"));
sentMessages.length = 0;
dispatchClick(doc, pcRow);
await new Promise((resolve) => setTimeout(resolve, 0));
ok(
  sentMessages.some((m) => m.type === "viewport_mode_set" && m.mode === "pc"),
  `second cycle: viewport_mode_set sent for mode "pc" (got ${JSON.stringify(sentMessages)})`
);

console.log(failed ? `\n${failed} FAILED\n` : "\nAll passed\n");
process.exit(failed ? 1 : 0);

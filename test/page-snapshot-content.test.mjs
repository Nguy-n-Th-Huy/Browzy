// page_snapshot, content-script half (openspec/changes/add-typesafe-jev-provider,
// design.md section 2 / specs/agent-browser-runtime.md "Page snapshot
// operation").
//
// STRUCTURAL PROOF, not a re-implementation. The whole shipped content script
// body is compiled and executed here against a stand-in DOM, and the
// `pageSnapshot` message is delivered through the listener the script really
// registers on chrome.runtime.onMessage — so the code under test is the code
// that ships, including every helper the snapshot reuses (getRole,
// getAccessibleName, isVisible, isInteractive, getOrAssignRef, getPageText).
// The stand-in DOM implements exactly the surface those functions touch and
// nothing more; it is not jsdom and does not pretend to be a browser.
//
// The mutation log is the read-only proof: the stand-in elements the test
// builds record the calls a read must never make (focus, click,
// scrollIntoView, attribute/DOM writes, value/checked/selected writes), and
// every case asserts it stayed empty.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const CONTENT = path.join(ROOT, "extension", "content.js");
const contentSrc = fs.readFileSync(CONTENT, "utf8");

// The shipped bounds, read out of the source rather than restated here: the
// assertions below prove "the shipped bound is applied", whatever it is set to.
const numConst = (name) => Number(new RegExp(`const ${name} = (\\d+);`).exec(contentSrc)[1]);
const strConst = (name) => new RegExp(`const ${name} = "([^"]*)"`).exec(contentSrc)[1];
const MAX_ELEMENTS = numConst("SNAPSHOT_MAX_ELEMENTS");
const MAX_TEXT = numConst("SNAPSHOT_MAX_TEXT_CHARS");
const MAX_LABEL = numConst("SNAPSHOT_MAX_LABEL_CHARS");
const MAX_VALUE = numConst("SNAPSHOT_MAX_VALUE_CHARS");
const MAX_OPTIONS = numConst("SNAPSHOT_MAX_OPTIONS");
const MAX_POINTER = numConst("SNAPSHOT_MAX_POINTER_ELEMENTS");
const MASK_ATTR = strConst("MASK_ATTR");
const MASK_PLACEHOLDER = strConst("MASK_PLACEHOLDER");

console.log(`== shipped bounds: ${MAX_ELEMENTS} elements, ${MAX_TEXT} text chars, ` +
  `${MAX_LABEL}/${MAX_VALUE} label/value chars, ${MAX_OPTIONS} options, ${MAX_POINTER} pointer-pass elements ==`);

// --- The shipped script, minus the IIFE wrapper ---------------------------
const bodyStart = contentSrc.indexOf("(function () {");
const bodyEnd = contentSrc.lastIndexOf("})();");
if (bodyStart === -1 || bodyEnd === -1) throw new Error("content.js IIFE not found");
const SCRIPT_BODY = contentSrc.slice(bodyStart + "(function () {".length, bodyEnd);

// Compiled once, called per case: each case gets its own document, ref
// counter, and listener — exactly what a fresh page gives the script.
const bootContentScript = new Function(
  "window", "document", "chrome", "location", "history", "crypto", "CSS",
  "getComputedStyle", "NodeFilter",
  SCRIPT_BODY
);

// --- Stand-in DOM ---------------------------------------------------------

/** The selectors content.js actually asks closest()/matches() about. Quotes
 * around an attribute value may be single or double — content.js's own
 * selector lists (SNAPSHOT_POINTER_NESTED_CONTROL_SELECTOR, contextLabelOf's
 * inline list) use single quotes, real CSS accepts either. */
function matchesSelector(node, sel) {
  if (sel === "label") return node.tagName === "LABEL";
  const m = /^\[([a-zA-Z-]+)(?:=["']([^"']*)["'])?\]$/.exec(sel);
  if (m) {
    const value = node.getAttribute(m[1]);
    return m[2] === undefined ? value !== null : value === m[2];
  }
  return false;
}

/** The container list getPageText() ranks: tags, `.class`, `#id`, and the
 * attribute-contains form. Document-level only — closest()/matches() keep
 * exactly the semantics the other snapshot helpers were written against. */
function matchesContainerSelector(node, sel) {
  const cls = /^\.([A-Za-z0-9_-]+)$/.exec(sel);
  if (cls) return String(node.getAttribute("class") || "").split(/\s+/).includes(cls[1]);
  const id = /^#([A-Za-z0-9_-]+)$/.exec(sel);
  if (id) return node.id === id[1];
  const contains = /^\[([a-zA-Z-]+)\*="([^"]*)"\]$/.exec(sel);
  if (contains) {
    const value = node.getAttribute(contains[1]);
    return value !== null && value.includes(contains[2]);
  }
  if (/^[a-z][a-z0-9-]*$/.test(sel)) return node.tagName === sel.toUpperCase();
  return matchesSelector(node, sel);
}

function attach(parent, child) {
  child.parentNode = parent;
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function descendants(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children) { out.push(child); walk(child); }
  };
  walk(root);
  return out;
}

/** One stand-in element. `opts.track` opts it into the mutation log — the
 * read-only proof that a snapshot changed nothing; a fixture that must prove a
 * value was never READ (the masked-textarea rule) passes `opts.reads` too. */
function makeElement(tag, opts = {}) {
  // The non-rendered states getPageText()'s visibility seam must honor:
  // display:none, visibility:hidden/collapse, the `hidden` attribute, and the
  // states only the browser's own answer can see (a closed <details> body).
  // Composed into one flag so checkVisibility() can answer for descendants
  // the way a browser does. `content-visibility: hidden` is deliberately NOT
  // here: Chromium's checkVisibility answers true for it (its box survives,
  // its contents are skipped) — the extractor excludes it through the
  // computed property instead, which the computedStyle seam below reports.
  const notRendered = opts.invisible === true ||
    (opts.style && (opts.style.display === "none" ||
      opts.style.visibility === "hidden" || opts.style.visibility === "collapse")) ||
    (opts.attrs && Object.prototype.hasOwnProperty.call(opts.attrs, "hidden"));
  // `display: contents` is the opposite shape: Chromium's checkVisibility
  // answers false for the element itself (no box of its own), while its
  // children and text nodes still render in the parent's formatting — so it
  // must not be composed into `notRendered`, which prunes whole subtrees.
  const boxless = !!(opts.style && opts.style.display === "contents");
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    id: opts.id || "",
    // Real elements reflect the `class` attribute onto `.className` — the
    // one property contextLabelOf and the ref-hint helpers read a class
    // pattern off (getAttribute("class") is a separate, already-covered
    // path). A plain field, not an accessor: content.js's own annotation
    // code does a bare `el.className = "..."` write, which this must accept
    // exactly like a real element does.
    className: (opts.attrs && opts.attrs.class) || "",
    _text: opts.text === undefined ? "" : String(opts.text),
    _attrs: Object.assign({}, opts.attrs),
    _track: opts.track || null,
    _reads: opts.reads || null,
    _notRendered: notRendered,
    _boxless: boxless,
    children: [],
    parentNode: null,
    parentElement: null,
    shadowRoot: opts.shadowRoot || null,
    // A null offsetParent IS the browser's answer for an element with no box
    // (display:none, or a detached subtree) — see isVisible's first line.
    offsetParent: opts.invisible ? null : {},
    style: Object.assign({}, opts.style),
    getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; },
    hasAttribute(name) { return name in this._attrs; },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
      if (this._track) this._track.push(`setAttribute:${name}`);
    },
    removeAttribute(name) {
      delete this._attrs[name];
      if (this._track) this._track.push(`removeAttribute:${name}`);
    },
    appendChild(child) {
      if (this._track) this._track.push("appendChild");
      return attach(this, child);
    },
    removeChild(child) {
      if (this._track) this._track.push("removeChild");
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    // The live-DOM walk getPageText() performs reads childNodes: this
    // element's own text (when it has any), then its child elements, in
    // order — the same order textContent below reports.
    get childNodes() {
      return this._text === ""
        ? this.children
        : [{ nodeType: 3, nodeValue: this._text }, ...this.children];
    },
    // Chromium's answer, modeled: false when this element, or an ancestor,
    // is in a state that removes the box or hides the subtree — and also
    // false for `display: contents`, which has no box of its own while its
    // children still render. getPageText() must treat that false as
    // "not a prune", which is why the two shapes are tracked separately.
    checkVisibility() {
      for (let n = this; n; n = n.parentNode || n.parentElement) {
        if (n._notRendered === true) return false;
      }
      return this._boxless !== true;
    },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
    set textContent(value) {
      this._text = String(value);
      this.children = [];
      if (this._track) this._track.push("write:textContent");
    },
    getBoundingClientRect() {
      const r = opts.rect || {};
      return {
        x: Number.isFinite(r.x) ? r.x : 0,
        y: Number.isFinite(r.y) ? r.y : 0,
        width: Number.isFinite(r.width) ? r.width : 20,
        height: Number.isFinite(r.height) ? r.height : 20
      };
    },
    closest(sel) {
      for (let n = this; n; n = n.parentNode || n.parentElement) if (matchesSelector(n, sel)) return n;
      return null;
    },
    // `pseudoDisabled` stands in for the one state the `disabled` property
    // does not reflect: a control inside a disabled <fieldset> matches
    // :disabled without carrying the attribute.
    matches(sel) { return (opts.pseudoDisabled === true && sel === ":disabled") || matchesSelector(this, sel); },
    // "*" answers with every descendant; a real (possibly comma-separated)
    // selector list is matched with the same tag/.class/#id/[attr] rules
    // matchesContainerSelector already applies at document level — reused
    // here so an element-scoped query (contextLabelOf's "does this child
    // hold a control" check, the pointer pass's "no nested native control"
    // check) is genuinely evaluated rather than always answering empty.
    querySelectorAll(sel) {
      if (sel === "*") return descendants(this);
      const parts = sel.split(",").map((s) => s.trim());
      return descendants(this).filter((n) => parts.some((p) => matchesContainerSelector(n, p)));
    },
    querySelector(sel) { const list = this.querySelectorAll(sel); return list.length ? list[0] : null; },
    contains(other) {
      for (let n = other; n; n = n.parentNode || n.parentElement) if (n === this) return true;
      return false;
    },
    focus() { if (this._track) this._track.push("focus"); },
    scrollIntoView() { if (this._track) this._track.push("scrollIntoView"); },
    click() { if (this._track) this._track.push("click"); },
    dispatchEvent() { if (this._track) this._track.push("dispatchEvent"); return true; },
    addEventListener() {},
    removeEventListener() {}
  };

  // The properties the snapshot reads. Defined as accessors so a WRITE to one
  // lands in the mutation log — the builder must never write a control's value
  // or state.
  const props = {
    type: opts.type, value: opts.value, checked: opts.checked, selected: opts.selected,
    disabled: opts.disabled, readOnly: opts.readOnly, contentEditable: opts.contentEditable,
    tabIndex: opts.tabIndex, placeholder: opts.placeholder, title: opts.title,
    alt: opts.alt, onclick: opts.onclick, options: opts.options
  };
  for (const [name, initial] of Object.entries(props)) {
    if (initial === undefined) continue;
    let current = initial;
    Object.defineProperty(node, name, {
      enumerable: true,
      configurable: true,
      get() {
        if (this._reads) this._reads.push(name);
        return current;
      },
      set(next) {
        current = next;
        if (this._track) this._track.push(`write:${name}`);
      }
    });
  }
  return node;
}

const computedStyle = (node) => ({
  display: (node.style && node.style.display) || "",
  visibility: (node.style && node.style.visibility) || "",
  contentVisibility: (node.style && node.style.contentVisibility) || "",
  position: (node.style && node.style.position) || "",
  // The pointer-affordance pass's one signal (task 1.1). Left unset by every
  // other fixture in this file, so every pre-existing case doubles as a
  // "this pass adds nothing on an unaffected page" proof.
  cursor: (node.style && node.style.cursor) || ""
});

function makeDocument(opts) {
  const html = makeElement("html", {});
  html.scrollHeight = opts.scrollHeight;
  const body = makeElement("body", { text: opts.bodyText, track: opts.track });
  const head = makeElement("head", {});
  attach(html, head);
  attach(html, body);
  for (const child of opts.elements) attach(body, child);

  const doc = {
    title: opts.title,
    body,
    documentElement: html,
    activeElement: null,
    children: [html],
    getElementById: (id) => descendants(doc).find((n) => n.id === id) || null,
    querySelector: () => null,
    // Real querySelectorAll does not pierce shadow roots — snapshotWalk
    // recurses into shadowRoot itself, exactly as the shipped walk does. The
    // container list getPageText() ranks is answerable here so container
    // selection is really exercised, not short-circuited to body.
    querySelectorAll: (sel) => (sel === "*" ? descendants(doc) : descendants(doc).filter((n) => matchesContainerSelector(n, sel))),
    createElement: (tag) => makeElement(tag, {}),
    createTreeWalker: () => ({ nextNode: () => null })
  };
  return doc;
}

/** The pre-checkVisibility seam: no element exposes the method, so the
 * extraction must fall back to getComputedStyle + the hidden attribute. */
function stripCheckVisibility(node) {
  delete node.checkVisibility;
  for (const child of node.children) stripCheckVisibility(child);
}

/** Boot the shipped script against a fresh stand-in document and hand back the
 * message channel the background page really talks to. `opts.visibility`
 * selects the seam `getPageText` asks about: every element's own
 * `checkVisibility` (the browser default) or, with "computed", only the
 * injected `getComputedStyle` + the hidden attribute. */
function bootWorld(opts = {}) {
  const mutations = [];
  const track = mutations;
  const elements = (opts.elements || []).map((build) => build(track));
  const doc = makeDocument({
    bodyText: opts.bodyText || "",
    elements,
    track,
    title: opts.title || "Fixture page",
    scrollHeight: opts.scrollHeight === undefined ? 4000 : opts.scrollHeight
  });
  if (opts.visibility === "computed") stripCheckVisibility(doc.documentElement);
  const registered = { fn: null };
  const chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => { registered.fn = fn; },
        removeListener: () => {}
      }
    }
  };
  const win = {
    innerWidth: opts.viewport ? opts.viewport.w : 1024,
    innerHeight: opts.viewport ? opts.viewport.h : 768,
    scrollY: opts.scrollY === undefined ? 120 : opts.scrollY,
    addEventListener() {},
    removeEventListener() {}
  };
  const location = { href: opts.url || "https://example.com/orders" };
  // A real history.pushState/replaceState changes location.href as a side
  // effect; content.js's own wrapper (installSpaTracking) compares
  // location.href before/after the ORIGINAL call to decide a route changed,
  // so the stand-in must actually move the href for that comparison to be
  // exercisable at all — a no-op stub, as this used to be, can never trigger
  // the SPA-route-change path from a test.
  const history = {
    pushState(state, title, url) { if (typeof url === "string") location.href = url; },
    replaceState(state, title, url) { if (typeof url === "string") location.href = url; }
  };
  bootContentScript(
    win, doc, chrome, location,
    history,
    { randomUUID: () => opts.docNonce || "fixture-uuid" },
    { escape: (s) => s },
    computedStyle,
    { SHOW_TEXT: 4 }
  );
  return {
    mutations,
    registered,
    doc,
    win,
    location,
    history,
    send(msg) {
      let reply;
      const handled = registered.fn(msg, null, (r) => { reply = r; });
      return { handled, reply };
    }
  };
}

// --- 1. Routing -----------------------------------------------------------
console.log("== message routing ==");
{
  const world = bootWorld();
  ok(typeof world.registered.fn === "function", "the script registers its listener on chrome.runtime.onMessage");
  const reply = world.send({ type: "pageSnapshot" });
  ok(reply.handled === true && reply.reply && typeof reply.reply.result === "object",
    "pageSnapshot is handled and answers with an object result");
  ok(world.send({ type: "definitelyNotAHandler" }).handled === false, "an unknown message type is still not handled");
}

// --- 2. Which controls are listed ----------------------------------------
console.log("== filters to visible, enabled, actionable controls ==");
{
  const world = bootWorld({
    bodyText: "Trang đơn hàng",
    elements: [
      (track) => makeElement("button", { text: "Đặt hàng", track }),
      (track) => makeElement("input", { track, type: "text", value: "quận 1", attrs: { "aria-label": "Địa chỉ" } }),
      (track) => makeElement("input", { track, type: "text", value: "ẩn", invisible: true }),
      (track) => makeElement("input", { track, type: "text", value: "tắt", disabled: true }),
      (track) => makeElement("input", { track, type: "text", value: "fieldset", pseudoDisabled: true }),
      (track) => makeElement("button", { text: "không kích thước", track, rect: { width: 0, height: 0 } }),
      (track) => makeElement("div", { text: "chỉ là chữ", track }),
      (track) => makeElement("a", { text: "Liên kết", track, style: { display: "none" } }),
      (track) => {
        const wrapper = makeElement("div", { attrs: { "aria-hidden": "true" } });
        attach(wrapper, makeElement("button", { text: "ẩn với AT", track }));
        return wrapper;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const labels = snap.elements.map((e) => e.label);

  ok(snap.elements.length === 2, `only the two actionable controls are listed (got ${snap.elements.length}: ${JSON.stringify(labels)})`);
  ok(labels.includes("Đặt hàng") && labels.includes("Địa chỉ"), "the visible enabled button and input are both there");
  ok(!labels.includes("ẩn"), "a control with no layout box is out");
  ok(!labels.includes("tắt"), "an explicitly disabled control is out");
  ok(!labels.includes("fieldset"), "a control disabled through :disabled (a disabled fieldset) is out");
  ok(!labels.includes("không kích thước"), "a zero-size control is out");
  ok(!labels.includes("chỉ là chữ") && !labels.includes("Liên kết"), "a non-interactive div and a display:none link are out");
  ok(!labels.includes("ẩn với AT"), "a control inside an aria-hidden container is out");
  ok(world.mutations.length === 0, `the read changed nothing on the page (${JSON.stringify(world.mutations)})`);
}

// --- 2b. The context-label fallback ---------------------------------------
console.log("== a control whose visible label sits beside it (no for=, no aria) still gets that name ==");
{
  // The real-world shape this exists for (verified against DauThau.info's
  // advanced search): a bootstrap form-group whose <label> has no `for=`,
  // wrapping the control's row rather than being linked to it. Without the
  // fallback every such control's name is empty and a text-only reader cannot
  // tell the province filter from the keyword box.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", { attrs: { class: "form-group" } });
        const label = makeElement("label", { track, text: "Nơi thực hiện" });
        const row = makeElement("div", { track });
        const select = makeElement("select", { track, attrs: { id: "idprovincekq", name: "idprovincekq[]" } });
        attach(group, label);
        attach(group, row);
        attach(row, select);
        return group;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const record = snap.elements.find((e) => e.tag === "select");
  ok(record && record.label === "Nơi thực hiện",
    `the unlinked sibling label becomes the control's name (got ${record && JSON.stringify(record.label)})`);
  ok(world.mutations.length === 0, `naming the control still changed nothing (${JSON.stringify(world.mutations)})`);
}
{
  // The control must NOT borrow a name it does not have: when nothing
  // label-ish sits beside it, the name stays empty rather than the fallback
  // guessing some unrelated text.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const stray = makeElement("div", { track, text: "Đoạn văn bản dài không phải nhãn của ô nào cả, chỉ là nội dung trang bình thường viết dài hơn tám mươi ký tự để chắc chắn bị từ chối." });
        const row = makeElement("div", { track });
        const input = makeElement("input", { track, type: "text" });
        attach(group, stray);
        attach(group, row);
        attach(row, input);
        return group;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const record = snap.elements.find((e) => e.tag === "input");
  ok(record && record.label === "", `a control with no label beside it keeps an empty name (got ${record && JSON.stringify(record.label)})`);
}

{
  // The combobox variant of the same page: select2-style widgets put their
  // CURRENT VALUE in their own text, so the leaf-text branch would name the
  // province filter "Chưa phân loại" (its placeholder value) — the exact
  // live confusion this ordering fixes. The field name beside it wins.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", { attrs: { class: "form-group" } });
        const label = makeElement("label", { track, text: "Nơi thực hiện" });
        const row = makeElement("div", { track });
        const widget = makeElement("span", { track, attrs: { role: "combobox" }, text: "Chưa phân loại" });
        attach(group, label);
        attach(group, row);
        attach(row, widget);
        return group;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const record = snap.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "Nơi thực hiện",
    `a combobox takes the field name beside it, not its own value text (got ${record && JSON.stringify(record.label)})`);
}

// --- 2c. Naming a widget control that carries no accessible name of its own
console.log("== an unnamed generic container is named by the value it displays, or by its caption when the page offers one ==");
{
  // muasamcong.mpi.gov.vn's Ant Design "Tìm theo" select, reproduced by
  // shape: a div[role="combobox"] whose displayed value lives in an
  // uncaptured descendant (div.ant-select-selection__rendered > div), with
  // no aria-label, no title, no associated label, and no caption beside it.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const combo = makeElement("div", { track, attrs: { role: "combobox" } });
        const rendered = makeElement("div", {});
        attach(rendered, makeElement("div", { text: "Thông báo mời thầu" }));
        attach(combo, rendered);
        attach(group, combo);
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "Thông báo mời thầu",
    `an unnamed combobox with no caption is named by the value it displays (got ${record && JSON.stringify(record.label)})`);
}
{
  // The same shape, now with a visible caption preceding it in the field
  // group — a plain, unstyled <div>, no label tag, no label-ish class. The
  // caption names the control and the displayed value does not displace it.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const caption = makeElement("div", { track, text: "Tìm theo" });
        const combo = makeElement("div", { track, attrs: { role: "combobox" } });
        const rendered = makeElement("div", {});
        attach(rendered, makeElement("div", { text: "Thông báo mời thầu" }));
        attach(combo, rendered);
        attach(group, caption);
        attach(group, combo);
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "Tìm theo",
    `a shape-recognised caption names the control instead of the value it displays (got ${record && JSON.stringify(record.label)})`);
}
{
  // A control that already carries an accessible name — including one this
  // portal authors poorly (the literal string "Default") — is reported
  // unchanged: no fallback runs, and a caption beside it never overrides it.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const caption = makeElement("div", { track, text: "Tìm theo" });
        const combo = makeElement("div", { track, attrs: { role: "combobox", "aria-label": "Default" } });
        attach(combo, makeElement("div", { text: "Thông báo mời thầu" }));
        attach(group, caption);
        attach(group, combo);
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "Default",
    `an existing accessible name, however authored, is reported unchanged (got ${record && JSON.stringify(record.label)})`);
}

console.log("== every previously-accepted caption sibling form still resolves the same way ==");
{
  const legendWorld = bootWorld({
    elements: [
      (track) => {
        const fieldset = makeElement("fieldset", {});
        attach(fieldset, makeElement("legend", { track, text: "Loại thông báo" }));
        const row = makeElement("div", { track });
        attach(row, makeElement("select", { track, attrs: { id: "kind" } }));
        attach(fieldset, row);
        return fieldset;
      }
    ]
  });
  const legendRecord = legendWorld.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.tag === "select");
  ok(legendRecord && legendRecord.label === "Loại thông báo",
    `a <legend> sibling still names the control (got ${legendRecord && JSON.stringify(legendRecord.label)})`);
}
{
  const thWorld = bootWorld({
    elements: [
      (track) => {
        const tr = makeElement("tr", {});
        attach(tr, makeElement("th", { track, text: "Trạng thái" }));
        const td = makeElement("td", { track });
        attach(td, makeElement("select", { track, attrs: { id: "status" } }));
        attach(tr, td);
        return tr;
      }
    ]
  });
  const thRecord = thWorld.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.tag === "select");
  ok(thRecord && thRecord.label === "Trạng thái",
    `a <th> sibling still names the control (got ${thRecord && JSON.stringify(thRecord.label)})`);
}
{
  const classWorld = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        attach(group, makeElement("div", { track, attrs: { class: "control-label" }, text: "Ngày đăng" }));
        const row = makeElement("div", { track });
        attach(row, makeElement("select", { track, attrs: { id: "date" } }));
        attach(group, row);
        return group;
      }
    ]
  });
  const classRecord = classWorld.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.tag === "select");
  ok(classRecord && classRecord.label === "Ngày đăng",
    `a label-ish class sibling still names the control (got ${classRecord && JSON.stringify(classRecord.label)})`);
}

console.log("== surrounding prose does not become a name ==");
{
  // "Holding": the container's own displayed value is long, unrelated prose
  // — the existing 200-char own-text bound still applies, so nothing is
  // invented from it, and the name stays empty exactly as before.
  const longValue = "Đoạn mô tả dài không phải tên điều khiển, chỉ là nội dung hiển thị bên trong widget này, viết đủ dài để vượt quá hai trăm ký tự của giới hạn văn bản trực tiếp hiện có trong getAccessibleName, để phép thử này chắc chắn không đặt tên từ nó, dù nó là nội dung duy nhất bên trong.";
  ok(longValue.length >= 200, "sanity: the fixture text exceeds the own-text bound");
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const combo = makeElement("div", { track, attrs: { role: "combobox" } });
        attach(combo, makeElement("div", { text: longValue }));
        attach(group, combo);
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "", `a long displayed value is never invented as a name (got ${record && JSON.stringify(record.label)})`);
}
{
  // "Sitting beside": a preceding sibling carrying long, unrelated prose is
  // still rejected by the existing 80-char caption bound, even though it
  // otherwise has the shape of a caption (no interactive descendant, no
  // element children of its own, positioned before the control).
  const longProse = "Đoạn văn bản dài không phải nhãn của ô nào cả, chỉ là nội dung trang bình thường viết dài hơn tám mươi ký tự để chắc chắn bị từ chối.";
  ok(longProse.length > 80, "sanity: the fixture text exceeds the caption length bound");
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        attach(group, makeElement("div", { track, text: longProse }));
        const combo = makeElement("div", { track, attrs: { role: "combobox" } });
        attach(group, combo);
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "",
    `long unrelated text beside the control is never invented as a caption (got ${record && JSON.stringify(record.label)})`);
}
{
  // The position half of the shape rule, isolated: a short, text-only,
  // otherwise caption-shaped sibling that sits AFTER the control instead of
  // before it must not be accepted — a caption describes what follows it,
  // not what came before. The combobox's own displayed value is what should
  // stand in instead, proving the sibling was genuinely rejected rather than
  // never reached.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const combo = makeElement("div", { track, attrs: { role: "combobox" } });
        attach(combo, makeElement("div", { text: "Thông báo mời thầu" }));
        attach(group, combo);
        attach(group, makeElement("div", { track, text: "Tìm theo" }));
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "Thông báo mời thầu",
    `a caption-shaped sibling AFTER the control is not accepted as its caption (got ${record && JSON.stringify(record.label)})`);
}
{
  // The text-only half of the shape rule, isolated: a sibling before the
  // control that is short and holds no interactive descendant, but is NOT
  // text through and through — its text lives inside an element child of its
  // own (a <span> wrapper) — must not be accepted either. Again the
  // combobox's own displayed value is what should stand in, proving the
  // wrapped sibling was rejected rather than accidentally matched by the
  // pre-existing tag/class rule.
  const world = bootWorld({
    elements: [
      (track) => {
        const group = makeElement("div", {});
        const wrapped = makeElement("div", { track });
        attach(wrapped, makeElement("span", { track, text: "Tìm theo" }));
        const combo = makeElement("div", { track, attrs: { role: "combobox" } });
        attach(combo, makeElement("div", { text: "Thông báo mời thầu" }));
        attach(group, wrapped);
        attach(group, combo);
        return group;
      }
    ]
  });
  const record = world.send({ type: "pageSnapshot" }).reply.result.elements.find((e) => e.role === "combobox");
  ok(record && record.label === "Thông báo mời thầu",
    `a caption-shaped sibling that is not text-only (its text sits inside a child element) is not accepted (got ${record && JSON.stringify(record.label)})`);
}

console.log("== the reported page's exact nested shape resolves ==");
{
  // The reported live shape: a div[tabindex=0] wrapping a div[role=combobox],
  // both unnamed, both showing the same descendant text — the shape that
  // reached the model as two indistinguishable "" rows and stalled the run
  // (repeated_no_change x5, then blocked / no_progress).
  const world = bootWorld({
    elements: [
      (track) => {
        const outer = makeElement("div", { track, tabIndex: 0 });
        const inner = makeElement("div", { track, attrs: { role: "combobox" } });
        const rendered = makeElement("div", {});
        attach(rendered, makeElement("div", { text: "Thông báo mời thầu" }));
        attach(inner, rendered);
        attach(outer, inner);
        return outer;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === 2, `both nested controls are listed (got ${snap.elements.length})`);
  ok(snap.elements.every((e) => e.label === "Thông báo mời thầu"),
    `both are named by the value they display, so they can be told apart from other unnamed rows (got ${JSON.stringify(snap.elements.map((e) => e.label))})`);
}

// --- 2d. Viewport-first ordering -------------------------------------------
console.log("== an on-screen control outranks earlier off-screen links ==");
{
  // The live shape this exists for: a homepage with hundreds of nav/footer
  // links whose advanced-search form was never offered because a DOM-ordered
  // table filled its 250 slots first — and scrolling could not change that.
  const builders = [];
  for (let i = 0; i < 260; i++) {
    builders.push((track) => makeElement("a", { track, text: `Liên kết ${i}`, rect: { x: 0, y: 5000, width: 60, height: 18 } }));
  }
  builders.push((track) => makeElement("input", { track, type: "text", attrs: { "aria-label": "Nơi thực hiện" }, rect: { x: 10, y: 300, width: 120, height: 24 } }));
  const world = bootWorld({ elements: builders });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements[0].label === "Nơi thực hiện", `the on-screen field leads the table (got ${snap.elements[0].label})`);
  ok(snap.elements.length === 250, `the bound still caps the table (${snap.elements.length})`);
  ok(snap.truncated.elements === true && snap.truncated.omitted === 11, `the dropped 11 are disclosed (${JSON.stringify(snap.truncated)})`);
}

// --- 3. The contract's own fields -----------------------------------------
console.log("== contract fields ==");
{
  const world = bootWorld({
    bodyText: "Nội dung trang",
    url: "https://shop.example.com/checkout",
    title: "Thanh toán",
    viewport: { w: 1280, h: 720 },
    scrollY: 340,
    scrollHeight: 5120,
    elements: [(track) => makeElement("button", { text: "Gửi", track })]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.v === 1, "v is 1");
  ok(snap.url === "https://shop.example.com/checkout", "url is the live document URL");
  ok(snap.title === "Thanh toán", "title is the document title");
  ok(snap.viewport.w === 1280 && snap.viewport.h === 720, "viewport carries w/h");
  ok(snap.scroll.y === 340 && snap.scroll.height === 5120, "scroll carries y/height");
  ok(typeof snap.text === "string" && snap.text.includes("Nội dung trang"), "text carries the page's text");
  ok(snap.truncated && snap.truncated.elements === false && snap.truncated.text === false && snap.truncated.omitted === 0,
    "nothing was truncated, and the disclosure says so with a zero omission count");

  const row = snap.elements[0];
  const EXPECTED = ["ref", "role", "label", "tag", "type", "value", "editable", "readonly",
    "contenteditable", "disabled", "checked", "selected", "expanded", "sensitive"];
  for (const field of EXPECTED) ok(field in row, `element carries ${field}`);
  ok(!("options" in row), "a non-select carries no options key");
  ok(/^ref_\d+$/.test(row.ref), `ref is a ref_N handle (${row.ref})`);
  ok(row.role === "button" && row.tag === "button", "role comes from the ARIA mapping and tag from the element");
  ok(row.disabled === false && row.checked === false && row.selected === false && row.expanded === false,
    "the state booleans are present for a control none of them apply to");
}

// --- 4. Refs are the same ref space the other tools resolve ---------------
console.log("== refs ==");
{
  const world = bootWorld({ elements: [(track) => makeElement("button", { text: "Một", track })] });
  const first = world.send({ type: "pageSnapshot" }).reply.result.elements[0].ref;
  const second = world.send({ type: "pageSnapshot" }).reply.result.elements[0].ref;
  ok(first === second, `the same element keeps its handle across observations (${first})`);
  // The proof that a snapshot ref is resolvable by the existing tools: the
  // shipped resolver, reading the same elementMap the snapshot minted into.
  const resolved = world.win.__unblockedChrome.resolveRef(first);
  ok(resolved && resolved.tagName === "BUTTON" && resolved.textContent === "Một",
    "resolveRef — the path computer/form_input resolve through — hands back the very element");
}

// --- 5. Values, masks, and editable flags --------------------------------
console.log("== values, masking, editable flags ==");
{
  const world = bootWorld({
    elements: [
      (track) => makeElement("textarea", { track, attrs: { "aria-label": "Ghi chú" }, value: "giao buổi chiều" }),
      (track) => makeElement("input", { track, type: "text", readOnly: true, attrs: { "aria-label": "Mã đơn" }, value: "DH-1" }),
      (track) => makeElement("input", { track, type: "checkbox", checked: true, attrs: { "aria-label": "Đồng ý" } }),
      (track) => makeElement("div", { track, contentEditable: "true", attrs: { "aria-label": "Soạn thảo" } }),
      // Masked by its own attribute — what masking itself sets, and what
      // generateAccessibilityTree checks before printing a value.
      (track) => makeElement("input", {
        track, type: "text", value: "4111-1111-1111-1111",
        attrs: { "aria-label": "Số thẻ", [MASK_ATTR]: "payment" }
      }),
      // Masked by its container: masking a container reaches the controls
      // inside it, and the value must not leak through this table either.
      (track) => {
        const container = makeElement("div", { attrs: { [MASK_ATTR]: "explicit" } });
        attach(container, makeElement("input", { track, type: "text", value: "737", attrs: { "aria-label": "CVV" } }));
        return container;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const byLabel = Object.fromEntries(snap.elements.map((r) => [r.label, r]));

  ok(byLabel["Ghi chú"].value === "giao buổi chiều" && byLabel["Ghi chú"].editable === true,
    "a textarea reports its value and is editable");
  ok(byLabel["Mã đơn"].readonly === true && byLabel["Mã đơn"].editable === false,
    "a readonly input reports readonly and is not editable");
  ok(byLabel["Đồng ý"].checked === true && byLabel["Đồng ý"].editable === false,
    "a checked checkbox reports its state and is not a text field");
  ok(byLabel["Soạn thảo"].contenteditable === true && byLabel["Soạn thảo"].editable === true,
    "a contenteditable element reports both flags");

  ok(byLabel["Số thẻ"].value === MASK_PLACEHOLDER, `a masked control reports the placeholder (${byLabel["Số thẻ"].value})`);
  ok(!JSON.stringify(snap.elements).includes("4111-1111-1111-1111"), "the masked card number appears nowhere in the table");
  ok(byLabel["CVV"].value === MASK_PLACEHOLDER, "a control inside a masked container is masked too");
  ok(!JSON.stringify(snap.elements).includes("737"), "the masked container's inner value never leaks");
  ok(world.mutations.length === 0, `reading values wrote nothing back (${JSON.stringify(world.mutations)})`);
}

// --- 5b. The sensitive-field category (openspec/changes/jev-literal-field-values) --
console.log("== the sensitive-field category, reusing the masking classifier ==");
{
  // The category rides the SAME descriptor construction the masking scan
  // itself uses (content.js's maskDescriptorForControl), never a second copy
  // of maskCategoryForDescriptor's rules — a type/autocomplete match needs no
  // name evidence at all.
  const world = bootWorld({
    elements: [
      (track) => makeElement("input", { track, type: "password", attrs: { "aria-label": "Mật khẩu" } }),
      (track) => makeElement("input", { track, type: "text", attrs: { "aria-label": "Mật khẩu hiện tại", autocomplete: "current-password" } }),
      (track) => makeElement("input", { track, type: "text", attrs: { "aria-label": "Tên công ty" }, value: "Alice, Inc." })
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const byLabel = Object.fromEntries(snap.elements.map((r) => [r.label, r]));
  ok(byLabel["Mật khẩu"].sensitive === "password", `a password-type input is classified (got ${JSON.stringify(byLabel["Mật khẩu"].sensitive)})`);
  ok(byLabel["Mật khẩu hiện tại"].sensitive === "password", `autocomplete=current-password is classified (got ${JSON.stringify(byLabel["Mật khẩu hiện tại"].sensitive)})`);
  ok(byLabel["Tên công ty"].sensitive === null, `an ordinary input carries no category (got ${JSON.stringify(byLabel["Tên công ty"].sensitive)})`);
  // Every other row field stays exactly as section 5 already proves — this
  // only checks that adding `sensitive` did not disturb them for the same rows.
  ok(byLabel["Mật khẩu"].editable === true && byLabel["Mật khẩu"].tag === "input" && byLabel["Mật khẩu"].type === "password",
    "existing row fields are unchanged alongside the new sensitive field");
  ok(byLabel["Tên công ty"].value === "Alice, Inc.", "an unclassified field still reports its real value (never masked by this field alone)");
  ok(world.mutations.length === 0, "classifying rows for the sensitive field changed nothing on the page");
}
{
  // A non-input/textarea control (e.g. a native select) never runs the
  // classifier at all — the descriptor is only meaningful for text entry
  // controls, matching the masking scan's own "input, textarea" scope.
  const world = bootWorld({
    elements: [(track) => makeElement("select", { track, attrs: { "aria-label": "Quốc gia", id: "ssn" }, options: [{ textContent: "VN", value: "vn", selected: true }] })]
  });
  const row = world.send({ type: "pageSnapshot" }).reply.result.elements[0];
  ok(row.sensitive === null, `a non-text control never carries a sensitive category (got ${JSON.stringify(row.sensitive)})`);
}

// --- 6. Native select options -------------------------------------------
console.log("== select options ==");
{
  const world = bootWorld({
    elements: [
      (track) => makeElement("select", {
        track,
        attrs: { "aria-label": "Tỉnh" },
        options: [
          { textContent: "Hà Nội", value: "HN", selected: true },
          { textContent: "Đà Nẵng", value: "DN", selected: false }
        ]
      })
    ]
  });
  const row = world.send({ type: "pageSnapshot" }).reply.result.elements[0];
  ok(row.role === "combobox" && row.tag === "select", "a native select reports the combobox role");
  ok(Array.isArray(row.options) && row.options.length === 2, "its options are listed");
  ok(row.options[0].label === "Hà Nội" && row.options[0].value === "HN" && row.options[0].selected === true,
    "the selected option carries label, value, and selected");
  ok(row.options[1].selected === false && row.options[1].label === "Đà Nẵng", "the unselected option says so");
  ok(row.value === "HN", "the select's own value is the chosen option's value");
  ok(row.selected === true, "a select with a chosen value reports selected");
  ok(row.editable === false, "a select is not a text field");
}

// --- 7. Bounds and their disclosure -------------------------------------
console.log("== bounds ==");
{
  // The shipping bound itself (fix-snapshot-text-and-jev-guards design 2):
  // every assertion below reads the constant, so without this pin the
  // constant could drift to any number and the suite would still agree.
  ok(MAX_TEXT === 10000, `the snapshot text bound is the shipping 10,000 (got ${MAX_TEXT})`);
  const many = [];
  for (let i = 0; i < MAX_ELEMENTS + 7; i++) {
    many.push((track) => makeElement("button", { text: `Nút ${i}`, track }));
  }
  const world = bootWorld({ elements: many, bodyText: "x".repeat(MAX_TEXT + 1234) });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;

  ok(snap.elements.length === MAX_ELEMENTS, `the element table is capped at ${MAX_ELEMENTS} (got ${snap.elements.length})`);
  ok(snap.truncated.elements === true, "the element table reports it was cut");
  ok(snap.truncated.omitted === 7, `the omission count is the number of dropped controls (got ${snap.truncated.omitted})`);
  ok(snap.text.length === MAX_TEXT, `the text is cut to ${MAX_TEXT} chars (got ${snap.text.length})`);
  ok(snap.truncated.text === true, "the text reports it was cut");
  ok(!JSON.stringify(snap.elements).includes(`Nút ${MAX_ELEMENTS + 6}`), "a dropped control is genuinely absent from the table");
  ok(world.mutations.length === 0, "a truncated read still changed nothing");
}
{
  // The other side of the same flag: text within the bound must NOT claim
  // truncation, or "truncated" would be a constant and worth nothing.
  const world = bootWorld({ bodyText: "ngắn gọn", elements: [] });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.text === "ngắn gọn" && snap.truncated.text === false, "an in-bounds text is reported whole and untruncated");
  ok(snap.truncated.elements === false && snap.truncated.omitted === 0, "and nothing else claims truncation");
}
{
  // getPageText's own ceiling is a second, independent reason to say the text
  // was cut: the snapshot must not present its own share as the whole story.
  const world = bootWorld({ bodyText: "y".repeat(30001), elements: [] });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.text.length === MAX_TEXT && snap.truncated.text === true,
    "the extraction's own truncation is disclosed even after the snapshot's own cut");
}
{
  const longLabel = "L".repeat(MAX_LABEL + 40);
  const longValue = "V".repeat(MAX_VALUE + 40);
  const world = bootWorld({
    elements: [(track) => makeElement("input", { track, type: "text", attrs: { "aria-label": longLabel }, value: longValue })]
  });
  const row = world.send({ type: "pageSnapshot" }).reply.result.elements[0];
  ok(row.label.length === MAX_LABEL, `a label is clipped to ${MAX_LABEL} chars (got ${row.label.length})`);
  ok(row.value.length === MAX_VALUE, `a value is clipped to ${MAX_VALUE} chars (got ${row.value.length})`);
}
{
  // A select whose option list exceeds its own bound: cut options are
  // candidates nobody can ever choose, so they are disclosed as omissions.
  const options = [];
  for (let i = 0; i < MAX_OPTIONS + 5; i++) options.push({ textContent: `Tỉnh ${i}`, value: `P${i}`, selected: i === 0 });
  const world = bootWorld({
    elements: [(track) => makeElement("select", { track, attrs: { "aria-label": "Tỉnh" }, options })]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements[0].options.length === MAX_OPTIONS, `options are capped at ${MAX_OPTIONS}`);
  ok(snap.truncated.elements === true && snap.truncated.omitted === 5,
    `cut options are counted as omissions (got ${snap.truncated.omitted})`);
}

// --- 8. Shadow roots and the extension's own overlay ---------------------
console.log("== shadow roots and the extension's own UI ==");
{
  const world = bootWorld({
    elements: [(track) => {
      const inner = makeElement("button", { text: "Trong shadow", track });
      return makeElement("div", { shadowRoot: { children: [inner], querySelectorAll: () => [inner] } });
    }]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.some((e) => e.label === "Trong shadow"), "a control inside an open shadow root is listed");
}
{
  const world = bootWorld({
    elements: [(track) => makeElement("button", { text: "Stop", track, attrs: { "data-browzy-overlay": "1" } })]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(!snap.elements.some((e) => e.label === "Stop"), "the extension's overlay controls are never page content");
}
{
  const world = bootWorld({
    elements: [
      (track) => {
        const layer = makeElement("div", { id: "browzy-annotation-layer" });
        attach(layer, makeElement("button", { text: "ref_1", track }));
        return layer;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(!snap.elements.some((e) => e.label === "ref_1"), "an annotation label is never reported as a page control");
}

// --- 9. The page text is RENDERED text -----------------------------------
console.log("== rendered page text ==");
{
  // The live failure shape (dauthau.asia, fix-snapshot-text-and-jev-guards):
  // ~18,000 characters of non-rendered chrome ahead of the content. The old
  // clone-and-textContent read counted every one of them and pushed
  // "Chủ đầu tư" past the bound; the rendered read starts at the content.
  const HIDDEN_CHROME = "TRANG CHỦ GIỚI THIỆU LIÊN HỆ ĐĂNG NHẬP ".repeat(400);
  const world = bootWorld({
    elements: [
      (track) => {
        const menu = makeElement("main", { attrs: { class: "navbar" }, style: { display: "none" } });
        attach(menu, makeElement("div", { track, text: HIDDEN_CHROME }));
        return menu;
      },
      (track) => makeElement("div", { track, text: "Chủ đầu tư: Ban Quản lý dự án Hải Phòng." }),
      (track) => makeElement("div", { track, text: "Danh sách hàng hóa: thiết bị cho tàu thủy." })
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(!snap.text.includes("TRANG CHỦ"), "non-rendered chrome contributes nothing to the page text");
  ok(snap.text.startsWith("Chủ đầu tư") && snap.text.includes("Danh sách hàng hóa"),
    `the content is present, from the start and past the old bound (got "${snap.text.slice(0, 60)}…")`);
  ok(snap.text.length < MAX_TEXT && snap.truncated.text === false,
    `the rendered text fits the bound whole (${snap.text.length} < ${MAX_TEXT})`);
  ok(world.mutations.length === 0, `the live walk changed nothing (${JSON.stringify(world.mutations)})`);
}
{
  // Every non-rendered state the design names, through BOTH visibility seams
  // (Element.checkVisibility, and the computed-style fallback) — including a
  // hidden ANCESTOR, which must take its whole subtree with it. The inline
  // display:none the fallback checks first is the same state as the
  // display:none case here; a browser computes it identically.
  const cases = [
    ["display:none", { style: { display: "none" } }],
    ["visibility:hidden", { style: { visibility: "hidden" } }],
    ["the hidden attribute", { attrs: { hidden: "" } }],
    ["a hidden ancestor", { style: { display: "none" }, ancestor: true }]
  ];
  for (const seam of ["checkVisibility", "computed"]) {
    for (const [label, shape] of cases) {
      const world = bootWorld({
        visibility: seam,
        elements: [
          (track) => {
            const hiddenOpts = Object.assign({}, shape);
            delete hiddenOpts.ancestor;
            const hidden = makeElement("div", hiddenOpts);
            if (shape.ancestor) {
              const wrapper = makeElement("div", hiddenOpts);
              attach(wrapper, hidden);
              attach(hidden, makeElement("div", { track, text: "CHROME-ẨN" }));
              return wrapper;
            }
            attach(hidden, makeElement("div", { track, text: "CHROME-ẨN" }));
            return hidden;
          },
          (track) => makeElement("div", { track, text: "Nội dung thật" })
        ]
      });
      const snap = world.send({ type: "pageSnapshot" }).reply.result;
      ok(!snap.text.includes("CHROME-ẨN") && snap.text.includes("Nội dung thật"),
        `[${seam}] ${label}: hidden text is excluded, visible text is kept (got "${snap.text}")`);
    }
  }
  // States whose only observable is the browser's own answer, with a
  // computed display that is NOT `contents`: a closed `<details>` body (the
  // live shape — the summary renders, the body does not). The
  // false-from-contents exception must not become a general amnesty, so it
  // prunes — the exact failure class an over-permissive rewrite reintroduced
  // (closed-details chrome crowding the content out of the bound). The
  // computed fallback cannot see this state; asking the seam first is what
  // covers it.
  {
    const world = bootWorld({
      elements: [
        (track) => {
          const details = makeElement("details", {});
          attach(details, makeElement("summary", { track, text: "Chi tiết" }));
          const body = makeElement("div", { invisible: true });
          attach(body, makeElement("div", { track, text: "CHROME-ẨN" }));
          attach(details, body);
          return details;
        },
        (track) => makeElement("div", { track, text: "Nội dung thật" })
      ]
    });
    const snap = world.send({ type: "pageSnapshot" }).reply.result;
    ok(!snap.text.includes("CHROME-ẨN") && snap.text.includes("Nội dung thật") && snap.text.includes("Chi tiết"),
      `[checkVisibility] a closed <details> body is excluded while its summary stays (got "${snap.text}")`);
  }
  // `content-visibility: hidden` keeps the element's box while skipping its
  // contents, and Chromium's checkVisibility answers true for it (measured
  // live) — so the computed property is what must exclude the subtree, in
  // both seams.
  for (const seam of ["checkVisibility", "computed"]) {
    const world = bootWorld({
      visibility: seam,
      elements: [
        (track) => {
          const panel = makeElement("div", { style: { contentVisibility: "hidden" } });
          attach(panel, makeElement("div", { track, text: "CHROME-ẨN" }));
          return panel;
        },
        (track) => makeElement("div", { track, text: "Nội dung thật" })
      ]
    });
    const snap = world.send({ type: "pageSnapshot" }).reply.result;
    ok(!snap.text.includes("CHROME-ẨN") && snap.text.includes("Nội dung thật"),
      `[${seam}] content-visibility:hidden: hidden text is excluded, visible text is kept (got "${snap.text}")`);
  }
}
{
  // `display: contents` has no box of its own — Chromium's checkVisibility
  // answers false — while its children and text nodes still render in the
  // parent's formatting. A walk that pruned on that false would silently drop
  // rendered content, so the wrapper must be walked through; the same
  // wrapper under visibility:hidden must still take its subtree with it.
  // Both seams: the checkVisibility answer and the fallback rules.
  for (const seam of ["checkVisibility", "computed"]) {
    const shown = bootWorld({
      visibility: seam,
      elements: [
        (track) => {
          const wrapper = makeElement("div", { style: { display: "contents" } });
          attach(wrapper, makeElement("div", { track, text: "MARKER-NỘI-DUNG" }));
          return wrapper;
        },
        (track) => makeElement("div", { track, text: "Nội dung thật" })
      ]
    });
    const shownSnap = shown.send({ type: "pageSnapshot" }).reply.result;
    ok(shownSnap.text.includes("MARKER-NỘI-DUNG") && shownSnap.text.includes("Nội dung thật"),
      `[${seam}] a display:contents wrapper's rendered subtree is kept (got "${shownSnap.text}")`);

    const hidden = bootWorld({
      visibility: seam,
      elements: [
        (track) => {
          const wrapper = makeElement("div", { style: { display: "contents", visibility: "hidden" } });
          attach(wrapper, makeElement("div", { track, text: "MARKER-ẨN" }));
          return wrapper;
        },
        (track) => makeElement("div", { track, text: "Nội dung thật" })
      ]
    });
    const hiddenSnap = hidden.send({ type: "pageSnapshot" }).reply.result;
    ok(!hiddenSnap.text.includes("MARKER-ẨN") && hiddenSnap.text.includes("Nội dung thật"),
      `[${seam}] visibility:hidden still excludes a display:contents subtree (got "${hiddenSnap.text}")`);
  }
}
{
  // Container selection is unchanged, now measured on the RENDERED text: the
  // richest container still wins over the body, and hidden chrome outside it
  // cannot make it look like an implausibly small share of the page.
  const world = bootWorld({
    elements: [
      (track) => makeElement("div", { track, text: "ĐIỀU HƯỚNG" }),
      (track) => {
        const hidden = makeElement("div", { style: { display: "none" } });
        attach(hidden, makeElement("div", { track, text: "CHROME-ẨN".repeat(200) }));
        return hidden;
      },
      (track) => {
        const article = makeElement("article", {});
        attach(article, makeElement("div", { track, text: "NỘI DUNG GÓI THẦU ".repeat(60) }));
        return article;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.text.startsWith("NỘI DUNG GÓI THẦU"),
    `the richest container is selected, not the body (got "${snap.text.slice(0, 40)}…")`);
  ok(!snap.text.includes("ĐIỀU HƯỚNG"), "the body's own text is not part of the container's text");
}
{
  // The masked-textarea rule: the placeholder is contributed, and the value
  // is neither read nor leaked (the fixture's `value` getter logs reads).
  const valueReads = [];
  const world = bootWorld({
    elements: [(track) => makeElement("textarea", {
      track, reads: valueReads, text: "OTP-918273", value: "OTP-918273",
      attrs: { "aria-label": "Ghi chú", [MASK_ATTR]: "explicit" }
    })]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.text.includes(MASK_PLACEHOLDER), `a masked textarea contributes the placeholder (got "${snap.text}")`);
  ok(!JSON.stringify(snap).includes("OTP-918273"), "the masked textarea's value never reaches the result");
  ok(!valueReads.includes("value"), `the value property was never read (${JSON.stringify(valueReads)})`);
  ok(world.mutations.length === 0, "reading the masked textarea wrote nothing to the page");
}

// --- 10. The pointer-affordance pass (tasks.md 1.1) ------------------------
console.log("== pointer-affordance pass: delegated-listener controls become observable ==");
{
  // The design's own example: a suggestion row is a wrapper with the
  // delegated listener and a leaf carrying the visible text. In a real
  // browser `cursor` is inherited, so a single declaration on the wrapper
  // reaches the leaf too — this stand-in's computed-style seam is per-node
  // (it does not model the cascade), so both levels are styled directly
  // here to stand in for that inheritance; either way, only the innermost
  // of the two must be listed.
  const world = bootWorld({
    elements: [
      (track) => {
        const row = makeElement("div", { attrs: { class: "cityline" }, style: { cursor: "pointer" } });
        attach(row, makeElement("span", { track, text: "Hà Nội", style: { cursor: "pointer" } }));
        return row;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === 1, `a delegated-listener row is listed exactly once (got ${snap.elements.length})`);
  ok(snap.elements[0].label === "Hà Nội" && snap.elements[0].tag === "span",
    `the innermost element is what is listed (got ${JSON.stringify(snap.elements[0])})`);
  ok(/^ref_\d+$/.test(snap.elements[0].ref), "it carries a resolvable ref like any other listed control");
  ok(world.mutations.length === 0, "listing it changed nothing on the page");
}
{
  // Several pointer-affording ancestors deliberately stacked around one
  // target (a component library redeclaring cursor:pointer at more than one
  // level) — still only the innermost is listed.
  const world = bootWorld({
    elements: [
      (track) => {
        const outer = makeElement("li", { style: { cursor: "pointer" } });
        const inner = makeElement("div", { style: { cursor: "pointer" } });
        attach(outer, inner);
        attach(inner, makeElement("span", { track, text: "Tùy chọn A", style: { cursor: "pointer" } }));
        return outer;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === 1 && snap.elements[0].label === "Tùy chọn A",
    `nested pointer-affording ancestors collapse to the one innermost target (got ${JSON.stringify(snap.elements.map((e) => e.label))})`);
}
{
  // A wrapper around a control the table already lists is not a substitute
  // for it: the native <button> is listed, the div around it is not.
  const world = bootWorld({
    elements: [
      (track) => {
        const wrapper = makeElement("div", { style: { cursor: "pointer" } });
        attach(wrapper, makeElement("button", { text: "Xác nhận", track }));
        return wrapper;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === 1 && snap.elements[0].label === "Xác nhận" && snap.elements[0].tag === "button",
    `the wrapper around an already-listed native control is not listed in its place (got ${JSON.stringify(snap.elements.map((e) => ({ label: e.label, tag: e.tag })))})`);
}
{
  // The nested-control rule holds even when the nested control itself never
  // reaches the table (here: disabled) — the wrapper is still not a
  // substitute target for it.
  const world = bootWorld({
    elements: [
      (track) => {
        const wrapper = makeElement("div", { style: { cursor: "pointer" } });
        attach(wrapper, makeElement("input", { track, type: "text", disabled: true }));
        return wrapper;
      }
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === 0,
    `a wrapper around a nested native control is excluded even when that control is itself excluded (got ${snap.elements.length})`);
}
{
  // The pass' own hard cap, independent of SNAPSHOT_MAX_ELEMENTS: each row
  // here is a sibling (no nesting), so nothing is dropped by the innermost
  // rule — only the pointer pass's own bound can be responsible for what is
  // missing, and it must be disclosed exactly like every other bound.
  const many = [];
  for (let i = 0; i < MAX_POINTER + 5; i++) {
    many.push((track) => makeElement("div", { track, text: `Dòng ${i}`, style: { cursor: "pointer" } }));
  }
  const world = bootWorld({ elements: many });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === MAX_POINTER, `the pointer pass is capped at its own bound (got ${snap.elements.length})`);
  ok(snap.truncated.elements === true && snap.truncated.omitted === 5,
    `what the pointer pass's own cap drops is disclosed like any other omission (got ${JSON.stringify(snap.truncated)})`);
}
{
  // Scenario "The pointer pass does not duplicate or inflate": a page with
  // no pointer-affording element produces the exact table the native scan
  // alone would already produce.
  const world = bootWorld({
    elements: [
      (track) => makeElement("button", { text: "Gửi", track }),
      (track) => makeElement("input", { track, type: "text", attrs: { "aria-label": "Tên" } }),
      (track) => makeElement("div", { track, text: "văn bản tĩnh, không có con trỏ" }),
      (track) => makeElement("p", { track, text: "đoạn văn thường" })
    ]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements.length === 2,
    `a page with no pointer-affording element lists only its native controls (got ${snap.elements.length})`);
  ok(snap.truncated.elements === false && snap.truncated.omitted === 0, "and nothing is disclosed as dropped");
}

// --- 11. The newly-appeared marking (tasks.md 1.4) --------------------------
console.log("== the snapshot marks what just appeared since the previous read ==");
{
  const world = bootWorld({
    elements: [(track) => makeElement("button", { text: "Nút cũ", track })]
  });
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  ok(snap.elements[0].isNew === false,
    "the first read of a document marks nothing new — the same rule find()/generateAccessibilityTree already follow");
}
{
  const world = bootWorld({
    elements: [(track) => makeElement("button", { text: "Nút cũ", track })]
  });
  world.send({ type: "pageSnapshot" }); // establishes the watermark for this document
  attach(world.doc.body, makeElement("button", { text: "Nút mới" }));
  const snap = world.send({ type: "pageSnapshot" }).reply.result;
  const byLabel = Object.fromEntries(snap.elements.map((e) => [e.label, e]));
  ok(byLabel["Nút cũ"].isNew === false, "a control present at the previous read is not marked new");
  ok(byLabel["Nút mới"].isNew === true, "a control that appeared since the previous read is marked new");
}
{
  // The document-identity reset: a route change resets the shared watermark
  // (bumpDocumentEpoch, ~content.js line 103), so the first snapshot taken
  // after it marks nothing new either — exercised through content.js's own
  // history.pushState wrapper, exactly as a real SPA route change would
  // trigger it.
  const world = bootWorld({
    elements: [(track) => makeElement("button", { text: "Nút cũ", track })]
  });
  world.send({ type: "pageSnapshot" });
  attach(world.doc.body, makeElement("button", { text: "Nút mới" }));
  const beforeReset = world.send({ type: "pageSnapshot" }).reply.result;
  ok(beforeReset.elements.find((e) => e.label === "Nút mới")?.isNew === true,
    "sanity check: the new control is marked before the reset");

  world.history.pushState(null, "", "https://example.com/orders?page=2");
  const afterReset = world.send({ type: "pageSnapshot" }).reply.result;
  ok(afterReset.elements.length === 2 && afterReset.elements.every((e) => e.isNew === false),
    `the first read after a document-identity reset marks nothing new (${JSON.stringify(afterReset.elements.map((e) => e.isNew))})`);
}

{
  const world = bootWorld({ docNonce: "document-a" });
  const first = world.send({ type: "pageSnapshot" }).reply.result;
  const identity = world.send({ type: "getDocumentIdentity" }).reply.result;
  ok(first.docNonce === identity.docNonce, "snapshot shares the document handshake nonce");
  ok(world.send({ type: "pageSnapshot" }).reply.result.docNonce === first.docNonce, "same-document reads preserve nonce");
  world.history.pushState(null, "", "https://example.com/next");
  ok(world.send({ type: "pageSnapshot" }).reply.result.docNonce === first.docNonce, "SPA navigation preserves document nonce");
  const replacement = bootWorld({ docNonce: "document-b", url: world.location.href });
  ok(replacement.send({ type: "pageSnapshot" }).reply.result.docNonce !== first.docNonce, "replacement document at same URL has a different nonce");
}

{
  const longUrl = "https://dauthau.asia/thong-bao-moi-thau/mua-sam-may-tinh-123456.html?q=" + "a".repeat(700) + "&word=m%C3%A1y%20t%C3%ADnh";
  const destinations = [longUrl, "https://example.com/" + "a".repeat(8192), "javascript:alert(1)", "mailto:a@example.com"];
  const world = bootWorld({ elements: destinations.map((href, index) => (track) => {
    const anchor = makeElement("a", { text: `Result ${index}`, attrs: { href }, track });
    anchor.href = href;
    return anchor;
  }) });
  const rows = world.send({ type: "pageSnapshot" }).reply.result.elements;
  ok(rows[0].href === longUrl, "snapshot preserves the complete observed link including long encoded query");
  ok(rows.slice(1).every((row) => !("href" in row)), "oversize and non-web destinations are omitted, never truncated into plausible links");
  ok(world.mutations.length === 0, "extracting links changes nothing on the page");
  const crowded = bootWorld({ elements: Array.from({ length: 20 }, (_, index) => () => {
    const anchor = makeElement("a", { text: `Long ${index}`, attrs: { href: "https://example.com/" } });
    anchor.href = `https://example.com/${index}?q=${"x".repeat(7000)}`;
    return anchor;
  }) }).send({ type: "pageSnapshot" }).reply.result;
  ok(crowded.elements.reduce((sum, row) => sum + (row.href?.length ?? 0), 0) <= numConst("SNAPSHOT_MAX_LINK_CHARS"), "snapshot caps aggregate link payload independently of control count");
  ok(crowded.truncated.links > 0 && crowded.elements.length === 20, "link omission is disclosed without removing actionable controls");
}

{
  const formWorld = (query, nonce = "form-doc", settings = {}) => bootWorld({ docNonce: nonce, elements: [(track) => {
    const form = makeElement("form", { attrs: { id: settings.formId || "search" } });
    form.action = settings.action || "https://example.com/search";
    form.method = settings.method || "get";
    const fields = [
      makeElement("input", { type: "text", value: query, attrs: { name: "q", "aria-label": "Query" }, track }),
      makeElement("input", { type: "hidden", value: "secret", invisible: true }),
      makeElement("input", { type: "text", value: "masked-secret", attrs: { name: "masked", [MASK_ATTR]: "secret" }, track }),
      makeElement("input", { type: "submit", value: "Search", attrs: { name: settings.submitter || "search" }, track }),
      makeElement("button", { type: "button", text: "Next page", track })
    ];
    Object.defineProperty(fields[1], "value", { get() { throw new Error("hidden value must not be read"); } });
    for (const field of fields) { field.form = form; attach(form, field); }
    return form;
  }] });
  const firstWorld = formWorld("máy tính", "first-doc");
  const first = firstWorld.send({ type: "pageSnapshot" }).reply.result;
  const next = formWorld("máy tính", "replacement-doc").send({ type: "pageSnapshot" }).reply.result;
  const changed = formWorld("máy in").send({ type: "pageSnapshot" }).reply.result;
  const submitOf = (snapshot) => snapshot.elements.find((row) => row.type === "submit").submit;
  ok(submitOf(first)?.scope === "observed_form_state" && submitOf(first)?.incomplete === true, "native submit gets a potential-repeat checkpoint hint, never a complete payload claim");
  ok(JSON.stringify(submitOf(first)) === JSON.stringify(submitOf(next)), "same observed form state has stable submission semantics across document replacement");
  const newBlock = formWorld("máy tính", "third-doc", { formId: "different-block" }).send({ type: "pageSnapshot" }).reply.result;
  ok(JSON.stringify(submitOf(first)) === JSON.stringify(submitOf(newBlock)), "form DOM block identifiers do not change semantic submission hint");
  ok(JSON.stringify(submitOf(first)) !== JSON.stringify(submitOf(changed)), "changed query produces distinct submission semantics");
  ok(submitOf(first)?.fields.length === 1 && !JSON.stringify(submitOf(first)).includes("secret"), "hidden and masked values never enter submission metadata");
  ok(!first.elements.find((row) => row.label === "Next page").submit, "ordinary non-submit buttons are never guessed to submit a form");
  ok(firstWorld.mutations.length === 0, "submission context collection remains read-only");
  for (const settings of [{ action: "https://example.com/other" }, { method: "post" }, { submitter: "next" }]) {
    const alternative = formWorld("máy tính", "first-doc", settings).send({ type: "pageSnapshot" }).reply.result;
    ok(JSON.stringify(submitOf(first)) !== JSON.stringify(submitOf(alternative)), `changed submission semantics produce a distinct hint (${JSON.stringify(settings)})`);
  }
}

console.log(fail === 0 ? "\nALL PAGE-SNAPSHOT CONTENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

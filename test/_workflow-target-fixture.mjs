// Synthetic DOM for the shipped content script's workflow target queries.
// No matching decisions are mocked: selectors, ancestors, shadow boundaries,
// labels, geometry, and hit tests are answered from the fixture tree. This is
// not a layout engine; boxes/styles model measured browser states explicitly.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./_extract.mjs";

const source = fs.readFileSync(path.join(ROOT, "extension/content.js"), "utf8");
const boot = new Function("window", "document", "chrome", "location", "history", "crypto", "CSS", "getComputedStyle", "Node", source);

function descendants(root) {
  return root.children.flatMap((node) => [node, ...descendants(node)]);
}

function matchOne(node, selector) {
  if (selector === "*") return true;
  if (selector === ":disabled") {
    return node.hasAttribute("disabled") || !!node.closest("fieldset[disabled]");
  }
  let rest = selector;
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    if (node.tagName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    const cls = /^\.([\w-]+)/.exec(rest);
    const id = /^#([\w-]+)/.exec(rest);
    const attr = /^\[([\w-]+)(?:=["']([^"']*)["'])?\]/.exec(rest);
    if (cls) {
      if (!node.className.split(/\s+/).includes(cls[1])) return false;
      rest = rest.slice(cls[0].length);
    } else if (id) {
      if (node.id !== id[1]) return false;
      rest = rest.slice(id[0].length);
    } else if (attr) {
      if (!node.hasAttribute(attr[1]) || (attr[2] !== undefined && node.getAttribute(attr[1]) !== attr[2])) return false;
      rest = rest.slice(attr[0].length);
    } else {
      throw new Error(`Unsupported fixture selector: ${selector}`);
    }
  }
  return true;
}

export function createTargetWorld() {
  const mutations = [];
  const queries = [];
  const doc = { children: [], nodeType: 9 };
  let listener;
  const win = { innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {} };
  const styleOf = (el) => ({ display: "block", visibility: "visible", opacity: "1", position: "static", pointerEvents: "auto", ...el.style });
  const rootOps = {
    querySelectorAll(selector) {
      queries.push(selector);
      return descendants(this).filter((el) => el.matches(selector));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    appendChild(el) {
      if (el.parentNode) el.parentNode.children.splice(el.parentNode.children.indexOf(el), 1);
      el.parentNode = this;
      this.children.push(el);
      return el;
    }
  };
  Object.assign(doc, rootOps);

  function element(tag, { text = "", attrs = {}, style = {}, rect = {} } = {}) {
    const el = {
      ...rootOps, nodeType: 1, tagName: tag.toUpperCase(), children: [], parentNode: null,
      attrs: { ...attrs }, style: { ...style }, rect: { x: 20, y: 20, width: 180, height: 30, ...rect }, _text: text,
      get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; },
      get isConnected() { const root = this.getRootNode(); return root === doc || !!root.host?.isConnected; },
      get id() { return this.attrs.id || ""; },
      get className() { return this.attrs.class || ""; },
      get type() { return this.attrs.type || ""; },
      get disabled() { return this.hasAttribute("disabled"); },
      get offsetParent() { return this.checkVisibility() ? doc.body : null; },
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); },
      set textContent(value) { mutations.push("textContent"); this._text = String(value); },
      getAttribute(name) { return this.attrs[name] ?? null; },
      hasAttribute(name) { return Object.hasOwn(this.attrs, name); },
      setAttribute(name, value) { mutations.push(`attribute:${name}`); this.attrs[name] = String(value); },
      getRootNode() { let root = this; while (root.parentNode) root = root.parentNode; return root; },
      matches(selector) { return selector.split(",").some((part) => matchOne(this, part.trim())); },
      closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; },
      contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; },
      getBoundingClientRect() {
        const r = this.rect;
        return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
      },
      checkVisibility() {
        for (let n = this; n; n = n.parentElement || n.getRootNode()?.host) {
          const s = styleOf(n);
          if (n.hasAttribute("hidden") || s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" || s.opacity === "0") return false;
        }
        return this.isConnected;
      },
      compareDocumentPosition(other) { return descendants(doc).indexOf(this) < descendants(doc).indexOf(other) ? 4 : 2; },
      focus() { mutations.push("focus"); },
      scrollIntoView() { mutations.push("scrollIntoView"); this.rect.y = Math.max(0, Math.min(300, this.rect.y)); },
      click() { mutations.push("click"); },
      dispatchEvent() { mutations.push("dispatchEvent"); },
      addEventListener() {}, removeEventListener() {},
      attachShadow() {
        this.shadowRoot = { ...rootOps, nodeType: 11, host: this, children: [] };
        return this.shadowRoot;
      }
    };
    return el;
  }
  doc.documentElement = doc.appendChild(element("html", { rect: { width: 1024, height: 3000 } }));
  doc.documentElement.scrollWidth = 1024;
  doc.documentElement.scrollHeight = 3000;
  doc.body = doc.documentElement.appendChild(element("body", { rect: { width: 1024, height: 3000 } }));
  doc.getElementById = (id) => descendants(doc).find((el) => el.id === id) || null;
  doc.elementFromPoint = (x, y) => {
    const painted = (root) => root.children.flatMap((el) => [el, ...painted(el), ...(el.shadowRoot ? painted(el.shadowRoot) : [])]);
    return painted(doc).reverse().find((el) => {
      const r = el.getBoundingClientRect();
      return el.checkVisibility() && styleOf(el).pointerEvents !== "none" && x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    }) || null;
  };
  boot(win, doc, { runtime: { onMessage: { addListener(fn) { listener = fn; }, removeListener() {} } } },
    { href: "https://fixture.test/search" }, { pushState() {}, replaceState() {} },
    { randomUUID: () => "workflow-fixture" }, { escape: (value) => value }, styleOf, { DOCUMENT_POSITION_FOLLOWING: 4 });
  return {
    doc, win, element, mutations, queries,
    send(message) {
      let reply;
      listener(message, null, (result) => { reply = result; });
      return reply;
    },
    resolve(target, options = {}) { return this.send({ type: "getTargetCoordinates", ...target, ...options })?.result; },
    state(target) { return this.send({ type: "getWorkflowReplayTargetState", ...target })?.result; },
    resolvedElement(ref) { return win.__unblockedChrome.resolveRef(ref); },
    widget({ expanded = true, expand = "Open advanced search", simple = "Return to simple search" } = {}) {
      const form = doc.body.appendChild(element("form"));
      const control = form.appendChild(element("a", {
        text: expanded ? simple : expand,
        attrs: { class: "panel-heading btn-search", "data-search-advance": expand, "data-search-simple": simple, href: "javascript:void(0);" },
        rect: { x: 471, y: 583, width: 242, height: 44 }
      }));
      const panel = form.appendChild(element("div", {
        attrs: { class: "panel-body advance-search" }, style: { display: expanded ? "block" : "none" },
        rect: { x: 20, y: 663, width: 705, height: 1052 }
      }));
      const field = panel.appendChild(element("input", { attrs: { "aria-label": "Keyword" }, rect: { x: 40, y: 680, width: 300, height: 35 } }));
      return { form, control, panel, field, target: { role: "link", name: expand } };
    }
  };
}

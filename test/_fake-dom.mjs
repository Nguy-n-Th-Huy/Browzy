// A minimal fake DOM for tests that drive real extension UI modules in plain
// Node.
//
// WHY THIS EXISTS. `extension/sidepanel/history-view.js` is deliberately
// written against `createElement` + `textContent` + `setAttribute` +
// `addEventListener` and never against `innerHTML` parsing or `querySelector`
// (see that file's own "TESTABILITY" note) — which means the surface a test
// has to provide is small enough to implement honestly here instead of
// reaching for jsdom (this repo's suites have no DOM dependency, and adding
// one would be a much larger commitment than this file).
//
// It implements the element behaviour the view actually depends on, and
// nothing else:
//   * children / appendChild / insertBefore / removeChild / remove — the keyed
//     patch's whole vocabulary,
//   * textContent with real semantics (setting it replaces the children, as
//     the browser does),
//   * attributes, dataset, className, disabled, hidden, value,
//   * addEventListener + removeEventListener + dispatchEvent, so click/keydown
//     behaviour is testable and teardown is observable,
//   * focus() recording `document.activeElement`, so "keyboard reopen" is
//     observable,
//   * scrollTop/scrollHeight/clientHeight as plain writable numbers, so a test
//     can install a reflow simulation that moves the scrolling ancestor's
//     offset across the insertBefore/removeChild calls the keyed patch makes —
//     which is what makes paging and scroll preservation observable rather
//     than assumed.
//
// It is NOT a browser: no layout, no CSS, no event bubbling (a test dispatches
// on the element whose own listener it wants), no HTML parsing.

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || "div").toUpperCase();
    this._doc = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this._text = "";
    this._listeners = new Map();
    this.innerHTML = "";
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join("");
    return this._text;
  }

  set textContent(value) {
    this._text = String(value == null ? "" : value);
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
  }

  appendChild(child) {
    return this.insertBefore(child, null);
  }

  insertBefore(child, reference) {
    if (!child) throw new Error("insertBefore: no child");
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = reference ? this.children.indexOf(reference) : -1;
    if (reference && index === -1) throw new Error("insertBefore: reference is not a child of this node");
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name.startsWith("data-")) {
      delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    }
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const listeners = this._listeners.get(type);
    if (!listeners) return;
    const index = listeners.indexOf(fn);
    if (index !== -1) listeners.splice(index, 1);
  }

  dispatchEvent(event) {
    const payload = { target: this, preventDefault() {}, stopPropagation() {}, ...(event || {}) };
    payload.target = payload.target || this;
    for (const fn of this._listeners.get(payload.type) || []) fn(payload);
    return true;
  }

  /** Test affordance: click this element (used on controls the view creates). */
  click() {
    this.dispatchEvent({ type: "click" });
  }

  focus() {
    if (this._doc) this._doc.activeElement = this;
  }
}

export function createDocument() {
  const doc = {
    activeElement: null,
    createElement(tag) {
      return new FakeElement(tag, doc);
    }
  };
  doc.body = doc.createElement("body");
  return doc;
}

export { FakeElement };

import assert from "node:assert/strict";
import { createDocument } from "./_fake-dom.mjs";
import { extractFunction, compile } from "./_extract.mjs";

const doc = createDocument();
globalThis.HTMLElement = class {
  constructor() { this.dataset = {}; this.attrs = {}; this.classList = { add() {} }; }
  setAttribute(key, value) { this.attrs[key] = value; }
};
globalThis.customElements = { define() {} };
const { UiToolRow } = await import("../extension/ui/behaviors.js");
const row = new UiToolRow();
const summary = doc.createElement("button");
summary.setAttribute("aria-expanded", "false");
const detail = doc.createElement("div");
detail.hidden = true;
detail.textContent = "Trước thao tác · Sau thao tác · Xem ảnh đã ghi";
row.querySelector = selector => selector === ".tool-row-summary" ? summary : selector === ".tool-row-detail" ? detail : null;
summary.parentElement = row;
row.connectedCallback();
const transcript = { querySelectorAll: selector => selector === ".tool-row-summary" ? [summary] : [] };
const wire = compile(extractFunction("wireTimelineToggles", "extension/sidepanel/sidepanel.js"), { el: { transcript } }, "wireTimelineToggles");
wire();
wire();
summary.dispatchEvent({ type: "click" });
assert.equal(detail.hidden, false, "one activation opens actual evidence detail");
assert.equal(summary.getAttribute("aria-expanded"), "true");
assert.equal(row.attrs["data-expanded"], "true", "chevron and content agree");
assert.ok(detail.textContent.includes("Xem ảnh đã ghi"));
summary.dispatchEvent({ type: "click" });
assert.equal(detail.hidden, true);
assert.equal(summary.getAttribute("aria-expanded"), "false");
assert.equal(row.attrs["data-expanded"], "false");
console.log("PASS actual UiToolRow plus panel wiring toggles evidence exactly once per activation");

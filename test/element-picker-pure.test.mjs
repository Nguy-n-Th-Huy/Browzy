#!/usr/bin/env node
// Pure-function coverage for extension/overlay/element-picker.js (design mode
// / openspec/changes/add-design-mode-element-picker), extracted from the REAL
// shipped file via test/_extract.mjs — the same brace-matching technique
// test/overlay-pointer.test.mjs already uses for pointer-overlay.js, and for
// the identical reason (see that file's own header, and element-picker.js's):
// no web_accessible_resources entry means no dynamic import(), so this is a
// classic script whose pure functions are pulled out and run in plain Node.
//
// Covers: the style filter (design.md D4's fixed property list), markup
// truncation (design.md D5's 32 KB ceiling, truncated at a tag boundary),
// the rect-to-region conversion, the selector descriptor, and sanitizeClone
// (design.md D3) — clone-then-strip value/checked/selected/textarea content
// on the element and every descendant, with the password-field case proven
// against the FULL serialized output string, not just the attribute.
//
// Run: node test/element-picker-pure.test.mjs

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

// =============================================================================
// A minimal hand-rolled DOM element fake — matching this codebase's existing
// convention (test/overlay-pointer.test.mjs's makeFakeElement) rather than a
// jsdom/puppeteer dependency (none exists in this repo). Supports exactly the
// real-Element surface sanitizeClone()/stripSubtree() touch: tagName,
// getAttribute/setAttribute/removeAttribute, children, appendChild/
// removeChild, cloneNode(deep), value/checked/selected, textContent, and a
// computed outerHTML getter that serializes the current attrs/children/text.
// =============================================================================
const VOID_TAGS = new Set(["input", "br", "img", "hr"]);

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function serializeEl(el) {
  const tag = el.tagName.toLowerCase();
  const attrPairs = Object.keys(el._attrs)
    .map((k) => ` ${k}="${escapeAttr(el._attrs[k])}"`)
    .join("");
  if (VOID_TAGS.has(tag)) return `<${tag}${attrPairs}>`;
  const inner = el.children.length ? el.children.map(serializeEl).join("") : escapeText(el._text);
  return `<${tag}${attrPairs}>${inner}</${tag}>`;
}

function makeEl(tagName, attrs) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    _attrs: Object.assign({}, attrs || {}),
    children: [],
    parentNode: null,
    value: "",
    checked: false,
    selected: false,
    _text: "",
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
    cloneNode(deep) {
      const clone = makeEl(this.tagName, this._attrs);
      clone.value = this.value;
      clone.checked = this.checked;
      clone.selected = this.selected;
      clone._text = this._text;
      if (deep) for (const c of this.children) clone.appendChild(c.cloneNode(true));
      return clone;
    },
    get outerHTML() { return serializeEl(this); }
  };
  return el;
}

// =============================================================================
// 1. filterStyles: exactly the fixed STYLE_PROPERTIES list (design.md D4),
//    nothing else, every key always present (even empty) — that presence IS
//    D5's "list identity".
// =============================================================================
console.log("== filterStyles: the fixed property list, and nothing else ==");
{
  const listMatch = SRC.match(/var STYLE_PROPERTIES = \[([\s\S]*?)\];/);
  ok(!!listMatch, "found STYLE_PROPERTIES in the shipped source");
  const STYLE_PROPERTIES = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  ok(STYLE_PROPERTIES.length >= 20, "the fixed list is non-trivial (design.md D4 names ~30 properties across 5 groups)");
  const filterStyles = compile(extract("filterStyles"), { STYLE_PROPERTIES }, "filterStyles");

  const fakeComputed = {
    getPropertyValue(prop) {
      const known = { display: "flex", color: "rgb(0, 0, 0)", "font-size": "14px", "z-index": "auto" };
      return prop in known ? known[prop] : "";
    }
  };
  const result = filterStyles(fakeComputed);
  const resultKeys = Object.keys(result).sort();
  const expectedKeys = STYLE_PROPERTIES.slice().sort();
  ok(JSON.stringify(resultKeys) === JSON.stringify(expectedKeys), "the output has EXACTLY the fixed property list as keys");
  ok(result.display === "flex", "a real value is read through via getPropertyValue");
  ok(result.color === "rgb(0, 0, 0)", "...for every property genuinely reported");
  ok("padding" in result && result.padding === "", "an unset-in-the-fake property is present as an empty string, not omitted");
  ok(!("-webkit-border-before-color" in result), "a property outside the fixed list never appears, however the fake computed style is configured");

  const thrown = compile(extract("filterStyles"), { STYLE_PROPERTIES }, "filterStyles")({
    getPropertyValue() { throw new Error("boom"); }
  });
  ok(thrown.display === "", "a getPropertyValue that throws degrades that one property to empty, not a crash");
}

// =============================================================================
// 2. truncateMarkup: design.md D5's 32 KB ceiling, tag-boundary truncation,
//    truncated + ceiling always reported.
// =============================================================================
console.log("\n== truncateMarkup: the 32KB ceiling, truncated at a tag boundary, never silent ==");
{
  const truncateMarkup = compile(
    [extract("utf8ByteLength"), extract("truncateMarkup")].join("\n\n"),
    {},
    "truncateMarkup"
  );
  const ceilingMatch = SRC.match(/var MARKUP_CEILING_BYTES = (\d+ \* \d+|\d+);/);
  ok(!!ceilingMatch, "found MARKUP_CEILING_BYTES in the shipped source");
  // eslint-disable-next-line no-eval
  const MARKUP_CEILING_BYTES = Function(`return (${ceilingMatch[1]});`)();
  ok(MARKUP_CEILING_BYTES === 32 * 1024, "the ceiling is exactly 32KB (design.md D5)");

  const small = "<div class=\"x\">hello</div>";
  const r1 = truncateMarkup(small, MARKUP_CEILING_BYTES);
  ok(r1.markup === small && r1.truncated === false, "under-ceiling markup passes through unchanged, reported as not truncated");
  ok(r1.ceilingBytes === MARKUP_CEILING_BYTES, "the applied ceiling is stated even when nothing was cut");

  const big = "<div>" + "<span>x</span>".repeat(5000) + "</div>"; // well over 32KB
  const r2 = truncateMarkup(big, MARKUP_CEILING_BYTES);
  ok(r2.truncated === true, "over-ceiling markup is truncated, and the record says so");
  ok(r2.ceilingBytes === MARKUP_CEILING_BYTES, "...and states the ceiling that applied");
  const bytes = Buffer.byteLength(r2.markup, "utf8");
  ok(bytes <= MARKUP_CEILING_BYTES, `the truncated result (${bytes}B) fits within the ceiling`);
  ok(r2.markup.endsWith(">"), "truncation lands right after a complete tag, never mid-tag");
  ok(!/<[^>]*$/.test(r2.markup), "no dangling open tag survives at the end of the truncated markup");

  const multiByte = "<p>" + "chào bạn 🎉 ".repeat(4000) + "</p>";
  const r3 = truncateMarkup(multiByte, MARKUP_CEILING_BYTES);
  const bytes3 = Buffer.byteLength(r3.markup, "utf8");
  ok(bytes3 <= MARKUP_CEILING_BYTES, "multi-byte (Vietnamese/emoji) content is measured in UTF-8 bytes, not UTF-16 code units, so it still fits");

  const r4 = truncateMarkup("not even one full tag fits: " + "<".repeat(100000), 10);
  ok(r4.truncated === true && typeof r4.markup === "string", "an absurdly small ceiling degrades to an empty/short result rather than throwing");
}

// =============================================================================
// 3. rectToRegion: [x0,y0,x1,y1] passthrough plus the viewport-clip flag
//    (design.md D6's stated consequence for a too-tall element).
// =============================================================================
console.log("\n== rectToRegion: [x0,y0,x1,y1] in CSS px, and whether it was clipped to the viewport ==");
{
  const rectToRegion = compile(extract("rectToRegion"), {}, "rectToRegion");
  const inside = rectToRegion({ left: 10, top: 20, right: 110, bottom: 220 }, 1000, 800);
  ok(JSON.stringify(inside.region) === JSON.stringify([10, 20, 110, 220]), "a fully-inside rect passes through as [x0,y0,x1,y1]");
  ok(inside.clipped === false, "...and is reported as not clipped");

  const offLeft = rectToRegion({ left: -5, top: 0, right: 100, bottom: 100 }, 1000, 800);
  ok(offLeft.clipped === true, "a rect starting above x=0 is reported clipped");

  const offBottom = rectToRegion({ left: 0, top: 0, right: 100, bottom: 900 }, 1000, 800);
  ok(offBottom.clipped === true, "an element taller than the viewport is reported clipped (design.md D6's stated consequence)");

  const offRight = rectToRegion({ left: 0, top: 0, right: 1200, bottom: 100 }, 1000, 800);
  ok(offRight.clipped === true, "a rect wider than the viewport is reported clipped");
}

// =============================================================================
// 4. describeSelector: a short, recognizable descriptor (spec: "identify
//    which element it describes in a form the operator can recognize").
// =============================================================================
console.log("\n== describeSelector: id, then class, then bare tag ==");
{
  const describeSelector = compile(extract("describeSelector"), {}, "describeSelector");
  ok(describeSelector({ tagName: "DIV", getAttribute: (n) => (n === "id" ? "hero" : null) }) === "div#hero", "an id wins");
  ok(
    describeSelector({ tagName: "BUTTON", getAttribute: (n) => (n === "class" ? "btn primary" : null) }) === "button.btn",
    "no id: the FIRST class wins"
  );
  ok(describeSelector({ tagName: "SPAN", getAttribute: () => null }) === "span", "neither: the bare tag name");
  ok(describeSelector(null) === "", "a missing element never throws");
}

// =============================================================================
// 5. sanitizeClone (design.md D3): clone-then-strip, on the element and every
//    descendant, never the live element.
// =============================================================================
console.log("\n== sanitizeClone: strips current values, preserves structural attributes, never touches the live element ==");
const sanitizeClone = compile(
  [
    extract("tagNameOf"),
    extract("attrOf"),
    extract("isPasswordInput"),
    extract("stripValueLike"),
    extract("stripPasswordContainerSiblings"),
    extract("stripSubtree"),
    extract("sanitizeClone")
  ].join("\n\n"),
  {},
  "sanitizeClone"
);

{
  const container = makeEl("div", { class: "field" });
  const label = makeEl("label", { for: "email" });
  label.textContent = "Email";
  const input = makeEl("input", { type: "email", name: "email", id: "email", placeholder: "you@example.com" });
  input.value = "secret@example.com";
  input.setAttribute("value", "secret@example.com");
  container.appendChild(label);
  container.appendChild(input);

  const clone = sanitizeClone(container);
  const html = clone.outerHTML;
  ok(!html.includes("secret@example.com"), "a filled-in input's value is removed, attribute and property");
  ok(html.includes('type="email"') && html.includes('name="email"') && html.includes('id="email"'), "type/name/id are preserved");
  ok(html.includes('placeholder="you@example.com"'), "placeholder is preserved (it is not a value)");
  ok(html.includes('for="email"'), "the label's `for` association survives — the control is still describable");
  ok(input.value === "secret@example.com", "the LIVE input's own .value is never touched — only the clone was mutated");
}

{
  const textarea = makeEl("textarea", { name: "bio", placeholder: "Tell us about yourself" });
  textarea.value = "typed bio content";
  textarea.textContent = "typed bio content"; // a real <textarea>'s initial value IS its text content
  const clone = sanitizeClone(textarea);
  ok(!clone.outerHTML.includes("typed bio content"), "a textarea's content is removed");
  ok(clone.outerHTML.includes('name="bio"'), "its name is preserved");
  ok(textarea.value === "typed bio content", "the live textarea is untouched");
}

{
  const checkbox = makeEl("input", { type: "checkbox", name: "agree", checked: "checked" });
  checkbox.checked = true;
  const clone = sanitizeClone(checkbox);
  ok(!/checked/.test(clone.outerHTML), "a checked checkbox's checked state is removed");
  ok(clone.outerHTML.includes('name="agree"'), "its name is preserved");
  ok(checkbox.checked === true, "the live checkbox's checked state is untouched");
}

{
  const select = makeEl("select", { name: "plan" });
  const optFree = makeEl("option", { value: "free" });
  optFree.textContent = "Free";
  const optPro = makeEl("option", { value: "pro", selected: "selected" });
  optPro.selected = true;
  optPro.textContent = "Pro";
  select.appendChild(optFree);
  select.appendChild(optPro);
  const clone = sanitizeClone(select);
  ok(!/selected/.test(clone.outerHTML), "the selected option's selected state is removed");
  ok(clone.outerHTML.includes('name="plan"'), "the select's name is preserved");
  ok(optPro.selected === true, "the live option's selected state is untouched");
}

{
  const wrapper = makeEl("div", { class: "form" });
  const level2 = makeEl("section");
  const level3 = makeEl("fieldset");
  const deepInput = makeEl("input", { type: "text", name: "deep", placeholder: "deep field" });
  deepInput.value = "deep secret value";
  level3.appendChild(deepInput);
  level2.appendChild(level3);
  wrapper.appendChild(level2);
  const clone = sanitizeClone(wrapper);
  const html = clone.outerHTML;
  ok(!html.includes("deep secret value"), "a control several levels below the selected element loses its value exactly as if it were the root");
  ok(html.includes('name="deep"') && html.includes('placeholder="deep field"'), "its structural attributes survive at any depth");
}

console.log("\n== the password case: no part of the value survives ANYWHERE in the output — attribute, property, or mirrored text content ==");
{
  const pwContainer = makeEl("div", { class: "password-field" });
  const label = makeEl("label", { for: "pw" });
  label.textContent = "Password";
  const pwInput = makeEl("input", { type: "password", name: "pw", id: "pw", placeholder: "Password" });
  pwInput.value = "hunter2";
  pwInput.setAttribute("value", "hunter2");
  // A "show password"/mirrored-character widget: the SAME typed value,
  // leaked into a sibling's text content rather than the input's own value
  // attribute. A value-only strip on the input would miss this entirely —
  // this is exactly the case design.md D3's "entire subtree... containing
  // control" rule exists for.
  const mirror = makeEl("span", { class: "mirror-chars", "data-value": "hunter2" });
  mirror.textContent = "hunter2";
  pwContainer.appendChild(label);
  pwContainer.appendChild(pwInput);
  pwContainer.appendChild(mirror);

  const clone = sanitizeClone(pwContainer);
  const full = clone.outerHTML;
  ok(!full.includes("hunter2"), "the password value appears NOWHERE in the full serialized output — not as an attribute, not as text content");
  ok(full.includes('type="password"') && full.includes('name="pw"') && full.includes('id="pw"'), "the password input's own structural attributes are preserved");
  ok(pwInput.value === "hunter2", "the LIVE password input is never touched");

  // Root-is-password edge case (advisor note): the selected element IS the
  // password input itself, with no parent in the detached clone.
  const bareClone = sanitizeClone(pwInput);
  ok(!bareClone.outerHTML.includes("hunter2"), "a password input selected directly (no containing control in the clone) still loses its own value");
}

{
  // Two password fields sharing one parent: cleaning one must not blank the
  // other's own (already-to-be-stripped) input.
  const row = makeEl("div", { class: "row" });
  const pw1 = makeEl("input", { type: "password", name: "pw1" });
  pw1.value = "first-secret";
  const pw2 = makeEl("input", { type: "password", name: "pw2" });
  pw2.value = "second-secret";
  row.appendChild(pw1);
  row.appendChild(pw2);
  const clone = sanitizeClone(row);
  const html = clone.outerHTML;
  ok(html.includes('name="pw1"') && html.includes('name="pw2"'), "sibling password inputs both survive as elements — one's cleanup does not delete the other");
  ok(!html.includes("first-secret") && !html.includes("second-secret"), "and neither value survives");
}

console.log(fail === 0 ? "\nALL ELEMENT-PICKER PURE-FUNCTION TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

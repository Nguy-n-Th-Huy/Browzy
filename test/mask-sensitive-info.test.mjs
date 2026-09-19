// Sensitive-info masking (openspec/changes/add-sensitive-info-masking):
// the descriptor matcher (extracted from the shipped content script) and the
// mask_sensitive_info handler (extracted from the shipped service worker),
// driven offline against stand-ins for their dependencies — the same
// extract-and-compile discipline as handlers.test.mjs.
import fs from "node:fs";
import path from "node:path";
import { extractFunction, extractMethod, compile, ROOT, BACKGROUND } from "./_extract.mjs";
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const CONTENT = path.join(ROOT, "extension", "content.js");

// --- 1. Matcher --------------------------------------------------------------
const matcher = compile(extractFunction("maskCategoryForDescriptor", CONTENT), {}, "maskCategoryForDescriptor");

const POSITIVE_CASES = [
  ["password type", { type: "password" }, "password"],
  ["autocomplete current-password", { autocomplete: "current-password" }, "password"],
  ["autocomplete New-Password (case)", { autocomplete: "New-Password" }, "password"],
  ["autocomplete cc-number", { autocomplete: "cc-number" }, "payment"],
  ["autocomplete cc-csc", { autocomplete: "cc-csc" }, "payment"],
  ["autocomplete cc-exp", { autocomplete: "cc-exp" }, "payment"],
  ["autocomplete one-time-code", { autocomplete: "one-time-code" }, "otp"],
  ["joined snake name card_number", { name: "card_number" }, "payment"],
  ["camelCase name cardNumber", { name: "cardNumber" }, "payment"],
  ["CVV placeholder", { placeholder: "CVV" }, "payment"],
  ["securityCode id", { id: "securityCode" }, "payment"],
  ["api_key name", { name: "api_key" }, "token"],
  ["csrf_token id", { id: "csrf_token" }, "token"],
  ["sessionid name", { name: "sessionid" }, "token"],
  ["ssn name", { name: "ssn" }, "identity"],
  ["user_pin name", { name: "user_pin" }, "identity"],
  ["iban name", { name: "iban" }, "bank"],
  ["routing_number id", { id: "routing_number" }, "bank"],
  ["otp_code name", { name: "otp_code" }, "otp"],
  ["label text 'Enter your password'", { labelText: "Enter your password" }, "password"],
  ["aria label 'Card number'", { ariaLabel: "Card number" }, "payment"]
];
console.log("== matcher: positive cases ==");
for (const [label, desc, expected] of POSITIVE_CASES) {
  const got = matcher(desc);
  ok(got === expected, `${label} -> ${expected} (got ${got})`);
}

// The Orca-reference discipline (design.md D5): broad words must never
// trigger on ordinary attributes, and short tokens match whole split tokens
// only — not substrings.
const NEGATIVE_CASES = [
  ["classname contains ssn as a substring", { name: "classname" }],
  ["spinner contains pin as a substring", { name: "spinner" }],
  ["user_state ('state' excluded)", { name: "user_state" }],
  ["source-code ('code' excluded)", { id: "source-code" }],
  ["verification_code_hint ('code' excluded)", { name: "verification_code_hint" }],
  ["auth alone excluded", { name: "auth" }],
  ["token alone excluded", { name: "token" }],
  ["empty descriptor", {}],
  ["null descriptor", null]
];
console.log("== matcher: false positives stay out ==");
for (const [label, desc] of NEGATIVE_CASES) {
  const got = matcher(desc);
  ok(got === null, `${label} -> null (got ${got})`);
}

// --- 2. Handler ---------------------------------------------------------------
const handlerSrc = `const H = { ${extractMethod("mask_sensitive_info")} };`;
const mk = new Function(
  "isInGroup", "checkTabReadableForExtraction", "sendContentMessage",
  handlerSrc + "; return H.mask_sensitive_info;"
);

function makeHandler(state) {
  const calls = [];
  const isInGroup = async (id) => state.inGroup.includes(id);
  const checkTabReadableForExtraction = async () => state.restricted || null;
  const sendContentMessage = async (tabId, msg) => { calls.push({ tabId, msg }); return state.response; };
  return { fn: mk(isInGroup, checkTabReadableForExtraction, sendContentMessage), calls };
}
const textOf = (r) => r.content[0].text;

console.log("== handler: scope + restricted page ==");
{
  const h = makeHandler({ inGroup: [], response: undefined });
  const r = await h.fn({ action: "mask", tabId: 5 });
  ok(/not in the MCP group/.test(textOf(r)), "out-of-scope tab refused before any content message");
  ok(h.calls.length === 0, "no sendContentMessage for an out-of-scope tab");
}
{
  const h = makeHandler({ inGroup: [5], restricted: { content: [{ type: "text", text: "restricted page" }] } });
  const r = await h.fn({ action: "mask", tabId: 5 });
  ok(textOf(r) === "restricted page", "restricted-page result returned as-is");
  ok(h.calls.length === 0, "no sendContentMessage for a restricted page");
}

console.log("== handler: mask message + receipt ==");
{
  const h = makeHandler({
    inGroup: [5],
    response: { result: { ok: true, masked: 3, already: 1, categories: { password: 2, payment: 1 }, invalidSelectors: [], capped: false } }
  });
  const r = await h.fn({ action: "mask", tabId: 5, selectors: ["#iban"] });
  ok(h.calls.length === 1 && h.calls[0].msg.type === "maskSensitiveInfo", "mask dispatches maskSensitiveInfo");
  ok(JSON.stringify(h.calls[0].msg.selectors) === JSON.stringify(["#iban"]), "selectors forwarded verbatim");
  const t = textOf(r);
  ok(/Masked 3 element\(s\)/.test(t), "receipt reports the masked count");
  ok(/password: 2, payment: 1/.test(t), "receipt carries the category breakdown");
  ok(/\(1 already masked\)/.test(t), "receipt reports previously-masked elements");
  ok(/current document only/.test(t), "receipt states the current-document scope");
}
{
  const h = makeHandler({
    inGroup: [5],
    response: { result: { ok: true, masked: 1, already: 0, categories: { explicit: 1 }, invalidSelectors: ["::bad"], capped: true } }
  });
  const r = await h.fn({ action: "mask", tabId: 5, selectors: ["::bad"] });
  const t = textOf(r);
  ok(/Stopped early at the per-page element budget/.test(t), "capped receipt names the budget");
  ok(/Invalid selector\(s\) ignored: ::bad/.test(t), "invalid selectors are reported, not fatal");
}

console.log("== handler: unmask + no-match + error ==");
{
  const h = makeHandler({ inGroup: [5], response: { result: { ok: true, restored: 3 } } });
  const r = await h.fn({ action: "unmask", tabId: 5 });
  ok(h.calls.length === 1 && h.calls[0].msg.type === "unmaskSensitiveInfo", "unmask dispatches unmaskSensitiveInfo");
  ok(/Unmasked 3 element\(s\)/.test(textOf(r)), "unmask receipt reports the count");
}
{
  const h = makeHandler({ inGroup: [5], response: { result: { ok: true, restored: 0 } } });
  const r = await h.fn({ action: "unmask", tabId: 5 });
  ok(/nothing to unmask/.test(textOf(r)), "unmask with nothing masked says so");
}
{
  const h = makeHandler({ inGroup: [5], response: { result: { ok: true, masked: 0, already: 0, categories: {}, invalidSelectors: [], capped: false } } });
  const r = await h.fn({ action: "mask", tabId: 5 });
  const t = textOf(r);
  ok(/Nothing matched/.test(t) && /selectors/.test(t), "no-match response points at explicit selectors");
}
{
  const h = makeHandler({ inGroup: [5], response: undefined });
  const r = await h.fn({ action: "mask", tabId: 5 });
  ok(/^Error:/.test(textOf(r)), "missing content-script result surfaces an Error");
}

// --- 3. Structural pins on the read-path integration ---------------------------
const contentSrc = fs.readFileSync(CONTENT, "utf8");
console.log("== read-path integration pins ==");
ok(/if \(msg\.type === "maskSensitiveInfo"\)/.test(contentSrc), "content script routes maskSensitiveInfo");
ok(/if \(msg\.type === "unmaskSensitiveInfo"\)/.test(contentSrc), "content script routes unmaskSensitiveInfo");
ok(/getAttribute\("data-browzy-masked"\) !== null/.test(contentSrc), "AX tree suppresses a masked control's value");
ok(/child\.tagName\.toLowerCase\(\) === "textarea" &&\s*child\.hasAttribute\("data-browzy-masked"\)\)\s*\{\s*parts\.push\("••••••"\)/.test(contentSrc),
  "the rendered-text walk gives a masked textarea the placeholder — its value never becomes page text");

console.log(fail === 0 ? "\nALL MASK TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

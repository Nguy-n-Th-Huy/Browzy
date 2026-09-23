#!/usr/bin/env node
//
// The operator literal field value grammar and eligibility predicate
// (host/agent/jev/literal-field-value.js) — per openspec/changes/
// jev-literal-field-values design.md and the `jev-decision-layer` spec's
// "Operator literal field values" requirement.
//
// Both functions under test are pure: no observation, no DOM, no network.
// This suite proves the grammar accepts exactly the two whole-prompt forms it
// documents, rejects every interpretation-shaped or malformed prompt, and
// that eligibility refuses every unsuitable observed field.
//
// Run: node host/test/jev-literal-field-value.test.mjs

import { parseOperatorLiteral, literalFieldEligible } from "../agent/jev/literal-field-value.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nOperator literal field value (grammar + eligibility)\n");

// --- Assignment: accepted shapes -------------------------------------------

test("a quoted assignment yields the exact label and value, including internal punctuation", () => {
  const literal = parseOperatorLiteral('set Company to "Alice, Inc."');
  assert(literal && literal.kind === "assign" && literal.label === "company" && literal.value === "Alice, Inc.", JSON.stringify(literal));
});

test("a curly-quoted assignment is accepted the same way", () => {
  const literal = parseOperatorLiteral("set Company to “Alice, Inc.”");
  assert(literal && literal.kind === "assign" && literal.value === "Alice, Inc.", JSON.stringify(literal));
});

test("\"fill the X field with Y\" strips the leading \"the\" and trailing \"field\" from the label", () => {
  const literal = parseOperatorLiteral('fill the Company field with "Acme"');
  assert(literal && literal.kind === "assign" && literal.label === "company" && literal.value === "Acme", JSON.stringify(literal));
});

test("a leading \"please\" and a trailing period are both tolerated", () => {
  const literal = parseOperatorLiteral('please set Company to "Acme".');
  assert(literal && literal.value === "Acme", JSON.stringify(literal));
});

test("an unquoted value of a few simple tokens is accepted", () => {
  const literal = parseOperatorLiteral("set Company to Acme-Corp_1");
  assert(literal && literal.kind === "assign" && literal.value === "Acme-Corp_1", JSON.stringify(literal));
});

test("a separator inside a quoted value stays part of the one literal", () => {
  const literal = parseOperatorLiteral('set Notes to "Call before 5, then confirm; done."');
  assert(literal && literal.value === "Call before 5, then confirm; done.", JSON.stringify(literal));
});

test("a curly-quoted value may contain a literal comma/semicolon/newline-free separator too", () => {
  const literal = parseOperatorLiteral("set Notes to “A; B, C”");
  assert(literal && literal.value === "A; B, C", JSON.stringify(literal));
});

// --- Assignment: rejected shapes --------------------------------------------

test("more than one clause (a separator outside any quote) yields no literal", () => {
  assert(parseOperatorLiteral('set Company to "Acme", then click Submit') === null);
  assert(parseOperatorLiteral("set Company to Acme; set City to Berlin") === null);
  assert(parseOperatorLiteral("set Company to Acme\nset City to Berlin") === null);
});

test("an unterminated quote yields no literal", () => {
  assert(parseOperatorLiteral('set Company to "Acme') === null);
  assert(parseOperatorLiteral("set Company to “Acme") === null);
});

for (const word of ["if", "unless", "when", "until", "instead", "either", "example", "previous", "original", "replace", "change", "except"]) {
  test(`the blocking word "${word}" anywhere in the prompt yields no literal`, () => {
    assert(parseOperatorLiteral(`set Company to Acme ${word} something else`) === null, word);
  });
}

for (const negation of ["do not", "don't", "never"]) {
  for (const verb of ["set", "fill", "type", "enter"]) {
    test(`the negated verb "${negation} ${verb}" yields no literal`, () => {
      assert(parseOperatorLiteral(`${negation} ${verb} Company to Acme`) === null, `${negation} ${verb}`);
    });
  }
}

for (const word of ["and", "then", "after", "before", "using", "from", "your", "my", "their", "its", "same", "current", "random", "any", "uppercase", "lowercase", "capitalized", "blank", "empty", "nothing", "whatever"]) {
  test(`the unquoted reserved word "${word}" yields no literal`, () => {
    assert(parseOperatorLiteral(`set Company to Acme ${word}`) === null, word);
  });
}

test("unquoted punctuation outside letters/digits/_/- yields no literal", () => {
  assert(parseOperatorLiteral("set Company to Acme!") === null);
  assert(parseOperatorLiteral("set Email to a@b.com") === null);
});

test("9 unquoted space-separated tokens exceed the 8-token bound", () => {
  const eight = "one two three four five six seven eight";
  const nine = `${eight} nine`;
  assert(parseOperatorLiteral(`set Notes to ${eight}`) !== null, "sanity: 8 tokens is still accepted");
  assert(parseOperatorLiteral(`set Notes to ${nine}`) === null, "9 tokens is rejected");
});

test("an empty quoted value is rejected", () => {
  assert(parseOperatorLiteral('set Notes to ""') === null);
});

test("a value of 2001 characters is rejected, 2000 is accepted", () => {
  const ok2000 = `"${"a".repeat(2000)}"`;
  const over2001 = `"${"a".repeat(2001)}"`;
  assert(parseOperatorLiteral(`set Notes to ${ok2000}`)?.value.length === 2000, "sanity: 2000 chars accepted");
  assert(parseOperatorLiteral(`set Notes to ${over2001}`) === null, "2001 chars rejected");
});

test("a prompt with no set/fill assignment shape and no search shape yields no literal", () => {
  assert(parseOperatorLiteral("Find a flight to Zurich") === null);
  assert(parseOperatorLiteral("") === null);
  assert(parseOperatorLiteral(undefined) === null);
});

// --- Search: accepted and rejected shapes -----------------------------------

test("a whole-prompt search literal is accepted with a quoted value", () => {
  const literal = parseOperatorLiteral('search for "red shoes"');
  assert(literal && literal.kind === "search" && literal.value === "red shoes", JSON.stringify(literal));
});

test("a search literal tolerates a leading please and a trailing period", () => {
  const literal = parseOperatorLiteral('please search for "red shoes".');
  assert(literal && literal.value === "red shoes", JSON.stringify(literal));
});

test("a search prompt with trailing content beyond the quoted value is not a whole-prompt match", () => {
  assert(parseOperatorLiteral('search for "red shoes" on the marketplace') === null);
});

// --- Date parsing lives in eligibility, not the parser ----------------------

test("the parser itself does not validate dates (that is literalFieldEligible's job)", () => {
  const literal = parseOperatorLiteral("set Departure to 2026-10-05");
  assert(literal && literal.value === "2026-10-05", JSON.stringify(literal));
});

// --- Eligibility -------------------------------------------------------------

function textbox(overrides = {}) {
  return {
    ref: "ref_1", role: "textbox", tag: "input", type: "text",
    label: "Company", editable: true, readonly: false, disabled: false,
    contenteditable: false, sensitive: null, value: "",
    ...overrides
  };
}

const ASSIGN_COMPANY = { kind: "assign", label: "company", value: "Acme" };

test("an exact single match is eligible", () => {
  const field = textbox();
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === true);
});

test("a duplicate label anywhere in the observation refuses eligibility for either control", () => {
  const a = textbox({ ref: "ref_1" });
  const b = textbox({ ref: "ref_2" });
  assert(literalFieldEligible(ASSIGN_COMPANY, a, [a, b]) === false);
  assert(literalFieldEligible(ASSIGN_COMPANY, b, [a, b]) === false);
});

test("a textarea is never eligible, even with the right role and label", () => {
  const field = textbox({ tag: "textarea" });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a contenteditable host is never eligible", () => {
  const field = textbox({ contenteditable: true });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a readonly field is not eligible", () => {
  const field = textbox({ readonly: true });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a disabled field is not eligible", () => {
  const field = textbox({ disabled: true });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a field not marked editable is not eligible", () => {
  const field = textbox({ editable: false });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a sensitive field is never eligible regardless of its category", () => {
  const field = textbox({ sensitive: "password" });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a field whose role is not textbox/searchbox/combobox is not eligible", () => {
  const field = textbox({ role: "button" });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a label mismatch is not eligible", () => {
  const field = textbox({ label: "City" });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === false);
});

test("a combobox with the matching role and label is eligible", () => {
  const field = textbox({ role: "combobox" });
  assert(literalFieldEligible(ASSIGN_COMPANY, field, [field]) === true);
});

// --- Search eligibility ------------------------------------------------------

const SEARCH_LITERAL = { kind: "search", value: "red shoes" };

function searchbox(overrides = {}) {
  return textbox({ ref: "ref_s", role: "searchbox", type: "search", label: "Search", ...overrides });
}

test("a single observed search field is eligible for the search literal", () => {
  const field = searchbox();
  assert(literalFieldEligible(SEARCH_LITERAL, field, [field]) === true);
});

test("two observed search fields make neither eligible", () => {
  const a = searchbox({ ref: "ref_s1" });
  const b = searchbox({ ref: "ref_s2" });
  assert(literalFieldEligible(SEARCH_LITERAL, a, [a, b]) === false);
  assert(literalFieldEligible(SEARCH_LITERAL, b, [a, b]) === false);
});

test("an input of type=search without the searchbox role still counts as the search field", () => {
  const field = textbox({ role: "textbox", type: "search" });
  assert(literalFieldEligible(SEARCH_LITERAL, field, [field]) === true);
});

test("an assignment literal is never eligible against a plain non-matching field for the search kind", () => {
  const field = textbox();
  assert(literalFieldEligible(SEARCH_LITERAL, field, [field]) === false, "an ordinary textbox is not a search field");
});

// --- Native date input --------------------------------------------------------

test("a real ISO calendar date binds to a native date field", () => {
  const field = textbox({ type: "date", label: "Departure" });
  const literal = { kind: "assign", label: "departure", value: "2026-10-05" };
  assert(literalFieldEligible(literal, field, [field]) === true);
});

test("an impossible calendar date (2026-02-30) is refused on a date field", () => {
  const field = textbox({ type: "date", label: "Departure" });
  const literal = { kind: "assign", label: "departure", value: "2026-02-30" };
  assert(literalFieldEligible(literal, field, [field]) === false);
});

test("a non-ISO date shape (05/10/2026) is refused on a date field", () => {
  const field = textbox({ type: "date", label: "Departure" });
  const literal = { kind: "assign", label: "departure", value: "05/10/2026" };
  assert(literalFieldEligible(literal, field, [field]) === false);
});

test("a relative date word (tomorrow) is refused on a date field", () => {
  const field = textbox({ type: "date", label: "Departure" });
  const literal = { kind: "assign", label: "departure", value: "tomorrow" };
  assert(literalFieldEligible(literal, field, [field]) === false);
});

test("a null literal or element never resolves eligible", () => {
  const field = textbox();
  assert(literalFieldEligible(null, field, [field]) === false);
  assert(literalFieldEligible(ASSIGN_COMPANY, null, [field]) === false);
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\nALL LITERAL FIELD VALUE TESTS PASSED" : `\n${failed.length} FAILED`);
process.exit(failed.length ? 1 : 0);

## 1. Sensitive category on snapshot rows

- [x] 1.1 In `extension/content.js`, add `sensitive` to the `page_snapshot` control record, computed by `maskCategoryForDescriptor` from the same descriptor construction the masking scan uses (`null` when unclassified). Do not duplicate the classifier.
- [x] 1.2 Do not add `sensitive` to the decision rows sent to Jev, and do not copy it onto `host/agent/jev/questions.js` TYPE_TEXT target records either: host-side eligibility (`literalFieldEligible`) reads `sensitive` directly from the raw observed `page_snapshot` element, so `questions.js` needs no change for this.
- [x] 1.3 Extend `test/page-snapshot-content.test.mjs`: type `password`, autocomplete `current-password` and an ordinary input → `sensitive` is `"password"`, `"password"` and `null` respectively; existing row fields unchanged ← (verify: classifier reused rather than copied; existing snapshot tests still pass)

## 2. Literal parser and eligibility

- [x] 2.1 Create `host/agent/jev/literal-field-value.js` with pure `parseOperatorLiteral(prompt)` and `literalFieldEligible(literal, element, elements)`, implementing the grammar, reserved words, blocking words, quote-aware clause split, 1–2000 length bound, search form and ISO date round trip exactly as specified.
- [x] 2.2 Create `host/test/jev-literal-field-value.test.mjs` covering: quoted and curly-quoted assignments; `fill the X field with Y`; separators inside quotes; the multi-clause reject; each blocking word; the negated verb reject; an unterminated quote; each unquoted reserved word; unquoted punctuation; 9 unquoted tokens; the empty and 2001-character values; search with one and two searchboxes; date `2026-10-05` accepted and `2026-02-30`, `05/10/2026`, `tomorrow` rejected; eligibility rejects for duplicate label, textarea, contenteditable, readonly, disabled, sensitive and wrong role ← (verify: every rejection class in the spec has a test; grammar matches spec text exactly)

## 3. Runtime binding

- [x] 3.1 In `host/agent/jev/runtime.js`, parse `provider.goal` once at run start. Tag model-prepared bindings `source: "prepared"`.
- [x] 3.2 In `eligiblePreparation()`, after the existing invalidation, bind an unspent literal to the single eligible element of the current snapshot (with a nonce required). Remove unconsumed model bindings for that ref. Skip when an equivalent literal binding already exists or the field already holds the value.
- [x] 3.3 On a TYPE_TEXT dispatch of a `source: "literal"` record, mark the run's literal spent. Stale invalidation does not spend it.
- [x] 3.4 Record `valueSource` (`"literal"` | `"prepared"`) on TYPE_TEXT `jev_step`, keeping `omitValue`. Confirm the side-panel step renderer tolerates the extra field and legacy records without it.
- [x] 3.5 Add runtime integration tests (in `host/test/jev-decision-runtime.test.mjs` or `host/test/jev-runtime.test.mjs`, following their existing fakes): literal offered in the first cycle with no extra model call; a field revealed in a later cycle gets the literal without REPLAN; the literal supersedes a differing model value; the literal is dispatched once and not re-offered when the field reappears; a nonce change drops the old binding; the typed value is absent from the step record and `valueSource` is `"literal"`; a non-literal prompt behaves exactly as before ← (verify: all guards — approval, nonce re-validation, bounds, completion check — still run for literal dispatches; no LLM call is added)

## 4. Checks

- [x] 4.1 Run the Jev host tests (`node --test host/test/jev-*.test.mjs`) and `node --test test/page-snapshot-content.test.mjs`, then the repo's full test command from `package.json`. Report failures in files outside this change without editing them ← (verify: tests green, or unrelated failures reported with ownership noted)

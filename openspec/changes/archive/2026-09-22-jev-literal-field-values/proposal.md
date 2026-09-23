## Why

In a TypeSafe (Jev) run, every TYPE_TEXT value is prepared by the configured language model, even when the operator already wrote the exact value in their prompt (`set Name to "Alice, Inc."`). The model can paraphrase or reformat such a value. A matching field that appears only after the first plan (a revealed form, a page after navigation) also needs a bounded REPLAN before anything can be typed into it. Ulka (a sibling Jev-based extension) removes both problems with a deliberately narrow, host-side literal grammar. This change brings that idea into Browzy's guarded Jev runtime as a specified requirement. Only the idea is ported: no ulka code and no ulka dependency.

## What Changes

- The Jev runtime parses **only the operator's own prompt** (`provider.goal`) with a narrow, deterministic grammar. The grammar accepts two forms, and each must be the whole prompt: a single `set|fill <Label> to|with <value>` clause, or a whole-prompt `search for "<X>"`. Anything conditional, corrective, multi-clause or transformation-shaped yields no literal. Plan memory, model output, conversation history and page text can never supply a literal.
- A parsed literal binds host-side, at observation time and without any language-model call, to the unique observed single-line, non-sensitive, editable, enabled field whose normalized label equals the literal's label. For the search form, it binds to the single observed search field. The binding has exactly the shape and guards of a model-prepared text binding (ref, role, label, docNonce, one dispatch). It also carries a `literal` source marker.
- A literal binding supersedes a model-prepared value for the same field. It is spent after one dispatch for the whole run, even if the field reappears. The existing rule that a field already holding the value consumes the binding still applies.
- Native date inputs accept a literal only when it is a valid ISO `YYYY-MM-DD` date that survives a round trip.
- `page_snapshot` element rows gain one additive field, `sensitive`, which carries the category from the extension's existing masking classifier (password, payment, one-time code and so on). A field with a sensitive category is never a literal target.
- `jev_step` records gain a `valueSource` (`"literal"` | `"prepared"`) on TYPE_TEXT steps. The literal value itself is never recorded (the existing omit-value rule is unchanged).
- Unchanged: the initial plan consultation, docNonce/target re-validation, approval and authorization gates, single-dispatch consumption, run bounds and completion verification.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `jev-decision-layer`: adds "Operator literal field values" (host-derived literal bindings from the operator's prompt, under the same exact-field ownership as prepared content, and the one non-model source of text) and "Text value source is observable".
- `typesafe-jev-provider`: adds "Sensitive-field category on observed controls" (an additive `sensitive` field on `page_snapshot` control rows).

## Impact

- `host/agent/jev/literal-field-value.js` (new): pure literal parser and field-eligibility predicate.
- `host/agent/jev/runtime.js`: literal binding at observation time in the preparation lifecycle (`prepare()` / `eligiblePreparation()`), supersession, per-run spent set, and `valueSource` on step records.
- `host/agent/jev/questions.js`: no change — host-side eligibility reads `sensitive` directly from the raw observed `page_snapshot` element, so the category is never carried onto TYPE_TEXT targets or sent to Jev.
- `extension/content.js`: `page_snapshot` record gains `sensitive` from `maskCategoryForDescriptor` (additive).
- Tests: new `host/test/jev-literal-field-value.test.mjs`; runtime integration in the existing Jev runtime test suite; snapshot field coverage in `test/page-snapshot-content.test.mjs`.
- Out of scope: making Jev a `browser_subgoal` tool of LLM runs (a separate future change), action caching, and schema extraction.

## Context

A TypeSafe run prepares text in `host/agent/jev/runtime.js` `prepare()`. The configured model returns `textValues` keyed by the displayed element index, and the host binds each one to `{ id, ref, role, label, docNonce, value, consumed }` (runtime.js ~974–1010). `eligiblePreparation()` (~1012) runs every cycle: it marks a binding consumed when the document, ref, role or label changes, when the field stops being editable, or when the field already holds the value. The decision request then offers the unconsumed bindings as complete TYPE_TEXT candidates. A dispatch consumes its record, and `summarizeArgs(..., { omitValue: true })` keeps the value out of the transcript.

`provider.goal` is the operator's prompt for this turn, set in `host/agent/companion.js` (~4247, "The operator's own prompt is the goal; page content never is").

`page_snapshot` rows (`extension/content.js` ~1406) already carry `tag`, `type`, `editable`, `readonly` and `contenteditable`. They do not carry the sensitive-field category that `maskCategoryForDescriptor` (~1003) computes for sensitive-info masking.

The idea comes from ulka's `literal-field-value.ts`. It is reimplemented here in plain JS, and nothing is imported from ulka.

## Goals / Non-Goals

**Goals:**
- Type an exact operator-supplied value without model paraphrase.
- Bind a literal to a matching field that appears after the initial plan, without a REPLAN.
- Keep every existing guard. The literal source is the only new thing.

**Non-Goals:**
- Skipping the initial plan call (plan memory is still required).
- Making Jev a tool of LLM runs (`browser_subgoal`), which is a separate future change.
- Action caching or schema extraction.
- Parsing values from anything other than `provider.goal`.
- Multi-field assignments in one prompt. More than one clause yields no literal, by design.

## Decisions

1. **Pure module `host/agent/jev/literal-field-value.js`.** It exports `parseOperatorLiteral(prompt)`, which returns `{ kind: "assign", label, value } | { kind: "search", value } | null`, and `literalFieldEligible(literal, element, elements)`, which returns a boolean. Both are pure and have no I/O, so the parser and eligibility rules are unit-testable in isolation, as `questions.js` helpers already are. The prompt is parsed once per run, at run start, because `provider.goal` does not change within a run.
   - Clause splitting walks characters and tracks the open quote (`"` closes with `"`, `“` closes with `”`). Separators inside a quote stay in the value. An unterminated quote yields `null`.
   - The regexes and reserved-word lists are exactly those stated in the spec. Unquoted tokens use `\p{L}\p{N}_-` with the `u` flag.
   - Date check: `/^[1-9]\d{3}-\d{2}-\d{2}$/`, plus `new Date(v + "T00:00:00.000Z").toISOString().slice(0,10) === v`.
2. **Eligibility uses observed row facts only.** Role in {textbox, searchbox, combobox}; `editable === true`; `readonly !== true`; `disabled !== true`; `tag === "input"`; `contenteditable !== true`; `sensitive == null`. The label is normalized with `trim().toLocaleLowerCase()`. Uniqueness is counted over all observed elements, not only the editable ones, which matches ulka's stricter rule. Search binding requires exactly one element with role `searchbox` or type `search`. A date check applies when `type === "date"`.
   - The binding label comes from the raw snapshot element label, never from the shortened display label (the same rule `prepare()` already follows).
3. **The binding happens inside `eligiblePreparation()`.** After the existing invalidation pass, if the run has an unspent literal and the current snapshot has a nonce, find the single eligible element. When it exists, remove unconsumed model bindings for that ref and append `{ id: "literal:<n>", ref, role, label, docNonce, value, consumed: false, source: "literal" }`. Do this unless an unconsumed literal binding for the same ref and nonce already exists, or the field's current value already equals the literal. This covers the first cycle, later cycles, and post-navigation cycles alike. `prepare()` output is merged under the same supersession rule: the literal is re-applied on the next `eligiblePreparation()` call, which runs before each decision. Model bindings carry `source: "prepared"`.
4. **Run-scoped spent flag.** When a TYPE_TEXT dispatch executes a record with `source === "literal"`, set `literalSpent = true`. Afterwards no literal binding is created for the rest of the run. A binding invalidated without dispatch (stale nonce) does not spend it, so a fresh eligible observation can rebind.
5. **`valueSource` on `jev_step`.** At the TYPE_TEXT step construction (~1426), set `step.valueSource = record.source === "literal" ? "literal" : "prepared"`. The `omitValue` summary is unchanged. The UI needs no change, because unknown step fields are already ignored by renderers. The implementer confirms this in the side-panel renderer.
6. **Snapshot `sensitive` field.** In the `page_snapshot` record builder, add `sensitive: maskCategoryForDescriptor({...descriptor fields the masking path already passes...})`. The implementer reuses the exact descriptor construction the masking scan uses, rather than a new partial one. `questions.js` does not copy `sensitive` onto TYPE_TEXT target records and does not send it to Jev in the decision rows (it is not decision-relevant, and adding it would change request fitting): `literalFieldEligible` reads `sensitive` directly from the raw observed snapshot element, which is the only place host-side eligibility needs it.

## Risks / Trade-offs

- [Grammar too narrow: many real prompts yield no literal] → This is intentional. The fallback is the unchanged model path, so no behavior regresses.
- [The literal targets the wrong field because of a label collision] → Uniqueness is counted across all observed controls, and any ambiguity yields no binding.
- [A sensitive field is typed from a prompt literal] → The `sensitive` category refuses it. Passwords, payment and OTP fields always use the existing path (and its approvals).
- [Parallel sessions have uncommitted edits in runtime.js, questions.js and content.js] → The edits are additive and localized. The implementer builds on the current contents and reverts nothing.
- [The literal equals the current value, so it would never dispatch] → It is treated as already satisfied: no binding is created, and nothing is spent.

## Migration Plan

This is additive. Old step records lack `valueSource` and render unchanged. Rollback means deleting the module and reverting the call sites.

## Open Questions

None.

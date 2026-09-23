# Verification Report: jev-literal-field-values

Date: 2026-09-22
Verifier: osf-verify subagent (independent, report-only)

## Scope

Verified against `openspec/changes/jev-literal-field-values/{proposal.md,design.md,tasks.md,specs/jev-decision-layer/spec.md,specs/typesafe-jev-provider/spec.md}` and the files declared in the change's Impact section:

- `host/agent/jev/literal-field-value.js` (new)
- `host/agent/jev/runtime.js`
- `extension/content.js`
- `host/agent/jev/questions.js` (task says no change needed)
- `host/test/jev-literal-field-value.test.mjs` (new)
- `host/test/jev-decision-runtime.test.mjs`
- `test/page-snapshot-content.test.mjs`

All 26 tasks.md checkboxes were independently verified against actual code/tests, not trusted.

## Summary

| Dimension | Status |
|---|---|
| Completeness (tasks.md vs code) | All 26 items verified with real backing code/tests |
| Correctness (spec vs implementation) | Matches on every requirement checked, including edge cases |
| Coherence | Classifier reused (not duplicated), sensitive field never leaks to Jev, UI tolerates unknown field |
| Test results | All green (see below) |

## Test Results

```
node --test host/test/jev-literal-field-value.test.mjs
→ 1 pass, 0 fail (72 sub-assertions via internal test() calls, all PASS)

node --test host/test/jev-decision-runtime.test.mjs
→ tests 81, pass 81, fail 0 (includes 15 literal-specific integration tests, all PASS)

node --test host/test/jev-*.test.mjs
→ tests 129, pass 129, fail 0 (jev-capability, jev-client, jev-decision-protocol,
  jev-decision-runtime, jev-evidence, jev-literal-field-value, jev-page-monitor-dispatch,
  jev-questions, jev-report-grounding, jev-runtime, jev-source-fetch, jev-text-helper)

node --test test/page-snapshot-content.test.mjs
→ tests 1, pass 1, fail 0 (includes the dedicated "sensitive-field category" section)
```

No failures anywhere in scope.

## Requirement-by-requirement verification

**1. Grammar** (`host/agent/jev/literal-field-value.js`) — Confirmed exact match to spec text:
- Two whole-prompt forms only: `parseOperatorLiteral` requires `SEARCH_PATTERN` to match the entire trimmed prompt, or `splitClauses` to yield exactly 1 clause matching `ASSIGNMENT_PATTERN`.
- Clause split (`splitClauses`) tracks quote state character-by-character (`"`→`"`, `"`→`"`), so separators inside quotes stay in the value; unterminated quote returns `null` (yielding no literal).
- `CONDITIONAL_WORDS` (12 words: if/unless/when/until/instead/either/example/previous/original/replace/change/except) and `NEGATED_VERB` (do not|don't|never + set|fill|type|enter) are tested against the whole raw prompt, matching spec + design.md's stated "over-inclusive" intent.
- `RESERVED_UNQUOTED_WORDS` has exactly the 21 words from spec; `UNQUOTED_VALUE_PATTERN` bounds to 1–8 tokens of `\p{L}\p{N}_-`.
- 1–2000 char bound applied to both quoted and unquoted values, both kinds.
- Tests cover all 12 blocking words, all 12 negation×verb pairs, all 21 reserved words, 9-token overflow, empty/2001-char rejects, curly quotes, `fill the X field with Y`, quote-aware separator retention — exhaustive against the spec text.

**2. Eligibility** (`literalFieldEligible`) — role restricted to {textbox, searchbox, combobox}; requires `editable===true`, `readonly!==true`, `disabled!==true`, `tag==="input"` (rejects textarea), `contenteditable!==true`, `sensitive==null`. Assignment path requires unique normalized-label match across ALL observed elements (not just editable ones, matching design.md's stated stricter rule); search path requires exactly one searchbox/type=search control. Date type gets `isRealIsoDate` round-trip check. All eligibility-reject test cases present and passing (duplicate label, textarea, contenteditable, readonly, disabled, sensitive, wrong role, date variants).

**3. Binding shape / supersession / spend** (`host/agent/jev/runtime.js`):
- `operatorLiteral = parseOperatorLiteral(provider.goal)` parsed once at run start (line 388); model-prepared records tagged `source: "prepared"` (line 1014).
- `eligiblePreparation()` (line 1035) runs the existing invalidation pass first, then binds an unspent literal to the single eligible current-snapshot element (line 1054+), removing unconsumed "prepared" records for the same ref (supersession, line 1068-1069), skipping when an unconsumed literal binding already exists for that ref+nonce or the field already holds the value (line 1060-1064, matching design.md risk #5).
- `eligiblePreparation()` is called at exactly the two points design.md specifies: pre-dispatch re-validation inside `dispatch()` (line 792) and before building each decision request (line 1216) — no extra call sites, confirming no extra LLM call is triggered by literal handling itself.
- `literalSpent` flag set only on actual TYPE_TEXT dispatch of a `source==="literal"` record (line 855), not on invalidation — matches "spent after one dispatch for the whole run even if field reappears" and "stale invalidation does not spend it."
- Runtime integration tests directly assert `h.plans === 1` (no extra preparation call) for both the first-cycle and later-revealed-field cases, assert supersession, single-dispatch-then-never-reoffered, nonce-drop-and-rebind, and that the typed value never appears in any emitted event (`!JSON.stringify(h.events).includes("Alice")`).

**4. Native date inputs** — `isRealIsoDate` requires `/^[1-9]\d{3}-\d{2}-\d{2}$/` plus a UTC `Date` round-trip; tests confirm `2026-10-05` accepted, `2026-02-30`/`05/10/2026`/`tomorrow` rejected, both at the parser level (parser itself is date-agnostic, correctly deferring to eligibility) and at `literalFieldEligible`.

**5. `sensitive` on `page_snapshot` rows** (`extension/content.js`):
- Line 1433: `sensitive: (tag === "input" || tag === "textarea") ? maskCategoryForDescriptor(maskDescriptorForControl(el)) : null`.
- `maskDescriptorForControl` (line 1069) is a new shared helper; confirmed BOTH the sensitive-info masking scan (line 1179: `maskCategoryForDescriptor(maskDescriptorForControl(el))`) and the snapshot builder (line 1433) call the identical function pair — no duplicated classifier logic, satisfying design.md decision 6 and tasks.md 1.1's "do not duplicate the classifier."
- Decision rows sent to Jev (`buildActionSpace` in `host/agent/jev/questions.js`, line 230+) construct `row` with an explicit whitelist of fields (index, role, label, tag, type, value, editable, readonly, contenteditable, checked, selected, expanded, isNew, operations) — `sensitive` is never added. Confirmed via grep that `questions.js` contains zero references to "sensitive" anywhere — matches tasks.md 1.2's claim exactly.
- `test/page-snapshot-content.test.mjs` (lines 852-877) has the exact 3-case coverage tasks.md 1.3 specifies (type=password → "password", autocomplete=current-password → "password", ordinary input → null), plus a "existing row fields unchanged" assertion and a "changed nothing on the page" mutation-count assertion.

**6. `valueSource` on `jev_step`** — Set at line 1501: `step.valueSource = preparedRecord?.source === "literal" ? "literal" : "prepared"`, found via `candidate.preparedId` lookup against `prepared.textValues`. `omitValue: operation === OPERATIONS.TYPE_TEXT` (line 1537) is unchanged — the typed value itself is never placed in `argsSummary`. Side-panel renderer (`extension/sidepanel/conversation-model.js`, `jev_step` case ~1175) builds its `jev` object via an explicit field whitelist copied from `event`; `valueSource`/`textField`-style extra fields are simply not copied when absent from the whitelist, confirming the renderer tolerates the new field without erroring (grep confirms no `valueSource` reference in the side-panel code, i.e., it is safely ignored — consistent with design.md decision 5's "unknown step fields are already ignored by renderers").

**7. Unchanged guards for literal dispatches** — Runtime integration suite includes "a denied literal dispatch is refused like any other TYPE_TEXT candidate — every existing guard still runs" and "a stale re-validation still applies to a literal dispatch (approval refresh refuses a changed field)", both passing, confirming approval/authorization gates, docNonce/target re-validation, and single-dispatch consumption apply unchanged to literal-sourced dispatches. Initial plan consultation is still invoked (`h.plans === 1`, i.e., exactly the normal one plan call, not zero) — literal handling adds no LLM call and removes none.

## Non-critical observations

1. Tasks.md item 4.1 instructs running "the repo's full test command from `package.json`," but there is no root `package.json` in this repo (confirmed: only `host/package.json` exists, which is the MCP-server/host package, not a repo-wide test runner). This is a documentation mismatch in tasks.md against the actual repo layout, not a code defect — the narrower `node --test` commands specified in this verification task's instructions were run directly and all pass. Not blocking.
2. `git status` at session start shows numerous other modified/untracked files (`extension/background.js`, `extension/msc-monitor.js`, `extension/page-monitor.js`, `host/agent/policy/authorization.js`, etc.) that are outside this change's declared Impact scope. These were not touched or evaluated by this verification and are presumed to belong to other in-progress work; ownership not verified, not classified as CRITICAL.

## CRITICALs

None found.

## Concerns

None. All spec requirements in both spec deltas (`jev-decision-layer`: "Operator literal field values", "Text value source is observable"; `typesafe-jev-provider`: "Sensitive-field category on observed controls") have concrete, tested backing code. All tasks.md checkboxes are backed by real implementation, not stubs or placeholders. The change is additive and self-contained; every one of design.md's five stated risks has a corresponding code guard and/or test.

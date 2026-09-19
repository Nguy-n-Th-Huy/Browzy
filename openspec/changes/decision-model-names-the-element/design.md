# Design: the decision model names the element it already chose

## 1. The one thing that moves

```
today:  observe → decide (operation + prose intent) → ask Jev which element → dispatch
after:  observe → decide (operation + offered index) → dispatch
```

Everything else in the cycle is untouched: the observation, the memory and its revisions, the completion check, the guards, the bounds, the approval gate, the host-side checks, the capture, the final report.

## 2. Why this is safe — the invariant does not move either

The rule that keeps page content from steering this loop has never been "Jev answers" — it is **the model may only return a key the host offered, and only the host maps a key to something executable**. `buildActionSpace` builds, from one observation, the numbered table and the `index → {ref, label, …}` map in the same pass; the map exists only in host memory and never reaches any model.

That rule is satisfied identically whichever model returns the key:

- the decision model's answer is validated against the action space built from **the observation that decision was made on** — not a later one, not a re-fetch;
- an index that is not in that table, or whose element does not support the decided operation, is refused;
- a `ref`, a selector, a coordinate or a script in that field is refused as a malformed decision, exactly as today;
- the dispatch still passes `canUseTool` and `runHostSideChecks`.

What the change removes is a *reconstruction* step, not a *check*.

## 3. The decision's answer

`intent` (prose, required for target-bearing operations) becomes `element` (an offered key, same requirement):

- `CLICK`, `HOVER`, `TYPE_TEXT`: `element` is an index string from the table — `"23"`.
- `SELECT`: `element` is `"<index>:<option>"` — the same composite key the offered criteria already use, so a select names both the control and the option in one field, as the selection request's own criteria always did.
- `NAVIGATE`, `SCROLL_*`, `WAIT`, `DONE`, `BLOCKED`: no `element`, refused if one is present — the existing rule for `intent`.

`evaluation` (added by `improve-jev-step-reasoning`) is unchanged and still required.

The instruction gains one sentence and loses one: name the element by its number from the table; never describe it in prose, and never invent a number the table does not show.

**Why keep a label in the step record**: the record already carries `target: {index, label}`, and the panel renders the label. The host fills it from the action space, so an operator still reads "Thông tin nhà thầu" rather than "23" — the label is host-derived, never model-supplied, so it cannot drift from what was executed.

## 4. What the fitting ladder was for, and what replaces it

`buildSelectionRequest` fits its request under `MAX_REQUEST_BYTES` by dropping elements from the tail, because Jev's input had a hard ceiling. With no selection request, that ladder has no caller on the step path.

The budget that matters now is the decision request's own (`MAX_DECISION_ELEMENTS_BYTES`, with its tail-drop and omission disclosure, from `improve-jev-step-reasoning`). The consequence to state rather than discover: **the decision can only name what its own fitted table showed.** An element dropped by that budget is not addressable this cycle, and the omission count already tells the model so. That was true of the selection request's ladder too; it is now true in one place instead of two.

## 5. Failure modes, all of them pre-existing paths

| the decision says | what happens |
|---|---|
| an index the table does not contain | the existing `target_unresolved` skip: nothing dispatches, one count toward no-progress, the loop continues |
| an index whose element cannot take the operation (TYPE_TEXT on a button) | same skip, same reason |
| `SELECT` naming an option the control does not offer | same skip |
| a `ref`, a selector, a CSS path, a coordinate | refused as a malformed decision, the existing one feedback retry, then the invalid-decision failure |

No new terminal outcome, no new event, no new reason string. `target_unresolved` keeps its meaning — "the step named something the observation does not offer" — and loses only the abstention half `improve-jev-step-reasoning` gave it, because there is no longer a distribution to abstain on.

## 6. What is deliberately deleted

- The per-step `POST /v1/systemone`, its retry, its size ladder and its answer validation on the step path.
- `TARGET_SELECTION` as a runtime instruction (the capability test keeps its own question, so the wire is still proven before a run).
- `SELECTION_CONFIDENCE_FLOOR` and `SELECTION_PROBABILITY_MARGIN`, and the abstention they produced. They were calibrated guesses against a distribution that no longer exists; keeping them would be keeping the machinery of a question nobody asks.
- The step record's `targetProbability`, `confidence`, `runnerUpProbability` and `targetAbstained` for target-bearing steps. They described the selection's certainty; there is no selection.

A run is one model call per step lighter and one round trip faster. That is a side effect, not the argument: the argument is that two of fourteen steps operated the wrong element and the transcript shows the decision naming the right one.

## 7. Non-goals

- **Asking Jev the watchers' questions** (`goal_done`, `stuck`). Worth doing, measured elsewhere, its own change — bundling it here would hide whether this change alone fixed the wrong-element problem.
- **Removing the `typesafe` provider.** Out of scope and not implied; what a `typesafe` profile means after this change is a product question, not a loop question.
- **Touching the SDK runtimes.** Untouched.

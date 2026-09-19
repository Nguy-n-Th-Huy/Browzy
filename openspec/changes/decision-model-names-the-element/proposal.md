# Proposal: the decision model names the element it already chose

## Why

Today a step costs two model calls and one lossy translation between them. The decision model looks at the observation and decides what to operate. It then has to describe that element **in prose** — "mục Thông tin nhà thầu trong menu Đấu thầu" — and Jev is asked to recover, from that prose, which of the offered elements was meant.

The information was never missing. Since `improve-jev-step-reasoning`, the decision model receives the same numbered element table Jev is offered: index, role, label, current value, state, and whether the control just appeared. It knows the element's number while it is writing a sentence that describes it, and the loop then spends a second request guessing that number back.

That round trip is a measured failure source. From the run recorded as `conv_d3bb74afe4104b5ae9` (19 September, 24 steps, abandoned by the operator), of fourteen target-bearing steps:

| step | the decision's intent | the element Jev resolved | confidence |
|---|---|---|---|
| 9 | "Thông tin nhà thầu trong menu Đấu thầu" | **"Đấu thầu"** — the parent menu | 0.47 |
| 13 | "mục Thông tin nhà thầu trong menu Đấu thầu" | **"Đấu thầu"** — the parent menu | **0.86** |

Two wrong elements in fourteen. The second at 0.86, which no confidence floor can catch: `improve-jev-step-reasoning` set the floor at 0.25 and even a floor of 0.7 would have dispatched it. The intent named a menu item; the run clicked the menu. Both times the operator watched it click the wrong thing while the transcript showed the model naming the right one.

This is not a verdict on Jev. Jev is asked the wrong kind of question. It is good at judging *which option best fits a situation* — a question whose answer nobody already has. "Which element did this sentence refer to?" is not that question: the caller already knows, and is asking Jev to reconstruct what the caller itself deleted.

## What Changes

- **The step decision names the element by its offered index.** `CLICK`, `TYPE_TEXT`, `SELECT` and `HOVER` carry `element` — one of the indices in the element table the decision was given — instead of a plain-language `intent`. A `SELECT` additionally carries the option, in the `<index>:<option>` form the offered key already uses.
- **The element-selection request leaves the step path.** No `POST /v1/systemone` per target-bearing step; no intent to resolve; no confidence floor and no top-two margin, because nothing is being guessed. One model call per step instead of two.
- **The safety invariant is unchanged, and this is the reason it can be unchanged**: the model's answer still carries only an *offered key*, never a selector, a coordinate, or a script. The mapping from an index to the code-owned `ref` stays where it has always been — in host code, built from the same observation the decision saw. What changes is which model answers with that key, not what a key is or what the host will accept.
- **An index the observation does not offer is refused, not resolved.** An unknown index, or an index whose element does not support the decided operation, is the existing target-unresolved skip: nothing dispatches, the step is recorded, it counts toward the no-progress bound, and the next decision sees the skip.
- **Unchanged**: the observation, the run memory and its revisions, the completion check, the stall guards, the bounds, the approval gate and every host-side check, the screenshot toggle, the final report, and the `anthropic`/`chatgpt` runtimes.

## What this leaves Jev doing, stated plainly

With element selection gone, a `typesafe` run makes **no Jev call per step**. The profile's Jev endpoint, key and source would then be exercised only by the capability test. That is a real consequence of this change and it should be read as one, not discovered later.

It is also the argument for the obvious follow-up, which is deliberately **not** in this change: ask Jev the questions the caller genuinely cannot answer. `jev-browser` (github.com/jkudish/jev-browser) asks three per step in one request — the action, plus two independent watchers, `goal_done` and `stuck` — and its own code explains why the independence matters: the questions cannot see each other's answers, "which is what makes goal_done an honest cross-check on the action rather than a rationalization of it". Those two watchers would replace two of this loop's LLM calls (the completion check and the stall consultation) with one fast, cheap structured call. That belongs in its own change, with its own measurement.

## Reversal notice

`2026-09-18-add-jev-run-context` pinned the opposite split — "everything except the click/element selection belongs to the configured model" — on the operator's own clarification. This change reverses the remaining half of it, at the operator's request and on the evidence above. It is recorded here so the reversal is deliberate rather than silent.

## Capabilities

### Modified Capabilities

- `typesafe-jev-provider`: the step decision names the element by offered index; the per-step element-selection request, the intent field, and the selection floor are removed; the offered-key safety rule is restated for the decision's own answer.
- `browser-assistant-panel`: a step row shows the element the decision named; there is no selection confidence or probability to show for it.

## Impact

- `host/agent/jev/text-helper.js` — `NEXT_STEP` and `parseStepDecision`: `element` replaces `intent`; the `<index>:<option>` form for `SELECT`.
- `host/agent/jev/runtime.js` — the selection request, the floor, the margin and their skip paths leave the step path; the decided index is validated against the cycle's own action space and mapped to a `ref` there.
- `host/agent/jev/questions.js` — `buildSelectionRequest` and `TARGET_SELECTION` lose their only runtime caller; the capability test keeps its own question.
- `host/agent/protocol.js`, `extension/sidepanel/*` — the step record's target fields and their labels.
- Tests: the Jev suites, `agent-typesafe-run`, and the side-panel suites.

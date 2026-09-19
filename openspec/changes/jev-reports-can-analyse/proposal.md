# Proposal: a Jev run's answer analyses instead of transcribing

## Why

The operator asked "phân tích chi tiết về nhà thầu này" and got back a faithful re-listing of the page: tax code, fax number, view count, then every figure the page displayed, in the page's own order, ending with three generic next steps. Every fact correct. No conclusion drawn.

The same request on an `anthropic` profile produced a twelve-section assessment: win rate computed two ways (35/42 = 83.3%, and 35/39 = 89.7% of decided packages), a pricing read (91.62% of estimate on average, 40% of wins only 1-5% below — wins on capability, not on price), a concentration risk (28 of 42 packages in one province, repeat customers in the maritime cluster), a contradiction worth flagging (registered for shipping and warehousing, actually selling Microsoft licences, LAN upgrades and servers), and a due-diligence checklist.

Both answers were written by a capable model. The difference is not intelligence. It is three properties of how this loop asks for the answer.

**1. The instruction forbids the inference that analysis is made of.** `FINAL_REPORT` says "Report ONLY what the provided material shows. Never invent a result, a page, a number, or a step that is not there." That rule exists to stop the run claiming outcomes it did not reach, and it must stay. But as written it also forbids *deriving* anything: "35 of 42 is 83%" is arithmetic on given facts, and the instruction reads as a prohibition on it. Two different prohibitions are fused, and only one of them is wanted.

**2. The report sees one page, not the run.** The final report's context carries `page` — the **last** observation, bounded at 10,000 characters — plus the memory's `notes` (600 characters) and ten recent action rows. Everything the run read on the way to that page is gone. A run that opened a listing, a filter and a detail page can only report on the last one.

**3. Length is capped at 4,000 characters for every answer.** The assessment the operator wants is several times that. Even with the material and the licence to reason, the answer would stop mid-way.

## What Changes

- **Facts and inferences are separated, not both banned.** Every *factual* claim in an answer must trace to the material the run was given — that rule is unchanged and is the one that matters. An *inference* — a ratio, a comparison, a pattern across the facts, a risk that follows from them — is allowed, and must be recognisable as an inference resting on named facts. The answer may never present a conclusion as something the page stated.
- **The answer sees the whole run.** Observations are accumulated across the run — bounded, oldest trimmed first, each keyed by the page it came from — and the report is written from that accumulation rather than from the final observation alone. The memory notes and the recent steps continue to ride along.
- **Length follows the goal.** A goal that asked for an action keeps today's short answer and today's bound. A goal that asked for analysis or a report gets a larger bound, sized to hold an assessment rather than a paragraph. The decision model already distinguishes the two (it chooses `DONE` for an informational goal "once the gathered material is enough for the requested analysis"); this makes the answer's own shape follow that same distinction.
- **An analysis leads with its conclusion.** For an analysis goal the answer opens with the judgment and its basis, then the evidence, then what could not be established. For an action goal the answer keeps today's order — what was accomplished, what was not, and why.

## Cost

Measured on the operator's own run of 19 September (10 steps): the step loop costs a median of 4,563 ms for the decision, 1,145 ms for the element selection and 165 ms for the dispatch. The answer call cost 8,945 ms for 2,949 characters.

This change adds **no call and no per-step cost**. Its only cost is that a longer answer takes longer to write — roughly 3 ms per character at the rate that run measured, so an assessment of ~10,000 characters lands near 30 seconds instead of 9. That cost is paid once, at the end, and only for the goals that asked for it: an action goal's answer stays exactly as fast as it is today.

## Capabilities

### Modified Capabilities

- `typesafe-jev-provider`: the run's answer is written from the run's accumulated observations rather than the last one; the no-fabrication rule is restated to permit stated inference; the answer's bound and shape follow the kind of goal.

## Impact

- `host/agent/jev/text-helper.js` — `FINAL_REPORT` and `COMPLETION_CHECK` instructions; a goal-kind-dependent report bound; the accumulated-observation projection in the report's context.
- `host/agent/jev/runtime.js` — accumulate bounded observations across the cycle, pass them to the report.
- Tests: `jev-text-helper`, `jev-runtime`, and the run-path suite.
- No change to the loop, the guards, the dispatch discipline, Jev, or the settings surface.

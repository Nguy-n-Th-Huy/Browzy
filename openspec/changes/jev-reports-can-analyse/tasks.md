# Tasks: a Jev run's answer analyses instead of transcribing

Depends on `jev-runs-answer-the-operator` (the final report) and `improve-jev-step-reasoning`.

## 1. Facts and inference

- [x] 1.1 `FINAL_REPORT` and `COMPLETION_CHECK` in `host/agent/jev/text-helper.js`: replace the blanket "report ONLY what the material shows" with the distinction — a factual claim must trace to the material; a ratio, comparison, pattern, risk or judgment the facts support is allowed and must name the facts it rests on; a conclusion is never presented as something the page stated.
- [x] 1.2 Keep, verbatim, the two rules that were never the problem: never claim an outcome the run did not reach, and never report a value the material does not contain.
- [x] 1.3 Test: both instructions carry the distinction and both keep the two preserved rules (string-level, like the existing instruction assertions).

## 2. The answer sees the whole run

- [x] 2.1 `host/agent/jev/runtime.js`: accumulate one bounded record per successful observation — page identity plus bounded text — deduplicated by identity+text so an unchanged page observed six times contributes once.
- [x] 2.2 Give the accumulation its own byte budget; when it does not fit, drop the OLDEST records first and disclose the omitted count in the context.
- [x] 2.3 `text-helper.js`: carry it in the final report's and the completion check's context, beside (not instead of) the current page. The step decision keeps carrying the current observation only.
- [x] 2.4 Tests: budget respected, oldest dropped first, duplicate page contributes once, omission disclosed, three distinct pages all reach the report's context, and the step decision's own request is unchanged in size and shape.

## 3. Length and shape follow the goal

- [x] 3.1 Raise the report bound to hold an assessment; keep one constant, not two code paths (output is timed by what is written, not by the ceiling).
- [x] 3.2 Both instructions: an action goal keeps today's order and brevity; an analysis/report goal opens with the conclusion and its basis, then the evidence, then what could not be established.
- [x] 3.3 Tests: the validator accepts an answer at the new bound and refuses one past it; the existing short-answer paths are unaffected.

## 4. Verification

- [x] 4.1 Run `jev-text-helper`, `jev-runtime`, `jev-questions`, `agent-typesafe-run`, and the side-panel suites.
- [ ] 4.2 (OPEN — needs a live run) Re-run the analysis goal that produced the transcription, on the same page, and record both answers side by side in the change's reports. The bar is whether the answer states a conclusion and names the facts under it — not its length.

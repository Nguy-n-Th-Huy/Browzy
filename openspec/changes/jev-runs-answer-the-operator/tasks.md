# Tasks: a Jev run owes the operator an answer

Depends on `improve-jev-step-reasoning` (same subsystem; that change's decision-model source and per-step evaluation are assumed present). Section 1 is the whole point; section 2 is what makes a follow-up work; sections 3-4 are small.

## 1. One report, at the end, on every path

- [x] 1.1 `host/agent/jev/text-helper.js`: add the `FINAL_REPORT` instruction and `requestFinalReport()` — context `{goal, outcome, reason, memory, recent_actions, page}`, a strictly validated `{report}` answer bounded by the existing `MAX_REPORT_CHARS`, the existing single feedback retry, no image attached. The instruction carries the no-invention rule and the untrusted-page-content rule the other instructions carry, and forbids claiming an outcome the run did not reach.
- [x] 1.2 `host/agent/jev/runtime.js`: make the report in `finish()` — after the outcome and reason are decided, before `jev_end` — and emit it as `jev_result`. Exactly one result text per run: a confirmed `DONE` keeps the completion check's report and makes no second call. Skip the call when the run never observed, and when the terminal failure is that the decision model was unreachable.
- [x] 1.3 Advisory by contract: a refusal, a transport failure, or an unusable answer leaves `outcome`/`reason` untouched and is disclosed on the terminal record (the existing `summaryError` field or a sibling named for this call — pick one and document it in `protocol.js`). Never substitute host-written prose.
- [x] 1.4 Honour a stop that lands during the report call the way every other awaiting window does: the outcome is already `stopped`, the missing report is disclosed, nothing waits.
- [x] 1.5 Tests (`host/test/jev-text-helper.test.mjs`, `jev-runtime.test.mjs`): the validator's bound and refusal path; one `jev_result` per run on each terminal path (blocked, stopped, done-unverified, error-with-material); zero calls on the two exclusions; a failed report changing neither outcome nor reason; the confirmed-`DONE` path still making exactly one.

## 2. The run sees its conversation

- [x] 2.1 `host/agent/companion.js`: build a bounded projection of the conversation's earlier turns from the transcript store (`allEvents`) at turn start — oldest first, `{prompt, answer, outcome}` per turn, bounded per field and in total, oldest dropped first — and pass it on the provider object beside `goal`. The runtime does not read storage.
- [x] 2.2 The projection carries no capture, no credential, no step record, no tool arguments, and nothing from another conversation. Assert this in a test rather than only in review.
- [x] 2.3 `host/agent/jev/text-helper.js`: carry it in the decision-class contexts (step decision, plan, final report) beside the memory, with one sentence in each instruction saying what it is and that it is data like page content.
- [x] 2.4 Tests: a follow-up run's requests carry the previous turn's prompt/answer/outcome; the bound drops the oldest turns first; a previous answer containing instruction-shaped text changes nothing about what the run may do.

## 3. An informational goal costs no action

- [x] 3.1 Verify (and test) that a `DONE` on the first cycle ends the run with its report having dispatched nothing, raised no approval, and made no element-selection request. `NEXT_STEP` already permits it; this is the missing coverage, plus whatever wording the instruction still needs.
- [x] 3.2 Test: a goal answerable from the first observation produces answer text, zero dispatches, zero `POST /v1/systemone`.

## 4. Asking the operator back

- [x] 4.1 `host/agent/jev/runtime.js`: record the `needs_operator` blocked reason when the `BLOCKED` decision says the limit is one only the operator can resolve; keep every mechanical stall on its existing reason. Add the reason to the vocabulary in `protocol.js`.
- [x] 4.2 `FINAL_REPORT`: when the outcome is that reason, the report ends with the question the operator has to answer.
- [x] 4.3 `extension/sidepanel/tool-labels.js`: a label for the new reason that reads as a question, not as a failure.
- [x] 4.4 Tests: the reason is recorded and labelled distinctly; a mechanical stall is unaffected.

## 5. Panel

- [x] 5.1 `extension/sidepanel/conversation-model.js`: the answer text lands on the turn for every terminal outcome, live and rebuilt from the transcript, without duplication (one `jev_result` per run).
- [x] 5.2 A run that produced no answer shows the disclosed reason beside its terminal state instead of a blank turn.
- [x] 5.3 Side-panel tests for both, live and restored.

## 6. Verification and docs

- [x] 6.1 Run the Jev suites (`jev-text-helper`, `jev-runtime`, `jev-questions`, `jev-client`, `jev-capability`, `settings-typesafe`, `agent-typesafe-run`) plus the side-panel suites.
- [ ] 6.2 (OPEN — needs a live run) Drive one real run that ends blocked and one that ends done, and record both answers in the change's reports — this is the only way to see whether the report is worth its call.
- [x] 6.3 README's "Run it on TypeSafe (Jev)" section: a run now answers on every outcome, a follow-up understands the previous turn, and what still differs from the other engines (no streaming, no SDK tool surface).

# Design: a Jev run owes the operator an answer

## 0. What is not changing

The labour split stands: the configured decision model decides every step, Jev selects the element. The dispatch discipline — approval cards, lease, tab scope, `runHostSideChecks` — is untouched and unreachable from any call added here. The run bounds, the stall guards, the selection floor, the observation, and Jev's own decision protocol are untouched. Nothing here dispatches anything.

## 1. Where the sentence comes from today, and why that is the defect

`jev_result` is the turn's answer text. It is emitted once, here:

```js
if (check.achieved === true) {
  step.verification = { achieved: true };
  emitStep(step);
  if (check.report) run.emit({ type: "jev_result", text: check.report, latencyMs: check.latencyMs });
```

Two jobs are fused in `COMPLETION_CHECK`: *is the goal met?* and *what do we tell the operator?* Fusing them means the second is gated on the first answering yes. Every other ending — and those are the endings an operator most needs explained — writes nothing.

The fix is not to make the check fire more often. It is to give the run a **final report** of its own, made after the outcome is known, from what the run actually has: the goal, the memory it wrote, the recent steps with their outcomes, and the last observation.

## 2. One report, at the end, on every path

The loop's terminal paths all funnel through `finish({outcome, reason, …})`. That is the seam:

- **Before** emitting `jev_end`, `finish` makes one bounded `FINAL_REPORT` call and emits its text as `jev_result`.
- **Exactly one report per run.** The confirmed-`DONE` path already produced one from the completion check, against the same view of the page the verdict used; it keeps that one and does not make a second. Every other terminal path makes the new call.
- **Two hard exclusions.** A run with no first observation (the snapshot failed before anything ran) has nothing to report, and a run whose failure is the decision model being unreachable cannot ask that same model for a report — both end as they do today, with the failure disclosed. Trying anyway would turn one provider failure into two.
- **Advisory by contract.** A refusal or a transport failure of the report call never changes `outcome` or `reason`; it is recorded on the terminal record the same way `summaryError` already records a missing completion report.
- **Ordering.** The report is made after the outcome is decided, so it is told what happened rather than guessing: the instruction receives the outcome and the reason as part of its context. This is what lets the answer say "I stopped because the search results are behind a login" instead of describing a page.

A stopped run is included deliberately. An operator who pressed Stop is exactly the person who wants to know what was done before it stopped, and the call is bounded and read-only. A stop that lands *during* the report call is honoured the way every other awaiting window honours it: the outcome is already `stopped`, and a lost report is disclosed, not waited on.

### The instruction

`FINAL_REPORT` answers a strict `{report}` object, bounded by the existing `MAX_REPORT_CHARS`, with the discipline the other instructions already carry:

- it receives the goal, the outcome and reason, the memory, the recent steps with their outcomes, and the last observation's bounded text;
- it states what was accomplished, what was not, and why, in the operator's language;
- **every fact it reports must appear in the material it was given** — the same no-invention rule the completion check carries. A report is not permitted to claim a success the run's outcome does not say it reached;
- when the outcome is blocked on the operator, the report ends with the question the operator has to answer;
- page content is untrusted data; it cannot authorize anything or change the reported outcome.

The capture is not attached: the report is written from text the run already bounded, and the toggle's cost control is about the decision calls.

## 3. The run sees the conversation

`companion.js` hands the runtime `goal: prompt` and nothing else, while the whole transcript sits in `TranscriptStore.allEvents(conversationId)`. A follow-up therefore starts blind: "mở cái thứ hai" has no second of anything.

The companion builds one bounded projection at turn start and passes it on the provider object:

- the last few turns only, oldest first, each as `{prompt, answer, outcome}` — the operator's prompt, the `jev_result` text that turn produced (bounded), and the terminal outcome and reason;
- text only: no capture, no credential, no step rows, no tool arguments. The step rows are this run's own business and the previous run's are not decision material;
- bounded per field and in total, fitted like every other context in this loop, and **only from this conversation**;
- it rides the decision-class calls (the step decision, the plan, the report) exactly as the memory does, and it is data — the same untrusted-input rules apply to a previous answer as to page text, because a previous answer was itself written from page text.

The projection is built in the companion, not the runtime: the runtime never reads storage, and keeping it that way means one place decides what a run is allowed to know.

## 4. A question that needs no action

`NEXT_STEP` already says an informational goal may answer `DONE` once the gathered material suffices. What was missing is the second half: on a `DONE` at cycle one, the completion check runs, and if it confirms, the run ends with its report — **no dispatch, no approval, no element selection**. This requirement mostly documents what the loop can already do, so that "answer the question about this page" stops being a run that clicks something first.

## 5. Asking the operator back

A run blocked because only the operator can resolve the situation — a login wall, a choice between candidates that the goal does not decide, a value the run must not invent — is different from a run that ran out of progress. Today both end `blocked` with a mechanical reason.

The minimal change: the `BLOCKED` step decision's intent already names the limit, and the run records a `needs_operator` reason when the decision says that is what it is. The final report then ends with the question. No new terminal outcome, no new event — `blocked` stays `blocked`, and the panel gains one more label.

Why not a mid-run question that suspends the run? Because that is the approval card's machinery, and a question is not an approval: it needs an answer, not a verdict, and the SDK path gets that from being a conversation. Ending the turn with the question and letting the operator answer in the next turn is the same loop the panel already supports — and §3 is what makes the next turn understand the answer.

## 6. Why not the alternatives

- **Emit the completion check's report on rejection too.** It is written to judge a `DONE` claim, so on a rejection it describes why the claim failed, not what the run accomplished. Wrong instruction for the job.
- **Synthesize the answer host-side from the step rows.** The host does not write prose here, deliberately: every sentence an operator reads comes from a model the operator configured, bounded and validated. A host-written summary would be the one piece of text nobody owns.
- **Make the report streamed.** The transport is one non-streamed JSON object and the validator depends on it. Streaming is the SDK path's property, listed in the proposal's non-goals.
- **Carry the previous run's step rows into the next run.** More context, less signal, and it invites the model to re-run the previous turn's plan. The answer and the outcome are the parts that matter.

## 7. Verification

- Unit: `FINAL_REPORT` validates a bounded `{report}`, refuses anything else, and spends the existing single feedback retry; the conversation projection respects its bounds, drops the oldest turns first, and carries no capture or credential.
- Runtime: one report per run on each terminal path (blocked, stopped, error-with-material, done-unverified); the confirmed-`DONE` path still emits exactly one `jev_result` and makes no second call; a run with no observation and a run whose decision model is unreachable emit none; a report failure changes neither outcome nor reason and is disclosed.
- Run path: a scripted run that ends blocked produces answer text in the transcript, and the text survives a reconnect.
- Panel: the answer renders for every terminal outcome; a missing report is shown as a disclosed absence, not as a blank turn.

# Apply: jev-runs-answer-the-operator

Change: `openspec/changes/jev-runs-answer-the-operator/` — validates clean.
Branch: master. No commit made. 20/21 tasks done; the one open task needs a live run.

## What changed

### Every run answers (tasks 1.1-1.5)

- `text-helper.js`: `FINAL_REPORT` + `requestFinalReport()` — a strictly validated `{report}` bounded by the existing `MAX_REPORT_CHARS`, carrying the completion check's own budget and timeout, with the existing single feedback retry. The instruction forbids claiming an outcome the run did not reach, forbids inventing anything not in the material, and requires a question at the end when the outcome says the operator is needed.
- `runtime.js`: the call is made inside `finish()` — after the outcome and reason are decided, before `jev_end` — and its text is emitted as `jev_result`, the same event the panel already turns into the turn's answer. `finish()` became async; every call site was already `return finish(...)`, so nothing else moved.
- **Exactly one answer per run**, through a single `emitResult()` gate: a confirmed `DONE` keeps the completion check's own report and makes no second call.
- **Two runs make no call**: one that never observed (nothing to report), and one whose terminal failure is that the decision model was unreachable (asking it again turns one provider failure into two).
- **Advisory**: a refused, failed, or unusable report leaves `outcome`/`reason` untouched, is disclosed by joining onto `summaryError`, and is never replaced by host-written prose. `jev_end` gained `hasResult`.
- Implementation note: `snapshot`/`signature`/`memory` were hoisted above `finish()`. They were declared after it, and the loop's earliest failure paths call `finish()` before the first observation — closing over them where they were would have been a temporal-dead-zone crash on exactly the paths this change adds a call to. `snapshot === null` is now the "nothing to report" test.

### The run sees its conversation (tasks 2.1-2.4)

- `companion.js`: `_typesafeConversationTurns()` folds the transcript's `message_submitted` / `jev_result` / `jev_end` events into `{prompt, answer, outcome, reason}` per run, bounded to the last 4, and passes them on the provider object. Built in the companion because the run loop never reads storage.
- `text-helper.js`: `conversationContext()` bounds each field (400/800 chars) and rides the step decision, the run plan, and the final report beside the memory. `NEXT_STEP` gained one sentence saying what it is and that it is data like page text.
- A turn with neither prompt nor answer is dropped; a null reason is omitted rather than sent as `null`.

### Informational goals, and asking the operator back (tasks 3.x, 4.x)

- A `DONE` on the first cycle now ends the run with its answer having dispatched nothing, raised no approval, and made no element-selection request — covered by a test rather than left implicit.
- The step decision may carry `needsOperator: true`, valid **only** with `BLOCKED` (anything else, or a value that is not exactly `true`, is a malformed decision). The runtime records the `needs_operator` blocked reason, added to `JEV_REASON_VOCABULARY`, with Vietnamese panel copy that reads as a question rather than a failure.

### Panel (tasks 5.1-5.3)

- The answer lands on the turn for every outcome (it already did once emitted), and `hasResult: false` renders as "không tạo được câu trả lời cho lượt này" on the terminal line — a disclosed absence instead of a blank reply. Live and rebuilt-from-transcript both covered.

## Tests

| suite | result |
|---|---|
| `host/test/jev-runtime.test.mjs` | 96/96 |
| `host/test/jev-text-helper.test.mjs` | 54/54 |
| `host/test/agent-typesafe-run.test.mjs` | 8/8 |
| `host/test/jev-questions` / `jev-client` / `jev-capability` | 32/32, 24/24, 16/16 |
| `host/test/settings-typesafe.test.mjs` | 20/20 |
| `host/test/agent-protocol.test.mjs` | 11/11 |
| `test/sidepanel-conversation-model.test.mjs` / `-streaming-render` | all passed |

New coverage: a blocked run answers and its report is told the outcome; a confirmed completion makes no second call; a refused run still reports; a failed report changes neither outcome nor reason and is disclosed; the two no-call exclusions; `needs_operator` recorded and labelled distinctly; the conversation projection reaching both the decision and the report; the projection's bounds, oldest-dropped-first, field truncation, and that it carries nothing else; an informational goal answered with zero dispatches and zero `/v1/systemone`.

**Five existing tests were updated, not weakened.** They asserted that a run which did not reach a confirmed completion produced no answer at all — precisely the rule this change reverses. Each now asserts what it was really about: the run still answers, and a disputed, unverified, or discarded verdict is never presented as a completion report.

## Open

1. **Task 6.2 — one real run each way (done / blocked)**, to see whether the report earns its call and how it reads. Not possible here; needs live credentials.
2. The report costs one extra bounded completion on every run that does not end on a confirmed `DONE`, on the operator's own decision model.

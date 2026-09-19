# Design: Completion Check Timeout

## Context

- `postJson` aborts each attempt at `timeoutMs` (`DEFAULT_TIMEOUT_MS = 25_000`, ported from the reference's short structured calls) and a transport failure gets one repeat — so the live failure burned ~50 s across two attempts before surfacing "timed out".
- `requestCompletionCheck` currently calls the shared builder without a timeout override, so the analysis-length call inherited the short-call ceiling. The step decisions, plan, revisions, and recoveries are small structured objects (measured live at 2–4 s) and fit the 25 s ceiling comfortably.

## Goals / Non-Goals

**Goals:** a page-sized analysis has a realistic generation window on the one call that produces it; every other call is untouched; a truly hung provider still aborts and the existing honest fallback stands.

**Non-Goals:** no change to retries, to the fallback semantics, to other timeouts, or to instruction/validators; no streaming; no requirement text changes (`skip_specs`).

## Decisions

### 1. `COMPLETION_CHECK_TIMEOUT_MS = 120_000`, only for the completion check

`requestCompletionCheck` passes `timeoutMs: COMPLETION_CHECK_TIMEOUT_MS`; every other caller keeps the default. Rationale: the check emits the entire analysis (up to the 4,000-character bound) in one non-streamed JSON response; the observed failure was this exact call aborting twice at 25 s. Two minutes covers a large model writing a long Vietnamese report through a gateway while still bounding the wait; the transport repeat remains, so the worst case is bounded at ~4 minutes on a genuinely hung endpoint — an acceptable price for the run's terminal verification, and the fallback path (done, unverified, failure recorded) is unchanged if it still cannot answer.

- *Alternatives rejected*: raising `DEFAULT_TIMEOUT_MS` globally (every small call would wait far too long before failing); shrinking the report bound back (contradicts the analysis goals the loop now serves); dropping the retry for the check (a single transient drop would leave every analysis unverified).

### 2. Tests

`host/test/jev-text-helper.test.mjs`: the exported constant is pinned at 120,000; the completion-check request's transport call is observed to receive it (via the suite's fetch doubles / injectable seams) while a step-decision or plan call is observed to keep the default; a timed-out check still yields the unchanged fallback shape (done + summaryError + verification `achieved: null`) at the runtime level (existing coverage re-run).

## Risks / Trade-offs

- **[A hung check now takes up to two minutes per attempt]** → one DONE per verification cycle, bounded attempts; the operator can Stop at any time, and the wait is visible as the run's working state.
- **[The gateway's own timeout is shorter]** → its error surfaces verbatim, unchanged from today.

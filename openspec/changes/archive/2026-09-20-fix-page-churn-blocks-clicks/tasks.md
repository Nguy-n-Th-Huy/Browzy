## 1. Separate evidence quality from dispatch authorization

- [x] 1.1 In `captureStepEvidence()` in `host/agent/jev/runtime.js`, keep computing whether the capture still depicts the observation and keep recording `screenshot: { status: "unavailable", reason: "stale_capture" }` when it does not, but stop letting that answer decide whether the dispatch may proceed.
- [x] 1.2 Make the post-capture condition that `dispatch()` acts on operation-aware: for an operation with an observed target (`CLICK`, `TYPE_TEXT`, `SELECT`, `HOVER`) require only a successful re-read, an unchanged document identity, and an unchanged target state — remove the whole-page signature comparison for these. For a targetless operation (`WAIT`, `SCROLL_UP`, `SCROLL_DOWN`), which has no target row to compare, keep the whole-page signature comparison in this post-capture condition exactly as before, since it is the only thing left that can judge its surroundings once the capture's own re-read has run.
- [x] 1.3 Leave the `dispatch()` preflight untouched in every respect: document identity, URL, the full `identityFields` target comparison, the prepared-record check, the whole-page signature branch governing targetless operations, and the existing NAVIGATE exemption. ← (verify: a diff of the preflight block shows no semantic change, and `WAIT` / `SCROLL_UP` / `SCROLL_DOWN` keep their current staleness behaviour)
- [x] 1.4 Update the surrounding comments so they record the two separate invariants — what the picture may claim, and what authorizes the mutation — in the prose style the file already uses for invariants. ← (verify: comments state the invariants and contain no plan, phase or change identifiers)

## 2. Make an abandoned dispatch diagnosable

- [x] 2.1 Give every path in `dispatch()` that returns a stale result a bounded host-authored code naming the condition that tripped: the re-read failed, the document changed, the URL changed, the target changed, a prepared record is no longer valid, the whole-page signature changed for a targetless operation, or the capture no longer depicts the observation.
- [x] 2.2 Carry the refusal reason that `dispatch()` already computes on its denied path through to the caller instead of discarding it.
- [x] 2.3 Surface both on the emitted step record alongside `skippedReason`, using the file's existing conventions for bounded host-authored fields. ← (verify: the codes are fixed host-authored strings and no page text, field value or tool error text can reach them)

## 3. Regression coverage

- [x] 3.1 In `host/test/jev-decision-runtime.test.mjs`, add a test where screenshots are enabled and the page changes away from the target during evidence capture: the CLICK dispatches, and the step's evidence records the screenshot as unavailable with `stale_capture`.
- [x] 3.2 Add a test where screenshots are enabled and the target's own state changes during evidence capture: the CLICK is still skipped as `stale_observation`.
- [x] 3.3 Confirm the existing test `approval refresh rejects a changed submission even when the submit button is unchanged` still passes with no modification to it. ← (verify: this test is byte-identical to its pre-change form and passes)
- [x] 3.4 Assert each new stale reason code in a test, so a rename or removal fails the suite.
- [x] 3.5 Add a test asserting the denied path records its host-authored refusal reason on the step.
- [x] 3.6 Add a test where screenshots are enabled, the candidate is a targetless operation (`WAIT` or `SCROLL_*`), and the page gains an unrelated element during evidence capture: the step is still skipped as `stale_observation` with `staleReason: "stale_capture"`, proving the whole-page term was not dropped for targetless operations. ← (verify: this test fails against the pre-fix `captureStepEvidence()`)

## 4. Validation

- [x] 4.1 Run `node host/test/jev-decision-runtime.test.mjs` from the workspace root and confirm every test passes, including the pre-existing staleness tests.
- [x] 4.2 Run `node host/test/jev-runtime.test.mjs` from the workspace root and confirm every test passes. Note that `npm test` inside `host/` does not cover either file, so it is not evidence for this change.
- [x] 4.3 Confirm each new test in group 3 fails against the pre-change behaviour, so the suite is load-bearing rather than merely green.
- [x] 4.4 Run `openspec validate fix-page-churn-blocks-clicks --strict` and resolve any reported issue. ← (verify: both jev test files pass in full, the new tests are proven load-bearing, and the delta spec validates; report, do not fix, any failure originating outside `host/agent/jev/runtime.js` and `host/test/jev-decision-runtime.test.mjs`)

## 1. Bound the stuck diversion

- [x] 1.1 In `host/agent/jev/runtime.js`, track whether the current plan revision was produced by a stuck-triggered planning consultation and whether any action has dispatched under that revision. Reset the marker whenever an action dispatches and whenever a plan revision is produced by any other trigger.
- [x] 1.2 Split the `operation === OPERATIONS.REPLAN || decision.stuck` branch so an explicitly selected `REPLAN` always consults planning as it does today, while a positive `stuck` withholds the selected action only when the marker from 1.1 says this plan revision has not already been revised for stuck without a dispatch since.
- [x] 1.3 Keep the skipped-step record, the `skipped_reason: "replan"` history row and the replan budget accounting unchanged for every diversion that still happens, so `replan_limit` and the no-progress guards behave exactly as before for the cases they still cover. ← (verify: a run whose every decision is an explicit REPLAN with no page change still ends `blocked / replan_limit`, and the emitted step still carries `skippedReason: "replan"`)

## 2. Let a prepared navigation dispatch against a moving page

- [x] 2.1 In the pre-dispatch preflight inside `dispatch()`, exempt `operation === OPERATIONS.NAVIGATE` from the document-identity, URL and observation-signature equality conditions, leaving the `validPrepared` unconsumed-record condition in force. Do not change the conditions applied to any other operation, including the targetless `WAIT` and `SCROLL_UP` / `SCROLL_DOWN`.
- [x] 2.2 In `captureStepEvidence()`, let a `NAVIGATE` dispatch proceed when the capture is no longer fresh, recording the screenshot as `{ status: "unavailable", reason: "stale_capture" }`; every other operation keeps treating a non-fresh capture as a refusal. ← (verify: with screenshots enabled and the page mutating during capture, NAVIGATE dispatches and its step evidence reports the stale capture, while CLICK in the same situation still skips)
- [x] 2.3 Extend the surrounding comments in the two touched blocks to state why a page-independent prepared URL has a different precondition than an observed target, matching the file's existing style of recording the invariant rather than the edit. ← (verify: comments describe the invariant and contain no plan, phase or change identifiers)

## 3. Regression coverage

- [x] 3.1 In `host/test/jev-decision-runtime.test.mjs`, add a test reproducing the incident: the plan prepares a navigation URL, every decision selects `NAVIGATE` with `stuck: yes`, and the run dispatches `navigate` instead of ending `blocked / replan_limit`.
- [x] 3.2 Assert in that test that the observation after the dispatch reports the new URL and that the step records the page change, covering the operator-visible half of the bug.
- [x] 3.3 Add a test that an explicitly selected `REPLAN` with no progress still ends `blocked / replan_limit`.
- [x] 3.4 Add a test that `NAVIGATE` dispatches when the page moves between the decision and the dispatch, where the current code skips with `stale_observation`.
- [x] 3.5 Add a test that a targeted `CLICK` in the same page-changed situation still skips with `stale_observation`. ← (verify: this test fails if the NAVIGATE exemption was written as a general targetless exemption instead of an operation-specific one)

## 4. Validation

- [x] 4.1 Run `node host/test/jev-decision-runtime.test.mjs` from the workspace root and confirm every test passes, including the pre-existing staleness tests.
- [x] 4.2 Run `node host/test/jev-runtime.test.mjs` from the workspace root and confirm every test passes. Note that `npm test` inside `host/` does not cover either file, so it is not evidence for this change.
- [x] 4.3 Run `openspec validate fix-stuck-monitor-blocks-navigation --strict` and resolve any reported issue. ← (verify: both jev test files pass in full and the delta spec validates; report, do not fix, any failure originating outside `host/agent/jev/runtime.js` and `host/test/jev-decision-runtime.test.mjs`)

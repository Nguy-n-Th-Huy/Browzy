# Proposal: Completion Check Timeout

## Why

Seen live, right after the report bound was raised so a real analysis could be delivered: the run "Phân tích nội dung trang này giúp mình." ended `done` with **`doneVerified: false`** and `summaryError: "the provider request timed out: This operation was aborted"`. The completion check — now asked to produce a page-sized analysis — ran into the shared **25-second** transport timeout (`DEFAULT_TIMEOUT_MS`, sized for the reference's short structured calls), timed out, was retried once, timed out again (~50 s), and the run fell back to the unverified outcome with no report. The one call whose output is a long analysis cannot share the short-call timeout.

## What Changes

- **The completion check gets its own timeout**: `COMPLETION_CHECK_TIMEOUT_MS = 120_000` passed through `requestCompletionCheck` to the transport, while every other configured-model call keeps `DEFAULT_TIMEOUT_MS` (25 s). A 4,000-character Vietnamese analysis can take well over 25 s to generate on a large model through a gateway; two minutes is a real ceiling for that one call, and the existing transport retry is unchanged.
- **Unchanged**: every other timeout, the retry policy, the fallback semantics (a still-timed-out check keeps the done outcome, records the failure, and discloses the judgment-alone completion), and all instruction/validators.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- (none — a timeout value is implementation-level; the change is marked `skip_specs: true`. The existing "completion check cannot be made" scenario continues to describe the fallback.)

## Impact

- **Host**: `host/agent/jev/text-helper.js` (`COMPLETION_CHECK_TIMEOUT_MS`, wired only into `requestCompletionCheck`) and `host/test/jev-text-helper.test.mjs`.
- **Docs/specs**: none.

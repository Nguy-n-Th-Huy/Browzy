## Why

A click on a real, busy web page is cancelled forever. Before every dispatch the runtime captures a screenshot and then re-reads the page, and it lets the action proceed only when the entire observation — the URL, the scroll position, every element's label, role, value and state, and the page text — is byte-identical across that capture. The capture takes roughly two seconds. Any page that rotates an advertisement, lazy-loads a widget or refreshes a counter in that window fails the comparison, and the action is skipped as a stale observation on every attempt.

This is observed, not theoretical. Run `run_7b574760ad6e1d8409` (conversation `conv_fef5509858bc1ac23f`) navigated to `dauthau.asia`, opened a menu, clicked through to the supplier list and typed a search query — four dispatches, all successful. It then tried to click the "Tìm kiếm" submit button and was skipped with `stale_observation` fourteen consecutive times before ending `blocked / action_denied`. Every other explanation was eliminated from the log: the document identity held (all reads in the window shared one document), the URL never changed, the click carried no prepared record, and the target's own identity was measured directly on the live page across typing, focusing, scrolling and six seconds of idling without a single difference. Measuring the page at rest — no typing, no interaction — showed its interactive element count drifting from 661 to 660 within three and a half seconds. The page is simply never byte-identical to itself.

The freshness value that gates the dispatch answers two unrelated questions at once: whether the screenshot faithfully depicts the observation, which is a question about evidence quality, and whether the action may still be dispatched, which is a question about authorization. Page movement away from the target affects only the first, yet currently blocks both. The target's own integrity is already protected twice over — by the target-state comparison inside that same freshness check, and by the full identity comparison in the pre-dispatch preflight.

A second defect made this expensive to find: none of the three paths that abort a dispatch as stale records which condition tripped, and the denial path discards the reason it already has. The step event says only `stale_observation`, so the cause had to be reconstructed by re-measuring the live page in a browser instead of read from the log.

## What Changes

- The pre-dispatch evidence capture stops using whole-page equality as an authorization gate. A capture that no longer matches the observation is still recorded as `screenshot: { status: "unavailable", reason: "stale_capture" }`, but that alone no longer cancels the dispatch.
- After the capture, a dispatch proceeds when the re-read succeeded, the document identity is unchanged, and the selected target's own state is unchanged. Unrelated page movement no longer participates in that decision.
- The pre-dispatch preflight is unchanged in every respect: document identity, URL, the full target identity comparison, the prepared-record check, the whole-page signature branch that still governs the targetless `WAIT` and `SCROLL_UP` / `SCROLL_DOWN`, and the existing `NAVIGATE` exemption all keep their current behaviour.
- Every path that aborts a dispatch as stale carries a bounded host-authored code naming the condition that tripped, and the denial path carries its host-authored refusal reason. Both surface on the step record alongside `skippedReason`.
- Those codes are host-authored classifications only. They never echo page content, field values or tool error text.

No breaking changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `jev-decision-layer`: the requirement "Jev selects complete fresh actions" gains a statement that a targeted dispatch is invalidated by the target's own state, not by unrelated movement elsewhere on the page; the requirement "Decision attribution is observable" gains a statement that a skipped or denied dispatch records which host-authored condition caused it.

## Impact

- `host/agent/jev/runtime.js` — the pre-dispatch evidence capture, the stale and denied return paths, and the step record they feed.
- `host/test/jev-decision-runtime.test.mjs` — regression coverage for the click that must now succeed, for the target-state change that must still be refused, and for each new reason code.
- `openspec/specs/jev-decision-layer/spec.md` — delta for the two requirements above.

Out of scope, and deliberately so: the `dispatch()` preflight itself; `observationSignature()` and the no-progress and repeated-no-change guards that use it; the extension's snapshot construction, visibility test and ref assignment; the approval gate, the host-side checks, and the approval grant and gate verdict lifecycle; and the run bounds.

**A known limitation, stated rather than guessed at:** the fifteenth attempt in the incident ended `action_denied` rather than stale, and this change does not fix that. The log holds no rejected-dispatch record and no stored reason, so the cause is not proven. Shipping a guessed fix for it would be a shortcut, not a root-cause repair. The reason-recording work above is what makes that path diagnosable the next time it occurs; until then it stays open. It is also plausible that it never recurs, since it only appeared after fourteen spurious stale aborts that this change removes.

## Why

A run whose tab starts on a page unrelated to the goal can never reach the site the goal names. The `stuck` monitor answers "yes" honestly on every cycle — no useful progress is possible on the wrong page — and that answer discards the NAVIGATE action the same decision selected, so the run replans the identical plan until its budget is spent and ends `blocked / replan_limit`.

This is observed, not theoretical. Run `run_ba35d305067cf0f2d9` (conversation `conv_b7e3bc104b21fb1470`) asked for a supplier profile on `dathau.asia` from a tab showing a Brave marketing page. All four plan revisions prepared the correct URL, all four decisions selected `NAVIGATE` with an action probability of 0.96–1.00 and a confidence of 0.95–0.99, and all four were skipped with `skippedReason: "replan"` because `stuck` was positive at confidence 0.46 and 0.37. No step ever carried `tool: "navigate"`; the browser never left the original page.

## What Changes

- The `stuck` monitor may divert a selected executable action into replanning **at most once per plan revision**. When `stuck` is positive, the selected operation is executable, and the current plan revision was itself produced by a stuck-triggered replan with no dispatch since, the action executes instead of triggering another identical replan.
- An explicit `REPLAN` operation keeps today's behaviour exactly: it always replans and remains bounded by the replan budget.
- The pre-dispatch staleness preflight stops requiring a byte-identical page for `NAVIGATE`. A prepared navigation URL is independent of the page's content, so its only preconditions are that the prepared record is still unconsumed and the destination differs from the current URL.
- A pre-dispatch screenshot that no longer matches the observation degrades the recorded evidence for `NAVIGATE` instead of cancelling the dispatch.
- Every other operation — `CLICK`, `TYPE_TEXT`, `SELECT`, `HOVER`, and the targetless `WAIT` / `SCROLL_UP` / `SCROLL_DOWN` — keeps its current staleness rules unchanged.

No breaking changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `jev-decision-layer`: the requirement "Monitors advise guarded control flow" gains a bound on how long a positive `stuck` judgment may withhold an executable action, and the requirement "Jev selects complete fresh actions" states that a targetless prepared navigation is not invalidated by unrelated page movement.

## Impact

- `host/agent/jev/runtime.js` — the only behavioural change: the stuck-diversion branch of the decision loop, the pre-dispatch staleness preflight, and the pre-dispatch evidence capture.
- `host/test/jev-decision-runtime.test.mjs` — regression coverage for the loop that could not escape and for the staleness rules that must not change.
- `openspec/specs/jev-decision-layer/spec.md` — delta for the two requirements above.

Out of scope: the `ACTION_PLAN`, `NEXT_ACTION` and `NEXT_STEP` prompts (the incident log proves they behaved correctly), any confidence threshold on the `stuck` head, the run bounds `MAX_REPLANS_WITHOUT_PROGRESS` / `MAX_MEMORY_UPDATES` / `MAX_RECOVERIES` / `NO_PROGRESS_LIMIT`, the staleness rules of targeted operations and of `WAIT` / `SCROLL_*`, and the extension side (`extension/background.js`, `extension/content.js`, side panel UI).

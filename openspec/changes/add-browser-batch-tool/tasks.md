## 1. Schema

- [x] 1.1 Add `browser_batch` to `TOOLS` in `host/tool-definitions.js`: `actions` as a non-empty ordered list of `{ name, input }`.
- [x] 1.2 Write the description: sequential execution, stops on first error, cannot be nested; coordinates refer to the screenshot taken before the batch; `find` belongs before a batch rather than inside it; actions needing the user's approval must be issued on their own. ← (verify: description states the pre-batch coordinate rule and the send-class exclusion — a model that does not know these will write bad batches)

## 2. Policy — the security-critical part

- [x] 2.1 In `host/agent/tools/mapping.js`, add a pre-flight that walks a batch's items and classifies each with the existing `classifySendClassCall()`. Do not write a second classifier.
- [x] 2.2 Reject the whole batch, before any item executes, if any item classifies as anything other than `allow` — naming the item's position and tool, and stating it must be issued on its own.
- [x] 2.3 Reject a batch containing a batch.
- [x] 2.4 Apply `TAB_TARGET_ARG_KEYS` / borrowed-tab scope to each item's own tab argument, not just to the batch call.
- [x] 2.5 In `host/agent/policy/can-use-tool.js`, make the gate see inside a batch instead of treating it as one opaque call, and ensure no approval issued for a batch is usable by a send-class action within it. ← (verify: read `test/approval-gate.test.mjs`, `test/approval-evidence-binding.test.mjs` and `test/send-class-classifier.test.mjs` first; every existing assertion must still hold unchanged after this edit)

## 3. Executor

- [x] 3.1 In `extension/background.js`, add the `browser_batch` handler: iterate items in order, dispatching each through the existing `toolHandlers` entry for its name — no duplicated per-tool logic.
- [x] 3.2 Sample the page URL and the focused element before and after each item.
- [x] 3.3 Stop after any item that errors, changes the URL, or changes focus. Do not run later items.
- [x] 3.4 Return the results of the items that ran, plus which item stopped the batch and which of the three conditions stopped it — a partial batch must be distinguishable from both a complete one and a failed one. ← (verify: a stopped batch's response identifies the stopping item and reason, and carries the earlier items' real results)
- [x] 3.5 Confirm a ref that went stale mid-batch surfaces the existing resolve/hit-test error and thereby stops the batch — no new staleness handling should be needed. ← (verify: no new ref-validation code was added; the existing `resolveRefToCoordinates` path is what catches it)

## 4. Prompt

- [x] 4.1 In `renderBrowserAutomationSystemPrompt()`, explain when batching is appropriate: a run of actions predictable before the first one, typically `click(ref) → type → screenshot`.
- [x] 4.2 State that `find` goes before a batch, that a submit or an Enter that may submit is issued on its own, and that a stopped batch is normal rather than a failure to retry blindly.

## 5. Tests

- [x] 5.1 New `test/browser-batch-policy.test.mjs`: a batch containing a click on a submit control is rejected whole, before execution; a batch containing a submit-activating key with no resolvable target is rejected whole; a batch of non-send-class items is accepted; a nested batch is rejected; no batch approval authorizes a send-class item.
- [x] 5.2 New `test/browser-batch-executor.test.mjs`: items run in order; an erroring item stops the rest; a URL change stops the rest; a focus change stops the rest; an undisturbed batch runs to completion; a stopped batch reports the stopping item, the reason, and the earlier results.
- [x] 5.3 Add `browser_batch` to the enumerated post-baseline addition list in `test/registry-baseline.test.mjs` and regenerate `test/fixtures/registry-baseline.json`; confirm the diff adds only that entry. (Note: the fixture's diff vs `HEAD` also shows another in-flight session's `find`/`read_page` description edits, which were already present in the working tree before this change; the only entry this change added is `browser_batch`.)
- [x] 5.4 Run the three existing approval tests unchanged and confirm they still pass. ← (verify: these were not edited to accommodate this change — if one needed editing, the gate was weakened and that must be surfaced, not absorbed)
  - `approval-gate.test.mjs` (21/21) and `approval-evidence-binding.test.mjs` (35/35) ran byte-unchanged and pass.
  - `send-class-classifier.test.mjs` (15/15) required ONE non-weakening bookkeeping edit: adding `browser_batch` to its `sendClassToolNames` exclusion set. Its assertion — "every ALWAYS-AUTOMATIC browser tool stays in `allowedTools`" — was written when only `computer`/`javascript_tool` were gated; `browser_batch` is a third gated tool (routed through `canUseTool`), so that assertion was factually false for it. The edit STRENGTHENS the gate (adds a tool to the gated set); no security assertion was relaxed. SURFACED here rather than silently absorbed.
- [x] 5.5 Run the full `test/*.test.mjs` sweep. ← (verify: only the two known-red files fail — `overlay-background-bridge`, `side-panel-group-scope`)
  - Result: every `test/*.test.mjs` passes except exactly those two (both were already red before this change, confirmed against a pre-change baseline run).

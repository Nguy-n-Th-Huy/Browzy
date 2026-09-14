## Why

A workflow step that clicks an element records a `ref_N` — a handle into ONE document's in-memory element map (`extension/content.js`'s WeakRef map, deliberately wiped by navigation, SPA route changes, tab close/reopen and browser restart). Freezing that handle into a stored definition pins the step to a reference that is guaranteed dead by the next session. The live failure (2026-09-15): a saved `dauthau.asia` workflow replayed a day after recording ended `target_no_longer_resolves` at its first `computer left_click` — the proof gate admitted the step, the step executed, and the aim could not resolve. Heal does not solve it either: a healed definition written with fresh refs re-drifts the same way one document later. The registry could store interactive workflows; nothing could durably replay them.

## What Changes

- **Materialization freezes the element's stable identity, not its handle.** A recorded `ref_N` with a known identity is rewritten to `target: {role, name}` and the dead handle is dropped. The identity comes from the run's own recorded evidence: a search result's `[ref_N] role "name"` line, or the click result's `… landed on <tag> "Name"` description of the element that received that click (the only evidence that exists for refs picked off a screenshot, and it disambiguates a ref number reused across a mid-run navigation). Those element-identity lines are the ONLY thing ever read out of tool results, a credential-shaped label is never frozen, and a ref with no recorded identity is preserved exactly as recorded (never invented, never a reason to block the draft).
- **Replay re-resolves the identity against the live page.** `computer`/`form_input` steps carrying a `target` resolve it through the existing find machinery (strict normalized name equality, role preferred) and then run through the existing scroll-into-view + hit-test path — so interception notes and reachability reporting stay exactly as true as they were for refs. Steps still carrying a ref try it first (same-document precision), then the target.
- **A replay returns to the starting page first.** The trail rarely records a `navigate` for the page the run began on (the operator already had it open — exactly how the dauthau.asia run began), so a replay launched from the previous run's results page mis-aims every step. The run's own first tab listing records that URL; the derivation speaks it as a leading `navigate` step (and folds its host into the domain binding) whenever the trail itself never navigates. A trail that navigates is left alone; a trail that records no starting page gets no invented one.
- **A target that no longer matches is drift.** The failure text starts with `Could not resolve/bring …`, so `shortcutDriftReason`/`batchItemResultFailed` classify it `target_no_longer_resolves` with no new vocabulary — an honest drift into the existing heal flow, never a click at a guess.
- **The heal tool documents the target form**, so heal-authored steps stop re-freezing document-scoped refs.
- **The registry schema validates `target`** (role ≤ 40 chars optional, name 1–200 required, no other fields), so a malformed target is a validation error, not a runtime surprise. `MATERIALIZE_VERSION` bumps to 2.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-skills`: adds the replayable-target requirement for derived workflows — interactive steps aim by recorded identity, replay re-resolves live, a genuine mismatch is drift, and an unrecorded identity is never invented (the modified-freshness rule is narrowed, not weakened: results are still never a source of step content beyond the identity line).

## Impact

- `extension/content.js` — `getTargetCoordinates()` + its message handler (strict identity → live element, reusing `findElements`/`getRefCoordinates`).
- `extension/background.js` — `resolveTargetToCoordinates()`, `describeTargetText()`, `computer()`'s ref-then-target resolution, `form_input()`'s target resolution; failure wording kept classifier-compatible.
- `host/agent/skills/workflows-materialize.js` — `extractRunTargetIdentities()`, `freezeStableTargets()`, wired into `deriveRunDraft()`; materialize version 2.
- `host/agent/skills/workflows-schema.js` — `target` shape validation in `validateSteps`.
- `host/agent/tools/propose-workflow-heal.js` — step-args description documents the target form.
- Tests: new `test/replayable-targets.test.mjs`; extensions in `host/test/workflows-materialize.test.mjs` and `test/shortcut-prove-handler.test.mjs`.

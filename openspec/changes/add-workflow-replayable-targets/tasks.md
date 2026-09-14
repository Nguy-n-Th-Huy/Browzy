## 1. Record side — freeze identities (host)

- [x] 1.1 `extractRunTargetIdentities()` in `workflows-materialize.js`: collect `ref_N → {role, name}` from the run window's recorded results (first occurrence wins; names whitespace-normalized, capped at 200; credential-shaped labels refused). ← (verify: `host/test/workflows-materialize.test.mjs` — real result-line format parsed; a JWT-shaped label is never frozen)
- [x] 1.2 `freezeStableTargets()`: every `ref` arg with a known identity becomes `target: {role, name}` (nested args walked); unmapped refs preserved verbatim; wired into `deriveRunDraft()` before the draft is built. ← (verify: a form step keeps its value through the rewrite; an unmapped ref stays as recorded)
- [x] 1.6 The click's own landing description (`… landed on <tag> "Name"`) is identity evidence too: associated to its call by tool id, it disambiguates a ref number reused across a mid-run navigation and is the only evidence for refs picked off a screenshot; a state-only landing line (`<span> — a dropdown list is now OPEN …`) never matches, and a landing on a form control (`<select> "…"` = the option list, not a name) is never frozen. ← (verify: name-only targets from landings; corroborated search role joins; conflict marks ambiguous; selects skipped)
- [x] 1.7 A derived replay starts where the run started: the run's first tab listing's URL (`recordedStartUrl()`) becomes a leading `navigate` step whenever the trail itself never navigates, and its host joins the domain binding; no starting page is invented when none was recorded. ← (verify: leading navigate present from the listing; absent when the trail already navigates)
- [x] 1.3 `workflows-schema.js` validates the `target` shape (optional role ≤ 40, required name 1–200, no unknown fields). ← (verify: a frozen draft passes `validateWorkflowRecord`; a malformed target fails with `UNSUPPORTED_STEP`)
- [x] 1.4 `MATERIALIZE_VERSION` → 2; the purity rule comment narrowed to name the one exception. 
- [x] 1.5 `propose-workflow-heal.js`'s step-args description documents the target form (heal-authored steps stop re-freezing refs).

## 2. Replay side — resolve identities live (extension)

- [x] 2.1 `content.js`: `getTargetCoordinates()` (strict normalized-name match, role preferred; hands back a fresh ref + point through the shipped `getRefCoordinates` path) and its `getTargetCoordinates` message handler. ← (verify: `test/replayable-targets.test.mjs` — role mismatch still resolves by name; no match is a real null; empty identity never searches)
- [x] 2.2 `background.js`: `resolveTargetToCoordinates()` + `describeTargetText()`; `computer()` resolves ref-then-target with per-source failure wording; `form_input()` resolves a target into a live ref before setting the value. ← (verify: structural pins + classifier pins)
- [x] 2.3 Drift classification: target failure texts start with `Could not resolve/bring`, classify `target_no_longer_resolves` through both `shortcutDriftReason` and `batchItemResultFailed`. ← (verify: `test/shortcut-prove-handler.test.mjs` + `test/replayable-targets.test.mjs`)

## 3. Verification

- [x] 3.1 `node test/replayable-targets.test.mjs` — content-side behavior (compiled from shipped source), background ordering/wording, both classifier gates, wire message shape. 
- [x] 3.2 `node host/test/workflows-materialize.test.mjs` — 17/17 including the four new checks.
- [x] 3.3 Full-suite sweep (`node test/*.test.mjs`, `node host/test/*.test.mjs`) — no regressions (pre-existing reds excluded: `overlay-background-bridge`, `overlay-pointer`, `side-panel-group-scope`).
- [ ] 3.4 Live follow-up (operator): re-derive the dauthau workflow, save, run — clicks resolve against the live page; a genuine site change (or a step whose ref had no recorded identity, e.g. one picked off a screenshot) still drifts.

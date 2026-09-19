# Tasks: fix-snapshot-text-and-jev-guards

## 1. Rendered-text extraction (extension) and the text bound

- [x] 1.1 `extension/content.js` `getPageText`: walk the live DOM and exclude non-rendered elements (`checkVisibility({checkVisibilityCSS:true})` when available, else computed `display`/`visibility` + `hidden` attribute + inline `display:none`), keeping the existing exclusion selectors, the masked-textarea rule (`••••••`, value never read), whitespace collapsing, and the container-selection/coverage logic measured on the rendered body text
- [x] 1.2 Raise the page-text bound 6,000 → 10,000 consistently: `content.js`'s snapshot text bound and `host/agent/jev/questions.js`'s `MAX_PAGE_TEXT_CHARS` (+ their comments), plus every pinned 6,000 reference in README/tests (grep and update; report what changed)
- [x] 1.3 Extend the stand-in DOM harness to model hidden elements + the visibility seam; tests: a fixture with large hidden chrome ahead of content (content present within the bound), each hidden-visibility case, masked textarea, truncation disclosure, container selection/fallback unchanged ← (verify: hidden chrome excluded; content reached; masking and disclosure intact; no change to reference behavior)

## 2. Scroll-only stall guard and instructions (host)

- [x] 2.1 `host/agent/jev/runtime.js`: exported `SCROLL_ONLY_STREAK_LIMIT = 8`; count consecutive executed scroll steps (either direction, table-change-agnostic), other executed steps reset; on trip take the existing stall path; refusal/unavailable/spent → blocked `no_progress`; after a recovery that followed a scroll-stall trip, one further executed scroll → blocked `no_progress`, cleared by any other executed step ← (verify: the 21-scroll failure class ends within ~9 steps; every existing guard test unchanged)
- [x] 2.2 `host/agent/jev/text-helper.js`: `NEXT_STEP` gains plan-adherence + `BLOCKED`-when-unobtainable + `DONE`-when-sufficient-for-analysis rules; `COMPLETION_CHECK` gains the analysis-goal confirmation semantics; tests assert the built payloads carry the rules ← (verify: instruction text contains each rule; no other instruction semantics changed)
- [x] 2.3 Extend `host/test/jev-runtime.test.mjs` for the new guard and `host/test/jev-text-helper.test.mjs` for the instruction rules (plus any other suite asserting the prior instruction text)

## 3. Docs

- [x] 3.1 README: the page-text bound (10,000) where it is stated, and the scroll-only stall guard where the Jev loop's guards are described ← (verify: statements match the shipped behaviour)

## 4. Focused suites and validation

- [x] 4.1 Run the focused suites (`cd host && node --test test/jev-*.test.mjs`; from root `node --test test/page-snapshot-content.test.mjs test/page-snapshot-background.test.mjs` and the registry suites touched by the bound change) and `openspec validate fix-snapshot-text-and-jev-guards --strict` — done: all green in verification (including the live-page extraction matrix and the scroll-guard harness); the one failing suite (overlay-background-bridge) is a pre-existing at-HEAD failure owned by another session, verified out of scope ← (verify: green; only in-scope files edited)

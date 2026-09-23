## 1. Reword the tool description

- [x] 1.1 In `host/agent/tools/browser-subgoal.js`, reword `TOOL_DESCRIPTION` from "ONE bounded interaction … never a multi-step task" to "one coherent sub-task on the current page (describe the end state, e.g. fill a form and submit) which may take several related steps; Jev runs the sequence within its bounded budget and returns one unverified checkpoint". Keep the "not a success claim / inspect the checkpoint / final verification is yours" framing intact. Do NOT change `goal` validation or the result contract. ← (verify: description no longer says "single interaction / never multi-step"; result/validation unchanged)

## 2. Batching nudge

- [x] 2.1 In `host/agent/tools/query-options.js` `renderJevToolsPreferenceSystemPrompt`, when `browser_subgoal` is present add a batching instruction: group a coherent sequence of related interactions into ONE `browser_subgoal` (fill and submit a form in one goal, not one subgoal per field/click) and return to your own reasoning only at a real decision point or when a subgoal reports blocked. Keep it conditional on `browser_subgoal` being in `extraToolNames` (never emitted when absent); keep the existing primary/fallback wording; return `null` when neither Jev tool present (prompt byte-for-byte unchanged). ← (verify: batching line present iff browser_subgoal registered; absent otherwise; existing nudge/guidance intact)

## 3. Tests

- [x] 3.1 Update `host/test/jev-tools-preference-nudge.test.mjs` to assert the batching instruction appears when `browser_subgoal` is registered and is absent when it is not; keep all existing assertions. If a browser-subgoal tool-description test exists, update it for the reworded contract; the `goal`-validation tests are unchanged.
- [x] 3.2 Run the preference-nudge test and the browser-subgoal test plus `openspec validate jev-subgoal-batch-interactions --strict`; report actual output; report unowned parallel-session failures without editing them.

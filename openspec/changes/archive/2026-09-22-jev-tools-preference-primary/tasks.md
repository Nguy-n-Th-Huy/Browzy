## 1. Strengthen the nudge wording

- [x] 1.1 In `host/agent/tools/query-options.js` `renderJevToolsPreferenceSystemPrompt`, rewrite the guidance strings to the primary/fallback rule: when `browser_subgoal` is present, default to it for every page interaction (click/type/select/submit/in-page navigation) by describing the goal, and use `computer`/`form_input` only as a fallback when a `browser_subgoal` attempt fails, is blocked, or cannot express the step (discourage the read_page→find→computer-click pattern for interactions); when `extract_page` is present, default to it for structured reads, keeping the reading tools for free-text/inspection. Keep the exact conditional structure, per-tool naming, and the `null`-when-neither return contract unchanged. ← (verify: only present tools named; returns null when neither present so systemPromptText is byte-for-byte unchanged; no signature/gating/call-site change)

## 2. Tests

- [x] 2.1 Update `host/test/jev-tools-preference-nudge.test.mjs` to assert the stronger semantics — the block states the Jev tool is the primary/default and the native tools are fallback-only when it fails/cannot express the step — while keeping the existing assertions: nudge present iff `browser_subgoal`/`extract_page` in `extraToolNames`, an absent tool is never named, prompt byte-for-byte unchanged when neither present, and the existing browser-automation guidance is intact. Do not weaken any existing assertion. ← (verify: every spec scenario covered; existing gating assertions preserved)

## 3. Checks

- [x] 3.1 Run the preference-nudge test and the query-options test suite; run `openspec validate jev-tools-preference-primary --strict`. Report actual output; report any unowned parallel-session failures without editing them.

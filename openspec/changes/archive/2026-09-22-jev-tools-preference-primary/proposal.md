## Why

The Jev-tools preference nudge shipped as a soft "prefer" instruction. In practice the driving model still does most manipulation with native tools: the latest run log (`conv_d4f355044d3b9a8e8f`, "Phân tích 1 TBMT Hải Phòng") shows `browser_subgoal` and `extract_page` each invoked about once, against `computer` ×38, `form_input` ×8, `read_page` ×8, `find` ×7. The user wants Jev to be the primary manipulation path — the Jev decision model finds and acts in one bounded step, avoiding the slow read_page→find→computer-click loop — with the native tools used only when Jev fails or cannot express the step.

## What Changes

- The conditional Jev-tools guidance is strengthened from "prefer" to a primary/fallback rule, still emitted only for the tools actually registered for the run:
  - When `browser_subgoal` is available: the model SHALL default to `browser_subgoal` for every page interaction (click, type, select, submit, in-page navigation) — describing the goal in natural language and letting Jev observe, find, and act — and use `computer`/`form_input` only as a fallback when a `browser_subgoal` attempt fails, returns blocked, or the step is something `browser_subgoal` cannot express. The read_page→find→computer-click pattern for interactions is discouraged.
  - When `extract_page` is available: the model SHALL default to `extract_page` for structured/field data reads instead of `read_page`/`get_page_text` plus manual parsing; the reading tools remain for free-text and inspection.
- It remains guidance, not enforcement: the native tools stay registered and are the honest fallback. No tool that is absent is ever named. When neither Jev tool is present, nothing is appended and the prompt is byte-for-byte unchanged (unchanged from today).
- No change to the tool gates/resolvers, tool runtime, native-tool availability, or the standalone `typesafe` path — only the guidance text.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: the "Run guidance prefers the Jev browser tools when they are available" requirement is strengthened — when a Jev tool is registered, the guidance makes it the primary path and names the native tools as a fallback used only when the Jev tool fails or cannot express the step, keeping all conditional/absent-tool safety clauses.

## Impact

- `host/agent/tools/query-options.js`: `renderJevToolsPreferenceSystemPrompt` text strengthened to the primary/fallback wording.
- Tests: the preference-nudge test updated to assert the stronger semantics (primary/default + fallback-only), keeping the existing presence/absence/never-name-absent assertions.
- Out of scope: forcing tool use, removing/gating native tools, the connection test, resolvers/gates, and tool runtime behavior.

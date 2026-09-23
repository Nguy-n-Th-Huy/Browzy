## Why

A real run ("Đi 23/09, 1 người lớn", a flight search) took ~781s. The timing breakdown shows Jev itself is fast (40 decisions, ~1.4s each = 55s); the cost is the LLM layers: ~600s in the driving model (ChatGPT) reasoning between steps, and 117s in the Jev planning model. The driving-model cost is amplified because `browser_subgoal` is documented as "ONE bounded interaction… never a multi-step task", so the driving model issued ~16 tiny subgoals (one per click), each a full round-trip back to its own reasoning. Letting one subgoal carry a coherent multi-step sub-task (e.g. fill an entire form and submit) collapses many of those round-trips into one, cutting the dominant cost. The trade-off — the driving model supervises less between the batched steps — is accepted for speed; every dispatch guard and approval still applies inside the subgoal.

## What Changes

- The `browser_subgoal` contract is relaxed from "one bounded interaction / never multi-step" to **one coherent sub-task that MAY span several related steps** on the current page context (for example, filling all fields of a form and submitting it, or opening a menu and choosing an item). The `goal` still describes an end state, not code or selectors, and the sub-run still returns a single unverified checkpoint at the end.
- The tool description and the run guidance are updated to instruct the driving model to **batch a coherent sequence of related interactions into one `browser_subgoal`** rather than one subgoal per click, and to return to its own reasoning only at a real decision point or when a subgoal reports blocked.
- Everything else is unchanged: the sub-run's bounded budgets, all dispatch guards, approval cards (a send/submit-class step inside a batched subgoal still suspends on its own approval), document/target re-validation, and the unverified-checkpoint result. This is guidance/wording only — no runtime guard or budget is weakened.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `jev-browser-subgoal`: the "one goal" requirement is broadened — a `goal` describes one coherent sub-task that may take several related steps, still a single end state and a single checkpoint, with all guards unchanged.
- `agent-browser-runtime`: the Jev-tools run guidance additionally instructs batching a coherent sequence of related interactions into one `browser_subgoal`.

## Impact

- `host/agent/tools/browser-subgoal.js`: `TOOL_DESCRIPTION` reworded from "ONE bounded interaction… never a multi-step task" to "one coherent sub-task that may take several related steps; describe the end state".
- `host/agent/tools/query-options.js`: `renderJevToolsPreferenceSystemPrompt` gains a batching instruction for `browser_subgoal` (still conditional on the tool being registered).
- Tests: the preference-nudge test asserts the batching instruction; a browser-subgoal description/validation test (if present) reflects the reworded contract. Validation-of-`goal` behavior is unchanged.
- Out of scope: changing the sub-run's budgets or any guard, the screenshot toggle, resolvers/gates, `extract_page`.

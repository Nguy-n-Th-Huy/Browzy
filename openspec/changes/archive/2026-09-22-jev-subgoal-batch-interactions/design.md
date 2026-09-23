## Context

- `host/agent/tools/browser-subgoal.js` `TOOL_DESCRIPTION` currently says "Delegate ONE bounded interaction… Describe a single outcome… never a multi-step task." This makes the driving model issue one subgoal per click.
- `host/agent/tools/query-options.js` `renderJevToolsPreferenceSystemPrompt` emits the Jev-tools guidance (conditional on `extraToolNames`).
- Measured on a real run: Jev decisions ~1.4s each (fast); the dominant cost (~600s of 781s) is the driving model reasoning between the ~16 tiny subgoals it issued.
- The sub-run already supports multi-step goals: a `jev_end` in the log shows `steps: 5` for one subgoal. Bounded budgets (`SUBGOAL_MAX_ACTIONS`, `SUBGOAL_MAX_DECISIONS`) already accommodate a form fill.

## Goals / Non-Goals

**Goals:**
- Let one `browser_subgoal` carry a coherent multi-step sub-task, and guide the driving model to batch that way, cutting driving-model round-trips.

**Non-Goals:**
- Changing the sub-run's budgets or any guard/approval.
- Removing the per-subgoal checkpoint (still one checkpoint per subgoal).

## Decisions

1. **Reword the tool description.** `TOOL_DESCRIPTION` becomes: delegate one coherent sub-task on the current page to Jev — describe the end state you want (e.g. "fill the search form with origin/destination/date and submit"), which may take several related steps; Jev runs the sequence within its bounded budget and returns one unverified checkpoint. Keep the "never a claim of success / inspect the checkpoint / final verification is yours" framing. Remove the "never a multi-step task / single interaction" phrasing that caused per-click subgoals.

2. **Add a batching line to the nudge.** In `renderJevToolsPreferenceSystemPrompt`, when `browser_subgoal` is present, add: group a coherent sequence of related interactions into one `browser_subgoal` (fill and submit a form in one goal, not one subgoal per field/click); come back to your own reasoning only at a real decision point or when a subgoal reports blocked. Conditional on the tool being registered, same as the rest of the nudge; when the tool is absent, nothing about batching is emitted.

3. **No runtime/budget change.** The sub-run's guards, approvals, bounded budgets, and checkpoint contract are unchanged — a batched subgoal simply uses more of the budget it already has, and every send/submit step inside it still hits its approval card. The trade-off (the driving model supervises less between the batched steps) is accepted for speed and is bounded by the sub-run's own no-progress/action limits.

## Risks / Trade-offs

- [Less driving-model supervision between batched steps] → Accepted for speed; guards/approvals inside the subgoal are unchanged, and the bounded budgets cap a runaway subgoal.
- [A batched subgoal hits its bound before finishing] → It returns a bounded blocked checkpoint with its reason, and the driving model continues — same as today, just at a coarser granularity.
- [Parallel-session edits] → Wording-only in two files; build on current contents, revert nothing.

## Migration Plan

Wording-only, additive. Rollback = restore the previous tool description and drop the batching line.

## Open Questions

None.

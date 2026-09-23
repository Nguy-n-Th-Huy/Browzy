## ADDED Requirements

### Requirement: Run guidance batches related interactions into one Jev subgoal

When `browser_subgoal` is registered for a run, the run's system guidance SHALL instruct the model to batch a coherent sequence of related page interactions into a single `browser_subgoal` goal (for example, filling all fields of a form and submitting it) rather than issuing one subgoal per click, and to return to its own reasoning only at a real decision point or when a subgoal reports blocked. This guidance SHALL be emitted only when `browser_subgoal` is registered for that run, SHALL NOT be emitted when it is absent, and SHALL not weaken any dispatch guard or approval — a send/submit-class step inside a batched subgoal still suspends on its own approval card.

#### Scenario: Guidance encourages batching when the tool is present

- **WHEN** a run has `browser_subgoal` registered
- **THEN** the system guidance instructs grouping a coherent sequence of related interactions into one `browser_subgoal` rather than one per click

#### Scenario: No batching guidance when the tool is absent

- **WHEN** a run does not have `browser_subgoal` registered
- **THEN** the system guidance does not mention batching subgoals

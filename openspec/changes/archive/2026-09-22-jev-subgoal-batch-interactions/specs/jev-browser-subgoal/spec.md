## MODIFIED Requirements

### Requirement: The tool takes one goal and runs a bounded Jev sub-run on the shared run

`browser_subgoal` SHALL accept a single required `goal` string describing one coherent sub-task on the current page — a sub-task that MAY take several related steps toward a single end state (for example, filling all fields of a form and submitting it, or opening a menu and selecting an item), not necessarily a single click — and SHALL reject any input whose `goal` is missing, empty or not a string before starting a sub-run. A valid call SHALL start a Jev sub-run in subgoal mode on the caller run's bound tab, sharing the caller's browser lease, browser `toolBridge`, argument coercion, and `canUseTool` authorization path. The sub-run SHALL NOT create a new tab, borrow a different tab, or acquire a second lease. The sub-run's decisions SHALL come from the profile's configured Jev decision source; its TYPE_TEXT values SHALL come from the profile's configured Jev text model; and the operator-literal fast path SHALL apply, sourced from the tool's `goal` argument and not from the outer conversation. The sub-run SHALL still run under its existing bounded budgets and return exactly one unverified checkpoint at the end, regardless of how many steps the sub-task took.

#### Scenario: A subgoal drives the bound tab

- **WHEN** the LLM calls `browser_subgoal` with `goal: "click the Sign in button"`
- **THEN** a Jev sub-run selects and dispatches actions on the caller's bound tab through the shared toolBridge and authorization path

#### Scenario: A multi-step sub-task runs in one subgoal

- **WHEN** the LLM calls `browser_subgoal` with a coherent multi-step goal such as "fill the search form (origin, destination, date, passengers) and submit it"
- **THEN** the single sub-run performs the related steps within its bounded budgets and returns one unverified checkpoint at the end, with every step still passing the existing dispatch and approval guards

#### Scenario: Missing or empty goal is rejected

- **WHEN** the tool is called with no `goal`, an empty `goal`, or a non-string `goal`
- **THEN** no sub-run starts and the call returns a bounded validation failure

#### Scenario: A literal in the subgoal text types exactly

- **WHEN** the `goal` is a whole-prompt operator literal such as `set Email to "a@b.com"` and the field is uniquely eligible
- **THEN** the exact value is typed through the existing literal path, and no Jev text-model call is made for it

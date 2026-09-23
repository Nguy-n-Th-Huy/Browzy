## ADDED Requirements

### Requirement: Run guidance prefers the Jev browser tools when they are available

When a run has the `browser_subgoal` and/or `extract_page` tools registered, the run's system guidance SHALL instruct the model to prefer `browser_subgoal` for page interactions (clicking, typing, selecting) and `extract_page` for structured data reads, rather than performing those inline with the native tools. This guidance SHALL be emitted only for the tools actually registered for that run, SHALL NOT reference a tool that is absent, and SHALL leave the existing browser-automation guidance and the native tools available and unchanged. A run without either Jev tool SHALL receive exactly the guidance it received before this capability existed.

#### Scenario: Guidance appears when the tool is present

- **WHEN** a run is configured with `browser_subgoal` (and/or `extract_page`) registered
- **THEN** the system guidance instructs preferring that tool for its purpose, and the native tools remain available

#### Scenario: No guidance when the tool is absent

- **WHEN** a run has neither `browser_subgoal` nor `extract_page` registered
- **THEN** the system guidance does not mention them and is byte-for-byte the guidance given before this capability existed

#### Scenario: Only the registered tool is referenced

- **WHEN** only `extract_page` is registered (text model configured but not the decision model/transport)
- **THEN** the guidance references `extract_page` only and does not instruct using `browser_subgoal`

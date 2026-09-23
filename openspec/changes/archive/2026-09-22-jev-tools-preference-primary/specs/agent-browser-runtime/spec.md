## MODIFIED Requirements

### Requirement: Run guidance prefers the Jev browser tools when they are available

When a run has the `browser_subgoal` and/or `extract_page` tools registered, the run's system guidance SHALL instruct the model to treat the registered Jev tool as the primary path for its purpose and to treat the native tools as a fallback used only when the Jev tool fails, returns blocked, or cannot express the step. Specifically, when `browser_subgoal` is registered the guidance SHALL instruct defaulting to `browser_subgoal` for every page interaction (clicking, typing, selecting, submitting, in-page navigation) by describing the goal in natural language, and using `computer`/`form_input` only as that fallback rather than as the default. When `extract_page` is registered the guidance SHALL instruct defaulting to `extract_page` for structured data reads rather than reading and parsing the page manually. This guidance SHALL be emitted only for the tools actually registered for that run, SHALL NOT reference a tool that is absent, and SHALL leave the existing browser-automation guidance and the native tools available and unchanged — it is guidance, not enforcement, and the native tools remain callable. A run without either Jev tool SHALL receive exactly the guidance it received before this capability existed.

#### Scenario: Guidance appears when the tool is present

- **WHEN** a run is configured with `browser_subgoal` (and/or `extract_page`) registered
- **THEN** the system guidance instructs using that tool as the primary path for its purpose, and the native tools remain available

#### Scenario: Native tools are named as fallback only

- **WHEN** `browser_subgoal` is registered
- **THEN** the guidance directs the model to reach for `computer`/`form_input` only when a `browser_subgoal` attempt fails, is blocked, or cannot express the step — not as the default for interactions

#### Scenario: No guidance when the tool is absent

- **WHEN** a run has neither `browser_subgoal` nor `extract_page` registered
- **THEN** the system guidance does not mention them and is byte-for-byte the guidance given before this capability existed

#### Scenario: Only the registered tool is referenced

- **WHEN** only `extract_page` is registered (text model configured but not the decision model/transport)
- **THEN** the guidance references `extract_page` only and does not instruct using `browser_subgoal`

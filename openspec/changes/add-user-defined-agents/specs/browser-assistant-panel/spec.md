## ADDED Requirements

### Requirement: Primary agent selection in the panel

The panel SHALL provide a control for choosing the conversation's primary agent from the enabled agent catalog, including an explicit "no agent" choice. The control SHALL show the current selection at all times without requiring it to be opened, and SHALL be present in every panel state in which a message can be composed. The selection SHALL be bound to the conversation and restored when the panel reloads or the conversation is reopened. The control SHALL meet this capability's existing accessibility guarantees: reachable and fully operable by keyboard, meeting WCAG 2.1 AA contrast, usable at 320px panel width, and announcing a selection change through the existing polite live region. When the catalog is empty the control SHALL state that no agents are defined and point to the management surface, rather than presenting an empty list with no explanation.

#### Scenario: Current selection is visible without opening the control

- **WHEN** the panel is showing a conversation with an agent selected
- **THEN** that agent's name is visible in the composer area without opening the control

#### Scenario: Selection is announced to assistive technology

- **WHEN** the operator changes the selected agent
- **THEN** the new selection is announced through the panel's polite live region

#### Scenario: Empty catalog explains itself

- **WHEN** the operator opens the control and no agents are defined
- **THEN** the control states that no agents are defined and offers a route to the management surface, rather than showing an empty list

#### Scenario: The control is usable at minimum width

- **WHEN** the panel is displayed at 320px width
- **THEN** the control and the current selection remain visible, legible and operable without horizontal scrolling of the panel body

### Requirement: The agent a run used is truthfully reported

The transcript SHALL identify which agent a run was started with, and SHALL report a fallback rather than conceal it: when a selected agent's declared model could not be resolved and the run fell back to the active profile's model, the panel SHALL show a notice naming the agent, the declared model, and the model actually used. When the selected agent was disabled or removed between selection and run start, the panel SHALL show that the run proceeded with no agent rather than silently omitting it. The panel SHALL NOT present per-agent cost or token figures, because usage is accounted per model and not per agent; any usage surface shown alongside agents SHALL state that limitation.

#### Scenario: The run's agent is shown in the transcript

- **WHEN** a run starts with an agent selected
- **THEN** the transcript identifies that agent for that run

#### Scenario: A model fallback is visible, not silent

- **WHEN** a run starts with an agent whose declared model is unavailable for the active profile
- **THEN** the panel shows a notice naming the agent, the declared model, and the model actually used

#### Scenario: A removed agent does not silently vanish

- **WHEN** the conversation's selected agent was removed or disabled before the run started
- **THEN** the panel shows that the run proceeded with no agent, and the run still completes normally

#### Scenario: Usage does not claim per-agent attribution

- **WHEN** a usage surface is shown for a conversation in which more than one agent acted
- **THEN** no per-agent cost or token figure is presented, and the surface states that attribution is per model

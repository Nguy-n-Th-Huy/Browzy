## ADDED Requirements

### Requirement: Jev selects complete fresh actions

The TypeSafe runtime SHALL build complete host-owned action candidates from each fresh observation and ask Jev to select an offered action key. Each key SHALL resolve to exactly one operation, current target and prepared payload where required. Routine decisions SHALL NOT require a configured-language-model NEXT_STEP request or a prose-to-target reconstruction.

#### Scenario: Multiple actions under one plan

- **WHEN** the prepared plan contains enough information for multiple routine actions
- **THEN** each cycle observes and consults Jev, executing validated offered actions without a language-model step request

#### Scenario: A target appears after hover

- **WHEN** HOVER reveals a new menu item
- **THEN** the next observation creates new candidates including the item without reusing prior target indices

#### Scenario: State changes during decision

- **WHEN** refreshed state no longer matches the selected target's relevant identity or state
- **THEN** no action is dispatched from the stale key and a fresh cycle rebuilds candidates

### Requirement: Prepared content has exact bounded ownership

The language model SHALL prepare bounded content from the user's goal and observed context. Host-owned TYPE_TEXT bindings SHALL identify the observed document and exact editable field, remain limited to the current plan revision and one dispatch, and SHALL NOT be rebound to another field by semantic similarity. NAVIGATE values SHALL be bounded absolute http(s) URLs. Missing content SHALL cause bounded replanning rather than guessed data.

#### Scenario: New field needs content

- **WHEN** a new editable field lacks a valid prepared value
- **THEN** no text candidate is invented for it and REPLAN can prepare its value

#### Scenario: Navigation or changed field invalidates text

- **WHEN** the document changes, the binding cannot be established, or the ref/role/label differs
- **THEN** the prior value is not offered for that field

#### Scenario: Value was dispatched

- **WHEN** a prepared text action executes
- **THEN** its content record is consumed and another dispatch requires new preparation

### Requirement: Monitors advise guarded control flow

The Jev request SHALL include independently answered action, goal_done and stuck Choice heads over the same bounded state. A positive completion judgment or DONE choice SHALL trigger LLM verification rather than successful termination. REPLAN and stuck SHALL use bounded planning consultation. ASK SHALL surface the existing blocked/operator-needed state. Every control choice SHALL remain subject to run bounds.

#### Scenario: Monitor thinks the goal is done

- **WHEN** goal_done is positive even though the action head selects a mutation
- **THEN** completion is checked before mutation and success requires verification

#### Scenario: Replans never progress

- **WHEN** repeated REPLAN or stuck judgments produce no executed progress
- **THEN** the bounded run ends blocked with a named reason rather than resetting its budgets

#### Scenario: Operator help is required

- **WHEN** Jev selects ASK
- **THEN** the run records blocked and needsOperator and presents the need for user input without claiming an implemented pause/resume channel

### Requirement: Decision attribution is observable

Step records and user-visible descriptions SHALL attribute action decisions to Jev and planning/completion to the configured language model. They SHALL preserve target, action and outcome observability and render older records. Screenshots SHALL remain optional LLM context; Jev SHALL receive supported structured text input only.

#### Scenario: Screenshot is available

- **WHEN** an enabled screenshot is captured for a planning or completion consultation
- **THEN** the LLM receives it while Jev receives bounded structured page state and history

## ADDED Requirements

### Requirement: Host-owned progress and bounded evidence

The runtime SHALL publish real work phases and bounded before/after evidence for dispatched steps. It SHALL preserve completion verification, fresh targets, approval, stop handling, masking and screenshot opt-in. Evidence failure SHALL NOT cause uncertain mutations to repeat.

#### Scenario: Optional capture fails

- **WHEN** a screenshot fails after an action executes
- **THEN** the action outcome and missing evidence are recorded without replaying the mutation

#### Scenario: Run ends during work

- **WHEN** a run stops or fails during a phase
- **THEN** terminal state supersedes the last work phase

### Requirement: Robust browser scenarios

The runtime SHALL handle obstruction, delayed results, empty results, pagination and changed filters through fresh observations and bounded control flow without unverified success or blocking legitimate new submissions as identical work.

#### Scenario: Popup obstruction

- **WHEN** an overlay prevents an intended interaction
- **THEN** the runtime recovers within bounds or reports obstruction without claiming success

#### Scenario: Delayed results

- **WHEN** submitted results arrive after loading observations
- **THEN** bounded waiting and fresh verification permit completion without repeated identical submissions

#### Scenario: Empty results

- **WHEN** the page confirms no matches
- **THEN** the report states no matches and invents no records

#### Scenario: Pagination or changed filter

- **WHEN** the task requests another page or changed filter
- **THEN** the changed submission remains executable and completion uses the new results

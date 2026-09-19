## ADDED Requirements

### Requirement: Jev run steps and outcome are visible

A run driven by the structured-choice (Jev) runtime SHALL be observable in the panel on the same terms as an LLM run. While it runs, each decision step SHALL appear as it is recorded, showing human-readable names for the chosen operation and its target, the recorded confidence or probability, the browser action that followed (or the reason nothing was dispatched), and its result — expandable to details like the existing action rows. The run's terminal outcome SHALL be shown when it ends: done-as-decided, blocked with its stated reason (no progress, an exhausted bound, a denied action, or a missing field value), stopped, or failed. A Jej run that produces no assistant prose SHALL still display its steps and a resolved terminal state rather than appearing empty or in progress. Step and outcome information SHALL be restored from the transcript after a reconnect or reopen, in order, matching what was shown live, and a partial run SHALL never be presented as complete.

#### Scenario: Steps appear live

- **WHEN** a Jev run executes decision steps
- **THEN** each step becomes visible in the run's turn as it is recorded, with its operation, target, and action outcome in human-readable form

#### Scenario: Restored after reopen

- **WHEN** the panel reconnects or the conversation is reopened after a Jev run
- **THEN** the same step rows and terminal outcome are restored from the durable transcript, in order and without duplication

#### Scenario: Terminal state without assistant text

- **WHEN** a Jev run ends without any assistant text having been produced
- **THEN** the turn shows its steps and a resolved terminal state — done (as decided), blocked with the stated reason, stopped, or failed — and is not left presenting the busy/working indicator

#### Scenario: Interrupted Jev run is shown honestly

- **WHEN** a Jev run is stopped or fails after some steps executed
- **THEN** the executed steps remain visible with their outcomes, the terminal state is labelled distinctly (stopped or failed, not complete), and no unexecuted step is shown as if it had run

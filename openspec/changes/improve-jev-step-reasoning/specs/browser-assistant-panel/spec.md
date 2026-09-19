# browser-assistant-panel delta

## MODIFIED Requirements

### Requirement: Jev run steps and outcome are visible

A run driven by the Jev runtime SHALL be observable in the panel on the same terms as an LLM run. While it runs, each step SHALL appear as it is recorded, showing in human-readable form the operation the configured model decided, the evaluation that decision made of the previous step, the element the TypeSafe endpoint selected for it (or the reason nothing was dispatched), the recorded confidence or probability, and the action that followed — expandable to details like the existing action rows. A step skipped because its selection fell below the run's selection floor SHALL read as a skip naming low selection confidence, never as a failure or as an executed action. The run's plan, each revision of its memory/context, and each stall recovery SHALL appear the same way, as their own rows recorded while the run executes. The run's terminal outcome SHALL be shown when it ends: done distinguished as verified by the completion check or as the configured model's judgment alone, blocked with its stated reason (no progress, an exhausted bound, a denied action, a missing field value, or an unverified completion), stopped, or failed. A Jev run that produces no assistant prose SHALL still display its steps and a resolved terminal state rather than appearing empty or in progress. Step, memory, and outcome information SHALL be restored from the transcript after a reconnect or reopen, in order, matching what was shown live, and a partial run SHALL never be presented as complete.

#### Scenario: Steps appear live

- **WHEN** a Jev run executes decision steps
- **THEN** each step becomes visible in the run's turn as it is recorded, with its operation, its evaluation of the previous step, the selected element, and the action outcome in human-readable form

#### Scenario: A low-confidence skip reads as a skip

- **WHEN** a step is skipped because its selection fell below the selection floor
- **THEN** the row reads as a skipped step naming low selection confidence, distinct from a failed run and from a step that had no compatible candidate

#### Scenario: Memory rows appear live

- **WHEN** a Jev run records its plan, a context revision, or a stall recovery
- **THEN** each appears in the run's turn as it is recorded, labelled in human-readable form, before the run ends

#### Scenario: Restored after reopen

- **WHEN** the panel reconnects or the conversation is reopened after a Jev run
- **THEN** the same step rows, memory rows, and terminal outcome are restored from the durable transcript, in order and without duplication

#### Scenario: Terminal state without assistant text

- **WHEN** a Jev run ends without any assistant text having been produced
- **THEN** the turn shows its steps and a resolved terminal state — done (verified, or the configured model's judgment alone when no verification was possible), blocked with the stated reason, stopped, or failed — and is not left presenting the busy/working indicator

#### Scenario: Completion is labelled honestly

- **WHEN** a Jev run ends as done
- **THEN** the terminal line distinguishes a completion verified by the completion check from one where only the configured model's judgment is claimed, and a completion disputed by the check is never presented as done

#### Scenario: Interrupted Jev run is shown honestly

- **WHEN** a Jev run is stopped or fails after some steps executed
- **THEN** the executed steps remain visible with their outcomes, the terminal state is labelled distinctly (stopped or failed, not complete), and no unexecuted step is shown as if it had run

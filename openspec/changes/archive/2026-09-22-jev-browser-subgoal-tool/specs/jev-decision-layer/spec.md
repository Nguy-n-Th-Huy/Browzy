## ADDED Requirements

### Requirement: Bounded subgoal mode ends at an unverified checkpoint

The Jev runtime SHALL support a bounded subgoal mode in which a caller (an LLM-driven run) supplies the goal and Jev selects and dispatches concrete actions from observed controls to advance that one goal. In subgoal mode the runtime SHALL NOT run a task-level completion verification or final report: the caller (the driving LLM) owns overall task decomposition and final verification. Subgoal mode MAY prepare bounded per-subgoal content and a plan through the configured model (the same preparation a standalone run uses to produce typed values and navigation targets); that prepared plan SHALL be used only for content preparation and Jev's `goal_done` monitor and SHALL NOT be handed to an LLM completion verifier. Jev SHALL consult its configured decision source for action selection, and TYPE_TEXT values SHALL come from the configured text model or the operator-literal fast path. Subgoal mode SHALL use bounded action, decision, no-progress, scroll and memory-update budgets that are independent of and no larger than the standalone run's budgets. A DONE decision or a positive `goal_done` monitor in subgoal mode SHALL end the sub-run as an unverified checkpoint rather than triggering task completion verification. Every dispatch guard, approval gate, document/target re-validation, single-dispatch consumption, stop precedence and result-unknown rule SHALL remain authoritative exactly as in a standalone run. An `ASK` in subgoal mode SHALL end the sub-run blocked with needs-operator surfaced to the caller.

#### Scenario: A subgoal prepares content but is not completion-verified

- **WHEN** a subgoal sub-run starts with a caller-supplied goal and reaches DONE or a positive `goal_done`
- **THEN** it returns an unverified checkpoint, and no task-level completion verification or final report is produced

#### Scenario: Guards are unchanged in subgoal mode

- **WHEN** a subgoal dispatches an action
- **THEN** the same document-nonce/target re-validation, approval gate, single-dispatch consumption, stop precedence and result-unknown rules apply as in a standalone run

#### Scenario: A subgoal exhausts its bound

- **WHEN** a subgoal reaches its bounded action, decision, no-progress or scroll limit
- **THEN** the sub-run ends blocked with its named bound rather than resetting budgets or continuing

#### Scenario: ASK inside a subgoal needs the operator

- **WHEN** Jev selects ASK during a subgoal
- **THEN** the sub-run ends blocked with needs-operator surfaced to the caller, without claiming an implemented pause/resume channel

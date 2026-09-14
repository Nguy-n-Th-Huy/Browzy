## ADDED Requirements

### Requirement: Composer remains usable while a run is active
The panel SHALL keep the composer available while the current conversation's run is running, stopping, or waiting for a decision: submitting SHALL queue the message by default and SHALL expose an explicit run-now (interrupt) choice. A submission the host refuses, such as a full queue, SHALL preserve the composer content and present the refusal reason. Nothing about a queued submission SHALL be presented as an answer to the active run. The prompt-enhancement control's own availability rules SHALL remain unchanged by this behavior.

#### Scenario: Submit while the run streams
- **WHEN** the operator submits a message while a run is streaming
- **THEN** the message appears in the conversation immediately, marked as waiting, and the active run is unaffected

#### Scenario: Queue-full refusal preserves the draft
- **WHEN** a submission is refused because the queue is full
- **THEN** the panel shows the refusal reason and the composer still holds the text for editing or resubmission

#### Scenario: Run-now while the run streams
- **WHEN** the operator chooses run-now on a submission while a run is active
- **THEN** the panel reflects the interrupt attempt, including the disclosed fallback when the run could not be stopped in time

### Requirement: Truthful queue states with per-message control
Each queued message SHALL display its actual state — waiting, running as the next turn, cancelled, failed — and an interrupt attempt that fell back to the queue SHALL be disclosed on that message. A cancel control SHALL appear only while the message is pending; after a claim the control SHALL no longer be offered, and the run's Stop remains the available control. When the drain is paused, the panel SHALL offer an explicit resume action.

#### Scenario: Waiting message
- **WHEN** a message is queued behind an active run
- **THEN** it is shown as waiting, distinguishable from an error and from a message being answered

#### Scenario: Cancel affordance follows the claim
- **WHEN** the next turn claims a pending message
- **THEN** its cancel affordance is no longer offered, and the message reads as running as the next turn

#### Scenario: Resume control after stop
- **WHEN** the operator stopped the run with messages still pending
- **THEN** the pending messages remain visible as pending and a resume action is offered

### Requirement: Queue restore renders from authoritative state, bound to submission-time context
Queue states SHALL be restored from the host's authoritative state after a panel reload or companion restart, rendered exactly once — no duplicated message text, no assumed progress. Each submitted message SHALL retain the page-context identity captured at submission, including when it waits and runs later as its own turn.

#### Scenario: Reload with a pending message
- **WHEN** the panel reloads while a message is pending
- **THEN** the same message is shown once with its pending state, and no second copy or placeholder is created

#### Scenario: Context at submission, not at drain
- **WHEN** the operator submits a message bound to page A while a run is active, then switches tabs before the message's turn starts
- **THEN** that message's turn targets page A exactly as submitted

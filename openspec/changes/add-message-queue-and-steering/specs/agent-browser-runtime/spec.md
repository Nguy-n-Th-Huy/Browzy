## ADDED Requirements

### Requirement: Messages submitted during a run are queued
The host SHALL accept a message submitted while the conversation's run is active into a bounded per-conversation queue, and SHALL run queued messages as subsequent turns in submission order. The queue's bound SHALL be a fixed, disclosed limit; a submission beyond it SHALL be refused with a distinguishable reason and SHALL NOT discard the operator's draft. A resubmission carrying the same idempotency key SHALL NOT create a second queue entry.

#### Scenario: Follow-up while a run is active
- **WHEN** the operator submits a message while the conversation's run is running, stopping, or waiting for a decision
- **THEN** the message is recorded as pending and runs as the next turn after the current run reaches a terminal state

#### Scenario: Queue full
- **WHEN** the queue already holds its bound of pending messages
- **THEN** the submission is refused with a reason naming the limit, nothing is queued, and the operator's draft remains available to edit or resubmit

#### Scenario: Duplicate delivery
- **WHEN** the same submission is delivered twice with the same idempotency key
- **THEN** exactly one queue entry exists, and the second delivery resolves to that existing entry rather than creating a duplicate

### Requirement: Queued messages have an observable lifecycle with a claim boundary
Each queued message SHALL pass through the observable states pending, dispatching, and consumed, with cancelled and failed as terminal outcomes. A pending message SHALL be cancellable; once a turn has claimed a message, a cancel request SHALL be refused with the claimed state disclosed. A claimed message SHALL be owned by exactly one turn.

#### Scenario: Cancel a pending message
- **WHEN** a cancel request targets a message still pending
- **THEN** the message never runs, is rendered as cancelled, and does not affect the active run

#### Scenario: Cancel after claim
- **WHEN** a cancel request targets a message already claimed by the next turn
- **THEN** the request is refused, the claimed state is disclosed, and the message proceeds as that turn

### Requirement: Interrupt-to-run-now is best-effort and reuses stop semantics
A submission MAY request to interrupt. The host SHALL attempt to cancel the active run through the existing stop path so the message runs immediately, and the attempt SHALL be best-effort: when the cancellation cannot be delivered, the message SHALL remain queued — running after the current turn — and the fallback SHALL be disclosed to the operator. Interrupt with no active run SHALL behave as an ordinary queued submission. Because it reuses the stop path, interrupt SHALL block subsequent browser dispatch, invalidate pending decisions, and SHALL NOT represent already executed browser effects as undone.

#### Scenario: Interrupt while a run is active
- **WHEN** the operator submits with interrupt while a run is running
- **THEN** the run stops under the existing stop semantics and the message runs as the immediate next turn

#### Scenario: Interrupt cannot preempt
- **WHEN** the active run cannot be cancelled promptly, such as already finishing or a cancellation that cannot be delivered
- **THEN** the message stays pending and runs after the current turn, and the fallback is disclosed rather than claimed as an interrupt

#### Scenario: Interrupt while other messages are pending
- **WHEN** an interrupt submission arrives while earlier messages are already pending
- **THEN** the interrupt message runs as the immediate next turn, and the earlier messages keep their submission order after it

#### Scenario: Interrupt while a decision is pending
- **WHEN** the active run is waiting for an approval or a question and the operator submits with interrupt
- **THEN** the pending decision is invalidated under the same rules as Stop, and the message runs next

### Requirement: Queue drain is operator-controlled
Stopping the active run SHALL pause the drain: pending messages SHALL remain pending and individually cancellable rather than starting automatically. The drain SHALL resume on an explicit resume action or on the next submission. Deleting a conversation SHALL cancel its pending messages under the existing tombstone semantics, and no pending message SHALL run into a deleted conversation.

#### Scenario: Stop pauses the drain
- **WHEN** the operator stops the active run while messages are pending
- **THEN** no pending message starts until the operator resumes the queue or submits again

#### Scenario: Resume drains in order
- **WHEN** the operator resumes a paused queue
- **THEN** the pending messages run as consecutive turns in submission order

#### Scenario: Conversation deleted with messages pending
- **WHEN** a conversation is deleted while it holds pending messages
- **THEN** those messages are cancelled with the conversation and none of them starts a run

### Requirement: Queue durability and restore
Queue state SHALL survive panel reload and companion restart. Restoring SHALL rebuild each message's exact state, and a message SHALL never be owned by more than one turn: the claim of a message and the creation of its turn SHALL be a single durable commit. A message not yet claimed at restart SHALL return to pending; a message already claimed by a run interrupted by restart SHALL follow that run's interruption outcome and SHALL NOT be automatically replayed. Restoring SHALL NOT render a message's text twice.

#### Scenario: Panel reload with messages pending
- **WHEN** the panel reloads while messages are pending
- **THEN** the pending messages and their states are restored exactly, with no duplication and no assumed progress

#### Scenario: Companion restart during the claim point
- **WHEN** the companion restarts while a message is being claimed or was just claimed by a run
- **THEN** the message is pending again if it was never owned, or follows the interrupted run's handling if it was, so it can never run twice from the same ownership

#### Scenario: A restored pending message runs once
- **WHEN** a conversation with pending messages is reopened and a run next executes
- **THEN** the oldest pending message runs exactly once as that turn

### Requirement: Queueing never resolves a pending decision
A queued message SHALL NOT answer, bypass, or race any pending approval or question, and the turn it becomes SHALL pass the same permission gate as any run. A message submitted while the run awaits a decision SHALL wait; its own actions SHALL be decided when its turn runs, under the then-current mode and remembered decisions.

#### Scenario: A queued message during an outstanding decision
- **WHEN** the operator submits a message while the active run awaits an approval or question, without requesting interrupt
- **THEN** the submission does not resolve the decision, does not grant anything, and waits for its own turn

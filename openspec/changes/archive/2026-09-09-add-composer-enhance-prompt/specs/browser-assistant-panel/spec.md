## ADDED Requirements

### Requirement: Composer prompt enhancement control
The composer SHALL offer a prompt-enhancement control positioned immediately before the send/stop control in the composer action row. Activating it SHALL submit the composer's current text to the companion for rewriting and SHALL replace the composer text with the rewritten result. The rewritten text SHALL preserve the language the operator wrote in. The composer text SHALL be the only input carried by the request: page context, conversation history, attachments, and provider profile secrets SHALL NOT be included. The control SHALL carry an accessible name and SHALL be reachable and operable by keyboard on the same terms as the send control.

#### Scenario: Successful enhancement
- **WHEN** the operator activates the enhancement control with a nonempty composer draft and the companion returns a rewritten prompt
- **THEN** the composer text is replaced by the rewritten prompt, the composer becomes editable again, and no message is added to the conversation

#### Scenario: Original language is preserved
- **WHEN** the operator's draft is written in a language other than English
- **THEN** the rewritten prompt returned to the composer is in that same language

#### Scenario: Undo restores the draft
- **WHEN** the composer text has been replaced by a rewritten prompt and the operator issues the browser's undo command in the composer
- **THEN** the text the operator had before enhancement is restored

### Requirement: Prompt enhancement availability
The enhancement control SHALL be unavailable when the composer is empty or contains only whitespace, when there is no conversation to compose into, when a run is queued, streaming, stopping, or waiting for permission, when an enhancement request for this panel is already in flight, and when the trimmed composer text begins with `/` (a slash command, whose literal text is what the companion dispatches on). Availability SHALL be derived from the same readiness signals the send control already uses; enhancement SHALL NOT introduce a separate provider-readiness gate that blocks the control while send remains usable.

#### Scenario: Empty draft
- **WHEN** the composer is empty or holds only whitespace
- **THEN** the enhancement control is disabled

#### Scenario: Slash command draft
- **WHEN** the trimmed composer text begins with `/`
- **THEN** the enhancement control is disabled, so the dispatched command text can never be rewritten

#### Scenario: Run in progress
- **WHEN** a run is queued, streaming, stopping, or waiting for permission
- **THEN** the enhancement control is disabled for the duration of that run

### Requirement: Prompt enhancement in-flight and cancellation
While an enhancement request is in flight the composer SHALL be read-only and marked busy, and the enhancement control SHALL act as Cancel. Cancelling SHALL instruct the companion to abandon the request. On cancellation, on any reported error, and on loss of the companion connection, the panel SHALL restore the exact composer text captured at the moment the request started and SHALL return the composer to its editable state. A late reply for a request that was cancelled SHALL be ignored rather than applied.

#### Scenario: Operator cancels
- **WHEN** the operator activates the enhancement control while a request is in flight
- **THEN** the companion is told to abandon that request, the composer is restored to the pre-request text, and any reply that arrives afterwards for that request is ignored

#### Scenario: Connection lost mid-request
- **WHEN** the companion connection drops while an enhancement request is in flight
- **THEN** the composer is restored to the pre-request text and becomes editable again

#### Scenario: Enhancement fails
- **WHEN** the companion reports an error for the enhancement request
- **THEN** the composer is restored to the pre-request text and the failure is shown to the operator as a distinguishable message, never as a silent no-op and never as a partial or empty draft

#### Scenario: Companion does not support enhancement
- **WHEN** the connected companion answers that it does not recognize the enhancement request
- **THEN** the panel reports that the companion needs updating and restores the composer to the pre-request text

### Requirement: Prompt enhancement is not a run
An enhancement request SHALL NOT create or advance a conversation, SHALL NOT append to any transcript, SHALL NOT emit run-state or action-timeline events, SHALL NOT take the browser lease, and SHALL NOT make any tool, skill, or browser automation available to the model answering it. It SHALL be answered by a bounded single-turn model call using the operator's already-configured provider profile.

#### Scenario: No transcript or run side effects
- **WHEN** an enhancement request completes, fails, or is cancelled
- **THEN** the conversation transcript, the run state shown in the panel, and the action timeline are all unchanged by it

#### Scenario: No browser or tool access
- **WHEN** the companion answers an enhancement request
- **THEN** the model answering it has no browser tools, no MCP servers, and no skills available, and no tab is opened, focused, or acted upon

#### Scenario: No configured provider
- **WHEN** the operator activates the enhancement control while no usable provider profile is configured
- **THEN** the request fails with a message naming that cause and the composer text is left untouched

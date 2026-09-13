## Purpose

Keep conversation history responsive, bounded, durable, and privacy-aware across panel restarts and multiple panel scopes.

## ADDED Requirements
### Requirement: Coalesced persistence
History updates SHALL be coalesced and persisted at most once per configured interval, with an immediate flush on run terminal states and explicit deletion.
#### Scenario: Streaming response
- **WHEN** token events arrive rapidly
- **THEN** the index is not rewritten for every event and the final metadata is durable when the run completes.
### Requirement: Bounded retention
The system SHALL enforce configurable maximum conversation count, prompt preview size, and transcript replay size, evicting only according to the configured retention policy.
#### Scenario: Retention limit reached
- **WHEN** a new conversation exceeds the count or byte limit
- **THEN** the oldest eligible entry is archived or removed according to policy and the user can see the outcome.
### Requirement: Privacy control
Users SHALL be able to disable raw prompt caching and clear all locally cached history.
#### Scenario: Prompt caching disabled
- **WHEN** a run is sent with caching disabled
- **THEN** the local index stores metadata and a preview-free entry, while the transcript remains governed by host retention.

## MODIFIED Requirements

### Requirement: Session and recording access
The panel SHALL support new conversation, list/reopen conversations, and deletion of conversations against authoritative host state, and SHALL support start/stop/list/attach recordings. Listing and reopening SHALL be driven by the host's conversation summaries, reconciled into the panel's local cache: a local entry the host does not report SHALL be shown as stale and SHALL NOT be presented as a fully reopenable conversation. Deletion SHALL be a host operation: the panel SHALL ask the host to remove the conversation's transcript, metadata and attachments, and SHALL drop its local cache entry only after the host acknowledges that removal. A deletion SHALL carry an idempotency key, so a replayed or concurrent delete of the same conversation resolves as the same successful outcome rather than a second failure. A deletion the host cannot confirm — an unknown conversation, an unreachable companion, or a companion that does not serve the history protocol — SHALL be reported as a failure with the local entry left intact, and SHALL never be reported as a local-only success; a delete-all that removes only part of the host's conversations SHALL report the sweep as incomplete and SHALL keep the local entries it could not confirm. Existing recording options including microphone permission and separate transcription credentials SHALL remain accessible. Toolbar recording behavior SHALL move to a labeled control rather than disappearing.

#### Scenario: Delete a conversation from the history list
- **WHEN** the user confirms deletion of a conversation in the history list
- **THEN** the host transcript, metadata and attachments are removed and the local cache entry is dropped only after the host acknowledges, and a deletion the host cannot confirm is shown as a failure with the entry still listed

#### Scenario: A conversation the host no longer reports
- **WHEN** the host's authoritative list does not contain a conversation the local cache holds
- **THEN** the panel marks that conversation stale, does not present it as a fully reopenable conversation, and keeps it removable so the stale row can be cleared

#### Scenario: A replayed delete is not a second failure
- **WHEN** two panels delete the same conversation at the same time
- **THEN** both requests resolve as the same successful outcome, and the host removes the conversation once

#### Scenario: Delete-all cannot be confirmed in full
- **WHEN** some conversations cannot be deleted from the host
- **THEN** the panel reports how many were left, keeps the local entries it could not confirm, and does not claim the whole history was cleared

#### Scenario: Attachment to conversation
- **WHEN** the user attaches a saved recording
- **THEN** the composer shows its identity and the companion makes its permitted trace/artifacts available to that conversation without an MCP channel

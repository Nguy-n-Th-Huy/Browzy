## Purpose

Provide a single authoritative lifecycle for conversations so reopening, deletion, export, and organization operate on the actual stored transcript.

## ADDED Requirements
### Requirement: Authoritative listing and reconciliation
The panel SHALL load host conversation summaries, reconcile orphaned local entries, and retain local-only prompt previews only when the host record is unavailable.
#### Scenario: Local cache contains an orphan
- **WHEN** the host list is returned
- **THEN** the orphan is marked stale or removed according to policy and is never presented as a fully reopenable conversation.
### Requirement: Complete deletion
Delete and delete-all SHALL remove host transcript, metadata, attachments, and local cache entries after explicit confirmation.
#### Scenario: User deletes a conversation
- **WHEN** deletion is confirmed
- **THEN** the host data is removed atomically or reported as failed; the UI never claims success for a local-only removal.
### Requirement: Organization and export
Users SHALL be able to rename, pin, archive, and export a conversation without changing its transcript contents.
#### Scenario: Export conversation
- **WHEN** export is selected
- **THEN** a local Markdown or JSON artifact is produced containing the selected transcript and metadata.

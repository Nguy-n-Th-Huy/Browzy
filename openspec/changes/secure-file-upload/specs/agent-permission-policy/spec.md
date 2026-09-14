## Purpose

Allow users to upload local files deliberately without granting the agent unrestricted filesystem path access.

## ADDED Requirements
### Requirement: User-mediated file grants
Uploads SHALL use a user-selected file or an explicit conversation-scoped grant, with filename, size, and MIME type shown before dispatch.
#### Scenario: Agent requests an upload
- **WHEN** no matching grant exists
- **THEN** the panel opens a chooser and does not send any file until the user confirms.
### Requirement: Grant containment and expiry
A grant SHALL be limited to the conversation and run policy, expire when revoked or the conversation is deleted, and reject path traversal or ungranted absolute paths.
#### Scenario: Agent reuses a revoked file
- **WHEN** a revoked grant is presented
- **THEN** upload is rejected and the user is asked to choose the file again.

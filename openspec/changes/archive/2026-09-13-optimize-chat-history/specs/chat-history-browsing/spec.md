## Purpose

Let users find and reopen conversations quickly without rendering or transferring the entire history at once.

## ADDED Requirements
### Requirement: Search and filters
The history view SHALL support debounced search by title, prompt preview, hostname, and conversation ID, plus date and domain filters.
#### Scenario: Search many conversations
- **WHEN** the user types a query
- **THEN** matching results update without rebuilding unrelated rows and stale queries are cancelled.
### Requirement: Incremental rendering
The view SHALL use pagination, infinite loading, or virtualization and SHALL preserve scroll position when new metadata arrives.
#### Scenario: Open history with hundreds of entries
- **WHEN** the history screen opens
- **THEN** only the first visible page is rendered and additional entries load on demand.
### Requirement: Live synchronization
Multiple panel instances SHALL converge on host changes and show loading, empty, offline, and error states distinctly.
#### Scenario: Delete in another panel
- **WHEN** a conversation is deleted elsewhere
- **THEN** the current panel removes or marks it stale without requiring a full page reload.

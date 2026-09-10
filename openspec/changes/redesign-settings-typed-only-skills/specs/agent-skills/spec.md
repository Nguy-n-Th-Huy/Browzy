## REMOVED Requirements

### Requirement: Local skill catalog
**Reason**: This requirement mandated the folder-import flow itself — importing a selected local skill folder, recording its source path, and refreshing the approved copy from that folder. That flow is removed: it obliged the application to accept a filesystem path from the extension and to read a directory it does not own, for no capability that composing a skill in the application does not already provide through the same validation pipeline.

**Migration**: Composing a skill in the application is now the only way a skill enters the catalog, covered by "In-app skill catalog" below. Skills already stored under the previous behavior are not migrated and are not rewritten: they stay listed, enabled or disabled, editable and removable, and editing them loads the content from the approved copy the application already holds. What such a skill loses is the ability to be re-read from its original folder; its content is changed by editing it in the application instead.

## ADDED Requirements

### Requirement: In-app skill catalog
Settings SHALL allow users to compose a skill directly in the application — a name, a description, a Markdown body, an optional allowed-tools hint and its invocation flags — and SHALL store it as the application's own approved copy. Composing in the application SHALL be the only way a skill enters the catalog: no interface the extension can invoke SHALL accept a filesystem path, and none SHALL read, copy or watch a directory the application does not own. Users SHALL be able to inspect a stored skill's name, description and stored content, load it back for editing, duplicate it under a name that is not taken, enable or disable it, and remove it. Creating or editing a skill SHALL never execute anything found in the stored content. Only skills that are stored and enabled SHALL be available to assistant sessions.

Validation SHALL reject before writing anything: a name outside the permitted character set, a name that would traverse outside the catalog's own storage, a missing description, an empty body, and a name already held by a different skill. Each rejection SHALL name the offending field, and a rejected submission SHALL leave the catalog and its stored files unchanged.

#### Scenario: Compose and reuse
- **WHEN** the user fills in a valid name, description and body, creates the skill, and enables it
- **THEN** the catalog shows its metadata and the skill remains available after browser restart without repeating setup

#### Scenario: Invalid submission
- **WHEN** a submission carries an invalid name, a traversal-shaped name, a missing description, an empty body, or a name already used by a different skill
- **THEN** the submission is rejected with a specific explanation identifying the field, and the existing catalog and its stored files remain unchanged

#### Scenario: No interface accepts a filesystem path
- **WHEN** the settings operations the extension can invoke are enumerated
- **THEN** none of them accepts a directory or file path as input, and none reads a location outside the application's own catalog storage

#### Scenario: Load a stored skill back for editing
- **WHEN** the user chooses to edit a stored skill
- **THEN** the application returns that skill's stored name, description, body, allowed-tools hint and invocation flags from its own approved copy, and submitting the edited form replaces that skill's stored content in place rather than creating a second entry

#### Scenario: Duplicate a stored skill
- **WHEN** the user chooses to duplicate a stored skill
- **THEN** the application offers that skill's stored content under a name that is not yet taken, and creating it leaves the original skill unchanged

#### Scenario: Reading a stored skill cannot be steered outside the catalog
- **WHEN** a read-back request names a skill that does not exist, or carries a name containing path separators or traversal segments
- **THEN** the request is rejected without opening any file, and no path outside the application's own catalog storage is read

#### Scenario: A skill stored before this behavior existed
- **WHEN** the catalog already holds a skill that entered it under the previous folder-import behavior
- **THEN** it is still listed, can still be enabled, disabled, edited, duplicated and removed, and editing it loads the content from the application's approved copy rather than from its original folder

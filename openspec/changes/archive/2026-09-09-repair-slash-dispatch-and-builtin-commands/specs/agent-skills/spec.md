## MODIFIED Requirements

### Requirement: Searchable slash picker
Typing `/` in the composer SHALL open a picker of enabled user-invocable skills with names, descriptions, filtering, keyboard navigation, and an empty state. Selection SHALL insert the exact invocation for review before Send. Keyboard navigation SHALL accept the highlighted entry on both Enter and Tab, while leaving Shift+Tab to ordinary focus movement. Built-in commands SHALL be distinguished from skills and limited to commands supported by the selected SDK version and permitted by the application; the supported set SHALL be the list the SDK itself advertises at runtime, less any entries the SDK marks as terminal-bound, and SHALL NOT be a statically assumed list. An invocation the picker offers SHALL actually run when sent.

#### Scenario: Select a skill
- **WHEN** the user types `/`, filters by name or description, and presses Enter on an entry
- **THEN** the composer contains that skill invocation, accepts additional task arguments, and does not submit until Send

#### Scenario: Accept with Tab
- **WHEN** the picker is open with an entry highlighted and the user presses Tab
- **THEN** that entry is inserted exactly as Enter would insert it, and focus stays in the composer

#### Scenario: Shift+Tab is not an accept key
- **WHEN** the picker is open and the user presses Shift+Tab
- **THEN** no entry is inserted and focus moves as it normally would

#### Scenario: A picked skill invocation runs
- **WHEN** the user sends a picker-inserted invocation for an enabled, user-invocable skill
- **THEN** the run applies that skill instead of failing with an unknown-command error, and the conversation transcript shows the operator's own literal slash text unchanged

#### Scenario: Built-in commands come from the SDK's advertised list
- **WHEN** the SDK has advertised its supported slash commands for the operator's configuration
- **THEN** the picker offers only those advertised commands that are neither terminal-bound nor absent from the application's approved allowlist, visually distinguished from skills

#### Scenario: No advertised list yet
- **WHEN** the SDK has not yet advertised a slash-command list for this installation
- **THEN** the picker offers skills only and claims no built-in command, rather than presenting an assumed one

#### Scenario: Nothing is currently approved
- **WHEN** the application's approved built-in allowlist is empty
- **THEN** no built-in command is offered no matter what the SDK advertises, and the picker is skills-only

#### Scenario: Disabled or unknown manual command
- **WHEN** the user manually types a disabled, unknown, or disallowed slash command
- **THEN** the companion rejects it before SDK dispatch with an actionable message, even if the SDK itself could discover that command

#### Scenario: Approved built-in is not rejected as an unknown skill
- **WHEN** the user sends a slash command that is absent from the skill catalog but present in the application's approved built-in allowlist and in the SDK's advertised list
- **THEN** the companion allows it through and passes it to the SDK exactly as typed, without rewriting it

## ADDED Requirements

### Requirement: Authorized slash dispatch reaches the SDK in a form it honours
A slash command SHALL pass the application's authorization gate before anything reaches the SDK. Once authorized, a command naming a **skill** SHALL be conveyed to the model in a form that actually invokes that skill. The conveyed form SHALL be a fixed, inspectable construction that carries the operator's own arguments verbatim; it SHALL NOT paraphrase, summarize, or reinterpret what the operator wrote. The composer text and the conversation transcript SHALL continue to show the operator's literal input.

#### Scenario: Skill dispatch is conveyed, not passed through raw
- **WHEN** an authorized slash command names a skill and the operator added task arguments after it
- **THEN** the model receives an instruction to use that named skill together with those arguments unchanged, and the operator's arguments appear in it verbatim

#### Scenario: The named skill is actually available to the model
- **WHEN** a run carrying an authorized skill dispatch is constructed
- **THEN** the skill named by that dispatch is among the skills the SDK has discovered for the run, so invoking it succeeds rather than failing as an unknown skill

### Requirement: Skill discovery is scoped to the session workspace
The approved skill snapshots the application materializes for a conversation SHALL be discoverable by the SDK, and that discovery SHALL be confined to the application-built session workspace. The operator's own global configuration directory SHALL NOT be loaded. No directory outside the session workspace SHALL contribute a skill, a command, or a setting to a run. The application's own catalog SHALL remain the authorization list; discoverability SHALL NOT by itself authorize anything.

#### Scenario: Workspace skills are discovered
- **WHEN** a conversation's session workspace has been built with an approved skill snapshot
- **THEN** that skill appears among the skills the SDK reports for the run

#### Scenario: Nothing above the workspace is loaded
- **WHEN** a directory above the session workspace contains its own skill definitions
- **THEN** none of them appear among the skills the SDK reports for the run

#### Scenario: The operator's global configuration is not loaded
- **WHEN** a run is constructed while the operator's global configuration directory holds skills of its own
- **THEN** none of those skills are available to the run

#### Scenario: Discoverable is still not authorized
- **WHEN** a skill is discoverable in the session workspace but is disabled or not user-invocable in the application's catalog
- **THEN** a slash dispatch naming it is still rejected by the authorization gate before the SDK is reached

#### Scenario: Rejected dispatch reaches nothing
- **WHEN** a slash command fails the authorization gate
- **THEN** no conveyed form is constructed and no model call is made for it

### Requirement: Advertised slash-command list is recorded and served
The application SHALL record the slash-command list the SDK advertises when a model session starts, capturing it from every place this product starts a real session, including the Settings connection test. The record SHALL survive a companion restart. The panel SHALL be able to read the record without starting a run. The record SHALL be treated as a statement of what the SDK supports, never as authorization by itself.

#### Scenario: Recorded from a connection test
- **WHEN** the operator runs the Settings connection test and the SDK advertises its slash commands
- **THEN** the advertised list is recorded, and the picker can offer approved built-ins afterwards without any conversation having been run

#### Scenario: Survives a restart
- **WHEN** the companion process restarts after a list was recorded
- **THEN** the previously recorded list is still readable, and the picker does not silently lose its built-in entries

#### Scenario: Advertisement is not authorization
- **WHEN** the SDK advertises a command that the application's allowlist does not contain
- **THEN** the picker does not offer it and the companion does not treat it as an approved built-in

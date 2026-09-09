## MODIFIED Requirements

### Requirement: Native skill execution
The assistant SHALL support explicit slash invocation and automatic invocation of enabled compatible skills through the SDK, respecting user-invocable and disable-model-invocation metadata. It SHALL provide approved relative skill resources when needed and display skill activity or errors in the conversation. A skill SHALL not change provider settings, access secrets, expand browser scope, or grant itself additional execution permissions. Reusable workflows SHALL be a separate registry category and SHALL inherit the same authorization rather than becoming skills implicitly.

#### Scenario: Explicit browser-workflow skill
- **WHEN** the user submits an enabled user-invocable browser skill with task arguments
- **THEN** the SDK invokes that skill and its browser operations use the existing authorized tool/session scope

#### Scenario: Automatic use
- **WHEN** a user task matches an enabled skill whose metadata permits automatic invocation
- **THEN** the SDK can invoke it without requiring the user to type its name, and the transcript identifies the skill used

#### Scenario: Unsupported script requirement
- **WHEN** an imported skill requires host shell execution, writes, or other capabilities outside the available tools
- **THEN** the assistant identifies the unavailable capability instead of enabling tools implicitly or claiming successful execution

### Requirement: Searchable slash picker
Typing `/` in the composer SHALL open a picker of enabled user-invocable skills with names, descriptions, filtering, keyboard navigation, and an empty state. Selection SHALL insert the exact invocation for review before Send. Keyboard navigation SHALL accept the highlighted entry on both Enter and Tab, while leaving Shift+Tab to ordinary focus movement. Built-in commands SHALL be distinguished from skills and limited to commands supported by the selected SDK version and permitted by the application; the supported set SHALL be the list the SDK itself advertises at runtime, less any entries the SDK marks as terminal-bound, and SHALL NOT be a statically assumed list. An invocation the picker offers SHALL actually run when sent. Workflows SHALL be shown in a separately labeled workflow surface/category; a skills-only empty state SHALL not claim that workflows are unavailable when workflow discovery is merely separate or not loaded.

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
- **THEN** the picker offers skills only and claims no built-in command, rather than presenting an assumed one; a separate workflow surface may report its own registry status

#### Scenario: Nothing is currently approved
- **WHEN** the application's approved built-in allowlist is empty
- **THEN** no built-in command is offered no matter what the SDK advertises, and the picker is skills-only

#### Scenario: Disabled or unknown manual command
- **WHEN** the user manually types a disabled, unknown, or disallowed slash command
- **THEN** the companion rejects it before SDK dispatch with an actionable message, even if the SDK itself could discover that command

#### Scenario: Approved built-in is not rejected as an unknown skill
- **WHEN** the user sends a slash command that is absent from the skill catalog but present in the application's approved built-in allowlist and in the SDK's advertised list
- **THEN** the companion allows it through and passes it to the SDK exactly as typed, without rewriting it

## Purpose

Let users reuse local skill packages within the browser assistant through Claude Agent SDK and discover or invoke those skills from an accessible slash-command interface.

## ADDED Requirements

### Requirement: Local skill catalog
Settings SHALL allow users to import a selected local skill folder containing SKILL.md and relative resources, inspect its name, description and source, enable or disable it, refresh its approved copy, and remove the application copy. Import SHALL never execute package scripts or change the original source files. Only explicitly imported and enabled packages SHALL be available to assistant sessions.

#### Scenario: Import and reuse
- **WHEN** the user imports a valid skill folder and enables it
- **THEN** the catalog shows its metadata and the skill remains available after browser restart without repeating setup

#### Scenario: Invalid package
- **WHEN** a selected package has invalid metadata, a duplicate name, escaping symlinks, or path traversal
- **THEN** import is rejected with a specific explanation and the existing catalog remains unchanged

### Requirement: Native skill execution
The assistant SHALL support explicit slash invocation and automatic invocation of enabled compatible skills through the SDK, respecting user-invocable and disable-model-invocation metadata. It SHALL provide approved relative skill resources when needed and display skill activity or errors in the conversation. A skill SHALL not change provider settings, access secrets, expand browser scope, or grant itself additional execution permissions.

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
Typing `/` in the composer SHALL open a picker of enabled user-invocable skills with names, descriptions, filtering, keyboard navigation, and an empty state. Selection SHALL insert the exact invocation for review before Send. Built-in commands SHALL be distinguished from skills and limited to commands supported by the selected SDK version and permitted by the application. The reference image SHALL not be treated as a required bundled skill list.

#### Scenario: Select a skill
- **WHEN** the user types `/`, filters by name or description, and presses Enter on an entry
- **THEN** the composer contains that skill invocation, accepts additional task arguments, and does not submit until Send

#### Scenario: Disabled or unknown manual command
- **WHEN** the user manually types a disabled, unknown, or disallowed slash command
- **THEN** the companion rejects it before SDK dispatch with an actionable message, even if the SDK itself could discover that command

### Requirement: Skill version and lifecycle isolation
Conversations SHALL bind to approved skill snapshots. Editing original source files SHALL not silently change a running conversation. Disabling a skill SHALL prevent subsequent invocation, including manually typed slash commands; active affected runs SHALL be interrupted before their next tool dispatch. Removing the app copy SHALL leave source files untouched.

#### Scenario: Refresh during a run
- **WHEN** the user refreshes an imported package while a run is active
- **THEN** the run keeps its existing approved snapshot and new conversations can use the refreshed snapshot

#### Scenario: Resume with unavailable skill
- **WHEN** a resumed conversation references a disabled or unavailable skill snapshot
- **THEN** the assistant reports the mismatch and requires a new conversation rather than silently loading different instructions

## Purpose

Lets the operator define, store and select named AI agents — each with its own description, system prompt, model, tool allowance, preloaded skills and turn cap — so one conversation can run a chosen agent and delegate to the others, without any agent ever gaining authority the run itself does not already hold.

## ADDED Requirements

### Requirement: Local agent catalog

The system SHALL maintain an application-owned agent catalog stored under the agent home directory, independent of any browser profile and of the operator's own Claude Code configuration. Each catalog entry SHALL record at minimum: a validated `name`, a `description`, the agent's system `prompt`, an optional declared `model`, an optional declared tool-name list, an optional preloaded skill-name list, an optional maximum-turns integer, an `enabled` flag, the entry's origin (imported or authored), and a last-updated timestamp. The catalog SHALL be written atomically so that an interrupted write never leaves a partially-written catalog that a later read must guess at. Each entry SHALL additionally have an immutable on-disk snapshot of the source content it was created from, so that editing or deleting the operator's original file cannot silently change what a run executes.

#### Scenario: Catalog survives an interrupted write

- **WHEN** the catalog file write is interrupted after the temporary file is written but before it replaces the live catalog
- **THEN** a subsequent read returns the previous complete catalog, and no entry is reported as partially defined

#### Scenario: Editing the source file does not change a stored agent

- **WHEN** an agent was imported from a file and the operator afterwards edits or deletes that source file
- **THEN** the catalog entry and its snapshot are unchanged, and a run using that agent uses the snapshot content

#### Scenario: Listing shows disabled entries too

- **WHEN** the catalog is listed for the management surface
- **THEN** every entry is returned with its `enabled` flag, including disabled entries, so a disabled agent can be seen and re-enabled

### Requirement: Agent names and paths are validated, never guessed

The system SHALL accept an agent `name` only if it matches the same identifier pattern the skill catalog already enforces — an initial alphanumeric character followed by up to 63 further characters drawn from letters, digits, underscore and hyphen — and SHALL reject any name containing a path separator or a parent-directory segment. Every name used as an on-disk path segment SHALL be re-validated at the point of use, not only at import. Metadata the system cannot confidently parse SHALL be rejected with a named error identifying the offending field; it SHALL NOT be repaired, defaulted, or partially accepted.

#### Scenario: Traversal in a name is rejected

- **WHEN** an import or author request supplies a name containing `..`, `/` or `\`
- **THEN** the request fails with a validation error naming the field, and no file or directory is created anywhere

#### Scenario: Unparseable metadata is rejected, not guessed

- **WHEN** an imported file's frontmatter contains a construct the parser cannot confidently interpret, or is missing its closing delimiter
- **THEN** the import fails with a validation error identifying the problem, and no catalog entry is created

#### Scenario: A missing required field fails the import

- **WHEN** an imported file omits `name`, omits `description`, or has an empty body after its frontmatter
- **THEN** the import fails with a validation error naming the missing field, and no catalog entry is created

### Requirement: Two authoring paths produce one record shape

The system SHALL support creating an agent by **importing** a markdown file whose YAML frontmatter carries `name` and `description` and optionally `model`, `tools`, `skills` and `max-turns`, with the markdown body below the frontmatter taken verbatim as the agent's system prompt; and by **authoring** the same fields directly through the management surface. Both paths SHALL produce records that are indistinguishable in shape and in every field that affects a run, differing only in the recorded origin. Neither path SHALL execute, evaluate, or interpret anything found in the source location; files are read and copied only.

#### Scenario: Imported and authored agents behave identically at run time

- **WHEN** an agent is imported from a file and an equivalent agent is authored with the same field values
- **THEN** both produce the same effective definition for a run, and differ only in the recorded origin shown in the management surface

#### Scenario: A source folder is never executed

- **WHEN** an agent is imported from a folder containing executable or script files
- **THEN** no file in that folder is executed or evaluated during import, refresh, or any later run

### Requirement: An agent's tool allowance is an intersection, never a grant

The system SHALL compute each agent's effective tool list as the set intersection of the tool names the agent's record declares and the tool names the current run itself actually holds. A declared tool name that the run does not hold SHALL be dropped from the effective list and reported to the operator; it SHALL NOT be forwarded to the model runtime. When an agent declares no tools, its effective list SHALL be the run's own list, never a wider one. The system SHALL additionally, in its own code, mark the high-risk built-in tools — arbitrary shell execution and direct filesystem write/edit operations — as disallowed for every agent it emits, rather than relying on any default of the underlying model runtime.

#### Scenario: A declared tool the run does not hold is dropped

- **WHEN** an agent's record declares a tool name that is not part of the current run's own allowance
- **THEN** that name is absent from the definition handed to the model runtime, and the operator is shown that it was dropped and why

#### Scenario: High-risk built-ins are refused for every agent

- **WHEN** an agent's record declares a shell-execution or filesystem-write tool, by any spelling the record permits
- **THEN** that tool is explicitly disallowed for that agent in the emitted definition, the run still starts, and the operator is shown that the declaration was refused

#### Scenario: An agent declaring no tools does not gain any

- **WHEN** an agent's record declares no tool list at all
- **THEN** its effective tool list equals the run's own allowance exactly, with no additional name present

### Requirement: A selected agent narrows authority and never widens it

An agent definition SHALL NOT widen the run's tab scope, SHALL NOT add any entry to the run's upload allowlist, and SHALL NOT cause any tool call to skip the per-call authorization and approval checks that the same call would face without an agent selected. Selecting an agent SHALL NOT change which calls require an operator approval decision.

#### Scenario: An agent cannot reach a tab outside the run's scope

- **WHEN** an agent attempts a browser operation on a tab outside the run's authorized scope
- **THEN** the operation is rejected exactly as it would be with no agent selected

#### Scenario: Approval is still required with an agent selected

- **WHEN** an agent performs an action that requires an operator approval decision
- **THEN** the same approval is requested and awaited, and the action does not proceed until it is granted

### Requirement: Agent definitions are supplied programmatically, never discovered from disk

The system SHALL supply agent definitions to the model runtime as explicit in-process values derived from its own catalog. It SHALL NOT enable, widen, or rely on any runtime mechanism that discovers agent definitions by scanning the filesystem, the operator's own tool configuration, or any ancestor directory of the session workspace. The existing isolation posture — no external setting sources, strict server configuration — SHALL remain unchanged by this capability.

#### Scenario: An unrelated on-disk agent file is not loaded

- **WHEN** an agent definition file exists in the operator's own tool configuration directory or in an ancestor of the session workspace, and is not in this catalog
- **THEN** it is not available to the run, and it does not appear in the run's agent list

#### Scenario: Only enabled catalog entries reach a run

- **WHEN** the catalog contains both enabled and disabled entries
- **THEN** only the enabled entries are supplied to the run

### Requirement: An agent's prompt composes with the run's own system prompt

An agent's system prompt SHALL be added to, and SHALL NOT replace or suppress, the run's browser-automation instructions and its bound page-context block. An agent SHALL NOT be able to shed either of those by being selected.

#### Scenario: Browser-automation instructions survive agent selection

- **WHEN** a run starts with an agent selected whose prompt says nothing about browser tools
- **THEN** the run's browser-automation instructions are still in force, and the agent's prompt is present in addition to them

#### Scenario: Bound page context survives agent selection

- **WHEN** a run has a bound page context and an agent is selected
- **THEN** the bound page-context block is still supplied, unchanged, alongside the agent's prompt

### Requirement: Model resolution is explicit and its fallback is visible

An agent MAY declare a model. The system SHALL resolve that declaration against the models available for the operator's active provider profile. When it resolves, the agent SHALL run on the declared model. When it does not resolve, the agent SHALL run on the active profile's own model and the run SHALL surface a named notice identifying the agent, the unresolvable declaration, and the model actually used. The system SHALL NOT start an agent on a model different from the one its management surface and the run notice report.

#### Scenario: A declared model that is available is used

- **WHEN** an agent declares a model that the active profile's model catalog contains
- **THEN** the agent runs on that model, and no fallback notice is shown

#### Scenario: An unavailable model falls back visibly

- **WHEN** an agent declares a model that the active profile's model catalog does not contain
- **THEN** the run starts on the profile's own model and shows a notice naming the agent, the declared model, and the model used

#### Scenario: Switching profiles re-resolves the declaration

- **WHEN** the operator switches to a profile whose model catalog no longer contains an agent's declared model
- **THEN** the next run using that agent applies the fallback and shows the notice, rather than reusing the earlier resolution

### Requirement: One primary agent per conversation, restored across reload and resume

The system SHALL let the operator select at most one primary agent for a conversation, and SHALL persist that selection with the conversation so that a panel reload, a companion restart, or a resumed session restores the same selection. Selecting no agent SHALL be a first-class state whose run behavior is identical to a system with no agent catalog at all. Every message the operator submits SHALL retain the agent identity that was in effect when it was submitted; changing the selection SHALL NOT retroactively re-attribute earlier messages.

#### Scenario: Selection survives a reload

- **WHEN** the operator selects an agent, then reloads the panel and reopens the same conversation
- **THEN** the same agent is still selected

#### Scenario: No agent selected is byte-identical to today

- **WHEN** a run starts in a conversation with no agent selected
- **THEN** the run's supplied options contain no agent definitions and are otherwise identical to a run made before this capability existed

#### Scenario: Changing selection does not rewrite history

- **WHEN** the operator changes the selected agent mid-conversation
- **THEN** already-submitted messages remain attributed to the agent in effect when they were submitted

### Requirement: Agent lifecycle changes take effect at the next run, not mid-run

Enabling, disabling, removing, refreshing or editing an agent SHALL take effect for the next run started in any conversation, and SHALL NOT alter the definitions already bound to a run that is currently executing. Removing an agent SHALL delete its catalog entry and its snapshot, and SHALL NOT touch the operator's original source location. Removing or disabling the agent a conversation has selected SHALL leave that conversation in the no-agent-selected state with a visible notice, and SHALL NOT prevent the conversation from being used.

#### Scenario: Disabling mid-run does not change the running run

- **WHEN** an agent is disabled while a run using it is executing
- **THEN** that run continues with the definitions it started with, and the next run does not include the disabled agent

#### Scenario: Removing the selected agent leaves the conversation usable

- **WHEN** the operator removes the agent currently selected for a conversation
- **THEN** the conversation falls back to no-agent-selected with a visible notice, and a new run can still be started

#### Scenario: Removal never touches the source

- **WHEN** an imported agent is removed from the catalog
- **THEN** its catalog entry and snapshot are deleted and the operator's original source file or folder is left untouched

### Requirement: Agent management and selection surfaces

The system SHALL provide a management surface for listing, importing, authoring, enabling, disabling, refreshing and removing agents, and a selection control in the assistant panel for choosing the conversation's primary agent. Both surfaces SHALL meet the accessibility guarantees the assistant panel already holds: usable at 320px width, fully reachable and operable by keyboard, meeting WCAG 2.1 AA contrast, and announcing state changes through the existing polite live region. Every rejection — an invalid name, an unparseable file, a dropped tool declaration, a refused high-risk tool, an unresolvable model — SHALL be shown with a specific reason, never a silent no-op.

#### Scenario: The picker is operable by keyboard alone

- **WHEN** the operator navigates to the agent selection control using only the keyboard
- **THEN** the control can be focused, opened, navigated and committed without a pointer, and the resulting selection is announced

#### Scenario: A rejected import states its reason

- **WHEN** an import fails validation
- **THEN** the management surface shows the specific reason and the offending field, and the catalog is unchanged

#### Scenario: The surfaces remain usable at minimum width

- **WHEN** the panel is displayed at 320px width with the selection control present
- **THEN** the control and its labels remain visible, operable, and legible without horizontal scrolling of the panel body

### Requirement: Usage accounting states what it can and cannot attribute

The system SHALL continue to account for consumption incurred by delegated agents, using the cumulative per-model accounting that already includes delegated work rather than the aggregate that excludes it. The system SHALL NOT present per-named-agent cost or token attribution, because the available accounting is keyed by model and not by agent. Any surface that reports usage alongside agents SHALL state that limitation rather than imply an attribution it cannot support.

#### Scenario: Delegated consumption is still counted

- **WHEN** a run delegates work to an agent and that delegated work consumes tokens
- **THEN** that consumption appears in the conversation's usage record

#### Scenario: Per-agent attribution is not claimed

- **WHEN** a usage surface is shown for a conversation that used more than one agent
- **THEN** no per-agent cost or token figure is presented, and the surface states that attribution is per model, not per agent

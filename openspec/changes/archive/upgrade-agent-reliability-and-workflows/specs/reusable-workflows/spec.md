## Purpose

Provide user-owned, parameterized browser workflows that can be safely discovered, reviewed, and reused without bypassing the assistant's existing authorization, document binding, provider, or usage controls.

## ADDED Requirements

### Requirement: Durable workflow records
The application SHALL store workflows with a stable id, name, description, version, owner, portability metadata, ordered steps or approved invocation template, declared parameter schema, exact domain/document constraints, required capabilities, created/updated timestamps, and enabled state. Records SHALL be validated atomically and SHALL reject missing fields, unsafe capabilities, path traversal, unsupported steps, duplicate identities, and ambiguous parameter schemas.

#### Scenario: Save valid workflow
- **WHEN** a user saves a workflow with valid parameters, steps, and exact domain constraints
- **THEN** it is persisted as a new version and appears in the user's workflow registry after restart

#### Scenario: Invalid workflow
- **WHEN** a workflow contains an unsupported step, undeclared parameter, unsafe capability, malformed domain, or duplicate identity
- **THEN** saving is rejected with a specific reason and the previous record remains unchanged

### Requirement: Workflow CRUD and ownership
Users SHALL be able to list, inspect, edit, enable, disable, export, import, and delete workflows they own. Imported workflows SHALL be treated as untrusted data until validated, SHALL retain declared ownership/provenance, and SHALL not execute package scripts or silently gain access to another user's records.

#### Scenario: Import and portability
- **WHEN** a user imports a valid workflow export
- **THEN** it is stored under the importing user's ownership with its version and provenance visible, without importing credentials or hidden permissions

#### Scenario: Delete workflow
- **WHEN** an owner deletes a workflow
- **THEN** it disappears from discovery for future runs while active runs retain their immutable snapshot and finish or stop under that snapshot

### Requirement: Exact discovery and parameter validation
The registry and sidepanel/MCP discovery surfaces SHALL expose only enabled workflows whose exact identity is requested or whose declared domain and document constraints match the current bound context. Domain matching SHALL use parsed, normalized host/domain rules rather than substring matching. Required, optional, type, range, enum, and secret-bearing parameters SHALL be validated before a draft can execute, and secret values SHALL be redacted from previews and transcripts.

#### Scenario: Substring domain mismatch
- **WHEN** a workflow allows `example.com` and the current host is `notexample.com`
- **THEN** the workflow is not considered a match

#### Scenario: Missing parameter
- **WHEN** a user attempts to run a workflow without a required parameter or with an invalid value
- **THEN** execution is blocked and the missing or invalid field is identified before any browser action

### Requirement: Safe execution through existing policy
Workflow execution SHALL be translated into the existing tool/skill dispatch path and SHALL inherit the current run's provider, skills, browser lease, tab scope, document identity, approval policy, cancellation, and usage budget. A workflow MUST NOT invoke arbitrary shell commands, hidden browser routes, direct CDP outside the existing adapter, or a second authorization channel.

#### Scenario: Sensitive workflow step
- **WHEN** a workflow reaches a send, submit, payment, confirmation, unknown-target, or otherwise sensitive step
- **THEN** the ordinary evidence-backed approval policy pauses it and a workflow definition cannot auto-approve it

#### Scenario: Document changes during workflow
- **WHEN** the bound document changes between workflow steps
- **THEN** the workflow pauses or fails with a stale-document result and does not act on the replacement page

### Requirement: Reviewable draft and truthful result
Before execution, the panel SHALL show the resolved workflow identity, version, parameter values, matched domain/document, planned action classes, and any unknowns. A recording-derived draft MAY be offered only when every step, parameter, domain, and document binding is fully resolved and reviewable; otherwise the system SHALL refuse draft generation with a specific reason. The transcript SHALL identify the workflow version and actual step outcomes without claiming unexecuted steps succeeded.

#### Scenario: Complete draft
- **WHEN** all workflow parameters and targets are resolved and the user reviews the draft
- **THEN** the draft is executable through ordinary Send and its actual step results appear in order

#### Scenario: Incomplete recording draft
- **WHEN** a recording cannot establish an exact parameter, target, domain, or document binding
- **THEN** no executable workflow draft is created and the user receives a specific incomplete-evidence explanation

### Requirement: Discoverability and compatibility
Workflows SHALL be discoverable through the existing sidepanel registry and MCP schemas with stable versioned metadata, and unsupported or stale peers SHALL receive an explicit update/schema error. Workflow advertisements SHALL never grant authorization, and workflow records SHALL not alter existing skill, external MCP, overlay, attachment, or recording contracts.

#### Scenario: Stale companion
- **WHEN** the sidepanel requests workflow operations from a companion that does not support them
- **THEN** the panel reports that the companion requires an update and does not retry through an unrecognized or weaker path

#### Scenario: Advertisement is not authority
- **WHEN** a workflow is discoverable but disabled, not owned, out of scope, or not approved for the current run
- **THEN** it cannot be invoked and no browser action is dispatched

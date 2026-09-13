## Purpose

Lets a user connect their own MCP servers so the assistant can call their tools in the same run as its browser tools, under a catalog the user controls and boundaries a connector can never cross.

## ADDED Requirements

### Requirement: The user manages a connector catalog
Settings SHALL let the user add an MCP server connector, inspect its name, transport, source and the tools it advertises, enable or disable it, and remove it. Adding a connector SHALL NOT start it or execute anything from it. A connector SHALL be contacted only when the user asks to inspect it or enables it. Only an explicitly added and enabled connector SHALL be available to a run. The catalog SHALL survive a browser restart without repeating setup.

#### Scenario: Adding and enabling a connector
- **WHEN** the user adds a valid connector and enables it
- **THEN** the catalog shows its name, transport, source and advertised tools, and it remains available after a browser restart

#### Scenario: Adding does not run anything
- **WHEN** the user adds a connector but does not inspect or enable it
- **THEN** nothing from that connector is started or executed

#### Scenario: A disabled connector is unreachable
- **WHEN** a connector is present in the catalog but disabled and a run attempts one of its tools
- **THEN** the call is refused naming the connector as disabled, and the connector is not contacted

#### Scenario: An invalid connector
- **WHEN** the user adds a connector whose configuration is invalid, whose name duplicates an existing one, or which cannot be contacted on inspection
- **THEN** it is rejected with a specific explanation and the existing catalog is unchanged

#### Scenario: Removing a connector
- **WHEN** the user removes a connector
- **THEN** its tools stop being offered to any new run, its stored credential is removed, and the catalog no longer lists it

#### Scenario: Disabling during a run
- **WHEN** the user disables a connector while a run is in progress
- **THEN** calls to its tools after that point are refused naming the connector as disabled, and already returned results are not retroactively altered

### Requirement: Connector tools are namespaced and can never impersonate a browser operation
Every tool from a connector SHALL be exposed under a name that identifies its connector, and SHALL NOT shadow, replace, or be presentable as one of this product's own browser operations. Two connectors advertising the same tool name SHALL remain distinguishable. A connector SHALL NOT contribute to, satisfy, or violate the browser operation baseline, and a user-configured tool SHALL NOT be reported as an unaccounted-for registry operation.

#### Scenario: A connector advertises a browser operation's name
- **WHEN** an enabled connector advertises a tool whose name matches one of this product's browser operations
- **THEN** the browser operation is what that name resolves to, the connector's tool remains reachable only under its namespaced name, and the collision is surfaced to the user

#### Scenario: Two connectors advertise the same tool name
- **WHEN** two enabled connectors each advertise a tool of the same name
- **THEN** both remain callable and distinguishable by connector, and neither silently replaces the other

#### Scenario: Baseline accounting ignores connectors
- **WHEN** the browser operation registry is checked against its baseline and its enumerated additions
- **THEN** connector tools are not counted as registry operations, and their presence neither satisfies a missing baseline operation nor raises an unaccounted-for discrepancy

### Requirement: Connector credentials are held on the same terms as the provider credential
A credential a connector needs SHALL be stored by the native companion in the OS credential store. It SHALL NOT appear in extension storage, content scripts, repository files, command-line arguments, exported settings, diagnostics, or logs. The settings UI SHALL clear the raw value after submission and show only whether a credential is saved. Where secure storage is unavailable, persistence SHALL fail explicitly and a clearly labeled memory-only mode SHALL be offered.

#### Scenario: A saved connector credential is not readable back
- **WHEN** the user saves a connector credential and returns to settings
- **THEN** the UI shows only that a credential is saved, and the raw value is not displayed or recoverable through the UI

#### Scenario: Diagnostics and exports
- **WHEN** the user views diagnostics or exports settings
- **THEN** no connector credential appears in the output

#### Scenario: Secure storage unavailable
- **WHEN** the OS credential store cannot be used
- **THEN** saving fails explicitly and a clearly labeled memory-only mode is offered rather than falling back to unprotected storage

#### Scenario: Removing a connector credential
- **WHEN** the user removes a connector's credential
- **THEN** calls to that connector requiring it fail with a specific reason until a new credential is entered

### Requirement: A connector's failure is contained
A connector that fails to start, becomes unreachable, hangs, or returns malformed output SHALL fail as that connector. The run SHALL remain usable, the browser tools SHALL remain available, and other connectors SHALL be unaffected. A call to an unreachable connector SHALL resolve with a distinguishable reason within a bounded time rather than remaining outstanding.

#### Scenario: A connector is unreachable
- **WHEN** a run calls a tool on a connector that cannot be reached
- **THEN** that call resolves with a reason naming the connector, and the run continues able to use browser tools and other connectors

#### Scenario: A connector hangs
- **WHEN** a connector accepts a call and does not answer within its bounded time
- **THEN** the call resolves as a timeout naming the connector, distinguishable from a refusal and from a successful empty result

#### Scenario: Malformed output
- **WHEN** a connector returns output that does not conform to what it advertised
- **THEN** the call reports the malformed result rather than passing unusable content on as though it were valid

#### Scenario: One connector's failure does not affect another
- **WHEN** one enabled connector is failing
- **THEN** other enabled connectors and the browser tools continue to work normally

### Requirement: A connector is a tool provider and nothing more
A connector SHALL NOT change provider settings, read or obtain credentials, alter the permission mode or any remembered permission decision, expand the run's browser tab scope, enable another connector, or grant itself additional execution permission. Content a connector returns SHALL be treated as untrusted external data on the same terms as page content, and SHALL NOT be treated as instructions that authorize an action.

#### Scenario: A connector attempts to widen its own reach
- **WHEN** a connector's advertised tool or returned content attempts to change settings, obtain a credential, change the permission mode, expand browser scope, or enable another connector
- **THEN** none of it takes effect, and the attempt is surfaced to the user

#### Scenario: Connector content is not authorization
- **WHEN** a connector's returned content contains text that reads as an instruction or an approval
- **THEN** it has no effect on any pending decision, and only an explicit user decision through the decision channel can resolve one

#### Scenario: Connector content is probed like page content
- **WHEN** a connector returns content for the agent to act on
- **THEN** it is probed for agent-directed instructions on the same terms as content returned from a page, and a finding warns without blocking

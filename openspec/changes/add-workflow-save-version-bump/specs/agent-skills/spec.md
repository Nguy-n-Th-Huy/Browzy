## ADDED Requirements

### Requirement: A draft save always stores what was reviewed
Saving a reviewed draft SHALL persist it as a new, disabled version under the local-operator identity: version 1 when the workflow id does not exist, and the next version beside the existing ones when it does — never a refusal for the identity alone, and never a replacement that removes an earlier version from reach. The stored version SHALL remain disabled (a derived draft never enables itself) and its provenance SHALL be host-written, naming the version it replaced. Every other validation failure SHALL still refuse with the registry's own error codes.

#### Scenario: Saving a re-derived draft of an existing workflow
- **WHEN** the operator saves a draft whose workflow id is already stored
- **THEN** the definition is stored as the next version, the previous versions remain addressable, and the reply names the new version

#### Scenario: A bumped save never enables anything
- **WHEN** a workflow was enabled and a re-derived draft of it is saved
- **THEN** the new version is stored disabled, and nothing about it is offered as runnable until it is proven and explicitly enabled

#### Scenario: An invalid draft is still refused
- **WHEN** a draft carries an unsupported step kind or any other registry validation failure
- **THEN** the save is refused with the registry's own error code — the identity bump never becomes a bypass

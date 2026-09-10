## MODIFIED Requirements

### Requirement: Confined tool execution and browser scope
The assistant MUST limit computer operations to the authorized browser bridge and session-owned tabs, the current tab bound at user submission, or explicitly selected tabs. Arbitrary shell commands, filesystem access outside session artifacts (except approved enabled skill resources and capability-scoped files explicitly selected by the user for upload), unknown tool names, invalid arguments, and unauthorized browser scopes SHALL be rejected before execution. Page content SHALL be treated as task data, never authorization to change settings, expand scope, or disclose credentials.

This confinement is a property of the run, not of whichever agent happens to be acting inside it. A named agent definition supplied to the run — whether selected as the conversation's primary agent or reached by delegation — SHALL be bounded by the identical confinement: it SHALL NOT make available any tool the run itself does not hold, SHALL NOT reach arbitrary shell execution or direct filesystem write/edit operations, SHALL NOT widen tab scope or the run's upload allowlist, and SHALL NOT cause any call to bypass the per-call authorization and approval checks the same call would face with no agent selected. An agent definition is a narrowing instrument only; a tool name it declares that the run does not hold SHALL be dropped before the definition reaches the model runtime, not honoured on the strength of the declaration.

#### Scenario: Command injection or unauthorized file access
- **WHEN** a model request includes an extra shell command, an unrecognized executable, a path traversal, or a file outside the approved artifact, skill-resource, and user-selected upload allowlists
- **THEN** the request is rejected without running that command or reading that file

#### Scenario: Concurrent conversation
- **WHEN** another conversation attempts to operate the browser while a run owns the browser lease
- **THEN** the second conversation is queued and cannot act until the lease is released and its own tab scope is restored

#### Scenario: A named agent cannot exceed the run's tool allowance
- **WHEN** a named agent definition declares a tool the run itself does not hold, or declares a shell-execution or filesystem-write tool
- **THEN** that tool is unavailable to the agent, the run still starts, and the refusal is reported to the operator rather than silently ignored

#### Scenario: A delegated agent faces the same per-call checks
- **WHEN** a delegated agent issues a browser call that requires tab-scope authorization or an operator approval decision
- **THEN** that call is authorized and approved by the same checks and the same decisions as an identical call made with no agent selected

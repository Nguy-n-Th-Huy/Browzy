## Purpose

Provide responsive, resilient side-panel agent execution with the same practical browser capability set as the shared registry.

## ADDED Requirements
### Requirement: Curated registry parity
The side panel SHALL expose all read, navigation, form, upload, tab, page-tool, and document operations permitted by the active policy.
#### Scenario: Agent fills a form
- **WHEN** the model selects a form operation
- **THEN** the operation is available with a human-readable permission label and enforced scope.
### Requirement: Incremental output and cancellation
The runtime SHALL forward text and tool events incrementally and SHALL cancel an in-flight request and release its browser lease when the user presses Stop.
#### Scenario: User stops a long task
- **WHEN** Stop is pressed during model output or tool execution
- **THEN** no new action is dispatched, the run is marked cancelled, and the lease is released.
### Requirement: Recovery and limits
The runtime SHALL retry transient transport failures with bounded exponential backoff, avoid retrying non-idempotent actions automatically, and report a clear terminal state when limits are reached.
#### Scenario: Gateway returns 429
- **WHEN** a retryable rate limit is received
- **THEN** the panel shows retry progress and either resumes or reports the final failure without duplicating a protected action.

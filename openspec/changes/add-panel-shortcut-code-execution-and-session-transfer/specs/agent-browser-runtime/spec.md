## ADDED Requirements

### Requirement: Sandboxed code execution and recording acknowledgement are reachable from the panel
The operations for sandboxed code execution and recording acknowledgement SHALL be available to the panel's agent through the same registry every other browser operation uses, producing the same result, error and image shapes the external MCP entry points already produce for them. Both SHALL appear in the enumerated set of post-baseline additions, so neither is reported as an unaccounted-for registry entry. Each SHALL carry an explicit classification in the runtime's action classification; neither SHALL rely on an unclassified default.

#### Scenario: Running sandboxed code from the panel
- **WHEN** the panel's agent runs sandboxed code
- **THEN** it executes in the same sandbox the external entry points use, and the result, errors and any image output match those entry points' existing contracts

#### Scenario: Sandbox failure from the panel
- **WHEN** sandboxed code fails, times out, or exceeds its limits during a panel run
- **THEN** the failure is reported with the same error shape the external entry points already produce, and the run continues to be usable

#### Scenario: Acknowledging a recording from the panel
- **WHEN** the panel's agent acknowledges a recording it was handed
- **THEN** the acknowledgement is accepted by the same path that accepts one from an external MCP client, and delivery is recorded once

#### Scenario: Both operations are accounted for in the registry
- **WHEN** the registry is checked against the baseline and the post-baseline additions set
- **THEN** both operations appear in the additions set and neither is reported as an unaccounted-for discrepancy

#### Scenario: Classification is explicit
- **WHEN** the runtime classifies a call to either operation
- **THEN** the classification comes from an explicit entry for that operation rather than from an unclassified fallback

#### Scenario: External MCP behavior is unchanged
- **WHEN** an external MCP client calls either operation as it did before this change
- **THEN** its behavior, results and errors are unchanged

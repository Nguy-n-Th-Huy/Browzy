## ADDED Requirements

### Requirement: Recalled memory is disclosed truthfully in the run timeline
When a run received recalled task memory, the panel SHALL show one disclosure line inside that run's timeline group naming the site and when the memory was last confirmed ("Đã tham khảo cách làm lần trước · <site> · <thời gian>"). The line SHALL be visually a disclosure, not an action row: it SHALL carry no running/succeeded/failed state, SHALL NOT be counted among the run's browser operations, and SHALL NOT list the recalled steps as if they had been performed. It SHALL be rendered from a durable transcript event so it is restored on reconnect without duplication. The final answer SHALL NOT be annotated as coming from memory.

#### Scenario: Run with recalled memory
- **WHEN** a run starts with two candidate memories and performs four browser actions
- **THEN** the timeline group shows the disclosure line once and reports four operations, none of them attributed to memory

#### Scenario: Reconnect
- **WHEN** the panel reconnects during or after such a run
- **THEN** the disclosure line is restored exactly once from the durable event

#### Scenario: No recall
- **WHEN** a run received no candidates
- **THEN** no disclosure line is shown and the timeline is unchanged from a run without this capability

### Requirement: Task memories are listed and forgettable from a management surface
The product SHALL provide a surface listing every stored task memory grouped by site, showing each entry's intent (or that the intent was not stored), its step count, when it was last confirmed, and whether it is fresh or stale. The user SHALL be able to forget one site's memories or every memory from that surface after explicit confirmation. The surface SHALL state that memories are advice about past runs and never grant permissions, and SHALL show an explanatory empty state rather than an empty list.

#### Scenario: Listing memories
- **WHEN** the user opens the surface with memories present for two sites
- **THEN** both sites are listed with each entry's intent, step count, last-confirmed time and state

#### Scenario: Forgetting one site
- **WHEN** the user forgets one site and confirms
- **THEN** that site's entries are removed and the other site's entries are unchanged

#### Scenario: Forgetting everything
- **WHEN** the user forgets all and confirms
- **THEN** the list is empty and the surface states that nothing is remembered

#### Scenario: Empty state
- **WHEN** the user opens the surface with no memories
- **THEN** it states that no way of working has been remembered yet, rather than showing an empty list with no explanation

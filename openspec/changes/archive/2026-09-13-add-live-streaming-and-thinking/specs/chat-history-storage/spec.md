## ADDED Requirements

### Requirement: Live streaming fragments are not durable history
Streaming fragments produced for live display SHALL NOT be written to the durable conversation record. The stored transcript SHALL remain the sequence of committed run events and completed assistant messages, so restoring or replaying a conversation yields exactly what it yields today: no duplicated text, no fragment-only entries, and no dependence on any fragment having been received. The existing coalescing, flush, retention and privacy rules SHALL continue to govern the durable record unchanged.

#### Scenario: A fragment is never persisted
- **WHEN** a run produces streaming fragments for live display
- **THEN** the durable conversation record contains no entry for those fragments, before or after the run completes

#### Scenario: Replay after live streaming
- **WHEN** a conversation whose response was shown live is restored from the stored record
- **THEN** the restored transcript contains each completed message once, with no duplicated text and no fragment-only content

#### Scenario: A fragment lost in transit changes nothing durably
- **WHEN** a streaming fragment never reaches the panel and the completed message arrives normally
- **THEN** the stored record and the restored transcript are identical to the case where every fragment arrived

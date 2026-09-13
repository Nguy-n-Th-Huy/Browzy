## ADDED Requirements

### Requirement: Connector tool activity is identified in the timeline
The action timeline SHALL show a connector tool call identified by the connector it came from, distinguishable from a browser action and from another connector's action. A connector call's failure, timeout, or refusal SHALL be shown with its reason rather than as a generic tool failure. Content a connector returned SHALL be displayed as quoted data, never rendered as instructions or as panel-authored copy.

#### Scenario: A connector call in a mixed run
- **WHEN** a run uses both browser tools and an enabled connector's tools
- **THEN** the timeline identifies which entries came from which connector and which are browser actions

#### Scenario: A connector call fails
- **WHEN** a connector call fails, times out, or is refused because the connector is disabled
- **THEN** the timeline shows that entry with its specific reason, naming the connector

#### Scenario: Connector content is quoted, not rendered
- **WHEN** the timeline displays content a connector returned
- **THEN** it appears as quoted data, and any markup or instruction inside it is neither rendered nor acted on

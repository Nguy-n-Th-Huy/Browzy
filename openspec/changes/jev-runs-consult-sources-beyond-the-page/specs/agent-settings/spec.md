# agent-settings delta

## ADDED Requirements

### Requirement: The TypeSafe provider discloses and controls source consultation

A `typesafe` profile SHALL expose a non-secret setting controlling whether its runs may consult sources beyond the page they drive, persisted with the profile beside the screenshot toggle and enabled by default. A profile stored before the setting existed SHALL load with it enabled.

The settings surface SHALL disclose what the setting permits in terms the operator can act on: that a run may fetch URLs found on the page it is reading or named in the goal, that the fetch is read-only and carries no credential or cookie, and that the servers at those URLs receive the request. The disclosure SHALL NOT describe the capability merely as "browsing the web".

#### Scenario: The toggle is offered and defaults on

- **WHEN** the operator opens a `typesafe` profile in Settings
- **THEN** the consultation setting is shown, enabled by default, and a profile saved before it existed loads with it enabled

#### Scenario: The disclosure names what leaves the machine

- **WHEN** the operator reads the `typesafe` provider's disclosure
- **THEN** it states that runs may fetch URLs found on the page or named in the goal, that no credential or cookie is sent, and that the servers at those URLs see the request

#### Scenario: Off is honoured

- **WHEN** the setting is off and a run would otherwise consult a source
- **THEN** no fetch is attempted, the answer is written from the driven page alone, and no failure is reported

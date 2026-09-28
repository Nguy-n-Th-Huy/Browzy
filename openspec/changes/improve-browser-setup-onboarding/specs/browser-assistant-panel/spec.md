## ADDED Requirements

### Requirement: Pre-setup panel guidance

While the configured profile is not complete and verified and the panel has no transcript to show, the panel SHALL state which setup step is next and SHALL offer the action that resolves it, on the panel itself rather than only on its settings surface. It MUST NOT present the panel as ready to run a request in that condition, and MUST NOT offer example requests whose submission the panel would itself refuse.

Where the panel can determine that the native companion is not registered, or is registered but unusable, it SHALL name registering the companion as the next step and state how to perform it, without requiring the user to hover over a status indicator to read it.

The panel SHALL NOT state the same unmet step twice at once in different places.

Once the profile is complete and verified, the panel's greeting and example requests SHALL be presented as before.

#### Scenario: First open with nothing configured

- **WHEN** the panel is opened with no complete verified provider profile
- **THEN** it states the next setup step and links to the surface that resolves that step, and it offers no example request that cannot be submitted

#### Scenario: Companion not registered

- **WHEN** the panel can determine that the native companion is not registered on this machine
- **THEN** it names registering the companion as the next step and states the command or action that performs it, visibly rather than as a tooltip

#### Scenario: A stored profile does not outrank a companion that cannot run it

- **WHEN** the panel's last known profile describes a complete verified configuration but the companion is not registered
- **THEN** the panel presents that setup step as the next one and does not present the profile as ready

#### Scenario: One ordered list, not competing steps

- **WHEN** the profile is incomplete and the companion is also not registered
- **THEN** the panel presents a single ordered list of steps, with the companion step before the profile steps, and does not present the same condition as two unrelated actions

#### Scenario: A companion whose state is unknown is not claimed to be missing

- **WHEN** the panel has no information about whether the companion is registered
- **THEN** it presents no companion step and does not state that the companion is missing

#### Scenario: A ready panel is unchanged

- **WHEN** the profile is complete and verified and the panel has no transcript
- **THEN** the panel presents its greeting and example requests as it does today

#### Scenario: A regression during a conversation is still reported

- **WHEN** a profile that was ready stops being ready while a conversation is open in the panel
- **THEN** the panel reports the unmet step next to the composer, and does not remove the conversation

#### Scenario: The unmet step is stated once

- **WHEN** the panel is showing setup guidance for an incomplete profile
- **THEN** the unmet step is stated in one place on the panel, not repeated in a second region

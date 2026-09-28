## ADDED Requirements

### Requirement: Setup walkthrough on the settings page

The settings page SHALL present the in-product setup preconditions as a single ordered walkthrough — a credential for the configured provider, at least one model with a default, and a passing connection test — marking which of them is satisfied and which is next. The order SHALL be the order the page itself requires them in, and the user SHALL NOT have to infer it from separate messages on the page. Where the extension can determine that the native companion is not registered, or is registered but unusable, that step SHALL lead the walkthrough and SHALL state how to perform it, without requiring the user to hover over a status indicator to read it.

Configuration SHALL be organized into sections that can each be collapsed by the user. Collapsing SHALL NOT remove any control from the page, and every section's heading SHALL carry a text state label so a collapsed section can be read without opening it. A section SHALL NOT be presented as collapsed while it holds an error the user must act on, whatever the user last chose for it. A section whose setup step is merely unsatisfied MAY be collapsed — the walkthrough identifying that step SHALL remain visible — and a request to open the page at a specific control SHALL reveal the section containing that control before the control is brought into view.

The Jev browser-tools configuration SHALL remain a section separate from the profile's primary provider configuration, and SHALL be presented collapsed for a profile that has not opted into it.

Every disclosure the page is required to make — the cost or usage consequence of a connection test, the ChatGPT unofficial-backend and OpenAI-terms disclosure, where a credential is stored and that it is never displayed again, and that usage and billing depend on the configured provider rather than being free — SHALL remain present on the page after this walkthrough is presented, and SHALL NOT be replaced by it.

#### Scenario: A fresh profile is told what comes next

- **WHEN** the settings page is open for a profile with no credential and no models
- **THEN** it names the provider configuration as the next step, lists the model and connection-test steps after it in that order, and does not present the connection test as available

#### Scenario: The walkthrough tracks the profile

- **WHEN** the profile gains a credential but still has no default model, and later has a default model but no passing connection test
- **THEN** the next unsatisfied step moves from the provider to the model list and then to the connection test, and each step already satisfied is shown as satisfied

#### Scenario: An error is never hidden

- **WHEN** a section that the user collapsed holds an error the user must act on
- **THEN** that section is presented open

#### Scenario: A section whose step is merely unsatisfied is still the user's to collapse

- **WHEN** the user collapses a section whose setup step is not satisfied and which holds no error
- **THEN** the section stays collapsed and the walkthrough continues to name that step as the next one

#### Scenario: Reaching a control by deep link

- **WHEN** the settings page is opened at a control that sits inside a collapsed section, or the user follows an in-page link to one
- **THEN** the section containing that control is open and the control is visible and operable

#### Scenario: A complete profile carries no walkthrough

- **WHEN** the profile is complete and its connection test has passed
- **THEN** no unsatisfied-step walkthrough is shown

#### Scenario: A profile that cannot be read

- **WHEN** the settings page cannot reach the companion to read the profile
- **THEN** it states the failure and does not present a list of setup steps, because none of them can be carried out until the profile can be read

#### Scenario: Nothing is claimed before the profile arrives

- **WHEN** the settings page has been opened but the profile has not been read yet
- **THEN** no setup step is presented as unsatisfied and no section is presented as holding an unmet step

#### Scenario: An action in progress is not reported as outstanding

- **WHEN** a setup step's own action is running — saving a credential, signing in, discovering models, running the connection test
- **THEN** that step is shown as in progress, not as satisfied and not as still to do

#### Scenario: A companion known to be unregistered leads

- **WHEN** the extension can determine that the native companion is not registered on this machine
- **THEN** the walkthrough names registering the companion as the first step, states the command or action that performs it, and shows the remaining steps as unsatisfied

#### Scenario: Optional advanced configuration does not block the required steps

- **WHEN** the user views the settings page for a profile that has not opted into the Jev browser tools
- **THEN** the Jev browser-tools configuration is presented collapsed and separate from the primary provider configuration, and the control that saves and tests the primary provider is reachable without passing through it

#### Scenario: Saved is distinguished from tested

- **WHEN** a credential has been saved but no connection test has passed
- **THEN** the walkthrough shows the credential step satisfied and the connection-test step unsatisfied, and does not present the profile as ready

## MODIFIED Requirements

### Requirement: Editable provider profile

A provider profile SHALL have a provider type, `anthropic`, `chatgpt`, or `typesafe`. A profile persisted before provider types existed SHALL load as `anthropic` without any change to its other fields.

For an `anthropic` profile, settings SHALL expose Base URL, masked API key with replace/remove actions, editable model ID and display-name pairs, and exactly one default model. The initial Base URL SHALL be https://api.anthropic.com.

For a `chatgpt` profile, settings SHALL NOT expose Base URL or API key. Instead they SHALL expose:
- "Sign in with ChatGPT" and "Use a code instead" actions.
- The signed-in account email and plan.
- The signed-in account's current usage and limits, read on demand with an explicit refresh action (see "ChatGPT usage display").
- A "Sign out" action.
- The same editable model list with exactly one default model, seeded on first sign-in with the Codex model ids known for the account's plan.
- A disclosure that requests use the user's ChatGPT subscription through an unofficial backend that may change or stop working, and that OpenAI's terms apply.

For a `typesafe` profile, settings SHALL NOT expose Base URL or API key for an Anthropic endpoint. Instead they SHALL expose:
- A write-only TypeSafe API key field with replace/remove actions.
- Write-only text-model fields: base URL, model ID, and API key with replace/remove actions.
- The same editable model list with exactly one default model, seeded with the provider's documented `jev-latest` entry only when the list is empty at the moment the provider type is selected.
- A disclosure that runs through this provider make structured element-selection requests to TypeSafe and, against the configured text-model endpoint, requests for the run's plan, each step decision, context revisions, the completion check, stall-recovery consultations, and generated text values, and that usage and billing follow those services' terms.

Saving SHALL validate and atomically persist the profile without requiring a network call.

#### Scenario: Valid custom endpoint
- **WHEN** the user saves an HTTPS Anthropic-compatible endpoint, credential, and nonempty unique model IDs on an `anthropic` profile
- **THEN** the profile is saved and subsequent conversations use those values without modifying source code or global environment settings

#### Scenario: Invalid or partial profile
- **WHEN** the URL contains credentials, query parameters, a fragment, an unsupported scheme, or the models contain duplicates or no valid default
- **THEN** field-level errors prevent saving and the last saved profile remains intact

#### Scenario: Existing profile after upgrade
- **WHEN** a profile saved by an earlier version is loaded
- **THEN** its provider type is `anthropic` and its Base URL, models, credential and capability results are unchanged

#### Scenario: Switching to ChatGPT
- **WHEN** the user selects the ChatGPT provider type
- **THEN** Base URL and API key fields are hidden and the sign-in actions and disclosure are shown

#### Scenario: Signed-in ChatGPT profile
- **WHEN** a `chatgpt` profile in the signed-in state is open in Settings
- **THEN** the account email and plan are shown together with the usage block and its refresh action, and no Base URL or API key field is present

#### Scenario: Switching to TypeSafe
- **WHEN** the user selects the `typesafe` provider type with an empty model list
- **THEN** the Anthropic Base URL and API-key fields are hidden, the TypeSafe credential and text-model fields are shown write-only, and the model list is seeded once with `jev-latest` as the default

#### Scenario: TypeSafe text-model fields are required
- **WHEN** the TypeSafe provider is selected but the text-model base URL or model ID is empty
- **THEN** saving and testing are blocked with a field-level error and no capability test request is sent

#### Scenario: TypeSafe disclosure names what the model is asked for
- **WHEN** the `typesafe` provider type is selected
- **THEN** the disclosure states that runs make structured element-selection requests to TypeSafe and, to the configured text-model endpoint, requests for the run's plan, each step decision, context revisions, the completion check, stall-recovery consultations, and generated text values, and that usage and billing follow those services' terms

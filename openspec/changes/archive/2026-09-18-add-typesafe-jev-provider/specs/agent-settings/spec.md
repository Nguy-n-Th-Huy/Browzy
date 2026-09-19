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
- A disclosure that runs through this provider make structured decision requests to TypeSafe and small text-generation requests to the configured text-model endpoint, and that usage and billing follow those services' terms.

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

### Requirement: Explicit compatibility and connection testing

Connection testing SHALL use the configured endpoint and selected model to verify Anthropic Messages streaming and a structured tool round trip, and SHALL report image-input support separately. For a `chatgpt` profile, the same test SHALL run through the companion's ChatGPT gateway with a test-scoped gateway token. For a `typesafe` profile, the test SHALL issue one trivial structured-choice request to the configured TypeSafe endpoint and one minimal completion to the configured text model, reporting their outcomes separately under the same result shape used for other providers. The UI SHALL disclose that this test sends a small request and can incur API usage, or for a `chatgpt` profile that it counts against the ChatGPT usage limit, or for a `typesafe` profile that it calls both the TypeSafe and text-model endpoints. OpenAI Chat Completions-only endpoints configured as `anthropic` profiles SHALL not be reported as compatible.

#### Scenario: Authentication or provider error
- **WHEN** a check receives 401/403, an unavailable model, rate limiting, timeout, TLS/network failure, or incompatible protocol
- **THEN** it shows the corresponding actionable error without revealing the API key or any ChatGPT token, and does not mark the profile verified

#### Scenario: Text-only endpoint
- **WHEN** a provider supports text but fails the tool or image test
- **THEN** settings identify the failed capability and block full browser-assistant use until a compatible model is selected

#### Scenario: ChatGPT profile not signed in
- **WHEN** the user runs the test on a `chatgpt` profile with no stored credential or in the `SESSION_EXPIRED` state
- **THEN** no request is sent and settings ask the user to sign in with ChatGPT

#### Scenario: TypeSafe stages report distinctly
- **WHEN** the TypeSafe question stage succeeds but the text-model stage fails, or the TypeSafe endpoint returns an invalid structured body
- **THEN** settings identify the failed stage by name (`INVALID_RESPONSE` for a structurally invalid answer; the applicable connectivity code for a failed call) and the profile is not marked verified

### Requirement: Manual model catalog with optional discovery

Users SHALL be able to add, edit, remove, reorder, and select models by exact provider model ID. Optional model refresh SHALL use the configured provider's model listing endpoint, handle pagination, and preserve manual entries. For a `chatgpt` profile, discovery SHALL report unsupported and the manual list SHALL remain editable. For a `typesafe` profile, discovery SHALL likewise report unsupported and the manual list SHALL remain editable. No model ID SHALL be invented from screenshot labels.

#### Scenario: Provider has no model listing
- **WHEN** optional discovery is unsupported or fails
- **THEN** manually configured models remain usable and the UI offers manual entry without erasing the list

#### Scenario: Model or endpoint changes during a run
- **WHEN** settings change while a run is active
- **THEN** the run keeps its original profile snapshot; changing endpoint, provider type or model for an existing conversation requires a new conversation so old context is not silently sent to a different provider

### Requirement: No Claude product account required

The extension SHALL be usable without Claude login, a Claude subscription, a preexisting Claude Code login, or the proprietary Claude in Chrome extension. It SHALL be usable with a valid Anthropic-compatible Base URL, API key and model; with a ChatGPT account the user explicitly signs in with; or with a TypeSafe API key plus a text-model configuration. First-run onboarding SHALL request provider configuration, offering the supported provider types, rather than Claude account creation or sign-in. It SHALL explain that usage and billing depend on the configured provider or the ChatGPT plan, without promising free inference or universal gateway compatibility.

#### Scenario: Fresh machine with provider credentials only
- **WHEN** a user with no Claude product account, login state, subscription or official extension completes one-time installation and enters supported provider credentials, signs in with ChatGPT, or enters TypeSafe and text-model credentials
- **THEN** the assistant can chat, read the current page, control authorized browser actions and invoke enabled skills without opening a Claude login flow

#### Scenario: Invalid provider credentials
- **WHEN** provider authentication fails, a ChatGPT session expires, or the TypeSafe or text-model credential is rejected
- **THEN** the application offers correcting the affected credential or endpoint, or signing in to ChatGPT again. It never silently switches to Claude account login, a different provider type, or another account's session

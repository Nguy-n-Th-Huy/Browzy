## Purpose

Allow users to configure Anthropic-compatible endpoints, credentials, and model choices from the extension while protecting secrets and exposing actionable connection errors.

## ADDED Requirements

### Requirement: Editable provider profile
Settings SHALL expose Base URL, masked API key with replace/remove actions, editable model ID and display-name pairs, and exactly one default model. The initial Base URL SHALL be https://api.anthropic.com. Saving SHALL validate and atomically persist the profile without requiring a network call.

#### Scenario: Valid custom endpoint
- **WHEN** the user saves an HTTPS Anthropic-compatible endpoint, credential, and nonempty unique model IDs
- **THEN** the profile is saved and subsequent conversations use those values without modifying source code or global environment settings

#### Scenario: Invalid or partial profile
- **WHEN** the URL contains credentials, query parameters, a fragment, an unsupported scheme, or the models contain duplicates or no valid default
- **THEN** field-level errors prevent saving and the last saved profile remains intact

### Requirement: Explicit compatibility and connection testing
Connection testing SHALL use the configured endpoint and selected model to verify Anthropic Messages streaming and a structured tool round trip, and SHALL report image-input support separately. The UI SHALL disclose that this test sends a small request and can incur API usage. OpenAI Chat Completions-only endpoints SHALL not be reported as compatible.

#### Scenario: Authentication or provider error
- **WHEN** a check receives 401/403, an unavailable model, rate limiting, timeout, TLS/network failure, or incompatible protocol
- **THEN** it shows the corresponding actionable error without revealing the API key or marking the profile verified

#### Scenario: Text-only endpoint
- **WHEN** a provider supports text but fails the tool or image test
- **THEN** settings identify the failed capability and block full browser-assistant use until a compatible model is selected

### Requirement: Manual model catalog with optional discovery
Users SHALL be able to add, edit, remove, reorder, and select models by exact provider model ID. Optional model refresh SHALL use the configured provider's model listing endpoint, handle pagination, and preserve manual entries. No model ID SHALL be invented from screenshot labels.

#### Scenario: Provider has no model listing
- **WHEN** optional discovery is unsupported or fails
- **THEN** manually configured models remain usable and the UI offers manual entry without erasing the list

#### Scenario: Model or endpoint changes during a run
- **WHEN** settings change while a run is active
- **THEN** the run keeps its original profile snapshot; changing endpoint or model for an existing conversation requires a new conversation so old context is not silently sent to a different provider

### Requirement: Secret isolation
Credentials SHALL be stored by the native companion using the OS credential store, never in extension sync/local storage, browser content scripts, repository files, command-line arguments, exported settings, or logs. The settings UI SHALL clear raw credentials after submission and show only whether a key is saved. If secure storage is unavailable, persistence SHALL fail explicitly and a clearly labeled memory-only mode SHALL be offered.

#### Scenario: Export and diagnostics
- **WHEN** the user exports settings or views diagnostics
- **THEN** the output contains no credential and imported settings require a separate credential entry

#### Scenario: Credential removal
- **WHEN** the user removes the saved credential
- **THEN** the companion cancels active runs using it, removes the secret, clears in-memory copies as far as practical, and requires a new credential before another request

### Requirement: No Claude product account required
The extension SHALL be usable with a valid supported provider Base URL, API key and model without Claude login, a Claude subscription, a preexisting Claude Code login, or the proprietary Claude in Chrome extension. First-run onboarding SHALL request provider configuration rather than Claude account creation or sign-in. It SHALL explain that API usage and billing depend on the configured provider, without promising free inference or universal gateway compatibility.

#### Scenario: Fresh machine with provider credentials only
- **WHEN** a user with no Claude product account, login state, subscription or official extension completes one-time installation and enters supported provider credentials
- **THEN** the assistant can chat, read the current page, control authorized browser actions and invoke enabled skills without opening a Claude login flow

#### Scenario: Invalid provider credentials
- **WHEN** provider authentication fails
- **THEN** the application offers correcting the endpoint or API key, never silently switches to Claude account login or another account's session

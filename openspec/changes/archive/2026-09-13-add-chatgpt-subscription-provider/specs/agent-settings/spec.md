## MODIFIED Requirements

### Requirement: Editable provider profile
A provider profile SHALL have a provider type, `anthropic` or `chatgpt`. A profile persisted before provider types existed SHALL load as `anthropic` without any change to its other fields.

For an `anthropic` profile, settings SHALL expose Base URL, masked API key with replace/remove actions, editable model ID and display-name pairs, and exactly one default model. The initial Base URL SHALL be https://api.anthropic.com.

For a `chatgpt` profile, settings SHALL NOT expose Base URL or API key. Instead they SHALL expose:
- "Sign in with ChatGPT" and "Use a code instead" actions.
- The signed-in account email and plan.
- A "Sign out" action.
- The same editable model list with exactly one default model, seeded on first sign-in with the Codex model ids known for the account's plan.
- A disclosure that requests use the user's ChatGPT subscription through an unofficial backend that may change or stop working, and that OpenAI's terms apply.

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

### Requirement: Explicit compatibility and connection testing
Connection testing SHALL use the configured endpoint and selected model to verify Anthropic Messages streaming and a structured tool round trip, and SHALL report image-input support separately. For a `chatgpt` profile, the same test SHALL run through the companion's ChatGPT gateway with a test-scoped gateway token. The UI SHALL disclose that this test sends a small request and can incur API usage, or for a `chatgpt` profile that it counts against the ChatGPT usage limit. OpenAI Chat Completions-only endpoints configured as `anthropic` profiles SHALL not be reported as compatible.

#### Scenario: Authentication or provider error
- **WHEN** a check receives 401/403, an unavailable model, rate limiting, timeout, TLS/network failure, or incompatible protocol
- **THEN** it shows the corresponding actionable error without revealing the API key or any ChatGPT token, and does not mark the profile verified

#### Scenario: Text-only endpoint
- **WHEN** a provider supports text but fails the tool or image test
- **THEN** settings identify the failed capability and block full browser-assistant use until a compatible model is selected

#### Scenario: ChatGPT profile not signed in
- **WHEN** the user runs the test on a `chatgpt` profile with no stored credential or in the `SESSION_EXPIRED` state
- **THEN** no request is sent and settings ask the user to sign in with ChatGPT

### Requirement: Manual model catalog with optional discovery
Users SHALL be able to add, edit, remove, reorder, and select models by exact provider model ID. Optional model refresh SHALL use the configured provider's model listing endpoint, handle pagination, and preserve manual entries. For a `chatgpt` profile, discovery SHALL report unsupported and the manual list SHALL remain editable. No model ID SHALL be invented from screenshot labels.

#### Scenario: Provider has no model listing
- **WHEN** optional discovery is unsupported or fails
- **THEN** manually configured models remain usable and the UI offers manual entry without erasing the list

#### Scenario: Model or endpoint changes during a run
- **WHEN** settings change while a run is active
- **THEN** the run keeps its original profile snapshot; changing endpoint, provider type or model for an existing conversation requires a new conversation so old context is not silently sent to a different provider

### Requirement: Secret isolation
Credentials SHALL be stored by the native companion using the OS credential store. This covers API keys and ChatGPT refresh tokens. They SHALL never be stored in extension sync/local storage, browser content scripts, repository files, command-line arguments, exported settings, or logs. ChatGPT access and ID tokens SHALL exist only in companion memory and SHALL never reach the extension, the SDK environment, or logs. The settings UI SHALL clear raw credentials after submission and show only whether a key is saved or which ChatGPT account is signed in. If secure storage is unavailable, persistence SHALL fail explicitly and a clearly labeled memory-only mode SHALL be offered.

#### Scenario: Export and diagnostics
- **WHEN** the user exports settings or views diagnostics
- **THEN** the output contains no credential or ChatGPT token, and imported settings require a separate credential entry or ChatGPT sign-in

#### Scenario: Credential removal
- **WHEN** the user removes the saved credential or signs out of ChatGPT
- **THEN** the companion cancels active runs using it, revokes its gateway tokens, removes the secret, clears in-memory copies as far as practical, and requires a new credential or sign-in before another request

### Requirement: No Claude product account required
The extension SHALL be usable without Claude login, a Claude subscription, a preexisting Claude Code login, or the proprietary Claude in Chrome extension. It SHALL be usable either with a valid Anthropic-compatible Base URL, API key and model, or with a ChatGPT account the user explicitly signs in with. First-run onboarding SHALL request provider configuration, offering both provider types, rather than Claude account creation or sign-in. It SHALL explain that usage and billing depend on the configured provider or the ChatGPT plan, without promising free inference or universal gateway compatibility.

#### Scenario: Fresh machine with provider credentials only
- **WHEN** a user with no Claude product account, login state, subscription or official extension completes one-time installation and enters supported provider credentials or signs in with ChatGPT
- **THEN** the assistant can chat, read the current page, control authorized browser actions and invoke enabled skills without opening a Claude login flow

#### Scenario: Invalid provider credentials
- **WHEN** provider authentication fails or a ChatGPT session expires
- **THEN** the application offers correcting the endpoint or API key, or signing in to ChatGPT again. It never silently switches to Claude account login, a different provider type, or another account's session

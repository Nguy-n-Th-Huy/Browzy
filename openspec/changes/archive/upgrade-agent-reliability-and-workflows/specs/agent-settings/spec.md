## MODIFIED Requirements

### Requirement: Editable provider profile
Settings SHALL expose Base URL, masked API key with replace/remove actions, editable named profile identity, editable model ID and display-name pairs, and exactly one selected model per profile. The initial Base URL SHALL be `https://api.anthropic.com`. Saving SHALL validate and atomically persist the profile without requiring a network call. Profile endpoint/model/skill identity is conversation-bound for SDK continuation; changing endpoint or selected model for an existing conversation SHALL require a new conversation, while each new turn SHALL capture fresh browser/document context.

#### Scenario: Valid custom endpoint
- **WHEN** the user saves an HTTPS Anthropic-compatible endpoint, credential, and nonempty unique model IDs
- **THEN** the profile is saved and subsequent conversations use those values without modifying source code or global environment settings

#### Scenario: Invalid or partial profile
- **WHEN** the URL contains credentials, query parameters, a fragment, an unsupported scheme, or the models contain duplicates or no valid default
- **THEN** field-level errors prevent saving and the last saved profile remains intact

#### Scenario: Endpoint or model changes in an existing conversation
- **WHEN** the user selects or edits an endpoint or model that differs from the conversation-bound identity
- **THEN** the UI rejects resume on that selection and directs the user to start a new conversation; it does not silently switch the SDK session's provider context

### Requirement: Explicit compatibility and connection testing
Connection testing SHALL use the configured endpoint and selected model to verify Anthropic Messages streaming and a structured tool round trip, and SHALL report image-input support separately. The UI SHALL disclose that this test sends a small request and can incur API usage. OpenAI Chat Completions-only endpoints SHALL not be reported as compatible. Capability results SHALL be keyed by profile, endpoint, model, credential revision, and relevant SDK version.

#### Scenario: Authentication or provider error
- **WHEN** a check receives 401/403, an unavailable model, rate limiting, timeout, TLS/network failure, or incompatible protocol
- **THEN** it shows the corresponding actionable error without revealing the API key or marking the profile verified

#### Scenario: Text-only endpoint
- **WHEN** a provider supports text but fails the tool or image test
- **THEN** settings identify the failed capability and block full browser-assistant use until a compatible model is selected

### Requirement: Manual model catalog with optional discovery
Users SHALL be able to add, edit, remove, reorder, and select models by exact provider model ID within each named profile. Optional model refresh SHALL use the configured provider's model listing endpoint, handle pagination, and preserve manual entries. No model ID SHALL be invented from screenshot labels.

#### Scenario: Provider has no model listing
- **WHEN** optional discovery is unsupported or fails
- **THEN** manually configured models remain usable and the UI offers manual entry without erasing the list

#### Scenario: Model or endpoint changes during a run
- **WHEN** settings change while a run is active
- **THEN** the run keeps its original profile endpoint/model snapshot; changing endpoint or model for an existing conversation requires a new conversation so old SDK context is not silently sent to a different provider

### Requirement: Secret isolation
Credentials SHALL be stored by the native companion using the OS credential store, never in extension sync/local storage, browser content scripts, repository files, command-line arguments, exported settings, workflow records, session snapshots, or logs. The settings UI SHALL clear raw credentials after submission and show only whether a key is saved. If secure storage is unavailable, persistence SHALL fail explicitly and a clearly labeled memory-only mode SHALL be offered. Profile records SHALL persist secret-free credential identity/revision separately from runtime secret material. Ordinary nonsecret profile edits SHALL not cancel an active run; credential replacement, removal, or revocation SHALL invalidate capability results and cancel affected active runs, with cancellation taking precedence over continuation. An old credential SHALL not be reconstructed when unavailable.

#### Scenario: Export and diagnostics
- **WHEN** the user exports settings or views diagnostics
- **THEN** the output contains no credential and imported settings require a separate credential entry

#### Scenario: Credential removal
- **WHEN** the user removes the saved credential
- **THEN** the companion cancels active runs using it, removes the secret, clears in-memory copies as far as practical, invalidates capability results, and requires a new credential before another request

#### Scenario: Secure storage unavailable
- **WHEN** the OS credential store cannot persist a credential
- **THEN** settings reports the failure and offers a clearly labeled memory-only mode without writing the raw key to application persistence

## ADDED Requirements

### Requirement: Named profile selection and lifecycle
Settings SHALL support CRUD and selection for named Anthropic-compatible profiles. A run SHALL snapshot the selected profile's endpoint/model identity, capability result, credential revision, and app policy without embedding the secret in conversation metadata. Profile deletion or credential revocation SHALL cancel affected active work; ordinary nonsecret display/model-list edits affect only future runs, while an endpoint/model identity change for an existing conversation requires a new conversation before resume.

#### Scenario: Profile deletion
- **WHEN** the selected profile is deleted
- **THEN** active runs using its credential are cancelled, future sends require another verified profile, and no historical secret is invented to resume an old conversation

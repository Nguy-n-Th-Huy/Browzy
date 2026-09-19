# agent-settings delta

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

For a `typesafe` profile, settings SHALL NOT expose Base URL or API key for the profile's own Anthropic endpoint. Instead they SHALL expose:
- An editable endpoint field for the provider's own requests: prefilled with the profile's current endpoint, labeled with the selected Jev source, its hint naming that source's documented default and its decision route; a custom endpoint is kept when the source changes and can always be edited here.
- A Jev source choice — TypeSafe API, the Vercel AI Gateway, or OpenRouter — with a write-only API key field for the selected source (the Vercel key starts `vck_`) and replace/remove actions naming it. A source published as alpha SHALL be labeled as such where it is selected.
- A decision-model source choice — an Anthropic endpoint and key, the ChatGPT subscription, or an OpenAI-compatible text model — showing only the selected source's own fields: for `anthropic`, a base URL and a write-only key with replace/remove actions; for `chatgpt`, the same sign-in, account, usage, and sign-out controls a `chatgpt` profile exposes, and the same disclosure about the unofficial backend; for `openai`, the write-only text-model base URL, model ID, and API key with replace/remove actions. Only the selected source's configuration SHALL be required before a run or a capability test, a deselected source's stored configuration SHALL be kept rather than cleared, and a profile stored before this choice existed SHALL load as `openai` with its text-model fields and behaviour unchanged.
- The same editable model list with exactly one default model, seeded with the provider's documented `jev-latest` entry only when the list is empty at the moment the provider type is selected.
- A screenshot toggle, enabled by default, controlling whether the decision model receives a page capture with its step decisions and completion check; a profile stored before the toggle existed SHALL load with it enabled.
- A disclosure that runs through this provider make structured element-selection requests to TypeSafe and, against the selected decision-model source, requests for the run's plan, each step decision (including the page capture when screenshots are enabled), context revisions, the completion check, stall-recovery consultations, and generated text values; the disclosure SHALL name that source — the operator's Anthropic endpoint, their ChatGPT subscription through the local companion gateway, or the configured text-model endpoint — and state that usage and billing follow that service's terms.

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
- **THEN** the Anthropic Base URL and API-key fields for the profile's own endpoint are hidden; the endpoint field (carrying the profile's current endpoint), the TypeSafe credential, the decision-model source choice with the selected source's fields, and the screenshot toggle (enabled by default) are shown, and the model list is seeded once with `jev-latest` as the default

#### Scenario: TypeSafe text-model fields are required

- **WHEN** the OpenAI-compatible text model is the selected decision-model source and its base URL or model ID is empty
- **THEN** saving and testing are blocked with a field-level error and no capability test request is sent

#### Scenario: Only the selected decision-model source is required
- **WHEN** the TypeSafe provider is selected and the operator chooses a decision-model source
- **THEN** only that source's own configuration is required and shown, an incomplete configuration for it blocks runs and the capability test with a field-level error, and the other sources' stored values are retained for a later switch

#### Scenario: The ChatGPT subscription drives the decision model
- **WHEN** the operator selects the ChatGPT decision-model source on a `typesafe` profile and signs in
- **THEN** no OpenAI-compatible text-model configuration and no additional API key are required, the account, usage, and sign-out controls appear as they do on a `chatgpt` profile, and decision-class requests go through the companion's existing gateway

#### Scenario: An existing TypeSafe profile keeps its text model
- **WHEN** a `typesafe` profile stored before the decision-model source choice existed is loaded
- **THEN** it loads with the `openai` source selected, its text-model base URL, model ID, and stored key unchanged, and its runs behave as they did

#### Scenario: TypeSafe endpoint is editable
- **WHEN** the operator edits the endpoint field on a `typesafe` profile (for example pointing it at a self-hosted gateway) and saves
- **THEN** the profile persists it and every subsequent provider request and capability test uses exactly that endpoint

#### Scenario: TypeSafe disclosure names what the model is asked for
- **WHEN** the `typesafe` provider type is selected
- **THEN** the disclosure states that runs make structured element-selection requests to TypeSafe and, to the selected decision-model source — named as the operator's Anthropic endpoint, their ChatGPT subscription through the local gateway, or the configured text-model endpoint — requests for the run's plan, each step decision including the page capture when screenshots are enabled, context revisions, the completion check, stall-recovery consultations, and generated text values, and that usage and billing follow that service's terms

### Requirement: Explicit compatibility and connection testing

Connection testing SHALL use the configured endpoint and selected model to verify Anthropic Messages streaming and a structured tool round trip, and SHALL report image-input support separately. For a `chatgpt` profile, the same test SHALL run through the companion's ChatGPT gateway with a test-scoped gateway token. For a `typesafe` profile, the test SHALL issue one trivial structured-choice request to the configured TypeSafe endpoint, one minimal decision-class request to the profile's selected decision-model source, and one minimal decision-class request carrying a small embedded image to that same source — each over the transport that source implies, a `chatgpt` source through the companion gateway with a test-scoped gateway token — reporting their outcomes separately under the same result shape used for other providers; the image stage's outcome SHALL NOT decide the profile's runnability, so a model that rejects images remains runnable with screenshots disabled. The UI SHALL disclose that this test sends a small request and can incur API usage, or that it counts against the ChatGPT usage limit where a ChatGPT account serves the request, or for a `typesafe` profile that it calls both the TypeSafe endpoint and the selected decision-model source. OpenAI Chat Completions-only endpoints configured as `anthropic` profiles SHALL not be reported as compatible.

#### Scenario: TypeSafe stages report distinctly

- **WHEN** the TypeSafe question stage succeeds but the decision-model or image stage fails, or the TypeSafe endpoint returns an invalid structured body
- **THEN** each stage's outcome is reported separately with its own actionable code, and the profile is marked verified only when the stages that decide runnability passed

#### Scenario: TypeSafe image stage reports separately

- **WHEN** the decision-model request succeeds but the image request is rejected or fails
- **THEN** the image capability is reported failed on its own, the profile stays runnable, and the UI can advise disabling screenshots or choosing a vision-capable model

#### Scenario: Authentication or provider error

- **WHEN** a check receives 401/403, an unavailable model, rate limiting, timeout, TLS/network failure, or incompatible protocol
- **THEN** it shows the corresponding actionable error without revealing the API key or any ChatGPT token, and does not mark the profile verified

#### Scenario: Text-only endpoint

- **WHEN** a provider supports text but fails the tool or image test
- **THEN** settings identify the failed capability and block full browser-assistant use until a compatible model is selected

#### Scenario: ChatGPT profile not signed in

- **WHEN** the user runs the test on a `chatgpt` profile — or on a `typesafe` profile whose decision-model source is the ChatGPT subscription — with no stored credential or in the `SESSION_EXPIRED` state
- **THEN** no request is sent and settings ask the user to sign in with ChatGPT

#### Scenario: The test follows the decision-model source

- **WHEN** a `typesafe` profile's decision-model source is `anthropic` or `chatgpt`
- **THEN** the decision-model and image stages run over that source's transport, the ChatGPT case uses a test-scoped gateway token and discloses that it counts against the subscription's usage, and no text-model endpoint is contacted

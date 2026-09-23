# agent-settings Specification

## Purpose
Allow users to configure Anthropic-compatible endpoints, credentials, and model choices from the extension while protecting secrets and exposing actionable connection errors.

## Requirements

### Requirement: Editable provider profile

A provider profile SHALL have a provider type, `anthropic` or `chatgpt`. A profile persisted before provider types existed SHALL load as `anthropic` without any change to its other fields. A profile persisted with the removed provider type `typesafe` SHALL load as `anthropic` under the migration rule below. Any other provider-type value SHALL be rejected when persisted.

For an `anthropic` profile, settings SHALL expose Base URL, masked API key with replace/remove actions, editable model ID and display-name pairs, and exactly one default model. The initial Base URL SHALL be https://api.anthropic.com.

For a `chatgpt` profile, settings SHALL NOT expose Base URL or API key. Instead they SHALL expose:
- "Sign in with ChatGPT" and "Use a code instead" actions.
- The signed-in account email and plan.
- The signed-in account's current usage and limits, read on demand with an explicit refresh action (see "ChatGPT usage display").
- A "Sign out" action.
- The same editable model list with exactly one default model, seeded on first sign-in with the Codex model ids known for the account's plan.
- A disclosure that requests use the user's ChatGPT subscription through an unofficial backend that may change or stop working, and that OpenAI's terms apply.

Settings SHALL NOT offer a standalone Jev/TypeSafe provider type, and SHALL NOT expose a standalone Jev configuration block (Jev endpoint, TypeSafe key, text-model fields, decision-source fields, standalone screenshot or consult-sources toggles, beta notice, or standalone Jev disclosures). The Jev engine is reached only through the Jev browser tools on `anthropic` and `chatgpt` profiles (see "Jev browser-tools configuration on LLM profiles").

Migration of a stored `typesafe` profile SHALL apply the following, and SHALL be written back once so later loads read an `anthropic` profile:
- The provider type becomes `anthropic`.
- The stored TypeSafe endpoint Base URL is replaced with the default Anthropic Base URL.
- A model list equal to the Jev seed (`jev-latest`) is cleared together with its default; any other model entries are kept.
- The last capability-test result is cleared.
- The profile's Jev secret record is kept, so a saved Jev transport key continues to enable the Jev browser tools; the legacy text-model key and text-model fields may remain stored but are never read.
- Named profiles never carry a provider type themselves; the only path a `typesafe` record reaches a named profile is the one-time import of the legacy single-profile file (`migrateLegacyProfile`), which applies this same transform to the value copied into the new named-profile record. That import never rewrites the legacy file.

Saving SHALL validate and atomically persist the profile without requiring a network call.

#### Scenario: Valid custom endpoint
- **WHEN** the user saves an HTTPS Anthropic-compatible endpoint, credential, and nonempty unique model IDs on an `anthropic` profile
- **THEN** the profile is saved and subsequent conversations use those values without modifying source code or global environment settings

#### Scenario: Invalid or partial profile
- **WHEN** the URL contains credentials, query parameters, a fragment, an unsupported scheme, or the models contain duplicates or no valid default
- **THEN** field-level errors prevent saving and the last saved profile remains intact

#### Scenario: Existing profile after upgrade
- **WHEN** a profile saved by an earlier version without a provider type is loaded
- **THEN** its provider type is `anthropic` and its Base URL, models, credential and capability results are unchanged

#### Scenario: Switching to ChatGPT
- **WHEN** the user selects the ChatGPT provider type
- **THEN** Base URL and API key fields are hidden and the sign-in actions and disclosure are shown

#### Scenario: Signed-in ChatGPT profile
- **WHEN** a `chatgpt` profile in the signed-in state is open in Settings
- **THEN** the account email and plan are shown together with the usage block and its refresh action, and no Base URL or API key field is present

#### Scenario: Switching to TypeSafe
- **WHEN** the user opens the provider picker in Settings
- **THEN** only the `anthropic` and `chatgpt` provider types are offered, with no Jev/TypeSafe option, and a request to persist the provider type `typesafe` is rejected without writing the profile

#### Scenario: TypeSafe text-model fields are required
- **WHEN** the user views Settings for any profile
- **THEN** no standalone TypeSafe text-model or decision-source field is shown, and saving or testing never requires or validates such a field

#### Scenario: TypeSafe endpoint is editable
- **WHEN** the user views Settings for any profile
- **THEN** no standalone TypeSafe endpoint field is shown; the only editable endpoint in the primary configuration is the `anthropic` Base URL, and the Jev transport endpoint hint lives in the Jev browser-tools section

#### Scenario: TypeSafe disclosure names what the model is asked for
- **WHEN** the user views Settings or first-run onboarding
- **THEN** no standalone Jev/TypeSafe provider disclosure or beta notice is shown; Jev usage is described only in the Jev browser-tools section of an `anthropic`/`chatgpt` profile

#### Scenario: Stored typesafe profile migrates to anthropic
- **WHEN** a profile stored with provider type `typesafe`, the TypeSafe endpoint, a model list equal to the `jev-latest` seed, a capability-test result, and a saved Jev transport key is loaded
- **THEN** it loads as an `anthropic` profile with the default Anthropic Base URL, an empty model list with no default, no capability-test result, and its Jev transport key still saved so the Jev browser tools remain enabled; the migrated profile is persisted once, and a later load reads it without migrating again

#### Scenario: Migration keeps non-seed models
- **WHEN** a stored `typesafe` profile's model list contains entries other than the `jev-latest` seed
- **THEN** those entries and their default are kept after migration to `anthropic`

#### Scenario: Named profiles migrate the same way
- **WHEN** the legacy stored single profile has provider type `typesafe` and is imported into the named-profile collection for the first time
- **THEN** the resulting named-profile record carries the same migrated values as the active-profile migration (`anthropic` provider type, default Anthropic Base URL, Jev-seed models cleared with their default, no capability-test result, its Jev transport key still saved), and the legacy single-profile file is not rewritten by the import

### Requirement: Explicit compatibility and connection testing

Connection testing SHALL use the configured endpoint and selected model to verify Anthropic Messages streaming and a structured tool round trip, and SHALL report image-input support separately. For a `chatgpt` profile, the same test SHALL run through the companion's ChatGPT gateway with a test-scoped gateway token. The UI SHALL disclose that this test sends a small request and can incur API usage, or for a `chatgpt` profile that it counts against the ChatGPT usage limit. OpenAI Chat Completions-only endpoints configured as `anthropic` profiles SHALL not be reported as compatible. There SHALL be no standalone TypeSafe capability test; the Jev transport is tested only through the Jev-tools connection test.

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
- **WHEN** the user runs the primary connection test on any profile
- **THEN** it reports only the Anthropic-compatible or ChatGPT stages and issues no TypeSafe structured-choice or standalone text-model request

#### Scenario: TypeSafe image stage reports separately
- **WHEN** the primary connection test's image-input check fails on an `anthropic` or `chatgpt` profile
- **THEN** settings report the image capability separately under the primary test, and no standalone TypeSafe image stage exists

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

The extension SHALL be usable without Claude login, a Claude subscription, a preexisting Claude Code login, or the proprietary Claude in Chrome extension. It SHALL be usable with a valid Anthropic-compatible Base URL, API key and model, or with a ChatGPT account the user explicitly signs in with. First-run onboarding SHALL request provider configuration, offering the supported provider types (`anthropic` and `chatgpt`), rather than Claude account creation or sign-in, and SHALL NOT mention a standalone Jev/TypeSafe provider. It SHALL explain that usage and billing depend on the configured provider or the ChatGPT plan, without promising free inference or universal gateway compatibility.

#### Scenario: Fresh machine with provider credentials only
- **WHEN** a user with no Claude product account, login state, subscription or official extension completes one-time installation and enters supported provider credentials or signs in with ChatGPT
- **THEN** the assistant can chat, read the current page, control authorized browser actions and invoke enabled skills without opening a Claude login flow

#### Scenario: Invalid provider credentials
- **WHEN** provider authentication fails or a ChatGPT session expires
- **THEN** the application offers correcting the affected credential or endpoint, or signing in to ChatGPT again. It never silently switches to Claude account login, a different provider type, or another account's session

### Requirement: ChatGPT usage display

For a `chatgpt` profile in the signed-in state, the settings page SHALL show the account's current usage and limits, read through the companion, with these contents:

- the plan type;
- for each rate-limit window the account has, the percent of the window used and its reset time, including a countdown that updates while the block stays visible;
- a clearly labeled refresh action, and a credits line only for an account that has credits.

The page SHALL read usage when it loads a signed-in profile and when the user activates refresh, and SHALL NOT poll on a timer. A read SHALL show a loading state that disables the refresh action, and its outcome SHALL replace the displayed values only for the profile it was requested for. For a profile that is not signed in, or whose session has expired, no usage read SHALL be attempted.

A failed read SHALL show the copy for its error code in the same language as the rest of the settings page, leave the account email, plan, and model list untouched, and leave refresh available for another attempt. An expired session discovered by the read SHALL show the same session-expired state and sign-in action the rest of the page uses, and a companion that predates the usage operation SHALL be reported as needing an update rather than as a network failure. The usage display SHALL hold and show no token or credential, and SHALL show no account identity beyond the email and plan Settings already displays.

#### Scenario: Usage shown for a signed-in account

- **WHEN** the settings page displays a signed-in `chatgpt` profile
- **THEN** it shows the plan and, for each window the account has, that window's used percent with its reset countdown

#### Scenario: Account with two windows

- **WHEN** the account has both a primary and a secondary window
- **THEN** both are shown, each labeled by its own window length, and no window is shown twice or invented when the account has only one

#### Scenario: Explicit refresh

- **WHEN** the user activates refresh
- **THEN** a loading state is shown, one read is issued for that profile, and the displayed values are replaced by its result

#### Scenario: Read failure

- **WHEN** the read fails with a network, backend, or authentication error
- **THEN** the block shows the matching error message, keeps the account email, plan, and model list as they were, and leaves refresh available

#### Scenario: Session expires during a read

- **WHEN** the read reports the session expired
- **THEN** the page shows the session-expired state with the action to sign in with ChatGPT again, and no token appears anywhere in the page

#### Scenario: Not signed in

- **WHEN** the displayed profile is not signed in to ChatGPT
- **THEN** no usage block content is shown and no usage read is attempted

### Requirement: Jev browser-tools configuration on LLM profiles

An `anthropic` or `chatgpt` profile SHALL be able to configure the Jev browser tools (`browser_subgoal`, `extract_page`) through a dedicated, opt-in Settings section that is separate from the profile's primary provider configuration. Because every profile is an `anthropic` or `chatgpt` profile, the section SHALL appear for every profile. The section SHALL be additive and off by default: a profile with no Jev transport key saved SHALL behave exactly as before, and both tools SHALL remain absent.

The section SHALL NOT collect a separate text model (no text-model base URL, model id or text-model API key inputs). The tools' text/decision model is the profile's primary provider and its current model: the Anthropic-compatible endpoint and key, or the signed-in ChatGPT account. The section's copy SHALL state this. The section SHALL collect only the Jev transport, meaning the source (TypeSafe, Vercel AI Gateway, OpenRouter), an endpoint hint and the transport API key, plus the Jev-tools screenshot toggle. Saving a transport key SHALL enable both tools together. Saving the section SHALL succeed with only these fields and SHALL NOT require any text-model field. Entering these fields SHALL NOT modify the profile's primary Anthropic/ChatGPT configuration. Text-model values previously stored on a profile, including one migrated from the removed `typesafe` type, SHALL be left in storage untouched and SHALL NOT be read.

Configuration SHALL be persisted through the existing config and credential envelopes, and API keys SHALL be stored in the secret store and never rendered back to the page, consistent with the existing key inputs. The host gate SHALL remain the sole authority on whether a tool is available, and the UI SHALL NOT claim a tool is active.

#### Scenario: The section appears for an LLM profile

- **WHEN** the user views Settings for an `anthropic` or `chatgpt` profile
- **THEN** a distinct "Jev browser tools" section is shown with transport inputs and the screenshot toggle, no text-model inputs, and copy stating that the tools use the primary provider and its current model

#### Scenario: The section is absent for a typesafe profile

- **WHEN** the user views Settings for a profile that was stored as `typesafe` and has been migrated to `anthropic`
- **THEN** the "Jev browser tools" section is shown like on any other `anthropic` profile, its saved transport key is still reported as saved, and no standalone Jev configuration block or text-model field is shown

#### Scenario: Saving the transport enables both tools

- **WHEN** the user selects a transport source, enters its API key on an `anthropic`/`chatgpt` profile and saves
- **THEN** the save succeeds without any text-model field, the key is stored in the secret store and not shown back, and the host makes both `extract_page` and `browser_subgoal` available

#### Scenario: Configuring the text model enables extract_page only

- **WHEN** the user looks for a way to configure a separate text model for the Jev tools on an `anthropic`/`chatgpt` profile
- **THEN** no text-model inputs exist, and `extract_page` is never enabled on its own: it is enabled together with `browser_subgoal` by the saved transport key, using the primary provider's model

#### Scenario: Primary provider configuration is untouched

- **WHEN** the user enters or clears the Jev-tools fields
- **THEN** the profile's primary Anthropic/ChatGPT base URL, API key, sign-in and models are unchanged

#### Scenario: Secrets are never rendered

- **WHEN** a saved Jev transport key exists
- **THEN** the UI shows only a saved/clear affordance and never renders the key value

### Requirement: Jev-tools connection test on LLM profiles

An `anthropic` or `chatgpt` profile SHALL be able to test its Jev browser-tools configuration and receive a clear success or failure result, distinct from the primary provider's connection test. The test SHALL validate the text model as the profile's primary provider at its default model. For `anthropic`, that is the profile's endpoint and key. For `chatgpt`, it is the loopback gateway with a test-scoped gateway token that is revoked when the test ends, whatever the outcome. When the transport key is saved, the test SHALL also validate the Jev transport. It SHALL reuse the existing Jev capability-test path rather than a second implementation. The result SHALL indicate which tool(s) the current configuration enables: both, only when both stages pass, and neither otherwise. The test SHALL never expose or log a secret, and its failure message SHALL be a bounded, host-authored classification. When no transport key is saved, the result SHALL report "not configured" rather than a false success.

#### Scenario: A valid Jev config tests successfully

- **WHEN** the primary provider works and a working Jev transport key is saved, and the user runs the Jev-tools connection test
- **THEN** the test reports success and indicates both `extract_page` and `browser_subgoal` are enabled, without showing any secret

#### Scenario: An invalid Jev key or model fails clearly

- **WHEN** the Jev transport key is wrong, or the primary provider's model/credential is rejected
- **THEN** the test reports a bounded, host-authored failure for the failing stage with no secret, and does not claim the tools are available

#### Scenario: Text-model-only config enables extract_page only

- **WHEN** an `anthropic`/`chatgpt` profile still has legacy text-model fields stored but no Jev transport key
- **THEN** the test reports "not configured" with neither tool enabled; the legacy text-model values are ignored

#### Scenario: No transport key reports not configured

- **WHEN** no Jev transport key is saved
- **THEN** the test reports "not configured" with neither tool enabled, and makes no provider request

#### Scenario: The test is separate from the primary provider test

- **WHEN** the user runs the Jev-tools connection test on a `chatgpt`/`anthropic` profile
- **THEN** it reports under the Jev-tools section only, and the primary connection test result is unchanged

### Requirement: Jev browser-tools screenshot capture defaults off with an opt-in toggle

A `browser_subgoal` sub-run started from an `anthropic`/`chatgpt` profile SHALL NOT capture a screenshot for its planning/content model by default. This SHALL be controlled by a dedicated Jev-tools screenshot toggle that is off by default and is independent of the profile's primary configuration and of any legacy standalone screenshot value still stored on a migrated profile. The "Jev browser tools" settings section SHALL expose this toggle (unchecked by default), persisted through the existing configuration envelope. Enabling it SHALL re-enable screenshot capture for the sub-run's planning consultation of the primary provider's model. Disabling it or leaving it unset SHALL keep the sub-run text-only. Jev's action selection SHALL be unchanged in either state (it never receives the screenshot), and the read-only `extract_page` tool SHALL be unaffected.

#### Scenario: A new profile runs subgoals without screenshots

- **WHEN** an `anthropic`/`chatgpt` profile has the Jev browser tools enabled and the Jev-tools screenshot toggle unset
- **THEN** a `browser_subgoal` sub-run captures no screenshot, and Jev still selects actions from the structured page state

#### Scenario: The toggle re-enables screenshots

- **WHEN** the user checks the Jev-tools "Gửi ảnh chụp màn hình" toggle and saves
- **THEN** the value persists through the existing envelope and a subsequent `browser_subgoal` sub-run captures a screenshot for its planning consultation

#### Scenario: The toggle is separate from the primary/typesafe setting

- **WHEN** the Jev-tools screenshot toggle is changed on an `anthropic`/`chatgpt` profile
- **THEN** the profile's primary configuration is unchanged, and any legacy standalone screenshot value left on a migrated profile is neither read nor modified

#### Scenario: extract_page is unaffected

- **WHEN** the Jev-tools screenshot toggle is off
- **THEN** `extract_page` still functions (it captures no screenshot regardless of this toggle)

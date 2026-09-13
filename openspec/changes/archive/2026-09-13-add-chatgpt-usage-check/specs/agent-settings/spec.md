## MODIFIED Requirements

### Requirement: Editable provider profile
A provider profile SHALL have a provider type, `anthropic` or `chatgpt`. A profile persisted before provider types existed SHALL load as `anthropic` without any change to its other fields.

For an `anthropic` profile, settings SHALL expose Base URL, masked API key with replace/remove actions, editable model ID and display-name pairs, and exactly one default model. The initial Base URL SHALL be https://api.anthropic.com.

For a `chatgpt` profile, settings SHALL NOT expose Base URL or API key. Instead they SHALL expose:
- "Sign in with ChatGPT" and "Use a code instead" actions.
- The signed-in account email and plan.
- The signed-in account's current usage and limits, read on demand with an explicit refresh action (see "ChatGPT usage display").
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

#### Scenario: Signed-in ChatGPT profile
- **WHEN** a `chatgpt` profile in the signed-in state is open in Settings
- **THEN** the account email and plan are shown together with the usage block and its refresh action, and no Base URL or API key field is present

## ADDED Requirements

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

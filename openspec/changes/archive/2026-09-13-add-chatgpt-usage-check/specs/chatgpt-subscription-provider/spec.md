## ADDED Requirements

### Requirement: ChatGPT account usage read

For a signed-in `chatgpt` profile the companion SHALL read the account's current usage from `GET https://chatgpt.com/backend-api/wham/usage`, authenticated with exactly the access token and account id the ChatGPT auth module holds for that profile (`Authorization: Bearer <access token>`, `chatgpt-account-id: <account id>`) and no other credential, and SHALL answer with a small, display-shaped result instead of the backend payload:

- the plan type;
- whether the account may currently make requests, and whether its limit has been reached;
- each rate-limit window the backend reports, as `{ usedPercent, limitWindowSeconds, resetAfterSeconds, resetAt }` under a `primary` and a `secondary` slot, with `null` for a window the backend omits;
- a credits summary `{ hasCredits, unlimited, balance }` only when the account has credits, and `null` otherwise.

The result SHALL NOT contain the account id, user id, email, spend-control, promo, or any other backend field the settings page does not render, and SHALL NOT contain a token, a credential, or a raw backend error body.

The read SHALL obtain its access token through the same auth module the gateway uses and SHALL hold no credential of its own. When the endpoint answers 401 the companion SHALL refresh the access token once and retry the request once; a 401 that survives that single refresh SHALL mark the profile `SESSION_EXPIRED` through the same profile-state transition the gateway records, and SHALL be reported to the caller as a session-expired result. A credential that is missing, already rejected, or rejected during that refresh SHALL be reported without a retry.

Every other outcome — a non-401 HTTP status, a network failure, a timeout, or a body that is not the expected shape — SHALL be returned as a structured failure (an error code plus a short message) and SHALL NOT be thrown through the settings protocol. The read SHALL NOT mutate the stored credential, the profile's models, or a capability-test result, and SHALL NOT send a request at all when the profile has no usable credential.

#### Scenario: Single-window account

- **WHEN** a signed-in account is read and the backend reports one primary window with `used_percent` 3 and `limit_window_seconds` 2592000, with `secondary_window: null`
- **THEN** the result carries the plan type, the primary window's used percent, window length and reset timing, a `null` secondary window, and no account identity

#### Scenario: Two-window account

- **WHEN** the backend reports both a primary and a secondary window (the 5-hour and weekly windows of a paid plan)
- **THEN** the result carries both windows, each with its own used percent and reset timing, in the slots the backend assigned them to

#### Scenario: Access token refreshed once

- **WHEN** the endpoint answers 401 and the request retried with a freshly refreshed access token answers 200
- **THEN** the caller receives only the successful result

#### Scenario: 401 after the single refresh

- **WHEN** the request retried with a freshly refreshed access token is still answered 401
- **THEN** the profile's session state becomes the same `SESSION_EXPIRED` state the gateway records, and the caller receives a session-expired result that names no token

#### Scenario: Backend failure contained

- **WHEN** the endpoint answers a 5xx, times out, or answers a body that is not the expected JSON
- **THEN** the caller receives a structured failure whose message contains no credential, token, or raw response body

#### Scenario: No usable credential

- **WHEN** usage is read for a profile with no stored ChatGPT credential, or for one whose session is already expired
- **THEN** no upstream request is sent and the caller receives a sign-in-required or session-expired result

# chatgpt-subscription-provider Specification

## Purpose
Lets the browser assistant run on a user's own ChatGPT subscription by signing in the way Codex CLI does and exposing that account to the Claude Agent SDK through a local Anthropic-compatible gateway inside the native companion.

## Requirements

### Requirement: ChatGPT browser sign-in
The companion SHALL start a ChatGPT sign-in for a `chatgpt` profile by returning an authorization URL for `https://auth.openai.com/oauth/authorize` with response type `code`, the Codex public client id, redirect URI `http://localhost:1455/auth/callback`, scopes `openid email profile offline_access`, a random `state`, and an S256 PKCE challenge. It SHALL listen for the callback on the loopback interface only, port 1455, for at most 5 minutes, accept exactly one callback whose `state` matches, exchange the code at `https://auth.openai.com/oauth/token` with the PKCE verifier, and then close the listener. The settings page SHALL open the authorization URL in a new browser tab. Only one sign-in SHALL be in progress per profile; starting another cancels the first.

#### Scenario: Successful browser sign-in
- **WHEN** the user clicks "Sign in with ChatGPT", approves in the opened tab, and the callback arrives with the matching state
- **THEN** the companion exchanges the code, stores the credential, reports the account email and plan, and the callback page tells the user they can close the tab

#### Scenario: State mismatch
- **WHEN** a request reaches the callback listener with a different `state`
- **THEN** no token exchange happens, the callback page shows an error, and the sign-in stays pending until a matching callback or the timeout

#### Scenario: Port 1455 unavailable
- **WHEN** the callback listener cannot bind port 1455
- **THEN** the sign-in fails with `CALLBACK_PORT_IN_USE` and the settings page offers the device-code sign-in instead

#### Scenario: Timeout or cancel
- **WHEN** 5 minutes pass without a valid callback, or the user cancels
- **THEN** the listener closes, nothing is stored, and the sign-in reports `SIGN_IN_TIMEOUT` or `SIGN_IN_CANCELLED`

### Requirement: ChatGPT device-code sign-in
The companion SHALL offer a device-code sign-in that requests a user code from `https://auth.openai.com/api/accounts/deviceauth/usercode`, returns the user code and the verification URL `https://auth.openai.com/codex/device` to the settings page, polls the device token endpoint at the server-given interval (default 5 seconds) treating HTTP 403/404 as pending, stops after 15 minutes, and exchanges the returned authorization code and verifier at the token endpoint with redirect URI `https://auth.openai.com/deviceauth/callback`.

#### Scenario: Device code approved
- **WHEN** the user enters the shown code at the verification URL and approves
- **THEN** the next poll succeeds, the credential is stored, and settings show the signed-in account

#### Scenario: Device code expires
- **WHEN** 15 minutes pass without approval
- **THEN** polling stops and the sign-in reports `SIGN_IN_TIMEOUT`

### Requirement: ChatGPT credential lifecycle
The companion SHALL persist only the refresh token and ChatGPT account id as the profile's secret, through the same OS credential store and memory-only rules as API keys, and SHALL fail explicitly with `SECRET_TOO_LARGE` rather than truncate if the secret exceeds the store's limit. The account email and plan type, read from the ID token's `https://api.openai.com/auth` claims, SHALL be stored as non-secret profile fields. Access and ID tokens SHALL be held in memory only. Before an upstream request the companion SHALL refresh when no access token is held or it expires within 5 minutes, SHALL run at most one refresh per profile at a time, and SHALL persist the rotated refresh token before using the new access token. A refresh rejected as `invalid_grant` or `refresh_token_reused` SHALL remove the stored secret, bump the credential revision, and put the profile in the `SESSION_EXPIRED` state. Signing out SHALL remove the secret, clear in-memory tokens, revoke gateway tokens for that profile, and cancel runs using it.

#### Scenario: Refresh token rotation
- **WHEN** a refresh returns a new refresh token
- **THEN** the stored secret holds the new refresh token before the new access token is used for any request

#### Scenario: Concurrent requests during refresh
- **WHEN** two requests need a refresh at the same time
- **THEN** exactly one refresh request is sent and both requests use its result

#### Scenario: Reused refresh token
- **WHEN** the token endpoint answers `refresh_token_reused`
- **THEN** the profile becomes `SESSION_EXPIRED`, its secret is removed, and the side panel asks the user to sign in again

### Requirement: Loopback Anthropic gateway
The companion SHALL serve an Anthropic Messages-compatible HTTP gateway bound only to `127.0.0.1` on an OS-assigned port, started on first need and closed when the companion exits. It SHALL serve `POST /v1/messages` (streaming and non-streaming), `POST /v1/messages/count_tokens` (a local estimate, never an upstream call), and `GET /v1/models` (the profile's models). Every request SHALL present a gateway token via `x-api-key` or `Authorization: Bearer`; tokens are random (at least 32 bytes), issued per run or per capability test, bound to one profile and one model, and revoked when that run or test ends, the profile signs out, or its credential revision changes. Requests without a valid token SHALL get HTTP 401 with an Anthropic `authentication_error` body. Any other path SHALL get HTTP 404 with an Anthropic `not_found_error` body. The model named in a request SHALL be replaced by the token's bound model, so the SDK's background calls for other model ids use the run's model.

#### Scenario: Run uses the gateway
- **WHEN** a conversation starts on a signed-in `chatgpt` profile with model `gpt-5.6-terra`
- **THEN** the SDK receives `ANTHROPIC_BASE_URL` pointing at the gateway and a fresh gateway token as `ANTHROPIC_API_KEY`, and no ChatGPT token appears in the SDK environment

#### Scenario: Token revoked at run end
- **WHEN** a run finishes and a request arrives with its token
- **THEN** the gateway answers 401 `authentication_error`

#### Scenario: Background call for another model
- **WHEN** the SDK sends a request naming `claude-haiku-4-5` with a run token bound to `gpt-5.6-terra`
- **THEN** the upstream request uses `gpt-5.6-terra`

#### Scenario: Not reachable from other hosts
- **WHEN** the gateway is running
- **THEN** it accepts connections only on `127.0.0.1`

### Requirement: Upstream Codex request
For each `/v1/messages` call the gateway SHALL send `POST https://chatgpt.com/backend-api/codex/responses` with headers `Authorization: Bearer <access token>`, `chatgpt-account-id`, `Accept: text/event-stream`, `Content-Type: application/json`, `session_id` equal to the request's prompt cache key, `originator: browzy`, and a `User-Agent` identifying Browzy and its version. The body SHALL set `model` (the bound model), `instructions: ""`, `input`, `tools` when present, `tool_choice`, `parallel_tool_calls`, `reasoning` (`effort` and `summary: "auto"`), `store: false`, `stream: true`, `include: ["reasoning.encrypted_content"]`, and `prompt_cache_key` derived from the conversation id. It SHALL NOT send `max_output_tokens`, `max_tokens`, `temperature`, `top_p`, `stop`, `previous_response_id`, `metadata` or `user`, and SHALL NOT add tools the client did not request. On HTTP 401 it SHALL refresh the access token once and retry once.

#### Scenario: Unsupported sampling fields dropped
- **WHEN** the SDK request carries `max_tokens`, `temperature` and `stop_sequences`
- **THEN** none of them appear in the upstream body and the request still succeeds

#### Scenario: Expired access token mid-run
- **WHEN** upstream answers 401 and the refresh succeeds
- **THEN** the request is retried once with the new token and the client sees only the retried result

### Requirement: Anthropic to Codex request translation
The gateway SHALL translate Anthropic request content as follows:
- `system` (string or text blocks) → one `developer` message of `input_text`.
- User text → `input_text`; assistant text → assistant message `output_text`.
- Base64 images → `input_image` with a `data:` URL; URL images → `input_image` with that URL.
- Base64 PDF documents → `input_file` with a `data:` URL and a file name.
- `tool_use` → `function_call` with the same id as `call_id` and the input serialized as JSON `arguments`.
- `tool_result` → `function_call_output` whose output is text or an array of `input_text`/`input_image`. When `is_error` is true, a leading `input_text` of `Tool error:` is added.
- `thinking` blocks whose signature was issued by this gateway → `reasoning` items carrying that encrypted content. Other thinking and redacted thinking are omitted.
- `cache_control` is removed.

Any other content block type SHALL fail the request with HTTP 400 `invalid_request_error` naming the type. Tools SHALL become `function` tools with `strict: false` and parameters equal to the input schema minus `$schema` and `$id`. The web-search server tool SHALL become `{type:"web_search"}`. Tool names longer than 64 characters SHALL be shortened to unique names of at most 64 characters and restored in responses. `tool_choice` `auto`/`any`/`none`/`tool` SHALL map to `auto`/`required`/`none`/named function. `disable_parallel_tool_use: true` SHALL map to `parallel_tool_calls: false`, otherwise `true`. Reasoning effort SHALL come from `output_config.effort` when present; otherwise enabled thinking maps budget below 4000 to `low`, below 16000 to `medium`, and 16000 or more to `high`; otherwise the effort is `medium`.

#### Scenario: Screenshot tool result
- **WHEN** a `tool_result` contains a text block and a base64 JPEG image block
- **THEN** the upstream `function_call_output` output is an `input_text` item followed by an `input_image` item with `data:image/jpeg;base64,...`

#### Scenario: Long MCP tool name round trip
- **WHEN** a tool is named with 80 characters and the model calls it
- **THEN** upstream sees a unique name of at most 64 characters, and the client receives `tool_use` with the original 80-character name

#### Scenario: Unsupported block
- **WHEN** a message contains a `container_upload` block
- **THEN** the gateway answers 400 `invalid_request_error` naming `container_upload` and sends nothing upstream

### Requirement: Codex to Anthropic response translation
For streaming requests the gateway SHALL emit Anthropic SSE in order: `message_start` when the response is created; a `thinking` content block streaming reasoning-summary text, closed by a `signature_delta` equal to a gateway-issued signature wrapping the reasoning item's encrypted content; `text` blocks from output-text deltas; `tool_use` blocks with `input_json_delta` from function-call argument deltas; then `message_delta` with stop reason and usage, and `message_stop`. The stop reason SHALL be `tool_use` when any function call was emitted, `max_tokens` for an incomplete response with reason `max_output_tokens`, `refusal` for reason `content_filter`, and otherwise `end_turn`. Usage SHALL report `input_tokens`, `output_tokens` and `cache_read_input_tokens` from cached input tokens. Non-streaming requests SHALL return the same content as one Anthropic message object. An upstream `response.failed` or `error` event SHALL become an Anthropic `error` event (streaming) or error response (non-streaming).

#### Scenario: Tool call streamed
- **WHEN** upstream streams a function call `computer` with arguments in three deltas
- **THEN** the client receives `content_block_start` of type `tool_use` named `computer`, three `input_json_delta` events whose concatenation is the arguments, `content_block_stop`, and a final stop reason `tool_use`

#### Scenario: Reasoning carried to the next turn
- **WHEN** the SDK sends back the assistant message holding the thinking block and signature the gateway emitted
- **THEN** the next upstream `input` contains a `reasoning` item with the same encrypted content

### Requirement: Upstream error mapping
The gateway SHALL map upstream failures to Anthropic errors without exposing any token:
- A 401 still failing after the single refresh → HTTP 401 `authentication_error`, and the profile becomes `SESSION_EXPIRED`.
- `usage_limit_reached` → HTTP 429 `rate_limit_error` with a message stating the ChatGPT usage limit and its reset time, plus a `retry-after` header from `resets_in_seconds` or `resets_at`.
- Other 429 → HTTP 429 `rate_limit_error`.
- Context-length errors → HTTP 400 `invalid_request_error` whose message contains `prompt is too long`.
- Other 4xx → HTTP 400 `invalid_request_error` with the upstream message.
- 5xx or model at capacity → HTTP 529 `overloaded_error`.
- Network failure or timeout → HTTP 502 `api_error`.

#### Scenario: Usage limit reached
- **WHEN** upstream reports `usage_limit_reached` with `resets_in_seconds: 1800`
- **THEN** the client receives 429 `rate_limit_error`, `retry-after: 1800`, and a message naming the ChatGPT usage limit

#### Scenario: Context too long
- **WHEN** upstream rejects the input as exceeding the context window
- **THEN** the client receives 400 whose message contains `prompt is too long`

### Requirement: No circumvention behaviours
The ChatGPT provider SHALL use exactly one signed-in account per profile and SHALL NOT fail over to other accounts, rotate or pool accounts, spoof another client's user agent or originator, alter TLS fingerprints, obfuscate account identity, or retry past a reported usage limit.

#### Scenario: Usage limit is not bypassed
- **WHEN** the signed-in account hits its usage limit
- **THEN** the request fails with the usage-limit error and no request is sent with any other credential

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

# Implementation evidence

## Batch A — profile provider-type schema, errors, orchestration stubs (tasks 1.1-1.3, part of 6.4)

Files changed:
- `host/agent/settings/profile-schema.js` — `providerType`/`chatgptAccount` fields, `PROVIDER_TYPES`, `DEFAULT_PROVIDER_TYPE`, `CHATGPT_CAPABILITY_TEST_MARKER`, `isKnownProviderType()`, `resolveProviderType()`; `createEmptyProfile()` and `isPlausibleProfile()` updated additively.
- `host/agent/settings/errors.js` — added `CALLBACK_PORT_IN_USE`, `SIGN_IN_TIMEOUT`, `SIGN_IN_CANCELLED`, `SIGN_IN_FAILED`, `SESSION_EXPIRED`, `SECRET_TOO_LARGE`, `USAGE_LIMIT_REACHED`, `UPSTREAM_REJECTED_CLIENT` to `PROVIDER_ERROR_CODES`.
- `host/agent/settings/profile.js` — `setProviderType()`, `setChatgptAccount()`, `CODEX_MODEL_SEEDS_BY_PLAN` + `seedChatgptModelsForPlan()`; `loadProfile()`, `snapshotForRun()`, `testCapability()`, `refreshDiscoveredModels()`, `isRunnable()` updated to branch on provider type.
- `host/test/settings-profile.test.mjs` — 15 new checks (legacy migration, provider-type switch, chatgpt-account round trip, model seeding, chatgpt not-signed-in stubs, unknown-providerType `INVALID_PROFILE`, discovery-unsupported, capability-test-key marker).
- `openspec/changes/add-chatgpt-subscription-provider/tasks.md` — checked off 1.1, 1.2, 1.3.

### Scope note on `snapshotForRun`/`testCapability` for `chatgpt`

Per the batch brief, ChatGPT gateway/auth/snapshot wiring is out of this batch's scope (later batches implement `host/agent/chatgpt/`). For a `chatgpt` profile, `snapshotForRun()` and `testCapability()` now fail explicitly with `ProviderError("NO_CREDENTIAL", "ChatGPT sign-in is required ...")` before touching any anthropic-only credential/model-list logic. This is not a stand-in for the eventual gateway path — it is the spec's correct "not signed in" outcome (agent-settings spec, "ChatGPT profile not signed in" scenario) for a profile that has no session yet, and it will remain correct once later batches add the real gateway for a profile that genuinely never signed in.

### Exported API added (for later batches)

`host/agent/settings/profile-schema.js`:
- `PROVIDER_TYPES` — `["anthropic", "chatgpt"]`
- `DEFAULT_PROVIDER_TYPE` — `"anthropic"`
- `CHATGPT_CAPABILITY_TEST_MARKER` — `"chatgpt:codex"`
- `isKnownProviderType(providerType): boolean`
- `resolveProviderType(profile): string` — absent → `DEFAULT_PROVIDER_TYPE`, present value kept verbatim (including unrecognized ones)
- `createEmptyProfile(profileId?)` — now also sets `providerType: "anthropic"`, `chatgptAccount: null`
- `isPlausibleProfile(profile)` — now also tolerates absent/well-shaped `providerType`/`chatgptAccount`

`host/agent/settings/errors.js`:
- `PROVIDER_ERROR_CODES` — extended with the 8 new codes listed above (no removals; existing codes unchanged)

`host/agent/settings/profile.js`:
- `loadProfile(): Promise<{...} | null>` — result now also carries `providerType: string` and `chatgptAccount: {email,planType}|null`
- `setProviderType(profileId: string, providerType: string): Promise<ReturnType<typeof loadProfile>>` — throws a plain `Error` for an unrecognized `providerType`
- `setChatgptAccount(profileId: string, account: {email:string, planType:string} | null): Promise<ReturnType<typeof loadProfile>>` — throws `ProviderError("NO_CREDENTIAL", ...)` if the profile doesn't exist yet
- `CODEX_MODEL_SEEDS_BY_PLAN: Record<string, Array<{id:string,label:string}>>` — keys: `free`, `plus`, `pro`, `team`, `enterprise`; unrecognized plan keys are not present (callers should use `seedChatgptModelsForPlan`, which falls back internally, rather than indexing this table directly)
- `seedChatgptModelsForPlan(profileId: string, planType: string): Promise<ReturnType<typeof loadProfile>>` — applies `CODEX_MODEL_SEEDS_BY_PLAN[planType]` (or the free-plan list for an unrecognized `planType`) only when the profile's current `models` list is empty; otherwise a no-op that just returns the current profile
- `snapshotForRun(profileId, modelId)` — for a `chatgpt` profile: throws `ProviderError("NO_CREDENTIAL", "ChatGPT sign-in is required before this profile can run")`. For a profile whose `providerType` is neither `anthropic` nor `chatgpt`: throws `ProviderError("INVALID_PROFILE", ...)`. Anthropic behavior unchanged.
- `testCapability(profileId, modelId)` — same branching as `snapshotForRun`, message: `"ChatGPT sign-in is required before the connection test can run"`.
- `refreshDiscoveredModels(profileId)` — for a `chatgpt` profile: returns `{ supported: false, reason: "ChatGPT profiles have no model-listing endpoint; the model list stays manually editable" }` without requiring any stored credential. For an unrecognized `providerType`: throws `ProviderError("INVALID_PROFILE", ...)`. Anthropic behavior unchanged.
- `isRunnable(profileId, modelId)` — for a `chatgpt` profile, computes the capability-test lookup key using `CHATGPT_CAPABILITY_TEST_MARKER` in place of `profile.baseUrl` (so a future `chatgpt`-aware `testCapability()` must record its pass under that same key shape for `isRunnable` to see it). Returns `false` for an unrecognized `providerType`. Anthropic behavior unchanged.

### Test output tails

`node host/test/settings-profile.test.mjs` → `29/29 passed`
`node host/test/settings-discovery.test.mjs` → `5/5 passed`
`node host/test/settings-capability-test.test.mjs` → `11/11 passed`
`node host/test/settings-named-profiles.test.mjs` → `12/12 checks passed`
`node host/test/settings-all.test.mjs` → all suites in the aggregate passed (`settings-models`, `settings-atomic-store`, `settings-http-client`, `settings-profile`, `settings-discovery`, `settings-capability-test`, `secrets-store` [2 BLOCKED items are pre-existing, platform-only: macOS Keychain / Linux Secret Service, informational not failures], `secrets-redaction`) — final line: `All settings/secrets suites passed.`

## Batch C — translator modules (tasks 3.1, 3.2, 3.3, 3.4, 6.2)

Files added:
- `host/agent/chatgpt/translate-request.js` — Anthropic Messages request body -> Codex `responses` request body. Pure (no I/O).
- `host/agent/chatgpt/translate-stream.js` — Codex SSE -> Anthropic SSE state machine, non-stream accumulator on the same machine, plus a generic SSE line parser and an Anthropic SSE serializer for the gateway batch to reuse. Pure.
- `host/agent/chatgpt/upstream-errors.js` — upstream failure -> Anthropic HTTP error mapping table, used both for out-of-band (pre-stream) failures and for `error`/`response.failed` events arriving inside an already-200 stream. Pure.
- `host/test/chatgpt-translate.test.mjs` — 129 checks covering every request mapping/rejection, tool-name shortening (including an engineered SHA-256 collision to exercise the suffix path), tool_choice/web_search/parallel_tool_calls, reasoning-effort rules, dropped sampling fields, the upstream-body allowlist, the SSE line parser's chunk-boundary and multi-line-data handling, the stream state machine's fixtures (text, thinking+signature, split-delta tool call with name restoration, incomplete, content_filter, failed/error), non-stream/stream parity, and the full upstream error mapping table (including the same table applied to in-stream failures).

No fixture files were needed under `host/test/fixtures/chatgpt/` — every fixture is a small inline JS object in the test file, which kept the whole suite in one self-contained script matching this repo's other `host/test/*.test.mjs` files.

Files changed:
- `openspec/changes/add-chatgpt-subscription-provider/tasks.md` — checked off 3.1, 3.2, 3.3, 3.4, 6.2.

### Notable implementation decisions (not fully pinned down by the plain-English spec text)

- **`tool_choice`/`parallel_tool_calls` presence.** The spec's allowlist prose lists `tool_choice` without an explicit "when present" qualifier (unlike `tools`). Matched CLIProxyAPI's reference behavior instead: `parallel_tool_calls` is always present (driven by `tool_choice.disable_parallel_tool_use`), while `tools`/`tool_choice` are only added to the body when the Anthropic request itself has a `tools` array. This is what the reference translator does and is internally consistent (a `tool_choice` naming a tool makes no sense without a tool list).
- **Unsupported nested shapes inside an otherwise-known block type** (a `document` block that isn't base64 `application/pdf`; a `tool_result` array item that isn't `text`/`image`; an `image` block whose `source.type` is neither `base64` nor `url`) all throw `ChatGPTTranslationError` naming the block/part type, rather than being silently dropped the way CLIProxyAPI's Go reference does for a non-PDF document. This follows design.md's stated general philosophy ("fail loudly instead of losing content") consistently, not only for entirely-unknown top-level block types.
- **`mapUpstreamError`'s stream-event classification** falls back to a small `invalid_request_error:400 / authentication_error:401 / permission_error:403 / not_found_error:404 / rate_limit_error:429` table keyed on the upstream error's own `type` field when there is no HTTP status to key off (an `error`/`response.failed` event arrives inside an already-200 stream). This keeps a mid-stream failure classified the same way an equivalent pre-stream HTTP failure would be.
- **Call ids are never shortened.** The spec text for "Anthropic to Codex request translation" says `tool_use` becomes `function_call` "with the same id as `call_id`" with no length rule, unlike tool *names* (explicitly capped at 64). CLIProxyAPI's reference also shortens `call_id` via a SHA-256 scheme, but that is not asked for here, so `call_id`/`tool_use_id` are passed through verbatim.

### Exported API (for later batches — gateway wiring is task 4.x)

`host/agent/chatgpt/translate-request.js`:
- `REASONING_SIGNATURE_PREFIX` — `"brzcx1."`
- `class ChatGPTTranslationError extends Error` — `.status === 400`, `.anthropicErrorType === "invalid_request_error"`, `.blockType: string` (the offending content-block type or tool_result part type)
- `buildToolNameMap(names: string[]): Map<string, string>` — original -> upstream-safe name, deterministic, collision-safe
- `shortenToolName(name: string, toolNameMap?: Map<string,string>): string` — looks up `toolNameMap` first, else computes the same deterministic candidate standalone
- `translateAnthropicRequestToCodex(request: object, options: { model: string, promptCacheKey?: string }): { body: object, toolNameMap: Map<string,string> }` — throws `ChatGPTTranslationError` for any untranslatable block

`host/agent/chatgpt/translate-stream.js`:
- `createSSEParser()` — returns `{ push(chunk) }`; `push(chunk: string | Uint8Array)` returns `Array<{ event: string, data: string }>` — generic SSE line parser, chunk-boundary and multi-line-`data:` safe
- `serializeAnthropicSSEEvent(eventName: string, data: object): string` — `"event: <name>\ndata: <json>\n\n"`
- `createCodexStreamState(options: { toolNameMap?: Map<string,string> })` — returns opaque state, one per in-flight request/turn; builds its own short-to-original reverse map from `toolNameMap`
- `feedCodexEvent(state, frame: { event?: string, data: object }): Array<{ event: string, data: object }>` — `frame.data` is one already-parsed Codex SSE event object; returns zero or more Anthropic SSE frames (`data` is a plain object, ready for `serializeAnthropicSSEEvent`)
- `accumulateNonStreamMessage(frames: Array<{ event?: string, data: object }>, options: { toolNameMap?: Map<string,string> })` — returns `{ message: object }` or `{ error: <mapUpstreamError result> }`; throws a plain `Error` if no terminal event (`response.completed`/`response.incomplete`/`response.failed`/`error`) is present in `frames`

`host/agent/chatgpt/upstream-errors.js`:
- `mapUpstreamError(input, opts)` — `input` is one of `{ httpStatus: number, body?: unknown }`, `{ streamEventType: "error" | "response.failed", streamEventBody: object }`, or `{ networkError: true, message?: string }`; `opts` is `{ now?: () => Date }`; returns `{ status: number, headers: Record<string,string>, anthropicErrorBody: { type: "error", error: { type: string, message: string } }, authFailed: boolean, sessionExpired: boolean }`

### Test output tail

`node host/test/chatgpt-translate.test.mjs` → exit code 0, 129/129 checks passed, final line `ALL CHATGPT TRANSLATE TESTS PASSED`. Representative tail:

```
== upstream error mapping: full table ==
  PASS  401 -> authentication_error
  PASS  401 flags the caller that the session should be treated as expired
  PASS  usage_limit_reached -> 429 rate_limit_error
  PASS  retry-after comes from resets_in_seconds
  PASS  the message names the ChatGPT usage limit
  PASS  retry-after is computed from resets_at relative to the injected clock
  PASS  a plain 429 (not usage_limit_reached) is still rate_limit_error, with no retry-after fabricated
  PASS  context_length_exceeded -> 400 whose message contains 'prompt is too long'
  PASS  context-length detected from message text alone also maps correctly
  PASS  other 4xx -> 400 invalid_request_error carrying the upstream message verbatim
  PASS  5xx -> 529 overloaded_error
  PASS  a capacity message overrides even a 429 status to 529 overloaded_error
  PASS  a network failure -> 502 api_error
  PASS  an in-stream (200 OK) 'error' event with error.type authentication_error is still classified as 401
  PASS  an in-stream response.failed usage_limit_reached is classified the same as an out-of-band 429
  PASS  an in-stream context-length failure maps the same way as an HTTP-level one
  PASS  the mapped message is exactly the upstream message, nothing appended or substituted from elsewhere

ALL CHATGPT TRANSLATE TESTS PASSED
```

## Batch B — ChatGPT auth (`host/agent/chatgpt/auth.js`) and profile credential-lifecycle helpers (tasks 2.1-2.5, 6.1)

Files changed:
- `host/agent/chatgpt/auth.js` (new) — PKCE/state generation, authorize-URL builder, the single-shot loopback callback listener, code exchange, device-code start/poll/exchange, ID-token claim decoding, per-profile single-flight refresh, credential storage/removal, sign-out. Header comment attributes the OAuth shape (endpoints, client id, PKCE, device-flow field names) to CLIProxyAPI @ `ac02da6` (MIT); the actual upstream request/translation logic those files also contain is out of this batch's scope (Batch C/D own it) and was not touched.
- `host/agent/settings/profile.js` — additive only: `loadProfile()` now also returns `chatgptSessionState` (defaults to `"signed_out"` when absent); three new exported functions — `recordChatgptSignIn(profileId, {email, planType, backend})`, `recordChatgptSignOut(profileId)`, `recordChatgptSessionExpired(profileId)`. No existing function's behavior was changed (verified by the full pre-existing `settings-profile.test.mjs` suite still passing unchanged, plus `settings-all.test.mjs`).
- `host/test/chatgpt-auth.test.mjs` (new) — 18 checks against local mock HTTP servers and ephemeral loopback ports only; no real OpenAI endpoint and no real OS credential store is ever touched (every instance uses an injected in-memory fake secret store).
- `host/test/settings-profile.test.mjs` — 5 new checks for `chatgptSessionState` defaulting and the three new lifecycle helpers.
- `openspec/changes/add-chatgpt-subscription-provider/tasks.md` — checked off 2.1, 2.2, 2.3, 2.4, 2.5, 6.1.

### Design choices worth flagging for later batches

- **Injectable everything (design.md decision 3).** `createChatgptAuth(options)` takes every network endpoint, the callback host/port/path, `now`, `randomBytes`, `fetchImpl`, the secret-store functions, a `loadCredentialInfo(profileId)` hook, and the three lifecycle callbacks (`onSignedIn`/`onSessionExpired`/`onSignedOut`) as overridable options. The module's default export functions (`startBrowserSignIn`, `startDeviceSignIn`, `getSignInStatus`, `cancelSignIn`, `getAccessToken`, `signOut`) are bound to a production instance wired to the real OpenAI endpoints, real port 1455, and `host/agent/settings/profile.js`'s new lifecycle helpers. `host/test/chatgpt-auth.test.mjs` never touches that production instance — it builds its own `createChatgptAuth(...)` per check.
- **Ephemeral callback port.** `callbackPort: 0` is supported: the OS assigns a free port, and (when `browserRedirectUri` was not explicitly overridden) the redirect URI embedded in the returned `authUrl` is built from the actually-bound port, so tests never guess or reserve a fixed port. Production always uses the fixed, spec-mandated port 1455.
- **The ChatGPT credential's secret target is `browzy-in-chrome/chatgpt/<profileId>`** — distinct from `profile.js`'s own `browzy-in-chrome/settings/<profileId>` (the Anthropic API key's target), because a `chatgpt` profile never has an API key. `auth.js` owns reads/writes/deletes at this target directly via `secret-store.js`; `profile.js`'s new helpers never touch it — they only update the non-secret profile record (account, model seeds, the shared `hasCredential`/`memoryOnlyCredential`/`secretBackend` bookkeeping fields, `credentialRevision`, and `chatgptSessionState`) and fire the existing `onCredentialRevoked` listeners. `auth.js`'s default (production) instance learns which backend/memoryOnly mode a stored secret used via `loadCredentialInfo` → `profile.loadProfile()`, so a refresh or sign-out after a companion restart reads the secret from the correct backend without any of its own persisted state.
- **`SECRET_TOO_LARGE` is a fixed 2560-byte ceiling applied to every backend**, not only Windows Credential Manager — see the constant's comment in `auth.js` for why a backend-agnostic ceiling was chosen over a per-OS special case. It is checked before every store — both the initial sign-in secret and every rotated refresh token — and the secret is never written (let alone truncated) when it would be exceeded.
- **`chatgptSessionState`** (`"signed_out" | "signed_in" | "session_expired"`) is a new non-secret profile field, additive from `profile.js`'s side (not added to `profile-schema.js`'s `createEmptyProfile`/`isPlausibleProfile` in this batch, since those are Batch A's file — `loadProfile()` simply defaults an absent field to `"signed_out"`, the same pattern already used for `providerType`/`chatgptAccount`). Batch E (side-panel readiness) can read it directly off `loadProfile()`'s result to show the spec's `SESSION_EXPIRED` state without needing to probe the credential.
- **`recordChatgptSignOut` clears `chatgptAccount` to `null`; `recordChatgptSessionExpired` keeps it.** This was a judgment call (the spec does not say either way): an explicit sign-out is the user disowning the account, while a session-expired profile should still let the side panel/settings name *which* account needs to sign in again. Flagging in case a later batch's UI expects the opposite.
- **`getSignInStatus`/`cancelSignIn` throw a plain `Error` (not a `ProviderError`) for an unknown `signInId`** — terminal sign-in records are pruned after `statusRetentionMs` (default 10 minutes) so memory never grows unbounded, and there is no error code in `errors.js` for "sign-in id not found" (it isn't one of the spec's named failure modes). The settings-protocol batch should treat this as a protocol-level bug (asking about a sign-in that was never started, or was pruned) rather than surface it as a user-facing `ProviderError` code.

### Exported API (for later batches)

`host/agent/chatgpt/auth.js`:
- `createChatgptAuth(options?)` → `{ startBrowserSignIn, startDeviceSignIn, getSignInStatus, cancelSignIn, getAccessToken, signOut, _dispose }` — see the file's top-of-file doc comment for the full options list and each method's exact signature/return shape (matches the spec/design contract verbatim: `startBrowserSignIn({profileId, memoryOnly?}) -> {signInId, authUrl}`, `startDeviceSignIn({profileId, memoryOnly?}) -> {signInId, userCode, verificationUrl, expiresAt}`, `getSignInStatus(signInId) -> {state:"pending"} | {state:"signed_in", account:{email,planType}} | {state:"failed", code, message}`, `cancelSignIn(signInId) -> Promise<void>`, `getAccessToken(profileId, {forceRefresh?}) -> {accessToken, accountId}`, `signOut(profileId) -> Promise<void>`).
- Module-scope re-exports of a production-wired default instance: `startBrowserSignIn`, `startDeviceSignIn`, `getSignInStatus`, `cancelSignIn`, `getAccessToken`, `signOut` — these are what the gateway/settings-protocol batches should import directly.
- `chatgptSecretTarget(profileId): string` — `browzy-in-chrome/chatgpt/<profileId>`.
- OAuth constants: `CODEX_OAUTH_CLIENT_ID`, `CODEX_AUTHORIZE_URL`, `CODEX_TOKEN_URL`, `CODEX_BROWSER_REDIRECT_URI`, `CODEX_DEVICE_USERCODE_URL`, `CODEX_DEVICE_TOKEN_URL`, `CODEX_DEVICE_VERIFICATION_URL`, `CODEX_DEVICE_REDIRECT_URI`, `CODEX_OAUTH_SCOPE`, `CODEX_CALLBACK_HOST` (`127.0.0.1`), `CODEX_CALLBACK_PORT` (`1455`), `CODEX_CALLBACK_PATH` (`/auth/callback`).

`host/agent/settings/profile.js` (additive):
- `loadProfile()`'s result now also carries `chatgptSessionState: "signed_out" | "signed_in" | "session_expired"`.
- `recordChatgptSignIn(profileId: string, { email: string, planType: string, backend: string }): Promise<ReturnType<typeof loadProfile>>` — composes `setChatgptAccount` + `seedChatgptModelsForPlan`, then bumps `credentialRevision` and sets `hasCredential: true`, `memoryOnlyCredential: backend === "memory"`, `secretBackend: backend`, `chatgptSessionState: "signed_in"`.
- `recordChatgptSignOut(profileId: string): Promise<void>` — clears `chatgptAccount`, clears the credential-presence fields, bumps `credentialRevision`, clears `lastCapabilityTest`, sets `chatgptSessionState: "signed_out"`, fires `onCredentialRevoked` listeners.
- `recordChatgptSessionExpired(profileId: string): Promise<void>` — same as sign-out except `chatgptAccount` is preserved and `chatgptSessionState` becomes `"session_expired"`.

### Test output tails

`node host/test/chatgpt-auth.test.mjs`:
```
ChatGPT (Codex) OAuth sign-in and credential lifecycle

  PASS  startBrowserSignIn returns an authorize URL with the exact spec params
  PASS  the PKCE challenge equals base64url(sha256(verifier)) for a 96-byte verifier
  PASS  a callback with a mismatched state shows an error page and stays pending
  PASS  a matching callback exchanges the code, stores the credential, and reports signed_in
  PASS  cancelSignIn marks a pending sign-in as SIGN_IN_CANCELLED and closes the listener
  PASS  a browser sign-in times out with SIGN_IN_TIMEOUT when no valid callback arrives
  PASS  starting a new browser sign-in for the same profile cancels the previous one
  PASS  binding an already-used callback port fails with CALLBACK_PORT_IN_USE
  PASS  device sign-in: pending polls (403) until approval, then reports signed_in
  PASS  device sign-in stops after its cap with SIGN_IN_TIMEOUT when never approved
  PASS  getAccessToken persists the rotated refresh token before its promise resolves
  PASS  two concurrent getAccessToken calls trigger exactly one refresh request
  PASS  a cached, non-expiring access token is reused without any refresh request
  PASS  a refresh rejected as refresh_token_reused removes the secret, fires the callback, and reports SESSION_EXPIRED
  PASS  an oversize credential fails with SECRET_TOO_LARGE and is never stored
  PASS  a memory-only sign-in reports the memory backend and the credential is usable afterward
  PASS  signOut clears memory tokens, deletes the secret, and fires onSignedOut
  PASS  no ChatGPT token value ever appears in a thrown error message

18/18 passed
```

`node host/test/settings-profile.test.mjs` → `34/34 passed` (29 pre-existing, unaffected + 5 new — see the file for the new `chatgptSessionState`/`recordChatgpt*` checks).

`node host/test/settings-all.test.mjs` → all suites passed (`settings-models`, `settings-atomic-store`, `settings-http-client`, `settings-profile`, `settings-discovery`, `settings-capability-test`, `secrets-store` [2 pre-existing BLOCKED items, platform-only], `secrets-redaction`) — final line: `All settings/secrets suites passed.`

## Batch D — loopback gateway, upstream client, run wiring (tasks 4.1-4.4, 6.3)

Files added:
- `host/agent/chatgpt/gateway.js` (new) — `createChatgptGateway(options)`: loopback-only `node:http` server bound to `127.0.0.1` on an OS-assigned port (`listen(0)`), lazy idempotent start (`ensureStarted`), idempotent close. Routes `POST /v1/messages` (stream + non-stream), `POST /v1/messages/count_tokens` (a local byte-length estimate, never an upstream call), `GET /v1/models` (the bound profile's own list). Token registry keyed by a 32-byte base64url token bound to `{profileId, model, credentialRevision, purpose}`; accepted via `x-api-key` or `Authorization: Bearer`; the request's `model` is rewritten to the bound model; a per-token `AbortController` set lets either a revoke or a client disconnect tear down the in-flight upstream fetch. Anthropic-shaped 401 `authentication_error` (missing/unknown/revoked/stale-revision token) and 404 `not_found_error` (unknown path) bodies. The credential revision is re-checked on every request against `loadProfile()`, so a sign-out or a session-expiry (both of which bump it) takes effect for already-issued tokens without this module needing to observe either event. Module-scope production instance re-exported as `ensureGatewayStarted`/`issueGatewayToken`/`revokeGatewayTokensForProfile`/`closeGateway`, plus `_setActiveGatewayForTests` for the settings-protocol batch.
- `host/agent/chatgpt/upstream-client.js` (new) — `sendCodexRequest(...)`: translates one Anthropic body via `translate-request.js`, POSTs to `https://chatgpt.com/backend-api/codex/responses` (`DEFAULT_CODEX_RESPONSES_URL`) with the spec headers (`Authorization: Bearer`, `chatgpt-account-id`, `Accept: text/event-stream`, `Content-Type: application/json`, `session_id` equal to the prompt-cache key, `originator: browzy`, `User-Agent: browzy/<version> (<platform>)`), and applies the single refresh-and-retry-once-on-401 rule. `iterateCodexSSE(response)` turns the upstream SSE body into parsed Codex frames. `computePromptCacheKey` prefers `metadata.user_id`, else a stable `browzy-<sha256[:32]>` derived from the conversation's first user turn. Ordinary upstream/auth/translation failures return `{ error }` (shaped by `mapUpstreamError`); only an in-flight `signal` abort rethrows, left for the gateway's own abort handling.
- `host/test/chatgpt-gateway.test.mjs` (new) — 21 checks against a real `node:http` gateway and a real local mock upstream (never a real OpenAI endpoint): missing/unknown/revoked/stale-revision token → 401; `revokeAllForProfile` scope; Bearer auth accepted alongside `x-api-key`; unknown path → 404 `not_found_error`; model rewrite; `count_tokens` local, token-gated, and never sent upstream; the full upstream header set; 401 refresh-and-retry (exactly one `forceRefresh`, exactly two upstream calls) and a double 401 → 401; `usage_limit_reached` → 429 with `retry-after: 1800`; non-stream returns one message object; stream returns SSE with `content_block_delta`/`message_stop`; a client disconnect aborts the upstream fetch signal; loopback bind on an OS-assigned port; lazy start/stop port lifecycle; token length and base64url charset; `GET /v1/models` returns the profile's list.

Files changed:
- `host/agent/settings/profile.js` (the `chatgpt` branch only) — `snapshotForRun`/`testCapability` now dispatch on provider type: `chatgpt` routes to `snapshotForChatgptRun`/`testCapabilityForChatgpt`, both gated by `requireChatgptEligible` (session expired → `SESSION_EXPIRED`; not signed in → `NO_CREDENTIAL`; missing/unknown model → `NO_CREDENTIAL`/`INVALID_PROFILE`). `snapshotForChatgptRun` lazily starts the gateway, issues a `purpose: "run"` token, and returns the same snapshot shape with `env.ANTHROPIC_BASE_URL = http://127.0.0.1:<port>` and `env.ANTHROPIC_API_KEY = <gateway token>` — never a ChatGPT token — plus an additive `releaseGatewayToken` handle. `testCapabilityForChatgpt` issues a `purpose: "capability-test"` token, runs the SAME `runCapabilityTest` an `anthropic` profile uses, always releases the token in a `finally`, and records the result under the `CHATGPT_CAPABILITY_TEST_MARKER` key `isRunnable` already expects. The `anthropic` snapshot output is unchanged (all 34 pre-existing settings-profile checks still pass).
- `host/agent/companion.js` (gateway lifecycle and token revocation only) — the existing `onCredentialRevoked` listener, which `recordChatgptSignOut`/`recordChatgptSessionExpired` already fire, now also lazily revokes that profile's gateway tokens. A `chatgpt` run's `releaseGatewayToken` handle is stashed on the run right after `resolveProfileSnapshot()` and released exactly once via a new idempotent `_releaseRunGatewayToken(run)` at every settle path in `_runQuery` (the `.catch`, the resume-incompatibility stop, the options-build failure, and the main `finally`), and released directly in the enhance-prompt one-off path. Resume-compatibility identity records the fixed `chatgpt:codex` marker instead of the ephemeral loopback URL, so a companion restart alone is not mistaken for an endpoint change. A new `closeGatewayBestEffort()` (dynamic import, 2-second bound) runs on the forked child's parent-watch exit. Every gateway reference is a dynamic import, so a companion that never touches a `chatgpt` profile never loads the gateway module or opens its socket.
- Two gateway robustness fixes surfaced by the new test: (1) `close()` now force-closes lingering keep-alive sockets via `closeAllConnections()` after a short grace — `server.close()` alone never settles while undici's idle connection pool holds a socket, which would hang companion shutdown. (2) Client-disconnect detection moved from `req.on("close")` to `res.on("close")`: an already-consumed `IncomingMessage` does not emit `close` when the SDK tears down a streaming response, so the upstream fetch's `AbortSignal` was never aborted on a disconnect; `res`'s `close` fires on both an abort and a normal end, where the extra `abort()` on an already-settled controller is harmless. Both covered by the disconnect test.

### Verification

- `node host/test/chatgpt-gateway.test.mjs` → 21/21 passed, exit 0.
- `node host/test/chatgpt-auth.test.mjs` → 18/18 passed.
- `node host/test/chatgpt-translate.test.mjs` → exit 0, `ALL CHATGPT TRANSLATE TESTS PASSED`.
- `node host/test/settings-profile.test.mjs` → 34/34 passed. The two checks that assert `snapshotForRun`/`testCapability` report `NO_CREDENTIAL` for a `chatgpt` profile remain correct and untouched: the profile they build never signs in (`chatgptSessionState` stays `signed_out`), which is exactly the state `requireChatgptEligible` gates on, so they verify the spec's "ChatGPT profile not signed in" outcome rather than a Batch-A stub.
- `node host/test/settings-capability-test.test.mjs` → 11/11 passed.
- `node host/test/agent-companion-core.test.mjs` → 20/20 passed (the companion lifecycle edits are inert for `anthropic` runs).
- `node --check` clean on `companion.js`, `settings/profile.js`, `chatgpt/gateway.js`, `chatgpt/upstream-client.js`.

### Notes for later batches

- `snapshotForChatgptRun`/`testCapabilityForChatgpt` use a dynamic `import("../chatgpt/gateway.js")` rather than a static import, so `profile.js` never pulls `auth.js`/`secret-store.js` (gateway.js's transitive deps) into the `anthropic` path or into tests that only exercise `anthropic`.
- Batch 5's sign-out / session-expiry protocol handlers do not need to call `revokeGatewayTokensForProfile` explicitly: the per-request credential-revision check plus the `onCredentialRevoked` listener already cover it, because `recordChatgptSignOut`/`recordChatgptSessionExpired` bump the revision and fire that listener.
- The gateway is a generic loopback listener bound to an ephemeral port, so it can serve any profile whose credential revision matches the token it was issued against. A second profile's token simply never validates until that profile signs in and its revision matches; no per-profile gateway instance is needed.

## Batch E2 — extension side (tasks 5.2-5.5)

Scope: `extension/**` and the extension-side readiness tests only. NO `host/**` file was touched — Batch D (host) owns those and ran in parallel. Reconciled the half-finished work a rate-limit-interrupted E2 run had left on disk and completed the remaining gaps (relay op-allowlist, provider-aware "not usable" copy, cold-load SESSION_EXPIRED banner, checkboxes/evidence).

### Wire contract (Batch E1 / host `profile-protocol.js` MUST match this verbatim)

Transport unchanged: `chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })` → `{ ok: true, result } | { ok: false, error: { code, message } }`. The six new ops, request payload and reply `result`:

| op | request payload | reply `result` |
|---|---|---|
| `set_provider_type` | `{ profileId, providerType }` (`providerType` ∈ `"anthropic"` \| `"chatgpt"`) | the updated secret-free profile (same shape as `save_profile`/`get_profile`) |
| `chatgpt_sign_in_start` | `{ profileId }` | `{ signInId, authUrl }` |
| `chatgpt_device_start` | `{ profileId }` | `{ signInId, userCode, verificationUrl, expiresAt }` (`expiresAt` = epoch-ms number) |
| `chatgpt_sign_in_status` | `{ signInId }` | `{ state: "pending" }` \| `{ state: "signed_in", account: { email, planType } }` \| `{ state: "failed", code, message }` |
| `chatgpt_sign_in_cancel` | `{ signInId }` | `{ cancelled: true }` |
| `chatgpt_sign_out` | `{ profileId }` | the updated secret-free profile |

Hard rules for E1's dispatcher:
- No op carries a token/credential value in EITHER direction. `chatgpt_sign_in_status`/`chatgpt_sign_in_cancel` are keyed by `signInId` ONLY (no `profileId`) — the extension records the `signInId`→`profileId` association itself at `chatgpt_sign_in_start`/`chatgpt_device_start` time (see background.js `chatgptSignInProfileById`).
- `chatgpt_sign_in_start`/`chatgpt_device_start`/`chatgpt_sign_in_status` replies MUST NOT include the profile object; only the terminal `signed_in` status carries `{ email, planType }`. The full profile (account, seeded models, `chatgptSessionState`, bumped `credentialRevision`) is picked up by the extension through a follow-up `get_profile` once a status reaches `signed_in` (the mirror re-fetch is background.js's job; the settings page re-fetches via `init()`/poll success path in `settings-controller.js:_pollSignInStatus`).
- An unknown `providerType` → the host's existing `INVALID_PROFILE`; the extension never sends a value outside `anthropic`/`chatgpt`.
- `chatgpt_sign_out` must be idempotent (safe when not signed in) — the extension's sign-out button is only shown while `chatgptSessionState === "signed_in"`, but a stale page could still call it.

### Files changed

- `extension/settings/settings-client.js` — documents the six new ops in the file-header wire-contract block and adds six thin client methods (`setProviderType`, `chatgptSignInStart`, `chatgptDeviceStart`, `chatgptSignInStatus`, `chatgptSignInCancel`, `chatgptSignOut`) that only build/unwrap the envelope (no logic).
- `extension/background.js` —
  - **5.2 (completed this run):** `createAgentSettingsRelay()` now holds an explicit `ops` allowlist (all pre-existing ops + exactly the six new op names) and `handleRequest` fails closed with `PROTOCOL_ERROR` for any op not in the set, before it touches the native channel. This is the "allow exactly the new op names" requirement — without it the relay forwarded an arbitrary `op` string straight to the host. The set lives inside the factory (not module scope) so `test/_extract.mjs`'s brace-matched extraction of `createAgentSettingsRelay` keeps the shipped function self-contained (a module-scope const would be a `ReferenceError` in the extracted copy).
  - `toProfileCacheMirror()` mirrors three more non-secret fields off `loadProfile()` — `providerType`, `chatgptAccount`, `chatgptSessionState` — never any token.
  - `syncProfileCacheAfterAgentSettings()` handles the new ops: `set_provider_type`/`chatgpt_sign_out` mirror the returned profile directly (like `save_profile`); `chatgpt_sign_in_start`/`chatgpt_device_start` record `signInId`→`profileId`; `chatgpt_sign_in_status` re-fetches the tracked profile only on terminal `signed_in` and prunes the entry on any terminal outcome; `chatgpt_sign_in_cancel` prunes the entry.
- `extension/settings/settings-controller.js` — provider-type + sign-in state machine: `providerType`/`chatgptAccount`/`chatgptSessionState`/`switchingProviderType`/`signingOut`/`signIn` state; `setProviderType()`, `startBrowserSignIn()`, `startDeviceSignIn()`, `cancelSignIn()`, `signOut()`, `_pollSignInStatus()` (1 s `setInterval`, injectable `setIntervalFn`/`clearIntervalFn`/`pollIntervalMs`, transient poll errors never tear down a pending sign-in), `pauseSignInPolling()`/`resumeSignInPolling()`.
  - **5.3 gaps completed this run:** `_notUsableBanner()` (used by both `testConnection` and `discoverModels`) returns provider-appropriate guidance — `NO_CREDENTIAL` only for `anthropic`; for `chatgpt`, `null` when `signed_in`, the `SESSION_EXPIRED` copy when `session_expired`, and a bespoke "sign in with ChatGPT" banner otherwise — so the connection test on a not-signed-in `chatgpt` profile no longer tells the user to "enter an API key" (spec "ChatGPT profile not signed in"). `_applyProfile()` raises the `SESSION_EXPIRED` banner on a cold load when the session expired host-side, gated on "nothing more specific already shown" so it never clobbers a just-performed action's own banner.
- `extension/settings/settings-app.js` — DOM binding: provider-type radios, hide Base URL/API-key vs show ChatGPT fields, sign-in/use-a-code/cancel/sign-out wiring, `chrome.tabs.create` to open `authUrl` (`window.open` fallback only off-extension), device-code + verification link + 1 s expiry countdown, focus moved to the device code the moment it newly appears (not on every re-render), `visibilitychange`/`pagehide` pause/resume, per-phase aria-live status text.
- `extension/settings/settings.html` — provider-type radiogroup, `anthropic-baseurl-item`/`anthropic-key-item`/`chatgpt-fields` toggles, disclosure paragraph, signed-out / pending (device code + link + expiry + cancel) / signed-in (email+plan) / session-expired ("sign in again") sections, and a `chatgpt`-specific connection-test disclosure ("counts against the ChatGPT usage limit"). No inline `<script>`/handlers (CSP guard passes).
- `extension/settings/settings-validation.js` — **unchanged**, deliberately: it is the client mirror of `url.js`/`models.js` and needs no ChatGPT branch. A `chatgpt` profile still carries a valid `baseUrl` (left at its previous/default value per design.md "Rollback"), and `save()` keeps validating it — so an in-progress chatgpt edit saves cleanly and the old code path still finds a runnable Anthropic field. The `validateApiKey` gate is never reached because the key field is hidden and `save(secretInput)` is called with an empty `secretInput` for a chatgpt profile.
- `extension/settings/errors-ui.js` — **5.4:** user copy (Vietnamese title/message/action) for all eight new codes (`CALLBACK_PORT_IN_USE`, `SIGN_IN_TIMEOUT`, `SIGN_IN_CANCELLED`, `SIGN_IN_FAILED`, `SESSION_EXPIRED`, `SECRET_TOO_LARGE`, `USAGE_LIMIT_REACHED`, `UPSTREAM_REJECTED_CLIENT`), plus an optional `opts.op` argument so `PROTOCOL_ERROR` on one of the six new ops reads as "update the companion" instead of the pre-existing "endpoint speaks the wrong protocol". Every existing single-argument call site is unaffected.
- `extension/sidepanel/profile-cache.js` — **5.5:** `READINESS.CHATGPT_SIGN_IN_REQUIRED` / `CHATGPT_SESSION_EXPIRED`; `deriveReadinessState()` branches on `providerType === "chatgpt"` before the API-key states, and `resolveCapabilityStanding()` keys a chatgpt profile's capability test by the fixed `chatgpt:codex` marker (mirroring host's `CHATGPT_CAPABILITY_TEST_MARKER`) instead of its leftover `baseUrl`. Once signed in, a chatgpt profile falls through to the SAME PARTIAL/UNTESTED/STALE/TEST_FAILED/READY states; `isProfileComplete()` stays false for both chatgpt not-ready states.
- `extension/sidepanel/sidepanel.js` — `renderSetupBanner()` cases for the two new states, each linking to Settings (a re-test can't fix a sign-in; the structural test asserts they never offer the Test-connection button).
- `test/sidepanel-readiness-states.test.mjs` — a ChatGPT sign-in-required / session-expired / signed-in-falls-through / marker-key / re-sign-in-invalidates-test / anthropic-unchanged block, plus structural assertions that the two new states link to Settings and never to Test connection.

### Notes / non-obvious decisions

- **Poll is request/response, not pushed.** Matches design.md decision 5 ("status is polled ... the existing relay is request/response only"). `chatgpt_sign_in_status` carries only `signInId`, which is why background.js tracks the `signInId`→`profileId` map itself so it knows which profile to re-mirror once a sign-in completes.
- **`_notUsableBanner` returns null for a signed-in chatgpt profile.** The prior half-finished edit gated the whole chatgpt branch so it returned a sign-in banner for every non-expired chatgpt case, which would have blocked the connection test even after a successful sign-in. Corrected: `signed_in` → proceed.
- **No token ever enters extension storage.** `chatgptSignInProfileById` holds only `signInId`→`profileId` strings (in-memory, service-worker lifetime, pruned on terminal outcome); the mirror holds only the three non-secret fields; the wire contract forbids tokens both directions (asserted by `test/settings-ui-no-conversation-leak.test.mjs` and `test/settings-ui-secrets.test.mjs`, which now also enumerate the six new ops).

### Test output tails (extension-side; all exit 0)

```
node test/settings-ui-client.test.mjs               → ALL SETTINGS-UI CLIENT TESTS PASSED
node test/settings-ui-controller.test.mjs           → ALL SETTINGS-UI CONTROLLER TESTS PASSED
node test/settings-ui-validation.test.mjs           → ALL SETTINGS-UI VALIDATION TESTS PASSED
node test/settings-ui-secrets.test.mjs              → ALL SETTINGS-UI SECRET-ISOLATION TESTS PASSED
node test/settings-ui-no-conversation-leak.test.mjs → ALL SETTINGS-UI NO-CONVERSATION-LEAK TESTS PASSED
node test/background-agent-settings-relay.test.mjs  → ALL BACKGROUND AGENT-SETTINGS-RELAY TESTS PASSED
node test/background-agent-settings-profile-mirror.test.mjs → ALL BACKGROUND PROFILE-MIRROR TESTS PASSED
node test/sidepanel-readiness-states.test.mjs       → ALL SIDEPANEL READINESS-STATE TESTS PASSED
node test/extension-csp-no-inline-scripts.test.mjs  → ALL EXTENSION CSP GUARD TESTS PASSED (7 html files)
node test/extension-scripts-parse.test.mjs          → 8/8 passed
```

### Follow-up for Batch E1 / final verification (out of E2's scope)

- `test/background-agent-settings-relay.test.mjs` should gain a check that an un-allowlisted op resolves `PROTOCOL_ERROR` without posting (the new fail-closed gate has no dedicated assertion yet — existing cases all use allowlisted ops).
- Task 6.4 (test updates) is partially satisfied by the readiness-test additions above; the E1 host dispatcher still needs its own `agent-settings-relay.test.mjs` coverage for the six new ops.

## Batch E1 — host `agent_settings` protocol for the six new ops (task 5.1)

Scope: host side only. No `extension/**` file was touched (E2 owns those). This batch wires the companion's single-profile `agent_settings` dispatcher to the six ops Batch E2's extension relay already sends, matching the recorded wire contract verbatim.

### Where the ops actually go

Batch E2's wire contract lives on the **single-profile** path — the one `get_profile`/`save_profile`/`set_credential` use, handled by `CompanionCore._handleAgentSettings()` in `host/agent/companion.js`, which delegates to `host/agent/settings/profile.js`. `host/agent/settings/profile-protocol.js` is the `dispatchProfileCollectionOp()` seam over `named-profiles.js`, which proposal.md lists under "Not changed" (not on the run path). So the six new ops were added to `companion.js`'s `_handleAgentSettings()` switch, not to `profile-protocol.js`. `host/agent/protocol.js` only declares the `AGENT_SETTINGS` message-type constant and does no op dispatch; `dispatchProfile` (the collection form) is used only by `host/test/settings-named-profiles.test.mjs`. Verified by grep for `agent_settings` / `dispatchProfile` / `settingsProvider`.

### Files changed

- `host/agent/companion.js` (the `agent_settings` handler, the constructor's dependency list, one new lazy accessor, and two new module-scope/instance helpers):
  - New `_getChatgptAuthModule()` — a cached, lazy `import("./chatgpt/auth.js")`, the same discipline as `_getSettingsModule()` and `_revokeGatewayTokensForProfile()`: a companion that never serves a `chatgpt` profile never loads the auth module (and so never pulls `secret-store.js`'s OAuth path or opens a callback listener).
  - Six new `switch` cases in `_handleAgentSettings()`, each a direct delegation, each returning the existing `{ ok:true, result }` / `{ ok:false, error:{code,message} }` envelope shape:
    - `set_provider_type {profileId, providerType}` → `settings.setProviderType()`, replies the updated secret-free profile. A `providerType` outside `anthropic`/`chatgpt` → `INVALID_PROFILE` (a protocol check before delegation, so the host never persists a typo); a missing `profileId` → `PROTOCOL_ERROR`.
    - `chatgpt_sign_in_start {profileId}` → `auth.startBrowserSignIn({profileId})`, replies `{signInId, authUrl}` (explicitly these two fields only — never the whole auth record).
    - `chatgpt_device_start {profileId}` → `auth.startDeviceSignIn({profileId})`, replies `{signInId, userCode, verificationUrl, expiresAt}`.
    - `chatgpt_sign_in_status {signInId}` → `auth.getSignInStatus(signInId)`, replies `{state:"pending"}` / `{state:"signed_in",account:{email,planType}}` / `{state:"failed",code,message}` verbatim.
    - `chatgpt_sign_in_cancel {signInId}` → `auth.cancelSignIn(signInId)`, replies `{cancelled:true}` (auth-side cancel is already idempotent on a terminal record).
    - `chatgpt_sign_out {profileId}` → `auth.signOut(profileId)`, then re-reads `settings.loadProfile()` and replies the fresh secret-free profile (guarded on the same `profileId` as `get_profile`, else `null`). Idempotent — `auth.signOut()` deletes the secret and fires `onSignedOut` (`recordChatgptSignOut`: credential-revision bump + revocation listeners, which already revoke the profile's gateway tokens via the Batch-D listener) even when nothing was signed in.
  - Unknown-`signInId` handling: `auth.js` throws a plain codeless `Error` for an unknown/pruned sign-in id (Batch B's documented note that this is a protocol misuse, not a user-facing code). Left to the outer `catch`, that plain `Error` would be labelled `NETWORK_ERROR` — implying a network call was made and failed, which is a materially different thing for the settings page to show. The status/cancel cases now wrap those two calls in a module-scope `asProtocolError(err, msg)` helper (`host/agent/companion.js`, top of file) that rethrows an already-coded error unchanged (so a `ProviderError` from a genuine sign-in failure still surfaces with its real code) and otherwise rethrows a `PROTOCOL_ERROR`. No token is ever read or emitted on that path — `getSignInStatus`/`cancelSignIn` look the id up in the in-memory `signIns` map and throw before touching any credential.
  - Token discipline is now enforced by three independent layers, not just field projection: the two start replies destructure named fields; the sign-in-status and both profile-returning replies (whose content this layer did not construct) pass through a new `_assertAgentSettingsResultSecretFree(value, secretHint)` (a widened copy of `profile-protocol.js`'s `assertSecretFree` — also names `accessToken`/`refreshToken`/`idToken` keys, while deliberately still matching the profile's own non-secret `hasCredential`/`credentialRevision`/`secretBackend`); a violation throws `PROTOCOL_ERROR`, never the raw content.
  - The auth surface is injectable for tests via a new `CompanionCore` constructor dep `chatgptAuthProvider` (same additive lazy pattern as `settingsProvider`): `_getChatgptAuthModule()` returns it verbatim when present, else lazily imports the real `auth.js`. Production never passes it, so nothing there changes.
  - The outer `catch` already maps a thrown `ProviderError` (its `.code`) — e.g. `CALLBACK_PORT_IN_USE` from `startBrowserSignIn`, `SIGN_IN_FAILED` — to `{ok:false,error:{code}}`; a failed auth-module import falls to the same catch as `NETWORK_ERROR`. No new error codes were added (they all exist from Batch A).

### Wire-contract compliance (against Batch E2's table)

- No op carries a token/credential in either direction. `chatgpt_sign_in_status`/`chatgpt_sign_in_cancel` are keyed by `signInId` only.
- `chatgpt_sign_in_start`/`chatgpt_device_start`/`chatgpt_sign_in_status` replies never include the profile object; only the terminal `signed_in` status carries `{email, planType}`. `set_provider_type` and `chatgpt_sign_out` are the only two that reply the profile, and both are the secret-free `loadProfile()`/`setProviderType()` result (`profile.js` never stores tokens — access/ID tokens are memory-only in `auth.js`).
- An unknown op still returns `PROTOCOL_ERROR` (unchanged `default` case; relay allowlisting is E2's, already done).

### Verification

- `node --check host/agent/companion.js` → clean.
- `node host/test/agent-settings-relay.test.mjs` → 23/23 passed (the 10 pre-existing cases unchanged, plus 13 new Batch E1 cases covering the six-op wire contract, input validation, unknown-signInId → PROTOCOL_ERROR, and that a start reply carrying a token field never crosses the wire — see the test file's own header for the exact assertions; the Batch B `chatgpt-auth.test.mjs` suite remains the auth-logic owner — no real port 1455 or OS store is touched here).
- `node host/test/settings-profile.test.mjs` → 34/34 passed (unchanged — this batch adds no `profile.js` surface).
- `node host/test/settings-all.test.mjs` → `All settings/secrets suites passed.` (secrets-store 2 BLOCKED items remain platform-only/informational, unchanged).
- `node host/test/agent-companion-core.test.mjs` → 20/20 passed (the companion lifecycle edits are inert for `anthropic` runs; the new `chatgptAuthProvider` dep is additive and defaults to the real module).

### Follow-up

- Task 6.4's `host/test/agent-settings-relay.test.mjs` slice for the six new ops (the protocol layer) is now committed. Task 6.4 also tracks unrelated updates (`settings-capability-test`, `settings-ui-*`, `background-agent-settings-relay`, `sidepanel-readiness-states`); those remain open. Task 6.5 (opt-in live test) and 6.6 (full `test/*.test.mjs` sweep) remain open.

## Batch G — docs and attribution (tasks 7.1, 7.2)

Docs and comments only. No executable code path changed: the only source file touched is `host/agent/chatgpt/gateway.js`, and only its top-of-file comment block.

### 7.1 — NOTICE and per-file attribution

- `NOTICE` — new `Third-party code: CLIProxyAPI` section after the existing fonts section: upstream `router-for-me/CLIProxyAPI` @ commit `ac02da6`, what was ported (Codex OAuth shape, Anthropic↔Codex request/stream translation, upstream header/body rules, error-classification table), what was deliberately not ported (`codex-tui` UA/originator impersonation, uTLS fingerprinting, multi-account pooling/failover, identity obfuscation, `image_generation` tool injection), and the full verbatim MIT permission notice with both upstream copyright lines (`Copyright (c) 2025-2005.9 Luis Pater`, `Copyright (c) 2025.9-present Router-For.ME`). The upstream text was taken from the license file at that commit (`raw.githubusercontent.com/router-for-me/CLIProxyAPI/ac02da6/LICENSE`), not from memory, and the first copyright line's apparent `2025-2005.9` year-range typo is reproduced as-is with that stated in a note — an attribution record must not silently rewrite the notice it is preserving.
- Per-file headers in `host/agent/chatgpt/`: five of the six files already named `router-for-me/CLIProxyAPI @ ac02da6 (MIT)` plus their upstream reference paths from their own batches (`auth.js:5`, `translate-request.js:10`, `translate-stream.js:9`, `upstream-errors.js:18`, `upstream-client.js:14`) — left intact, nothing restated. `gateway.js` had no attribution line, so its header now carries one: the wire behaviour it exposes comes from CLIProxyAPI (pointing at NOTICE and the five per-file headers rather than re-listing them), **and** the sentence recording that the file's own distinguishing shape — loopback-only bind, OS-assigned port, per-run tokens bound to `{profile, model, credentialRevision}` — is this project's design (design.md decisions 1 and 2), not CLIProxyAPI's, which serves many clients under its own API-key model. Attribution should say what came from where precisely enough that a later reader never has to guess, including where the answer is "not from upstream".

### 7.2 — README and docs/cai-dat.md

- `README.md` → `### Configure your provider` restructured into a two-provider-type lead (provider type chosen per profile; side panel/tools/approvals/skills identical either way) plus `#### Anthropic-compatible API key (default)` (the existing four steps and credential paragraph, verbatim — behaviour unchanged) and a new `#### Run it on a ChatGPT subscription`: sign-in steps (switch type → sign in → account email and plan shown → models seeded for the plan, only while the list is empty), the device-code fallback with the reason it is needed (port `1455` held, typically by a running Codex CLI login) and the `auth.openai.com/codex/device` URL + expiry, the usage-limit meaning of **Test connection**, sign-out semantics, the unofficial/undocumented-backend disclosure with OpenAI ToS applying and the honest `originator: browzy`, and an explicit not-supported list (account pooling/rotation/failover, other clients pointing at the gateway, model discovery). Also closed two places that asserted API-key-only as the sole side-panel credential: the Installation **Prerequisites** bullet and the Quick-start table's "Account needed" row.
- `docs/cai-dat.md` → same content in Vietnamese, in that file's register. `### 4. Nhập API key` became `### 4. Chọn nhà cung cấp` (both types, plus the Test-connection gate), followed by a new `## Đăng nhập bằng gói ChatGPT` section mirroring the README one. The **Chuẩn bị** bullet now offers either credential instead of only an API key.

Cross-references verified: `#run-it-on-a-chatgpt-subscription` (README `#### Run it on a ChatGPT subscription`) and `#đăng-nhập-bằng-gói-chatgpt` (cai-dat `## Đăng nhập bằng gói ChatGPT`) both resolve to headings that exist in their own files.

### Verification

- `node --check host/agent/chatgpt/gateway.js` → clean (comment-only change).
- `grep -n "ac02da6" host/agent/chatgpt/*.js` → all six files listed above, one attribution line each.
- Every factual claim in the new doc text was checked against source or spec rather than written from the prose: the `1455`/device-code fallback and its `CALLBACK_PORT_IN_USE` trigger (spec "Port 1455 unavailable"; design.md decision 3), the seed-only-when-empty model behaviour (`profile.js` `seedChatgptModelsForPlan`), the disclosure wording quoted in the docs (`extension/settings/settings.html` `#chatgpt-disclosure`, `#test-disclosure-chatgpt`, and the actual button labels `Đăng nhập với ChatGPT` / `Dùng mã thay thế` / `Đăng xuất` / `Loại nhà cung cấp` / `Tài khoản ChatGPT`), the secret target `browzy-in-chrome/chatgpt/<profileId>` and memory-only access tokens (Batch B), the loopback/ephemeral-port/per-run-token gateway contract and revocation (Batch D), the one-account/no-failover rule (spec "No circumvention behaviours"), and the two-companion-processes caveat (design.md Risks).
- No test asserts README/NOTICE content (`grep` over `test/` for doc-content assertions found only `companion-missing-notice.test.mjs`, which is about the side panel's missing-companion banner, not this file), so no test run was required for this batch; the extension's HTML/CSP and script-parse guards are unaffected since no shipped markup or script changed.

### Open items after this batch

- Tasks 5.1 (host protocol) and 6.4/6.5/6.6 remain unchecked in `tasks.md`; Batch E1 recorded that its `CompanionCore` check was an ad-hoc harness, not a committed test, so 6.4's relay coverage for the six new ops is still owed.

## Batch H — final test tasks (6.4, 6.5, 6.6)

Scope: tests only. No production file was changed in this batch (the one production-adjacent edit — `extension/settings/settings-validation.js` — was deliberately left alone; see the audit below).

### 6.4 — test updates

Audited every file 6.4 names, then closed only the genuinely missing gaps:

- **`test/background-agent-settings-relay.test.mjs`** — added the recorded open follow-up: an op outside the relay's allowlist (Batch E2's fail-closed gate) resolves `PROTOCOL_ERROR` locally, names the refused op, and posts **nothing** to the native channel; the next allowlisted op still forwards normally (the gate is per-op, not a latch). Added a second block asserting all six ChatGPT ops are allowlisted and none resolves with the local rejection.
- **`test/settings-ui-client.test.mjs`** — added the six new ops' outgoing message shape (`set_provider_type` with `providerType`; `chatgpt_sign_in_start`/`chatgpt_device_start`/`chatgpt_sign_out` with `profileId` only; `chatgpt_sign_in_status`/`chatgpt_sign_in_cancel` keyed by `signInId` **only**, no `profileId`) plus a per-op scan that no secret-shaped field is ever sent. E2 added the six client methods but no test.
- **`test/settings-ui-controller.test.mjs`** — added 49 checks for the provider-type/sign-in state machine E2 added with no coverage: provider-type switch (`set_provider_type` reaches the companion; model list untouched; prior connection result cleared; an unknown type rejected locally and never sent), browser sign-in pending state + injected-timer poll → `signed_in` applies the re-fetched profile and stops polling, device sign-in surfaces code/link/expiry and cancel clears it, terminal failure stops polling while a transient poll error does not, `CALLBACK_PORT_IN_USE` from the start op surfaces its own code and leaves no pending state, `testConnection`/`discoverModels` on a not-signed-in chatgpt profile send **no** request and show a sign-in banner (never "enter an API key"), a cold-load `session_expired` profile shows the `SESSION_EXPIRED` banner and sends no request, the signed-in path does proceed, and sign-out clears the mirrored account/credential state.
- **`test/settings-ui-scripted-companion.mjs`** (test fixture, additive) — implements the six new client methods with reply shapes from the recorded wire contract, plus per-op `scripts.*` overrides. Required support for the controller checks above; the alternative (a second inline fake) would have been a competing convention.
- **`test/settings-ui-secrets.test.mjs`** — added the ChatGPT half of "tokens never reach the extension": a comment-stripped static scan of `extension/settings/**` for `access_token|refresh_token|id_token|accessToken|refreshToken|idToken|Bearer`, and a runtime full sign-in/sign-out flow (fake non-ticking timers) asserting no token-shaped field or value ever lands in an emitted state snapshot or in a companion call.
- **`host/test/settings-capability-test.test.mjs`** — the spec requires a `chatgpt` profile's capability test to run through the companion's gateway with a **test-scoped** token, and nothing covered that offline. Added three checks:
  1. not eligible (`signed_out` → `NO_CREDENTIAL`, `session_expired` → `SESSION_EXPIRED`, model outside the list → `INVALID_PROFILE`) with the module's active gateway swapped for one whose `getAccessToken`/`fetchImpl` would throw: asserts the gateway was never started (`_port() === null`), no token was issued, and no upstream call was made. Covers `requireChatgptEligible`'s `SESSION_EXPIRED` branch, which had no test anywhere.
  2. signed-in profile → real `snapshotForRun`/`testCapability` path: exactly one gateway token is issued with `purpose: "capability-test"` bound to the profile/model; the three-part `runCapabilityTest` (real SDK) passes through the loopback gateway against a local mock Codex upstream; every upstream call carries `Authorization: Bearer <real ChatGPT token held by the gateway>`, `originator: browzy`, `chatgpt-account-id`, `stream: true`, `store: false`; the token is released when the test ends; the pass is recorded under the fixed `chatgpt:codex` marker key and makes `isRunnable` true.
  3. a run snapshot's `env` carries exactly `ANTHROPIC_BASE_URL` (loopback) + `ANTHROPIC_API_KEY` (the issued gateway token, `purpose: "run"`), contains no ChatGPT token/account value, and releasing the handle revokes the token.
- **Confirmed already-adequate, left untouched:** `host/test/settings-profile.test.mjs` (34/34; legacy-profile migration, provider-type switch, chatgpt account/session/model seeding, unknown-`providerType` `INVALID_PROFILE`, discovery-unsupported, marker-keyed `isRunnable`), `host/test/agent-settings-relay.test.mjs` (23/23; E1's six-op protocol coverage), `test/sidepanel-readiness-states.test.mjs` (E2's ChatGPT block), `test/background-agent-settings-profile-mirror.test.mjs` (enumerates `providerType`/`chatgptAccount`/`chatgptSessionState` and the `set_provider_type`/`chatgpt_sign_out` mirror paths), `test/settings-ui-no-conversation-leak.test.mjs` (its op scan is generic — `call("<op>", {…})` — so it already covers the six new ops without naming them), `test/settings-ui-validation.test.mjs` (by E2's documented design: a chatgpt profile still keeps a valid `baseUrl` and the client-side mirror of `url.js`/`models.js` needs no ChatGPT branch), `test/settings-ui-real-companion.test.mjs` and the skills suites (anthropic path unchanged).

### 6.5 — opt-in live test

Created **`host/test/chatgpt-live.test.mjs`** (`OCIC_RUN_LIVE_CHATGPT_TESTS=1`, pattern of `settings-live.test.mjs`):
- Gate first: unset → one clear skip line and exit 0, **before** any dynamic import, so no module, no credential read, and no network is touched. Set but no signed-in `chatgpt` profile → a second clear skip line and exit 0.
- When live: `snapshotForRun()` (real production auth, refresh token from the OS store, access token memory-only) feeds the gateway URL/token; asserts the SDK env is only the two `ANTHROPIC_*` keys; then one streamed tool round trip with the image probe — an 80-character tool name (shortened upstream, restored client-side), `message_start` → `tool_use` → `input_json_delta` → `message_delta stop_reason=tool_use` → `message_stop` — followed by a `tool_result` carrying text + base64 image, expecting a completed turn; finally the released run token gets 401 `authentication_error`.
- `runStreamedToolRoundTrip()` is exported and the file only `process.exit`s when it is the main module, so its own request/assertion logic is verifiable offline. Non-obvious findings from doing exactly that:
  - `createSSEParser()`'s frames carry `data` as the raw field **text**, not parsed JSON — the live test decodes it before asserting.
  - Codex SSE *data* must carry a `type` field: `feedCodexEvent` switches on `data.type`, not the SSE `event` name. The capability test's mock `response.created` frame initially omitted `type`, so no `message_start` was emitted at all (the SDK tolerated it). Both mocks now send `type: "response.created"`.

### 6.6 — runs

New + touched suites (all exit 0):

```
node host/test/chatgpt-auth.test.mjs                 → 18/18 passed
node host/test/chatgpt-translate.test.mjs            → ALL CHATGPT TRANSLATE TESTS PASSED
node host/test/chatgpt-gateway.test.mjs              → 21/21 passed
node host/test/chatgpt-live.test.mjs                 → chatgpt-live.test.mjs: skipped (set OCIC_RUN_LIVE_CHATGPT_TESTS=1 with a signed-in chatgpt profile already configured to run this)
node host/test/settings-capability-test.test.mjs     → 14/14 passed
node host/test/settings-profile.test.mjs             → 34/34 passed
node host/test/agent-settings-relay.test.mjs         → 23/23 passed
node host/test/agent-companion-core.test.mjs         → 20/20 passed
node host/test/settings-all.test.mjs                 → All settings/secrets suites passed.  (secrets-store's 2 BLOCKED items remain platform-only, pre-existing)
node test/background-agent-settings-relay.test.mjs   → ALL BACKGROUND AGENT-SETTINGS-RELAY TESTS PASSED
node test/settings-ui-client.test.mjs                → ALL SETTINGS-UI CLIENT TESTS PASSED
node test/settings-ui-controller.test.mjs            → ALL SETTINGS-UI CONTROLLER TESTS PASSED
node test/settings-ui-secrets.test.mjs               → ALL SETTINGS-UI SECRET-ISOLATION TESTS PASSED
node test/settings-ui-no-conversation-leak.test.mjs  → ALL SETTINGS-UI NO-CONVERSATION-LEAK TESTS PASSED
node test/settings-ui-real-companion.test.mjs        → ALL SETTINGS-UI REAL-COMPANION INTEGRATION TESTS PASSED
node test/settings-ui-validation.test.mjs            → ALL SETTINGS-UI VALIDATION TESTS PASSED
node test/background-agent-settings-profile-mirror.test.mjs → ALL BACKGROUND PROFILE-MIRROR TESTS PASSED
node test/sidepanel-readiness-states.test.mjs        → ALL SIDEPANEL READINESS-STATE TESTS PASSED
node test/extension-csp-no-inline-scripts.test.mjs   → ALL EXTENSION CSP GUARD TESTS PASSED
node test/extension-scripts-parse.test.mjs           → 8/8 passed
```

Extension sweep `for t in test/*.test.mjs; do node "$t" || break; done`: 92 files exist; the loop stops at `test/overlay-background-bridge.test.mjs`. Running the remainder individually, the only failures are three files that are **outside this change** and were not touched, and are reproducible from HEAD state (their own test files and target source carry no working-tree modification from this change):

- `test/overlay-background-bridge.test.mjs` — `ReferenceError: requestAnnotationClear is not defined` inside the extracted `teardownOverlayForRun`. `git show HEAD:extension/background.js` already contains that call in that function, the test injects no such symbol, and `git diff -U0 extension/background.js` touches only `createAgentSettingsRelay`/`toProfileCacheMirror`/`syncProfileCacheAfterAgentSettings`. Pre-existing; left unedited.
- `test/overlay-pointer.test.mjs` — `FAIL found the OVERLAY_CSS string literal block in the shipped source` → `cssMatch[1]` null. Test and overlay sources are unmodified in this working tree. Pre-existing; left unedited.
- `test/side-panel-group-scope.test.mjs` — 6 structural failures about group membership/resolver/adoption. It reads `extension/background.js`, whose working-tree diff is confined to the settings relay/mirror functions; the expected group machinery is absent at HEAD as well (it belongs to the parallel `side-panel-action-visibility` session). Unrelated; left unedited.

All other extension test files pass individually (including every `settings-ui-*`, `sidepanel-*`, `background-*` suite).

Live-network limitation (honest reporting): no signed-in ChatGPT account exists in this environment, so `chatgpt-live.test.mjs`'s real-backend assertions were **not** executed. Verified instead: (a) the unset-env skip path, (b) the set-env-but-not-signed-in skip path (both exit 0, no network), and (c) the file's own round-trip logic end to end against the real gateway + a local mock Codex upstream via a throwaway harness (two upstream calls, tool name shortened upstream and restored client-side, model rewritten to the bound model, `stream:true`/`store:false`, exit 0). The throwaway harness lives in the OS temp dir and is not part of the repo.

### Open items after this batch

- Real-backend behaviour (whether OpenAI accepts `originator: browzy` with `tools`/named `tool_choice`, and the live round trip generally) is still unobserved; the opt-in live test is the documented way to answer it.
- The three extension-sweep failures above are pre-existing/unrelated and remain unfixed by design (scope discipline); they need their own owner (`side-panel-*` sessions / overlay code).


## Batch I — verification findings resolved

Independent verification (round 1) confirmed everything else audits clean and raised exactly two findings. Neither was a missing feature invented here: both are spec statements whose production wiring did not exist. Only the files named in the brief were touched; nothing else was re-opened or refactored, and `tasks.md` is deliberately left as-is (its checkboxes are accurate again now that the wiring exists).

### Finding 1 (CRITICAL) — the `SESSION_EXPIRED` half of the post-refresh 401

**What the verifier found.** `specs/chatgpt-subscription-provider/spec.md:120` requires "A 401 still failing after the single refresh → HTTP 401 `authentication_error`, and the profile becomes `SESSION_EXPIRED`." Only the HTTP half existed. The second-401 branch (`host/agent/chatgpt/upstream-client.js:222-241`) said in as many words that the state was "deliberately NOT treated as a session expiry"; the advisory flags `authFailed`/`sessionExpired` from `upstream-errors.js:172-174` had no production consumer; `gateway.js:249-252` wrote the error and ignored them; the only producer of `recordChatgptSessionExpired` was `auth.js:723` (a refresh the token endpoint actually rejected). `host/test/chatgpt-gateway.test.mjs:500-517` asserted only status/type, so nothing caught it.

**Root cause.** The one case the spec attaches the transition to — a 401 answered to the retry that used a *freshly refreshed* token — was reported to the caller with flags that were indistinguishable from the token-acquisition failure `auth.js` has already recorded, so the caller could not act on it correctly. The fix makes the case explicit and gives it an owner:

- `host/agent/chatgpt/upstream-client.js` — the second-401 branch now returns `{ ...mapUpstreamError({httpStatus:401, body}), sessionExpiredAfterRefresh: true }`, and its (previously opposite) comment was rewritten to state the spec rule and why the marker must not be attached to a token-acquisition failure. The `sendCodexRequest` JSDoc documents the marker as the caller's one profile-state duty.
- `host/agent/chatgpt/upstream-errors.js` — the header's advisory-flags paragraph now spells out the two different duties behind a `sessionExpired` result (record it vs. already recorded by `auth.js`), matching the module's existing "the caller owns profile-state decisions" contract. No behaviour change in the module.
- `host/agent/chatgpt/gateway.js` — the factory takes an injectable `onSessionExpired` (default `recordChatgptSessionExpired`, the same real-implementation-default convention as `getAccessToken`/`loadProfile`; injectable like every other collaborator so tests never touch a real profile). `handleMessages` now awaits it when `result.error.sessionExpiredAfterRefresh` is set, *before* answering the client, and never lets a recorder failure swallow the 401. Because the recorder bumps `credentialRevision` and fires `onCredentialRevoked`, the companion's existing listener cancels the profile's runs and revokes its gateway tokens (`companion.js:1160-1174`), exactly as after a sign-out — and `snapshotForRun`/`testCapability` then refuse the profile with `SESSION_EXPIRED`, which is what the side panel's `deriveReadinessState()` already renders as "Phiên ChatGPT đã hết hạn" + re-sign-in.
- `host/agent/settings/profile.js` — `recordChatgptSessionExpired` is now idempotent: `signed_in → session_expired` is a state edge, and recording it twice is a no-op, so the many in-flight requests that can each hit a post-refresh 401 produce exactly ONE revision bump and ONE listener firing. The body has no `await` before its write, so the check-then-write is atomic in the event loop; a fresh sign-in sets `signed_in` again, so the next genuine expiry still transitions.

Not transitioned, by construction: a first 401 that succeeds after its refresh (that path returns the successful response), and a refresh the token endpoint rejected (that error carries no marker, and `auth.js` has already recorded it — a `NO_CREDENTIAL` profile must not be turned into an expired one).

**Tests added.** `host/test/chatgpt-gateway.test.mjs` (23/23): the retry-succeeds case now also asserts the hook is never called; a new case asserts a refresh-failure 401 never re-records; the double-401 case asserts the profile is recorded `SESSION_EXPIRED`, the record is for the request's own profile, exactly one transition happened, and the profile's gateway tokens are revoked (a follow-up request with the same token is refused and never reaches upstream); and a new end-to-end case runs the REAL `profile.js` recorder + `loadProfile` against a redirect-off profile ledger (`OCIC_AGENT_CONFIG_DIR`, never the production `default` profileId) through a real revocation listener — the profile reaches `chatgptSessionState:"session_expired"`, `hasCredential:false`, exactly one revision bump, one listener firing, `_tokenCount() === 0`, the already-issued token refused, and a subsequent sign-in-then-expiry transition again (not a latch). `host/test/settings-profile.test.mjs` (36/36) adds the concurrency proof at the layer that owns the edge: three overlapping `recordChatgptSessionExpired` calls bump the revision once and fire listeners once, plus an unknown-`profileId` no-op.

### Finding 2 (MAJOR) — the memory-only offer for the ChatGPT refresh credential

**What the verifier found.** `specs/agent-settings/spec.md:60` requires "If secure storage is unavailable, persistence SHALL fail explicitly and a clearly labeled memory-only mode SHALL be offered." The explicit failure worked; the offer was unreachable for ChatGPT: the extension sent only `{profileId}` (`settings-client.js:139`), the companion dropped any `memoryOnly` (`companion.js:1649`), the UI had no ChatGPT counterpart of the API-key path's `pendingMemoryOnlyOffer → confirmMemoryOnlyCredential` (`settings-app.js`), and `errors-ui.js:115-120`'s action text promised "lưu API key chỉ trong bộ nhớ" on a profile that has no API key. `auth.js:25-26,271-280` already supported `memoryOnly` end to end and was simply never asked.

**Fix, threaded exactly the way the API-key path already does it:**

- `extension/settings/settings-client.js` — `chatgptSignInStart`/`chatgptDeviceStart` accept an options object; the wire contract header documents `memoryOnly?` for both, and that it is sent ONLY for the user-confirmed retry (an ordinary sign-in's payload stays `{profileId}`).
- `host/agent/companion.js` — both ops validate `memoryOnly` as boolean-when-present (a non-boolean is a `PROTOCOL_ERROR` before `auth` is reached, fail-closed like the other field checks) and pass `memoryOnly: envelope.memoryOnly === true` into `auth.startBrowserSignIn`/`startDeviceSignIn`.
- `extension/settings/settings-controller.js` — a `SECURE_STORAGE_UNAVAILABLE` outcome observed by the sign-in poll sets a labeled offer (`pendingMemoryOnlyOffer: true`, `memoryOnlyOfferKind: "sign_in"`) and privately remembers which flow failed; `confirmMemoryOnlySignIn()` re-runs THAT flow with `memoryOnly: true` and returns the new `authUrl`/device code; `cancelMemoryOnlyOffer()` discards either kind of offer. The API-key offer now tags `memoryOnlyOfferKind: "credential"`, and stale offers are cleared on a successful save / credential removal. `describeErrorCode` is called with the failing op so the copy is provider-appropriate.
- `extension/settings/errors-ui.js` — `SECURE_STORAGE_UNAVAILABLE` has a ChatGPT variant (message names the ChatGPT credential, action offers memory-only *sign-in*, never an API key); the existing single-argument calls are unchanged.
- `extension/settings/settings-app.js` — the shared offer block is labeled and wired per kind ("Đăng nhập chỉ trong bộ nhớ" re-runs the sign-in and opens the new tab; "Lưu chỉ trong bộ nhớ" keeps the API-key behaviour), and the signed-in line names a memory-only session ("· chỉ trong bộ nhớ") so the non-persisted state is visible instead of indistinguishable from a stored one.

**Tests added.** `test/settings-ui-controller.test.mjs`: offer appears after the explicit failure with the sign-in kind and provider-appropriate banner (asserted to contain no API-key promise), confirm re-runs the browser flow with `memoryOnly:true` and returns a NEW authorize URL, offer clears, polling resumes, and the completed memory-only sign-in mirrors `memoryOnlyCredential:true`; a second block proves the DEVICE flow is retried (never falling back to the browser flow); a third proves cancelling discards the offer. `test/settings-ui-client.test.mjs`: both ops forward `memoryOnly:true` when asked (and the ordinary payload is unchanged). `test/settings-ui-scripted-companion.mjs`: the fixture records the option the same way the real client sends it. `host/test/agent-settings-relay.test.mjs` (25/25): the companion forwards `memoryOnly:true`, defaults it to `false` for an ordinary sign-in, keeps the reply shapes token-free, and rejects a non-boolean value as `PROTOCOL_ERROR` without ever calling auth. Auth-layer support (`memoryOnly → backend "memory"`) was already proven by `host/test/chatgpt-auth.test.mjs`; `host/test/settings-profile.test.mjs` proves `recordChatgptSignIn(..., backend:"memory") → memoryOnlyCredential:true`. The existing no-token-in-storage suites stayed green (below).

### Real-UI verification (browser, not a unit test)

The settings page (`extension/settings/settings.html`) was served statically and driven in a real Chromium tab with a `chrome.*` stub (settings page opened → `#btn-chatgpt-signin-browser` clicked → poll reported `SECURE_STORAGE_UNAVAILABLE`):

- the banner rendered the ChatGPT-specific copy and a labeled **"Đăng nhập chỉ trong bộ nhớ"** button (screenshot captured);
- the ordinary sign-in sent `{op:"chatgpt_sign_in_start", profileId:"default"}`; confirming the offer sent `{op:"chatgpt_sign_in_start", profileId:"default", memoryOnly:true}` and opened the NEW `authorize` URL in a tab, leaving the page in its pending state;
- a memory-only signed-in profile renders "Đã đăng nhập với probe@example.com (gói plus · chỉ trong bộ nhớ)."

### Runs (all exit 0 unless noted)

```
exit=0  host/test/chatgpt-gateway.test.mjs                   23/23 passed
exit=0  host/test/chatgpt-auth.test.mjs                      18/18 passed
exit=0  host/test/chatgpt-translate.test.mjs                 ALL CHATGPT TRANSLATE TESTS PASSED
exit=0  host/test/settings-profile.test.mjs                  36/36 passed
exit=0  host/test/settings-capability-test.test.mjs          14/14 passed
exit=0  host/test/agent-settings-relay.test.mjs              25/25 passed
exit=0  host/test/agent-companion-core.test.mjs              20/20 passed
exit=0  host/test/chatgpt-live.test.mjs                      skipped (OCIC_RUN_LIVE_CHATGPT_TESTS unset — unchanged)
exit=0  host/test/settings-all.test.mjs                      All settings/secrets suites passed.
exit=0  test/settings-ui-client.test.mjs                     ALL SETTINGS-UI CLIENT TESTS PASSED
exit=0  test/settings-ui-controller.test.mjs                 ALL SETTINGS-UI CONTROLLER TESTS PASSED
exit=0  test/settings-ui-secrets.test.mjs                    ALL SETTINGS-UI SECRET-ISOLATION TESTS PASSED
exit=0  test/settings-ui-no-conversation-leak.test.mjs       ALL SETTINGS-UI NO-CONVERSATION-LEAK TESTS PASSED
exit=0  test/settings-ui-real-companion.test.mjs             ALL SETTINGS-UI REAL-COMPANION INTEGRATION TESTS PASSED
exit=0  test/settings-ui-validation.test.mjs                 ALL SETTINGS-UI VALIDATION TESTS PASSED
exit=0  test/background-agent-settings-relay.test.mjs        ALL BACKGROUND AGENT-SETTINGS-RELAY TESTS PASSED
exit=0  test/background-agent-settings-profile-mirror.test.mjs ALL BACKGROUND PROFILE-MIRROR TESTS PASSED
exit=0  test/sidepanel-readiness-states.test.mjs             ALL SIDEPANEL READINESS-STATE TESTS PASSED
exit=0  test/extension-scripts-parse.test.mjs                8/8 passed
exit=0  test/extension-csp-no-inline-scripts.test.mjs        ALL EXTENSION CSP GUARD TESTS PASSED
```

Count deltas are additions only: gateway 21 → 23, profile 34 → 36, relay 23 → 25. No existing assertion was weakened, deleted or re-pinned. The three pre-existing extension-sweep failures recorded under Batch H (`overlay-background-bridge`, `overlay-pointer`, `side-panel-group-scope`) were not touched and were not re-attributed.

### Open items after this batch

- The extension's profile-cache mirror is refreshed on native connect and after settings ops (`extension/background.js:839-912`), so a gateway-recorded expiry reaches the side panel on the next panel/native reconnect or settings op. There is no push channel for it today and adding one was out of this brief's scope; the host-side state, the run cancellation and the token revocation all happen immediately.
- Deliberately scoped: the transition is recorded for the spec's case — a *401 response* to the retry that used a freshly refreshed token. A failure that arrives inside an already-200 upstream stream (`translate-stream.js`'s `error`/`response.failed` handling) is not an HTTP 401, involves no refresh retry, and was left exactly as it was; widening it would be new behaviour beyond both the spec bullet and this brief.
- `chatgpt-live.test.mjs`'s real-backend assertions remain unexecuted (no signed-in ChatGPT account in this environment), unchanged from Batch H.

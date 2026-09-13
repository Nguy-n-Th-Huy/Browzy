## 1. Profile provider type (`host/agent/settings/`)

- [x] 1.1 `profile-schema.js`: add `providerType` (`anthropic` | `chatgpt`, absent → `anthropic`) and non-secret `chatgptAccount` (`{email, planType}` | null); unknown `providerType` loads as not runnable (`INVALID_PROFILE`), never crashes
- [x] 1.2 `errors.js`: add `CALLBACK_PORT_IN_USE`, `SIGN_IN_TIMEOUT`, `SIGN_IN_CANCELLED`, `SIGN_IN_FAILED`, `SESSION_EXPIRED`, `SECRET_TOO_LARGE`, `USAGE_LIMIT_REACHED`, `UPSTREAM_REJECTED_CLIENT`
- [x] 1.3 `profile.js`: `setProviderType`, Codex model seed table by plan (applied only to an empty model list), discovery returns unsupported for `chatgpt`, capability-test key uses marker `chatgpt:codex` for `chatgpt` ← (verify: legacy profile file loads byte-for-byte equivalent as `anthropic`; all existing settings-profile tests still pass)

## 2. ChatGPT auth (`host/agent/chatgpt/auth.js`)

- [x] 2.1 PKCE (96-byte verifier, S256), state, authorize URL with exact params from spec; ID-token claim decoding for account id, email, plan
- [x] 2.2 Single-shot callback listener on `127.0.0.1:1455` (5-minute timeout, state check, HTML result page, close after one valid callback, `CALLBACK_PORT_IN_USE` on bind failure, cancel support; starting a new sign-in cancels the previous one for that profile)
- [x] 2.3 Code exchange and device-code flow (usercode, poll at server interval treating 403/404 as pending, 15-minute cap, exchange with device redirect URI)
- [x] 2.4 Credential store: secret `{"v":1,refresh_token,account_id}` at `browzy-in-chrome/chatgpt/<profileId>` via `secret-store.js` (memory-only rules unchanged, `SECRET_TOO_LARGE` instead of truncation); access/ID tokens memory only
- [x] 2.5 Refresh: when missing or expiring within 5 minutes and once after upstream 401; single-flight per profile; persist rotated refresh token before releasing access token; `invalid_grant`/`refresh_token_reused` → remove secret, bump credential revision, fire revocation listeners, `SESSION_EXPIRED`; sign-out clears memory, secret, gateway tokens, cancels runs ← (verify: rotation persisted before use, exactly one refresh under concurrency, no token string in any log or error message)

## 3. Translator (`host/agent/chatgpt/translate-request.js`, `translate-stream.js`)

- [x] 3.1 Request: system → developer message; text, base64/URL images, base64 PDF, tool_use, tool_result (text/image arrays, `is_error` → `Tool error:` lead), gateway-signed thinking → reasoning, cache_control stripped; unknown block → 400 naming the type
- [x] 3.2 Tools and controls: function tools `strict:false` minus `$schema`/`$id`, web-search server tool → `web_search`, deterministic ≤64-char name shortening with reverse map, tool_choice mapping, `parallel_tool_calls`, reasoning effort rules, `summary:"auto"`; allowlisted upstream body (`model`, `instructions:""`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store:false`, `stream:true`, `include`, `prompt_cache_key`) — nothing else forwarded
- [x] 3.3 Stream: Codex SSE → Anthropic SSE (`message_start`, thinking + `brzcx1.` signature, text, tool_use + `input_json_delta` with restored names, `message_delta` stop reason/usage incl. `cache_read_input_tokens`, `message_stop`, `error`); non-stream accumulator on the same state machine
- [x] 3.4 Error mapping per spec (401 after refresh, `usage_limit_reached` with `retry-after`, other 429, context length → `prompt is too long`, other 4xx, 5xx/capacity → 529, network → 502), including failures that arrive inside a 200 stream ← (verify: fixture round trip tool_use → tool_result with screenshot → reasoning replay matches spec scenarios)

## 4. Gateway (`host/agent/chatgpt/gateway.js`) and run wiring

- [x] 4.1 `node:http` server on `127.0.0.1`, `listen(0)`, lazy start, closed on companion exit; routes `/v1/messages` (stream/non-stream), `/v1/messages/count_tokens` (local estimate), `/v1/models`; 401/404 Anthropic error bodies
- [x] 4.2 Gateway tokens: 32-byte random, bound to `{profileId, model, credentialRevision, purpose}`, accepted via `x-api-key` or Bearer, model rewrite to bound model, revoked on run/test end, sign-out, credential revision change
- [x] 4.3 Upstream client: `POST https://chatgpt.com/backend-api/codex/responses` with spec headers (`originator: browzy`, Browzy User-Agent, `chatgpt-account-id`, `session_id`), SSE parsing, one refresh-and-retry on 401, request abort when the client disconnects or the run is cancelled
- [x] 4.4 `profile.js` `snapshotForRun` / `testCapability` / `isRunnable` for `chatgpt`: require signed-in state, issue gateway token, return gateway `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`; companion revokes the run token where run cleanup already happens; capability test reuses `runCapabilityTest` through a test-scoped token ← (verify: SDK env contains only the gateway URL/token, never ChatGPT tokens; Anthropic snapshot output unchanged)

## 5. Settings protocol and extension UI

- [x] 5.1 `profile-protocol.js` + companion `agent_settings` handling: `set_provider_type`, `chatgpt_sign_in_start`, `chatgpt_device_start`, `chatgpt_sign_in_status`, `chatgpt_sign_in_cancel`, `chatgpt_sign_out`; replies never contain tokens
- [x] 5.2 `extension/background.js` settings relay: allow exactly the new op names
- [x] 5.3 `extension/settings/settings-client.js`, `settings-controller.js`, `settings-app.js`, `settings.html`, `settings-validation.js`: provider type switch; for `chatgpt` hide Base URL/API key, show sign-in / use-a-code / sign-out, pending state with cancel, device code + verification link + expiry countdown, signed-in email and plan, `SESSION_EXPIRED` banner, disclosure text, usage-limit wording on the connection test; open `authUrl` with `chrome.tabs.create`; poll status every 1 s while pending and stop on leave
- [x] 5.4 `extension/settings/errors-ui.js`: user copy for every new error code; `PROTOCOL_ERROR` on the new ops shown as "update the companion"
- [x] 5.5 Side-panel readiness: `chatgpt` profile not signed in → "Sign in to ChatGPT" state linking to settings; `SESSION_EXPIRED` → "ChatGPT session expired" state; existing API-key states unchanged ← (verify: keyboard-operable controls with labels, focus moves to the device code when shown, no token in extension storage)

## 6. Tests

- [x] 6.1 `host/test/chatgpt-auth.test.mjs`: authorize URL params, PKCE challenge, state mismatch, port-in-use, timeout, cancel, code exchange (mock token server), device polling pending → success and timeout, refresh rotation order, single-flight, reused token → `SESSION_EXPIRED`, `SECRET_TOO_LARGE`, memory-only backend
- [x] 6.2 `host/test/chatgpt-translate.test.mjs`: every request mapping and rejection in the spec, name shortening round trip, effort rules, dropped sampling fields, stream fixtures for text/thinking/tool calls/incomplete/content filter/failed, non-stream parity, error mapping table
- [x] 6.3 `host/test/chatgpt-gateway.test.mjs` (mock upstream on loopback): missing/revoked token 401, unknown path 404, model rewrite, count_tokens local, 401 refresh-and-retry, usage limit 429 + `retry-after`, client disconnect aborts upstream, loopback-only bind
- [x] 6.4 Update `host/test/settings-profile.test.mjs`, `settings-capability-test.test.mjs`, `test/settings-ui-*.test.mjs`, `test/background-agent-settings-relay.test.mjs`, `test/sidepanel-readiness-states.test.mjs` for provider type, new ops and states; legacy-profile migration check
- [x] 6.5 Opt-in live test `host/test/chatgpt-live.test.mjs` gated by an env var (pattern of `settings-live.test.mjs`): real sign-in token from memory-only store, one streamed tool round trip with an image through the gateway; skipped by default
- [x] 6.6 Run the new tests, the touched existing tests, and `for t in test/*.test.mjs; do node "$t" || break; done`; report any failure in files outside this change without editing them ← (verify: all new and touched tests exit 0; live test documented as skipped unless env set)

## 7. Docs and attribution

- [x] 7.1 `NOTICE`: third-party section for CLIProxyAPI (commit `ac02da6`, copyright lines, MIT permission notice); header comment in each ported file
- [x] 7.2 `README.md` provider section and `docs/cai-dat.md`: ChatGPT sign-in steps, device-code fallback, usage-limit behaviour, disclosure about the unofficial backend and OpenAI terms, what is not supported (account pooling, other clients using the gateway)

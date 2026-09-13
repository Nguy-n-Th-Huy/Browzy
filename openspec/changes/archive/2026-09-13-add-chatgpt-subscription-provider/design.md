## Context

- **How runs get a provider today.** `host/agent/tools/query-options.js` builds an isolated SDK environment from `snapshotForRun()` in `host/agent/settings/profile.js`. That snapshot is `{ model, env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }, revision, credentialRevision }`, and the Agent SDK's Claude Code subprocess makes every model call against that Base URL. The connection test (`settings/capability-test.js`) and prompt enhancement (`enhance-prompt.js`) use the same snapshot/SDK path.
- **Where secrets live.** Secrets go through `host/agent/secrets/secret-store.js`: Windows Credential Manager, macOS Keychain, Linux Secret Service, or explicit memory-only.
- **How settings reach the host.** Settings ops travel `extension/settings/settings-client.js` → the background `agent_settings` relay → `settings/profile-protocol.js`.
- **Named profiles.** `settings/named-profiles.js` exists but is not on the run path (`resolveProfileSnapshot` imports `profile.js`).
- **URL rules.** `url.js` already allows plain HTTP only to loopback hosts.

Reference implementation: `router-for-me/CLIProxyAPI` @ `ac02da6` (MIT, Go).

| Area | Location |
|---|---|
| OAuth | `internal/auth/codex/*`, `sdk/auth/codex*.go` |
| Headers and body rules | `internal/runtime/executor/codex_executor_*.go` |
| Claude↔Codex translator | `internal/translator/codex/claude/*` |
| Error mapping | `codex_executor_terminal.go` |

Upstream facts relied on (researched 2026-09-13):
- **Client and redirect.** Codex public client id `app_EMoamEEZ73f0CkXaXp7hrann`, redirect URI `http://localhost:1455/auth/callback`.
- **Device flow.** `deviceauth/usercode` → `deviceauth/token` → token exchange with redirect `https://auth.openai.com/deviceauth/callback`.
- **Backend request.** `chatgpt.com/backend-api/codex/responses` requires `stream:true` and `store:false`, and rejects token-limit/sampling fields. Current CLIProxyAPI main sends `instructions:""` with the system prompt as a `developer` message.
- **Tool-result images.** `function_call_output.output` accepts `input_text`/`input_image` arrays.

## Goals / Non-Goals

**Goals:**
- A ChatGPT account becomes one more provider type behind the existing snapshot contract. The SDK, MCP tools, approvals, skills, transcripts and the Anthropic path stay untouched.
- Port CLIProxyAPI's proven wire behaviour, not its evasion features.
- Everything is testable offline with a mocked upstream and mocked auth server.

**Non-Goals:**
- Wiring `named-profiles.js` into runs.
- The standalone harness `extension/agent/`.
- The Codex WebSocket transport and `/responses/compact`.
- Image generation, and PDF/document types beyond base64 PDF.
- A Codex model listing endpoint.
- Proxying for any client other than this companion's own runs and tests.

## Decisions

### 1. Gateway in the companion, not a separate binary or SDK fork
The SDK only accepts an Anthropic endpoint, so translation must sit between the SDK subprocess and OpenAI.

An in-process `node:http` server on `127.0.0.1` with an OS-assigned port (`listen(0)`) lives and dies with the companion. Nothing is left orphaned and no fixed port can collide.

*Alternatives:*
- **External CLIProxyAPI.** Rejected by the user: extra install and process.
- **Patch the SDK or inject a custom fetch.** Not supported; the SDK spawns a CLI subprocess.

### 2. Per-run gateway tokens bound to profile + model
`snapshotForRun()` for a `chatgpt` profile issues `crypto.randomBytes(32)` base64url and registers `{ profileId, model, credentialRevision, purpose }`. It returns `ANTHROPIC_BASE_URL = http://127.0.0.1:<port>` and `ANTHROPIC_API_KEY = <token>`.

- **Release.** The companion revokes the token when the run settles (the same place run cleanup already happens). The capability test issues and revokes its own.
- **Why bind.** Binding stops another local process from spending the user's subscription through an open loopback port. It also makes credential removal cancel in-flight use: the revision check fails.
- **Model rewrite.** The request's model is replaced by the bound model, because Claude Code sends background calls with Claude model ids.
- **Alternative rejected:** one static gateway key. It would outlive runs and ignore credential revocation.

### 3. Auth module and secret shape
New `host/agent/chatgpt/auth.js`:
- PKCE/state generation: 96-byte verifier, S256.
- Authorize URL builder.
- A single-shot callback listener on `127.0.0.1:1455` with a 5-minute timeout and a minimal HTML result page.
- Code exchange.
- Device-code start and poll.
- Refresh with single-flight per profile.
- ID-token claim decoding. This is display and routing only, never trust; tokens come straight from the TLS token endpoint.

**Stored secret.** JSON `{"v":1,"refresh_token":…,"account_id":…}` under target `browzy-in-chrome/chatgpt/<profileId>`. Access tokens and ID tokens are large JWTs and would press against Windows Credential Manager's 2560-byte blob limit. They are short-lived and cheap to re-derive, so they stay in memory. A too-large secret fails with `SECRET_TOO_LARGE`, never truncated.

**Refresh.**
- Refresh when there is no access token or it expires within 5 minutes (`exp` claim), and once after an upstream 401.
- Persist the rotated refresh token *before* releasing the access token. A crash then never leaves a consumed refresh token on disk.
- `invalid_grant` or `refresh_token_reused` → `SESSION_EXPIRED` (secret removed, credential revision bumped, existing revocation listeners fire).

**Sign-in flow.** The browser sign-in is the default and device code is the fallback, matching Codex CLI. The companion never opens a browser itself: settings receives the URL and calls `chrome.tabs.create`. That keeps the flow inside the browser the user is signed in to.

### 4. Translator as pure modules
`host/agent/chatgpt/translate-request.js` (Anthropic body → Codex body plus name map) and `translate-stream.js` (Codex SSE events → Anthropic SSE events, with a non-stream accumulator built on the same state machine). No I/O, so fixtures drive tests.

**Reasoning signatures.** The format is `brzcx1.` + encrypted_content. Only signatures with that prefix are turned back into `reasoning` items, so a signature of another origin can never be sent upstream as if it were OpenAI's.

**Tool names.** Name shortening is deterministic per request: a name over 64 characters keeps its first 58 characters plus `_` and a 5-character hash, with collision suffixes. The reverse map lives in the request's stream state.

**Porting rules.** Logic is ported from CLIProxyAPI's `codex_claude_request.go` / `codex_claude_response.go` / `codex_executor_terminal.go`, with these deliberate differences:

| Difference | Reason |
|---|---|
| URL images are forwarded, not dropped | Responses accepts image URLs |
| Unknown block types → 400, not silently dropped | Fail loudly instead of losing content |
| `is_error` is preserved as a `Tool error:` prefix | CLIProxyAPI loses it |
| No `image_generation` tool injection | Never add tools the client did not request |
| No cloaking UA/originator, no uTLS | See decision 6 |

### 5. Profile schema and settings protocol
`profile-schema.js` gains `providerType` (default `anthropic` on load when absent), plus non-secret `chatgptAccount: { email, planType } | null`.

**Snapshot, test and discovery.**
- `snapshotForRun()`, `testCapability()`, `isRunnable()` and `refreshDiscoveredModels()` branch on `providerType`.
- The capability-test key for `chatgpt` uses baseUrl marker `chatgpt:codex` in place of the endpoint. A new sign-in bumps `credentialRevision`, which invalidates it naturally.
- Model seed lists live in one constant table keyed by plan (from CLIProxyAPI's registry snapshot) and are applied only when the model list is empty.

**New `agent_settings` ops.**

| Op | Returns |
|---|---|
| `set_provider_type` | |
| `chatgpt_sign_in_start` | `{ signInId, authUrl }` |
| `chatgpt_device_start` | `{ signInId, userCode, verificationUrl, expiresAt }` |
| `chatgpt_sign_in_status` | `pending`, `signed_in` with account, or `failed` with code |
| `chatgpt_sign_in_cancel` | |
| `chatgpt_sign_out` | |

**Transport.** Status is polled by the settings page (1-second interval while pending) rather than pushed. The existing relay is request/response only, and polling needs no new envelope type. The background relay allowlist gains exactly these op names.

### 6. Honest client identity, single account
Headers: `originator: browzy`, `User-Agent: browzy/<host package version> (<platform>)`. No TLS fingerprinting, no multi-account failover, no retry past `usage_limit_reached`.

- **Why.** The research found these are the behaviours most likely to count as circumventing OpenAI protections. The Codex public client id is still used because OpenAI offers no third-party registration; this is disclosed in settings.
- *Alternative:* impersonate `codex-tui` like CLIProxyAPI. Rejected, because it misrepresents the client.
- **Risk:** the backend could reject a non-Codex originator (see Risks).

### 7. Error codes
`settings/errors.js` adds:
- `CALLBACK_PORT_IN_USE`
- `SIGN_IN_TIMEOUT`
- `SIGN_IN_CANCELLED`
- `SIGN_IN_FAILED`
- `SESSION_EXPIRED`
- `SECRET_TOO_LARGE`
- `USAGE_LIMIT_REACHED`
- `UPSTREAM_REJECTED_CLIENT` (upstream 403 or 400 whose message mentions originator/client/instructions — surfaced verbatim so the user sees what the backend refused)

`extension/settings/errors-ui.js` gets matching copy. The gateway's HTTP mapping follows the spec. `prompt is too long` wording is used so the SDK's existing auto-compaction path triggers.

### 8. Attribution
Ported files carry a header naming CLIProxyAPI, its commit, and MIT. `NOTICE` gains a third-party section reproducing the CLIProxyAPI copyright line and MIT permission notice. Code comments state behaviour, never plan or task ids.

## Risks / Trade-offs

- **[Undocumented backend changes or blocks third-party use]** → All upstream knowledge is isolated in `host/agent/chatgpt/`. Errors surface verbatim as `UPSTREAM_REJECTED_CLIENT`, and the Anthropic path is unaffected. The settings disclosure says it may stop working.
- **[Backend rejects `originator: browzy` or empty `instructions`]** → The capability test detects it before any real run. Changing identity would be a user decision, not an automatic fallback.
- **[OpenAI terms / account action]** → Opt-in only, one account, no evasion, explicit disclosure. No claim of endorsement.
- **[Port 1455 held by Codex CLI's own login]** → `CALLBACK_PORT_IN_USE` → device-code path.
- **[Refresh token rotation race across two companion processes (two browsers)]** → Single-flight is per process only. A second process sees `refresh_token_reused` → `SESSION_EXPIRED` and asks for sign-in. This is accepted and documented; cross-process locking is out of scope.
- **[Full-history resend of screenshots each turn]** → Same cost profile as the Anthropic path; the SDK's own compaction applies.
- **[Claude Code sends request features the translator does not know]** (new block types or beta fields) → Unknown blocks fail with a named 400. Unknown top-level fields are dropped by an allowlist-based builder, never forwarded blindly.
- **[Model list drifts]** → Seeds are editable, and a wrong id fails the capability test with the upstream message.

## Migration Plan

1. **Additive and backward compatible.** Existing profiles load as `anthropic`. Nothing starts the gateway until a `chatgpt` profile runs or tests.
2. **Rollout.** Update the host package, then reload the extension. An old extension with a new host never sends the new ops. A new extension with an old host gets the relay's existing `PROTOCOL_ERROR` for unknown ops, which settings shows as "update the companion".
3. **Rollback.** Revert.
   - **Old code, `chatgpt` profile.** A `chatgpt` profile keeps a valid `baseUrl` field (left at its previous value) and its secret under a different target (`browzy-in-chrome/chatgpt/<profileId>`). Old code ignores the extra fields and reports `NO_CREDENTIAL`, never sending anything anywhere.
   - **New code, unknown `providerType`.** New code treats an unknown `providerType` as not runnable, with `INVALID_PROFILE`, and does not crash.

## Open Questions

- Whether the backend accepts `originator: browzy` and `instructions:""` today. This is answered by the opt-in live test at implementation time and does not change the design: rejection surfaces as `UPSTREAM_REJECTED_CLIENT`.

## Why

The side panel can only run against an Anthropic-compatible Base URL and API key, so a user whose paid model access is a ChatGPT subscription (Plus/Pro/Team, the plan Codex CLI signs in with) cannot use Browzy without also buying API credit somewhere else. The Claude Agent SDK that powers the panel speaks only the Anthropic Messages API, so supporting ChatGPT means signing in the way Codex CLI does and translating between the two wire protocols inside Browzy — the approach `router-for-me/CLIProxyAPI` (MIT) has proven in production, ported into the native companion so no extra binary has to be installed or run.

## What Changes

- A provider profile gains a provider type: `anthropic` (existing behaviour, the default for every existing profile) or `chatgpt`.
- Settings offers "Sign in with ChatGPT" for a `chatgpt` profile: a browser sign-in (PKCE, callback on `127.0.0.1:1455`) with a device-code alternative. It shows the signed-in account and plan, supports sign-out, and discloses that the connection uses the user's ChatGPT subscription through an unofficial backend under OpenAI's terms.
- The companion stores the ChatGPT refresh credential in the OS credential store (same isolation rules as API keys), keeps access tokens in memory only, refreshes them before expiry and once after an upstream 401, and persists every rotated refresh token.
- The companion runs a loopback-only gateway that serves the Anthropic Messages API (`/v1/messages` streaming and non-streaming, `/v1/messages/count_tokens`, `/v1/models`) and forwards to `https://chatgpt.com/backend-api/codex/responses`, translating requests, streamed responses, tools, images, reasoning and errors. Each run gets its own gateway token, bound to that run's profile and model, and revoked when the run ends or the credential is removed.
- A run on a `chatgpt` profile points the SDK's `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` at the gateway, so the SDK, tools, approvals and skills are unchanged.
- The existing capability test runs unchanged through the gateway; model discovery is unsupported for `chatgpt` profiles, which are seeded with the known Codex model ids for the signed-in plan and stay manually editable.
- Side-panel readiness distinguishes "sign in to ChatGPT" and "ChatGPT session expired" from "enter an API key".
- Deliberately NOT ported from CLIProxyAPI: client impersonation (forced Codex CLI user agent/originator), browser TLS fingerprinting, multi-account pooling/failover, identity obfuscation, and automatic image-generation tool injection.
- **BREAKING (spec-level)**: the `agent-settings` statement that every provider is Anthropic-compatible and that there is no OpenAI provider surface is replaced by the two provider types above. Anthropic-type profiles behave exactly as before.

## Capabilities

### New Capabilities

- `chatgpt-subscription-provider`: ChatGPT sign-in and token lifecycle, the loopback Anthropic-compatible gateway, Anthropic↔Codex translation, upstream error mapping, and the explicit list of excluded circumvention behaviours.

### Modified Capabilities

- `agent-settings`: provider profile gains a provider type and a ChatGPT sign-in surface in place of Base URL/API key; connection testing covers ChatGPT profiles; secret isolation extends to OAuth tokens; the no-Claude-account requirement is extended so ChatGPT sign-in is only ever an explicit user choice.

## Impact

- Host (`host/agent/`): new ChatGPT auth module (PKCE, device code, refresh, token store), new gateway + translator modules, `settings/profile.js` and `settings/profile-schema.js` (provider type, ChatGPT snapshot, model seeding, discovery gating), `settings/profile-protocol.js` and the companion's `agent_settings` handling (sign-in/out ops), `settings/errors.js` (new error codes), companion lifecycle (gateway start/stop, run-token revocation on credential removal).
- Extension: `extension/settings/` (provider type switch, sign-in UI, client ops, error copy), `extension/background.js` settings relay allowlist for the new ops, side-panel readiness copy/state.
- Tests: new host tests for auth, translator and gateway (mocked upstream, no network); updated settings/profile/readiness tests; an opt-in live test gated by an env var like `settings-live.test.mjs`.
- Docs: `README.md` provider section, `docs/cai-dat.md`, and `NOTICE` attribution for the ported CLIProxyAPI logic (MIT).
- Not changed: the Anthropic API-key path, the external MCP path, `host/agent/settings/named-profiles.js` (not wired into runs; stays Anthropic-only), the standalone harness `extension/agent/`.
- External dependencies: `auth.openai.com` OAuth/device endpoints and the undocumented `chatgpt.com/backend-api/codex` backend — both can change without notice.

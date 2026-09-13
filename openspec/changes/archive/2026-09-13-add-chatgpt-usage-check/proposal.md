## Why

A user running Browzy on a signed-in `chatgpt` profile has no way to see how much of their plan's quota is left. The only signal today is a failure after the limit is already reached (the gateway maps `usage_limit_reached` to a 429 with the reset time), so a user cannot tell whether a long conversation is about to be cut off, and cannot plan around a 5-hour or weekly window. The same account managers in the `router-for-me/CLIProxyAPI` ecosystem show this quota in real time, and the backend endpoint that feeds them is already reachable with the credential Browzy holds.

## What Changes

- A new host module `host/agent/chatgpt/usage.js` reads the signed-in account's usage from `GET https://chatgpt.com/backend-api/wham/usage` with the pair of headers the backend expects (`Authorization: Bearer <access token>`, `chatgpt-account-id`) and maps the reply onto a small, UI-shaped result: plan type, allowed/limit-reached flags, each present rate-limit window (`used_percent`, `limit_window_seconds`, `reset_after_seconds`, `reset_at`), and a credits summary when the account has one.
- It reuses the existing ChatGPT auth module for credentials — every call goes through `getAccessToken(profileId)` — and applies the same 401 rule the gateway already uses: refresh once (`forceRefresh: true`) and retry once; a 401 that survives that single refresh is the session-expiry signal, recorded through the same profile-state transition the gateway uses (`recordChatgptSessionExpired`).
- A new settings op `chatgpt_usage` (`{ profileId }`) carries the request through the existing `agent_settings` envelope and the extension relay allowlist; the reply is deliberately minimal (no `user_id`, `account_id`, email, or raw backend payload), and every failure comes back as a structured `{ok:false,error}` result rather than throwing into the protocol.
- The Settings page's ChatGPT section gains a usage block for a signed-in profile: plan, a percent-used bar/text and reset countdown per window present, a credits line when present, a clearly labeled refresh action, and loading / error / session-expired states built from the existing patterns and Vietnamese copy.
- No credential or access token ever leaves the host or appears in a reply, an error, or a log.

Explicitly out of scope: usage anywhere outside Settings (no side-panel badge), polling or notifications, multi-account support, and any change to the gateway, the translator, or the run path.

## Capabilities

### New Capabilities

None. The behaviour lands inside two existing capabilities.

### Modified Capabilities

- `chatgpt-subscription-provider`: adds an account-usage read for a signed-in profile — the endpoint and its required headers, what is rendered from the reply, the 401 refresh-once-then-session-expiry rule, and what may never leave the host.
- `agent-settings`: the ChatGPT section of Settings shows current usage and limits with an explicit refresh, and the new `chatgpt_usage` op joins the settings protocol on the same envelope, allowlist, and secret-isolation rules.

## Impact

- Host: new `host/agent/chatgpt/usage.js`; `host/agent/companion.js` (`_handleAgentSettings()` gains the `chatgpt_usage` case and the reply pass through the existing secret-free assertion); `host/agent/settings/errors.js` if a new code is needed.
- Extension: `extension/background.js` (settings relay allowlist), `extension/settings/settings-client.js` (one thin method), `extension/settings/settings-controller.js` / `settings-app.js` / `settings.html` (usage block, refresh, countdown, Vietnamese copy), `extension/settings/errors-ui.js` (error copy).
- Tests: new `host/test/chatgpt-usage.test.mjs`; additions to `host/test/agent-settings-relay.test.mjs`, `host/test/settings-capability-test.test.mjs`, `test/settings-ui-client.test.mjs`, `test/settings-ui-controller.test.mjs`, `test/background-agent-settings-relay.test.mjs`; the parse/CSP guards stay green.
- Docs: `README.md` ChatGPT section and `docs/cai-dat.md` state that Settings shows current usage/limits.
- External: one undocumented ChatGPT backend endpoint (`backend-api/wham/usage`) that can change without notice; failure is contained to the usage block.
- Not changed: the gateway, the translator, the run path, the credential store, `NOTICE` (CLIProxyAPI is already attributed).

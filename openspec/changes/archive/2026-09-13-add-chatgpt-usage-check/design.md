## Context

See proposal.md — Why. What shapes the approach:

- **Credentials already exist and are host-only.** `host/agent/chatgpt/auth.js` owns the ChatGPT refresh credential, holds access tokens in memory, and exposes `getAccessToken(profileId, { forceRefresh? }) -> { accessToken, accountId }`. Nothing outside the host ever sees a token.
- **The 401 rule already has a shape.** `host/agent/chatgpt/upstream-client.js` refreshes once and retries once on 401, and marks the one case the caller must record with `sessionExpiredAfterRefresh`; `host/agent/chatgpt/gateway.js` answers that marker by calling `onSessionExpired(profileId)` (default `settings/profile.js`'s `recordChatgptSessionExpired`). A refresh rejected as `invalid_grant`/`refresh_token_reused` is recorded by the auth module's own hook before it throws.
- **Host modules take injected collaborators.** `createChatgptAuth()` and `createGateway()` both build on `{ fetchImpl, getAccessToken, loadProfile, onSessionExpired, now, ... }` defaults over the real modules, which is what makes them testable with a mocked upstream and no network.
- **Settings ops are a closed set in three places.** `host/agent/companion.js`'s `_handleAgentSettings()` dispatches them and re-checks every ChatGPT reply through `_assertAgentSettingsResultSecretFree()`; `extension/background.js`'s `createAgentSettingsRelay()` allowlists op names (a missing entry fails locally with `PROTOCOL_ERROR`); `extension/settings/errors-ui.js`'s `CHATGPT_OPS` set decides whether that `PROTOCOL_ERROR` means "update the companion".
- **The settings page is a thin client + state machine + DOM layer.** `settings-client.js` sends one envelope per method, `settings-controller.js` holds all state and is driven deterministically in tests (injectable timers), `settings-app.js` renders state into `settings.html` (no inline scripts, no build step, Vietnamese copy, `aria-live` for progress).
- **Upstream facts (verified 2026-09-13 with a real free-plan account).** `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access token>` and `chatgpt-account-id: <account id>` only, answers `{ user_id, account_id, email, plan_type, rate_limit: { allowed, limit_reached, primary_window, secondary_window }, credits: {...}, spend_control, promo, ... }` where a window is `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }`. The free plan observed one primary window of 2592000 s (30 days) and `secondary_window: null`; paid plans are understood to report a 5-hour primary and a weekly secondary. `backend-api/codex/usage`, `backend-api/me` and `backend-api/wham/rate_limits` answer 403/404 and are not used. Reference implementation: `router-for-me/CLIProxyAPI` (MIT), whose account managers surface the same quota.

## Goals / Non-Goals

**Goals:**
- A signed-in `chatgpt` profile's usage is visible in Settings with one extra settings op, no change to the run path, and no new long-lived state.
- Everything is testable offline: a mocked fetch and a mocked auth module drive every branch, including the session-expiry one.

**Non-Goals:**
- Caching usage in the host, polling, notifications, or showing usage anywhere outside Settings.
- Changing the gateway, the translator, the credential store, or the profile schema (no new profile field — usage is not persisted).
- Rendering backend fields the settings page does not show.

## Decisions

### 1. A dedicated host module with injectable collaborators

New `host/agent/chatgpt/usage.js` exports `createUsageReader(options)` returning `{ readUsage(profileId) }`. Defaults are the real modules; tests inject everything:

| Option | Default | Purpose |
|---|---|---|
| `fetchImpl` | `globalThis.fetch` | the one network call |
| `getAccessToken` | `chatgpt/auth.js`'s | credentials and the refresh rule |
| `loadProfile` | `settings/profile.js`'s `loadProfile` | eligibility checked before any network call |
| `onSessionExpired` | `settings/profile.js`'s `recordChatgptSessionExpired` | the same transition the gateway records |
| `now` | `Date.now` | tests |
| `upstreamUrl` | `https://chatgpt.com/backend-api/wham/usage` | tests / future moves |
| `timeoutMs` | `15000` | bounds one read via `AbortSignal.timeout` |

`readUsage()` never throws for an ordinary failure. It resolves `{ ok: true, result }` or `{ ok: false, error: { code, message } }`, so the companion's op can answer in the same expression without a translation layer, and the `catch` in `_handleAgentSettings()` stays a safety net rather than the error path. The module header names CLIProxyAPI and its commit as the provenance of the endpoint knowledge, like `upstream-errors.js` already does.

*Alternatives:* a method on `gateway.js` (that module owns the run path and an open loopback server — this read has no relation to either); a method on `auth.js` (auth owns credentials, not account state); a generic `fetch` helper in `settings/` (the endpoint is ChatGPT-specific and belongs with the provider).

### 2. One GET, exactly the verified headers, windows rendered from the fields

The request is `GET <upstreamUrl>` with `Authorization: Bearer <accessToken>` and `chatgpt-account-id: <accountId>` — no other header is added, in particular no User-Agent or originator cloaking (spec: "No circumvention behaviours"). The body is parsed as JSON; a non-2xx status, a fetch rejection, a timeout, or a body without a `rate_limit` object becomes a structured failure (table below) and never a throw.

Window mapping is generic, never plan-specific:

| Backend | Result |
|---|---|
| `rate_limit.primary_window` / `secondary_window` | `primary` / `secondary`, each `{ usedPercent, limitWindowSeconds, resetAfterSeconds, resetAt }` or `null` |
| `reset_after_seconds` | seconds remaining, used by the UI for the live countdown |
| `reset_at` | normalized to epoch milliseconds when the value is a plausible epoch (seconds or ms) or an ISO-8601 string, otherwise `null` — the UI then shows the countdown only |
| `plan_type` | `planType` |
| `rate_limit.allowed` / `limit_reached` | `allowed` / `limitReached` (a missing value is treated as a failure, not as "allowed") |

The UI derives each window's label from `limitWindowSeconds` (300 min → "5 giờ", 604800 → "tuần", 2592000 → "30 ngày", otherwise a rounded hours/days label) and never assumes which window exists.

Error mapping (no new codes except the last row):

| Outcome | Code |
|---|---|
| profile not signed in / no credential | `NO_CREDENTIAL` (no request sent) |
| profile already `session_expired` | `SESSION_EXPIRED` (no request sent) |
| 401, retried with a forced refresh, then 200 | success |
| 401 after that single refresh | `SESSION_EXPIRED`, and `onSessionExpired(profileId)` is awaited first |
| refresh rejected (`invalid_grant` / reused token) | `SESSION_EXPIRED` (already recorded by `auth.js`) |
| 429 | `RATE_LIMIT_ERROR` |
| 403 | `AUTH_ERROR` |
| any other non-2xx | `NETWORK_ERROR` with the status in the message |
| fetch rejection / `AbortSignal.timeout` | `TIMEOUT_ERROR` / `NETWORK_ERROR` via the existing `classifyNetworkError` |
| 200 with a body that is not the expected shape | `USAGE_UNAVAILABLE` (new code) |

`USAGE_UNAVAILABLE` exists so a malformed body cannot borrow `PROTOCOL_ERROR` (which the settings page reads as "update the companion") or `NETWORK_ERROR` (which blames the network). It costs one entry in `PROVIDER_ERROR_CODES` and one Vietnamese copy pair.

*Alternative:* reuse `PROTOCOL_ERROR`. Rejected: the extension translates a `PROTOCOL_ERROR` on a ChatGPT op into "update the companion", which would be wrong and unactionable here.

### 3. Reply minimization

The op's result carries only what the page renders:

```json
{
  "planType": "plus",
  "allowed": true,
  "limitReached": false,
  "primary":  { "usedPercent": 3, "limitWindowSeconds": 2592000, "resetAfterSeconds": 1209600, "resetAt": 1767264000000 },
  "secondary": null,
  "credits": null
}
```

`credits` is `{ hasCredits, unlimited, balance }` **only when `hasCredits` is true**, otherwise `null`, because the credits line is rendered only for an account that has credits. Dropped on purpose: `user_id`, `account_id`, `email` (the page already shows the profile's own email/plan), `spend_control`, `promo`, `rate_limit_reset_credits`, `code_review_rate_limit`, `additional_rate_limits`, `model_usage`, `rate_limit_reached_type`, and every unrecognized key. The reply passes through the existing `_assertAgentSettingsResultSecretFree()` unchanged, which is the same fail-closed guard the other ChatGPT ops use.

*Why not the raw payload:* the extension never needs it, every extra field is a leak surface, and a narrower reply is the only shape a test can assert is minimal.

### 4. Session-expiry behavior: record the gateway's transition, then answer the caller

The read reuses the gateway's exact rule instead of inventing a second one:

1. `getAccessToken(profileId)` (no forced refresh) — a `NO_CREDENTIAL`/`SESSION_EXPIRED` throw becomes the caller's error code with no upstream request.
2. On a 401 answer, `getAccessToken(profileId, { forceRefresh: true })` once and retry the request once.
3. If the retry is 401 again, `await onSessionExpired(profileId)` — by default `recordChatgptSessionExpired`, the same transition `gateway.js` performs for `sessionExpiredAfterRefresh` (idempotent: it returns early when the state is already `session_expired`, so repeated failed reads cannot thrash the credential revision) — and answer `{ code: "SESSION_EXPIRED" }`.
4. A refresh that fails because the refresh token was rejected already recorded the transition inside `auth.js` before throwing, so this module only translates the throw; it never records twice.

*Alternatives:* returning a bare signal for the caller to act on (there is no such caller — the settings page has no profile-state authority, and duplicating the transition in the settings layer is exactly the drift the gateway's comment warns about); throwing `SESSION_EXPIRED` into the protocol (the companion's catch would answer `ok:false` anyway, but a module that returns results is testable without simulating the envelope, and the existing relay/companion error-shape rules stay in one place).

### 5. Protocol wiring: one op, three registration points

- `host/agent/companion.js`: `case "chatgpt_usage":` validates `profileId`, calls the lazily-resolved usage module the way the other ChatGPT ops resolve their collaborators (`_getChatgptUsageReader()`, injectable via constructor for tests), and answers `ok(...)` / `fail(code, message)` inside the existing envelope. The result is asserted secret-free like every other ChatGPT reply.
- `extension/background.js`: `chatgpt_usage` joins the relay's `ops` set. No mirror work: the op changes no profile field, so `applyProfileCacheWrite` is untouched.
- `extension/settings/settings-client.js`: one method `chatgptUsage: (profileId) => call("chatgpt_usage", { profileId })`, plus the wire-contract comment block that lists the op shapes.

The request payload is `{ profileId }` and nothing else; the extension never sends a token, and the reply never carries one.

### 6. UI: controller state, thin DOM render, no polling

- `settings-controller.js` gains `usage` state (`{ status: "idle" | "loading" | "ready" | "error", usage, error }`) and `refreshUsage()`. `init()`/`_applyProfile()` starts a read exactly when the profile is `chatgpt` and `signed_in`; it never runs for an `anthropic` profile, a signed-out profile, or a session-expired one. Each read is tagged with the profileId it was issued for so a response that lands after a profile switch is discarded — the same guard the capability-test result uses.
- The controller stores the reset moments as absolute milliseconds (`fetchedAt + resetAfterSeconds * 1000`, computed from its injectable `now`) so the countdown in the DOM layer needs no controller ticking and stays deterministic in tests.
- `settings-app.js` renders the block inside the existing `#chatgpt-fields` region: a percent-used line per present window with its countdown (updated by one `setInterval`, cleared when the block is hidden, mirroring the existing device-code countdown), the plan, a credits line only when present, a limit-reached line when `limitReached` is true, a refresh button labeled as such (`Làm mới`), and loading/error/`aria-live` text. Error copy comes from `errors-ui.js` by code; `USAGE_UNAVAILABLE` and the existing codes get Vietnamese copy, and `chatgpt_usage` joins the `CHATGPT_OPS` set so a stale companion reads as "update the companion".
- The block is read-only: no usage value is stored in the profile, in extension storage, or in a mirror.

### 7. Tests

- `host/test/chatgpt-usage.test.mjs` (new, mock fetch + mock auth): single-window mapping, both-window mapping, absent `reset_at`, missing `rate_limit` → `USAGE_UNAVAILABLE`, 401 → forced refresh → retry once (asserting exactly one refresh and that the retry used the fresh token), surviving 401 → `SESSION_EXPIRED` + one recorded transition, refresh rejection → `SESSION_EXPIRED` without a second transition, 429/403/5xx mapping, fetch rejection and `AbortSignal.timeout` mapping, no-credential and session-expired short-circuits that send nothing, and a leak guard: no `accessToken`, `account_id`, `user_id`, or email appears anywhere in the result or error objects.
- `host/test/agent-settings-relay.test.mjs` (additions): `chatgpt_usage` in the relay's allowlist family coverage, and the companion's reply shape for success and for a failure code.
- `host/test/settings-capability-test.test.mjs` / `settings-all.test.mjs`: confirm the existing suites stay green (this change adds no capability-test path).
- Extension: `test/settings-ui-client.test.mjs` (message shape), `test/settings-ui-controller.test.mjs` (load-then-read for a signed-in profile, no read for anthropic/signed-out/expired, refresh replaces values, error state keeps account and models, stale response for another profile discarded), `test/background-agent-settings-relay.test.mjs` (allowlist entry), `test/settings-ui-secrets.test.mjs` (no token or account id in any state/DOM the block produces), `test/extension-scripts-parse.test.mjs` and `test/extension-csp-no-inline-scripts.test.mjs` unchanged and green.

### 8. Docs

`README.md`'s "Run it on a ChatGPT subscription" section and `docs/cai-dat.md`'s ChatGPT section gain one paragraph: Settings shows the account's current usage and limits (percent per window with a reset countdown and a refresh action), the value comes from the same account the profile runs on, and reading it does not use the assistant's model quota. No `NOTICE` change (CLIProxyAPI is already attributed); only the new module's header names the ported knowledge.

## Risks / Trade-offs

- **[The endpoint is undocumented and can change or disappear]** → The read is one module behind one op; a change surfaces as a structured error inside the usage block and never affects runs. Detection: `USAGE_UNAVAILABLE`/`NETWORK_ERROR` copy in Settings, and the live opt-in test.
- **[Paid-plan window shapes are inferred, not observed]** → Mapping is generic over `primary`/`secondary` and never labels a window by plan; a plan with different or additional windows renders what exists and invents nothing.
- **[`reset_at` format unknown]** → Normalized defensively to epoch ms, and the countdown depends only on `reset_after_seconds`; an unusable `reset_at` renders the countdown alone rather than a wrong clock time.
- **[Each Settings load now makes one extra ChatGPT request]** → One request per page load or refresh activation, never on a timer, and it does not touch the model quota. If the endpoint ever rate-limits, the failure is user-visible and retryable, not silent.
- **[Session state changed by a read the user did not associate with a run]** → It is the same transition an expired gateway request makes, so the page's session-expired banner and the panel's agreement are preserved; a spurious expiry would still require two 401s (one after a fresh token), which is the same bar the gateway already applies.
- **[A user with two companion processes reads usage from both]** → Harmless: read-only, one request each, no credential rotation involved.

## Migration Plan

1. **Additive.** Nothing reads usage until the settings page asks; a `chatgpt` profile that never opens Settings behaves exactly as before. No profile field, no schema, no migration.
2. **Rollout.** Ship host + extension together (the repo has no independent release step): an old extension with a new host simply never sends the op; a new extension with an old host gets the relay's `PROTOCOL_ERROR` for an unknown op, which the `CHATGPT_OPS` entry turns into "update the companion".
3. **Rollback.** Revert. The new op is unknown to the old relay/host and fails closed; nothing was persisted, so there is no state to clean up.

## Open Questions

- Whether paid plans (or plan variants) report window shapes beyond the two observed fields — answered at runtime by rendering whatever is present; no spec or task depends on the answer.

# Implementation evidence

## Wave 1 (host) — usage reader, `USAGE_UNAVAILABLE`, `chatgpt_usage` op (tasks 1.1–1.6, 2.1, 2.2)

### Files changed

- `host/agent/chatgpt/usage.js` (new) — `createUsageReader({ fetchImpl, getAccessToken, loadProfile, onSessionExpired, now, upstreamUrl, timeoutMs }) -> { readUsage(profileId) }`; defaults wire `chatgpt/auth.js`'s `getAccessToken` and `settings/profile.js`'s `loadProfile`/`recordChatgptSessionExpired`, plus the verified endpoint (`DEFAULT_CHATGPT_USAGE_URL`). Header names `router-for-me/CLIProxyAPI @ ac02da6` as the provenance of the endpoint knowledge, like `upstream-errors.js`.
- `host/agent/settings/errors.js` — `USAGE_UNAVAILABLE` added to `PROVIDER_ERROR_CODES` with the one-line comment (a 200 usage body that is not the expected shape; distinct from `PROTOCOL_ERROR`, which the settings page reads as "update the companion").
- `host/agent/companion.js` — constructor option `chatgptUsageReader` + `_getChatgptUsageReader()` (lazy `import("./chatgpt/usage.js").then(mod => mod.createUsageReader())`, injected double wins) and `case "chatgpt_usage"` in `_handleAgentSettings()`: `profileId` validated (`PROTOCOL_ERROR` when missing), the reader's structured result forwarded as `ok(result)` / `fail(code, message)`, success through `_assertAgentSettingsResultSecretFree()`.
- `host/test/chatgpt-usage.test.mjs` (new) — 18 checks, mock fetch + mock auth.
- `host/test/agent-settings-relay.test.mjs` — `buildRealSettingsCore()` accepts `chatgptUsageReader`; 5 new `chatgpt_usage` checks (30 total).
- `openspec/changes/add-chatgpt-usage-check/tasks.md` — checked off 1.1–1.6, 2.1, 2.2.

### Decisions (beyond the plain task text)

- **Eligibility is `loadProfile()` + a profileId guard.** A stored profile whose `profileId` does not match the requested one is `NO_CREDENTIAL` (the profile store is a single file, so "no profile for this id" is the first-run outcome `get_profile` already treats as null) — a read can never be answered from another profile's record. Zero fetches, zero token resolutions on every short-circuit (`session_expired`, not `signed_in`, no `hasCredential`, mismatched id, or a `getAccessToken` that throws).
- **`reset_at` plausibility uses the injectable `now`.** Epoch-scale floors (1e9 s / 1e12 ms) tell seconds from milliseconds; a value more than two years from `now` is `null`, so the page falls back to the `resetAfterSeconds` countdown instead of rendering a wrong clock time. This is where the `now` option is consumed (the module needs no other clock).
- **A non-JSON 200 body and a body read that rejects are handled separately.** `res.text()` rejecting is a network-layer failure (`classifyNetworkError`); a `JSON.parse` failure is `USAGE_UNAVAILABLE`. A 200 body is only accepted when `rate_limit` is an object AND `allowed`/`limit_reached` are booleans — a missing flag is a failure, never an implied `allowed: true`.
- **The 401 rule is upstream-client.js's, verbatim.** One forced refresh, one retry. A refresh that fails is only translated (auth.js already recorded the transition through its own hook); a refresh that succeeds and a retry that is still 401 awaits `onSessionExpired(profileId)` exactly once before returning `SESSION_EXPIRED`. The recorder call is best-effort so a recorder failure cannot turn the read into a throw.
- **`readUsage()` has an outer safety net** so the "never throws" contract holds even for an unexpected exception (reported as a structured `NETWORK_ERROR`), matching the companion's outer-catch behaviour instead of propagating into the protocol.
- **The op does not re-project the result.** Minimality is enforced in the module (only the six reply keys are constructed); the companion forwards it unchanged through the secret-free scan. A reader result that *did* carry a token fails the scan closed (`PROTOCOL_ERROR`).

### Test output tails (exact)

```
$ node host/test/chatgpt-usage.test.mjs
...
  18/18 passed
EXIT=0
```

```
$ node host/test/agent-settings-relay.test.mjs
...
  PASS  chatgpt_usage forwards the reader's structured success result with ONLY the six documented keys
  PASS  chatgpt_usage answers a failing read as {ok:false,error:{code,message}} in the envelope — never a throw
  PASS  chatgpt_usage without a profileId is a PROTOCOL_ERROR before the reader is ever resolved
  PASS  a reader that THREW (its documented never-throw contract violated) still settles the envelope, not the protocol
  PASS  a usage result that DID carry a token field fails closed (secret-free scan) rather than emit it
  PASS  a start reply that DID carry a token field fails closed (secret-free scan) rather than emit it

  30/30 passed
EXIT=0
```

```
$ node host/test/settings-capability-test.test.mjs
...
  14/14 passed
EXIT=0
```

```
$ node host/test/settings-all.test.mjs
...
  4/4 passed
  All settings/secrets suites passed.
EXIT=0
```

```
$ node host/test/agent-companion-core.test.mjs
...
  20/20 passed
EXIT=0
```

### Unresolved items

- **`tasks.md` 2.2 says "the eight usage keys"; `design.md` decision 3 pins six** (`planType`, `allowed`, `limitReached`, `primary`, `secondary`, `credits`) — the same set the Wave 1 brief fixes. Implemented and asserted as exactly those six (the window sub-object keys are pinned too), so a future backend field cannot slip through. The "eight" is a wording slip in `tasks.md`, not a functional gap; nothing was added to satisfy it.
- **The "relay allowlist" half of 2.2 cannot be covered from the host.** `createAgentSettingsRelay()`'s `ops` set lives in `extension/background.js`; its coverage is Wave 2 task 3.2/3.4 (`test/background-agent-settings-relay.test.mjs`). Wave 1 proves the companion side of the family (seven ChatGPT ops, exact reply key set, structured failure shape).
- **The endpoint remains undocumented and unverified against a live account in this environment.** Every branch is driven by a mocked upstream; the live opt-in read is Wave 2 task 5.1.
- **Design.md prose says the reader resolves `{ ok: true, usage }`; the fixed Wave 1 contract (and therefore this implementation and the op) uses `{ ok: true, result }`.** Wave 2 must consume `result`.

## Wave 2 (extension) — wire, relay, Settings UI, live check, docs (tasks 3.1–3.4, 4.1–4.5, 5.1–5.3)

### Files changed

- `extension/settings/settings-client.js` — wire-contract block extended with the `chatgpt_usage` request/reply shape (six keys, window/credits sub-shapes, `resetAt` epoch-ms-or-null, "no account identity at all: no account id, no user id, no email"), plus `chatgptUsage: (profileId) => call("chatgpt_usage", { profileId })`.
- `extension/background.js` — `"chatgpt_usage"` added to `createAgentSettingsRelay()`'s `ops` set, with the note that it deliberately has no `applyProfileCacheWrite` branch (the op changes no profile field).
- `extension/settings/errors-ui.js` — `"chatgpt_usage"` added to `CHATGPT_OPS` (a stale companion's unknown-op `PROTOCOL_ERROR` reads as "Cần cập nhật companion", not as an endpoint incompatibility) and a new `USAGE_UNAVAILABLE` case (title/message/action matching the existing code-copy style, action naming the **Làm mới** button the block shows).
- `extension/settings/settings-controller.js` — `usage: { status, usage, error }` in the state snapshot; injectable `now`; `refreshUsage()` / `_readUsage()` / `_usageStale()` / `_withResetMoments()`; `_applyProfile()` starts exactly one read for a signed-in `chatgpt` profile (and clears the block for every other state); `init()` bumps the read tag so a late response cannot land.
- `extension/settings/settings-app.js` — the usage renderer: plan, one line per present window (label from `limitWindowSeconds`, percent, countdown from the stored absolute moment), credits only when present, limit-reached/not-allowed line, refresh button, loading/error copy from `errors-ui.js`; one `setInterval` for the whole block, cleared when the block hides and on `visibilitychange`/`pagehide`; refresh button + countdown wiring in `wireEvents()`.
- `extension/settings/settings.html` — usage block markup (`#chatgpt-usage-block` + its five child elements and `#btn-chatgpt-refresh-usage`) as a direct child of `#chatgpt-fields`, with page-local CSS; no inline script or inline handler.
- `test/settings-ui-client.test.mjs` — new block pinning the outgoing `{type, op:"chatgpt_usage", profileId}` shape (exactly three keys), the reply pass-through, and `USAGE_UNAVAILABLE` arriving as a typed `ProviderErrorLike`.
- `test/settings-ui-controller.test.mjs` — eight new blocks / 41 checks covering every task-4.4 case (see tails below).
- `test/settings-ui-scripted-companion.mjs` — `chatgptUsage` added to the fake client + scripts, reply shaped like the host's six-key result; header updated.
- `test/background-agent-settings-relay.test.mjs` — new "the ChatGPT account-usage read is allowlisted too" block (forwarded with its profileId, reply resolves back); the existing unlisted-op rejection case is untouched and still passes; the drift guard now reads 32 ops out of the shipped client sources.
- `test/settings-ui-secrets.test.mjs` — new runtime block: a load read + an explicit refresh, asserting no token-shaped field or `Bearer` value in any emitted snapshot, no `account_id`/`user_id`/`email` inside `state.usage`, and that every usage wire call is `{ op, profileId }` only.
- `host/test/chatgpt-live.test.mjs` — one opt-in live check: a real `chatgpt_usage` read through `CompanionCore.handleEnvelope()` with the production reader (no collaborator overrides), asserting the six-key result, a plan type, ≥1 window with a numeric percent, and no token/account-id/user-id/email anywhere in the reply; header's "what it proves" list and quota note updated.
- `README.md`, `docs/cai-dat.md` — one paragraph each ("Seeing current usage." / "Xem mức sử dụng hiện tại.").
- `openspec/changes/add-chatgpt-usage-check/tasks.md` — checked off 3.1–3.4, 4.1–4.5, 5.1–5.3; the 2.2 "eight usage keys" slip corrected to six with the key names spelled out.
- `openspec/changes/add-chatgpt-usage-check/design.md` — decision 1's `{ ok: true, usage }` slip corrected to `{ ok: true, result }`.

### Decisions (beyond the plain task text)

- **The block is visible only for `signed_in`.** It is a direct child of `#chatgpt-fields` (not nested in `#chatgpt-signed-in-info`) so it keeps the section's own spacing, and `renderChatgptUsage(state, visible)` is called with `showSignedIn` — the same expression that shows the account line. When the section itself is hidden (anthropic provider), `renderProvider()` calls `renderChatgptUsage(state, false)`, which empties the block as well as hiding it: leaving a previous profile's rows in the DOM would let the page's visibilitychange handler resume a countdown for values that are no longer displayed.
- **`chatgpt_usage` is de-duplicated only while the block is genuinely `loading`.** A read already in flight for the displayed profile is returned as-is (so a load read plus an immediate refresh cost one request), but once an outcome has landed a new call is a new read — that is what keeps the refresh button working after a failure instead of returning a settled promise.
- **A `SESSION_EXPIRED` read mirrors the page's own session-expired state.** The companion has already recorded the transition (Wave 1 rule), so the controller sets `chatgptSessionState = "session_expired"`, keeps `chatgptAccount`/`models` exactly as they were, and sets the usual `SESSION_EXPIRED` banner — the page then shows its existing "Đăng nhập lại" action rather than a usage block it can no longer read. Every other failure lands in `usage.error` only and deliberately leaves `state.banner` alone.
- **Absolute reset moments are computed in the controller, and only from `resetAfterSeconds`.** `_withResetMoments()` copies each window (never mutating the reply object) and adds a non-wire `resetAtMs` = `now() + resetAfterSeconds * 1000`; the backend's own `resetAt` is used only when a window has no relative value at all, so an unusable `resetAt` renders the percent without a countdown instead of a wrong clock time.
- **The countdown shows seconds under a minute.** `formatUsageDuration()` returns `N giây` (<60 s) so the countdown visibly ticks as a reset approaches (the coarser `N phút` label only changes once a minute — verified live, see below); minutes/hours/days/weeks otherwise, with whole-label Vietnamese phrasing and an explicit `đã đến hạn đặt lại` once the moment has passed.
- **The DOM layer resolves error copy itself.** `settings-app.js` imports `describeErrorCode` and calls it with `{ op: "chatgpt_usage" }`, so `PROTOCOL_ERROR` (stale companion) and the new `USAGE_UNAVAILABLE` render distinctly, and the copy lives in one place.
- **The live check asserts shape only and prints nothing from the reply.** Failure messages quote key names, never the reply, the plan, the numbers, the account id, or the email; the companion/protocol modules are imported *after* the signed-in-profile guard so an unset env var still means "no work, no network, no credential read".

### Test output tails (exact)

```
$ node test/settings-ui-client.test.mjs
== outgoing message shape: the ChatGPT account-usage read ==
  PASS one message per call
  PASS chatgptUsage sends { type: "agent_settings", op: "chatgpt_usage", profileId } — got {"type":"agent_settings","op":"chatgpt_usage","profileId":"default"}
  PASS and NOTHING else rides along (no token, no account id, no model id) — got ["type","op","profileId"]
  PASS the display-shaped reply passes through unwrapped and unmodified
  PASS USAGE_UNAVAILABLE arrives as a typed ProviderErrorLike with its code intact

ALL SETTINGS-UI CLIENT TESTS PASSED
EXIT=0
```

```
$ node test/settings-ui-controller.test.mjs
== ChatGPT usage: a signed-in profile reads once on load, with absolute reset moments ==
  PASS loading a signed-in chatgpt profile issues exactly one read, for its own profileId — got [{"op":"chatgpt_usage","profileId":"default"}]
  PASS the primary window's absolute reset moment is now + resetAfterSeconds, not the reply's own resetAt
  PASS the usage state carries no account identity (the reply never had one)
== ChatGPT usage: no read at all for an anthropic profile, a signed-out profile, or an expired session ==
  PASS an anthropic profile: loading it sends no chatgpt_usage request
  PASS a signed-out chatgpt profile: still zero chatgpt_usage requests after the refused refresh
  PASS a session-expired chatgpt profile: the usage block stays idle — nothing to show and nothing read
== ChatGPT usage: explicit refresh issues a second read and replaces the displayed values ==
  PASS it is a second, real read — never a cached value
  PASS a loading state was published, with the previous values cleared, before the reply landed
== ChatGPT usage: a failed read lands in usage.error and leaves the account, plan and models untouched ==
  PASS the signed-in account is untouched
  PASS the model list and its default are untouched
  PASS refresh stays available for another attempt
== ChatGPT usage: a read that discovers an expired session shows the page's own session-expired state ==
  PASS the page mirrors the transition the companion just recorded
  PASS the page's usual SESSION_EXPIRED banner (and its sign-in action) is what the user sees
  PASS and issues none (no read is ever sent for a session-expired profile)
== ChatGPT usage: a late response for a previous profile is discarded, never landed ==
  PASS the previous profile's late reply is discarded instead of landing on the new profile's page
== ChatGPT usage: nothing on a timer — a load read and an explicit refresh are the only reads ==
  PASS a signed-in profile's usage read registers NO interval (no polling, ever)
  PASS still no interval after a refresh
== ChatGPT usage: a companion that predates the op reads as 'update the companion', not as a network failure ==
  PASS chatgpt_usage is in CHATGPT_OPS, so an unknown op means "update the companion" — got {"title":"Cần cập nhật companion",...}
  PASS USAGE_UNAVAILABLE has its own actionable copy — got {"title":"Không đọc được mức sử dụng",...}

ALL SETTINGS-UI CONTROLLER TESTS PASSED
EXIT=0
```

```
$ node test/background-agent-settings-relay.test.mjs
== the ChatGPT account-usage read is allowlisted too ==
  PASS chatgpt_usage is forwarded with its profileId — got {"op":"chatgpt_usage","profileId":"default"}
  PASS the display-shaped reply resolves back to its caller
== drift guard: every op any shipped agent_settings client sends is allowlisted ==
  PASS the guard found the op strings in the shipped client sources (32 distinct ops) — a vacuous pass is impossible
  PASS every op sent by a shipped client is allowlisted — missing: (none)

ALL BACKGROUND AGENT-SETTINGS-RELAY TESTS PASSED
EXIT=0
```

```
$ node test/settings-ui-secrets.test.mjs
== runtime: the ChatGPT usage block carries no token and no account identity ==
  PASS no token field ever appears in an emitted state snapshot of the usage flow
  PASS no Bearer authorization value ever appears in a usage-flow snapshot
  PASS the usage block's own state carries no account id, user id, or email
  PASS the flow issued both a load read and an explicit refresh, so the scan covers real traffic (2/2)
  PASS every usage request is { op, profileId } ONLY — got [{"op":"chatgpt_usage","profileId":"default"},{"op":"chatgpt_usage","profileId":"default"}]

ALL SETTINGS-UI SECRET-ISOLATION TESTS PASSED
EXIT=0
```

```
$ node test/extension-scripts-parse.test.mjs
8/8 passed
EXIT=0
```

```
$ node test/extension-csp-no-inline-scripts.test.mjs
ALL EXTENSION CSP GUARD TESTS PASSED
EXIT=0
```

```
$ node test/settings-ui-validation.test.mjs
ALL SETTINGS-UI VALIDATION TESTS PASSED
EXIT=0
```

```
$ node test/settings-ui-no-conversation-leak.test.mjs
ALL SETTINGS-UI NO-CONVERSATION-LEAK TESTS PASSED
EXIT=0
```

```
$ node test/sidepanel-readiness-states.test.mjs
ALL SIDEPANEL READINESS-STATE TESTS PASSED
EXIT=0
```

Live-test skip proof (the only run performed here — no signed-in account in this environment):

```
$ node host/test/chatgpt-live.test.mjs
chatgpt-live.test.mjs: skipped (set OCIC_RUN_LIVE_CHATGPT_TESTS=1 with a signed-in chatgpt profile already configured to run this)
EXIT=0
```

Module-parse check for the settings modules the derived parse list does not cover (they are extension-page modules, not manifest content scripts), run with the same `node --check`-on-a-`.mjs`-copy technique the parse guard uses:

```
settings-app.js parses as a module
settings-controller.js parses as a module
errors-ui.js parses as a module
settings-client.js parses as a module
```

### Real-browser verification of the block (task 4.2/4.3)

`extension/` was served over a throwaway local static server and the REAL `settings.html` + `settings-app.js` were loaded in Playwright Chromium (`browser.open` → `tab.run`), then driven through `window.__settingsDebug` with a stubbed client — the block rendered and behaved as designed:

```
signed-in, two windows:
  "Mức sử dụng của tài khoản / Làm mới / Gói: plus /
   Cửa sổ 5 giờ — đã dùng 3% · đặt lại sau 1 giờ /
   Cửa sổ 1 tuần — đã dùng 41.3% · đặt lại sau 1 ngày 1 giờ"
limit reached + credits:
  "Gói: pro / Cửa sổ 5 giờ — đã dùng 100% · đặt lại sau 4 phút /
   Credits: 12.5. /
   Tài khoản đã đạt giới hạn sử dụng — mốc đặt lại ở trên cho biết khi nào dùng lại được."
live countdown (resetAfterSeconds = 6): " · đặt lại sau 6 giây" → 5 → 4 → 3 (one interval)
interval lifecycle: shown {created:1, cleared:0, blockHidden:false, rows:1};
  switch to anthropic {created:1, cleared:1, blockHidden:true, rows:0, sectionHidden:true};
  switch back {created:2, cleared:1, blockHidden:false, rows:1}
```

An unpacked-extension launch in headless Chrome was attempted first and refused to load the extension (`ERR_BLOCKED_BY_CLIENT` on the `chrome-extension://` URL), so that run does not cover the extension URL scheme/manifest path — the CSP/parse guards above do. Every throwaway artifact (static server, smoke scripts, Chrome profile, tab) was removed after use.

Also smoke-tested offline (throwaway script, removed): the live check's exact `CompanionCore` construction + envelope, with an injected fake reader — 10/10 PASS, including "the result carries the six documented keys" and "no identity field in the reply" — so the live check's plumbing is correct before the opt-in run.

### Wording slips corrected (both noted by Wave 1)

- `tasks.md` 2.2 said "the eight usage keys": corrected to six, naming `planType`, `allowed`, `limitReached`, `primary`, `secondary`, `credits`. Wave 1's implementation and both key-set assertions were already six; nothing was added.
- `design.md` decision 1 prose said the reader resolves `{ ok: true, usage }`: corrected to `{ ok: true, result }`, matching the shipped contract, the companion op, `settings-client.js`'s wire block, and every extension test added here (all consume `result` / `res.result`).

### Unresolved items

- **The live usage read has not been executed in this environment** (no signed-in `chatgpt` profile here). Task 5.1 is complete as code + assertions and its plumbing is smoke-tested offline; the actual live PASS still requires `OCIC_RUN_LIVE_CHATGPT_TESTS=1` on a machine with a signed-in profile.
- **No single test spans "real extension relay object → real host companion"** for this op. That is the same posture as every pre-existing `agent_settings` op: the relay side is exercised against a scripted fake companion (`test/background-agent-settings-relay.test.mjs`), the companion side against the real `CompanionCore` (`host/test/agent-settings-relay.test.mjs`), and the two are held together by the drift guard reading the real op strings out of the shipped clients. Only the live opt-in run exercises both ends plus the backend at once.
- **`resetAtMs` is extension-state only, never wire state.** The six-key reply is unchanged; the controller adds that one derived key inside each window so the DOM layer counts down without controller ticking. If a future consumer expects `state.usage.usage` to be byte-identical to the reply, that key is the difference.
- **`USAGE_UNAVAILABLE` copy is asserted through `describeErrorCode()` directly** (there is no dedicated errors-ui test file in this suite); the copy is also rendered in the browser run above.

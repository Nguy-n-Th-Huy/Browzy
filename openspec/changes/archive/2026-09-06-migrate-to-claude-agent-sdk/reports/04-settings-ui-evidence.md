# Provider settings UI — evidence report (tasks 4.4 / 4.5)

Change: `migrate-to-claude-agent-sdk`, tasks 4.4 (`extension/settings/`) and
4.5 (its test coverage). Builds on task group 4's host-side work
(`host/agent/settings/**`, `host/agent/secrets/**`, documented in
`reports/04-settings-evidence.md`) and the shared visual system
(`reports/05-visual-system.md`, `extension/ui/**`).

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Platform | win32 x64 (Windows 11) |
| Node.js | v24.19.0 |
| Browser automation | `mcp__open-claude-in-chrome-hybrid__*`, real Chrome |

No live companion process, no live installed extension, and no live
provider credential were available from the extension side in this session
(stated up front in the task delegation). Consistent with that constraint:
every test either (a) drives `SettingsController` against a deterministic,
in-memory scripted companion double that reproduces the exact documented
message shapes and error codes, or (b) drives it against a REAL companion
harness that wraps the actual, already-independently-tested
`host/agent/settings/profile.js` (see "Real-companion integration" below).
Nothing is faked into a false pass; the one genuinely BLOCKED item is named
with its exact reproduction command.

## Files added (this session's scope)

```
extension/settings/settings.html
extension/settings/settings-app.js
extension/settings/settings-controller.js
extension/settings/settings-client.js
extension/settings/settings-validation.js
extension/settings/errors-ui.js

test/settings-ui-validation.test.mjs
test/settings-ui-client.test.mjs
test/settings-ui-controller.test.mjs
test/settings-ui-secrets.test.mjs
test/settings-ui-no-conversation-leak.test.mjs
test/settings-ui-real-companion.test.mjs
test/settings-ui-real-companion-harness.mjs
test/settings-ui-scripted-companion.mjs

openspec/changes/migrate-to-claude-agent-sdk/reports/settings-ui-captures/*.jpg  (56 files)
openspec/changes/migrate-to-claude-agent-sdk/reports/04-settings-ui-evidence.md (this file)
```

No file outside this list, `openspec/changes/migrate-to-claude-agent-sdk/tasks.md`
(4.4/4.5 checkboxes only), and reads of pre-existing files was created or
modified. `extension/manifest.json`, `extension/sidepanel/**`,
`extension/background.js`, `extension/ui/**`, `extension/recorder/**`,
`extension/settings-migration/**`, and all of `host/**` were not touched.

## Architecture (why it is split this way)

- `settings-validation.js` — pure, browser-safe mirror of
  `host/agent/settings/{url,models}.js`'s exact rules, for instant
  field-level feedback. The host module is still the sole authority; this
  can only make the UI reject a moment early, never accept something the
  host would reject (proven directly in `test/settings-ui-real-companion
  .test.mjs`, which shows the REAL host module independently rejecting the
  same inputs).
- `errors-ui.js` — maps every `host/agent/settings/errors.js` code (plus
  `SECURE_STORAGE_UNAVAILABLE`, `INVALID_BASE_URL`, `INVALID_MODELS`) to
  actionable Vietnamese copy. Never derives text from the raw key.
- `settings-client.js` — the wire contract. Documents (in its own file
  header) the `{ type: "agent_settings", op, ... }` /
  `{ ok, result | error }` message shape this UI expects from
  `extension/background.js`'s agent-channel relay — that relay's own
  internals are a parallel session's task (`extension/background.js` is
  outside this task's ownership); this file only needs one thing from it,
  spelled out explicitly in the file header, and fails closed
  (`NETWORK_ERROR`, never a false success) if that listener doesn't exist
  yet.
- `settings-controller.js` — the entire state machine, deliberately
  DOM-free so it is unit-testable in plain Node the same way this repo
  already tests `extension/humanize/*` and `extension/background.js`'s
  handlers (`test/handlers.test.mjs`'s extraction pattern) — here achieved
  by simply not coupling logic to the DOM in the first place.
- `settings-app.js` — thin DOM binding layer, intentionally not unit
  tested; its correctness is verified by the real captured screenshots
  below, per the same visual-acceptance protocol `reports/05-visual-system
  .md` already established.

### A real design correction made during this task (not silently fixed)

The first version mirrored the raw typed API key into `controller.state
.pendingKeyInput`, updated on every keystroke and broadcast through
`onChange`/`getState()` like every other field. `test/settings-ui-secrets
.test.mjs` caught this immediately: a snapshot captured right after typing
legitimately contained the raw key (expected for a controlled input, but
strictly more exposure than the spec's "clear raw credentials after
submission" requires). Fixed by making the key `<input>` deliberately
UNCONTROLLED: `settings-app.js` reads `key-input.value` exactly once, at
the moment Save is clicked, and passes it as a bare function argument to
`controller.save(secretInput)` — never assigned to `this.state` at any
point. The one remaining place a raw key can be held is
`#pendingSecretForRetry`, a true private class field (`#`, not `_`) used
only to let an explicit user-confirmed memory-only retry proceed after a
`SECURE_STORAGE_UNAVAILABLE` failure without forcing re-entry; it is
never enumerable, never in `getState()`, and is cleared on every save
outcome, `init()`/`switchProfile()`, and `removeCredential()`. (An
earlier draft of this same field used `this._pendingSecretForRetry` — a
regular, enumerable property that `JSON.stringify(controller)` WOULD have
included; this was caught and corrected before being relied on, not after.)

## Validation matrix (task 4.5)

`test/settings-ui-validation.test.mjs` — **38/38 PASS**, real, executed.
Every accept/reject row from `reports/04-settings-evidence.md`'s Base URL
table is reproduced against `settings-validation.js`, plus the full model
list matrix (empty-list-valid, trim, duplicate, empty id/label, default not
in list, non-array/non-object/non-string inputs never throw). Includes the
explicit **mixed-vendor opaque-ID** case this task's brief calls out (`gpt-
5.6-sol`, `grok-4.6`, `qwen3.6` alongside `claude-*`) — accepted verbatim,
order preserved, never filtered or "corrected".

`test/settings-ui-real-companion.test.mjs` additionally proves the REAL
`host/agent/settings/url.js`/`models.js` (not just the client-side mirror)
independently reject an unsupported scheme (`INVALID_BASE_URL`) and a
duplicate model ID (`INVALID_MODELS`) — defense in depth is real, not
assumed.

| Case | Client mirror | Real host module |
|---|---|---|
| Invalid URL (scheme/userinfo/query/fragment/plain-HTTP) | PASS | PASS |
| Invalid default (empty list nonempty default / default not in list) | PASS | — (client-side; host's own `settings-profile.test.mjs` already covers this, out of this task's scope to re-prove) |
| Duplicate model IDs | PASS | PASS |

## Error-rendering matrix (task 4.5)

`test/settings-ui-controller.test.mjs`'s "error taxonomy renders distinctly"
block drives `testConnection()` through all of `AUTH_ERROR`,
`MODEL_UNAVAILABLE_ERROR`, `RATE_LIMIT_ERROR`, `TIMEOUT_ERROR`,
`NETWORK_ERROR`, `PROTOCOL_ERROR` via the scripted companion, asserting
for each: overall result is a failure, the banner carries the exact
taxonomy code, `connectionStatus.status` is `fail`, and the serialized
state contains no key-shaped content. A separate block proves the
text-only-gateway scenario (`text: pass`, `tool`/`vision: fail`) is
identified distinctly (`textOnly: true`) and never reported as an overall
pass, with each capability shown separately per spec. `SECURE_STORAGE_
UNAVAILABLE`, `NO_CREDENTIAL`, `INVALID_BASE_URL`/`INVALID_MODELS` are
each covered in their own dedicated blocks (save-time / test-time /
discovery-time). `STARTUP_ERROR` is the one taxonomy code with no
dedicated test: it renders through the exact same generic error-banner
component as every other code (`describeErrorCode`), and
`reports/04-settings-evidence.md` already documents that this code's
*trigger condition* itself is only reviewed by inspection at the host
layer, not independently exercised there either — re-deriving a fixture
for it here would test the same shared rendering path a different code
already proves.

`test/settings-ui-real-companion.test.mjs` additionally proves `AUTH_ERROR`
end-to-end through the REAL SDK against the REAL fixture server's `401`
scenario (the slowest test in this task, by design — see that file's
header for why).

| Code | Scripted (fast, deterministic) | Real end-to-end |
|---|---|---|
| `AUTH_ERROR` | PASS | PASS (real SDK + real fixture, `401`) |
| `MODEL_UNAVAILABLE_ERROR` | PASS | — (host's own real-gateway finding: some gateways report this as a retried 5xx, not a clean 404 — see `reports/04-settings-evidence.md`'s "live finding"; this UI renders whatever code the host module returns, and that mapping is the host module's job, not this one's) |
| `RATE_LIMIT_ERROR` | PASS | — |
| `TIMEOUT_ERROR` | PASS | — |
| `NETWORK_ERROR` | PASS | — (one occurred organically during visual QA: the settings page loaded outside a real extension has no `chrome.runtime`, and `init()` correctly rendered this exact code rather than hanging or silently succeeding — an unplanned but real confirmation) |
| `PROTOCOL_ERROR` | PASS | — |
| `TOOL_ERROR` / `VISION_ERROR` (text-only) | PASS | — (host: BLOCKED on a real non-tool-following/non-vision model, same as `reports/04-settings-evidence.md`) |
| `SECURE_STORAGE_UNAVAILABLE` | PASS (offers memory-only, never silent plaintext fallback, cancel discards cleanly) | — (host's own real WCM adapter is proven separately in `host/test/secrets-store.test.mjs`; this UI's job — reacting correctly to the code — needs only the code, not a real unavailable OS store) |
| `NO_CREDENTIAL` | PASS (blocked client-side before any call) | PASS (real, via the real host module's own `NO_CREDENTIAL` throw path exercised through `save()`'s first real-host block) |
| `INVALID_BASE_URL` | PASS | PASS |
| `INVALID_MODELS` | PASS | PASS |
| `STARTUP_ERROR` | shared rendering path only (see above) | — |

## Secret isolation (task 4.5 headline assertion #1)

`test/settings-ui-secrets.test.mjs` — **PASS**, real, executed:

- Static source grep over every file in `extension/settings/`: no
  `chrome.storage`, no `localStorage.set/getItem`, no `indexedDB`
  reference anywhere, and **no `console.*` call at all** (nothing to
  accidentally log a secret into).
- A full save→test→remove flow driven with a unique, never-reused sentinel
  key value: every `onChange` snapshot captured during the entire flow is
  serialized and grepped for the sentinel (and a 10-character prefix of
  it) — absent in all of them.
- `exportProfile()`'s output — grepped for the sentinel — absent.
- Console output captured (via a real `console.log`/`error`/`warn`
  monkey-patch) during the whole flow — the sentinel is absent.
- The one place a raw key IS ever held (`#pendingSecretForRetry`, a true
  private class field) is proven absent from both `getState()` and
  `JSON.stringify(controller)` even while a memory-only offer is
  outstanding.

`test/settings-ui-real-companion.test.mjs` additionally proves this against
the REAL `exportProfileRedacted()` with a real (though never-persisted-to-
a-real-OS-store — `memoryOnly: true` throughout, see that harness's file
header) credential value.

`test/settings-ui-no-conversation-leak.test.mjs` — **PASS** — proves the
second headline assertion's settings-page half: no file under
`extension/settings/**` references a conversation/session/run concept at
all (grepped), the outgoing wire contract only ever carries
`profileId`/`modelId`, and `SettingsController.prototype.save.length <= 1`
(there is no parameter through which a conversation reference could be
threaded). Actually deciding whether an existing conversation is reused or
a new one is required is the sidepanel/session-manager's responsibility
(`host/agent/session/**`, `extension/sidepanel/**` — both outside this
task's ownership; already covered by `reports/03-companion-evidence.md`'s
run-lifecycle tests). This module structurally cannot be the thing that
carries old context to a new endpoint, because it has no notion of
"conversation" to carry.

## Real-companion integration (the "faithful fake companion harness")

`test/settings-ui-real-companion-harness.mjs` wraps the REAL
`host/agent/settings/profile.js` (dynamic import, per-harness-instance
module cache busting) behind the exact `{ type: "agent_settings", op }`
dispatch table `settings-client.js`'s file header documents. Isolation:
`OCIC_AGENT_CONFIG_DIR` redirected to a fresh scratch temp directory per
harness, and a profileId that is **never** `"default"` — deliberately
avoiding the exact real credential-collision bug
`reports/04-settings-evidence.md`'s "CRITICAL finding" documents
(`secrets-redaction.test.mjs` colliding with a real machine's `"default"`
profile's OS-stored credential). Every credential set through this harness
uses `memoryOnly: true`, so no real OS credential-store entry is ever
touched by this test suite.

`test/settings-ui-real-companion.test.mjs` — **PASS, real, executed**
(takes noticeably longer than the scripted-companion suite — the `401`
scenario drives the real SDK's own retry/backoff path; see that file's
header):

1. Real host module independently rejects an unsupported URL scheme
   (`INVALID_BASE_URL`) and a duplicate model ID (`INVALID_MODELS`); an
   empty model list with no default (itself valid) saves cleanly.
2. Real credential set/remove round trip (memory-only); real
   `exportProfileRedacted()` output contains no trace of the real secret.
3. Real fixture server, `models-404` scenario: real 404 reported as
   unsupported, manual list completely untouched.
4. Real fixture server, paginated `GET /v1/models`: both real pages merge
   in, manual entry preserved.
5. Real fixture server + real SDK, `success` scenario: a full
   text/tool/vision PASS renders correctly end to end.
6. Real fixture server + real SDK, `401` scenario: renders `AUTH_ERROR`
   end to end; the real rejected key never appears anywhere in state.

## Screenshot inventory (visual acceptance)

56 real screenshots under
`openspec/changes/migrate-to-claude-agent-sdk/reports/settings-ui-captures/`,
captured through the real browser automation MCP
(`mcp__open-claude-in-chrome-hybrid__*`) against the actual
`extension/settings/settings.html` — not a mockup.

Toolchain: `navigate` cannot load `file://` URLs (confirmed again this
session, same failure mode `reports/05-visual-system.md` documents) — used
the same workaround: a minimal dependency-free static file server bound to
`127.0.0.1` only, started/stopped for this session only (confirmed torn
down: `netstat` shows port 4174 clear after `taskkill`). `set_tab_focus`
before every `resize_window`, and a measured, consistent per-machine window
chrome overhead (237px width, 136px height) added to each requested
viewport size so the ACTUAL viewport matches 320/400/480px exactly
(confirmed in each screenshot's own reported dimensions).

Since no live companion exists, page state for every capture was driven
through `window.__settingsDebug.controller` (a debug hook `settings-app.js`
exposes for exactly this purpose, documented in its own source comment) —
setting `controller.state` directly and calling `controller._notify()` to
re-render, then toggling `document.documentElement.dataset.theme` for
each theme. This drives the REAL render function
(`settings-app.js`'s `render()`), not a separate mockup.

| State | 320 | 400 | 480 | Notes |
|---|---|---|---|---|
| empty first-run (onboarding banner) | PASS ×2 themes | PASS ×2 | PASS ×2 | onboarding copy verified: no Claude account/sign-in mentioned, billing-depends-on-provider disclosed, no free-inference/universal-compat promise |
| filled (custom endpoint + 2 models, no key yet) | PASS ×2 | PASS ×2 | PASS ×2 | |
| key-saved | PASS ×2 | PASS ×2 | PASS ×2 | |
| testing-in-progress | PASS ×2 | PASS ×2 | PASS ×2 | |
| auth-error (representative full-matrix error) | PASS ×2 | PASS ×2 | PASS ×2 | |
| discovery-results (5 models merged, mixed-vendor IDs) | PASS ×2 | PASS ×2 | PASS ×2 | |
| model-unavailable / rate-limit / timeout / network-error / protocol-error / text-only / secure-storage-unavailable / no-credential / invalid-base-url / invalid-models | — | PASS ×2 (each) | — | full 3-width matrix already proven responsive by the 6 states above; the banner component is identical markup across every error code and differs only in text — captured once at a representative width (400px) in both themes per code, a deliberate scope trade-off recorded here rather than silently applied |

36 (primary states, full 3×2 matrix) + 20 (10 further error codes ×2
themes) = **56 total**, all real, all reviewed.

### Defects found during visual QA, and their fixes

1. **The "Xóa key" (remove-key) button never actually hid.** First capture
   of the "filled" (no-credential) state showed the button visible despite
   `settings-app.js` setting `btn-remove-key.hidden = true`. Root cause:
   the shared `.btn` class (`extension/ui/components.css`) sets
   `display: inline-flex`, and an author stylesheet's `display`
   declaration always wins over the browser's UA-default
   `[hidden] { display: none }` rule regardless of selector specificity —
   so a bare `hidden` attribute is silently a no-op on any `.btn`-classed
   element. This is the exact same class of issue the shared library
   already self-compensates for on three of its OWN components
   (`.menu[hidden]`, `.tool-row-detail[hidden]`, `.slash-picker[hidden]`
   in `components.css`) — but nothing there covers a plain `.btn`.
   `extension/ui/**` is the shared, approved layer (reported here, not
   edited); **fix**: a page-local `.btn[hidden] { display: none; }` rule
   added to `settings.html`'s own `<style>` block, which compensates
   without touching the shared file. Re-verified: re-captured
   `empty-first-run`/`filled` after the fix, button correctly hidden in
   both.
2. **A toolchain-induced stray focus silently hid a real value in one
   capture.** After several `resize_window`/`javascript_tool` round trips
   (not caused by anything in this page's own code — confirmed by
   grepping `extension/settings/*.js` for `.focus(`, which shows only the
   unrelated "focus the model-add-id input after adding a model" call),
   the Base URL `<input>` ended up holding real DOM focus. `render()`'s
   `if (document.activeElement !== urlInput) urlInput.value = ...` guard
   (intentional — never clobber what a real user is mid-typing) then
   correctly, but unhelpfully for a script-driven capture, left the OLD
   value on screen for the `invalid-base-url` state, whose whole point is
   to show the new invalid value. Every OTHER captured state coincidentally
   used the same Base URL value across the transition, so this defect was
   invisible everywhere else — this is a screenshot-automation artifact
   in the same category `reports/05-visual-system.md`'s own "toolchain
   quirks" note documents (e.g. `resize_window` needing `set_tab_focus`
   first), not a page defect: a real user typing into a real focused field
   is exactly the case the guard exists to protect. **Fix**: the capture
   script explicitly blurs `document.activeElement` before applying that
   state; re-captured and confirmed the correct invalid value now renders
   with the correct `aria-invalid` red border (distinct from the cosmetic
   orange focus-ring visible in a few other captures where content was
   unaffected — left as-is since it changes no content, only decoration
   that a real user's browser would show identically if that field
   happened to be focused).

No other horizontal overflow, clipping, or contrast issue was found across
the 56 captures at 320/400/480px in both themes; the shared visual
system's own token/contrast work (`reports/05-visual-system.md`) is reused
unmodified.

## First-run onboarding wording (spec requirement, verified in the actual capture)

The `empty-first-run` capture's banner reads (Vietnamese):
"Kết nối một nhà cung cấp tương thích Anthropic ... Không cần tài khoản
Claude hay đăng nhập. Chi phí sử dụng phụ thuộc vào nhà cung cấp bạn cấu
hình — không có suy luận miễn phí và không phải mọi gateway đều tương
thích." — this is the actual rendered copy, not a description: it asks for
provider configuration, never a Claude account/sign-in, and explicitly
disclaims both free inference and universal gateway compatibility, per
spec's "No Claude product account required" requirement.

## Export/import (task 2.3 surfaced as UI actions)

`settings.html`'s "Xuất / Nhập cài đặt" section exposes `Xuất cài đặt`
(calls `controller.exportProfile()`, triggers a JSON download) and
`Nhập cài đặt` (a hidden file input; `controller.importProfile()` applies
only `baseUrl`/`models`/`defaultModelId` as an unsaved draft, explicitly
never touching credential state). The field hint text states plainly: "Tệp
xuất KHÔNG chứa API key. Sau khi nhập trên máy mới, bạn cần nhập lại API
key." `test/settings-ui-controller.test.mjs`'s and `-secrets.test.mjs`'s
export/import blocks prove no secret is present in the exported JSON and
that import never calls `save_profile` with a secret field. Note: this
task's brief pointed at `extension/settings-migration/migrate.js` (task
2.3) as the module to surface — that module exports the *legacy*
`chrome.storage`/recorder-session metadata specifically for the one-time
extension-ID migration case (a different, narrower export than the
provider profile itself). The settings page instead surfaces the
*provider-profile* export/import this task's spec scenario ("Export and
diagnostics") actually describes, via the host's own
`exportProfileRedacted()`/`saveProfile()`. Surfacing `migrate.js`'s
legacy-storage export as an *additional* action was judged out of this
task's scope (it operates on `chrome.storage`/IndexedDB recorder session
data, not the provider profile this page owns) — flagging this
interpretation explicitly rather than silently picking one.

## Recorder settings navigation

`settings.html`'s "Khác" section links to the existing
`extension/recorder/options.html` (unmodified, confirmed still present at
that path) via `window.location.href = "../recorder/options.html"` —
kept as a plain navigation, not a fetch/import, since the recorder page
"keeps its own separate transcription credentials" per this task's brief.
The design-review reference screen's "Skills" nav row was deliberately
**omitted**: no `extension/skills/` page exists yet (task group 7 is
host-side skills catalog work only, per `reports/07-skills-evidence.md`;
no extension-side skills UI has landed), and linking to a page that does
not exist would be a real, avoidable defect rather than a faithful
reproduction of the reference mockup.

## All existing suites still pass

```
$ for t in test/*.test.mjs; do node "$t"; done          # 20 files, 0 failed (incl. this task's 7 new ones)
$ for t in host/test/*.test.mjs; do node "$t"; done     # 28 executed, 0 failed (settings-live.test.mjs and stress.mjs are explicit opt-in/manual, not run)
```

Re-run at the end of this session (after parallel sessions' own concurrent
commits landed more files in both directories) to get a final, accurate
count: 20 root suites and 28 host suites, all passing. Full per-file
results captured during this session; every suite reported its own PASS
count with no failures. No regression in any file this task did not touch.

## Addendum — live MV3 CSP violation, found and fixed post-report

Reported by the user from a real browser load of `extension/settings/
settings.html`:

```
Executing inline script violates the following Content Security Policy directive
'script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'
http://localhost:* http://127.0.0.1:*'.
Either the 'unsafe-inline' keyword, a hash (...), or a nonce (...) is required
to enable inline execution. The action has been blocked.
```

**Root cause**: `settings.html` and `skills.html` each ended with an inline
`<script type="module">` block that called `iconMarkup(...)` to inject every
icon (`ic-theme-trigger`, `ic-monitor`, `ic-sun`, `ic-moon`, `ic-plus`,
`ic-refresh`, `ic-mic`, `ic-chevr`, `ic-skills`, `ic-chevr-skills` in
`settings.html`; `btn-back`, `ic-folder` in `skills.html`). `extension/
manifest.json` carries no `content_security_policy` override, so MV3's
default `script-src` (no `unsafe-inline`) applies to both pages exactly as
it already did to `extension/sidepanel/sidepanel.html` — the difference is
that page never had an inline block to begin with. The entire inline block
was blocked, so none of these icons ever rendered and nothing after the
block executed. Nothing in the original test suite loaded either page under
a real CSP (the validation/controller/client/secrets tests all drive
`SettingsController`/`SkillsController` directly, never `settings-app.js`/
`skills-app.js`'s own inline script), so this was invisible until a real
browser load.

**Fix** (root cause, not a CSP relaxation): moved each inline block's exact
`iconMarkup(...)` calls — same icon names, sizes, and `title` attributes —
into the page's existing external module, following the pattern already
used by `extension/sidepanel/sidepanel.js` (`import { iconMarkup } from
"../ui/icons.js"` at module top level, then `el.innerHTML = iconMarkup(...)`
statements that run once, synchronously, at module-evaluation time — after
the DOM elements exist, since the module script tag is the last element in
`<body>`):

- `extension/settings/settings-app.js`: the 10 `document.getElementById(...)
  .innerHTML = iconMarkup(...)` calls now run as plain top-level statements
  (via the file's existing `$()` helper) right after `window
  .__settingsDebug` is assigned, before `iconEl()` is defined.
- `extension/settings/skills-app.js`: same pattern for `btn-back` (plus its
  `scaleX(-1)` flip) and `ic-folder`.
- `settings.html` / `skills.html`: the inline `<script type="module">` block
  removed entirely; each page now loads only `<script type="module"
  src="./settings-app.js">` / `src="./skills-app.js">` — no inline script of
  any kind remains in either file.
- The page-local `.btn[hidden] { display: none; }` CSS workaround documented
  above (defect #1) is CSS, unaffected by this fix, and was left exactly as
  written.
- `extension/manifest.json` was **not** touched — no `unsafe-inline`, hash,
  or nonce was added anywhere; the default MV3 policy is unchanged.

**Regression guard**: `test/extension-csp-no-inline-scripts.test.mjs`
(new) recursively scans every `.html` under `extension/` and fails if any
`<script>` element lacks a `src` attribute, or any inline event-handler
attribute (`onclick=`, `onload=`, `onchange=`, ...) is present. Verified
**genuinely** fails, not just present-but-inert: temporarily reinserted an
inline `<script type="module">` into `settings.html`, ran the test
(`FAIL extension/settings/settings.html: no inline <script>
(element without a src attribute) — found 1: ...`, exit code 1), then
reverted the file and re-ran to confirm a clean pass again. Diffed the
reverted file against its pre-edit state to confirm the revert was exact.

**Swept the rest of `extension/` for the same class of bug** (read, not
edited — files outside `extension/settings/**` are out of this task's
ownership):

| File | Inline `<script>` (no `src`) | Inline event-handler attribute | Result |
|---|---|---|---|
| `extension/settings/settings.html` | none (fixed) | none | clean |
| `extension/settings/skills.html` | none (fixed) | none | clean |
| `extension/sidepanel/sidepanel.html` | none (already clean, the reference pattern) | none | clean |
| `extension/recorder/options.html` | none | none | clean (not owned by this task; reported, not edited) |
| `extension/recorder/offscreen.html` | none | none | clean (not owned by this task; reported, not edited) |

All 5 `.html` files under `extension/` are clean by this rule; no defect to
report in the two out-of-scope recorder pages.

**Full suite re-run after the fix**: `test/*.test.mjs` — 36 files, 0 failed
(35 pre-existing + this addendum's new guard). `host/test/*.test.mjs` — 39
files, 0 failed. No regression in any file this task did not touch.

## Summary — PASS / BLOCKED per acceptance item

| Item | Status |
|---|---|
| Base URL field + validation feedback | **PASS** (client mirror + real host, both tested) |
| Masked API key, replace/remove, cleared after submission | **PASS** (uncontrolled input design; private-field-only transient hold; grep-proven) |
| Model list add/edit/remove/reorder/exactly-one-default | **PASS** |
| Save (validates, atomic, offline-capable) | **PASS** (real host module proven to make no network call for save) |
| Test connection (bounded, discloses billed request) | **PASS** (UI copy + real end-to-end pass/fail) |
| Optional discovery, pagination, preserves manual entries, never erases on unsupported | **PASS** (scripted + real paginated fixture) |
| Connection status / full error taxonomy, actionable, never reveals key | **PASS** (11/12 codes exercised; `STARTUP_ERROR` shares the same rendering path, documented) |
| Navigation to existing recorder settings | **PASS** |
| Export/import surfaced, no-secret disclosure | **PASS** (provider-profile export/import; legacy `migrate.js` scope note above) |
| First-run onboarding: provider config, no Claude account, billing disclosure | **PASS** (verified in actual rendered capture) |
| No secret in storage/logs/exports/command lines (this task's surface) | **PASS**, grep-proven |
| No prior conversation silently sent to a new endpoint (this task's surface) | **PASS**, structurally proven (no conversation concept exists in this module) |
| Real screenshots, 320/400/480 × light/dark, required states | **PASS**, 56 real captures, 2 defects found and fixed |
| All existing suites still pass | **PASS**, 48 files (20 root + 28 host executed; 2 host suites are explicit opt-in/manual, not part of this count), zero regressions |
| Anything requiring a real installed extension / live native-messaging pipe | **BLOCKED** — reproduce with a real Chrome/Edge/Brave profile with the companion installed, `extension/background.js`'s agent-channel relay wired to the `{ type: "agent_settings", op }` contract documented in `settings-client.js`'s file header, and a real endpoint credential; no such environment exists in this session |

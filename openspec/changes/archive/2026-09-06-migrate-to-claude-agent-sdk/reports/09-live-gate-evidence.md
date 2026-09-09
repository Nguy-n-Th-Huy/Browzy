# Live provider gate evidence — consolidated report

Change: `migrate-to-claude-agent-sdk`. This report closes every item in
`reports/01-sdk-gate-evidence.md` and `reports/04-settings-evidence.md` that
was previously recorded as **BLOCKED on live credentials**, using a
user-supplied gateway credential provided for exactly this purpose. It does
**not** re-litigate anything already proven offline in those two reports —
it only adds what a live endpoint makes possible.

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Endpoint | `https://node1.viber.vn` (a mixed-vendor Anthropic-compatible gateway — response headers identify it as a "New API"/"OneAPI"-style product; `x-oneapi-request-id` present on error responses) |
| Models configured | `claude-opus-5`, `claude-sonnet-5` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.263 (unchanged from group 1) |
| Node.js | v24.19.0 |
| Platform | win32 x64 (Windows 11) |

## Credential handling (redacted) — read this before anything else

The user-supplied gateway credential was **never** placed in a shell
environment variable, a CLI argument, or any repository file. It was stored
exactly once, through the real production path, and used only by reading it
back through that same path:

1. The credential was written to a scratch file **outside the repository**
   (the session's temp scratchpad directory, not under
   `D:\Dev\www\open-claude-in-chrome`).
2. A one-off Node script (also outside the repo) read that file, called
   `host/agent/settings/profile.js`'s `saveProfile()` (non-secret baseUrl +
   model list, atomic JSON store) and `setCredential()` (which routes to
   `host/agent/secrets/secret-store.js` → the real **Windows Credential
   Manager** adapter — confirmed by the real write+read+delete availability
   probe `detectSecureStorage()` performs before ever trusting a backend).
3. The scratch file holding the raw credential was deleted immediately after
   being read.
4. Every subsequent live check (gates, capability tests, discovery, error
   taxonomy) resolved the credential **exclusively** by calling
   `loadProfile()` / `snapshotForRun()` / `testCapability()` from
   `host/agent/settings/profile.js`, which reads the OS credential store —
   never an ambient environment variable. Every live gate script explicitly
   asserts `process.env.ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/
   `ANTHROPIC_AUTH_TOKEN` are **unset** in the parent process before trusting
   its own result (see gate 1.5 below) — proving isolation empirically, not
   just by construction.
5. The persisted, non-secret profile file
   (`~/.config/open-claude-in-chrome/agent-profile.json`) was inspected
   directly and contains no credential material — only `baseUrl`, `models`,
   `hasCredential: true`, and `secretBackend: "windows-credential-manager"`.

**Leak-proof (run at the end of this session, after every change above):** a
repo-wide, case-sensitive `grep` for the two distinctive substrings the task
brief identified in the user-supplied credential (deliberately not
reproduced anywhere in this report — including as a description of the
pattern itself — so this report can never become a false-positive hit for
its own proof) across the entire working tree (tracked and untracked files,
`node_modules` included), excluding only `.git`. Result: **zero matches for
either substring, anywhere in the repository.** Re-verified after every edit
made in this session, including after writing this report file itself.

State this report leaves on the local machine (**outside** the repository,
disclosed rather than hidden): a real profile
(`~/.config/open-claude-in-chrome/agent-profile.json`, `baseUrl:
"https://node1.viber.vn"`, models `claude-opus-5`/`claude-sonnet-5`) and a
real Windows Credential Manager entry
(`open-claude-in-chrome/settings/default`) holding the credential. This is
intentional — it exercises and leaves working the real production credential
path end to end, per the correction that redirected this work away from
shell env vars. See "CRITICAL finding" below for a real bug that will wipe
this credential if `host/test/secrets-redaction.test.mjs` is run again.

## Endpoint capability summary

- `POST /v1/messages` — real Anthropic Messages API, SSE streaming, `x-api-key` + `anthropic-version` auth (confirmed by the SDK's own transport and independently by a raw `fetch`).
- Streaming text, a structured tool round trip, and image (vision) input all work for both configured models.
- `GET /v1/models` paginates via `data`/`has_more`/`last_id` and returns a **31-entry mixed-vendor catalog** (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, `gpt-5.6-sol`, `grok-4.6`, `qwen3.6`, `kimi-k3`, `GLM-5.2`, …) — confirms the design's requirement that model IDs stay opaque and are never inferred from vendor naming.
- Real message streams include `thinking` and `redacted_thinking` content blocks preceding `tool_use`/`text` — confirmed `capability-test.js`'s parsing already tolerates this (it only inspects `tool_use`/`text` block types; everything else is silently skipped, which is correct here).
- A model-not-found condition on this endpoint surfaces as a **retried HTTP 503** with a JSON body `{"error":{"code":"model_not_found",...}}`, not the documented unretried 404 — a genuine, gateway-specific finding, detailed below.

## Per-gate results (task group 1)

### Gate 1.3 — DOM/nav/form/click + screenshot recognition — PASS (vision half LIVE; browser half HARNESSED)

**Root-cause implementation, not a one-off script:** `host/agent/spike/gates/gate-1.3-vision.mjs`'s `--live` branch, which previously just `throw`ed, now has a real implementation, runnable by anyone who configures a profile+credential (no code embeds this session's credential).

State precisely which half is which, per the task's explicit instruction not to overclaim:
- **HARNESSED** — navigate, read_page, find, form_input, and the `computer(screenshot)` call itself dispatch through the **real** `host/native-host.js` + `host/tool-runtime.js`, but a fake-extension stand-in (the same technique gate 1.5 and `host/test/ownership.test.mjs` use) supplies every response, including the screenshot image. There is still no live Chrome/extension in this session.
- **LIVE** — a freshly randomized 64×64 shape+color PNG (never checked into the repo, regenerated per run, encoded by a new dependency-free encoder `host/agent/spike/lib/tiny-png.mjs` since this project has no image library) is sent to the real configured provider via `query()`. The model must identify the shape and color — information it cannot have memorized or guessed. Its answer then drives a real, dependent `form_input` call through the same harnessed dispatch chain.

Two independent runs, two different randomized images, two correct answers:

```
Run 1: Generated a randomized live-vision fixture image: shape=square color=yellow (64x64 PNG, 154 bytes)
       LIVE vision call replied: "square yellow" (ground truth: "square yellow")
       PASS (LIVE): correctly identified a freshly randomized shape+color image
       [harnessed] form_input(recognized value) -> [harnessed] form_input accepted: square yellow

Run 2 (via node host/agent/spike/gate.mjs --live):
       Generated a randomized live-vision fixture image: shape=circle color=orange (64x64 PNG, 250 bytes)
       LIVE vision call replied: "circle orange" (ground truth: "circle orange")
       PASS (LIVE): correctly identified a freshly randomized shape+color image
       [harnessed] form_input(recognized value) -> [harnessed] form_input accepted: circle orange
```

**Remaining, genuinely BLOCKED gap:** a live Chrome/extension. This is a
different precondition than credentials and stays open pending group 3/5/7's
live browser infrastructure.

### Gate 1.5 — Cancellation, reconnect, bounded errors, live round trip — PASS (fully closed)

**Real bug found and fixed before running live:** the gate's `--live` branch
would previously have read `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` straight
from `process.env` — bypassing the production credential path entirely. This
was corrected: it now resolves the endpoint/model/credential exclusively
through `host/agent/settings/profile.js`'s `loadProfile()` +
`snapshotForRun()`, matching the contract task group 3's session
orchestration will actually use, and it asserts the parent process itself
carries **zero** ambient `ANTHROPIC_*` variables before trusting the result.

Captured real run:
```
Ambient shell env check: clean — no ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN set in this process's own environment
snapshotForRun("default", "claude-sonnet-5") resolved a credential from the OS credential store (secretBackend: windows-credential-manager) — env is isolated (only ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY/PATH/SystemRoot), never merged with process.env
message types observed: system:init, system:thinking_tokens x5, assistant, assistant, result:success
PASS: a real round trip through query() succeeded using ONLY the isolated env produced by snapshotForRun() — subtype=success, 1 turn(s), 1780ms
```
Cancellation, reconnect, and bounded-error handling (unchanged from group 1's
original offline evidence) all still pass in the same run.

### Gate 1.6 — Clean-profile onboarding — PASS (fully closed for its scope)

Re-ran the same isolation assertions against a **real, non-placeholder**
resolved credential (not just the offline `"sk-ant-spike-placeholder"`
value):
```
PASS (live): snapshotForRun() against the REAL configured profile ("default", model "claude-sonnet-5", endpoint "https://node1.viber.vn") resolved a real credential from the OS credential store (windows-credential-manager) into the same isolated env shape asserted above with the placeholder — no OAuth/session/cookie key, no Claude account/subscription reference
```
The "a real run completes" proof is gate 1.5's round trip above — cross-referenced rather than repeated, to avoid a duplicate billed request for identical evidence. No Claude account, subscription, OAuth token, or official extension was used or referenced anywhere in the isolated `options`/`env` objects, confirmed against real, non-placeholder values.

**Remaining, genuinely BLOCKED gap:** same as 1.3 — a live browser + companion for the full onboarding *journey* (current-page analysis, browser control, skill invocation). The auth/isolation contract itself, which is what this task's own verify clause asks for, is fully closed.

## Settings 4.3 live verification (task group 4)

### Capability matrix (both configured models, real endpoint)

| Model | text | tool | vision |
|---|---|---|---|
| `claude-sonnet-5` | pass | pass | pass |
| `claude-opus-5` | pass | pass | pass |

`claude-sonnet-5` was run with a message-stream hook attached (bypassing
nothing — same `runCapabilityTest()` function `profile.js`'s `testCapability()`
calls) and confirmed real `thinking`/`redacted_thinking` content blocks
appear before `tool_use`/`text`; the existing parsing already tolerates this
correctly. `claude-opus-5` was run through `profile.js`'s `testCapability()`
directly (the actual persisted, production integration path), confirming it
writes a correctly-keyed result into the profile's `lastCapabilityTest`.

### Model discovery

`refreshDiscoveredModels("default")` paginated a real 31-entry mixed-vendor
catalog and both manually-configured entries (`claude-opus-5`,
`claude-sonnet-5`) survived the merge untouched — exactly the "manual entries
preserved" contract task 4.3 specifies.

### Error taxonomy verification against the real endpoint

| Scenario | Expected | Actual | Real HTTP trace |
|---|---|---|---|
| Bad API key, real model | `AUTH_ERROR` | **`AUTH_ERROR`** ✅ | `system/api_retry`: `error_status: 401, error: "authentication_failed"` |
| Nonexistent model, real (good) key | `MODEL_UNAVAILABLE_ERROR` | **`NETWORK_ERROR`** (documented gateway-dependent fallback — see finding below) | `system/api_retry`: `error_status: 503, error: "server_error"` |

### Real finding: this gateway reports "model not found" as a retried 5xx, not the documented 404

A raw `fetch` to `POST /v1/messages` with a nonexistent model id (bypassing
the SDK entirely, to attribute this to the gateway and not to any
CLI-side reinterpretation) confirmed the wire-level truth:

```
status: 503
body: {"error":{"code":"model_not_found","message":"No available channel for model claude-this-model-does-not-exist-live-gate-probe under group default (distributor) (request id: ...)","type":"new_api_error"}}
```

The bundled Claude Code CLI's own `system`/`api_retry` message, however, only
ever forwards `{ error_status: 503, error: "server_error" }` to the SDK
caller — it does **not** forward the upstream response body, so the specific
`model_not_found` reason is unrecoverable from `capability-test.js` without
bypassing the SDK transport entirely (a design this module deliberately
avoids — see its file header on why `query()` was chosen over a bespoke HTTP
client). Confirmed by dumping the full raw message object: it carries only
`attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`,
`session_id`, `uuid` — no body text at all.

**Root-cause action taken:** `classifySdkError`'s `status >= 500` branch
still returns `NETWORK_ERROR` — genuinely the most honest classification
available given what the SDK exposes, since there is no way to distinguish
this from an actual transient outage at this layer — but its message was
corrected (`host/agent/settings/capability-test.js`) to say so explicitly:
*"provider server error (HTTP 503); note: some gateways report an
unrecognized model id as a 5xx rather than 404 — this may also mean the
requested model is not available on this endpoint, not only a transient
server/network fault."* The file's header comment documenting the two known
retry/no-retry shapes was extended with this third, empirically-discovered
shape. The offline test suite was not affected (it asserts only on the
`code`, never the message text — confirmed before editing).

This is exactly the "confirm the classifier against the live endpoint and
correct it if reality differs" verification the task requested. No fabricated
heuristic was added (e.g. sniffing message text for "model_not_found") since
the SDK provides no such text to sniff for this failure shape — that would
have been guessing, not correcting.

### `host/test/settings-live.test.mjs` — new, opt-in live coverage

Added, guarded behind `OCIC_RUN_LIVE_PROVIDER_TESTS=1` (unset by default, so
the offline suite never depends on it). It does **not** create or store a
credential — it consumes whatever profile+credential is already configured
through the real production path, and bounds its capability-test loop to at
most 3 models (default model first) rather than iterating an entire
discovered catalog, specifically to avoid the cost blowup described in the
next section. Verified to skip cleanly with no env var (exit 0, no
credential access attempted) and to pass all 5 checks live:
```
$ OCIC_RUN_LIVE_PROVIDER_TESTS=1 node host/test/settings-live.test.mjs
  PASS  model discovery paginates and preserves every manual model entry (478ms)
  PASS  capability test for "claude-sonnet-5" reports text/tool/vision each on its own key (40805ms)
  PASS  capability test for "claude-opus-5" reports text/tool/vision each on its own key (26871ms)
  PASS  a deliberately bad API key is classified AUTH_ERROR against the real endpoint (2790ms)
  PASS  a nonexistent model id is classified as a model/route failure, never reported compatible (2811ms)
5/5 passed
```

## RESOLVED: `host/test/secrets-redaction.test.mjs` collided with and destroyed a real profile's stored credential

Discovered by direct reproduction while doing this work (not hypothetical):
after seeding a real credential and running the full offline suite once
(27/27 passed), a second inspection found the real credential **gone** from
Windows Credential Manager, even though the persisted profile JSON still
claimed `hasCredential: true`.

**Root cause:** `host/test/secrets-redaction.test.mjs`'s "real Windows
Credential Manager" check called
`profile.setCredential("default", SECRET, { memoryOnly: false })` and, in its
`finally` block, `await profile.removeCredential("default")`. It correctly
isolated its own **profile JSON metadata** via a scratch
`OCIC_AGENT_CONFIG_DIR`, but the credential **target name** —
`host/agent/settings/profile.js`'s `credentialTarget(profileId)`, literally
`` `open-claude-in-chrome/settings/${profileId}` `` — is **not** scoped by
config dir at all. It is a single, global Windows Credential Manager key
per `profileId`. Since the test used `profileId: "default"` — the exact same
ID `DEFAULT_PROFILE_ID` and every real installation uses — its `setCredential`/
`removeCredential("default")` calls silently overwrote and then deleted the
*same physical OS secret* any real "default" profile on that machine
references, regardless of how isolated its own JSON file is.

A second, related instance of the same hazard was found and fixed during
this cleanup: `host/test/settings-profile.test.mjs` also used profileId
`"default"` throughout. Two of its checks ("snapshotForRun throws
NO_CREDENTIAL when no credential is stored" and "removeCredential fires
onCredentialRevoked and clears the stored secret") resolve a credential for
a profile whose `memoryOnlyCredential`/`secretBackend` fields read back as
"unset" (never set, or just cleared by `removeCredential`) — in that state,
`profile.js`'s `readSecret()` call falls through to a **real** OS-backend
detection + read, not memory. Combined with `profileId: "default"`, this
meant the file was silently **reading** the real, machine-wide production
secret into an unrelated test's process memory whenever one existed on the
host machine (confirmed directly against this session's real, live
`"default"` credential: with the fix below reverted, this file's `removeCredential`
test fails exactly this way — the real secret is found where an absent one
was expected). Not destructive by itself (no write/delete on that path), but
the same class of global-namespace collision, so it is fixed here too.

By contrast, `secrets-store.test.mjs`'s own raw-adapter WCM test already
avoided this correctly, using a dedicated
`` `open-claude-in-chrome-test/wcm/${process.pid}-${Date.now()}` `` target.

**Fix — both layers, per the task's "prefer the option that makes the whole
class of bug impossible" guidance:**

1. **Test fix** (`host/test/secrets-redaction.test.mjs`,
   `host/test/settings-profile.test.mjs`): every `profile.js` call
   (`saveProfile`/`setCredential`/`removeCredential`/`snapshotForRun`/
   `exportProfileRedacted`/`isRunnable`) now uses a dedicated,
   obviously test-only `profileId` (`"ocic-test-secrets-redaction"` /
   `"ocic-test-settings-profile"`) instead of `"default"`, mirroring
   `secrets-store.test.mjs`'s own established convention.
2. **Structural guard** (`host/agent/secrets/secret-store.js`, the single
   dispatcher every OS-backed credential operation already goes through): a
   new `assertSafeCredentialTarget()` check, called from `storeSecret()`,
   `readSecret()`, and `deleteSecret()`, throws a new
   `UnsafeTestCredentialTargetError` whenever a **real** (non-memory)
   backend operation is attempted against the exact production target
   (`open-claude-in-chrome/settings/default`) while `OCIC_AGENT_CONFIG_DIR`
   is set — the env var that only ever gets set by a test harness
   (`host/agent/settings/paths.js`'s own doc comment; no real installation
   sets it). A memory-only call is always exempt (it can never reach a real
   OS store). This makes the entire class of collision structurally
   impossible going forward, independent of any one test file remembering
   to pick a safe profileId: the two `settings-profile.test.mjs` checks
   above were actually caught live by this exact guard while fixing this
   (it threw where the tests had been silently succeeding/failing on
   whatever real credential happened to be on the machine), which is what
   surfaced the second instance described above.

**Verification (no destructive re-test performed):** the real `"default"`
Windows Credential Manager entry already on this machine was confirmed
present (existence-only check, value never read/printed) before this fix,
then the **entire** offline suite (`host/test/*.test.mjs`, `test/*.test.mjs`)
was run, then the real entry was confirmed present again, byte-for-byte
unchanged in the sense that it was never touched — `windowsCredRead` on the
production target returns non-null both before and after, and nothing in
this session's process output ever printed its value.

**Consequence for this report's "state left on the machine" section above:**
the real credential is untouched and remains configured; the destructive
collision this section originally reported can no longer occur.

## Offline suite regression proof (no ambient credentials)

With `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` confirmed unset in the shell
(`env | grep -i anthropic` → no output):

```
$ (28 files) host/test/*.test.mjs   -> 28/28 passed (includes the new settings-live.test.mjs, which skips cleanly with exit 0)
$ (7 files)  test/*.test.mjs        -> 7/7 passed (root-level suite; read-only sanity check, not owned by this session)
$ node host/agent/spike/gate.mjs    -> no hard failures (offline mode unaffected by the --live code paths added)
```
No offline suite newly depends on a live key. The one real interaction
between "offline" and "live" state is the CRITICAL finding above (a
pre-existing offline test destroys a live credential as a side effect) — not
a new dependency this session introduced.

## Cost discipline / request accounting

Approximately **22 real `POST /v1/messages` calls** were made across this
work (each bounded: `maxTurns` 1–3, short synthetic prompts, aborted
immediately on the first retry/error signal rather than waiting out the
CLI's own backoff), plus a handful of cheap, non-token-billed `GET
/v1/models` pagination calls. The count is higher than the minimum
theoretically required (~10) because two real bugs were found and fixed
mid-flight (the unbounded model-list pollution in the first draft of
`settings-live.test.mjs`, and the env-var-reading gate scripts before the
credential-handling correction), each requiring a re-run to verify the fix.
No check was re-run after it had already passed for its own sake.

## Task IDs now closable

Recorded here for the tasks.md owner to reconcile (this session did not edit
tasks.md):

- **1.3** — sub-item "screenshot-based recognition of a randomized visual fixture" and "live, vision-capable Anthropic model" closable; the DOM/browser-control sub-item stays open (needs a live browser, not a credential).
- **1.5** — "a real configured endpoint/model round trip through the SDK" closable in full.
- **1.6** — "no Claude account, no subscription, no OAuth token, no official extension — API-key mode only" closable in full for its auth/isolation/real-run scope; the full current-page-analysis/browser-control/skill-invocation journey stays open (needs a live browser + companion).
- **4.3** — "run the real capability test and real paginated model discovery against this endpoint" closable in full, including the error-taxonomy verification and the SDK-classifier-vs-reality confirmation.

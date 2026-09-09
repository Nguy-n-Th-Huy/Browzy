# Provider settings and model catalog — evidence report

Change: `migrate-to-claude-agent-sdk`, tasks 4.1–4.3 (host-side only; 4.4/4.5
— the `extension/settings/` UI and its tests — are explicitly out of scope
for this session and land later).

This report records what was actually run, on this machine, on this date.
**Update (later session, same date): a live Anthropic-compatible provider
credential became available and every item below that was previously BLOCKED
strictly on a missing live credential has now been closed with real,
captured evidence** — see `reports/09-live-gate-evidence.md` for the full
consolidated live run (endpoint capabilities, the per-model capability
matrix, error-taxonomy verification against the real gateway, and a critical
test-isolation bug this work discovered). What remains BLOCKED below is
blocked strictly on missing **macOS/Linux hardware** (the secret-store
adapters), which a credential does not change.

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Platform | win32 x64 (Windows 11) |
| Node.js | v24.19.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.263 (already pinned by task group 1; this session added no dependency) |
| Bundled Claude Code CLI | 2.1.263 |

Reproduce the full suite:

```
cd host
node test/settings-all.test.mjs
```

or any individual file (`node test/settings-url.test.mjs`, etc. — see the
`Run:` comment at the top of each file).

## Files added (this session's scope)

```
host/agent/settings/paths.js
host/agent/settings/atomic-store.js
host/agent/settings/url.js
host/agent/settings/models.js
host/agent/settings/errors.js
host/agent/settings/profile-schema.js
host/agent/settings/profile-store.js
host/agent/settings/http-client.js
host/agent/settings/discovery.js
host/agent/settings/capability-test.js
host/agent/settings/profile.js                       <- the contract group 3 codes against
host/agent/settings/testing/fixture-anthropic-server.mjs

host/agent/secrets/secret-store.js
host/agent/secrets/windows-credential-manager.js
host/agent/secrets/macos-keychain.js
host/agent/secrets/linux-secret-service.js
host/agent/secrets/memory-store.js
host/agent/secrets/redact.js

host/test/settings-url.test.mjs
host/test/settings-models.test.mjs
host/test/settings-atomic-store.test.mjs
host/test/settings-http-client.test.mjs
host/test/settings-profile.test.mjs
host/test/settings-discovery.test.mjs
host/test/settings-capability-test.test.mjs
host/test/settings-all.test.mjs
host/test/secrets-store.test.mjs
host/test/secrets-redaction.test.mjs
```

No file outside `host/agent/settings/**`, `host/agent/secrets/**`,
`host/test/settings-*.test.mjs`/`host/test/secrets-*.test.mjs`, and this
report was created or modified. `host/package.json` was not touched — no new
dependency was added; the capability test uses the SDK dependency task group
1 already pinned, and discovery/http-client use Node's built-in `fetch`.

## Contract group 3 codes against (`host/agent/settings/profile.js`)

```js
async function loadProfile()
//   -> { profileId, baseUrl, models: [{id, label}], defaultModelId, revision, lastCapabilityTest } | null

async function snapshotForRun(profileId, modelId)
//   -> { model, env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }, revision, profileId }
//   throws a ProviderError(code: "NO_CREDENTIAL") if no credential is available

function onCredentialRevoked(listener)   // listener({ profileId })
```

Signatures are exact, unchanged from the task prompt. Additional exports
alongside them: `saveProfile`, `setCredential`, `removeCredential`,
`refreshDiscoveredModels`, `testCapability`, `isRunnable`,
`exportProfileRedacted`.

## Profile schema (task 4.1/4.2)

Persisted, versioned, non-secret JSON at
`~/.config/open-claude-in-chrome/agent-profile.json` (same
`~/.config/open-claude-in-chrome/` convention already used by
`host/endpoint.js`/`host/native-host.js`/`host/parent-watch.js`, including on
Windows — no new per-platform convention introduced). Override for tests:
`OCIC_AGENT_CONFIG_DIR`.

```json
{
  "schemaVersion": 1,
  "profileId": "default",
  "baseUrl": "https://api.anthropic.com",
  "models": [{ "id": "claude-...", "label": "..." }],
  "defaultModelId": "claude-...",
  "revision": 3,
  "credentialRevision": 2,
  "hasCredential": true,
  "memoryOnlyCredential": false,
  "secretBackend": "windows-credential-manager",
  "lastCapabilityTest": {
    "<baseUrl> <modelId> <credentialRevision>": {
      "status": "pass" | "fail",
      "capabilities": { "text": "pass|fail|not_run", "tool": "...", "vision": "..." },
      "errors": { "text": { "code": "...", "message": "..." }, ... },
      "timestamp": "..."
    }
  }
}
```

The actual secret is **never** a field here — it lives only in the OS
credential store (or the explicit memory-only in-process map), keyed by
`open-claude-in-chrome/settings/<profileId>`. `lastCapabilityTest` is keyed
by `(baseUrl, modelId, credentialRevision)`, so replacing the credential or
changing the endpoint/model naturally orphans every prior result — no
separate "invalidate" step exists or is needed (`profile-schema.js`,
`capabilityTestKey`).

### Atomicity (task 4.1)

`atomic-store.js` writes a uniquely-named temp file beside the target,
`fsync`s it, then `fs.renameSync`s it onto the real path (atomic on NTFS and
POSIX filesystems alike). A `crashAfterWrite` test hook throws between the
fsync and the rename, simulating a process death at the worst possible
moment. `host/test/settings-atomic-store.test.mjs` proves the last good file
survives that byte-for-byte, and that the leftover temp file is cleaned up on
the next load without ever being mistaken for the real profile. **PASS**
(7/7, real, executed).

## Base URL normalization table (task 4.2)

`host/agent/settings/url.js`. Accept/reject rows all verified by
`host/test/settings-url.test.mjs` (23/23 **PASS**, real, executed):

| Input | Result | Normalized / reason |
|---|---|---|
| `https://api.anthropic.com` | accept | `https://api.anthropic.com` (documented default) |
| `https://gateway.example.com/proxy` | accept | unchanged (gateway prefix preserved) |
| `https://api.anthropic.com/` | accept | `https://api.anthropic.com` (trailing slash stripped) |
| `https://gateway.example.com/v1` | accept | `https://gateway.example.com` (terminal `/v1` stripped — never doubled) |
| `https://gateway.example.com/proxy/v1` | accept | `https://gateway.example.com/proxy` (prefix kept, `/v1` stripped) |
| `https://gateway.example.com/proxy/v1/` | accept | `https://gateway.example.com/proxy` |
| `https://gateway.example.com/v10/foo` | accept | unchanged — `v10` is not a terminal `/v1` segment |
| `https://gateway.example.com:8443/proxy` | accept | port preserved |
| `http://localhost:8080` | accept (loopback) | `isLoopbackHttp: true` |
| `http://127.0.0.1:8080/v1` | accept (loopback) | `isLoopbackHttp: true`, `/v1` stripped |
| `http://[::1]:9000` | accept (loopback) | `isLoopbackHttp: true` |
| `https://user@gateway.example.com` | **reject** | userinfo |
| `https://user:pass@gateway.example.com` | **reject** | userinfo |
| `https://api.anthropic.com/?foo=bar` | **reject** | query string |
| `https://api.anthropic.com/#section` | **reject** | fragment |
| `http://gateway.example.com` | **reject** | plain HTTP to a non-loopback host |
| `ftp://gateway.example.com` | **reject** | unsupported scheme |
| `""` | **reject** | required |
| `"not a url at all"` | **reject** | not a valid absolute URL |

## API-key header semantics (task 4.2)

`http-client.js`'s `authenticatedFetch` sends **only** `x-api-key` +
`anthropic-version`; it never sends `Authorization: Bearer` under any
circumstance — verified directly (`settings-http-client.test.mjs`, "never
sends Authorization: Bearer"). A Bearer-only gateway therefore fails
authentication (reported as `AUTH_ERROR`) rather than being silently made to
work by switching schemes, per spec.

## Model catalog (task 4.2)

`models.js`: trims whitespace, requires nonempty + unique (case-sensitive)
IDs, explicit array order preserved, exactly one default that must reference
a real entry, and an empty list requires no default (never invents a model).
`host/test/settings-models.test.mjs`: **PASS** (12/12, real, executed).

## Per-run isolation and revision tracking (task 4.2)

`snapshotForRun`'s `env` is built from scratch (`{ ANTHROPIC_BASE_URL,
ANTHROPIC_API_KEY }` only) — never `{ ...process.env, ... }`. Verified with a
real adversarial test that sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
and `ANTHROPIC_AUTH_TOKEN` on `process.env` to attacker-controlled values
before calling `snapshotForRun`, and asserts none of those three ambient
values appear anywhere in the returned snapshot (`settings-profile.test.mjs`,
"snapshotForRun's env REPLACES the ambient environment"). **PASS** (real,
executed). `revision` is the profile's own field and is returned unchanged in
the snapshot, so a long-running SDK session can be shown to have used a
specific committed profile version even if the profile is later edited.

## Model discovery (task 4.3)

`discovery.js` performs paginated `GET /v1/models?limit=&after_id=` via
`authenticatedFetch`, merging pages by `has_more`/`last_id` and never
inventing an ID. A 404 is reported as `{ supported: false }` (manual models
untouched, per spec); any other failure (401/403/429/malformed body) is a
real thrown `ProviderError`, not silently folded into "unsupported" — this
distinction is itself tested (`settings-discovery.test.mjs`, 5/5 **PASS**,
real, executed against the in-process fixture server, including a genuine
two-page pagination round trip).

**Verified live** against the real gateway via
`host/agent/settings/profile.js`'s `refreshDiscoveredModels()`: paginated
across a real 31-entry **mixed-vendor** catalog (`gpt-5.6-sol`, `grok-4.6`,
`qwen3.6`, `claude-haiku-4-5`, …, confirming model IDs stay opaque and are
never inferred from vendor naming), and both manually-configured entries
(`claude-opus-5`, `claude-sonnet-5`) survived the merge untouched. Full output
in `reports/09-live-gate-evidence.md`.

## Bounded synthetic capability test (task 4.3)

### A real architecture decision, made from empirical evidence, not assumption

The spec describes this as running "a bounded SDK session". Two designs were
considered:

1. Spawn the actual bundled Claude Code CLI (via the real
   `@anthropic-ai/claude-agent-sdk` `query()`) against the configured
   endpoint.
2. Hand-roll a direct HTTP client against the Anthropic Messages API.

**(1) was chosen** — and empirically validated before being built on, not
assumed to work. A throwaway probe server was pointed at by `query()` (real
SDK, no fixture code yet) to capture exactly what the bundled CLI sends. The
findings, which the whole capability-test design is built from:

- The CLI issues `HEAD {baseUrl}/api/hello` before anything else, then
  `POST {baseUrl}/v1/messages?beta=true` with a normal Anthropic Messages API
  streaming (SSE) body — `x-api-key` + `anthropic-version: 2023-06-01`, never
  `Authorization`.
- **The CLI's own HTTP transport retries almost every failure** — 401, 429,
  and even a bare connection-refused — with slow, growing exponential
  backoff (10 retries; by the 5th–6th attempt the delay alone is 9–19
  seconds). A capability test that waited for this to exhaust would blow far
  past any reasonable budget. `capability-test.js` does not wait for that:
  it watches the live message stream and classifies + aborts on the
  **first** `system`/`api_retry` signal it sees.
- A **second**, different failure shape exists and had to be discovered
  separately: 403, a 404 model-not-found, and a non-Anthropic-shaped 200
  response (the OpenAI-Chat-Completions test below) are **not** retried at
  all. Instead the CLI synthesizes a `result` message with
  `subtype: "success"` **but** `is_error: true` and (when available) a
  numeric `api_error_status`, immediately followed by the async generator
  throwing. The first implementation of this module missed this and reported
  a false PASS for 403/404/protocol-mismatch scenarios; the fixed
  classification logic in `capability-test.js` checks `is_error`/
  `api_error_status` on every `result` message before ever trusting
  `subtype === "success"` alone, restoring `lastApiErrorType` captured from
  the preceding `assistant` message's `is_api_error_message`/`error` field
  as an additional signal when no numeric status is present (the
  OpenAI-shape case, where `api_error_status` is `null` and only the
  human-readable message identifies the failure). This is why the fixture
  server and the classifier below produce genuine, verified-correct PASS/FAIL
  outcomes rather than a plausible-looking guess.
- A real, harmless MCP tool round trip and a real base64 image content block
  both work end-to-end through `query()` against a scripted fixture — proven
  empirically before being relied on in `capability-test.js`.

Choosing the real `query()` path means a PASS here is evidence the actual
product wire protocol is compatible, not just that a bespoke test client can
talk to the endpoint — and it is what let the retry/no-retry distinction
above be discovered and handled at all.

### Fixture server

`host/agent/settings/testing/fixture-anthropic-server.mjs` — an in-process,
local-only HTTP(S) server built directly from the captured trace above:
`HEAD /api/hello`, real Anthropic Messages SSE framing for a text/tool/vision
success path, paginated `GET /v1/models`, and scripted error scenarios
(`401`, `403`, `404-model`, `429`, `500`, `protocol-openai`,
`redirect-same-origin`, `redirect-cross-origin`, `hang`, `hang-startup`). TLS
scenarios use a throwaway self-signed cert minted via the `openssl` CLI when
available.

### Results — `host/test/settings-capability-test.test.mjs` (10/10 **PASS**, real, executed against the real SDK + real fixture server)

| Scenario | Classified as | Notes |
|---|---|---|
| well-behaved fixture (text + tool + vision) | `pass` / `pass` / `pass` | fixture tool actually invoked through real MCP dispatch + real zod validation; a real base64 image accepted |
| `401` | `AUTH_ERROR` | via the retry-path `api_retry` signal; classified on the first retry, not after exhaustion |
| `403` | `AUTH_ERROR` | via the no-retry `result.is_error`/`api_error_status` signal |
| `404-model` | `MODEL_UNAVAILABLE_ERROR` | `api_error_status: 404` |
| `429` | `RATE_LIMIT_ERROR` | via the retry-path signal |
| connection refused (nothing listening) | `NETWORK_ERROR` | `error_status: null, error: "unknown"` from the retry-path signal |
| OpenAI-Chat-Completions-shaped 200 response | `PROTOCOL_ERROR`, `status: "fail"` | message-pattern match on the CLI's own "malformed response ... StreamNoEventsError" text — **never reported compatible**, per spec |
| cross-origin redirect on `/v1/messages` | `status: "fail"` | the SDK's own transport (not this module's `authenticatedFetch`) makes this call, so the exact taxonomy code is transport-dependent; what's asserted unconditionally is that it never completes as a pass |
| no response at all (`hang`) | `TIMEOUT_ERROR` | fires on this module's own externally-imposed deadline, not the CLI's much longer internal timeout |
| capability shape | each of text/tool/vision reported under its own key | structural requirement ("reported separately") |

### Update: verified live against a real gateway

A live, credentialed, vision-capable Anthropic-compatible endpoint is now
available. Both configured models passed all three sub-tests for real:

| Model | text | tool | vision |
|---|---|---|---|
| `claude-sonnet-5` | pass | pass | pass |
| `claude-opus-5` | pass | pass | pass |

The `claude-sonnet-5` run was captured with a message-stream hook and
confirmed the model stream includes `thinking` and `redacted_thinking`
content blocks preceding `tool_use`/`text` — `capability-test.js`'s parsing
already tolerates this correctly (it only inspects `tool_use`/`text` block
types and ignores everything else; no code change was needed here, but this
is now empirically confirmed rather than assumed). Full transcripts, the
exact commands used, and the credential-handling method (OS credential store
via `host/agent/settings/profile.js`, never a shell env var) are in
`reports/09-live-gate-evidence.md`.

**Still genuinely unverified** (not overclaimed): this specific gateway's
Claude models complied fully with both the tool-call and vision requests —
proving the wire protocol and this module's parsing are correct, but not
exercising the `TOOL_ERROR`/`VISION_ERROR` codes' actual trigger condition (a
model that *declines* an offered tool, or *rejects* an image). Those two
codes remain verified only against the deterministic fixture server
(above), same as before.

## Error taxonomy (task 4.3)

`host/agent/settings/errors.js` (`ProviderError`, codes in
`PROVIDER_ERROR_CODES`):

| Code | Meaning | Verified by |
|---|---|---|
| `STARTUP_ERROR` | runtime/endpoint never became reachable within the startup budget | code path exists (`capability-test.js`'s `sawInit`/`initDeadline` check); not independently exercised this session — the fixture's `hang-startup` scenario (never answering `HEAD /api/hello`) did not, in practice, delay the CLI's own `system:init` emission (it appears to fire on local process readiness, not on the health-check response), so this specific sub-path is reviewed by inspection rather than an executed fixture scenario. **Recorded here rather than silently claimed.** |
| `AUTH_ERROR` | 401/403 | `settings-capability-test.test.mjs` (both retry-path and no-retry-path shapes), `settings-discovery.test.mjs` |
| `MODEL_UNAVAILABLE_ERROR` | model/route not found (404) | `settings-capability-test.test.mjs` |
| `RATE_LIMIT_ERROR` | 429 | `settings-capability-test.test.mjs`, `settings-discovery.test.mjs` |
| `TIMEOUT_ERROR` | provider-test deadline exceeded with no classifiable response | `settings-capability-test.test.mjs` (`hang` scenario) |
| `NETWORK_ERROR` | DNS/TCP/TLS failure, connection reset, unclassified 5xx | `settings-capability-test.test.mjs` (connection refused), `settings-discovery.test.mjs` |
| `PROTOCOL_ERROR` | endpoint does not speak the Anthropic Messages API | `settings-capability-test.test.mjs` (OpenAI-shape), `settings-discovery.test.mjs` (non-Anthropic-shaped 200) |
| — **live finding** | A real gateway was found to report "model not found" as a **retried HTTP 503** (`error: "server_error"`) with the specific reason (`{"error":{"code":"model_not_found",...}}`) buried in a response body the bundled CLI's own `api_retry` message does not forward — confirmed both through the SDK (`runCapabilityTest`) and a raw `fetch` against `/v1/messages` bypassing the SDK entirely. `classifySdkError`'s `>=500` branch still returns `NETWORK_ERROR` (there is no principled way to recover `model_not_found` from what the SDK exposes without abandoning the "real SDK transport" design decision above), but its message was corrected to say so explicitly instead of asserting a cause it cannot verify — see `capability-test.js`'s updated comment and `errors.text.message`. Full trace in `reports/09-live-gate-evidence.md`. |
| `TOOL_ERROR` | model completed the turn without ever calling the fixture tool | code path exists in `capability-test.js`; the "well-behaved" fixture always calls the tool (by construction, since it inspects the request for a `tools` array and replies with a matching `tool_use`), so a genuine model *declining* to call an available tool needs a real, imperfectly-tool-following provider — **BLOCKED**, same live-endpoint command as above |
| `VISION_ERROR` | image input rejected or not completed | same as `TOOL_ERROR` — the fixture always accepts the image; a genuine rejection needs a real non-vision model — **BLOCKED**, same command |
| `REDIRECT_REJECTED` | cross-origin redirect for an authenticated request | `settings-http-client.test.mjs`, `settings-discovery.test.mjs` (both real, real HTTP 302 responses, real origin comparison) |
| `NO_CREDENTIAL` | `snapshotForRun`/`testCapability`/`refreshDiscoveredModels` called with no stored credential | `settings-profile.test.mjs` |
| `INVALID_PROFILE` | requested model not in the profile's list | `settings-profile.test.mjs` |

## Secret storage (task 4.1/4.3)

One interface (`host/agent/secrets/secret-store.js`) in front of three OS
adapters plus an explicit memory-only fallback. `detectSecureStorage()` never
assumes availability from `process.platform` alone — it does a real
write+read+delete probe with a throwaway value before reporting a backend
"available". If none is available and the caller did not explicitly pass
`memoryOnly: true`, `storeSecret()` throws `SecureStorageUnavailableError` —
**never** a silent plaintext-file fallback (verified:
`secrets-store.test.mjs`, "throws SecureStorageUnavailableError when no OS
backend is detected").

| Adapter | Mechanism | Status on this machine (Windows) |
|---|---|---|
| Windows Credential Manager | `powershell.exe` + `Add-Type` P/Invoke of `CredWriteW`/`CredReadW`/`CredDeleteW` (advapi32.dll); secret travels over stdin/stdout, base64-encoded, never as a CLI argument | **PASS, real** — genuine write, read-back, delete, unicode round trip, and not-found handling against the actual OS credential store (`secrets-store.test.mjs`, 9 checks) |
| macOS Keychain | `security add-generic-password`/`find-generic-password`/`delete-generic-password` | **BLOCKED** — no macOS on this machine. A disclosed, real, non-hidden limitation: `security`'s only non-interactive write interface is `-w <password>` (an argv value, briefly visible to `ps` for that one call) — there is no stdin/env alternative in the documented CLI. Reproduce: `node host/test/secrets-store.test.mjs` on macOS |
| Linux Secret Service | `secret-tool store`/`lookup`/`clear` (libsecret-tools) | **BLOCKED** — no Linux on this machine. Unlike macOS, `secret-tool store` reads the secret from **stdin**, so there is no equivalent argv-exposure window. Reproduce: `node host/test/secrets-store.test.mjs` on Linux with a Secret Service provider (gnome-keyring/KWallet) running |
| Memory-only | in-process `Map`, explicit opt-in only | **PASS, real** — write/read/delete round trip, and the dispatcher never reaches an OS adapter when `memoryOnly: true` |

A fake-subprocess simulation of `security`/`secret-tool` was attempted on
Windows to at least exercise the macOS/Linux adapters' own argv-construction
logic without a real macOS/Linux box, and was **deliberately abandoned**
after hitting two genuine, empirically-confirmed constraints (recorded in
`host/test/secrets-store.test.mjs`'s file header, not silently worked
around): `child_process.execFileSync` cannot invoke a `.cmd`/`.bat`
stand-in without `shell: true` on Windows (a documented Node limitation
unrelated to this code), and ESM named imports of Node built-ins
(`import { execFileSync } from "node:child_process"`) are snapshotted at
first evaluation, so monkeypatching `child_process.execFileSync` from a test
does not intercept the adapter's own call either. Adding `shell: true` to
the real adapters purely to satisfy this Windows-only test harness was
rejected as a real command-injection surface increase on the real target
OSes for zero correctness benefit. What genuinely IS verified: the
dispatcher's platform-routing logic (`isWindowsCredentialManagerPlatform`/
`isMacosKeychainPlatform`/`isLinuxSecretServicePlatform`) correctly agrees
with `process.platform` on every OS, so `detectSecureStorage()` never even
attempts the wrong adapter here.

## Credential redaction (task 4.3)

`host/test/secrets-redaction.test.mjs` runs a real save → set-credential →
export flow (once memory-only, once against the real Windows Credential
Manager) with a unique, never-reused secret value, captures every line this
process logs to `console.log`/`console.error` during that flow, then greps
**both** the captured log text and every file under a scratch
`OCIC_AGENT_CONFIG_DIR` for the literal secret string. **PASS** (4/4, real,
executed) — the secret appears in neither. `redact.js`'s
`redactSecretsInText`/`redactSecretsDeep` (used for exports/diagnostics
beyond the profile file, which structurally never holds a secret to begin
with) are also unit-tested directly.

## Non-negotiable behaviors — where each is enforced

- **Saving allowed offline; running requires a passing capability test** —
  `saveProfile()` makes no network call (verified: every `settings-profile
  .test.mjs` save check runs with no fixture server present).
  `isRunnable(profileId, modelId)` checks `lastCapabilityTest[key].status ===
  "pass"` for the *exact* current `(baseUrl, modelId, credentialRevision)`
  triple; nothing else is consulted.
- **Key replacement invalidates compatibility status** — `capabilityTestKey`
  includes `credentialRevision`; `setCredential` bumps it; verified
  end-to-end in `settings-profile.test.mjs` ("replacing a credential
  invalidates prior capability-test results").
- **Key deletion cancels associated runs and removes stored secrets** —
  `removeCredential` calls `deleteSecret` then fires every registered
  `onCredentialRevoked` listener; verified in `settings-profile.test.mjs`.
  Actually cancelling an in-flight SDK run is task group 3's session
  orchestration; this module's job — firing the revocation event reliably —
  is what's tested here.
- **Provider/model changes apply only to a new conversation** — this module
  never mutates an already-issued `snapshotForRun()` result; a session
  holding one keeps using it (it is a plain object, not a live reference)
  until the caller (group 3) requests a new snapshot for a new conversation.
- **No Claude account/subscription/OAuth/proprietary Chrome integration** —
  nothing in `host/agent/settings/**` or `host/agent/secrets/**` references
  any of these; auth is exclusively `ANTHROPIC_API_KEY`/`x-api-key`.

## Full run

```
$ node host/test/settings-all.test.mjs
...
All settings/secrets suites passed.

$ node host/test/endpoint.test.mjs      # 7/7 PASS (pre-existing, unmodified)
$ node host/test/parent-watch.test.mjs  # 3/3 PASS (pre-existing, unmodified)
$ node host/test/ownership.test.mjs     # 12/12 PASS (pre-existing, unmodified)
```

## RESOLVED: a real credential-collision bug in `host/test/secrets-redaction.test.mjs` (and a second instance in `host/test/settings-profile.test.mjs`)

While seeding a real profile+credential through the production path
(`profile.js`'s `saveProfile()`+`setCredential()`) to run the live checks
above, running the **offline** regression suite silently destroyed the
seeded credential. Root cause, confirmed by direct reproduction: this file's
"real Windows Credential Manager" check called
`profile.setCredential("default", SECRET, { memoryOnly: false })` and, in its
`finally` block, `await profile.removeCredential("default")` — against
profile ID `"default"`, the exact same ID `DEFAULT_PROFILE_ID` and every real
user's profile uses. The test isolated its **JSON metadata** correctly (via
`OCIC_AGENT_CONFIG_DIR`), but `credentialTarget(profileId)` in `profile.js` is
**not** scoped by config dir at all — it is only `open-claude-in-chrome/settings/${profileId}`,
a single **global, OS-wide** Windows Credential Manager key. So this test's
`setCredential`/`removeCredential("default")` calls read and then deleted the
*same physical OS secret* a real "default" profile on that machine uses,
regardless of `OCIC_AGENT_CONFIG_DIR`. `secrets-store.test.mjs`'s own raw
adapter test already avoided this correctly (it uses a dedicated
`open-claude-in-chrome-test/wcm/${process.pid}-${Date.now()}` target).

**A second, non-destructive instance of the same class of bug was found
during the fix and is resolved here too:** `host/test/settings-profile.test.mjs`
also used profileId `"default"` throughout. Two of its checks resolve a
credential for a profile whose `memoryOnlyCredential`/`secretBackend` fields
read back as "unset" (never set, or just cleared by `removeCredential`) — in
that state `profile.js`'s `readSecret()` falls through to a **real**
OS-backend detection + read rather than memory. Combined with profileId
`"default"`, this silently read the real, machine-wide production secret
into an unrelated test's process memory whenever one existed on the host —
not destructive by itself, but the same global-namespace collision.

**Consequence, confirmed live before the fix:** a real profile's
`hasCredential: true` metadata was left pointing at a now-deleted OS secret
after simply running `node host/test/secrets-redaction.test.mjs` (or the
full offline suite) on a machine with a real "default" profile configured —
`snapshotForRun()`/`testCapability()` correctly fail-safe with
`NO_CREDENTIAL` at the point of use (this was not a silent-success bug), but
the credential itself was gone and had to be re-entered.

**Fix applied (both layers — "make the whole class of bug impossible," not
just this call site):**

1. **Test fix**: `host/test/secrets-redaction.test.mjs` and
   `host/test/settings-profile.test.mjs` now use a dedicated, obviously
   test-only `profileId` (`"ocic-test-secrets-redaction"` /
   `"ocic-test-settings-profile"`) for every `profile.js` call, mirroring
   `secrets-store.test.mjs`'s own established convention. Neither file's
   `profileId` can ever equal the production default again.
2. **Structural guard**: `host/agent/secrets/secret-store.js` — the single
   dispatcher every OS-backed credential operation already goes through —
   gained an `assertSafeCredentialTarget()` check (called from
   `storeSecret()`, `readSecret()`, and `deleteSecret()`) that throws a new
   `UnsafeTestCredentialTargetError` whenever a real (non-memory) backend
   operation targets the exact production key
   (`open-claude-in-chrome/settings/default`) while `OCIC_AGENT_CONFIG_DIR`
   is set (an env var only ever set by a test harness — see
   `host/agent/settings/paths.js`'s own doc comment). This makes the
   collision structurally impossible regardless of which test (existing or
   future) forgets to pick a safe profileId, rather than relying on every
   test author remembering the convention.

**Verification (no destructive re-test):** the real `"default"` Windows
Credential Manager entry already configured on this machine was confirmed
present (an existence-only check — the value itself was never read or
printed) both before and after running the complete offline suite
(`host/test/*.test.mjs`, `test/*.test.mjs`) with the fix in place; it was
untouched throughout. See `reports/09-live-gate-evidence.md` for the full
before/after reproduction and the exact diff description.

## Summary

| Task | Status |
|---|---|
| 4.1 versioned atomic profile storage + OS credential-store adapters + memory-only mode | **DONE** — atomic write/crash-safety real and tested; Windows adapter real and tested (and, this session, exercised for real against a genuine live-gateway credential); macOS/Linux adapters implemented against their documented CLI surface, still BLOCKED for execution on this OS with exact reproduction commands (a credential does not change this); explicit-failure (never-plaintext) path real and tested. See the CRITICAL finding above for a real credential-collision bug discovered in an unowned test file. |
| 4.2 Base URL normalization, `x-api-key` semantics, manual model catalog, per-run isolation, revision tracking | **DONE** — all real, all tested |
| 4.3 paginated discovery, bounded capability test, error taxonomy, redaction | **DONE**, now including the live-provider content: real paginated discovery against a 31-entry mixed-vendor catalog, a real two-model (opus/sonnet) capability matrix (text/tool/vision all pass), and real error-taxonomy verification (bad key → `AUTH_ERROR`, nonexistent model → a documented, evidenced `NETWORK_ERROR` fallback — see the live finding above). `TOOL_ERROR`/`VISION_ERROR`'s actual trigger condition (a model that declines/rejects) remains verified only against the deterministic fixture, since this gateway's Claude models complied fully. See `reports/09-live-gate-evidence.md`. |

# Task group 6 (remainder) — Executor, sandbox, and recorder preservation

Scope: `openspec/changes/migrate-to-claude-agent-sdk` task 6.1 (mapping half
only — the baseline half was already committed, see
`reports/06-registry-baseline.md`), plus 6.2, 6.3, 6.4 in full. Tasks 6.5/6.6
are explicitly out of this delegation's scope and untouched.

**Environment**: no live browser and no Anthropic API key were available in
this session, exactly as stated in the delegation. Every PASS below is real,
executed output against real source (via the same read-only extraction
technique `test/handlers.test.mjs` and `test/registry-baseline.test.mjs`
already use, or direct import of real ES modules) and fakes/injected doubles
for anything that would otherwise need a live browser, live wrangler, or a
live API key. Every BLOCKED item names the exact command needed to close it.
Nothing here is simulated as a pass.

## Files touched

Owned and edited:
- `host/agent/tools/mapping.js` (new)
- `host/agent/tools/adapter.js` (additive edits only)
- `host/codemode/common.js` (additive edits only — `SandboxLifecycle`,
  `SandboxUnavailableError`)
- `extension/background.js` (borrowed-tab scope only — see the diff summary
  below; every other line is untouched)
- `host/tool-definitions.js` (line-1 comment fix + one added comment block;
  zero changes to any `TOOLS` entry's name/description/paramShape)
- `test/registry-sdk-mapping.test.mjs` (new)
- `test/registry-borrowed-tab-scope.test.mjs` (new)
- `host/test/codemode-sandbox-lifecycle.test.mjs` (new)
- `host/test/recorder-companion-routing.test.mjs` (new)
- `openspec/changes/migrate-to-claude-agent-sdk/tasks.md` (group 6 checkboxes
  only)
- this report

Read for context, never edited: `host/agent/broker/tool-bridge.js`,
`host/agent/policy/authorization.js`, `host/agent/session/run.js`,
`host/agent/broker/browser-lease.js`, `host/agent/policy/approvals.js`,
`host/agent/companion.js`, `host/native-host.js`, `host/tool-runtime.js`,
`host/codemode/server-hybrid.js`, `host/codemode/server-codemode.js`,
`host/codemode/worker/worker.js`, every file under `extension/recorder/`.

`git diff --stat`-equivalent for `extension/background.js`: additive only —
one new module-level `currentToolMeta` + `isTabInWireScope`/`isInGroup`
enhancement + `sdkAgentCreatedTabs` set + `sdkTabsContext()` helper +
`tabNotAuthorizedResult`-equivalent inline text kept byte-identical for the
legacy path; `tabs_context_mcp`/`tabs_create_mcp`/`tabs_close_mcp` gain an
SDK-path branch; the native-port `tool_request` listener now builds a `meta`
object from `msg.runId`/`tabScope`/etc. (already sent by `host/tool-
runtime.js` since task group 3) and `handleToolRequest` sets/resets
`currentToolMeta` around each handler call. No other handler's signature or
behavior changed.

### Follow-up session: task 6.3's remainder (file-ownership boundary now clear)

Owned and edited in this follow-up:
- `host/agent/protocol.js` (additive — new `RECORDING_COMPLETE` message type
  and its doc comment; every existing export/type unchanged)
- `host/native-host.js` (additive — `routeFromExtension()`'s
  `recording_complete` branch gains a companion-forwarding block after its
  unchanged legacy fan-out; nothing else in the file touched)
- `host/agent/companion.js` (additive — `_handleRecordingComplete()`, a new
  `switch` case, an added import, and `PendingRecordingsStore` wired into
  `createRealCompanion()`; every other method unchanged)
- `host/agent/session/manager.js` (additive — `pendingRecordings` is an
  optional constructor dep defaulting to a real store, plus
  `activeConversationIdForRecording()`, `recordRecordingComplete()`,
  `listPendingRecordings()`; every existing method unchanged, every existing
  call site — `new SessionManager({ store, lease, approvals })` with no
  fourth arg — still works exactly as before)
- `host/agent/storage/pending-recordings.js` (new)
- `host/test/agent-recorder-push.test.mjs` (new)
- `openspec/changes/migrate-to-claude-agent-sdk/tasks.md` (6.3 checkbox only)
- this report (6.3 section)

Not touched: `extension/*`, `host/agent/settings/**`, `host/agent/secrets/**`,
`host/agent/spike/**`, `host/agent/tools/**`, `host/codemode/**`,
`host/tool-definitions.js`, `host/agent/policy/**`, `host/agent/broker/**`,
`host/agent/session/run.js`, `host/agent/session/token-batcher.js`,
`host/agent/storage/transcript-store.js`, `host/agent/storage/paths.js`,
`README.md`, `install.sh`, `install.ps1`.

## A hard constraint discovered while implementing 6.1, and how it was resolved

Every one of the 26 `toolHandlers` object methods in `extension/background.js`
is extracted **by exact signature text** — `test/_extract.mjs`'s
`extractMethod()` literally searches for `` `  async ${name}(args)` `` — by
BOTH `test/handlers.test.mjs` (out of this task's ownership, must keep
passing) and this task's own `test/registry-baseline.test.mjs`. Adding a
second `meta` parameter to any handler, or renaming any handler, breaks that
literal match for every one of the 26 tools, not just the ones this task
touches — confirmed by first attempting exactly that and watching both
suites fail with `method X not found`.

Resolved by never changing any handler's signature. Borrowed-tab-scope wiring
instead goes through a **module-level `currentToolMeta` variable**, set
synchronously by `handleToolRequest()` immediately before invoking a handler
— with zero `await` between the assignment and the handler's own first
(also-synchronous-until-its-own-`await`) statement, so no concurrent
dispatch can interleave and hand one call's meta to a different call. The one
handler that calls `isInGroup()`-equivalent logic more than once across
several `await`s (`tabs_close_mcp`) additionally captures its own local
`requestMeta` snapshot at entry, immune to the module-level variable being
overwritten mid-loop by an unrelated concurrent dispatch — proven structurally
by `test/registry-borrowed-tab-scope.test.mjs`'s last test.

The same constraint blocked literally renaming the SDK's `tool()` registration
to a friendly name: `host/test/agent-tool-adapter.test.mjs` (task group 3,
out of this task's ownership) asserts the registered name set is byte-
identical to `TOOLS.map(t => t.name)`. `host/agent/tools/mapping.js`'s
friendly-alias table is therefore real, bidirectional, and fully tested
(`test/registry-sdk-mapping.test.mjs`), wired into the adapter for
**description text only** today; the file's own header comment documents
exactly why the registered identifier itself is unchanged rather than
silently doing something that would break an existing, required-to-pass
suite.

## 6.1 (mapping half) — the 26-entry mapping table

| Legacy executor name | SDK-facing friendly alias | Mutation classification |
|---|---|---|
| tabs_context_mcp | `list_tabs` | read-only |
| tabs_create_mcp | `create_tab` | mutating |
| tabs_close_mcp | `close_tabs` | mutating |
| debug_timings | (same — no alias) | read-only |
| navigate | (same) | mutating |
| computer | (same) | **per-action** (screenshot/zoom/scroll/scroll_to/wait read-only; click/type/key/drag/hover mutating) |
| find | (same) | read-only |
| form_input | (same) | mutating |
| get_page_text | (same) | read-only |
| gif_creator | (same) | mutating |
| javascript_tool | (same) | mutating (arbitrary code — always conservative) |
| read_console_messages | (same) | read-only |
| read_network_requests | (same) | read-only |
| read_page | (same) | read-only |
| resize_window | (same) | mutating |
| shortcuts_list | (same) | read-only |
| shortcuts_execute | (same) | mutating |
| switch_browser | (same) | read-only |
| update_plan | (same) | read-only |
| debug | (same) | read-only |
| get_config | (same) | read-only |
| set_config | (same) | mutating |
| set_tab_focus | (same) | mutating |
| upload_image | (same) | mutating |
| retranscribe_recording | (same) | read-only |
| file_upload | (same) | mutating |

Generated live from `host/agent/tools/mapping.js` + `host/tool-definitions.js`
(not hand-copied):

```
$ node -e "...sdkFacingName()/_mutationClassificationCoverage() over TOOLS..."
tabs_context_mcp|list_tabs|read-only
tabs_create_mcp|create_tab|mutating
debug_timings|(same)|read-only
tabs_close_mcp|close_tabs|mutating
navigate|(same)|mutating
computer|(same)|per-action
find|(same)|read-only
form_input|(same)|mutating
get_page_text|(same)|read-only
gif_creator|(same)|mutating
javascript_tool|(same)|mutating
read_console_messages|(same)|read-only
read_network_requests|(same)|read-only
read_page|(same)|read-only
resize_window|(same)|mutating
shortcuts_list|(same)|read-only
shortcuts_execute|(same)|mutating
switch_browser|(same)|read-only
update_plan|(same)|read-only
debug|(same)|read-only
get_config|(same)|read-only
set_config|(same)|mutating
set_tab_focus|(same)|mutating
upload_image|(same)|mutating
retranscribe_recording|(same)|read-only
file_upload|(same)|mutating
```

`gif_creator`, `shortcuts_list`, `shortcuts_execute` remain the same
unimplemented stubs the committed baseline already recorded truthfully —
this task added no new real behavior for them, and the mapping/classification
table above records their **declared** contract (their real handler still
just returns a fixed "not supported" text block regardless of args).

## Borrowed-tab scope test matrix (design.md 5b)

| # | Property | Enforcement point | Test | Result |
|---|---|---|---|---|
| 1 | Read-only borrowed access works (a bound, never-grouped tab can still be read) | `extension/background.js`'s `isInGroup()` SDK-path branch | `test/registry-borrowed-tab-scope.test.mjs`: "a borrowed tab ... is authorized under SDK-path scope", "tabs_context_mcp under SDK-path scope reports the run's own tabs", "the SDK adapter allows a READ on the same borrowed tab" (registry-sdk-mapping) | PASS |
| 2 | Cleanup never closes a borrowed tab | `extension/background.js`'s `tabs_close_mcp` (2nd, independent gate) + `host/agent/tools/mapping.js`'s `enforceBorrowedTabScope` (primary, pre-dispatch gate) | `test/registry-borrowed-tab-scope.test.mjs`: "tabs_close_mcp REFUSES to close a borrowed tab"; `test/registry-sdk-mapping.test.mjs`: "the SDK adapter itself rejects a mutation on a borrowed tab" | PASS |
| 3 | Cleanup never regroups a borrowed tab | Structural: `tabs_create_mcp`'s schema takes **zero** input arguments — there is no way to pass an existing tabId into it, so it can only ever group a tab it just created itself | `test/registry-borrowed-tab-scope.test.mjs`: "tabs_context_mcp under SDK-path scope ... never touching the Chrome group" (no `tabs.group` call in the read path); `tabs_create_mcp`'s paramShape (`{}`) verified against the live registry in `test/registry-baseline.test.mjs` | PASS |
| 4 | Mutation without task authorization is rejected | `host/agent/tools/mapping.js`'s `enforceBorrowedTabScope` (pre-dispatch, primary) | `test/registry-sdk-mapping.test.mjs`: "mutation without task authorization is rejected; explicit authorization lifts it for that exact tab" (and proves authorization is scoped to the exact tab, not the whole run) | PASS |
| 5 | Agent-created tabs are distinguished from borrowed tabs, per run | `host/agent/tools/mapping.js` (`WeakMap` keyed by `Run`) + `extension/background.js` (`sdkAgentCreatedTabs` Set) | `test/registry-sdk-mapping.test.mjs`: "borrowed-tab classification is per-run — two different runs never share agent-created state"; `test/registry-borrowed-tab-scope.test.mjs`: "tabs_create_mcp under SDK-path scope records the new tab as agent-created", "tabs_close_mcp ALLOWS closing a tab this same run created" | PASS |
| 6 | Legacy managed-group behavior is unchanged | `extension/background.js`'s `isInGroup()` legacy branch (byte-identical body), every handler's rejection text unchanged when `currentToolMeta` is unset | `test/registry-borrowed-tab-scope.test.mjs`: "legacy path (no currentToolMeta) is BYTE-IDENTICAL to before" (×3: `isInGroup`, `tabs_context_mcp`, `tabs_close_mcp`); full re-run of `test/handlers.test.mjs` and `test/registry-baseline.test.mjs` (unmodified suites) still green | PASS |
| 7 | SDK tool descriptions no longer mandate creating a new tab | `host/agent/tools/mapping.js`'s `sdkFacingDescription()` | `test/registry-sdk-mapping.test.mjs`: "sdkFacingDescription() removes the 'mandate a new tab' wording ... without mutating host/tool-definitions.js" (and re-confirms the committed baseline snapshot is untouched) | PASS |
| 8 | Do not simply disable the membership check, and do not move the user's tab into the group | Design constraint honored by construction: `isInGroup()`'s SDK branch performs a REAL scope check (`isTabInWireScope`) rather than `return true`; nothing anywhere calls `chrome.tabs.group()` on a caller-supplied (as opposed to newly-created) tabId | Reviewed in source; `tabs_create_mcp`'s zero-argument schema (item 3 above) makes "move the user's tab into the group" structurally unreachable, not merely avoided by convention | PASS (structural) |

## Non-negotiable assertions — explicit verification

| Assertion | Evidence | Result |
|---|---|---|
| No dropped operation: all 26 reachable via the SDK mapping | `test/registry-sdk-mapping.test.mjs`: "every one of the 26 baseline entries has a legacy executor contract reachable via sdkFacingToolDefs()", "... is registered on the real SDK server via adapterToolNames()/KNOWN_TOOL_NAMES", "a real SDK tool call for every one of the 26 entries reaches the underlying legacy executor" | PASS |
| No model access to provider credentials via get_config/set_config | Re-verified from the SDK-adapter angle: `sdkFacingToolDefs()`'s `get_config`/`set_config` entries carry the EXACT SAME `paramShape` object as the shared registry (no SDK-only argument could smuggle a credential request through); `CONFIG_SCHEMA` itself re-verified unchanged by `test/registry-baseline.test.mjs` (`humanize`, `humanize_speed`, `audit_mode` only) | PASS |
| No generated JavaScript evaluated in Node | `host/test/codemode-sandbox-lifecycle.test.mjs`: structural (`common.js` source contains no `eval`/`new Function`/`vm`) + behavioral (a fake local HTTP server returns a canary value with no relation to the submitted code's real semantics; `runCode`/`SandboxLifecycle.runCode` return that canary verbatim, proving the code is never independently evaluated in the calling process) | PASS |
| Screenshots survive the SDK path as real image content, not text | `test/registry-sdk-mapping.test.mjs`: "screenshots survive the SDK path as REAL image content, never collapsed to text" (an `{type:"image",...}` block passed through `computer`'s SDK handler comes back byte-for-byte, including `data`/`mimeType`) | PASS |

## 6.2 — codemode sandbox lifecycle

Added `SandboxLifecycle`/`SandboxUnavailableError` to `host/codemode/
common.js` (additive; `startWorkerd`/`makeRunCode`/`installCleanup`/etc. all
unchanged, so `host/codemode/server-hybrid.js` and `server-codemode.js`
continue working exactly as before with zero edits). Real gap closed: the
existing `server-hybrid.js` `runCode`/`runCodeError` pattern only classifies
a sandbox that **never started**; a sandbox that starts fine and then
**exits mid-session** was previously invisible — a later `execute_code` call
would hang or throw a raw fetch failure against a dead port.
`SandboxLifecycle` listens for the child process's `exit`/`error` events and
transitions to a specific `unavailable` state with reason `"exited"`,
`"start_failed"`, or `"start_timeout"`, so `execute_code`-style callers get a
legible, typed error every time, and direct browser operations (which never
reference `SandboxLifecycle` at all) are structurally unaffected by any state
it is ever in.

```
$ node host/test/codemode-sandbox-lifecycle.test.mjs
... (11 checks across state-machine, direct-ops-isolation, and
    never-evaluated-in-Node sections)
10/10 passed
```

BLOCKED (live infra): an actual end-to-end run through real `wrangler dev` +
real workerd. Close with: `node host/codemode/test-hybrid.js` (spawns the
real hybrid server, which needs `npm install` already run inside
`host/codemode/worker/` and, for the passthrough-tool half of that smoke
test, the extension connected).

## 6.3 — recorder-to-companion routing

**Status: DONE.** The prior session (see history below) proved
`extension/recorder/*` and `extension/background.js`'s existing,
UNMODIFIED recorder-completion path are already channel-agnostic — a
recording saves to disk and produces a copy-able, client-neutral reference
before and independent of any channel-notify attempt — and stopped there
because the remaining wiring point (`host/native-host.js` +
`host/agent/companion.js`) was owned by a different, then-in-flight
delegation. That file-ownership boundary is now clear; this session closed
the remainder for real, against the file-ownership rules stated in its own
delegation (`host/native-host.js`, `host/agent/companion.js`,
`host/agent/protocol.js`, `host/agent/session/**`, `host/agent/storage/**`
owned; `extension/*`, `host/agent/settings/**`, `host/agent/secrets/**`,
`host/agent/spike/**` untouched).

### What was built

- `host/agent/protocol.js`: a new `RECORDING_COMPLETE` envelope type in
  `AGENT_MESSAGE_TYPES`, consistent with the existing message catalogue.
  Deliberately **not** gated behind the hello handshake — a recording is a
  fact about the browser bridge produced by the extension's toolbar
  recorder, independent of whether any sidepanel has ever opened, and the
  spec is explicit that this must work "without requiring a Claude Code
  channel." Its protocol version is still validated and fails closed exactly
  like every other envelope (design.md decision 1's "Unknown versions fail
  closed" is a protocol-wide invariant, not a hello-only one).
- `host/native-host.js`: `routeFromExtension()`'s existing `recording_complete`
  branch (which already fanned the extension's raw message out to every
  attached legacy MCP client — **unchanged, still runs first**) now also
  forwards the same facts to the supervised companion, wrapped as a versioned
  agent envelope via `companionChild.send(wrapAgentMessage(makeEnvelope(...)))`.
  Best-effort and additive: if the companion isn't up yet (`startCompanion()`
  is called first, mirroring `handleAgentMessageFromExtension`'s own pattern)
  the legacy fan-out and the on-disk save already done by
  `handleSaveRecording()` are completely unaffected.
- `host/agent/companion.js`: `CompanionCore._handleRecordingComplete()`
  validates the envelope version, normalizes the payload using the SAME
  field names the existing recorder wire contract already uses
  (`recording_id`/`path`/`schema`/`summary`/`transcript_status` on the wire,
  `recordingId`/`path`/`schema`/`summary`/`transcriptStatus` once inside the
  companion — matching `host/tool-runtime.js`'s `onRecordingEvent()` and
  `host/codemode/server-hybrid.js`'s channel bridge, not inventing a second
  naming convention), and delegates to the session manager.
- `host/agent/session/manager.js`: `activeConversationIdForRecording()`
  identifies the conversation to attach to — priority to whichever
  conversation's run currently holds the shared browser lease (it is the one
  actually driving the SAME browser bridge the recording was just captured
  through), falling back to the sole active run if unambiguous, else `null`
  ("no SDK run is active", the spec's exact phrase). `recordRecordingComplete()`
  either appends a `recording_complete` event to that conversation's
  transcript (idempotent by `recordingId` — a redelivered event is never
  appended twice, so the existing `afterSeq` resync mechanism a reopened
  panel already uses never replays it) or persists it via the new pending
  store.
- `host/agent/storage/pending-recordings.js` (new): `PendingRecordingsStore`
  — a companion-wide (not per-conversation, since no conversation claimed
  it), atomically-written (write-temp-then-rename, same convention as
  `TranscriptStore`), private-per-user (`agentRoot()`-scoped) JSON map of
  `recordingId -> { recordingId, path, schema, summary, transcriptStatus,
  receivedAt }`, keyed so a redelivery can never create a duplicate entry.
  Stores a **reference only** — never a copy of trace.json/audio/images,
  which stay exactly where `handleSaveRecording()` already puts them under
  `~/.config/open-claude-in-chrome/recordings/<id>/`, itself asserted
  unmodified by this task (structural test, below). This is the "listed for
  later attachment" half of the spec scenario; the future sidepanel "attach"
  action (group 5.3) is the eventual consumer of `listPendingRecordings()`
  and is out of this task's scope.

### Non-negotiables verified

- **Existing host storage format/location unchanged**: `handleSaveRecording()`
  in `host/native-host.js` was read, never edited, and a structural test
  (`extractFunction`, the same read-only-extraction technique
  `test/handlers.test.mjs` already uses) pins its exact
  `~/.config/open-claude-in-chrome/recordings/<recording_id>/trace.json`
  path template.
- **Recording data formats and OpenAI transcription config unchanged**:
  neither `extension/recorder/*` nor `extension/background.js` was touched
  by this session — `recorder-companion-routing.test.mjs` (below) still
  passes byte-for-byte unchanged, proving the artifact/schema/transcription
  layer this task depends on did not shift under it.
- **Legacy behavior intact**: a structural test confirms
  `routeFromExtension()`'s original client fan-out loop still runs, still
  unconditionally, and still BEFORE the new companion-forwarding code — a
  recording completing with no companion running (or an old build with no
  companion support at all) is saved and legacy-notified exactly as before.
- **No credential/secret in recorder metadata**: the new envelope and
  pending-store shape carry exactly `recordingId`/`path`/`schema`/`summary`/
  `transcriptStatus`/`receivedAt` — no provider credential, API key, or
  settings-profile field is threaded through this path anywhere (verified by
  reading every line touched; there is no code path in `_handleRecordingComplete`
  or `recordRecordingComplete` that reads `host/agent/settings/**` or
  `host/agent/secrets/**` at all).

### Evidence

```
$ node host/test/agent-recorder-push.test.mjs
12/12 passed
```

Covers: an unsupported protocol version failing closed with no hello ever
sent; a recorder event succeeding with no hello (no Claude Code channel
required); routing to the conversation holding the browser lease with exact
field/location round-trip and real sequence numbers; a recorder event with
zero active runs being persisted and listable, never silently dropped or
misattached; the pending-attachment reference's on-disk shape holding only
reference fields; two structural regression guards on `native-host.js`
(storage-path template unchanged; legacy fan-out still runs first); no
duplicate transcript event or pending entry on redelivery; a reconnecting
panel's `afterSeq` resync never replaying an already-seen recorder event; and
one true end-to-end test that spawns the REAL `native-host.js` (which forks
the REAL `companion.js`), drives it exactly as the extension does over
native-messaging framing with a raw `recording_complete` message, and reads
the REAL on-disk `pending.json` it wrote.

```
$ node host/test/recorder-companion-routing.test.mjs
11/11 passed
```

Unchanged — this task added a new routing path through files it owns
(`host/native-host.js`, `host/agent/companion.js`, `host/agent/protocol.js`,
`host/agent/session/manager.js`, `host/agent/storage/pending-recordings.js`);
it did not touch `extension/recorder/*` or `extension/background.js`, so the
prior session's suite needed no changes and still passes exactly as it did
before.

Nothing here required a live browser or a live Anthropic API key: every
acceptance-criteria item for this task (routing, association-when-active,
persistence-when-idle, resequencing on reconnect, format preservation,
version fail-closed) is genuinely testable offline, and was tested for real
— either against fakes for the SDK/profile (the only pieces that need a live
credential), or against the REAL `native-host.js`/`companion.js` process
pair for the wire-level routing itself.

### Prior session's history (superseded by the above, kept for context)

`extension/recorder/*` was grep-verified to contain **zero** references to
"Claude Code", "MCP", or "channel" — the artifact/schema/transcription layer
is already channel-agnostic by construction, and
`extension/background.js`'s existing, unmodified
`notifyClaude()`/`saveBundleToDisk()`/`buildRecordingReference()` already
save to disk and produce a copy-able, client-neutral reference before and
independent of any channel-notify attempt (re-verified for real via
extraction, not assumed). What remained unimplemented — pushing a live
`recording_complete` event into an ACTIVE companion conversation's
transcript, the way `host/codemode/server-hybrid.js` already does via
`host/tool-runtime.js`'s existing, generic `onRecordingEvent()` — needed an
equivalent subscriber added inside `host/agent/companion.js`, which was
outside that delegation's file ownership. Reported rather than forced
through an unowned file — closed above, this session.

```
$ node host/test/recorder-companion-routing.test.mjs
11/11 passed
```

## 6.4 — representative flows and full regression

Offline-testable flows — all executed for real this session:

```
$ node test/registry-sdk-mapping.test.mjs            -> 20/20 passed
$ node test/registry-borrowed-tab-scope.test.mjs      -> 11/11 passed
$ node host/test/codemode-sandbox-lifecycle.test.mjs  -> 10/10 passed
$ node host/test/recorder-companion-routing.test.mjs  -> 11/11 passed
$ node test/registry-baseline.test.mjs                -> ALL REGISTRY BASELINE TESTS PASSED (unmodified suite, re-verified clean)
$ node test/handlers.test.mjs                         -> ALL HANDLER TESTS PASSED (unmodified suite, re-verified clean)
```

Full existing-suite regression re-run (all required, all still green):

```
$ node host/test/endpoint.test.mjs                        -> 7/7 passed
$ node host/test/parent-watch.test.mjs                     -> 3/3 passed
$ node host/test/ownership.test.mjs                        -> 12/12 passed
$ node host/test/identity.test.mjs                         -> 20/20 passed
$ node host/test/agent-protocol.test.mjs                   -> 11/11 passed
$ node host/test/agent-native-handshake.test.mjs           -> 4/4 passed
$ node host/test/agent-chunked-transport.test.mjs          -> 10/10 passed
$ node host/test/agent-lease.test.mjs                      -> 12/12 passed
$ node host/test/agent-run-lifecycle.test.mjs              -> 19/19 passed
$ node host/test/agent-tool-adapter.test.mjs               -> 6/6 passed
$ node host/test/agent-companion-core.test.mjs             -> 14/14 passed
$ node host/test/agent-pipe-isolation.test.mjs             -> 3/3 passed
$ node host/test/agent-real-profile-integration.test.mjs   -> 3/3 passed
```

BLOCKED (live infra — no browser, no Anthropic API key available in this
session):

| Flow | Exact command to close it |
|---|---|
| Real read/action/vision recognition + dependent action | `node host/agent/spike/gate.mjs --live` (real browser attached, live `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`) |
| Real code-mode / `execute_code` round trip | `node host/codemode/test-hybrid.js` (needs `host/codemode/worker/` deps installed + extension connected) |
| Real recording capture + retranscription | Record via the extension toolbar, stop, then call `retranscribe_recording` with the real `recording_id` |
| Real browser handoff | `switch_browser` between two installed Chromium browsers with the extension enabled in both |
| Real upload/download/GIF scenario | `file_upload`/`upload_image` against a live page's `<input type=file>`; GIF export is currently an unimplemented stub in this build (`gif_creator`) regardless of live infra — see the committed baseline |

None of these are faked or stubbed into a false pass; each is named here with
the exact missing precondition, matching this task's environment-constraint
instruction.

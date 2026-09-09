# Assistant side panel — evidence report (tasks 5.1–5.4)

Change: `migrate-to-claude-agent-sdk`. Builds on task 5.0's shared visual
system (`extension/ui/**`, `reports/05-visual-system.md`) and task group 3's
versioned agent protocol (`host/agent/protocol.js`, `host/agent/companion.js`,
`reports/03-companion-evidence.md`), both read-only from this session.

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Platform | win32 x64 (Windows 11) |
| Node.js | v24.19.0 |
| Browser automation | `mcp__open-claude-in-chrome-hybrid__*`, real Chrome |

No live browser extension install and no live companion process were
available in this session (stated up front in the task delegation).
Consistent with that constraint: every test either (a) drives the panel's
own pure modules directly, or (b) drives them end-to-end against a REAL
`host/agent/companion.js` `CompanionCore` instance (imported read-only,
never modified) with only its SDK/profile-provider dependencies faked — the
"fake companion harness" the delegation asked for. Nothing is faked into a
false pass; every genuinely BLOCKED item below is named with the exact
missing precondition.

## Files added (this session's scope)

```
extension/sidepanel/sidepanel.html
extension/sidepanel/sidepanel.css
extension/sidepanel/sidepanel.js
extension/sidepanel/protocol-client.js
extension/sidepanel/panel-controller.js
extension/sidepanel/conversation-model.js
extension/sidepanel/history-store.js
extension/sidepanel/profile-cache.js
extension/sidepanel/page-context.js
extension/sidepanel/recordings-model.js
extension/sidepanel/tool-labels.js
extension/sidepanel/run-states.js
extension/sidepanel/markdown-lite.js

test/sidepanel-conversation-model.test.mjs
test/sidepanel-protocol-client.test.mjs
test/sidepanel-history-store.test.mjs
test/sidepanel-recordings-model.test.mjs
test/sidepanel-page-context.test.mjs
test/sidepanel-markdown-lite.test.mjs
test/sidepanel-fake-companion.test.mjs
test/background-agent-settings-relay.test.mjs   (mid-air coordinator request — see its own section below)

openspec/changes/migrate-to-claude-agent-sdk/reports/panel-captures/*.jpg  (68 files)
openspec/changes/migrate-to-claude-agent-sdk/reports/05-panel-evidence.md  (this file)
```

Files edited (in-scope, additive/backward-compatible):

```
extension/manifest.json     — sidePanel permission + side_panel.default_path,
                               options_page -> settings/settings.html,
                               action.default_title text.
extension/background.js     — sidePanel feature detection + toolbar
                               reassignment, panel_recorder_status /
                               panel_toggle_recording / panel_reattach_recording
                               messages, and the agent_settings relay
                               (createAgentSettingsRelay) — see its own
                               section below.
```

No file outside this list, `openspec/changes/migrate-to-claude-agent-sdk/tasks.md`
(5.1–5.4 checkboxes only), and reads of pre-existing files was created or
modified. `extension/settings/**`, `extension/ui/**`, `extension/recorder/**`,
`design-review/**`, and all of `host/**` were not touched (host files were
imported read-only by the test suite and by this report's research —
verified with `git status --porcelain host/` before finishing, showing only
the pre-existing modifications from other groups).

A QA-only visual-capture harness (`_qa_harness.html`, `_qa_harness_shim.js`,
`_qa_harness_drive.js`) was created under `extension/sidepanel/` to drive the
REAL, unmodified panel modules for screenshot capture (chrome.runtime/tabs/
storage shims + a small scripted fake companion per named state), then
**deleted** before finishing this task — it is not part of the shipped
extension, the same convention `reports/05-visual-system.md` used for its
own throwaway static file server. Its logic is fully described below so the
captures are reproducible.

## Architecture

- `run-states.js` — the 11 named phases (`RUN_PHASE`), Vietnamese labels,
  and the `.connection-state.is-*` class mapping (reusing only the three
  modifiers `extension/ui/components.css` already defines — `is-ready`/
  `is-connecting`/`is-error`; `stopped`/`interrupted` deliberately map to no
  modifier, i.e. the shared primitive's own neutral-gray default).
- `tool-labels.js` — pure Vietnamese human-readable labels for all 26
  registry tools (`host/tool-definitions.js`'s inventory) plus `execute_code`,
  computer-action-specific phrasing, and sensitive-argument redaction
  (password/token/secret-shaped field names, and a `form_input`/`computer`
  typed-text heuristic) — display-only, never touches what is actually
  dispatched.
- `markdown-lite.js` — a small, deliberately minimal Markdown-lite renderer
  that escapes **all** input before applying any formatting. This is a
  safety property, not just styling: assistant text and tool results can
  contain literal webpage content, and this file's own test
  (`test/sidepanel-markdown-lite.test.mjs`) proves a `<script>`/`<img
  onerror>` payload is never inserted as live HTML.
- `protocol-client.js` — envelope shaping and connection lifecycle over the
  `"ocic-agent"` port `extension/background.js` already relays; mirrors
  `host/agent/protocol.js`'s `AGENT_MESSAGE_TYPES` by hand (this file runs in
  the browser and cannot import that Node module — the same constraint
  `background.js`'s own `AGENT_PROTOCOL_VERSION` comment documents).
- `conversation-model.js` — the DOM-free per-conversation state machine. Key
  design decisions (see the file's own header for the full reasoning):
  1. One `assistant_turn` item per run (tool rows + one growing text field),
     not a flat interleaved list — matches
     `design-review/screens/chat-streaming.html`'s markup.
  2. `complete: true` is set **only** by a `run_done` event. Every other
     terminal event (`run_stopped`, `run_error`, `run_interrupted_by_restart`)
     leaves it `false` — the direct implementation of the non-negotiable
     "a partial response must never be shown as complete after interruption".
  3. **Reconnect dedup**: `host/agent/companion.js`'s live `stream_event`/
     `token_batch` forwarding does not stamp a `seq` on the inner event (only
     events read back from disk via `TranscriptStore.snapshot()` do — traced
     by reading `companion.js`'s `runAsForkedChild()`). Rather than trust a
     fragile client-side seq cursor across a reconnect, `applySnapshot()`
     always performs a **full rebuild**, discarding anything applied live
     beforehand. Since every live event is durably persisted before it is
     ever forwarded live, the disk-backed snapshot is always a superset —
     rebuilding from it can never lose information, and because it REPLACES
     rather than merges, it can never duplicate a row either.
  4. `host/agent/companion.js`'s `_handleStart` never persists the user's own
     prompt text as an event, so this model keeps its own local echo
     (`addLocalUserMessage`/`bindRunToLastUserMessage`, cached by
     `history-store.js`), with an honest `[Nội dung tin nhắn trước đó không
     có sẵn]` placeholder when no local record exists (e.g. resuming a
     conversation this browser profile never sent the prompt for).
- `panel-controller.js` — wires `protocol-client.js` to one-or-more
  `ConversationModel`s, `history-store.js`, and `profile-cache.js`; routes
  every envelope type; is what `test/sidepanel-fake-companion.test.mjs`
  drives directly.
- `history-store.js`, `profile-cache.js`, `recordings-model.js`,
  `page-context.js` — thin, individually unit-tested wrappers described in
  "Known gaps" below where they compensate for a protocol contract that
  doesn't fully exist yet.
- `sidepanel.js`/`sidepanel.html`/`sidepanel.css` — the only files that touch
  `document`/`chrome.tabs`/`chrome.runtime` for the main chat flow; ports
  `design-review/shell.css`'s layout into the real shipped panel, extended
  with the history/recordings screen toggle, the permission-card slot, and
  the connection-state/recorder-status rows this task owns.

## Protocol contract used (no second protocol invented)

Every wire message is one of `host/agent/protocol.js`'s documented
`AGENT_MESSAGE_TYPES`: `hello`/`hello_ack`/`version_mismatch`, `new`,
`resume`, `snapshot_request`/`snapshot`, `start`, `stop`,
`approval_decision`, `stream_event`, `token_batch`, `recording_complete`,
`error`. `APPROVAL_REQUEST` is defined by `protocol.js` but, confirmed by
reading the current `host/agent/companion.js`, is never actually emitted
anywhere yet (the SDK `canUseTool` wiring that would emit it belongs to a
different, not-yet-landed task). `conversation-model.js` defensively accepts
it in either of the two transmission shapes the rest of the protocol already
uses elsewhere (a dedicated top-level envelope, or nested inside a
`stream_event`'s `event`) so the panel is ready the moment that wiring
lands — this is documented explicitly in the file, not left implicit.

## State matrix — all 11 states, reachable and distinct

| Phase | Reached by | Unit-tested (`sidepanel-conversation-model`) | End-to-end against real CompanionCore (`sidepanel-fake-companion`) |
|---|---|---|---|
| empty | fresh conversation, no items | ✅ | ✅ |
| connecting | handshake not yet `ok` | ✅ | ✅ (hello handshake completing) |
| ready | idle, has history, no turn | ✅ | — (composable from empty/completed; directly asserted in the unit test) |
| queued | `run_queued` without `run_started` | ✅ | ✅ |
| streaming | `run_started`, no pending approval | ✅ | ✅ |
| waiting-for-permission | `approval_request` overrides streaming | ✅ | — (unit-tested; live emission not yet available from the host, see above) |
| stopping | client-optimistic, `markStopRequested()` before the ack | ✅ | ✅ |
| stopped | `run_stopped` (`reason==="user_stop"` or unlabeled) | ✅ | ✅ |
| interrupted | `run_interrupted_by_restart` (resume after a companion restart) | ✅ | ✅ (simulated real restart: a second `CompanionCore` sharing the same on-disk `TranscriptStore`) |
| completed | `run_done` (the **only** path to `complete: true`) | ✅ | ✅ |
| error | `run_error`, or a `run_stopped` with a non-`user_stop` reason on a turn that already carries `errorInfo` | ✅ | ✅ (profile-unavailable failure) |

A real host-behavior nuance found and fixed while building this: 
`host/agent/companion.js`'s `_runAfterLeaseGranted()` emits `run_error`
**then** calls `run.stop(reason)` for an internal failure (e.g. an
unavailable provider profile) — reusing the stop path for lease cleanup, not
a user-initiated Stop. A naive `run_stopped` handler would have downgraded
this to a plain "stopped" label, misrepresenting an internal failure as if
the user had pressed Stop. Fixed in `conversation-model.js`: a `run_stopped`
event on a turn that already carries `errorInfo` keeps the more specific
`error` lifecycle unless the reason is literally `"user_stop"`. Caught by
`test/sidepanel-fake-companion.test.mjs`'s "run_error" test failing until
this was corrected — left in this report per this delegation's root-cause
completion requirement, not silently fixed with no trace.

## Non-negotiable behaviors — proven, not asserted

- **A partial response is never shown as complete after interruption**:
  `turn.complete` is `false` for every terminal lifecycle except `done`,
  proven for both `stopped` and `interrupted` with real partial text
  preserved (`sidepanel-conversation-model.test.mjs`), and end-to-end with a
  REAL abort actually taking effect — the fake-companion stop test asserts
  text queued *after* the abort never arrives (`sidepanel-fake-companion
  .test.mjs`: "text queued after the stop never appears (the abort actually
  took effect)").
- **No generic retry for an uncertain mutation**: a `tool_result_unknown`
  row is labeled "Không tự động thử lại" (no automatic retry) and no
  `retry`/`retryable` field is ever attached to a failed/unknown row —
  asserted directly.
- **Sensitive arguments are never shown**: `redactArgsForDisplay`/
  `isSensitiveTypedInput` redact password/token/secret-shaped fields and a
  `form_input` typed value into a password-looking selector; proven the
  redacted text never appears in the rendered detail line.
- **Webpage/tool content is never live HTML**: `markdown-lite.js`'s escaping
  is proven against a literal `<script>`/`<img onerror>` payload.
- **Reconnect dedup**: `sidepanel-conversation-model.test.mjs` and
  `sidepanel-fake-companion.test.mjs` both prove applying a snapshot twice
  (simulating two reconnects) produces the exact same item/tool-row/text
  counts, not doubled — the latter using a REAL second `CompanionCore`
  instance and a REAL second `TranscriptStore` read from the same on-disk
  conversation.

## Visual acceptance — 66 real screenshots, 11 states × 320/400/480 × light/dark

All captures are real, rendered through the REAL, unmodified `sidepanel.js`/
`sidepanel.html`/`sidepanel.css` via the browser automation MCP, not a
mockup. `document.documentElement.scrollWidth` was checked equal to the
target width at every capture (no horizontal overflow at 320px, the hard
requirement). Files live in `reports/panel-captures/<state>-<width>-<theme>.jpg`:

| State | 320 | 400 | 480 |
|---|---|---|---|
| empty | ✅ | ✅ | ✅ |
| connecting | ✅ | ✅ | ✅ |
| ready | ✅ | ✅ | ✅ |
| queued | ✅ | ✅ | ✅ |
| streaming | ✅ | ✅ | ✅ |
| waiting-for-permission | ✅ | ✅ | ✅ |
| stopping | ✅ | ✅ | ✅ |
| stopped | ✅ | ✅ | ✅ |
| interrupted | ✅ | ✅ | ✅ |
| completed | ✅ | ✅ | ✅ |
| error | ✅ | ✅ | ✅ |

Plus two additional live-verification captures (not part of the 66-cell
matrix): `evidence-keyboard-focus-send.jpg` (visible focus ring on the Send
button after typing, Tab-reached) and `evidence-reduced-motion-streaming.jpg`
(the streaming cursor genuinely disappears under a real reduced-motion
signal — see "Keyboard and reduced-motion" below).

### How the screens were rendered (toolchain note, same limitation as 05-visual-system.md)

`navigate` cannot load a `file://` URL in this environment (reproduced
again, same failure mode `reports/05-visual-system.md` already documented).
Same workaround: a minimal dependency-free static file server
(`http`/`fs`/`path` only) bound to `127.0.0.1`, serving the repo root
read-only with `Cache-Control: no-store`, started and torn down for this
session only (confirmed `netstat -ano` shows nothing bound on its port
afterward).

The QA harness (`_qa_harness.html` + two small support scripts, deleted
before finishing — see "Files added" above) provided:
- A `window.chrome` shim faithful to the real wire contract: `runtime
  .connect({name:"ocic-agent"})` returns a fake port wired to a small
  scripted "fake companion" speaking the exact envelope shapes above
  (reproducing `background.js`'s real behavior of auto-sending hello and
  replaying current handshake state to a newly-connected port);
  `storage.local` as an in-memory object seeded with a complete
  `ocic_profile_cache_v1` for every state except `empty` (which
  deliberately keeps none, to demonstrate the spec's "First use" scenario);
  one fixed fake tab for `chrome.tabs.*`. `indexedDB` was the REAL browser
  API, left untouched (an honestly empty "ocic-recorder" database on this
  origin, not a fake result).
- A small drive script that calls the REAL `PanelController` methods
  (`sendMessage`/`stop`/`reopenConversation`) a real user action would
  trigger, for the states the fake companion's own scripted replies cannot
  reach alone (e.g. `stopping` needs an actual `panel.stop()` call after
  streaming starts).
- `window.__browzyPanelDebug` — the one line added to the REAL `sidepanel.js`
  (kept after cleanup, documented in that file as a debug/QA hook; exposes
  no secret, only the same conversation state already visible in the DOM)
  that let the harness drive the real controller instance without
  duplicating `sidepanel.js`'s own wiring.

Window-size-to-viewport calibration (same clamping behavior
`reports/05-visual-system.md` implicitly worked around by testing before
publishing): this environment's window manager enforces a ~516px minimum
window width; the actual chrome overhead measured was **exactly** 237px
width / 136px height regardless of target size (verified at three points:
800→563, 557→320, 637→400, 717→480). Every capture below 517px CSS width
therefore requested a window width of `target + 237` (e.g. 320px viewport →
557px window), confirmed by `scrollWidth`/`innerWidth` after every resize,
not assumed.

## Defects found and fixed during this task

1. **Duplicate user-message item on every run start.** The first version of
   `_turnFor()`'s `createIfMissing` path unconditionally inserted a new
   "user" item (from the local-prompt cache or a placeholder) even when
   `addLocalUserMessage()` had already inserted one moments earlier at Send
   time — producing two user bubbles per turn. Caught immediately by
   `test/sidepanel-conversation-model.test.mjs`'s "live sequence produced
   exactly one user item" assertion. **Fix:** extracted `_ensureUserItemForRun()`,
   which first checks whether a bound item already exists for that runId
   (checking `this.items`, not a separate flag) before falling back to the
   pending-index or local-prompt-cache paths.
2. **`run_stopped` silently downgraded an internal failure to "stopped".**
   Documented above under "State matrix".
3. **Test-harness timing artifact, not a product defect** (documented so a
   future reader doesn't misread it as one): the in-memory fake-companion
   bridge in `test/sidepanel-fake-companion.test.mjs` originally delivered
   replies **synchronously** within the caller's own call stack, which made
   the client-optimistic "stopping" sub-phase unobservable (a `run_stopped`
   reply would apply before the test's own next line ran) and caused a stop
   test to race ahead of the first streamed chunk. **Fix:** the harness's
   `deliver()` now always defers via `setTimeout(fn, 0)`, matching the
   genuine cross-process asynchrony real native messaging has — this is a
   test-harness realism fix, not a change to any shipped file.
4. **`extractFunction`'s brace-matching cannot see past a destructured
   parameter.** `createAgentSettingsRelay({ postToNative, ... })`'s
   destructuring `{...}` is the first `{` after the function name, so
   `test/_extract.mjs`'s brace-counter (used by the existing
   `test/handlers.test.mjs` pattern) matched only the parameter list, not
   the function body. **Fix:** the function now takes one plain `opts`
   object and destructures inside its own body — documented with a comment
   in `background.js` so a future edit doesn't reintroduce a destructured
   parameter without knowing why.

No visual/layout defects were found in the 66 captures themselves (all
`.tool-row`/`.permission-card`/`.error-banner`/list-item styling came
unmodified from `extension/ui/components.css`, already visually QA'd in
task 5.0). `extension/sidepanel/sidepanel.css`'s own new `overflow: hidden`
declarations were grepped and checked against
`reports/05-visual-system.md`'s specific caution (a tall `overflow:hidden` +
`border-radius` container silently failing to paint in this environment) —
none apply here (small fixed-size icon boxes, text-truncation overflow, and
the 1×1px `.sr-only` node only).

## Live verification (closing the two gaps from `reports/05-visual-system.md`)

**Keyboard-only focus traversal** — exercised live against the real panel
(`waiting-for-permission` and `completed` states, 320px):
Tab order reaches, in this sequence: history → settings → tool-row-summary
(expand) → Deny → Allow → pin → model choice → Send/Stop, then (composer
disabled during an active run) cycles out to the browser and back. On the
`completed` state (composer enabled, empty), the disabled Send button is
correctly excluded from the tab order until text is typed — verified by
typing into the composer and confirming Send becomes both `disabled:false`
and the very next Tab stop, with `document.activeElement.matches
(':focus-visible') === true` and a computed `outline: solid 2px rgb(138,
74, 50)` (the contrast-verified `--color-focus-ring` token from task 5.0) —
screenshotted as `evidence-keyboard-focus-send.jpg`. Every control the spec
names (send, stop [same button, different icon/label], model choice,
settings, history, permission allow/deny) was reached this way; recordings
are reached via the History screen's own tab-order (not re-verified here
since History is a `hidden` view swap, not overlapping DOM).

**Reduced motion** — exercised live against the REAL `extension/ui/theme.js`
code path, not a hand-set attribute: the QA harness patched
`window.matchMedia("(prefers-reduced-motion: reduce)")` to genuinely report
`matches: true` (a real `MediaQueryList`-shaped object) **before**
`theme.js`'s own module-level `initTheme()` ran, so `initTheme()`'s actual
production logic read it and set `data-motion="reduce"` on `<html>` itself
— confirmed the streaming cursor's computed `display` becomes `none` and
`--motion-duration` collapses to `0.01ms`, screenshotted as
`evidence-reduced-motion-streaming.jpg` (compare to `streaming-320-light
.jpg`, which shows the cursor).

**Genuinely BLOCKED, disclosed rather than faked**: a true OS/Chrome-level
`prefers-reduced-motion` toggle (CDP `Emulation.setEmulatedMedia`, or
Chrome's own `chrome://settings/accessibility` → "Reduce motion") was
attempted and is **not reachable** from this session: the browser-automation
MCP exposes no generic CDP-command tool, `chrome://` pages are explicitly
blocked from `computer`/screenshot automation ("Cannot access a chrome://
URL"), and toggling the user's real Windows-wide "Animation effects"
accessibility setting (`HKCU:\Software\Microsoft\Windows\CurrentVersion
\Explorer\Accessibility`) to force it is outside this task's scope — a
system-wide OS setting on the user's real machine should not be changed by
an autonomous sidepanel-implementation task. **Close with:** open DevTools →
More tools → Rendering → "Emulate CSS media feature prefers-reduced-motion:
reduce" (or `chrome://settings/accessibility` → Reduce motion, once
available in the installed Chrome channel) in a normal, non-automated
session, then reload `extension/sidepanel/sidepanel.html` and confirm the
same collapse observed above.

## Known gaps (host/** protocol surface, out of this task's ownership) — RESOLVED

Two real architectural gaps were found while wiring 5.3, both requiring a
change to `host/agent/protocol.js`/`host/agent/companion.js` (entirely off
limits to this task). **A later session, owning `host/agent/protocol.js`,
`companion.js`, `session/**`, and `storage/**`, closed both** without
touching `extension/**` (this file's own scope) at all — the panel code
described in this report is unmodified and now has a real companion-side
counterpart to call.

1. **No `LIST_CONVERSATIONS`/`DELETE_CONVERSATION` message type — RESOLVED.**
   `host/agent/protocol.js` now defines both (`AGENT_MESSAGE_TYPES
   .LIST_CONVERSATIONS`/`.DELETE_CONVERSATION`), gated behind hello exactly
   like `NEW`/`START`/`STOP` (consistent with the existing sequencing this
   report's own "Protocol contract used" section describes).
   `host/agent/companion.js`'s `_handleListConversations()` returns
   `session/manager.js`'s new `conversationSummaries()` (conversationId,
   createdAt, updatedAt, `interrupted`, and a live per-process
   `hasActiveRun`) — the exact interrupted-state field this report's
   `history-store.js` gap note above says the panel already threads through
   `HistoryStore.upsert({..., interrupted})`. `_handleDeleteConversation()`
   returns `{conversationId, deleted:true, hadActiveRun}`, removing only this
   app's own conversation directory (SDK artifacts included) and explicitly
   never a recording's own file (a separate tree entirely — design.md
   section 5's separate retention). A genuine race — an active run's own SDK
   `query()` generator unwinding asynchronously after abort, which could
   otherwise resurrect a just-deleted conversation directory via the
   transcript store's auto-vivify fallback — is closed with an explicit
   tombstone in `SessionManager`, proven by a dedicated test. This module's
   own local-index behavior (documented above) remains correct and can now
   additionally be reconciled against the host's authoritative list once a
   consuming session wires `history-store.js` to call it — that wiring is
   `extension/**` work, outside the closing session's ownership, and is not
   claimed done here.
2. **`agent_settings` companion-side handler — RESOLVED.** See the dedicated
   section below, whose own body is left as this report's original,
   now-historical account of the relay-only half; the companion-side half it
   was waiting on is described in `reports/03-companion-evidence.md`'s
   addendum and proven by `host/test/agent-settings-relay.test.mjs`.

Neither gap required any change to `extension/**` (the closing session's
`companion.js`/`protocol.js`/`session/manager.js` changes are consumed
through the exact wire contracts `settings-client.js`, `history-store.js`,
and `conversation-model.js` already documented in this report and in
`settings-client.js`'s own file header — no client-side change was needed or
made).

## Mid-task addition: `agent_settings` relay in `extension/background.js`

Partway through this task, the coordinator reported that
`extension/settings/settings.html` (tasks 4.4/4.5, a parallel session) had
landed and asked this session — as the owner of `extension/background.js` —
to implement the relay `extension/settings/settings-client.js` documents:
`chrome.runtime.sendMessage({type:"agent_settings", op, ...payload})` →
`{ok:true, result} | {ok:false, error:{code,message}}`.

**What was built** (`createAgentSettingsRelay()` in `extension/background.js`,
instantiated once and wired into the existing `chrome.runtime.onMessage`
listener and the existing `handleAgentMessage()`/`nativePort.onDisconnect`
paths):
- Reuses the exact existing versioned agent channel (wraps the request as
  `{v: AGENT_PROTOCOL_VERSION, type: "agent_settings", requestId, ...payload}`
  and posts it via the same `nativePort.postMessage({type:"agent_msg",
  envelope})` call the sidepanel's own hello/relay already uses) — no second
  channel, no parallel message format.
- Request/response correlation by a generated `requestId` (needed here,
  unlike the sidepanel's pure verbatim relay, because
  `chrome.runtime.sendMessage`'s single `sendResponse` must resolve with the
  ONE reply matching THIS call).
- A documented fallback: `host/agent/companion.js`'s real, generic
  `{type:"error", reason:"unknown_message_type", inReplyTo:"agent_settings"}`
  default-case reply (confirmed by reading the current file — no
  `agent_settings` case exists there yet) settles the oldest pending request
  with an honest `PROTOCOL_ERROR`, never a fabricated success.
- Fails closed immediately (no post attempted) when `nativePort` is not
  connected; times out (65s, matching design.md's 60s-startup + 30s-test
  budget) rather than hanging forever; every pending request is settled
  (never left hanging) on native-host disconnect.
- **Secret transience**: the API key travels through `handleRequest`'s
  `payload` spread and the single synchronous `postToNative` call argument
  only — never assigned to a variable that outlives that call, never
  logged, never written to `chrome.storage`. Grepped `background.js` after
  writing this to confirm no `dbg()`/`console.*` call anywhere receives the
  `agent_settings` envelope or its payload.
- Routable with no conversation/run active: `handleRequest`'s only
  precondition is `nativePort` being connected — no dependency on any
  conversation, run, or lease state, matching "first-run setup happens
  before any run exists".
- Checked the coordinator's `.btn[hidden]` specificity-trap warning against
  this panel's own code: the only `hidden`-attribute uses are
  `.tool-row-detail[hidden]` and `.slash-picker[hidden]` (both already have
  an explicit `[hidden]{display:none}` rule in `extension/ui/components.css`)
  and `#history-view[hidden]` (a plain, non-`.btn` div, with its own explicit
  rule added in `sidepanel.css`) — no `.btn`-classed element is ever hidden
  via the `hidden` attribute in this panel, so the trap does not apply here.
- Checked the coordinator's live-gateway findings against this code:
  `_applyStreamMessage` already ignores unknown content-block types
  (verified with a dedicated test using a leading `thinking` block — the
  actual text block still renders and the run still completes normally),
  and model catalog entries are used as fully opaque `{id, label}` pairs
  everywhere in this panel (grepped for any `"claude-"` assumption — none
  found) — a mixed-vendor catalog (`gpt-5.6-sol`, `grok-4.6`, `qwen3.6`
  alongside `claude-*`) needs no code change here.

**Is it covered by a test? Yes** —
`test/background-agent-settings-relay.test.mjs` (17 assertions, all real,
extracted from the SHIPPED `background.js` source via `test/_extract.mjs`'s
brace-matching, the same technique `test/handlers.test.mjs` already uses —
not a hand-maintained copy that can drift): request shaping, hello/version-
channel reuse, requestId correlation with two concurrent requests resolved
out of order, the generic-`unknown_message_type` fallback (using
`companion.js`'s real reply shape, not an invented one), no-connection
fail-closed, timeout, disconnect settling every pending request, and an
unrelated envelope type correctly left unconsumed.

**What was honestly NOT covered at the time this section was written, and
why**: a real end-to-end pass, because `host/agent/companion.js` did not yet
implement an `agent_settings` case (confirmed by reading the current file
immediately before writing this) — that half of the contract belonged to
whichever task was granted edit access to `host/agent/companion.js` next.
Every real request at the time resolved `{ok:false,
error:{code:"PROTOCOL_ERROR", ...}}` against a real companion, which was the
correct, honest behavior for an unimplemented op — never a false success.

**RESOLVED by a later session** (see `reports/03-companion-evidence.md`'s
addendum): `CompanionCore._handleAgentSettings()` now answers every op this
relay forwards (`get_profile`/`save_profile`/`set_credential`/
`remove_credential`/`test_capability`/`discover_models`/`export_profile`),
delegating to the real `host/agent/settings/profile.js`, with no change to
this relay itself (this file's own `background.js` code and
`test/background-agent-settings-relay.test.mjs` are untouched and still
pass). Proven end-to-end by the new `host/test/agent-settings-relay.test.mjs`
against the real companion + real settings module (a real fixture HTTP
server for `discover_models`/`test_capability`, memory-only credentials
throughout, never touching a real OS credential store).

## Test run — this session, real output

```
$ node test/sidepanel-conversation-model.test.mjs        -> 47/47 passed
$ node test/sidepanel-protocol-client.test.mjs            -> 20/20 passed
$ node test/sidepanel-history-store.test.mjs              -> 11/11 passed
$ node test/sidepanel-recordings-model.test.mjs           -> 14/14 passed
$ node test/sidepanel-page-context.test.mjs               -> 10/10 passed
$ node test/sidepanel-markdown-lite.test.mjs              -> 12/12 passed
$ node test/sidepanel-fake-companion.test.mjs             -> 25/25 passed (real host/agent/companion.js)
$ node test/background-agent-settings-relay.test.mjs      -> 17/17 passed
```

156 new assertions across 8 suites, all real, all passing.

## Full regression — every suite in `test/` and `host/test/`

```
$ for f in test/*.test.mjs; do node "$f"; done          -> 21/21 files PASS (includes all of the above plus every pre-existing suite: audit-segments, handlers, humanize-executor, humanize-planners, registry-baseline, registry-borrowed-tab-scope, registry-sdk-mapping, settings-ui-*)
$ for f in host/test/*.test.mjs; do node "$f"; done      -> 29/29 files PASS (agent-*, codemode-sandbox-lifecycle, endpoint, identity, ownership, parent-watch, recorder-companion-routing, secrets-*, settings-*, skills-*)
```

No regression in any pre-existing suite. `git status --porcelain host/`
after this session shows only the same pre-existing modifications other
groups already made — nothing new.

## Acceptance criteria — PASS/BLOCKED

| # | Item | Status |
|---|---|---|
| 1 | Every one of the 11 run states renders and is covered by a test against the fake companion harness | **PASS** |
| 2 | Reconnect resync produces no duplicate transcript or activity entries | **PASS** (proven twice: pure unit test and real-CompanionCore end-to-end, including a second independent reconnect) |
| 3 | Real screenshots exist for the required states × 3 widths × 2 themes | **PASS** (66/66, zero horizontal overflow) |
| 4 | Keyboard traversal and reduced-motion verified live, closing the two gaps | **PASS** for keyboard traversal (live, real panel). Reduced-motion: **PASS** for the real `theme.js` code path with a genuine `matchMedia` signal; **BLOCKED** for a true OS/Chrome-level toggle (exact reproduction command given above; not faked) |
| 5 | All existing suites still pass | **PASS** (21/21 `test/` files, 29/29 `host/test/` files) |
| 6 | This report records the state matrix, screenshot inventory, defect log, and PASS/BLOCKED per item | **PASS** (this document) |

## Scope discipline notes

- `extension/settings/**`, `extension/ui/**`, `extension/recorder/**`,
  `design-review/**`, and `host/**` were read for context only, never
  modified.
- `install.sh`/`install.ps1`/`README.md`/`REAL/`/`benchmark/`/`scratch/` were
  not touched.
- The QA-only harness files were deleted before finishing; `netstat -ano`
  confirms no leftover listener on the scratch static-file-server port.
- Task 5.13 (Browzy branding audit across every surface) is explicitly a
  separate task and was not attempted here beyond what 5.1/5.2 already
  required (the panel's own header/title/tooltip text uses "Browzy",
  per the spec's hard branding requirement on the panel itself) — the
  extension manifest's top-level `name`/`description` fields were
  deliberately left untouched as that full audit's own scope.

## Post-ship defect fix: "Chưa cấu hình nhà cung cấp" shown for a fully configured, fully tested provider

**Reported by the user, reproduced from their real machine, not hypothetical.**
Their real `agent-profile.json` (`baseUrl` `https://node1.viber.vn`, both
models present, `defaultModelId: "claude-sonnet-5"`, `hasCredential: true`,
`credentialRevision: 5`) had a passing `lastCapabilityTest` recorded at
`credentialRevision` **4** — i.e. the key was replaced (re-entered) after the
last successful test, which design.md decision 4 explicitly requires to
invalidate the stored result ("Key replacement invalidates compatibility
status"). The panel still showed the generic "unconfigured, add Base
URL/API key/model" banner, which is simply false for this profile — the
correct message is "the key changed, re-test the connection."

**Root cause, two parts, both real:**

1. `extension/sidepanel/profile-cache.js`'s `isProfileComplete()` and
   `extension/sidepanel/panel-controller.js`'s (duplicate, inline)
   `hasCompleteProfile()` both collapsed every not-ready reason into one
   boolean, and `sidepanel.js`'s `renderSetupBanner()` rendered one
   hardcoded message for every not-ready case — so a stale test looked
   identical to no configuration at all.
2. Deeper, and the reason the first fix alone would have shipped a nicer
   message for a state the user could never leave: **nothing ever wrote**
   `ocic_profile_cache_v1`. The settings page talks to the companion purely
   through the `agent_settings` request/response relay
   (`createAgentSettingsRelay()` in `extension/background.js`); no code
   mirrored that state into `chrome.storage.local` for a different
   extension page (the sidepanel) to read. The panel's `ProfileCache.read()`
   would see no cache at all and — correctly, per its own documented safe
   default — report "not configured", forever, regardless of what the
   settings page said.

**Fix, part 1 — `extension/sidepanel/profile-cache.js`:** replaced the single
boolean with `deriveReadinessState(profile)`, returning one of
`READINESS.{NOT_CONFIGURED, PARTIAL, NO_CREDENTIAL, UNTESTED, STALE,
TEST_FAILED, READY}`. `STALE` further reports `reason: "credential" |
"endpoint_or_model"` by checking whether any recorded `lastCapabilityTest`
entry shares the current `(baseUrl, defaultModelId)` prefix under a
different `credentialRevision` (same key format as
`host/agent/settings/profile-schema.js`'s `capabilityTestKey` — NUL-joined,
verified against the byte layout of a real on-disk profile, not the
misleading space rendering a plain text viewer shows). `isProfileComplete()`
is now a thin wrapper (`state === READY`) — a stale or failed test is never
treated as ready, and the exact reduced legacy shape
(`{models, defaultModelId, capabilityTest:{ok,at,credentialRevision}}`,
still used by `test/sidepanel-fake-companion.test.mjs` and
`test/sidepanel-slash-picker-dispatch.test.mjs`'s fixtures) still resolves
`READY`/`ready` identically to before — no regression on either file.
`panel-controller.js`'s own duplicate inline check was deleted in favor of
importing this one function (`hasCompleteProfile()` now just delegates),
and a new `readinessState()` method exposes the full breakdown.
`extension/sidepanel/sidepanel.js`'s `renderSetupBanner()` now renders six
distinct Vietnamese messages and, for every state a (re)test can resolve
(`UNTESTED`/`STALE`/`TEST_FAILED`), a direct "Kiểm tra kết nối"/"Kiểm tra
lại kết nối" button that opens `settings.html#btn-test-connection` — a
plain URL fragment matching that button's real, already-existing element id,
so Chrome scrolls it into view with no change to `extension/settings/**`
(out of this task's scope) — instead of a generic "Mở cài đặt" the user
would have to hunt through.

**Fix, part 2 — `extension/background.js`:** added the missing writer.
`toProfileCacheMirror(profile)` projects a full
`host/agent/settings/profile.js` `loadProfile()` result down to exactly
`profile-cache.js`'s documented non-secret contract (`profileId`, `baseUrl`,
`models`, `defaultModelId`, `revision`, `credentialRevision`,
`hasCredential` as a plain boolean, `lastCapabilityTest`) — never
`secretBackend`/`memoryOnlyCredential`, and obviously never the credential
itself, which `host/agent/settings/profile.js` never returns to this layer
in the first place. `writeProfileCacheMirror()` writes it (or `null`, which
clears the cache) to `chrome.storage.local`. The `chrome.runtime.onMessage`
`agent_settings` handler now calls `syncProfileCacheAfterAgentSettings(msg,
response)` **after** replying to the settings page (fire-and-forget — never
adds latency or a new failure mode to that response): `get_profile`/
`save_profile` replies already carry the full profile and are mirrored
directly; `set_credential`/`remove_credential`/`test_capability`/
`discover_models` replies carry only their own narrow result shape
(`{backend}`/`{removed:true}`/the raw capability-test result/
`{supported,...}`), so those four instead issue one supplemental
`get_profile` call through the exact same relay and mirror ITS result,
rather than hand-patching a guess. A failed op never touches the mirror.
`connectNativeHost()` also calls `refreshProfileCacheMirror()` on every
connect and reconnect (service-worker startup and every companion restart)
so a panel opened before any settings-page action still sees real state,
not an empty cache — `agent_settings` ops are deliberately not gated on the
hello handshake (see `host/agent/companion.js`'s `_handleAgentSettings`
header), so this does not need to wait for `hello_ack` either.
`createAgentSettingsRelay()` and `handleAgentMessage()` themselves are
byte-for-byte unchanged, so both of their existing extraction-based tests
(`test/background-agent-settings-relay.test.mjs`,
`test/overlay-background-bridge.test.mjs`) still pass unmodified.

**Tests added:**
- `test/sidepanel-readiness-states.test.mjs` — `deriveReadinessState()`
  for all six not-ready reasons plus `READY`; the user's exact real profile
  shape verbatim, asserting `STALE`/`reason:"credential"` (never
  `NOT_CONFIGURED`) both directly and wired through a real `ProfileCache` +
  `PanelController` against a fake `chrome.storage.local`; the two existing
  fixture files' legacy reduced shape still resolves `READY`/`UNTESTED`/
  `TEST_FAILED` correctly (no regression); and a structural check that
  `sidepanel.js` links every re-testable state to the real Test-connection
  control, not a generic "open settings".
- `test/background-agent-settings-profile-mirror.test.mjs` — the mirror
  writer for every one of the six ops, asserting exactly one
  `chrome.storage.local.set()` per op, the correct supplemental-`get_profile`
  behavior for the four narrow-reply ops, that a failed op never writes, that
  credential removal correctly clears `hasCredential`/`lastCapabilityTest`,
  the startup/reconnect populate path, and — the explicit non-negotiable —
  that no secret-shaped field or literal secret value ever appears in
  anything passed to `chrome.storage.local.set()`, asserting on the full
  written object each time, not a sampled field.

**Full regression, this fix:** `test/*.test.mjs` — 34/34 files pass
(the two new files plus every pre-existing one, including
`test/background-agent-settings-relay.test.mjs` and
`test/overlay-background-bridge.test.mjs`, both of which extract functions
this fix left untouched). `host/test/*.test.mjs` — 38/38 files pass, re-run
in full after this change.

**Scope note:** `extension/background.js` was out of this task's original
ownership (a parallel session was mid-edit on it); the coordinator
transferred ownership to this task once that session finished, specifically
to fix this defect's actual root cause rather than shipping a
better-worded message for a cache that would still never populate.
`extension/settings/**` and `extension/ui/**` were still not modified —
the settings page's own `id="btn-test-connection"` element (already present,
unchanged) is reused via a URL fragment, and `.setup-banner`/`.status-pill`/
`.btn`/icon primitives from `extension/ui/**` are reused unchanged in the
new banner states.

**Note on a third candidate bug investigated and retracted:** a live user
report of the model claiming "no permission" for `get_page_text`/`read_page`
on a specific tab was initially traced (by the coordinator) to
`extension/background.js`'s `isInGroup()` rejection message, and a
message-wording fix plus tests were drafted here. Further evidence (the
browser's own permission-request text) showed the actual cause is the Agent
SDK's own permission layer (`host/agent/tools/query-options.js`'s tool
allowlist), never reaching `extension/background.js`/`isInGroup()` at all.
That fix belongs to a different session owning `host/agent/tools/**`; the
draft fix and tests in this file's earlier revision were reverted in full —
`extension/background.js`'s `isInGroup()` and all 13 of its call sites are
byte-identical to before this session touched them, and
`test/registry-borrowed-tab-scope.test.mjs`/`test/handlers.test.mjs` are
back to their original content (both re-verified passing).

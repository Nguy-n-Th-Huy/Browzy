# Implementation evidence — add-live-streaming-and-thinking

One section per wave. Each section records the files it changed, the decisions
it settled, the exact commands that prove it, and what is still open.

## Wave 1 (host)

Status: **complete** — tasks.md 1.1–1.6 and 4.1 are checked off.
Scope boundary: `host/**` only. `extension/**` is untouched (Wave 2 owns the
panel model and render).

### Settled cross-wave contract (Wave 2 MUST pin exactly these)

- **Transient event type name: `stream_partial`** — exported by
  `host/agent/protocol.js` as `STREAM_PARTIAL_EVENT_TYPE` (kept the design.md
  working name; nothing forced a change). The panel cannot import a Node-side
  host module, so Wave 2 pins the literal `"stream_partial"` the same way
  `extension/sidepanel/panel-controller.js` already hand-syncs the other
  protocol literals. A host test asserts the literal, so a rename fails loudly
  instead of silently orphaning the panel.
- **Shape** (documented in `protocol.js` beside the other inner-event
  vocabularies):
  `{ type: "stream_partial", message: { type: "stream_event", event: <raw
  Anthropic stream event>, parent_tool_use_id, uuid, session_id } }`.
  The SDK message is carried **verbatim** under `message`, exactly as
  `stream_message` carries a complete one — so the raw event is
  `message.event` (with `event.type` ∈ `message_start`,
  `content_block_start`, `content_block_delta`, `content_block_stop`,
  `message_delta`, `message_stop`), and the assistant message id the panel
  reconciles against is `message.event.message.id` (from `message_start`).
- **Envelopes: unchanged.** Fragments ride inside the existing
  `TOKEN_BATCH` envelope as ordinary batch entries. Because the batcher now
  treats them as batchable, a fragment is never sent as a native message of
  its own — it is always one entry of a `token_batch`, usually in the same
  batch as the complete message it belongs to. No new envelope type, no
  envelope shape change, no `PROTOCOL_VERSION` bump.
- **No durable sequence.** A fragment carries no `seq` and is never appended
  by the durable sink, so it can never move `_highSeq`/`lastSeq` or enter
  history persistence in any panel.
- **Ignorable.** An older panel ignores an unknown inner event type: both
  `stream_event` and `token_batch` route inner events through
  `ConversationModel.applyEvent()`, whose `_applyEventToItems()` ends in a
  `default:` branch that ignores unknown types without throwing (no error
  state, no placeholder, complete messages still render as before).

### Files changed

| File | Change |
| --- | --- |
| `host/agent/tools/query-options.js` | `buildIsolatedOptions()` (the panel-run builder) returns `includePartialMessages: true`. Nothing else in that options object changed. |
| `host/agent/companion.js` | `_runQuery()`'s pump: an SDK message with `type === "stream_event"` is emitted as `{ type: STREAM_PARTIAL_EVENT_TYPE, message }`; every other message keeps `{ type: "stream_message", message }` unchanged. |
| `host/agent/session/manager.js` | `startRun()`'s `onEvent` sink returns early for a transient event, before the single `store.appendEvent` call — the append stays the only path to a stored record. |
| `host/agent/session/token-batcher.js` | `isStreamMessageEvent` widened to `isBatchableStreamEvent` (`stream_message` OR a transient event), used as the `TokenBatcher` default predicate. The pending-batch-first rule is untouched. |
| `host/agent/protocol.js` | New `STREAM_PARTIAL_EVENT_TYPE`, `TRANSIENT_EVENT_TYPES`, `isTransientEvent()`, with the shape/contract documented where the other inner-event vocabularies live. |
| `host/test/agent-run-lifecycle.test.mjs` | Four new tests (options flag + only-builder scope; pump identity/order + durable-store content; fragment name/classification contract; batch window + ordering). |

### Decisions

1. **Name: `stream_partial`** (design.md's working name), exported as a shared
   constant rather than a scattered literal — the sink and the batcher both
   read it.
2. **Verbatim SDK message under `message`** (not a flattened `{event, uuid}`
   shape): consistent with `stream_message`, and it keeps `uuid`,
   `session_id`, `parent_tool_use_id` and `ttft_ms` available to the panel
   without a second shape to maintain.
3. **One vocabulary module**: `protocol.js` owns the name and the transient
   classification; `manager.js` and `token-batcher.js` import `isTransientEvent`
   instead of duplicating the string (matches the file's existing role for
   `THREAT_EVENT_TYPES`).
4. **Predicate rename** `isStreamMessageEvent` → `isBatchableStreamEvent`:
   nothing outside `token-batcher.js` imported the old name (verified by
   repo-wide grep), and the old name would have lied — it now covers two
   event types.
5. **Fragments are batchable, not immediate** — that is what keeps a fragment
   from overtaking the tool/approval/lifecycle event that followed it. The
   consequence, documented in `protocol.js`, is that they always arrive
   inside `token_batch`.
6. **No durable-format, retention, replay or identity change**: the option
   flag is a single new key, and `buildPermissionPolicyIdentity()` only reads
   `tools`/`allowedTools`/`disallowedTools`, so binding an existing
   conversation to the new options object cannot produce a
   `conversation_identity_incompatible` rejection.
7. **Tests extended in the named file** (`agent-run-lifecycle.test.mjs`)
   rather than a new file: there is no aggregate host runner — each
   `host/test/*.test.mjs` is run directly — and the file already owns the
   `TokenBatcher` contract. Storage is isolated under a scratch
   `OCIC_AGENT_HOME`, never the operator's real agent home.

### Task 1.6 — every other run-event consumer audited

| Consumer | Verdict |
| --- | --- |
| `SessionManager.startRun()` onEvent sink (durable) | Changed: drops transient events before `store.appendEvent`. |
| `runAsForkedChild()`'s live forwarder (`TokenBatcher` + envelope wrapping) | Changed via the widened predicate: fragments are batched and forwarded under the existing envelopes. Exercised end-to-end by `agent-recorder-push.test.mjs`, which runs the REAL native host + REAL forked companion. |
| `host/native-host.js` | Passes agent envelopes through verbatim; its only inner inspection is envelope-level (`HELLO`). A fragment is opaque to it. |
| `extension/background.js` (not edited) | Inner-event checks are exact literals/Set membership (`OVERLAY_TEARDOWN_RUN_EVENTS`, `run_started`, `approval_request`, `tab_risk_update`); a fragment matches none, then the envelope is relayed verbatim to panel ports. |
| `extension/sidepanel/panel-controller.js` (not edited) | Routes both envelope types' inner events into `ConversationModel.applyEvent()`; unknown types are ignored by `_applyEventToItems()`'s `default:` branch — not treated as content, not an error. See "Unresolved" for the two Wave 2 follow-ups (window retention, per-batch history write). |
| External MCP entry points (`host/mcp-server.js`, `host/codemode/server-codemode.js`, `host/codemode/server-hybrid.js`) | They proxy browser tools over the native bridge/upstream MCP and never construct SDK query options, so they neither see nor consume run events. |
| Other SDK-query builders (`host/agent/enhance-prompt.js` `buildEnhanceOptions()`, `host/agent/settings/capability-test.js`) | Build their own options objects and never route through `buildIsolatedOptions()`, so enabling the flag cannot change their traffic. Pinned by a test assertion that the enhance options have no partial flag. |
| Durable-log readers inside `manager.js` (`recording_complete`, `download_decision_recorded`, `action_event` filters) | Exact-type filters; a `stream_partial` would be ignored by them even if one ever reached the log. |
| `host/agent/session/run.js` | Pure fan-out to the configured `onEvent` sink; no dispatch on event type. |

### Verification — exact commands and tails (all run from the repo root)

```
$ node host/test/agent-run-lifecycle.test.mjs                        EXIT=0
  PASS  the transient fragment event name and its transient-only classification are the fixed cross-wave contract
  PASS  buildIsolatedOptions enables the SDK partial-message stream for panel runs — and no other query builder does
  PASS  a stream_event SDK message is forwarded as a transient fragment; the complete message stays stream_message and is stored exactly once
  PASS  fragments share the one bounded batch window with complete messages and still arrive before the tool/lifecycle event that follows them

23/23 passed

$ node host/test/agent-companion-core.test.mjs                       EXIT=0
20/20 passed

$ node host/test/agent-threat-observe.test.mjs                       EXIT=0
ALL THREAT OBSERVATION TESTS PASSED

$ node host/test/agent-recorder-push.test.mjs                        EXIT=0
12/12 passed

$ node host/test/agent-tool-permission-preapproval.test.mjs          EXIT=0
5/5 passed

$ node host/test/agent-timeline-storage.test.mjs                     EXIT=0
28/28 passed

$ node host/test/settings-all.test.mjs                               EXIT=0
4/4 passed
All settings/secrets suites passed.

$ node host/test/agent-skills-wiring.test.mjs                        EXIT=0
8/8 passed

$ node host/test/chat-history-host.test.mjs                          EXIT=0
ALL CHAT-HISTORY HOST TESTS PASSED

$ node host/test/agent-context-channel.test.mjs                      EXIT=0
11/11 passed

$ node host/test/agent-conversation-metadata.test.mjs                EXIT=0
ALL CONVERSATION METADATA TESTS PASSED

$ node test/enhance-prompt-module.test.mjs                           EXIT=0
ALL ENHANCE-PROMPT MODULE TESTS PASSED
```

What the four new tests actually prove (the verification note attached to
tasks 1.6/4.1):

- The built panel-run options carry the partial flag, and the other query
  builder does not.
- A scripted partial stream driven through the **real** `CompanionCore`
  `_runQuery()` pump emits exactly `[stream_partial × 6, stream_message,
  run_done]`: every `stream_event` SDK message becomes a transient event with
  the SDK message forwarded verbatim, the complete assistant message stays
  `stream_message`, and both precede the run's terminal lifecycle event.
- The same run's `events.jsonl` contains no fragment (raw-file read, not just
  the snapshot), the snapshot contains exactly one `stream_message` and zero
  `stream_partial` entries, and only durable events carry a `seq`.
- Fragments and the complete message coalesce into one `token_batch` in SDK
  order, and a following non-batchable event (the `tool_rejected` shape a
  tool/approval/lifecycle event takes) flushes the pending batch first and
  arrives after it — the ordering property the design's decision 2 requires.

### Unresolved / carried forward

- **Wave 2 work is untouched**: tasks 2.1–2.7, 3.1–3.6, 4.2–4.4 and 5.1 remain
  open (panel model deltas/thinking/reconciliation, in-place render + the
  "Suy luận" block, panel tests, README note).
- **Intermediate-state note for Wave 2 (tasks 2.2/2.7)**: with the host change
  live and the panel unchanged, a fragment behaves exactly as the old panel's
  rules dictate — `applyEvent()` sees no `seq`, so no watermark moves and no
  dedupe is perturbed; the event is retained in the bounded `_windowEvents`
  and re-ignored on replay; `panel-controller.js` still calls
  `_persistHistoryEntry()` once per `stream_event`/`token_batch` regardless of
  what the batch contained. The model ignores the unknown type throughout, so
  nothing fragment-shaped is stored and the transcript is unchanged, but the
  redundant retention and the redundant history write are exactly what tasks
  2.2 and 2.7 remove. No host-side workaround was added, since hiding either
  host-side would require un-batching fragments (breaking ordering) or
  dropping them (breaking the feature).
- **No live-SDK end-to-end run** in this wave: this session has no live
  provider credential, so the pump is covered with a scripted SDK through the
  real `CompanionCore`, and the real forked-child wire path is covered by the
  existing recorder-push suite. The one unexercised combination is a real
  `query()` with `includePartialMessages` against a live gateway.

## Wave 2 (panel)

Status: **complete** — tasks.md 2.1–2.7, 3.1–3.6, 4.2–4.4 and 5.1 are checked
off (superseding the "Wave 2 work is untouched" note above, which described
Wave 1's own point in time). Scope boundary: `extension/sidepanel/**` and the
panel test suites; no `host/**` file was touched.

### Files changed

| File | Change |
| --- | --- |
| `extension/sidepanel/conversation-model.js` | New exported `STREAM_PARTIAL_EVENT_TYPE` (hand-synced with `protocol.js`); `applyEvent()` exempts the transient type from the window push and the watermark; `_applyEventToItems()` gains the fragment case; new `_applyStreamPartial`/`_appendPartialRun`/`_bufferFor`/`_bufferEntryFor`/`_retireBuffer`/`_dropPartialBuffers`/`_appendCompleteText`/`_appendCompleteThinking`; turns gain `thinking` + `redactedThinking`; complete-message text/thinking reconcile suffix-only against the per-run, per-message-id buffers; buffers cleared by `_resetItems()` (so `_reset()`, `applySnapshot()` and `_rebuildItems()` all clear them) and dropped at `run_done`/`run_stopped`/`run_error`/`run_interrupted_by_restart`. |
| `extension/sidepanel/panel-controller.js` | Imports the shared transient literal; new `isTransientFragmentEvent()`; `stream_event` skips `_persistHistoryEntry()` for a fragment, `token_batch` skips it when the batch was fragment-only (a mixed batch still persists). |
| `extension/sidepanel/sidepanel.js` | New `transcriptStructureSignature()`, `streamingTailNodes()`, `setNodeTextIfChanged()`, `paintStreamingTail()` and the `lastStructureSignature` gate in `renderTranscript()`; `renderProseHtml()` (stable `.stream-answer-text` node while live, `renderMarkdownLite()` once not live); `renderThinkingBlockHtml()` + `thinkingIsExpanded()` + `thinkingExpandedRuns` + `wireThinkingToggles()`/`toggleThinkingSummary()`; `renderTurnHtml()` composes both; `setOlderTranscriptStatus()` forces the structural render (its notice is not model state). |
| `extension/sidepanel/sidepanel.css` | New `.thinking-block`/`.thinking-summary`/`.thinking-glyph`/`.thinking-label`/`.thinking-body`/`.thinking-redacted` rules (subordinate, sunken, dashed disclosure, focus ring, pre-wrap, hidden state). |
| `README.md` | "Live answer and thinking" note in the side-panel status section: answer text and model thinking are shown live while a run is in flight, display-only, reconciled so nothing appears twice. |
| `test/sidepanel-conversation-model.test.mjs` | New "live fragments (2.1–2.7)" block: text before completion, watermark/window exemption (including a fragment carrying a bogus seq), suffix-only reconciliation, unknown-id append-once, non-prefix supersede (and anchored replacement after an earlier complete message), thinking from fragments and from complete messages, the redacted flag without data, a snapshot rebuild mid-message, an eviction rebuild, terminal drop at run_done/run_stopped/run_error, and unknown-type tolerance retained. |
| `test/sidepanel-fake-companion.test.mjs` | New block driving real `stream_event` SDK partials through the REAL CompanionCore/TokenBatcher/ProtocolClient/PanelController: fragments arrive live in `token_batch`, a fragment-only batch writes no history, the complete message reconciles exactly once, an unknown inner event type is ignored without error, and the on-disk transcript read back contains no fragment and exactly one complete message. |
| `test/sidepanel-streaming-render.test.mjs` | **New suite** — the shipped render functions extracted with `test/_extract.mjs`: live vs completed prose, the "Suy luận" disclosure markup/state/redaction, expansion defaults + explicit override, the structural signature's sensitivity, in-place painter node identity (answer node, cursor, redacted body), and streamed-then-completed === full render of the final state. |

### Decisions

1. **The transient literal is exported from `conversation-model.js`** and
   imported by `panel-controller.js` (rather than hand-syncing a second copy),
   so the model's exemption and the controller's history gate cannot drift; the
   host test pins the host-side literal, and this pair is the extension-side
   half of that contract.
2. **Fragments are applied BEFORE any window/watermark bookkeeping**, keyed on
   the event TYPE, not on the absence of `seq`. An unknown event type keeps the
   old contract (ignored, still retained) — pinned by a test — because graceful
   degradation of a future event kind rests on it.
3. **Buffers are per run × per message id, with start offsets.** The complete
   message appends the missing suffix when the buffer is a prefix and otherwise
   replaces exactly the span the fragments occupied (so an earlier complete
   message in the same turn survives a supersede). Buffers live in
   `_resetItems()`, the single place `_reset`, `applySnapshot` and
   `_rebuildItems` all pass through, so no rebuild path can leave a stale
   prefix.
4. **`renderTranscript()` stays the structural authority.** One
   `transcriptStructureSignature()` string encodes everything the markup's
   SHAPE depends on (conversation id, item kinds/order, turn lifecycle, text
   and thinking EXISTENCE but not length, tool-row statuses, warnings,
   documents, answer count, busy). Two renders with the same signature differ
   only in buffer CONTENT, so the in-place path paints the existing
   `.stream-answer-text` / `.thinking-body` nodes and returns; every other
   change takes the existing `innerHTML` renderer. A UI-only fact that is not
   model state (the older-window notice) forces the structural path explicitly.
5. **The live answer is plain text in one stable node; the finished answer is
   markdown.** Appending into existing nodes is what preserves node identity,
   so while live the prose is escaped text; on the first non-live render the
   structural renderer formats it through `renderMarkdownLite()` exactly as
   before this change. No renderer rewrite, no second transcript
   implementation.
6. **The thinking disclosure mirrors the action-timeline summary**: a real
   `<button>` with `aria-expanded`/`aria-controls`, a body that stays in the
   DOM with `hidden` when collapsed, and the same `.wired` re-render sentinel.
   `aria-expanded` is the toggle's source of truth so a live-default expansion
   can be explicitly collapsed. Expansion state is a module `Map` keyed by run
   id — never in the model, never persisted, never replayed — with the default
   "expanded while arriving, collapsed once not live" and an explicit override
   winning in either direction.
7. **`sidepanel.html` was not changed**: the transcript is generated HTML, so
   the block's markup lives in `renderTurnHtml` (like the timeline summary
   block) and its presentation in the stylesheet. A static template the
   renderer never clones would be dead markup. This is the only deviation from
   a literal reading of the design's file list, and reality forced it, as the
   design's decision 6 anticipated.
8. **Test-style note:** the new render helpers take plain `opts` parameters
   (assigned inside the body) rather than a destructured signature, because
   `test/_extract.mjs`'s brace-matching extractor stops at the first `{`; this
   keeps the shipped bodies directly testable, the same way `history-view.js`
   stays readable by the fake DOM.

### Render-path proof (tasks 3.1–3.6, 4.4)

- **No transcript rebuild while streaming:** `transcriptStructureSignature()`
  is asserted unchanged across growing answer text and growing thinking text,
  and changed by lifecycle, tool row, thinking appearing, busy presence, and
  conversation switch.
- **Node identity:** `paintStreamingTail()` is called twice on a fake-DOM
  subtree; the answer node, the streaming cursor that follows it, and a
  sentinel sibling keep their object identity and position, thinking streams
  into its own stable node, and an empty thinking buffer never overwrites a
  redacted block's placeholder.
- **Exactly-once content:** a model driven with fragments then the complete
  message renders byte-for-byte the same turn HTML as a model driven with the
  complete message alone, with identical `turn.text`.
- **Wiring is pinned on the shipped source:** `renderTurnHtml` composes
  `renderProseHtml`/`thinkingHtml`; `renderTranscript` calls
  `paintStreamingTail(nodes, latest)` behind the signature gate, wires the
  disclosure, and keeps exactly one `el.transcript.innerHTML = ...` authority.
- **Fragments never feed the polite live region:** nothing in this change
  writes `el.phaseAnnouncer`; the only announcements remain the pre-existing
  coarse phase and busy-transition strings, and the in-place path never moves
  the reading position unless the reader was already at the bottom (mirroring
  the structural path), and never touches focus or selection.
- Note: no live-installed-extension visual/AT run was possible in this
  environment (no browser session with the MV3 side panel loaded), consistent
  with the host wave's own limitation; keyboard semantics come from a native
  `<button>` plus the explicit Enter/Space handler, and the disclosure's
  320px/both-themes presentation is carried by the shared tokens the existing
  stylesheet already verifies.

### Verification — exact commands and tails (all run from the repo root)

```
$ node test/sidepanel-conversation-model.test.mjs                 EXIT=0  PASS=132
  PASS the replayed run_done is honoured
  PASS an overlapping live event at seq <= the watermark is dropped
  PASS a newer event is applied exactly once
  ALL SIDEPANEL CONVERSATION-MODEL TESTS PASSED

$ node test/sidepanel-fake-companion.test.mjs                    EXIT=0  PASS=89
  PASS the unknown transient event type was ignored without raising an error
  PASS the durable events that followed (the complete message and run_done) still persist history normally
  PASS the durable transcript contains no fragment entry at all
  PASS the complete assistant message is stored exactly once, not once per fragment
  ALL SIDEPANEL FAKE-COMPANION TESTS PASSED

$ node test/sidepanel-streaming-render.test.mjs                  EXIT=0  PASS=54
  PASS the streamed-then-completed text is exact, never duplicated
  PASS it equals the same final state reached with no fragments at all
  PASS and it renders byte-for-byte the same as a full render of that final state
  PASS ...through the normal markdown answer renderer
  ALL SIDEPANEL STREAMING RENDER TESTS PASSED

$ node test/sidepanel-chat-history-lifecycle.test.mjs            EXIT=0  PASS=74
  PASS the raced conversation keeps its capped model after the proof arrives
  ALL SIDEPANEL CHAT-HISTORY LIFECYCLE TESTS PASSED

$ node test/sidepanel-history-view.test.mjs                      EXIT=0  PASS=152
  PASS extension/sidepanel/sidepanel.js parses as a module
  ALL SIDEPANEL HISTORY-VIEW TESTS PASSED

$ node test/sidepanel-readiness-states.test.mjs                  EXIT=0  PASS=45
  PASS CHATGPT_SESSION_EXPIRED never offers a Test connection action
  ALL SIDEPANEL READINESS-STATE TESTS PASSED

$ node test/extension-scripts-parse.test.mjs                     EXIT=0  PASS=8
  8/8 passed

$ node test/extension-csp-no-inline-scripts.test.mjs             EXIT=0  PASS=15
  PASS extension/sidepanel/sidepanel.html: no inline event-handler attributes — none found
  ALL EXTENSION CSP GUARD TESTS PASSED
```

### Unresolved / carried forward

- **No live-SDK end-to-end run** in this wave either (same environment
  limitation as Wave 1): the fragment path is exercised through a scripted SDK
  through the real `CompanionCore`/`TokenBatcher`/`PanelController` and through
  the extracted shipped render functions. The unexercised combination remains a
  real `query()` with `includePartialMessages` against a live gateway, and a
  real browser/AT pass over the disclosure.
- **A live streamed answer is displayed as plain text until the message
  completes** (by design: node identity; the spec requires the text to be
  visible, not formatted). Markdown formatting lands one render later, at the
  first non-live render. Flagged so a future change can decide whether live
  markdown is worth a second streaming representation.
- **`thinkingExpandedRuns` module state is not cleared on conversation
  deletion** (same lifetime behavior as the pre-existing `timelineExpandedRuns`
  it mirrors); it is a small Map keyed by run id, never persisted. Left
  consistent with the existing pattern rather than diverging this change.

## Findings resolution (round-1 verification)

Status: **resolved** — the verifier's CRITICAL (split-id duplication) and
MAJOR (selection destroyed inside the live span) findings are fixed and
pinned; the defensive MINOR (subagent fragments merged into the operator's
turn) is implemented and pinned. **No task checkbox changed**: `tasks.md` is
still 1.1–5.1 all `[x]`, because this is a correction to already-checked work,
not new work. Scope touched: `extension/sidepanel/conversation-model.js`,
`extension/sidepanel/sidepanel.js`, the three panel test suites, one bullet of
`design.md`'s risk table, and this report. The verifier's third finding (no
live browser/AT pass) and its residual low-risk signature observations were
left as disclosed — they are environment limits, not defects.

### The corrected SDK granularity fact (what the CRITICAL rested on)

The pinned SDK documents the real granularity of a streamed response as **"one
assistant message per completed content block, so several consecutive assistant
messages can share `message.id` and each carries just that block in
`message.content`"** (`host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3316`).
The SDK also documents the stream events themselves as *preceding* the complete
message — "The complete assistant message still follows as its own message"
(`sdk.d.ts:4824`) — so `message_stop` can arrive **before** the complete
messages. That is why the verifier's first suggested fix (retire the buffer at
the fragment stream's own end, `message_stop`) was **not** what shipped: it
would retire the buffer before any complete message arrives, reproducing the
bug. The shipped fix is the report's second option — per-kind consumed offsets
— which reconciles correctly under either emission order. `design.md`'s
duplication risk bullet previously claimed "the impossible case for a correct
id match is duplication"; it now records the corrected granularity and the
consumed-offset rule.

### What changed

1. **CRITICAL — split-id duplication (`conversation-model.js`).**
   - Reproduced first, against the shipped model, with the verifier's own
     driver (`/tmp/browzy-verify/repro-split-id.mjs`, outside the repo):
     order `[thinking],[text]` → `turn.text = "Xin chàoXin chào"`; order
     `[text],[thinking]` → `turn.thinking = "cân nhắccân nhắc"`; the
     one-message-both-blocks control stayed clean. After the fix all three
     orders are clean.
   - Each message id's buffer is now per kind `{streamed, start}` (not a
     consume-once string), and `_reconcileCompleteBlock()` consumes a complete
     block three ways: **suffix-extension** (`text` extends the streamed run →
     append only the missing suffix), **head-consumption** (the streamed run is
     longer and starts with `text` — a later block of the same id was already
     streamed → consume that head and shift the anchor), or **supersede**
     (neither → replace exactly the span the fragments occupied, so an earlier
     complete message in the same turn survives).
   - Nothing is retired by the first complete message. `_releaseConsumedBuffer()`
     drops an id's entry only once neither kind has anything left unconsumed,
     and deliberately leaves `currentMessageId` open so a later block's
     fragments still re-open a buffer. Run-terminal (`_dropPartialBuffers`) and
     rebuild (`_resetItems`) drops are unchanged. `_retireBuffer`,
     `_appendCompleteText` and `_appendCompleteThinking` were deleted rather
     than left beside their replacements.
   - Pinned by new tests in `test/sidepanel-conversation-model.test.mjs`: both
     block orders with the **full fragment stream before both complete
     messages**, a streamed run longer than one block (text → tool_use → text
     under one id, where the first completion must not truncate text already on
     screen), and the pre-existing one-message-both-blocks shape (s4) still
     passes untouched. `test/sidepanel-fake-companion.test.mjs` now drives the
     real wire path with **two complete assistant messages sharing `msg_live`**
     (the SDK-documented shape) instead of one message with both blocks.
2. **MAJOR — selection destroyed inside the live span (`sidepanel.js`).**
   `setNodeTextIfChanged()` now grows the node's single text node in place when
   the new value is a prefix-extension of the current `data`
   (`child.data = next`), and falls back to `textContent = next` (children
   replaced) only on a supersede/redacted body. Element identity, the streaming
   cursor and the reading position are untouched exactly as before. Pinned by a
   new render test built on a browser-faithful single-text-node element: the
   text node's **object identity** survives two prefix-growth batches, and a
   non-prefix supersede still replaces the child.
3. **MINOR (defensive) — subagent frames merged into the operator's turn
   (`conversation-model.js`).** `_applyStreamPartial()` now ignores a fragment
   whose `parent_tool_use_id` is non-null, before any text/thinking/redaction is
   applied and before any buffer is opened. Pinned by a model test proving a
   subagent fragment contributes no text, no thinking, no redaction flag, opens
   no buffer, and leaves the operator's own stream reconciling normally.
   **Honest scope note:** this is a presentation-layer guard only — host
   forwarding is deliberately unchanged (the panel runs do not set
   `forwardSubagentText`, so only subagent `tool_use`/`tool_result` blocks are
   forwarded as messages; `sdk.d.ts:1727-1732`). Live-provider confirmation of
   subagent frame traffic was **not possible** in this environment (no live
   credential/gateway — the same disclosed limitation), so the guard rests on
   the pinned SDK's documented `parent_tool_use_id` semantics (`sdk.d.ts:3316`,
   `:3330`, `:4824`), not on an observed subagent stream.

### New-test proof: they fail on the pre-fix code

A throwaway copy of `test/` + `extension/` (plus a junctioned `host/` for the
companion suite) with **only these three source changes reversed** was run
against the new tests:

```
$ node test/sidepanel-conversation-model.test.mjs   (pre-fix sources)  EXIT=1
  FAIL the SECOND complete message sharing the id does not duplicate the answer text
  FAIL ...and the thinking message that follows still reconciles suffix-only
  FAIL the first block completes without truncating the later text the stream already showed for the id
  FAIL a subagent fragment contributes no text or thinking to the operator's turn
  FAIL ...and not even a redaction flag
  FAIL ...and opens no buffer the operator's own messages would be reconciled against
  FAIL the operator's own stream still streams and reconciles normally after an ignored subagent frame
  7 FAILED

$ node test/sidepanel-streaming-render.test.mjs     (pre-fix sources)  EXIT=1
  FAIL ...by writing into the SAME text node (the range a selection would be anchored in survives)
  FAIL ...and it stays that same node across further batches
  2 FAILED

$ node test/sidepanel-fake-companion.test.mjs       (pre-fix sources)  EXIT=1
  FAIL the complete message reconciles with the fragments — the answer appears exactly once
  1 FAILED
```

On the shipped fix the same suites are green (tails below).

### Verification — exact commands and tails (all run from the repo root)

```
$ node test/sidepanel-conversation-model.test.mjs           EXIT=0  PASS=148
  PASS one streamed id: the fragments of both blocks are shown before either completes
  PASS the first complete block (thinking) still reconciles, appending nothing new
  PASS the SECOND complete message sharing the id does not duplicate the answer text
  PASS ...and leaves the already-completed thinking exactly once
  PASS run-terminal drops still clear the id's buffer after a split completion
  PASS with the text message first, the answer is not duplicated either
  PASS ...and the thinking message that follows still reconciles suffix-only
  PASS ...without touching the answer
  PASS both text blocks of the id stream into the answer in order
  PASS the first block completes without truncating the later text the stream already showed for the id
  PASS the later block of the same id then appends only its missing suffix
  PASS a subagent fragment contributes no text or thinking to the operator's turn
  PASS ...and not even a redaction flag
  PASS ...and opens no buffer the operator's own messages would be reconciled against
  PASS the operator's own stream still streams and reconciles normally after an ignored subagent frame
  PASS a newer event is applied exactly once
  ALL SIDEPANEL CONVERSATION-MODEL TESTS PASSED

$ node test/sidepanel-streaming-render.test.mjs             EXIT=0  PASS=60
  PASS the live answer starts as one text node inside the shipped span shape
  PASS a prefix-growth batch extends the text
  PASS ...by writing into the SAME text node (the range a selection would be anchored in survives)
  PASS ...and it stays that same node across further batches
  PASS a non-prefix supersede still replaces the text correctly
  PASS ...and that replacement is a real child replacement, exactly as before
  PASS the streamed-then-completed text is exact, never duplicated
  PASS it equals the same final state reached with no fragments at all
  PASS and it renders byte-for-byte the same as a full render of that final state
  PASS ...through the normal markdown answer renderer
  ALL SIDEPANEL STREAMING RENDER TESTS PASSED

$ node test/sidepanel-fake-companion.test.mjs               EXIT=0  PASS=89
  PASS streamed answer fragments reach the panel model live through the real token_batch envelope
  PASS the complete message reconciles with the fragments — the answer appears exactly once
  PASS ...and the complete thinking block appends only its missing suffix
  PASS the durable transcript contains no fragment entry at all
  PASS each of the id's complete block messages is stored exactly once, not once per fragment
  ALL SIDEPANEL FAKE-COMPANION TESTS PASSED

$ node test/extension-scripts-parse.test.mjs                EXIT=0  PASS=8
  8/8 passed

$ node test/extension-csp-no-inline-scripts.test.mjs        EXIT=0  PASS=15
  PASS extension/sidepanel/sidepanel.html: no inline <script> (element without a src attribute) — none found
  PASS extension/sidepanel/sidepanel.html: no inline event-handler attributes (onclick=, onload=, onchange=, ...) — none found
  ALL EXTENSION CSP GUARD TESTS PASSED

$ node test/sidepanel-history-view.test.mjs                 EXIT=0  PASS=152
  PASS extension/sidepanel/sidepanel.js parses as a module
  ALL SIDEPANEL HISTORY-VIEW TESTS PASSED

$ node test/sidepanel-chat-history-lifecycle.test.mjs       EXIT=0  PASS=74
  PASS the raced conversation keeps its capped model after the proof arrives
  ALL SIDEPANEL CHAT-HISTORY LIFECYCLE TESTS PASSED
```

### Still unresolved (unchanged, environment limits)

- **No live browser/AT pass** over the disclosure or the in-place path — the
  same disclosed limitation as both waves; the selection guarantee is pinned by
  DOM object identity rather than observed in a real browser.
- **No live provider run** with `includePartialMessages`; the split-id shape is
  driven from the pinned SDK's documented granularity through the real
  companion/transport path, not from a captured live stream.
- **Live-provider confirmation of subagent fragment traffic** was not possible;
  the guard is defensive and presentation-layer only (above).

## Findings resolution (round 2)

Status: **resolved** — the round-2 verifier's CRITICAL (the in-place painter
still destroyed a selection/caret inside the live answer) is fixed by writing
only the delta into the existing text node, and the pinning test now pins that
mechanism instead of node identity alone. The verifier's MINOR (stale decision-4
wording) is corrected. **No task checkbox changed**: `tasks.md` is still
1.1–5.1 all `[x]`; this corrects already-checked work, it is not new work.
Scope touched: `extension/sidepanel/sidepanel.js` (the painter), one render
test, one sentence of `design.md`, and this report.

### What round 2 found

Round 1 replaced the wholesale `innerHTML` rebuild with a single in-place text
node, but the growth path still assigned the **whole** string to that node
(`child.data = next`, sidepanel.js). Per the DOM "replace data" algorithm, that
is a replace over the entire already-visible range, which resets any live Range
whose endpoint lies inside it. The round-2 verifier proved this in a **real
Chromium session** (headless puppeteer driving the shipped `renderProseHtml` +
`paintStreamingTail` + `setNodeTextIfChanged` over the shipped live markup): a
selection over already-streamed text (`Xin`, Range 0–4) collapsed to 0–0 after
one 75 ms batch, and a caret at the end of the live text was yanked to offset 0.
The same probe with `child.appendData(next.slice(child.data.length))`
substituted preserved both the selection and the live Range across two batches
with **byte-identical final text**. So the destructive write was the remaining
root cause; the round-1 fix moved the object it was written to, not the write
itself.

The round-1 test could not see this: it asserted only that the text node's
object identity survived (`answer.firstChild === originalTextNode`), which is
true whether the update is a safe append or a whole-`data` rewrite. A test named
for the guarantee it did not test.

### What changed

1. **CRITICAL — prefix growth rewrites the whole text node
   (`extension/sidepanel/sidepanel.js`).** In `setNodeTextIfChanged()`, the
   prefix-growth branch now writes **only the missing delta** into the existing
   text node:
   `child.appendData(next.slice(child.data.length))`, still guarded on
   `next.startsWith(child.data)` (so a non-prefix buffer cannot append a
   nonsense suffix). Whole-text replacement (`node.textContent = next`) remains
   **exclusively** for the paths it is correct for: the initial paint of an
   empty node, a supersede (non-prefix buffer), and a redacted body — none of
   which has a live selection to preserve. The early no-op return when
   `child.data === next` is unchanged. No other part of the in-place path
   changed.
2. **Test truthfulness (`test/sidepanel-streaming-render.test.mjs`).** The test
   previously named "a growing streamed answer keeps ONE text node (a selection
   inside it survives every batch)" is renamed to "prefix growth APPENDS only
   the delta into one text node (a live selection inside it survives every
   batch)" and now proves what the name claims. Its browser-faithful text node
   records **how** it is written to — `data`-setter calls vs `appendData` /
   `insertData` calls — because identity alone cannot distinguish a
   selection-safe update from a selection-destroying one. It asserts: growth
   calls `appendData` with the exact delta and **never** assigns whole `data`;
   each batch appends only its own delta; a repeated-text batch is a no-op;
   a non-prefix supersede still replaces the child (and the retired node is
   dropped, not rewritten); and the initial paint of an empty node still goes
   through `textContent` (the append path is growth-only). No assertion was
   removed or weakened.
3. **MINOR — stale design wording (`design.md` decision 4).** "the buffer entry
   is then retired" predated the round-1 split-id fix and contradicted the
   shipped lifecycle. It now records what ships: each block is reconciled
   against its **kind's** buffer (suffix-extension, head-consumption, or
   span-supersede), nothing is retired per complete message, and an id's entry
   is released only once neither kind has anything left unconsumed — with the
   id deliberately left open so a later block's fragments re-open a buffer.
   This matches the risk-table bullet and `_releaseConsumedBuffer()`
   (`conversation-model.js`).

### Falsifiability proof: the strengthened test fails on the old mechanism

The precise regression the finding describes was applied to the shipped file
(`child.appendData(next.slice(child.data.length))` → `child.data = next`),
the suite run, and the file restored:

```
$ node test/sidepanel-streaming-render.test.mjs        (old whole-`data` mechanism)  EXIT=1
  FAIL ...as the exact delta, appended — so the replace-data algorithm never touches the visible range
  FAIL ...and never by assigning the whole `data` (which would collapse a selection or caret inside it)
  FAIL ...each batch appending only its own delta
  FAIL ...with no whole-`data` write ever occurring while the text only grows
  FAIL a batch that repeats the same text is a no-op, not a rewrite
  FAIL ...so the superseded node is dropped, not rewritten in place
  6 FAILED
```

On the shipped append mechanism the same suite is green (tail below). This is
the falsifiability the round-1 test lacked.

### Verification — exact commands and tails (all run from the repo root)

```
$ node test/sidepanel-streaming-render.test.mjs             EXIT=0
  PASS the live answer starts as one text node inside the shipped span shape
  PASS a prefix-growth batch extends the text
  PASS ...by writing into the SAME text node (the node a selection would be anchored in survives)
  PASS ...as the exact delta, appended — so the replace-data algorithm never touches the visible range
  PASS ...and never by assigning the whole `data` (which would collapse a selection or caret inside it)
  PASS ...and it stays that same node across further batches
  PASS ...each batch appending only its own delta
  PASS ...with no whole-`data` write ever occurring while the text only grows
  PASS a batch that repeats the same text is a no-op, not a rewrite
  PASS a non-prefix supersede still replaces the text correctly
  PASS ...and that replacement is a real child replacement, exactly as before
  PASS ...so the superseded node is dropped, not rewritten in place
  PASS the initial paint of an empty node still goes through textContent (the append path is growth-only)
  ALL SIDEPANEL STREAMING RENDER TESTS PASSED

$ node test/sidepanel-conversation-model.test.mjs           EXIT=0
  PASS the SECOND complete message sharing the id does not duplicate the answer text
  PASS the first block completes without truncating the later text the stream already showed for the id
  PASS a subagent fragment contributes no text or thinking to the operator's turn
  PASS a newer event is applied exactly once
  ALL SIDEPANEL CONVERSATION-MODEL TESTS PASSED

$ node test/sidepanel-fake-companion.test.mjs               EXIT=0
  PASS streamed answer fragments reach the panel model live through the real token_batch envelope
  PASS the complete message reconciles with the fragments — the answer appears exactly once
  PASS the durable transcript contains no fragment entry at all
  PASS each of the id's complete block messages is stored exactly once, not once per fragment
  ALL SIDEPANEL FAKE-COMPANION TESTS PASSED

$ node test/extension-scripts-parse.test.mjs                EXIT=0
  8/8 passed

$ node test/extension-csp-no-inline-scripts.test.mjs        EXIT=0
  PASS extension/sidepanel/sidepanel.html: no inline <script> (element without a src attribute) — none found
  PASS extension/sidepanel/sidepanel.html: no inline event-handler attributes (onclick=, onload=, onchange=, ...) — none found
  ALL EXTENSION CSP GUARD TESTS PASSED
```

### Honest notes and remaining limits

- **The real-browser evidence is the round-2 verifier's, not this pass's.** The
  DOM semantics that make this fix necessary (`data =` collapses a live range;
  `appendData` preserves it with byte-identical text) were **observed by the
  round-2 verifier in a real Chromium session** driving the shipped functions
  — that observation is what turned the round-1 inference into fact. This pass
  added no browser probe of its own; it pinned the mechanism those observations
  implicate and verified it in the suite's fake DOM (including the falsified
  regression above).
- **Still no live-installed-extension / AT pass.** The same environment limit
  both prior reports disclose stands: the change has not been exercised as a
  real MV3 side panel with a screen reader, so the end-to-end "the operator's
  selection survives while the answer streams" claim is supported by the
  shipped-mechanism pin plus the verifier's isolated real-Chromium DOM probe,
  not by an installed-extension run.
- **No live provider run** with `includePartialMessages`, and **no
  live-provider confirmation of subagent fragment traffic** — unchanged from
  the sections above.


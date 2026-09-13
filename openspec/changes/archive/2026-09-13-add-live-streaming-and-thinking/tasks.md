## 1. Host: transient live fragments

- [x] 1.1 Set `includePartialMessages` in `buildIsolatedOptions()` (`host/agent/tools/query-options.js`) so the panel run's SDK query emits raw stream events; change nothing else in that options object, and leave the prompt-enhancement and external MCP option builders untouched.
- [x] 1.2 Give streamed fragments their own transient event identity in the `_runQuery()` pump (`host/agent/companion.js`): a `stream_event` SDK message is forwarded as the transient event type, a complete assistant/user message keeps `stream_message` unchanged.
- [x] 1.3 Make the durable sink skip the transient type in `SessionManager.startRun()`'s `onEvent` (`host/agent/session/manager.js`) so `store.appendEvent` never sees a fragment, keeping the append as the only path to the stored record.
- [x] 1.4 Widen the batch predicate in `host/agent/session/token-batcher.js` (`isStreamMessageEvent`) to also cover the transient type, so fragments and complete messages share the existing bounded window and the pending-batch-first rule still orders text before tool, approval and lifecycle events.
- [x] 1.5 Document the transient event's shape beside the existing stream envelopes in `host/agent/protocol.js`, stating that it is additive, carries no durable sequence, and must be ignorable by a panel that does not know it.
- [x] 1.6 Confirm every other consumer of run events (external MCP entry points, other host modules) ignores the transient type rather than treating it as content or an error. ← (verify: a run whose answer streams produces a durable transcript with each complete message exactly once and no fragment entry; the built options contain the partial flag; fragments arrive live and in order relative to the tool events that follow them)

## 2. Panel model: deltas, thinking, reconciliation

- [x] 2.1 Add the transient fragment case to `_applyEventToItems()` (`extension/sidepanel/conversation-model.js`): `message_start`, `content_block_start`, `content_block_delta` and `content_block_stop` for `text_delta` and `thinking_delta`; discard `input_json_delta` (live tool-argument streaming is out of scope) and anything else.
- [x] 2.2 Apply fragments to the turn without retaining them in the event window and without advancing `lastSeq`/`_highSeq`; leave the existing behavior for unknown event types (ignored, no throw) exactly as it is, since graceful degradation depends on it.
- [x] 2.3 Track per-run, per-message-id buffers of the answer text and thinking already displayed, and reconcile the complete assistant message by appending only the missing suffix; a complete message with no buffer appends in full once, and a buffer that is not a prefix of the complete text is superseded by it.
- [x] 2.4 Keep fragments feeding the existing derivations: answer fragments set `lastContentKind = "text"` exactly as complete text blocks do, and the existing `text`, `tool_use` and `tool_result` handling is unchanged.
- [x] 2.5 Accumulate thinking from complete messages as well as from fragments, including a `redacted_thinking` flag that marks thinking as having occurred without content.
- [x] 2.6 Clear the per-message buffers on `_rebuildItems()`, `applySnapshot()` and `_reset()`, and drop a run's buffers when it reaches `run_done`, `run_stopped` or `run_error`.
- [x] 2.7 Ensure a batch containing only fragments does not call `_persistHistoryEntry`, change the conversation title, or touch history metadata (`extension/sidepanel/panel-controller.js` `stream_event` / `token_batch` cases). ← (verify: fragments followed by the complete message render the text exactly once, including after a mid-message rebuild and after a reconnect snapshot; no fragment reaches history persistence or the durable sequence watermark)

## 3. Panel render: in-place streaming and the thinking block

- [x] 3.1 Add the in-place streaming update path in `extension/sidepanel/sidepanel.js`: when the only change is the latest turn's answer or thinking buffers, append into the existing text nodes and do not call `renderTranscript()`; any other change falls back to the structural render.
- [x] 3.2 Keep the streaming cursor node in place after the growing text so it does not flicker, and leave `isNearBottom()`, the near-bottom snap and the jump-to-latest control behaving as they do today.
- [x] 3.3 Render the collapsible thinking block inside the assistant turn (`sidepanel.html` markup and its stylesheet), labeled "Suy luận" to match the panel's existing Vietnamese copy, visually subordinate to the answer, with a keyboard-operable disclosure carrying an accessible name and an exposed expanded/collapsed state.
- [x] 3.4 Add the block's expansion state as UI-only state keyed by run id, mirroring `timelineExpandedRuns`: expanded by default while thinking is arriving, collapsed for a turn that is no longer live, an explicit collapse honored for the rest of that run, never persisted and never replayed.
- [x] 3.5 Represent a redacted thinking block as thinking that occurred, without displaying or fabricating its content.
- [x] 3.6 Keep fragments out of the polite live region entirely, and confirm the update path does not move scroll, selection or focus. ← (verify: while fragments stream, the DOM nodes of previously rendered items are identical — no transcript rebuild — scroll position, text selection and focus survive, assistive announcements are unchanged, and the thinking block is usable by keyboard at 320 CSS pixels in both themes)

## 4. Tests

- [x] 4.1 Host: extend `host/test/agent-run-lifecycle.test.mjs` or add a focused host test asserting the built options carry the partial flag, that fragments are forwarded live through the batch path, and that the durable store receives no fragment entry while the complete message is stored exactly once.
- [x] 4.2 Model: extend `test/sidepanel-conversation-model.test.mjs` with a scripted partial stream covering text appearing before completion, suffix-only reconciliation, an unknown-id complete message appending once, a non-prefix buffer being superseded, thinking accumulation including the redacted case, a rebuild mid-message leaving no stale buffer, and fragments not moving the sequence watermark or history.
- [x] 4.3 Panel: extend `test/sidepanel-fake-companion.test.mjs` with scripted partial streams through the real message path (`stream_event` and `token_batch`), including an unknown transient event type being ignored without error, which is the old-panel tolerance guarantee.
- [x] 4.4 Render: assert that streaming updates reuse existing DOM nodes (identity) and that a streamed-then-completed turn renders the same content as a full render of the final state. ← (verify: the panel tests prove no duplicated text and no transcript rebuild while streaming, the host test proves no fragment is persisted, and all three degradation pairings — new companion/old panel, old companion/new panel, unknown event — hold)

## 5. Documentation

- [x] 5.1 Add a brief README note where streaming behavior is already described, stating that the answer and model thinking are shown live while a run is in flight.

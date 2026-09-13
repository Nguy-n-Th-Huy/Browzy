## Why

While a run is in flight the side panel shows only a phase label ("Đang phản hồi", or the busy "Đang xử lý…" indicator); the assistant's actual answer appears only when a COMPLETE assistant message arrives, and model thinking is never shown at all. The operator therefore cannot tell what the agent is doing during the long part of a turn — her words: "hiện tại chỉ có đang phản hồi ko có phản hồi chi tiết vs ko có thinking cần thêm để bt đang làm gì".

The transport and the panel model are already built for this. The SDK supports an incremental partial-message stream, and `host/agent/session/token-batcher.js` already coalesces high-frequency `stream_message` events into `token_batch` envelopes so live forwarding does not flood native messaging — but `includePartialMessages` is not set today, so no partial event exists, and the panel has no delta or thinking display path. This change closes that gap without weakening anything the panel already guarantees.

## What Changes

- Enable the SDK's incremental partial-message stream for panel runs (`includePartialMessages`), so assistant text and model thinking are emitted as they are produced, not only when a message completes.
- Forward partial events to the panel as **transient** live traffic: batched through the existing token batcher, never appended to the durable per-conversation transcript. Replay, snapshot and reconnect keep rebuilding from complete messages only.
- The panel renders assistant text into the current turn as it streams, and renders model thinking in a collapsible "Suy luận" block inside the same assistant turn — live while it streams, and also for `thinking` / `redacted_thinking` blocks that arrive inside complete messages today but are silently dropped.
- Reconcile deltas against the complete message by SDK message id: when the complete message for a streamed assistant message arrives, only the suffix the stream did not already produce is appended, so text is never duplicated.
- Apply streaming updates in place for the streaming tail instead of rebuilding the whole transcript, so the operator's reading position, text selection, and focus survive every delta.
- Preserve existing guarantees unchanged: busy/working indicator visibility and elapsed time, streaming cursor, tool rows, approval and question cards, reconnect deduplication, and the chat-history surfaces (search, filters, incremental rendering, live sync).
- Degrade gracefully in both directions: a companion that does not emit partials still streams complete messages exactly as today, and a panel that does not understand deltas ignores them without error.
- Explicitly out of scope: live tool-argument streaming; any change to permission/approval flows; any renderer rewrite beyond what the streaming tail needs.

## Capabilities

### New Capabilities

None. Every behavior here is a change to how the existing panel and its durable history behave, not a new capability.

### Modified Capabilities

- `browser-assistant-panel`: during a run the panel SHALL show the assistant's answer text as it is produced and the model's thinking in a collapsible block, reconcile live deltas with the complete message without duplication, keep a partial response from being presented as complete, and apply streaming updates in place so the reader is not disturbed.
- `chat-history-storage`: live streaming deltas are transient — they SHALL NOT become part of the durable transcript, so the stored history and its replay remain exactly the complete-message record they are today.

## Impact

- `host/agent/tools/query-options.js` — `buildIsolatedOptions()` gains the partial-message flag; no other option changes.
- `host/agent/companion.js` — the `_runQuery` pump and the `runAsForkedChild()` emit wrapper distinguish transient partial events from durable stream messages (live forward, no durable append).
- `host/agent/session/manager.js` — the per-run `onEvent` sink skips transient events instead of passing them to `store.appendEvent`.
- `host/agent/session/token-batcher.js` — the batch predicate also covers transient partial events, so both kinds travel in one bounded window and keep their ordering relative to non-batchable events (tool dispatch, approvals).
- `host/agent/protocol.js` — the transient partial event's identity on the existing `stream_event` / `token_batch` envelope (documentation of the wire shape; no new envelope category).
- `extension/sidepanel/conversation-model.js` — delta application, thinking accumulation, per-message-id reconciliation, and the existing complete-message path kept authoritative.
- `extension/sidepanel/sidepanel.js` (+ `sidepanel.html` and its stylesheet) — the live render path for the streaming tail and the collapsible "Suy luận" block.
- Extension constraints that bound the renderer choice: Manifest V3, no build step, zero dependencies, ES-module scripts, CSP allowing only self-hosted scripts — the rendering approach and its alternatives are decided in `design.md`.
- Tests: `host/test/agent-run-lifecycle.test.mjs` or a focused host test (partials forwarded live, never persisted; the query option is set); `test/sidepanel-conversation-model.test.mjs` and `test/sidepanel-fake-companion.test.mjs` with scripted partial streams, plus render/DOM-identity coverage.
- Documentation: a brief README note only if it fits naturally where streaming behavior is already described.

## Context

See proposal.md — Why for the motivation. The constraints that shape the approach:

- **The pump forwards every SDK message as one durable event.** `host/agent/companion.js` `_runQuery()` does `run.emit({ type: "stream_message", message })` for each message from `sdk.query(...)`, and `runAsForkedChild()` wraps `run.emit` so every event is (a) appended to the conversation store through `SessionManager.startRun()`'s `onEvent` sink → `store.appendEvent`, and (b) pushed into a `TokenBatcher`. The batcher already coalesces `stream_message` events into `token_batch` envelopes on a 75 ms window, so high-frequency live forwarding is a solved problem; there is simply nothing high-frequency to forward today.
- **No partial messages exist yet.** `host/agent/tools/query-options.js` `buildIsolatedOptions()` (the panel run's option builder) does not set `includePartialMessages`, which the pinned SDK documents as "When true, `SDKPartialAssistantMessage` events will be emitted during streaming" with shape `{ type: 'stream_event', event, parent_tool_use_id, uuid, session_id }`. The raw stream events are the usual `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop` sequence. `host/agent/enhance-prompt.js` builds its own options and is unaffected.
- **The panel drops thinking and has no delta path.** `extension/sidepanel/conversation-model.js` `_applyStreamMessage()` handles only complete `text` and `tool_use` blocks in `assistant` messages and complete `tool_result` blocks in `user` messages; `thinking` and `redacted_thinking` blocks fall through untouched. `_applyEventToItems()` has no default branch, so an event type it does not recognize is silently ignored — the property graceful degradation rests on. `applyEvent()` pushes every event into the retained window (`_windowEvents`) that `_rebuildItems()` replays after eviction or an older-page prepend.
- **The transcript renderer is wholesale.** `extension/sidepanel/sidepanel.js` `renderTranscript()` rebuilds `el.transcript.innerHTML` on every render, then re-wires icons, thumbnails, document cards, copy buttons and the timeline toggles. There is an in-repo precedent for the opposite: `extension/sidepanel/history-view.js` `_patch()` keyed reconcile that reuses DOM nodes by key, rewrites only changed ones, and restores the scroller offset after the patch. Per-user UI state already lives outside the model in a `Set` keyed by run id (`timelineExpandedRuns`), deliberately not persisted or replayed.
- **Panel tests run without a browser.** `test/sidepanel-conversation-model.test.mjs` and `test/sidepanel-fake-companion.test.mjs` drive the model from scripted events and a fake companion; host behavior is covered by `host/test/agent-run-lifecycle.test.mjs`. Both paths are testable without a live SDK.
- **Extension constraints.** Manifest V3, no build step, zero dependencies, ES-module scripts, CSP allowing only self-hosted scripts. A dependency that needs an asset pipeline cannot ship here.

## Goals / Non-Goals

**Goals:**

- Live answer detail and live thinking during a run, in the turn they belong to.
- One authoritative source per fact: durable history is complete messages; live display is fragments that must reconcile with them by identity, not by luck.
- Smooth updates: a fragment never triggers a transcript rebuild, and never disturbs scroll, selection, focus or the live region.
- Both old/new pairings across companion and extension behave exactly as today when the other side lacks the feature.

**Non-Goals:**

- No live tool-argument streaming (`input_json_delta` is ignored on purpose), no change to permission/approval/timeline flows, no new lifecycle state, no protocol version negotiation.
- No renderer rewrite beyond the streaming tail. The full-render path stays the structural renderer.
- No change to retention, coalescing, deletion, export, or the stored-record format.

## Decisions

### 1. The live detail comes from the SDK's partial-message stream, enabled at the option boundary

`buildIsolatedOptions()` gains the partial-message flag. Nothing else in that object changes. This is the only available source of sub-message detail: today the SDK emits complete assistant messages only, and the panel cannot read a message that was never sent.

Alternative considered: infer streaming from the token batcher's timing on complete messages. Rejected — there is nothing to infer from; complete messages arrive at their own cadence and carry no deltas.

Alternative considered: pass the CLI flag directly. Rejected — the panel runs through `sdk.query()`'s options object, not a spawned CLI command line, and the SDK's own option is the contract.

Scope note: the flag is set in the panel-run builder only. The prompt-enhancement path and the external MCP entry points build their own options and are untouched, so enabling it cannot change what any other caller sees.

### 2. Partial events are a distinct, transient event type — not `stream_message`

The pump emits a separate event for `message.type === "stream_event"` (working name `stream_partial`), while complete messages keep `stream_message`. The durable sink in `SessionManager.startRun()` skips the transient type, so `store.appendEvent` never sees a fragment; the batcher's predicate is widened from `isStreamMessageEvent` to also batch the transient type, so fragments and complete messages share the one bounded window and the existing "flush the pending batch before a non-batchable event" rule still orders text against tool dispatch and approvals.

Alternatives considered and rejected:

- **Emit fragments as `stream_message` and let the panel tell them apart by `message.type === "stream_event"`.** The sink is type-agnostic — it appends whatever was emitted — so every fragment would land in `events.jsonl`, making transient data durable and changing what replay returns. That is precisely what the spec forbids.
- **Send fragments from the pump directly to the parent process, bypassing `run.emit`.** It dodges the sink but also bypasses the batcher, so a fragment can overtake the tool event that followed it, and it duplicates per-run forwarding wiring instead of reusing it.
- **Persist fragments and prune them when the run ends.** Replay between the write and the prune is already wrong, and it makes the durable record depend on a cleanup step succeeding.

The naming of the transient event (a dedicated type versus a `transient: true` flag on `stream_message`) is not constrained by the spec; `host/agent/protocol.js` documents the chosen shape where the stream envelopes are already documented.

### 3. Fragments are applied to the model but never enter its event window

`applyEvent()` currently pushes every event into `_windowEvents`, which `_rebuildItems()` replays after an eviction or an older-page prepend. For a transient fragment that must not happen: it is applied to the turn, but it is not retained and does not advance `lastSeq`/`_highSeq` (it carries no sequence number anyway). A rebuild therefore reconstructs the turn from durable events only, and the complete message that follows supplies the full text — no replayed prefix, no duplicated text, and the model's retained window keeps meaning exactly what it documents itself to mean: the durable record.

Alternative considered: retain fragments and rely on message-id reconciliation during rebuild. Rejected — memory accounting would count fragments as history, and a rebuild would produce a partial answer that is later truncated by reconciliation, which is visible churn for no benefit.

Rebuilds and snapshots also clear fragment buffers for all messages (Decision 4), so a rebuild cannot leave a buffer claiming a prefix the rebuilt turn no longer shows.

### 4. Reconciliation with the complete message is per SDK message id and suffix-only

Fragments carry the id of the assistant message they belong to (`message_start` opens it; `content_block_delta` sequences follow). The model keeps, per run, a small map from message id to the answer text and thinking text already displayed for that id. When the complete assistant message with that id arrives, each block is compared against that kind's buffer and only the missing suffix is appended; a later block of the same id that the stream already displayed is consumed from its head, and a non-prefix run is superseded exactly where the fragments sat. Nothing is retired per complete message: the buffer tracks, per kind, how much of the stream has been consumed, and the id's entry is released only once neither kind has anything left unconsumed — with the id deliberately left open, so a fragment from a later block of the same streamed message re-opens a buffer for it. If a complete message arrives whose id has no buffer, its text is appended once, in full — the authoritative case for a panel that missed fragments or one connected to a companion that does not emit them. If a buffer exists but is not a prefix of the complete text, the complete text is treated as authoritative and the turn's text for that message is replaced by it, which cannot duplicate anything.

The same rule covers thinking, keyed by the same message id.

Alternative considered: on completion, replace the whole turn text with the complete message. It trivially prevents duplication, but it discards text from an earlier assistant message in the same turn (a turn can contain several assistant messages separated by tool calls) and causes a visible truncate-and-repaint when the buffer is longer. The suffix rule preserves the incremental display while keeping the complete message authoritative.

### 5. Thinking is a per-turn buffer with a UI-only disclosure state

`turn.thinking` accumulates streamed `thinking_delta` text and complete-message `thinking` blocks for the turn. A `redacted_thinking` block sets a flag that says thinking occurred without content, so the panel reports it honestly instead of inventing or decrypting anything. The block's expanded/collapsed state lives in `sidepanel.js` in a `Set` keyed by run id, mirroring `timelineExpandedRuns`: pure UI state, never sent to the host, never persisted, never replayed — which is also what keeps the "expansion state does not alter the underlying record" guarantee true. Default is expanded while thinking is arriving (seeing that work is the point of the request) and collapsed once the run is no longer live; an operator's explicit collapse is honored for the remainder of that run.

### 6. The rendering approach: targeted in-place DOM updates for the streaming tail, not a vendored SolidJS renderer

Chosen: **targeted vanilla DOM updates.** `renderTranscript()` keeps its current role as the structural renderer (new turns, tool rows, approvals, questions, lifecycle and history-boundary changes). A narrow incremental path is added for the case that currently matters — the latest turn's answer text and thinking text are still streaming, and nothing structural changed. That path:

- keeps one text node per streamed message for the answer and one for the thinking block, and appends fragments into those nodes as batches arrive, in a single synchronous task per batch;
- never calls `renderTranscript()`, so it cannot reset `innerHTML`, re-wire anything, or re-run the near-bottom snap;
- leaves the streaming cursor node in place after the growing text rather than regenerating it, so it does not flicker;
- falls back to the structural render whenever the change is not confined to the streaming buffers (a new turn, a tool row, a lifecycle change, a card, a history boundary), so the incremental path is an optimization over an unchanged authority, not a second implementation of the transcript.

Precedent: `history-view.js` `_patch()` already does keyed reconciliation with scroll-offset restoration in this repository — the mechanism, its counters, and its constraints have been exercised here.

Alternatives considered:

- **(b) Vendor SolidJS and rebuild the transcript reactively** (the operator's suggestion: "Có thể dùng solidjs để render nhé"). Rejected for this requirement. Solid's primary form needs JSX compilation, which the extension cannot run (no build step, CSP allows only self-hosted scripts). The buildless entry point (`solid-js/html` tagged templates) still vendors a runtime plus its helpers as new source in a repository that ships zero dependencies, and it only pays off if the model becomes a signal graph — while `conversation-model.js` is deliberately a plain event-application store shared by the panel, the fake companion and the DOM-less tests. Porting it would touch the whole transcript, i.e. far beyond the streaming tail the request is about. The operator's suggestion is genuinely available; it is simply a larger, riskier change than the requirement needs. If a future change rebuilds the panel renderer, this decision should be revisited on its own merits rather than defended here.
- **Re-render the transcript per batch with `innerHTML`** (the status quo, now driven by 75 ms batches). Rejected — it destroys selection and focus on every batch and is exactly the wholesale replacement the spec forbids.
- **A virtual-DOM library.** Same dependency and build objections as Solid, without the reactivity benefit for a store that is already the source of truth.

### 7. One batch, one update

Rendering cadence is the batcher's existing 75 ms window; no second timer is introduced. A batch is applied to the model and then triggers one in-place update, so a model producing thousands of deltas per second produces roughly thirteen DOM updates per second regardless. The existing immediate-flush rule is untouched, so a tool dispatch or an approval that follows text flushes the pending fragments first and arrives after them.

### 8. Degradation is inherent in the traffic, not negotiated

- **New companion, old panel:** fragments arrive inside existing `stream_event` / `token_batch` envelopes carrying an event type the old model does not recognize; `_applyEventToItems()` has no default branch, so they are ignored, and complete messages still arrive and still render exactly as today.
- **Old companion, new panel:** no fragments are ever sent; the delta path is simply never exercised, and the complete-message path is unchanged.

No version handshake is added: the new traffic is additive on an existing envelope and both directions already tolerate unknown event types. This is a property to keep, not a mechanism to build.

### 9. Existing derivations stay derived, not overridden

- `isBusy()` reads `turn.text` and `turn.lastContentKind`. Fragments set `lastContentKind = "text"` exactly as complete text blocks do, so the busy indicator clears when text actually starts appearing instead of at message completion — the intended improvement, obtained without changing the derivation.
- `isLatestStreaming` / the cursor, `isNearBottom()`, the jump-to-latest control, `_persistHistoryEntry` and the reconnect dedup watermark (`_highSeq` / sequence numbers) are untouched. A batch containing only fragments does not call `_persistHistoryEntry` and does not move the watermark.
- Tool rows, approval cards, question cards and the action timeline are unaffected: fragments carry no tool, approval or lifecycle semantics, and `input_json_delta` is discarded.

### 10. What a fragment explicitly may not do

Fragments never advance the durable sequence, never create or complete a turn, never create a tool row, never resolve a tool result, never answer a pending decision, never change the conversation title or history metadata, and never survive their run — the per-message buffers for a run are dropped when the run reaches `run_done`, `run_stopped` or `run_error`.

## Risks / Trade-offs

- **A fragment stream and its complete message are reconciled twice, duplicating text** → Reconciliation is by message id and appends only the suffix; a complete message with an unknown id appends in full once; a non-prefix buffer is superseded by the complete text. Planning assumed one complete message per id; the pinned SDK actually emits **one assistant message per completed content block**, so several consecutive messages share `message.id` and each must reconcile against the same streamed buffer — a buffer is therefore released only once nothing of it is left unconsumed, never by the first message that carries the id. The code path that could still duplicate — a later complete message finding no buffer — is the one the host and panel tests pin.
- **A mid-stream rebuild (eviction, older-page prepend, reconnect snapshot) leaves a stale buffer** → Rebuilds clear all fragment buffers, and the complete message then appends its full text once. Verified by a model test that rebuilds mid-message.
- **Live updates break reading position, selection or focus** → The incremental path never rebuilds the transcript and never runs the near-bottom snap; it reuses the nodes it updates. The full render keeps its existing behavior. Tests assert node identity and the absence of a rebuild while fragments arrive.
- **The live region is stormed by fragments** → Fragments are never announced; the existing transitions the polite region announces are unchanged.
- **Enabling partial messages increases native-message volume** → Nothing is persisted, fragments travel inside the existing 75 ms batch, and rendering is once per batch. The volume is bounded by the same mechanism that already bounds text streaming.
- **The pinned SDK stops honoring the option** → The flag is set at a single call site and covered by a host test asserting the built options; if it were ignored the run degrades to today's complete-message behavior, which the panel already supports.
- **The incremental path drifts from what the full render would produce** → It is confined to the text content of the latest turn's answer and thinking containers under a state where nothing structural changed; any other change goes through the structural renderer, and the tests check that streaming a turn then completing it yields the same rendered content as a full render of the final state.
- **Thinking displayed live is noisy or leaks content the model marked undisclosable** → A redacted thinking block is represented without content, the block is subordinate and collapsible, and its state is UI-only; the streaming default is a taste call that can change without touching the spec.

## Migration Plan

1. **Host, before any panel change:** set the option; give fragments their transient identity; make the durable sink skip them; widen the batch predicate. With the panel unchanged this is invisible except for the added native traffic, and the panel ignores the new event type — a safe intermediate state that is also the rollback target.
2. **Panel model:** accept fragments, apply them without window retention, reconcile by message id, accumulate thinking (including the redacted flag). The complete-message path stays authoritative.
3. **Panel render:** the in-place streaming path and the collapsible thinking block (markup, styles, expansion state), with the structural renderer untouched.
4. **Tests:** host first (fragments forwarded live and never persisted; the option is set), then panel (scripted partial streams through the model and the fake companion, DOM identity while streaming, reconciliation with and without a matching id, rebuild mid-message, thinking including the redacted case, old-panel tolerance of the unknown event type).

Rollback: clearing the option returns the system to today's complete-message behavior in one step; the panel's delta path then simply never runs. Reverting the panel first is also safe, because the host change is additive and the old model ignores the new event type.

## Open Questions

- Whether the thinking block should default expanded for a completed turn (rather than only while thinking is arriving). The spec requires it to be distinguishable, subordinate and collapsible; the default is a presentation taste call that can be tuned without a spec change.
- The final name of the transient event and whether it is a distinct event type or a flag on `stream_message`. The spec constrains only that fragments are not durable; the name is settled where `protocol.js` documents the stream envelopes and does not change this design.
- Whether a future change should rebuild the panel renderer on a reactive runtime. Explicitly deferred: this design chooses the cheapest mechanism that satisfies the streaming requirement and records why, rather than treating the current choice as permanent.

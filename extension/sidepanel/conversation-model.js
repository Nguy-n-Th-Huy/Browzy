// Pure, DOM-free state machine for one conversation's transcript + tool
// activity + observable run phase (spec: "Observable run states" — empty,
// connecting, ready, queued, streaming, waiting-for-permission, stopping,
// stopped, interrupted, completed, error). No chrome.* dependency anywhere
// in this file so it can be driven directly in tests (including against a
// real host/agent/companion.js CompanionCore instance, per this task's
// "fake companion harness" requirement) without a browser.
//
// Key design decisions, and why:
//
// 1. "assistant output streams into one response while tool activity is
//    shown separately" (spec) is modeled as ONE `assistant_turn` item per
//    run, holding an ordered `toolRows` array plus a single growing `text`
//    string — not a flat interleaved list of separate bubbles. This matches
//    design-review/screens/chat-streaming.html's markup (`.tool-timeline`
//    then `.prose` inside one `.msg-assistant-body`).
//
// 2. A run is marked `complete: true` ONLY on a `run_done` event. Every
//    other terminal event (`run_stopped`, `run_error`,
//    `run_interrupted_by_restart`) leaves `complete: false` and sets
//    `lifecycle` to a distinct value the renderer must label as such — this
//    is the direct implementation of the non-negotiable "a partial response
//    must never be shown as complete after interruption".
//
// 3. Reconnection dedup: host/agent/companion.js's LIVE stream_event/
//    token_batch forwarding does not stamp a `seq` on the inner event (only
//    events read back from disk via snapshot()/eventsAfter() carry one —
//    see host/agent/storage/transcript-store.js). Rather than trust a
//    fragile client-side seq cursor across a reconnect, `applySnapshot()`
//    always performs a FULL REBUILD of this model from the returned
//    snapshot, discarding anything applied live beforehand. Since every
//    live event is durably persisted (store.appendEvent) before it is ever
//    forwarded live, the disk-backed snapshot is always a superset —
//    rebuilding from it can never lose information, and because it REPLACES
//    rather than merges, it can never duplicate a row either. See
//    reports/05-panel-evidence.md for the reasoning and the test that
//    proves no duplicates survive a simulated reconnect.
//
// 4. host/agent/companion.js's `_handleStart` never persists the user's own
//    prompt text as an event — only the run lifecycle and the SDK's own
//    message stream are recorded. This model therefore keeps its own
//    client-side echo of sent prompts, keyed by runId
//    (`bindRunToLastUserMessage`/`seedLocalPrompts`), so a reopened
//    conversation can still show what was asked. See the "Known gaps"
//    section of reports/05-panel-evidence.md.

import { RUN_PHASE } from "./run-states.js";
import { humanToolLabel, humanToolLabelRunning, summarizeArgsForDetail } from "./tool-labels.js";

// The host's transient live-fragment event type (host/agent/protocol.js's
// STREAM_PARTIAL_EVENT_TYPE), hand-synced here for the same reason
// panel-controller.js hand-syncs the other protocol literals: the extension
// cannot import a Node-side host module. Exported so panel-controller.js's
// history-persistence gate reads the SAME single literal this model does
// instead of scattering a second copy of the string.
//
// The fragment's shape, fixed by Wave 1 (host/agent/protocol.js):
//   { type: "stream_partial", runId, message: {
//       type: "stream_event",
//       event: { type: "message_start" | "content_block_start" |
//                "content_block_delta" | "content_block_stop" |
//                "message_delta" | "message_stop", ... } } }
// The SDK message is carried verbatim, so the assistant message id the
// complete message is reconciled against is `message.event.message.id`
// (opened by `message_start`).
export const STREAM_PARTIAL_EVENT_TYPE = "stream_partial";

function extractResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b) return "";
        if (b.type === "text") return b.text || "";
        if (b.type === "image") return "[hình ảnh]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

let _uid = 0;
function nextKey(prefix) {
  _uid += 1;
  return `${prefix}_${_uid}`;
}

export class ConversationModel {
  /**
   * @param {string} conversationId
   * @param {object} [opts]
   * @param {number} [opts.maxWindowEvents] - hard ceiling on the number of
   *   stored events this model retains for rendering (tasks.md 3.3 — "cap
   *   rendered model memory"). Live traffic evicts the OLDEST retained
   *   events once the window is full; an explicit older page
   *   (`applyOlderPage`) is accepted only while the window has room, so
   *   memory is bounded no matter how long a conversation runs. The host's
   *   own snapshot page is the same order of magnitude (transcript-store.js's
   *   `maxSnapshotEvents`), so a cold rebuild fits with room to page back.
   */
  constructor(conversationId, { maxWindowEvents = 1000 } = {}) {
    this.conversationId = conversationId;
    this.maxWindowEvents = maxWindowEvents;
    this._reset();
  }

  _reset() {
    this._resetItems();
    // The rendered window: the raw stored events (ascending seq) the items
    // below were built from. Kept because evicting the oldest events must not
    // mean "evict an arbitrary aggregate item" — an assistant_turn item can
    // span dozens of events (text deltas, tool rows), so only the event
    // sequence itself identifies what is safe to drop. Bounded by
    // maxWindowEvents.
    this._windowEvents = [];
    // Watermarks (tasks.md 3.3, "no duplicate events"):
    //   _highSeq — highest seq ever incorporated. Any event at or below it
    //     has already been applied, which is what makes a live/replay
    //     overlap (a reconnect, a replayed snapshot, a retried token batch)
    //     a no-op instead of a duplicated transcript.
    //   _lowSeq — lowest seq still in the window; events below it are
    //     already loaded but were evicted (or never loaded).
    // Events WITHOUT a seq (live traffic that predates durable replay) are
    // still applied, but cannot participate in either watermark.
    this._highSeq = 0;
    this._lowSeq = 0;
    this._hasOlderEvents = false;
  }

  _resetItems() {
    this.items = []; // ordered: {kind:"user"|"assistant_turn"|"recording"}
    this.lastSeq = 0;
    this.meta = null;
    this.pendingApproval = null; // {action, target, requestId, protectedCategory, rememberable, ts}
    // Task 2.4: a LOCAL-only protected decision raised by background.js's
    // chrome.downloads.onCreated gate — never part of the host transcript,
    // never replayed from a snapshot (a download is a point-in-time browser
    // event, not conversation history), and never rememberable (downloads
    // are always the "download" protected category — spec "A protected
    // decision is not remembered"). Kept as its own field rather than
    // reusing pendingApproval so a real host-issued approval_request and a
    // local download pause can never be confused with each other (a
    // approval_decision reply for one must never be mistaken for the other).
    this.pendingDownloadDecision = null; // {requestId, runId, category, filename, url, ts}
    // Task 9.7: pending question — the user's choice resolves via
    // panel-controller.js's respondQuestion() with the matching requestId.
    // Mirror of pendingApproval, persisted and restored via the same
    // sequenced-event/replay mechanism.
    this.pendingQuestion = null; // {question, header, options, requestId, multiSelect, ts}
    this.connectionError = null; // {reason, detail} — conversation-scoped errors (run_error)
    // Tasks 7.4/7.6: the LATEST known risk category + contributing signals
    // for each tab this conversation's runs have controlled, keyed by tabId.
    // Populated only from real `tab_risk_update` events (host/agent/threat/
    // tab-risk.js's TabRiskRegistry) — never inferred locally. Used to show
    // risk CONTEXT on a decision card for the same tab (see getTabRisk());
    // the discrete finding/category events themselves are ALSO recorded as
    // turn-anchored warnings below, so the transcript shows them in place
    // (spec: "Findings and risk are surfaced as warnings, never as
    // decisions"). Survives a full applySnapshot() rebuild like every other
    // piece of state derived purely from replayed events — no separate
    // dedup needed (design decision 3 above: the rebuild replaces rather
    // than merges).
    this.tabRisk = new Map();
    this._turnsByRunId = new Map(); // runId -> item (assistant_turn)
    this._pendingUserIndex = null; // index of a just-sent, not-yet-bound user item
    this._localPrompts = new Map(); // runId -> original prompt text (this session's own echo cache)
    // Per-run, per-SDK-message-id record of the answer/thinking text already
    // displayed from LIVE fragments, so the complete message(s) that follow
    // can append only the missing suffix instead of the whole text again
    // (design decision 4). `runId -> { currentMessageId, byMessage:
    // Map(messageId -> { text: {streamed, start}, thinking: {streamed, start} }) }`.
    //
    // One id can be shared by several complete assistant messages (the SDK
    // emits one per completed content block), so a message id's entry is kept
    // until every kind it streamed has been consumed — never retired by the
    // first complete message that carries the id — and only then released
    // (`_releaseConsumedBuffer`) so an id with nothing left to reconcile does
    // not accumulate.
    //
    // Lifetime: this is transient display bookkeeping, never history. It is
    // cleared by every rebuild (`_resetItems()` below, which `_reset()` and
    // `_rebuildItems()` both call) and dropped when the run ends
    // (`_dropPartialBuffers`), so a snapshot/reconnect rebuild can never
    // leave a buffer claiming a prefix the rebuilt turn no longer shows.
    this._partialBuffers = new Map();
  }

  /** Seed locally-cached prompt text for runIds this browser profile has
   * previously sent (see history-store.js), so a rebuild from a host
   * snapshot can still show the user's own messages even though the host
   * does not persist them. Safe to call before applySnapshot(). */
  seedLocalPrompts(map) {
    for (const [runId, text] of map instanceof Map ? map.entries() : Object.entries(map || {})) {
      this._localPrompts.set(runId, text);
    }
  }

  /** Every runId -> prompt text this model currently knows, for the caller
   * to persist locally (history-store.js) after each Send. */
  localPrompts() {
    return new Map(this._localPrompts);
  }

  /** Optimistically add the user's own message at Send time, before the
   * host has assigned a runId. Returns nothing; pair with
   * bindRunToLastUserMessage() once the START reply names the runId.
   * `opts.attachments` is the EXACT attachment snapshot captured at Send
   * time (references only: id/mimeType/fileName, never bytes — mirroring
   * the page-context exact-identity binding), so the transcript shows
   * precisely which images were bound to this message. */
  addLocalUserMessage(text, { attachments = [] } = {}) {
    this.items.push({
      kind: "user",
      text,
      attachments: attachments.length ? attachments.map((a) => ({ id: a.id, mimeType: a.mimeType, fileName: a.fileName })) : [],
      ts: Date.now(),
      runId: null
    });
    this._pendingUserIndex = this.items.length - 1;
  }

  bindRunToLastUserMessage(runId) {
    if (this._pendingUserIndex == null) return;
    const item = this.items[this._pendingUserIndex];
    if (item && item.kind === "user") {
      item.runId = runId;
      this._localPrompts.set(runId, item.text);
    }
    this._pendingUserIndex = null;
  }

  /** Full rebuild from a `snapshot` reply payload ({conversationId, meta,
   * lastSeq, firstSeq, hasOlder, events}), per design decision 3 above. The
   * host bounds `events` to its own newest page; `hasOlder` says whether the
   * conversation continues below it, so the model never pretends the window
   * is the whole transcript. */
  applySnapshot(snapshot) {
    const keepPrompts = this._localPrompts;
    this._reset();
    this._localPrompts = keepPrompts;
    if (!snapshot) return;
    this.meta = snapshot.meta || null;
    this.lastSeq = snapshot.lastSeq || 0;
    const events = snapshot.events || [];
    for (const event of events) this.applyEvent(event, { trim: false });
    this._maybeTrimWindow();
    // The host's own watermark can be ahead of the newest event in the page
    // (it is the log's true last sequence). Keeping it means a later live
    // event at that seq is not mistaken for new.
    if (typeof snapshot.lastSeq === "number" && snapshot.lastSeq > this._highSeq) this._highSeq = snapshot.lastSeq;
    this.lastSeq = Math.max(this.lastSeq, this._highSeq);
    this._lowSeq = this._windowEvents.length ? this._windowSeq(this._windowEvents[0]) : 0;
    // OR, never overwrite: the host says whether history continues below the
    // page it sent, and eviction above may have dropped part of that page
    // too. Either way there IS more history, and the model must not claim
    // otherwise.
    this._hasOlderEvents = this._hasOlderEvents || snapshot.hasOlder === true;
  }

  /** Oldest sequence number still in the rendered window (0 when the window
   * holds no seq-bearing event, e.g. a purely live, never-persisted
   * conversation). */
  oldestLoadedSeq() {
    for (const event of this._windowEvents) {
      const seq = this._windowSeq(event);
      if (seq > 0) return seq;
    }
    return 0;
  }

  /** Highest sequence number this model has incorporated. */
  highestSeq() {
    return this._highSeq;
  }

  /** Whether the host reported (or eviction produced) events below the
   * rendered window — the signal a UI uses to offer "load earlier". */
  hasOlderEvents() {
    return this._hasOlderEvents;
  }

  /** How many stored events are currently retained (the memory-bound
   * observable tasks.md 3.3's benchmark asserts). */
  windowSize() {
    return this._windowEvents.length;
  }

  _windowSeq(event) {
    return event && typeof event.seq === "number" ? event.seq : 0;
  }

  /**
   * Merge one OLDER page (from the host's transcript_window reply) below the
   * current window. Events at or above `_lowSeq` are already rendered and are
   * dropped; the page is accepted only while the window has room, so
   * retained memory can never exceed `maxWindowEvents`. The items are rebuilt
   * from the combined event window (a prepend cannot be done incrementally
   * without splitting an aggregate turn).
   *
   * @returns {{added: number, hasOlder: boolean, limitReached: boolean}}
   */
  applyOlderPage(page) {
    const events = (page && page.events) || [];
    const low = this.oldestLoadedSeq();
    const older = events.filter((event) => {
      const seq = this._windowSeq(event);
      return seq > 0 && (low === 0 || seq < low);
    });
    if (!older.length) {
      this._hasOlderEvents = page && page.hasOlder === true ? true : this._hasOlderEvents;
      return { added: 0, hasOlder: !!page && page.hasOlder === true, limitReached: false };
    }
    const room = Math.max(0, this.maxWindowEvents - this._windowEvents.length);
    // Keep the NEWEST events of the older page (the ones adjacent to the
    // current window) when the page does not fit — the rest stays reachable
    // through another request.
    const accepted = older.length > room ? older.slice(older.length - room) : older;
    if (!accepted.length) {
      this._hasOlderEvents = true;
      return { added: 0, hasOlder: true, limitReached: true };
    }
    this._windowEvents = accepted.concat(this._windowEvents);
    this._lowSeq = this._windowSeq(accepted[0]) || low;
    // History remains below this window if the page was truncated to fit, or
    // if the host said there was more beyond the page we were given.
    this._hasOlderEvents = accepted.length < older.length || (page && page.hasOlder === true);
    this._rebuildItems();
    return {
      added: accepted.length,
      hasOlder: this._hasOlderEvents,
      limitReached: this._windowEvents.length >= this.maxWindowEvents
    };
  }

  /** Rebuild `items` from `_windowEvents` (used after an older-page prepend or
   * an eviction). Watermarks are preserved: this is a re-render of
   * already-incorporated events, not a reset.
   *
   * `preserveLiveState` keeps the state that events OUTSIDE the retained
   * window established — a run's lifecycle/error, an outstanding approval or
   * question, the latest tab-risk entries, a connection error. Without it,
   * evicting the `run_started` at the head of a long run would silently
   * demote a live run to "created" (the panel would show it as idle while it
   * is still streaming), and an eviction during a pending approval would drop
   * the card the operator is looking at. The window is about MEMORY, not
   * about forgetting what the conversation is currently doing. */
  _rebuildItems({ preserveLiveState = true } = {}) {
    const windowEvents = this._windowEvents;
    const keepPrompts = this._localPrompts;
    const highSeq = this._highSeq;
    const carry = preserveLiveState ? this._captureLiveState() : null;
    this._resetItems();
    this._localPrompts = keepPrompts;
    for (const event of windowEvents) this._applyEventToItems(event);
    this.lastSeq = highSeq;
    if (windowEvents.length) {
      const last = this._windowSeq(windowEvents[windowEvents.length - 1]);
      if (last > 0) this.lastSeq = Math.max(this.lastSeq, last);
    }
    if (carry) this._restoreLiveState(carry);
  }

  _captureLiveState() {
    const pendingUser = this._pendingUserIndex != null ? this.items[this._pendingUserIndex] : null;
    return {
      pendingApproval: this.pendingApproval,
      pendingQuestion: this.pendingQuestion,
      pendingDownloadDecision: this.pendingDownloadDecision,
      connectionError: this.connectionError,
      tabRisk: new Map(this.tabRisk),
      pendingUserText: pendingUser && pendingUser.kind === "user" ? pendingUser.text : null,
      turns: new Map(
        [...this._turnsByRunId].map(([runId, turn]) => [
          runId,
          { lifecycle: turn.lifecycle, complete: turn.complete, errorInfo: turn.errorInfo, ts: turn.ts, lastContentKind: turn.lastContentKind }
        ])
      )
    };
  }

  _restoreLiveState(carry) {
    for (const [runId, saved] of carry.turns) {
      const turn = this._turnsByRunId.get(runId);
      if (!turn) continue;
      turn.lifecycle = saved.lifecycle;
      turn.complete = saved.complete;
      turn.errorInfo = saved.errorInfo;
      turn.ts = saved.ts;
      turn.lastContentKind = saved.lastContentKind;
    }
    if (carry.pendingApproval) this.pendingApproval = carry.pendingApproval;
    if (carry.pendingQuestion) this.pendingQuestion = carry.pendingQuestion;
    if (carry.pendingDownloadDecision) this.pendingDownloadDecision = carry.pendingDownloadDecision;
    if (carry.connectionError) this.connectionError = carry.connectionError;
    for (const [tabId, entry] of carry.tabRisk) this.tabRisk.set(tabId, entry);
    if (carry.pendingUserText != null) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i].kind === "user" && this.items[i].runId == null) {
          this._pendingUserIndex = i;
          break;
        }
      }
    }
  }

  /**
   * Drop the oldest events once the window is over budget. Evicted in BATCHES
   * (a quarter window) so the rebuild cost is amortized O(1) per event rather
   * than a full re-render on every token delta.
   */
  _maybeTrimWindow() {
    if (this._windowEvents.length <= this.maxWindowEvents) return;
    const batch = Math.max(1, Math.floor(this.maxWindowEvents / 4));
    const drop = this._windowEvents.length - this.maxWindowEvents + batch;
    const dropped = this._windowEvents.splice(0, drop);
    // Dropped events are gone from the window but were real — there is
    // history below whatever remains.
    if (dropped.length) this._hasOlderEvents = true;
    this._lowSeq = this._windowEvents.length ? this._windowSeq(this._windowEvents[0]) : this._highSeq;
    if (this._windowEvents.length) this._rebuildItems();
  }

  /**
   * Make sure exactly one "user" item exists for this runId, in one of three
   * ways, checked in order:
   *   1. Already present (an earlier bindRunToLastUserMessage/_ensureUserItemForRun
   *      call already attached it) -> no-op. This is the common LIVE path:
   *      sendMessage() -> addLocalUserMessage() -> the START reply's runId
   *      binds it via bindRunToLastUserMessage() BEFORE any run_queued/
   *      run_started stream_event ever calls this again for the same runId.
   *   2. A just-sent, not-yet-bound local item exists (_pendingUserIndex) ->
   *      bind it now (covers a stream_event arriving before the START
   *      reply's own envelope is processed, however unlikely the ordering).
   *   3. Neither -> a rebuild (applySnapshot) or a run_created for a runId
   *      this connection never sent (e.g. a second attached panel) -> use
   *      the seeded local-prompt cache, or an honest placeholder if this
   *      profile never saw that prompt at all. Never fabricates text.
   */
  _ensureUserItemForRun(runId) {
    if (this.items.some((it) => it.kind === "user" && it.runId === runId)) return;
    if (this._pendingUserIndex != null) {
      this.bindRunToLastUserMessage(runId);
      return;
    }
    const promptText = this._localPrompts.get(runId);
    this.items.push({
      kind: "user",
      text: promptText != null ? promptText : "[Nội dung tin nhắn trước đó không có sẵn]",
      ts: Date.now(),
      runId,
      isPlaceholder: promptText == null
    });
  }

  _turnFor(runId, { createIfMissing = false, ts } = {}) {
    let turn = this._turnsByRunId.get(runId);
    if (!turn && createIfMissing) {
      this._ensureUserItemForRun(runId);
      turn = {
        kind: "assistant_turn",
        runId,
        toolRows: [],
        // Tasks 7.4/7.5: turn-anchored warnings — `injection_finding`,
        // `injection_probe_failed`, and `tab_risk_update` events recorded
        // while this turn's run was active. Purely informational (spec: "A
        // warning SHALL NOT present allow/deny controls... SHALL NOT be
        // resolvable as an approval") — nothing here is ever consumed by
        // approve/deny code, and nothing here ever clears on its own the way
        // pendingApproval/pendingQuestion do, because acknowledging a
        // warning is not a thing this model models at all.
        warnings: [],
        text: "",
        // Model reasoning for this turn, accumulated from live
        // `thinking_delta` fragments and from `thinking` blocks inside
        // complete messages alike (tasks.md 2.5). `redactedThinking` says a
        // `redacted_thinking` block arrived — thinking that occurred WITHOUT
        // disclosable content — so the renderer can report that honestly
        // instead of inventing or decrypting anything.
        thinking: "",
        redactedThinking: false,
        // Mid-turn answers to ask-user questions, in answer order:
        // {text, afterToolCount, ts}. Rendered right after the tool timeline
        // (before the prose), so a pick sits next to the tool call that asked
        // for it instead of trailing the whole turn. Local-only like the old
        // trailing bubble: a snapshot rebuild replays host events only, so
        // answers are not resurrected after a reconnect — same as before.
        questionAnswers: [],
        lifecycle: "created", // created|queued|running|stopping|stopped|done|error|interrupted
        complete: false,
        errorInfo: null,
        lastContentKind: null, // "text"|"tool_use"|null -- most recently applied content block kind (see isBusy())
        // Wall-clock anchor for the busy indicator's elapsed count. On live
        // traffic this is "now"; on a snapshot rebuild the replayed stored
        // event carries its original append `ts` (transcript-store.js stamps
        // every stored event), so a reconnect RESTORES the turn's real start
        // instant instead of resetting it to the reconnect time.
        ts: typeof ts === "number" && ts > 0 ? ts : Date.now()
      };
      this.items.push(turn);
      this._turnsByRunId.set(runId, turn);
    }
    return turn;
  }

  /** One event from a `stream_event` envelope's `event` field, a
   * `token_batch` envelope's `events[i]`, or a stored snapshot event (all
   * three shapes carry the same fields plus, for snapshot events, `seq`).
   *
   * Duplicate suppression (tasks.md 3.3 "no duplicate events"): an event
   * whose `seq` is at or below the highest sequence already incorporated is
   * dropped. That single watermark is what makes a live/replay overlap — a
   * reconnect's snapshot page, a replayed window, a redelivered batch —
   * impossible to render twice, without a per-event seen-set that would
   * itself grow without bound. Live events that carry no `seq` (the panel's
   * own optimistic traffic before the host has persisted anything) are still
   * applied, exactly as before. */
  applyEvent(event, { trim = true } = {}) {
    if (!event || typeof event !== "object") return;
    // A live fragment (design decisions 3 and 10): applied to the turn, but
    // never retained in the window and never allowed to move a watermark. It
    // carries no `seq` by construction, and returning BEFORE the window push
    // is what keeps `_windowEvents`/`_highSeq`/`lastSeq` meaning exactly what
    // they document themselves to mean: the durable record. A rebuild
    // therefore reconstructs the turn from durable events only, and the
    // complete message that follows supplies the full text (suffix-only, see
    // `_applyStreamMessage`), so no replayed prefix can duplicate it.
    //
    // Only this literal gets the exemption: an unknown event type keeps the
    // pre-existing behavior (ignored by `_applyEventToItems()`'s default
    // branch, still retained in the window), because graceful degradation of
    // a future/unknown event rests on that.
    if (event.type === STREAM_PARTIAL_EVENT_TYPE) {
      this._applyEventToItems(event);
      return;
    }
    const seq = this._windowSeq(event);
    if (seq > 0) {
      if (seq <= this._highSeq) return; // already incorporated — replay overlap
      this._highSeq = seq;
      if (seq > this.lastSeq) this.lastSeq = seq;
    }
    this._windowEvents.push(event);
    this._applyEventToItems(event);
    if (trim) this._maybeTrimWindow();
  }

  /** The pure event → items application, with no window bookkeeping. Split
   * out so a rebuild can replay the retained window without re-triggering
   * dedupe/trimming. */
  _applyEventToItems(event) {
    switch (event.type) {
      case "run_created":
        // Live traffic never actually delivers this one (it is appended via
        // SessionManager.startRun()'s direct store.appendEvent() call, not
        // through Run.emit(), so it is not wrapped by the forked child's
        // live-forwarding override — see companion.js's runAsForkedChild).
        // It IS present in a resume/snapshot replay, so this case still
        // matters for rebuild. _turnFor()'s _ensureUserItemForRun() call
        // handles binding a still-pending local echo either way.
        this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        break;
      case "run_queued": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "queued";
        break;
      }
      case "run_started": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "running";
        break;
      }
      case "run_stopped": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        // host/agent/companion.js's _runAfterLeaseGranted() emits run_error
        // THEN calls run.stop() for an internal failure (e.g. an
        // unavailable provider profile) — reusing the stop path for lease
        // cleanup, not a user-initiated Stop. A plain "stopped" label there
        // would misrepresent an internal failure as if the user had pressed
        // Stop. Only an actual user_stop (or an unlabeled reason, the
        // common/default case) downgrades an already-set error lifecycle;
        // any other reason on a turn that already carries errorInfo keeps
        // the more specific "error" lifecycle so the phase stays
        // distinguishable and honest.
        if (turn.errorInfo && event.reason && event.reason !== "user_stop") {
          turn.lifecycle = "error";
        } else {
          turn.lifecycle = "stopped";
        }
        turn.complete = false;
        for (const row of turn.toolRows) {
          if (row.status === "running") row.status = "cancelled";
        }
        this._dropPartialBuffers(event.runId);
        this._invalidatePendingDownloadDecisionForRun(event.runId);
        break;
      }
      case "run_done": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "done";
        turn.complete = true;
        this._dropPartialBuffers(event.runId);
        this._invalidatePendingDownloadDecisionForRun(event.runId);
        break;
      }
      case "run_error": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "error";
        turn.complete = false;
        turn.errorInfo = { reason: event.reason || "run_error", detail: event.detail };
        this._dropPartialBuffers(event.runId);
        this._invalidatePendingDownloadDecisionForRun(event.runId);
        break;
      }
      case "run_interrupted_by_restart": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "interrupted";
        turn.complete = false;
        for (const row of turn.toolRows) {
          if (row.status === "running") row.status = "unknown";
        }
        this._dropPartialBuffers(event.runId);
        this._invalidatePendingDownloadDecisionForRun(event.runId);
        break;
      }
      case "tool_rejected": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.toolRows.push({
          key: nextKey("tool"),
          toolName: event.toolName,
          args: {},
          status: "failed",
          isRejection: true,
          startedAt: Date.now(),
          endedAt: Date.now(),
          resultSummary: `Từ chối: ${event.reason || "không được phép"}`
        });
        break;
      }
      case "tool_result_unknown": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        const row = findOldestUnresolved(turn.toolRows, event.toolName);
        if (row) {
          row.status = "unknown";
          row.endedAt = Date.now();
          row.resultSummary = "Không rõ kết quả — mất kết nối trước khi nhận phản hồi. Không tự động thử lại.";
        } else {
          turn.toolRows.push({
            key: nextKey("tool"),
            toolName: event.toolName,
            args: {},
            status: "unknown",
            startedAt: Date.now(),
            endedAt: Date.now(),
            resultSummary: "Không rõ kết quả — mất kết nối trước khi nhận phản hồi. Không tự động thử lại."
          });
        }
        break;
      }
      case "stream_message":
        this._applyStreamMessage(event.runId, event.message, event.ts);
        break;
      // A live fragment (tasks.md 2.1/2.2): the raw SDK partial-message event
      // carried verbatim under `message`. Applied to the turn — never a turn
      // creator, never durable, never a watermark move (see applyEvent()).
      case STREAM_PARTIAL_EVENT_TYPE:
        this._applyStreamPartial(event.runId, event.message);
        break;
      // Tasks 7.4/7.5: an injection probe finding — a FACT about content a
      // tool already returned (the content was delivered unchanged; see
      // reports/wave2h-events.md), never a request. Recorded as a
      // turn-anchored warning so it appears in the transcript roughly where
      // the tool call that surfaced it ran. `matchedText` is carried through
      // completely verbatim here — it is QUOTED DATA (literally what a web
      // page said) and MUST be rendered inert by every consumer (never as
      // HTML/markdown/a link); see extension/ui/threat-labels.js's own
      // header for the rendering rule this model does not enforce itself
      // (a pure state model has no rendering to get wrong).
      case "injection_finding": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        if (!Array.isArray(turn.warnings)) turn.warnings = [];
        turn.warnings.push({
          key: nextKey("warn"),
          kind: "injection_finding",
          tool: event.tool,
          tabId: event.tabId != null ? event.tabId : null,
          field: event.field,
          patternId: event.patternId,
          matchedText: event.matchedText,
          location: event.location || null,
          ts: event.ts || Date.now()
        });
        break;
      }
      // A probe failure is diagnostic, not a finding — distinguishable from
      // "scanned this and found nothing" (spec "Probe failure": "the probe's
      // failure is recorded distinguishably from a clean result"). Recorded,
      // never silently dropped, but gets no special decision-relevant
      // treatment (reports/wave2h-events.md: "not user-facing copy").
      case "injection_probe_failed": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        if (!Array.isArray(turn.warnings)) turn.warnings = [];
        turn.warnings.push({
          key: nextKey("warn"),
          kind: "injection_probe_failed",
          tool: event.tool,
          tabId: event.tabId != null ? event.tabId : null,
          error: event.error,
          ts: event.ts || Date.now()
        });
        break;
      }
      // Task 6's per-tab risk category, advisory-only end to end (never
      // gates, never consulted by the permission resolver — see
      // reports/wave2h-events.md). Kept in TWO places on purpose: `tabRisk`
      // (below) is the LATEST-known state per tab, read by the decision-card
      // renderer for context (task 7.6); the SAME event is also recorded as
      // a turn-anchored warning (above pattern) so a category change is
      // visible in the transcript itself (spec "tab risk categories" are
      // warnings too, exactly like a finding), not only as ambient card
      // context.
      case "tab_risk_update": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        if (!Array.isArray(turn.warnings)) turn.warnings = [];
        const signals = Array.isArray(event.signals) ? event.signals : [];
        turn.warnings.push({
          key: nextKey("warn"),
          kind: "tab_risk_update",
          tabId: event.tabId,
          category: event.category,
          signals,
          ts: event.ts || Date.now()
        });
        if (event.tabId != null) {
          this.tabRisk.set(event.tabId, { category: event.category, signals, ts: event.ts || Date.now() });
        }
        break;
      }
      case "approval_request":
        this.pendingApproval = {
          runId: event.runId,
          action: event.action,
          target: event.target,
          requestId: event.requestId,
          // Task 7.3: which protected category applies (null for an
          // ordinary mode/mutating/send-class decision) and whether this
          // decision may be offered a "remember" option at all — both
          // already emitted by host/agent/policy/can-use-tool.js's
          // approval_request event (see reports/wave1-contracts.md's Notes
          // section). A protected decision is never rememberable, per spec.
          protectedCategory: event.protectedCategory != null ? event.protectedCategory : null,
          rememberable: event.rememberable === true,
          ts: Date.now()
        };
        break;
      // Task 9.7: store the question the ask-the-user tool pushed, exactly
      // as we do for approval_request. The pending question survives
      // reconnects via the same TranscriptStore/replay path. Never auto-
      // answered on reconnect — stays outstanding until an explicit
      // question_answer arrives or the tool's bounded timeout fires
      // (which the companion resolves with an explicit tool-error, not
      // here).
      case "question_request":
        this.pendingQuestion = {
          runId: event.runId,
          question: event.question,
          header: event.header,
          options: event.options,
          multiSelect: !!event.multiSelect,
          requestId: event.requestId,
          ts: Date.now()
        };
        break;
      // A document the run produced for the operator. The event carries
      // metadata only — never the bytes — so this is cheap to replay on every
      // reconnect, and the card fetches the file separately when the operator
      // actually opens or downloads it (documents-client.js).
      //
      // Attached to the TURN rather than pushed as a top-level item so the
      // card sits with the answer that produced it, the way the transcript
      // already anchors mid-turn question answers.
      case "document_created": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        if (!Array.isArray(turn.documents)) turn.documents = [];
        // Replay-safe: the same event arriving twice (a reconnect snapshot
        // replaying the run's transcript) must not duplicate the card.
        if (!turn.documents.some((d) => d.documentId === event.documentId)) {
          turn.documents.push({
            documentId: event.documentId,
            title: event.title,
            fileName: event.fileName,
            format: event.format,
            mimeType: event.mimeType,
            byteLength: event.byteLength,
            ts: event.ts || Date.now()
          });
        }
        break;
      }
      case "recording_complete":
        this.items.push({
          kind: "recording",
          recordingId: event.recordingId,
          path: event.path,
          summary: event.summary,
          transcriptStatus: event.transcriptStatus,
          ts: Date.now()
        });
        break;
      // Task 2.4 durable half: this conversation's own transcript replaying
      // back the durable record host/agent/session/manager.js's
      // recordDownloadDecision() appended (see
      // host/agent/companion.js's _handleDownloadDecisionRecorded()) — on a
      // reconnect/resume snapshot, or a second connected panel. Never
      // arrives as a LIVE stream_event (the decision is made entirely
      // outside any Run, so there is no run.emit() to carry it) — the LIVE
      // half of this same record is recordDownloadDecision() below, called
      // directly from respondDownloadDecision() the instant the user
      // answers. Both paths funnel through _pushDownloadDecisionItem(),
      // deduplicated by requestId, so neither can ever double the item the
      // other already added.
      case "download_decision_recorded":
        this._pushDownloadDecisionItem(event);
        break;
      default:
        // Unknown event types are ignored, not fatal — protocol.js's own
        // "unknown_message_type" convention for envelopes; a future event
        // kind must not crash an older panel build.
        break;
    }
  }

  /** Clears a resolved/expired approval (e.g. after sending the decision, or
   * on stop/scope-change per design.md's approval-token invalidation). */
  clearPendingApproval() {
    this.pendingApproval = null;
  }

  /** Task 7.6: the latest known `{category, signals, ts}` for a tab, or
   * `null` when this conversation has never seen a `tab_risk_update` for it
   * (including "no run has ever controlled this tab" and "insufficient
   * signals were ever observed" — both legitimately return null/uncategorized
   * from the host side too; this method never fabricates a category the host
   * did not report). Read by the decision-card renderer to show risk as
   * CONTEXT alongside a pending approval for the same tab — never consulted
   * to change whether a decision is required. */
  getTabRisk(tabId) {
    if (tabId == null) return null;
    return this.tabRisk.get(tabId) || null;
  }

  /** Task 2.4: background.js paused a download and is asking for a fresh,
   * non-rememberable protected decision. Never overwrites/merges with
   * pendingApproval — see that field's own comment for why the two are kept
   * distinct. */
  setPendingDownloadDecision(info) {
    this.pendingDownloadDecision = info;
  }

  clearPendingDownloadDecision() {
    this.pendingDownloadDecision = null;
  }

  /** Task 2.4 (panel spec "An outstanding card SHALL be invalidated... on
   * Stop"): this run just ended (run_stopped/run_done/run_error/
   * run_interrupted_by_restart, applied from applyEvent() above) — a download
   * decision it raised can no longer be answered. Observes the SAME
   * run-teardown stream_event background.js's own OVERLAY_TEARDOWN_RUN_EVENTS
   * hook does, independently: this only clears the PANEL's own view of the
   * card; background.js clears its map entry from the identical event on its
   * own side (invalidateDownloadDecisionsForRun()), so neither side depends
   * on a round trip through the other for this specific case. A no-op when
   * there is no pending decision, or it belongs to a different run. */
  _invalidatePendingDownloadDecisionForRun(runId) {
    if (this.pendingDownloadDecision && this.pendingDownloadDecision.runId === runId) {
      this.pendingDownloadDecision = null;
    }
  }

  /** Task 2.4: an honest record for a download that finished (or otherwise
   * became ungateable) before background.js could pause it — reported, not
   * pretended to have been blocked. A plain transcript item, not a decision:
   * there is nothing left to allow or deny. */
  recordDownloadNotice({ filename, url, outcome, detail, ts }) {
    this.items.push({ kind: "download_notice", filename, url, outcome, detail: detail || null, ts: ts || Date.now() });
  }

  /** Shared by the LIVE path (recordDownloadDecision() below, called the
   * instant the user answers) and the REPLAY path (applyEvent()'s
   * "download_decision_recorded" case, for a reconnect/second panel).
   * Deduplicates by requestId so whichever path arrives second is a no-op. */
  _pushDownloadDecisionItem({ requestId, decision, category, filename, url, ts }) {
    if (this.items.some((i) => i.kind === "download_decision" && i.requestId === requestId)) return;
    this.items.push({
      kind: "download_decision",
      requestId,
      decision,
      category: category || "download",
      filename: filename || null,
      url: url || null,
      ts: ts || Date.now()
    });
  }

  /** Task 2.4: the panel's own LIVE record of a download decision the instant
   * the user answers (panel-controller.js's respondDownloadDecision()) — the
   * durable host-side half (host/agent/session/manager.js's
   * recordDownloadDecision()) is a fire-and-forget best-effort report that
   * only becomes visible again on a later reconnect/resume replay, so this
   * keeps the CURRENT session's own timeline honest without waiting on that
   * round trip. */
  recordDownloadDecision({ requestId, decision, category, filename, url }) {
    this._pushDownloadDecisionItem({ requestId, decision, category, filename, url, ts: Date.now() });
  }

  /** Task 9.7: clears a resolved/expired question (after the user answered,
   * or on stop invalidating it). Mirror of clearPendingApproval. */
  clearPendingQuestion() {
    this.pendingQuestion = null;
  }

  /** Task 9.7: record the user's chosen option(s) anchored to the turn that
   * asked for them, so the transcript shows the pick right after the
   * ask-user tool call instead of trailing the whole turn (and everything
   * streamed after it). `afterToolCount` pins the position against later
   * tool rows. Falls back to the legacy trailing user item only when the
   * asking turn cannot be found, so the record is never silently dropped. */
  recordQuestionAnswer(answer) {
    const chosen = Array.isArray(answer) ? answer : [answer];
    const text = chosen.length === 0 ? "(người dùng không chọn)" : `👉 ${chosen.join(", ")}`;
    const runId = this.pendingQuestion?.runId ?? null;
    const turn = runId != null ? this._turnsByRunId.get(runId) : null;
    if (turn) {
      if (!Array.isArray(turn.questionAnswers)) turn.questionAnswers = [];
      turn.questionAnswers.push({ text, afterToolCount: turn.toolRows.length, ts: Date.now() });
      return;
    }
    this.items.push({ kind: "user", text, ts: Date.now(), runId, isQuestionAnswer: true });
  }

  _applyStreamMessage(runId, message, ts) {
    if (!message || typeof message !== "object") return;
    const turn = this._turnFor(runId, { createIfMissing: true, ts });
    if (message.type === "assistant" && message.message && Array.isArray(message.message.content)) {
      // The SDK message id is what the live fragments for this exact message
      // were keyed by (`message_start` derived it in `_applyStreamPartial`).
      // When a buffer exists, only the suffix the stream did not already
      // produce is appended (design decision 4); without one, the message's
      // text is appended once, in full — the authoritative case for a panel
      // that missed fragments or talks to a companion that emits none.
      //
      // One id can be shared by SEVERAL complete assistant messages: the
      // pinned SDK documents that a streamed response is emitted "one
      // assistant message per completed content block, so several consecutive
      // assistant messages can share message.id and each carries just that
      // block". The streamed fragments for that id cover ALL of its blocks,
      // so the buffer must survive each of those messages (see
      // `_reconcileCompleteBlock` / `_releaseConsumedBuffer`).
      const messageId = message.message.id != null ? String(message.message.id) : null;
      const buf = this._bufferEntryFor(runId, messageId);
      for (const block of message.message.content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          this._reconcileCompleteBlock(turn, "text", block.text, buf && buf.text);
          // The busy/working indicator's visibility condition (see isBusy())
          // needs "has answer text been applied since run start / since the
          // most recent tool_use". That is derived from this existing block
          // stream -- we only record which kind of content block was applied
          // most recently. A "user"-type tool_result message deliberately
          // does NOT touch this field: a tool finishing is not answer text
          // resuming.
          turn.lastContentKind = "text";
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          // Thinking that arrives only inside a completed message (no streamed
          // fragments) must still be shown (tasks.md 2.5), reconciled by the
          // same message id and suffix rule as the answer.
          this._reconcileCompleteBlock(turn, "thinking", block.thinking, buf && buf.thinking);
        } else if (block.type === "redacted_thinking") {
          // Thinking that occurred, with nothing disclosable: a flag, never
          // the block's `data` (which this panel must not reveal or invent).
          turn.redactedThinking = true;
        } else if (block.type === "tool_use") {
          turn.toolRows.push({
            key: block.id || nextKey("tool"),
            toolName: block.name,
            args: block.input || {},
            status: "running",
            startedAt: Date.now(),
            endedAt: null,
            resultSummary: null
          });
          turn.lastContentKind = "tool_use";
        }
      }
      // Deliberately NOT retired here: retiring after the first complete
      // message that carries the id is exactly what made a sibling complete
      // message (same id, different block) append text the fragments had
      // already displayed. Only a buffer with nothing left unconsumed is
      // released, and the run-terminal/rebuild drops are unchanged.
      this._releaseConsumedBuffer(runId, messageId, buf);
    } else if (message.type === "user" && message.message && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (!block || block.type !== "tool_result") continue;
        const row = turn.toolRows.find((r) => r.key === block.tool_use_id) || findOldestUnresolved(turn.toolRows, null);
        if (!row) continue;
        row.status = block.is_error ? "failed" : "succeeded";
        row.endedAt = Date.now();
        row.resultSummary = extractResultText(block.content);
      }
    }
    // "system" and "result" SDK messages carry no transcript-visible
    // content this model needs beyond the run-lifecycle events already
    // emitted independently by host/agent/session/run.js.
  }

  /** One live fragment, verbatim (`message` is the SDK's
   * `SDKPartialAssistantMessage`: `{type:"stream_event", event, uuid,
   * session_id, parent_tool_use_id}`). Only `message_start`,
   * `content_block_start` and `content_block_delta` carry anything this model
   * displays; `input_json_delta` (live tool-argument streaming) and
   * `signature_delta` are discarded on purpose (tasks.md 2.1), and
   * `content_block_stop`/`message_delta`/`message_stop` close state the
   * complete message already owns.
   *
   * A subagent's own frames carry a non-null `parent_tool_use_id` (the pinned
   * SDK stamps it on every frame a Task's subagent produces). The panel
   * renders ONE operator turn and its runs do not set `forwardSubagentText`,
   * so a subagent's text/thinking never arrives as a complete message to
   * reconcile against — displaying its fragments would leave unreconcilable
   * text inside the operator's answer. They are dropped here, at the
   * presentation layer; the host's forwarding is unchanged.
   *
   * A fragment never creates a turn (design decision 10): without the run's
   * own lifecycle already applied there is nothing to stream into, and the
   * complete message still delivers the text in full. */
  _applyStreamPartial(runId, sdkMessage) {
    if (sdkMessage && sdkMessage.parent_tool_use_id != null) return;
    const streamEvent = sdkMessage && sdkMessage.event;
    if (!streamEvent || typeof streamEvent !== "object") return;
    const turn = this._turnsByRunId.get(runId);
    if (!turn) return;
    switch (streamEvent.type) {
      case "message_start": {
        // Opens the id every following delta of this message is keyed by.
        const id = streamEvent.message && streamEvent.message.id;
        if (id != null) this._partialRun(runId, { create: true }).currentMessageId = String(id);
        break;
      }
      case "content_block_start": {
        const block = streamEvent.content_block || {};
        if (block.type === "redacted_thinking") {
          turn.redactedThinking = true;
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          this._appendPartialRun(runId, "thinking", block.thinking, turn);
        } else if (block.type === "text" && typeof block.text === "string" && block.text) {
          this._appendPartialRun(runId, "text", block.text, turn);
        }
        break;
      }
      case "content_block_delta": {
        const delta = streamEvent.delta || {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          this._appendPartialRun(runId, "text", delta.text, turn);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          this._appendPartialRun(runId, "thinking", delta.thinking, turn);
        }
        break;
      }
      case "content_block_stop":
      case "message_delta":
      case "message_stop":
      default:
        // Closing state the complete message already owns; anything else is
        // an event kind this panel does not display and ignores without
        // failing (the same tolerance the old panel had for a fragment it
        // did not recognize).
        break;
    }
  }

  /** Apply one fragment to the turn AND remember it in the message's buffer,
   * so the complete message can append only the missing suffix. The buffer's
   * start offset anchors the fragment text inside the turn's text/thinking,
   * which is what lets a buffer that is NOT a prefix of the complete text be
   * superseded at the exact spot it occupied instead of duplicated. Each kind
   * keeps its own run of streamed text, because one message id can carry a
   * thinking block and a text block. */
  _appendPartialRun(runId, kind, text, turn) {
    const buf = this._bufferFor(runId, null); // current message id, opened by message_start
    if (!buf) return; // no message_start seen: no id to reconcile against
    const state = buf[kind];
    if (state.start == null) state.start = turn[kind].length;
    state.streamed += text;
    turn[kind] += text;
    if (kind === "text") {
      // Fragments feed the existing derivation exactly as complete text
      // blocks do: the busy indicator clears when text actually starts
      // appearing (tasks.md 2.4), without changing isBusy() itself.
      turn.lastContentKind = "text";
    }
  }

  /** Append a complete content block of `kind` ("text" or "thinking"),
   * subtracting whatever the fragments for this message id already displayed.
   * A streamed run that is a prefix of the complete block is appended
   * suffix-only; one the complete block extends from (a longer streamed run
   * covering several blocks of the same id) is consumed head-first, leaving
   * the rest anchored for its own block; anything else is superseded by the
   * complete block at the exact span it occupied (treated as authoritative).
   * `state` is the kind's buffer slot, or null when this id streamed nothing
   * of this kind — then the block is the only source and is appended in full. */
  _reconcileCompleteBlock(turn, kind, text, state) {
    if (!text) return;
    const streamed = state && state.streamed;
    if (!streamed) {
      turn[kind] += text;
      return;
    }
    if (streamed.startsWith(text)) {
      state.streamed = streamed.slice(text.length);
      state.start = state.streamed ? state.start + text.length : null;
      return;
    }
    if (text.startsWith(streamed)) {
      turn[kind] += text.slice(streamed.length);
      state.streamed = "";
      state.start = null;
      return;
    }
    turn[kind] = turn[kind].slice(0, state.start) + text + turn[kind].slice(state.start + streamed.length);
    state.streamed = "";
    state.start = null;
  }

  _partialRun(runId, { create = false } = {}) {
    let run = this._partialBuffers.get(runId);
    if (!run && create) {
      run = { currentMessageId: null, byMessage: new Map() };
      this._partialBuffers.set(runId, run);
    }
    return run || null;
  }

  /** The open message's buffer, created on first use. `messageId` (a fresh
   * `message_start`) re-keys the run; passing null uses the id already open. */
  _bufferFor(runId, messageId) {
    const run = this._partialRun(runId, { create: true });
    if (messageId != null) run.currentMessageId = String(messageId);
    const id = run.currentMessageId;
    if (id == null) return null;
    let buf = run.byMessage.get(id);
    if (!buf) {
      buf = { text: { streamed: "", start: null }, thinking: { streamed: "", start: null } };
      run.byMessage.set(id, buf);
    }
    return buf;
  }

  /** The existing buffer for a message id, or null — used by the complete
   * message so it never creates a buffer of its own. */
  _bufferEntryFor(runId, messageId) {
    if (messageId == null) return null;
    const run = this._partialBuffers.get(runId);
    return run ? run.byMessage.get(messageId) || null : null;
  }

  /** Drop a message id's buffer once it has nothing left unconsumed (the
   * common case after its content blocks have all been reconciled). The id
   * itself is deliberately left open (`currentMessageId`) so a fragment from
   * a later block of the same streamed message still re-opens a buffer for
   * it. */
  _releaseConsumedBuffer(runId, messageId, buf) {
    if (!buf || messageId == null) return;
    if (buf.text.streamed || buf.thinking.streamed) return;
    const run = this._partialBuffers.get(runId);
    if (run) run.byMessage.delete(messageId);
  }

  /** A run reached a terminal state: its fragments can never be confirmed
   * again, so its buffers are dropped (design decision 10). */
  _dropPartialBuffers(runId) {
    this._partialBuffers.delete(runId);
  }

  /** The overall panel phase, per spec's 11 named states. `ctx` carries
   * panel-level (not per-conversation) facts. Lifecycle values on the
   * current turn are: created|queued|running|stopping|stopped|done|error|
   * interrupted — "stopping" is set client-side by markStopRequested()
   * only, since the host has no separate "stopping" wire state (it replies
   * to STOP once the run has actually stopped). */
  derivePhase({ connectionStatus, hasProfile } = {}) {
    if (connectionStatus === "version_mismatch" || connectionStatus === "error") return RUN_PHASE.ERROR;
    if (connectionStatus !== "ok") return RUN_PHASE.CONNECTING;
    // Task 2.4: a paused download suspends the SAME way a host-issued
    // approval does, from the operator's point of view — something is
    // waiting on their decision — even though nothing here is a host
    // request.
    if (this.pendingApproval || this.pendingDownloadDecision) return RUN_PHASE.WAITING_FOR_PERMISSION;
    // Task 9.7: a pending question also suspends the run, so the phase is
    // STREAMING (the model is waiting on tool result). Using the same
    // "waiting-for-permission" phase would mislead the user into thinking
    // they need to approve an action when it's actually just a question.
    // The question card renders independently via renderQuestion().
    // Deliberately not adding a separate WAITING_FOR_QUESTION phase —
    // the run is still streaming (generating), just paused on the user's
    // input.
    if (this.pendingQuestion) return RUN_PHASE.STREAMING;

    const turn = this._latestTurn();
    if (turn) {
      switch (turn.lifecycle) {
        case "queued":
          return RUN_PHASE.QUEUED;
        case "created":
        case "running":
          return RUN_PHASE.STREAMING;
        case "stopping":
          return RUN_PHASE.STOPPING;
        case "stopped":
          return RUN_PHASE.STOPPED;
        case "done":
          return RUN_PHASE.COMPLETED;
        case "error":
          return RUN_PHASE.ERROR;
        case "interrupted":
          return RUN_PHASE.INTERRUPTED;
        default:
          break;
      }
    }
    void hasProfile; // profile-gating (disable send / show setup guidance) is a composer concern, not a phase value
    return this.items.length === 0 ? RUN_PHASE.EMPTY : RUN_PHASE.READY;
  }

  /** Client-optimistic "stopping" sub-phase between the Stop click and the
   * run_stopped event actually arriving. Call before sending STOP. */
  markStopRequested() {
    const turn = this._latestTurn();
    if (turn && (turn.lifecycle === "running" || turn.lifecycle === "queued" || turn.lifecycle === "created")) {
      turn.lifecycle = "stopping";
    }
  }

  _latestTurn() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === "assistant_turn") return this.items[i];
    }
    return null;
  }

  // Visibility condition for the busy/working indicator (Section 6). Never
  // used by any other surface. Derives only from data the turn model already
  // holds -- phase/state plus turn text/lastContentKind -- not from any new
  // wire-level run state. Rule, per spec 6.2 / design decision 6:
  //   - shown while queued (any turn in queued counts)
  //   - while streaming with no answer text currently arriving: no `text` since
  //     run start, OR most recently applied content block is tool_use
  //   - HIDDEN whenever pendingQuestion or pendingApproval is set, even though
  //     phase still reports STREAMING for the former
  //   - never shown for empty/connecting/ready/waiting-for-permission/
  //     stopping/stopped/interrupted/completed/error
  isBusy() {
    if (this.pendingApproval || this.pendingQuestion || this.pendingDownloadDecision) return false;
    const turn = this._latestTurn();
    if (!turn) return false;
    if (turn.lifecycle === "queued") return true;
    if (turn.lifecycle !== "running" && turn.lifecycle !== "created") return false;
    if (!turn.text || turn.text.length === 0) return true;
    return turn.lastContentKind === "tool_use";
  }

  // Wall-clock anchor for the busy indicator's elapsed count. Same timestamp
  // the collapsed timeline summary uses: the turn's recorded creation instant
  // (`turn.ts`), which on a snapshot replay is restored from the original
  // stored-event `ts`, not reset to the reconnect time.
  busyElapsedSeconds(now = Date.now()) {
    const turn = this._latestTurn();
    if (!turn) return 0;
    return Math.max(0, Math.floor((now - turn.ts) / 1000));
  }

  hasActiveRun() {
    const turn = this._latestTurn();
    return !!turn && ["created", "queued", "running", "stopping"].includes(turn.lifecycle);
  }
}

function findOldestUnresolved(toolRows, toolName) {
  for (const row of toolRows) {
    if (row.status === "running" && (toolName == null || row.toolName === toolName)) return row;
  }
  return null;
}

export function toolRowDisplay(row) {
  return {
    ...row,
    label: row.status === "running" ? humanToolLabelRunning(row.toolName, row.args) : humanToolLabel(row.toolName, row.args),
    detail: summarizeArgsForDetail(row.toolName, row.args)
  };
}

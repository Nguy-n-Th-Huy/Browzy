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
  /** @param {string} conversationId */
  constructor(conversationId) {
    this.conversationId = conversationId;
    this._reset();
  }

  _reset() {
    this.items = []; // ordered: {kind:"user"|"assistant_turn"|"recording"}
    this.lastSeq = 0;
    this.meta = null;
    this.pendingApproval = null; // {action, target, requestId, ts}
    // Task 9.7: pending question — the user's choice resolves via
    // panel-controller.js's respondQuestion() with the matching requestId.
    // Mirror of pendingApproval, persisted and restored via the same
    // sequenced-event/replay mechanism.
    this.pendingQuestion = null; // {question, header, options, requestId, multiSelect, ts}
    this.connectionError = null; // {reason, detail} — conversation-scoped errors (run_error)
    this._turnsByRunId = new Map(); // runId -> item (assistant_turn)
    this._pendingUserIndex = null; // index of a just-sent, not-yet-bound user item
    this._localPrompts = new Map(); // runId -> original prompt text (this session's own echo cache)
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
   * lastSeq, events}), per design decision 3 above. */
  applySnapshot(snapshot) {
    const keepPrompts = this._localPrompts;
    this._reset();
    this._localPrompts = keepPrompts;
    if (!snapshot) return;
    this.meta = snapshot.meta || null;
    this.lastSeq = snapshot.lastSeq || 0;
    for (const event of snapshot.events || []) {
      this.applyEvent(event);
    }
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
        text: "",
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
   * three shapes carry the same fields plus, for snapshot events, `seq`). */
  applyEvent(event) {
    if (!event || typeof event !== "object") return;
    if (typeof event.seq === "number" && event.seq > this.lastSeq) this.lastSeq = event.seq;

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
        break;
      }
      case "run_done": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "done";
        turn.complete = true;
        break;
      }
      case "run_error": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "error";
        turn.complete = false;
        turn.errorInfo = { reason: event.reason || "run_error", detail: event.detail };
        break;
      }
      case "run_interrupted_by_restart": {
        const turn = this._turnFor(event.runId, { createIfMissing: true, ts: event.ts });
        turn.lifecycle = "interrupted";
        turn.complete = false;
        for (const row of turn.toolRows) {
          if (row.status === "running") row.status = "unknown";
        }
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
      case "approval_request":
        this.pendingApproval = {
          runId: event.runId,
          action: event.action,
          target: event.target,
          requestId: event.requestId,
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
      for (const block of message.message.content) {
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string") {
          turn.text += block.text;
          // The busy/working indicator's visibility condition (see isBusy())
          // needs "has answer text been applied since run start / since the
          // most recent tool_use". That is derived from this existing block
          // stream -- we only record which kind of content block was applied
          // most recently. A "user"-type tool_result message deliberately
          // does NOT touch this field: a tool finishing is not answer text
          // resuming.
          turn.lastContentKind = "text";
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

  /** The overall panel phase, per spec's 11 named states. `ctx` carries
   * panel-level (not per-conversation) facts. Lifecycle values on the
   * current turn are: created|queued|running|stopping|stopped|done|error|
   * interrupted — "stopping" is set client-side by markStopRequested()
   * only, since the host has no separate "stopping" wire state (it replies
   * to STOP once the run has actually stopped). */
  derivePhase({ connectionStatus, hasProfile } = {}) {
    if (connectionStatus === "version_mismatch" || connectionStatus === "error") return RUN_PHASE.ERROR;
    if (connectionStatus !== "ok") return RUN_PHASE.CONNECTING;
    if (this.pendingApproval) return RUN_PHASE.WAITING_FOR_PERMISSION;
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
    if (this.pendingApproval || this.pendingQuestion) return false;
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

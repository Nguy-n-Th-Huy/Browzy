// Thin client for the versioned agent protocol (host/agent/protocol.js),
// spoken over the "ocic-agent" chrome.runtime port that
// extension/background.js already relays verbatim to/from the native host
// (see background.js's `agentPorts` / `handleAgentMessage`). This module
// owns ONLY envelope shaping and the connection lifecycle; it does not
// interpret stream_event/snapshot payloads itself -- that is
// conversation-model.js's job, kept separate so each half is independently
// testable (this file needs no DOM, no chrome.tabs, no IndexedDB).
//
// The wire message types mirrored here (hello/hello_ack/version_mismatch/
// new/resume/snapshot_request/snapshot/start/stop/approval_decision/
// stream_event/token_batch/recording_complete/error) are exactly
// host/agent/protocol.js's AGENT_MESSAGE_TYPES -- this file cannot import
// that Node ES module directly (it runs in the extension's own module
// graph, same constraint background.js documents for
// AGENT_PROTOCOL_VERSION), so the literals are kept in sync by hand. Do NOT
// add a message type here that protocol.js does not define; report a gap
// instead of inventing a second protocol.
//
// `APPROVAL_REQUEST` is defined by protocol.js but, as of this task, never
// actually emitted by host/agent/companion.js (the SDK canUseTool wiring
// that would emit it is not yet built -- see reports/05-panel-evidence.md).
// This client defensively accepts it in either of the two transmission
// shapes the rest of the protocol already uses elsewhere (a dedicated
// top-level envelope, matching how START/STOP work, OR nested inside a
// stream_event's `event`, matching how tool_rejected/tool_result_unknown
// already arrive) so the panel is ready the moment that wiring lands,
// without guessing at a third shape.

export const AGENT_PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
  HELLO: "hello",
  HELLO_ACK: "hello_ack",
  VERSION_MISMATCH: "version_mismatch",
  START: "start",
  RESUME: "resume",
  NEW: "new",
  STOP: "stop",
  APPROVAL_REQUEST: "approval_request",
  APPROVAL_DECISION: "approval_decision",
  // Task 9.7: question_request/question_answer mirror the approval pair.
  QUESTION_REQUEST: "question_request",
  QUESTION_ANSWER: "question_answer",
  SNAPSHOT_REQUEST: "snapshot_request",
  SNAPSHOT: "snapshot",
  STREAM_EVENT: "stream_event",
  TOKEN_BATCH: "token_batch",
  RECORDING_COMPLETE: "recording_complete",
  // Composer prompt enhancement (host/agent/protocol.js's
  // AGENT_MESSAGE_TYPES.ENHANCE_PROMPT). Additive, no PROTOCOL_VERSION bump —
  // an older companion answers through the existing `unknown_message_type`
  // ERROR path above, which sidepanel.js maps to a "companion needs
  // updating" state.
  ENHANCE_PROMPT: "enhance_prompt",
  // Agent-created documents (host/agent/protocol.js's DOCUMENT_REQUEST /
  // DOCUMENT). Additive under the same PROTOCOL_VERSION: an older companion
  // answers an unknown type through the existing ERROR path, which the panel
  // already surfaces as "companion needs updating". The bytes themselves come
  // back as a chunk_begin/chunk_part*/chunk_end sequence, which
  // background.js already relays verbatim and documents-client.js reassembles.
  //
  // protocol.js also defines DOCUMENT_LIST_REQUEST/DOCUMENT_LIST. The panel
  // does not send it: applySnapshot() already performs a full rebuild from
  // the conversation's persisted event stream, so a reopened conversation's
  // document cards come back from the replayed `document_created` events with
  // no extra round trip. The pair stays host-side for a client that has no
  // transcript to replay.
  DOCUMENT_REQUEST: "document_request",
  DOCUMENT: "document",
  ERROR: "error"
});

export const HANDSHAKE = Object.freeze({
  PENDING: "pending",
  OK: "ok",
  VERSION_MISMATCH: "version_mismatch",
  ERROR: "error"
});

function envelope(type, payload = {}) {
  return { v: AGENT_PROTOCOL_VERSION, type, ...payload, ts: Date.now() };
}

/**
 * @param {object} deps
 * @param {() => { postMessage(msg: object): void, onMessage: {addListener(fn):void}, onDisconnect: {addListener(fn):void}, disconnect(): void }} deps.createTransport -
 *   defaults to `chrome.runtime.connect({ name: "ocic-agent" })`; injectable
 *   so tests can supply an in-memory transport (e.g. one wired directly to a
 *   real host/agent/companion.js CompanionCore instance -- the "fake
 *   companion harness" this task's environment constraint calls for).
 * @param {() => number} [deps.now]
 */
export class ProtocolClient {
  constructor({ createTransport, now = Date.now } = {}) {
    this._createTransport = createTransport || defaultCreateTransport;
    this._now = now;
    this._port = null;
    this._handshake = HANDSHAKE.PENDING;
    this._handshakeDetail = null;
    this._envelopeHandlers = new Set();
    this._handshakeHandlers = new Set();
    this._disconnectHandlers = new Set();
  }

  handshakeState() {
    return this._handshake;
  }
  handshakeDetail() {
    return this._handshakeDetail;
  }

  onEnvelope(fn) {
    this._envelopeHandlers.add(fn);
    return () => this._envelopeHandlers.delete(fn);
  }
  onHandshakeChange(fn) {
    this._handshakeHandlers.add(fn);
    return () => this._handshakeHandlers.delete(fn);
  }
  onDisconnect(fn) {
    this._disconnectHandlers.add(fn);
    return () => this._disconnectHandlers.delete(fn);
  }

  connect() {
    if (this._port) return;
    this._port = this._createTransport();
    this._port.onMessage.addListener((msg) => this._handleIncoming(msg));
    this._port.onDisconnect.addListener(() => {
      this._port = null;
      this._handshake = HANDSHAKE.PENDING;
      this._handshakeDetail = null;
      for (const fn of this._disconnectHandlers) fn();
    });
  }

  disconnect() {
    if (this._port) {
      try {
        this._port.disconnect();
      } catch {
        /* already gone */
      }
    }
    this._port = null;
  }

  isConnected() {
    return !!this._port;
  }

  _handleIncoming(msg) {
    if (!msg || msg.type !== "agent_msg" || !msg.envelope || typeof msg.envelope !== "object") return;
    const env = msg.envelope;
    if (env.type === MSG.HELLO_ACK) {
      this._setHandshake(HANDSHAKE.OK, null);
    } else if (env.type === MSG.VERSION_MISMATCH) {
      this._setHandshake(HANDSHAKE.VERSION_MISMATCH, env.reason || "unsupported_version");
    } else if (env.type === MSG.ERROR && !env.conversationId) {
      // A connection-scoped error (e.g. native_host_unavailable) rather than
      // a per-conversation one -- conversation-scoped errors still flow
      // through onEnvelope for conversation-model.js to attribute correctly.
      // `companion_not_installed` is the sharper sibling of
      // `native_host_unavailable`: the host is not merely unreachable right
      // now, Chrome says it is not registered for this extension at all. Both
      // are connection-scoped errors; the reason is carried through as the
      // detail so the UI can tell the operator which one they are looking at.
      if (env.reason === "native_host_unavailable" || env.reason === "companion_not_installed") {
        this._setHandshake(HANDSHAKE.ERROR, env.reason);
      }
    }
    for (const fn of this._envelopeHandlers) fn(env);
  }

  _setHandshake(state, detail) {
    this._handshake = state;
    this._handshakeDetail = detail;
    for (const fn of this._handshakeHandlers) fn(state, detail);
  }

  _send(env) {
    if (!this._port) throw new Error("ProtocolClient: not connected");
    this._port.postMessage({ type: "agent_msg", envelope: env });
  }

  sendHello({ installationId, connectionId } = {}) {
    this._send(envelope(MSG.HELLO, { installationId, connectionId }));
  }

  newConversation(meta = {}) {
    this._send(envelope(MSG.NEW, { meta }));
  }

  resumeConversation(conversationId, afterSeq = 0) {
    this._send(envelope(MSG.RESUME, { conversationId, afterSeq }));
  }

  requestSnapshot(conversationId, afterSeq = 0) {
    this._send(envelope(MSG.SNAPSHOT_REQUEST, { conversationId, afterSeq }));
  }

  /**
   * `context`, when present, is panel-controller.js's structured trusted
   * page-context metadata (extension/sidepanel/context-binding.js's
   * `buildContextMetadata()` output) — a field DISTINCT from `prompt`
   * (design.md section 5: "User messages and page/tool content remain
   * distinctly typed"). host/agent/companion.js forwards it verbatim into
   * host/agent/tools/query-options.js's constructed `query()` options as the
   * SDK's own `systemPrompt`, never mixed into the wire `prompt` text.
   * `attachments`, when present, is an additive optional field of artifact
   * references (never raw bytes) — ignored by older companions.
   */
  start({ conversationId, profileId, modelId, tabScope, prompt, context, attachments, effort, elementRecord }) {
    const payload = { conversationId, profileId, modelId, tabScope, prompt, context };
    if (attachments && attachments.length) payload.attachments = attachments;
    // Absent, not null: the companion reads an absent field as "send no effort
    // parameter", and writing an explicit null would say the same thing in a
    // shape older peers have no reason to expect.
    if (effort) payload.effort = effort;
    // openspec/changes/add-design-mode-element-picker, design.md D7: a
    // design-mode picked element's own field, beside `attachments` — never
    // spliced into `prompt`. Additive optional: an old companion ignores it.
    if (elementRecord) payload.elementRecord = elementRecord;
    this._send(envelope(MSG.START, payload));
  }

  stop({ conversationId, reason = "user_stop" }) {
    this._send(envelope(MSG.STOP, { conversationId, reason }));
  }

  /**
   * @param {boolean} [remember] - Task 7.3: "remember this decision" — sent
   *   ONLY when the user explicitly asked for it (omitted, never `false`,
   *   otherwise). host/agent/policy/can-use-tool.js's own gating
   *   (`decision.remember === true && modeDecision.rememberable === true`)
   *   is the actual authority on whether it takes effect — this is never
   *   offered by the panel for a protected decision in the first place (see
   *   sidepanel.js's renderPermission()), but the wire itself carries no
   *   assumption either way.
   */
  approvalDecision({ conversationId, decision, action, target, requestId, ttlMs, remember }) {
    // Task 9.6: include requestId so the companion correlates the reply with
    // the original approval_request. An unknown/mismatched requestId is
    // rejected by the companion, not silently applied.
    const payload = { conversationId, decision, action, target, requestId, ttlMs };
    if (remember === true) payload.remember = true;
    this._send(envelope(MSG.APPROVAL_DECISION, payload));
  }

  /**
   * Task 2.4: the panel's answer to a LOCAL, background.js-synthesized
   * "download_protected_decision" envelope — never a
   * host/agent/protocol.js message. chrome.downloads carries no tabId, so
   * there is nothing for the host's per-call approval-token binding
   * (host/agent/policy/approvals.js) to verify against; background.js
   * pauses the download itself and intercepts this reply BEFORE it ever
   * reaches nativePort (see background.js's "ocic-agent" port.onMessage
   * handler), resuming or cancelling the download locally. `download_decision`
   * is deliberately NOT one of host/agent/protocol.js's AGENT_MESSAGE_TYPES
   * and must never be added there — see this file's own header note about
   * not inventing a second protocol on the wire that reaches the companion.
   */
  downloadDecision({ requestId, decision }) {
    this._send(envelope("download_decision", { requestId, decision }));
  }

  /**
   * Task 2.4: tell background.js to invalidate every outstanding download
   * decision it is tracking — the panel's own trigger today is a successful
   * permission-mode change (PanelController.invalidateAllPendingApprovals()),
   * the exact same event that already clears every ordinary `pendingApproval`
   * card. Same LOCAL-only rule as downloadDecision() above: this type is
   * deliberately not one of host/agent/protocol.js's AGENT_MESSAGE_TYPES and
   * never reaches nativePort — background.js intercepts it in its
   * "ocic-agent" port.onMessage handler.
   */
  invalidateDownloadDecisions(reason) {
    this._send(envelope("download_decisions_invalidate", { reason }));
  }

  // Task 9.7 (design.md section 8): the panel's answer to a question_request.
  // Mirror-image of approvalDecision — the requestId correlates the
  // companion-pushed question and the panel's answer.
  questionAnswer({ conversationId, requestId, answer }) {
    this._send(envelope(MSG.QUESTION_ANSWER, { conversationId, requestId, answer }));
  }

  /**
   * Composer prompt enhancement (design.md decision 1 / task 4.2). One
   * envelope shape covers both ops, matching host/agent/protocol.js's
   * documented wire contract exactly:
   *   op:"generate" -> {requestId, op, prompt, profileId, modelId}
   *   op:"cancel"   -> {requestId, op} — prompt/profileId/modelId are
   *                     omitted, not sent as null, since the companion's
   *                     cancel branch never reads them.
   * The reply (also type enhance_prompt, correlated by requestId) surfaces
   * through onEnvelope() like every other request/reply pair here — this
   * class does not itself interpret it.
   */
  /** Ask for one document's bytes. The reply is either a chunked sequence or
   * a `document` envelope with found:false — both correlated by requestId,
   * both surfacing through onEnvelope() like every other pair here. */
  documentRequest({ conversationId, documentId, requestId }) {
    this._send(envelope(MSG.DOCUMENT_REQUEST, { conversationId, documentId, requestId }));
  }

  enhancePrompt({ requestId, op, prompt, profileId, modelId }) {
    const payload = op === "cancel" ? { requestId, op } : { requestId, op, prompt, profileId, modelId };
    this._send(envelope(MSG.ENHANCE_PROMPT, payload));
  }
}

function defaultCreateTransport() {
  return chrome.runtime.connect({ name: "ocic-agent" });
}

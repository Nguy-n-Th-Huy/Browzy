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
  // Conversation management (host/agent/protocol.js's LIST_CONVERSATIONS /
  // DELETE_CONVERSATION / UPDATE_CONVERSATION / DELETE_ALL_CONVERSATIONS /
  // TRANSCRIPT_WINDOW_REQUEST, added for openspec/changes/optimize-chat-history
  // tasks 1.1–1.3 and 3.2). Request/reply share one type name exactly as the
  // host documents; every reply is correlated by `requestId` (or, for the
  // list family, carries the host's authoritative array). Additive under
  // PROTOCOL_VERSION 1: an older companion answers `unknown_message_type`
  // through the existing ERROR path, which the panel already maps to a
  // "companion needs updating" state rather than hanging.
  LIST_CONVERSATIONS: "list_conversations",
  DELETE_CONVERSATION: "delete_conversation",
  UPDATE_CONVERSATION: "update_conversation",
  DELETE_ALL_CONVERSATIONS: "delete_all_conversations",
  TRANSCRIPT_WINDOW_REQUEST: "transcript_window_request",
  TRANSCRIPT_WINDOW: "transcript_window",
  // Composer prompt enhancement (host/agent/protocol.js's
  // AGENT_MESSAGE_TYPES.ENHANCE_PROMPT). Additive, no PROTOCOL_VERSION bump —
  // an older companion answers through the existing `unknown_message_type`
  // ERROR path above, which sidepanel.js maps to a "companion needs
  // updating" state.
  ENHANCE_PROMPT: "enhance_prompt",
  // User-mediated upload grants (host/agent/protocol.js's UPLOAD_GRANT): the
  // operator's own native-dialog file selection, sent per conversation. The
  // reply (same type, correlated by requestId) reports, per path, what the
  // companion actually granted — the panel renders only that.
  UPLOAD_GRANT: "upload_grant",
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
  // Message-queue operator controls (openspec/changes/add-message-queue-and-
  // steering, design.md decisions 4/5). Mirrors host/agent/protocol.js's own
  // CANCEL_MESSAGE / RESUME_QUEUE, which document the wire shapes in full;
  // both are request/reply pairs correlated by `requestId`, and both are
  // additive under PROTOCOL_VERSION 1 — an older companion answers
  // unknown_message_type through the existing ERROR path above.
  CANCEL_MESSAGE: "cancel_message",
  RESUME_QUEUE: "resume_queue",
  // Rerunnable workflows + self-healing (openspec/changes/
  // add-workflow-materialization-and-heal). Five request/reply pairs, all
  // additive under PROTOCOL_VERSION 1 — an older companion answers each of
  // them with the existing `unknown_message_type` ERROR path above, which the
  // panel already maps to a "companion needs updating" state rather than
  // hanging:
  //   workflow_draft_request — derive a draft from one completed run's trail
  //   workflow_draft_save    — validate + store it disabled (never enabled by
  //                            the derivation itself)
  //   workflow_prove         — run the stored definition live ONCE for
  //                            evidence, before it may be enabled
  //   workflow_enable        — the operator's explicit enable, after a proof
  //   workflow_heal_decide   — Allow/Deny for one heal proposal
  //   workflow_edit_request  — fetch one stored definition's editable steps
  //   workflow_edit_save     — store an operator-edited steps array as the
  //                            next version of the line
  // The events these operations append (`workflow_draft_saved`,
  // `workflow_proof`, `workflow_drift`, `workflow_heal_*`, `workflow_enabled`,
  // `workflow_updated`) are NOT envelope types: they ride the existing
  // stream_event/token_batch envelopes into conversation-model.js like every
  // other transcript event.
  WORKFLOW_DRAFT_REQUEST: "workflow_draft_request",
  WORKFLOW_DRAFT_SAVE: "workflow_draft_save",
  WORKFLOW_PROVE: "workflow_prove",
  WORKFLOW_ENABLE: "workflow_enable",
  WORKFLOW_HEAL_DECIDE: "workflow_heal_decide",
  WORKFLOW_EDIT_REQUEST: "workflow_edit_request",
  WORKFLOW_EDIT_SAVE: "workflow_edit_save",
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

  /**
   * Ask for the host's AUTHORITATIVE conversation list (tasks.md 1.2). The
   * reply reuses this type name and is correlated by `requestId` — the panel
   * layer resolves it through onEnvelope() like every other pair here.
   */
  listConversations({ requestId, limit } = {}) {
    const payload = { requestId };
    if (Number.isInteger(limit) && limit > 0) payload.limit = limit;
    this._send(envelope(MSG.LIST_CONVERSATIONS, payload));
  }

  /** Push presentation metadata the panel owns (title/hostname) or the
   * operator asked for (pin/archive). `patch` carries only changed fields;
   * `ifRevision` (inside `patch`) makes a stale write fail with a conflict
   * instead of clobbering a newer edit from another panel. */
  updateConversation({ conversationId, patch, requestId }) {
    this._send(envelope(MSG.UPDATE_CONVERSATION, { conversationId, ...(patch || {}), requestId }));
  }

  /**
   * Host-side delete with an idempotency key (tasks.md 1.3, design.md
   * decision 5). The reply carries `deleted` — the panel may only drop its
   * local cache for a confirmed `deleted:true`.
   */
  deleteConversation({ conversationId, idempotencyKey, requestId }) {
    this._send(envelope(MSG.DELETE_CONVERSATION, { conversationId, idempotencyKey, requestId }));
  }

  /** Host-side delete-all; same confirmation contract as deleteConversation. */
  deleteAllConversations({ idempotencyKey, requestId }) {
    this._send(envelope(MSG.DELETE_ALL_CONVERSATIONS, { idempotencyKey, requestId }));
  }

  /** One older transcript page by sequence range (tasks.md 3.2). */
  requestTranscriptWindow({ conversationId, beforeSeq, limit, requestId }) {
    const payload = { conversationId, requestId };
    if (Number.isInteger(beforeSeq) && beforeSeq > 0) payload.beforeSeq = beforeSeq;
    if (Number.isInteger(limit) && limit > 0) payload.limit = limit;
    this._send(envelope(MSG.TRANSCRIPT_WINDOW_REQUEST, payload));
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
  start({ conversationId, profileId, modelId, tabScope, prompt, context, attachments, effort, elementRecord, mode, idempotencyKey, privacy }) {
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
    // Message-queue send mode (host/agent/protocol.js's START_MODES,
    // openspec/changes/add-message-queue-and-steering design.md decisions
    // 3/7): "queue" files the message behind the conversation's active run,
    // "interrupt" is the panel's explicit run-now choice. Sent explicitly by
    // the panel's own Send (see panel-controller.js sendMessage()) so the
    // envelope states which of the two this submission is, rather than
    // relying on the host's default for it.
    if (mode) payload.mode = mode;
    // Retry identity for a queued send (design.md decision 7 / task 1.4): a
    // duplicate delivery of the SAME send resolves to the entry it already
    // created instead of queueing the message twice.
    if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
    // openspec/changes/add-task-memory: the history privacy policy for this
    // turn ({ rawPromptCaching }). Additive optional: an old companion
    // ignores it, and absent means "no policy stated".
    if (privacy && typeof privacy === "object") payload.privacy = privacy;
    this._send(envelope(MSG.START, payload));
  }

  /**
   * Cancel one still-`pending` queued message (task 6.2's per-message cancel
   * affordance). The reply reuses this type name and is correlated by
   * `requestId` like every other request/reply pair here; a message the next
   * turn has already claimed is refused host-side with the claimed state
   * disclosed, never applied optimistically.
   */
  cancelMessage({ conversationId, messageId, requestId }) {
    this._send(envelope(MSG.CANCEL_MESSAGE, { conversationId, messageId, requestId }));
  }

  /** Resume a drain Stop paused (task 6.2's resume control); correlated by
   * `requestId` like cancelMessage above. */
  resumeQueue({ conversationId, requestId }) {
    this._send(envelope(MSG.RESUME_QUEUE, { conversationId, requestId }));
  }

  /**
   * Ask the host to derive a workflow draft from ONE completed run's recorded
   * action trail and bound context (openspec/changes/
   * add-workflow-materialization-and-heal). Derived from the transcript, never
   * from model memory; the host answers `{ok:true, draft, review}` for a fully
   * resolved derivation, `{ok:false, incomplete:[reasons]}` for a trail with
   * gaps it refuses to guess around, or `{ok:false, reason}` (`unknown_run`,
   * `run_not_completed`, `no_trail`, `unknown_conversation`). Nothing is stored
   * or enabled by this call.
   */
  workflowDraftRequest({ conversationId, runId, requestId }) {
    this._send(envelope(MSG.WORKFLOW_DRAFT_REQUEST, { conversationId, runId, requestId }));
  }

  /**
   * Save a reviewed draft as a DISABLED workflow — the derivation and this
   * save both never enable it; enabling is the separate, post-proof step below.
   * The host re-validates the definition with the registry's own schema and
   * answers `{ok:true, workflowId, version}` or
   * `{ok:false, reason:"invalid_definition", errors:[...]}`.
   */
  workflowDraftSave({ conversationId, runId, definition, requestId }) {
    this._send(envelope(MSG.WORKFLOW_DRAFT_SAVE, { conversationId, runId, definition, requestId }));
  }

  /**
   * Run one stored workflow against the live page, for evidence, before it may
   * be enabled. The reply is `{ok:true, outcomes, evidenceFile}` when the proof
   * executed — `ok` is the host's verdict on the execution, `outcomes` the
   * per-step detail — or `{ok:false, reason}` where reason names why no proof
   * happened at all (`unknown_workflow`, `busy`, `bridge_unavailable`,
   * `bridge_error`, `extension_error`). `version` pins the exact record being
   * proved; `tabId` is the page the proof runs against.
   */
  workflowProve({ conversationId, workflowId, version, tabId, requestId }) {
    this._send(envelope(MSG.WORKFLOW_PROVE, { conversationId, workflowId, version, tabId, requestId }));
  }

  /** Enable a proven workflow (`{ok:true, version}`). The host owns the
   * version check — a stale version comes back as
   * `{ok:false, reason:"stale_version", latest}` rather than overwriting a
   * newer record. */
  workflowEnable({ conversationId, workflowId, version, requestId }) {
    this._send(envelope(MSG.WORKFLOW_ENABLE, { conversationId, workflowId, version, requestId }));
  }

  /** Allow or deny one heal proposal. `decision:"allow"` saves a new version
   * through the registry's existing version bump; `"deny"` is a recorded
   * no-op. Refusals disclose state: `unknown_proposal`, `expired`,
   * `superseded`, `stale_base`, `invalid_candidate`. */
  workflowHealDecide({ conversationId, proposalId, decision, requestId }) {
    this._send(envelope(MSG.WORKFLOW_HEAL_DECIDE, { conversationId, proposalId, decision, requestId }));
  }

  /** Fetch one stored definition's editable steps: reply `{ok:true,
   * workflowId, version, name, steps}` or `{ok:false, reason}`. */
  workflowEditRequest({ conversationId, workflowId, version, requestId }) {
    this._send(envelope(MSG.WORKFLOW_EDIT_REQUEST, { conversationId, workflowId, version, requestId }));
  }

  /** Save an operator-edited steps array as the next version (`{ok:true,
   * version}`), or a refusal naming why — `stale_version` (with `latest`),
   * `invalid_candidate` (with the registry's `errors`), `unknown_workflow`. */
  workflowEditSave({ conversationId, workflowId, version, steps, requestId }) {
    this._send(envelope(MSG.WORKFLOW_EDIT_SAVE, { conversationId, workflowId, version, steps, requestId }));
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

  actionArtifactRequest({ conversationId, artifactId, requestId }) {
    this._send(envelope("action_artifact_request", { conversationId, artifactId, requestId }));
  }

  enhancePrompt({ requestId, op, prompt, profileId, modelId }) {
    const payload = op === "cancel" ? { requestId, op } : { requestId, op, prompt, profileId, modelId };
    this._send(envelope(MSG.ENHANCE_PROMPT, payload));
  }

  /**
   * Send the operator's own file selection as this conversation's upload
   * grants. `paths` are absolute paths picked in the native file dialog
   * (never anything the model wrote); `op` is "grant" or "revoke". The reply
   * (also type upload_grant, correlated by requestId) surfaces through
   * onEnvelope() like every other request/reply pair here.
   */
  uploadGrant({ requestId, conversationId, op, paths }) {
    this._send(envelope(MSG.UPLOAD_GRANT, { requestId, conversationId, op, paths }));
  }
}

function defaultCreateTransport() {
  return chrome.runtime.connect({ name: "ocic-agent" });
}

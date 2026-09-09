// Wires protocol-client.js (wire I/O) to one-or-more conversation-model.js
// instances (per-conversation state), history-store.js (local index +
// prompt echo cache) and profile-cache.js (send-gating). Deliberately
// DOM-free — sidepanel.js is the only file that touches `document` — so
// this class is the thing tests drive directly (including against a real
// host/agent/companion.js CompanionCore, per this task's "fake companion
// harness" requirement).
//
// Envelope routing contract (host/agent/protocol.js / companion.js):
//   SNAPSHOT            -> full rebuild of the named conversation (see
//                          conversation-model.js's applySnapshot design note)
//   STREAM_EVENT         -> one event, applied live; runId comes from the
//                          envelope (the inner event object does not carry
//                          one for live traffic — see companion.js's
//                          runAsForkedChild)
//   TOKEN_BATCH          -> same as STREAM_EVENT, once per batched event
//   START (reply)        -> binds the just-sent local user message to its
//                          real runId and persists it to HistoryStore
//   STOP (reply)         -> no-op beyond logging; run_stopped (a
//                          STREAM_EVENT) is what actually updates state
//   ERROR (conversation-scoped, i.e. carries conversationId)
//                        -> surfaced on that conversation as a connection
//                          error banner
//   RECORDING_COMPLETE   -> informational; conversation-model.js already
//                          renders the underlying recording_complete
//                          STREAM_EVENT when it lands in that conversation

import { ConversationModel } from "./conversation-model.js";
import { DocumentsClient } from "./documents-client.js";
import { RUN_PHASE } from "./run-states.js";
import { buildContextMetadata } from "./context-binding.js";
import { isProfileComplete, deriveReadinessState, READINESS } from "./profile-cache.js";

export { READINESS };

export class PanelController {
  /**
   * @param {object} deps
   * @param {import("./protocol-client.js").ProtocolClient} deps.protocolClient
   * @param {import("./history-store.js").HistoryStore} deps.historyStore
   * @param {import("./profile-cache.js").ProfileCache} deps.profileCache
   * @param {() => Promise<{installationId:string, connectionId:string}>} [deps.identity]
   */
  constructor({ protocolClient, historyStore, profileCache, identity }) {
    this.protocol = protocolClient;
    this.historyStore = historyStore;
    this.profileCache = profileCache;
    this._identity = identity || (async () => ({ installationId: null, connectionId: null }));
    this.models = new Map(); // conversationId -> ConversationModel
    this.currentConversationId = null;
    // Set while a NEW request is outstanding, so the snapshot that answers it
    // is adopted as the active conversation even though one is already open.
    // The wire envelope carries no request id (see protocol-client.js's
    // `envelope()`: v/type/payload/ts and nothing else), so the intent has to
    // be remembered here rather than correlated on the reply.
    this._awaitingNewConversation = false;
    this.profile = null;
    // The user's explicit model choice for the NEXT send, from the
    // composer's model menu (sidepanel.js). null means "use the profile's
    // defaultModelId" (design.md decision 4: model changes apply only to a
    // new conversation/run, never retroactively).
    this._selectedModelId = null;
    this._updateHandlers = new Set();
    // Document byte fetches (agent-created document cards). Owns its own
    // request correlation and chunk reassembly; this controller only routes
    // envelopes into it and exposes fetchDocument() to the view.
    this.documents = new DocumentsClient({
      send: ({ conversationId, documentId, requestId }) =>
        this.protocol.documentRequest({ conversationId, documentId, requestId })
    });

    this.protocol.onEnvelope((env) => this._onEnvelope(env));
    this.protocol.onHandshakeChange(() => this._notify());
    this.protocol.onDisconnect(() => this._notify());
  }

  onUpdate(fn) {
    this._updateHandlers.add(fn);
    return () => this._updateHandlers.delete(fn);
  }

  _notify() {
    for (const fn of this._updateHandlers) fn();
  }

  async init() {
    this.profile = await this.profileCache.read();
    this.profileCache.onChange((p) => {
      this.profile = p;
      this._notify();
    });
    this.protocol.connect();
    // In production the panel connects to extension/background.js's
    // "ocic-agent" relay, which ALREADY performs its own hello on every
    // native-host connect (background.js's sendAgentHello(), using the
    // persisted per-profile installationId this module has no access to)
    // and immediately replays the current handshake state to a
    // late-connecting port (see background.js's onConnect listener) — so
    // sending a second hello with no real identity here would not just be
    // redundant, it could overwrite the already-correct browser identity
    // companion.js's _handleHello sets unconditionally from whatever hello
    // it last saw. Only send our own hello when `identity` resolves to a
    // REAL installationId — which happens in the test harness that talks
    // directly to a CompanionCore with no background.js in between (there
    // is no other hello source there, so this panel must be the one to
    // send it).
    const identity = await this._identity();
    if (identity && identity.installationId) {
      this.protocol.sendHello(identity);
    }
  }

  hasCompleteProfile() {
    return isProfileComplete(this.profile);
  }

  /**
   * The full not-ready-reason breakdown profile-cache.js's
   * `deriveReadinessState()` computes — never collapse this to
   * `hasCompleteProfile()`'s single boolean when the UI needs to say WHY.
   * @returns {{ state: string, missing?: string, reason?: string, capabilities?: object, errors?: object }}
   */
  readinessState() {
    return deriveReadinessState(this.profile);
  }

  currentModel() {
    if (!this.currentConversationId) return null;
    return this.models.get(this.currentConversationId) || null;
  }

  currentPhase() {
    const model = this.currentModel();
    const connectionStatus = this.protocol.handshakeState() === "ok" ? "ok" : this.protocol.handshakeState();
    // Mirror ConversationModel.derivePhase()'s own connection rule rather than
    // collapsing every non-ok state to CONNECTING. Without this, the one case
    // that matters most — a fresh machine with no companion installed, which
    // by definition has no conversation open — reported "connecting" forever
    // while the real answer (a setup step is missing) was already known here.
    if (!model) {
      if (connectionStatus === "version_mismatch" || connectionStatus === "error") return RUN_PHASE.ERROR;
      return connectionStatus === "ok" ? RUN_PHASE.EMPTY : RUN_PHASE.CONNECTING;
    }
    return model.derivePhase({ connectionStatus, hasProfile: this.hasCompleteProfile() });
  }

  _getOrCreateModel(conversationId) {
    let model = this.models.get(conversationId);
    if (!model) {
      model = new ConversationModel(conversationId);
      this.models.set(conversationId, model);
    }
    return model;
  }

  async startNewConversation(meta = {}) {
    // Claim the next snapshot BEFORE the request goes out. Without this the
    // reply was silently discarded whenever a conversation was already open —
    // which is every press of the panel's own "+" except the first — so the
    // host created the conversation and the panel went on showing the old one.
    this._awaitingNewConversation = true;
    try {
      this.protocol.newConversation(meta);
    } catch (err) {
      // The request never left (ProtocolClient throws when its port is gone).
      // Clearing the claim matters: a stale one would hijack the next
      // unrelated snapshot — a resume, or a reconnect's own reply — and switch
      // the panel to a conversation the user never asked for.
      this._awaitingNewConversation = false;
      throw err;
    }
  }

  async reopenConversation(conversationId) {
    const model = this._getOrCreateModel(conversationId);
    const prompts = await this.historyStore.promptsFor(conversationId);
    model.seedLocalPrompts(prompts);
    this.currentConversationId = conversationId;
    this.protocol.resumeConversation(conversationId, 0);
  }

  /**
   * @param {string} text - the user's own literal composer text; this is
   *   what the transcript displays and what history-store echoes back —
   *   never the composed wire prompt below.
   * @param {object} [opts]
   * @param {Array<number>|'any'} [opts.tabScope]
   * @param {object|null} [opts.pageContext] - a PageContextTracker snapshot
   *   already validated atomically by the caller (see page-context.js's
   *   captureForSend()) — bound to this exact message/run, never re-resolved
   *   later. Design.md 5b: "Each submitted message SHALL retain its exact
   *   page-context identity."
   * @param {"low"|"medium"|"high"|"xhigh"|"max"|null} [opts.effort] - reasoning
 *   effort for this turn, as chosen in the composer. Null (the default) sends
 *   nothing, leaving the model's own default in force. Additive optional
 *   field: old peers ignore it.
 * @param {Array<{id?:string, mimeType:string, fileName?:string}>} [opts.attachments]
   *   - snapshot of the composer attachment refs at Send time (exact-message
   *   binding, mirror of pageContext). Additive optional field: old peers
   *   ignore it.
   */
  async sendMessage(text, { tabScope = "any", profileId, modelId, pageContext = null, attachments = null, effort = null } = {}) {
    const model = this.currentModel();
    if (!model) throw new Error("PanelController.sendMessage: no active conversation");
    model.addLocalUserMessage(text, { attachments: attachments || [] });
    this._notify();
    this._pendingSend = { conversationId: this.currentConversationId, text };
    // `prompt` is the user's own literal text, UNCHANGED (design.md section
    // 5: "User messages and page/tool content remain distinctly typed").
    // The bound page context, when present, travels as a SEPARATE `context`
    // field — structured trusted metadata, never merged into the user's
    // turn — which host/agent/companion.js forwards into
    // host/agent/tools/query-options.js's constructed `query()` options as
    // the SDK's own `systemPrompt` (see that file for the sdk.d.ts citation).
    this.protocol.start({
      conversationId: this.currentConversationId,
      profileId: profileId ?? (this.profile && this.profile.profileId),
      modelId: modelId ?? (this.profile && this.profile.defaultModelId),
      tabScope,
      prompt: text,
      context: buildContextMetadata({ text, context: pageContext }),
      ...(attachments && attachments.length ? { attachments } : {}),
      // Only sent when the composer actually chose a level. Omitted means the
      // run sends no effort parameter and the model's own default applies —
      // deliberately not the same as pinning it to today's default.
      ...(effort ? { effort } : {})
    });
  }

  stop(reason = "user_stop") {
    const model = this.currentModel();
    if (!model || !this.currentConversationId) return;
    model.markStopRequested();
    this._notify();
    this.protocol.stop({ conversationId: this.currentConversationId, reason });
  }

  respondApproval(decision) {
    const model = this.currentModel();
    if (!model || !model.pendingApproval) return;
    const { action, target, requestId } = model.pendingApproval;
    // Task 9.6: include the requestId so the companion's _handleApprovalDecision
    // can correlate the panel's reply with the original approval_request. An
    // unknown/mismatched requestId is rejected by the companion, not silently
    // applied to a different pending decision.
    this.protocol.approvalDecision({
      conversationId: this.currentConversationId,
      decision,
      action,
      target,
      requestId
    });
    model.clearPendingApproval();
    this._notify();
  }

  // Task 9.7: respond to a pending question with the chosen option(s).
  // Mirror-image of respondApproval — the requestId correlates the
  // question_request and the panel's answer so the companion's
  // _handleQuestionAnswer resolves the right Promise.
  respondQuestion(answer) {
    const model = this.currentModel();
    if (!model || !model.pendingQuestion) return;
    const { requestId } = model.pendingQuestion;
    this.protocol.questionAnswer({
      conversationId: this.currentConversationId,
      requestId,
      answer
    });
    // Record the chosen option in the transcript immediately, then clear
    // the pending question so the card disappears.
    model.recordQuestionAnswer(answer);
    model.clearPendingQuestion();
    this._notify();
  }

  async deleteConversationLocally(conversationId) {
    await this.historyStore.removeLocal(conversationId);
    this.models.delete(conversationId);
    if (this.currentConversationId === conversationId) this.currentConversationId = null;
    this._notify();
  }

  /**
   * Fetch one agent-created document's bytes for the card the operator just
   * opened or downloaded.
   *
   * @returns {Promise<{found: true, bytes: Uint8Array, meta: object} | {found: false, reason: string}>}
   */
  fetchDocument(documentId, conversationId = this.currentConversationId) {
    return this.documents.fetch({ conversationId, documentId });
  }

  _onEnvelope(env) {
    // Document transfers are consumed before the switch below: their reply is
    // a chunk_begin/chunk_part*/chunk_end sequence plus an occasional
    // `document` not-found envelope, none of which any conversation model has
    // an opinion about. handleEnvelope() returns true only for envelopes that
    // belong to a fetch this panel actually asked for, so an unrelated chunk
    // sequence (a screenshot artifact reply) still falls through untouched.
    if (this.documents.handleEnvelope(env)) return;

    switch (env.type) {
      case "snapshot": {
        const model = this._getOrCreateModel(env.conversationId);
        model.applySnapshot(env);
        // A NEW/RESUME/SNAPSHOT_REQUEST reply all share this shape. Adopt it
        // when nothing is open yet (the very first NEW call on panel startup),
        // and whenever a NEW request of our own is outstanding — that second
        // case is what makes the "+" button switch to the conversation the
        // host just created. RESUME is unaffected: reopenConversation() sets
        // currentConversationId itself before asking, and never sets the flag.
        if (this._awaitingNewConversation) {
          this._awaitingNewConversation = false;
          this.currentConversationId = env.conversationId;
        } else if (this.currentConversationId == null) {
          this.currentConversationId = env.conversationId;
        }
        this._persistHistoryEntry(model);
        this._notify();
        break;
      }
      case "start": {
        if (env.runId) {
          const model = this.models.get(env.conversationId);
          if (model) {
            model.bindRunToLastUserMessage(env.runId);
            if (this._pendingSend) {
              this.historyStore.recordPrompt(env.conversationId, env.runId, this._pendingSend.text).catch(() => {});
              this._pendingSend = null;
            }
          }
        }
        this._notify();
        break;
      }
      case "stream_event": {
        const model = this.models.get(env.conversationId);
        if (model) {
          model.applyEvent(normalizeEvent(env.event, env.runId));
          this._persistHistoryEntry(model);
        }
        this._notify();
        break;
      }
      case "token_batch": {
        const model = this.models.get(env.conversationId);
        if (model && Array.isArray(env.events)) {
          for (const e of env.events) model.applyEvent(normalizeEvent(e, env.runId));
          this._persistHistoryEntry(model);
        }
        this._notify();
        break;
      }
      case "error": {
        if (env.conversationId) {
          const model = this.models.get(env.conversationId);
          if (model) model.connectionError = { reason: env.reason, detail: env.detail };
        }
        this._notify();
        break;
      }
      case "recording_complete":
      case "stop":
      case "approval_decision":
      case "hello_ack":
      case "version_mismatch":
      default:
        this._notify();
        break;
    }
  }

  _persistHistoryEntry(model) {
    const firstUser = model.items.find((i) => i.kind === "user");
    this.historyStore
      .upsert({
        conversationId: model.conversationId,
        title: firstUser ? firstUser.text.slice(0, 60) : undefined,
        hostname: undefined,
        interrupted: model.meta ? !!model.meta.interrupted : model.hasActiveRun() ? false : undefined
      })
      .catch(() => {});
  }
}

function normalizeEvent(event, envelopeRunId) {
  if (!event) return event;
  return event.runId ? event : { ...event, runId: envelopeRunId };
}

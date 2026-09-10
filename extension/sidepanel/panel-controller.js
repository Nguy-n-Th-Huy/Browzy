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
//   ERROR "unknown_conversation" (carries NO conversationId — see
//                          companion.js's _handleResume) -> attributed to
//                          the oldest outstanding RESUME via
//                          `_pendingResumes` and surfaced the same way, on
//                          THAT conversation's model; a startup restore
//                          additionally falls back to a fresh conversation,
//                          but only when it is still the one showing (see
//                          `_handleUnknownConversationError()`)
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
    // Every RESUME this controller currently has outstanding, oldest first:
    // `{ conversationId, isBootRestore }`. Pushed immediately before the
    // matching `protocol.resumeConversation()` call (see `reopenConversation()`)
    // and removed either when that conversation's own snapshot arrives (see
    // `_resolvePendingResume()`) or when an `unknown_conversation` error is
    // attributed to it (see `_handleUnknownConversationError()`).
    //
    // This replaces a single `_restoringConversationId` flag (design.md's
    // superseded "Correlate the unknown-conversation fallback with an
    // explicit restoring flag" decision), which only ever tracked ONE
    // outstanding startup restore and had no way to represent a concurrent
    // explicit reopen. `sidepanel.js`'s history "open" handler calls
    // `reopenConversation()` directly and is wired independently of
    // `bootPromise`, so a user reopen concurrent with an outstanding boot
    // restore is reachable, not hypothetical — both are RESUMEs, and both
    // can independently fail with the SAME conversationId-less
    // `unknown_conversation` envelope.
    //
    // ORDERING ASSUMPTION (this is the one thing the wire genuinely cannot
    // prove, so it is written down rather than implied): an
    // `unknown_conversation` error carries no conversationId — see
    // host/agent/companion.js's `_handleResume()`, which catches
    // `SessionManager#resumeConversation()`'s throw and emits
    // `{ reason: "unknown_conversation", detail }` with nothing else — so an
    // incoming error of that shape cannot be looked up by id; it can only be
    // matched against whichever RESUME is oldest and still unresolved.
    // `_handleResume()` does no `await` of its own before building that
    // reply, and the transport carrying envelopes between panel and
    // companion (a `chrome.runtime.Port` in production, an in-memory queue
    // in tests) is itself a single ordered channel — so two RESUME sends
    // provably produce their (non-snapshot) replies in the SAME order the
    // requests were sent. Treating `_pendingResumes[0]` as "the request this
    // reply answers" is therefore correct, PROVIDED every push happens
    // immediately adjacent to its matching send (no `await` between them —
    // see `reopenConversation()`), so queue order can never drift from wire
    // send order even when two `reopenConversation()` calls race each other.
    // A successful RESUME (a `snapshot` reply, which DOES carry the
    // conversationId) does not need this ordering assumption at all —
    // `_resolvePendingResume()` removes it by id directly, wherever in the
    // queue it sits.
    this._pendingResumes = [];
    // Flips to true the instant ANY explicit (non-boot) reopenConversation()
    // call is MADE (set synchronously at the top of that call, before any
    // `await` — see reopenConversation()), and never resets. Consumed only
    // by `_handleUnknownConversationError()`'s startup-restore fallback
    // decision.
    //
    // This exists because `currentConversationId` alone is not a reliable
    // enough signal for "has the operator since navigated away from the
    // startup restore": `restoreOrStartConversation()` needs THREE awaited
    // steps before it ever reaches its own `reopenConversation()` call
    // (`getLastActive()`, `list()`, then `reopenConversation()`'s own
    // `promptsFor()`), while an explicit reopen needs only ONE
    // (`promptsFor()`). A boot restore racing a near-simultaneous explicit
    // reopen therefore systematically tends to reach its send LAST — and,
    // because `_setCurrentConversationId()` runs immediately before that
    // send, would then "win" `currentConversationId` back from the
    // operator's own explicit click even though that click came first in
    // real operator intent. Comparing `currentConversationId` at
    // error-arrival time alone would let the automatic startup fallback
    // fire in exactly that case, overriding an explicit action the operator
    // already took — which is the "restore attempt the user has since
    // navigated away from acts on stale state" failure mode this field
    // closes. `_handleUnknownConversationError()` treats either this flag
    // OR a `currentConversationId` mismatch as reason enough to skip the
    // fallback; the flag is the primary guard, `currentConversationId` a
    // secondary one for any transition this flag does not cover.
    this._explicitReopenSinceBoot = false;
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

  /**
   * The ONLY place `currentConversationId` is assigned (design.md "Funnel all
   * active-conversation assignment through one setter"). Every one of the
   * four spots that used to write the field directly — both adopt branches in
   * `_onEnvelope`'s `snapshot` case, `reopenConversation()`, and the clear in
   * `deleteConversationLocally()` — now calls this instead, so the persisted
   * "last active" identity can never drift from the in-memory one: whichever
   * of the four transitions actually happens, this setter sees it.
   *
   * Persistence is fire-and-forget with the rejection swallowed, the same
   * treatment `_persistHistoryEntry()` already gives history writes —
   * `chrome.storage.local` being unavailable must never block using the
   * panel, and this setter runs synchronously so callers can keep treating
   * the assignment itself as instant.
   */
  _setCurrentConversationId(conversationId) {
    this.currentConversationId = conversationId;
    this.historyStore.setLastActive(conversationId).catch(() => {});
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

  /**
   * @param {string} conversationId
   * @param {object} [opts]
   * @param {boolean} [opts.isBootRestore] - true only when called from
   *   `restoreOrStartConversation()`'s own startup resume. Never set by a
   *   caller acting on the operator's explicit request (the history list's
   *   "open" button) — that distinction is what lets
   *   `_handleUnknownConversationError()` apply the "forget and start a
   *   usable new conversation" fallback ONLY to a startup restore, never to
   *   an explicit reopen (spec "Explicit reopen of an unknown conversation is
   *   not swapped").
   */
  async reopenConversation(conversationId, { isBootRestore = false } = {}) {
    // Set synchronously, before any `await` in this method — see the
    // `_explicitReopenSinceBoot` field comment for why timing this to the
    // CALL, not the eventual send, is what makes it a reliable signal.
    if (!isBootRestore) this._explicitReopenSinceBoot = true;
    const model = this._getOrCreateModel(conversationId);
    const prompts = await this.historyStore.promptsFor(conversationId);
    model.seedLocalPrompts(prompts);
    // A startup restore must never steal the DISPLAY away from an operator's
    // own explicit reopen — including one that only started, not
    // necessarily finished, before this line runs (`_explicitReopenSinceBoot`
    // is set at the top of an explicit call, before its own `await`, for
    // exactly this reason). Without this check, `restoreOrStartConversation()`
    // needing three awaits before it ever reaches this method (vs an explicit
    // reopen's one) means the boot restore systematically tends to reach
    // THIS line last and would otherwise optimistically overwrite
    // `currentConversationId` back onto itself, away from whatever the
    // operator already explicitly opened — even when that explicit reopen
    // goes on to succeed. The RESUME below still goes out regardless, so the
    // restored conversation's own model and history stay in sync and its
    // eventual reply is still correctly attributed via `_pendingResumes` —
    // only the "make this the displayed conversation" side effect is
    // skipped for a superseded startup restore.
    if (!(isBootRestore && this._explicitReopenSinceBoot)) {
      this._setCurrentConversationId(conversationId);
    }
    // Push the pending-resume entry IMMEDIATELY before the send, with no
    // `await` in between (see the `_pendingResumes` field comment): that is
    // what keeps queue order identical to wire send order even when two
    // `reopenConversation()` calls are racing each other, since each call's
    // own `await historyStore.promptsFor()` above can resolve in either
    // order relative to the other's.
    const pending = { conversationId, isBootRestore };
    this._pendingResumes.push(pending);
    try {
      this.protocol.resumeConversation(conversationId, 0);
    } catch (err) {
      // The request never left (port gone) — remove the entry so a later
      // unrelated error can never be mistaken for this resume having failed,
      // the same reason startNewConversation() clears `_awaitingNewConversation`
      // on its own failed send.
      this._removePendingResume(pending);
      throw err;
    }
  }

  _removePendingResume(entry) {
    const idx = this._pendingResumes.indexOf(entry);
    if (idx !== -1) this._pendingResumes.splice(idx, 1);
  }

  /** Removes (by conversationId, not queue position) the pending resume a
   * successful `snapshot` reply answers. Unlike the `unknown_conversation`
   * error path, a snapshot always carries its conversationId, so it never
   * needs the FIFO ordering assumption — it can be found directly wherever
   * in the queue it sits. */
  _resolvePendingResume(conversationId) {
    const idx = this._pendingResumes.findIndex((p) => p.conversationId === conversationId);
    if (idx !== -1) this._pendingResumes.splice(idx, 1);
  }

  /**
   * startNewConversation() wrapped so it can never reject.
   * `restoreOrStartConversation()`'s contract is that `boot()` can `await`
   * it with no catch — `bootPromise` itself has no `.catch()` either, so a
   * rejection anywhere inside it would abort the rest of startup, including
   * the very first `render()`, and leave the panel permanently blank. A
   * `ProtocolClient` throw ("not connected", the port already gone before
   * the panel finished booting) is a real, reachable failure here, not a
   * hypothetical one. Swallowing it is safe on both paths that can reach
   * this method, though not for the same reason: on the `!restorable` path
   * `currentConversationId` is still null, so `currentPhase()` falls into
   * its own "no model" branch and renders CONNECTING/ERROR purely from
   * handshake state (see that method's own header comment); on the
   * resume-then-fallback-failure path `reopenConversation()` has already
   * optimistically set `currentConversationId` to the (unconfirmed) id it
   * tried to resume, so a model exists and `currentPhase()` instead
   * resolves through `ConversationModel.derivePhase()` — typically EMPTY,
   * since that model has no turns and no items yet. Either way the panel
   * renders a real, non-throwing phase, and the next user action — pressing
   * "+", or reopening from history — retries through its own already-guarded
   * path.
   */
  async _startNewConversationSafely() {
    try {
      await this.startNewConversation();
    } catch {
      // Swallowed deliberately — see this method's header comment.
    }
  }

  /**
   * Startup entry point (design.md "Restore is a controller method, not
   * logic in boot()"): resume the conversation the operator was last looking
   * at, or start a fresh one when there is nothing usable to resume. Kept
   * DOM-free like every other method here so a test can call it directly —
   * `sidepanel.js`'s `boot()` only awaits it in place of the old
   * `if (!panel.currentConversationId) startNewConversation()` block.
   *
   * The remembered id is treated as restorable only when it is present in
   * this panel's own local index (`historyStore.list()`) and not flagged
   * `deletedLocally` — an id that fails either check is "nothing to restore"
   * exactly like the spec's "First ever open" scenario, and is never sent to
   * the companion at all (spec "Remembered conversation was deleted
   * locally": a locally-deleted conversation is never resurrected by a round
   * trip). `list()`'s own storage-failure fallback (an empty array) already
   * makes an unreadable index resolve here to "nothing restorable", which is
   * exactly the fallback this method wants.
   *
   * The actual resume reuses `reopenConversation()` rather than duplicating
   * its model-creation, local-prompt-seeding and RESUME-sending logic,
   * passing `{ isBootRestore: true }` so the pending-resume entry it pushes
   * is distinguishable from an explicit reopen's (see the `_pendingResumes`
   * field comment and `_handleUnknownConversationError()`).
   *
   * Guarded at the top by `if (this.currentConversationId) return;`,
   * restoring protection the pre-change `boot()` had via
   * `if (!panel.currentConversationId) startNewConversation()`: `boot()`
   * awaits `pageContext.start()` and `panel.init()` before calling this
   * method, and `sidepanel.js`'s history "open" handler is wired
   * independently of `bootPromise` — so an operator who reopens a
   * conversation from the history list during either of those earlier awaits
   * already has a real, deliberately chosen conversation active by the time
   * this method runs. Restoring or starting a new one here would silently
   * overwrite that choice with the merely-remembered one, which is exactly
   * backwards.
   *
   * `reopenConversation()` sends the RESUME synchronously inside its own
   * async body, so a `ProtocolClient` throw (port already gone) surfaces here
   * as a rejected promise, not a synchronous throw — caught below and
   * translated into starting a new conversation instead (design.md "Send
   * failure falls back through the same path"). Both the `!restorable`
   * branch and this catch branch route through `_startNewConversationSafely()`
   * rather than `startNewConversation()` directly: `boot()`
   * awaits this method with no catch, and `bootPromise` has no `.catch()`
   * either, so a rejection anywhere in here would abort the rest of startup,
   * including the first `render()`, and leave the panel permanently blank —
   * a strictly worse outcome than the restore failing.
   */
  async restoreOrStartConversation() {
    if (this.currentConversationId) return;

    const lastActiveId = await this.historyStore.getLastActive();
    let restorable = false;
    if (lastActiveId) {
      const list = await this.historyStore.list();
      const entry = list.find((c) => c.conversationId === lastActiveId);
      restorable = !!entry && !entry.deletedLocally;
    }
    if (!restorable) {
      await this._startNewConversationSafely();
      return;
    }
    try {
      await this.reopenConversation(lastActiveId, { isBootRestore: true });
    } catch {
      // The RESUME never left (port gone) or reopenConversation() otherwise
      // rejected before a reply could ever correlate against the pending
      // entry it pushed — reopenConversation() already removed that entry
      // itself on the same throw (see its own catch), so there is nothing
      // left to clean up here beyond falling back.
      await this._startNewConversationSafely();
    }
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
    if (this.currentConversationId === conversationId) this._setCurrentConversationId(null);
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

  /**
   * Handles an `error` envelope with `reason: "unknown_conversation"` and no
   * conversationId (host/agent/companion.js's `_handleResume()` — see the
   * `_pendingResumes` field comment for the full envelope-shape and
   * correlation reasoning). Called from `_onEnvelope`'s `error` case.
   */
  _handleUnknownConversationError(env) {
    // FIFO shift: the oldest still-outstanding RESUME is provably the one
    // this reply answers (see the `_pendingResumes` field comment for why).
    const pending = this._pendingResumes.shift();
    if (!pending) return; // No RESUME of ours is outstanding — nothing to attribute this to.

    // Surface the failure on the conversation the operator actually asked
    // about — startup restore or explicit reopen alike —
    // reusing the SAME `model.connectionError` mechanism a conversation-
    // scoped error already uses above, rather than inventing a second error
    // channel the render layer would also have to learn (spec "the panel
    // surfaces the failure against the conversation the operator asked
    // for"). `_getOrCreateModel` rather than `models.get`: reopenConversation()
    // already created this model before sending, but building defensively
    // here costs nothing and means this method has no hidden dependency on
    // that ordering.
    const model = this._getOrCreateModel(pending.conversationId);
    model.connectionError = { reason: env.reason, detail: env.detail };

    if (!pending.isBootRestore) {
      // Explicit reopen: the assignment above already satisfies the spec.
      // Never fall back to starting a new conversation here — that is
      // exactly the hijack the spec forbids (spec "Explicit reopen of an
      // unknown conversation is not swapped"): the panel is left exactly on
      // the conversation the operator asked for, `currentConversationId`
      // untouched, and no `new` goes on the wire.
      return;
    }

    // Startup restore. Only run the "forget the remembered id and start a
    // usable new conversation" fallback when NEITHER of the following is
    // true — otherwise the operator has already, one way or another, moved
    // on from this restore and firing the fallback would silently swap them
    // onto a THIRD conversation they never asked for (the exact hijack a
    // concurrent boot-restore-plus-reopen race can otherwise produce: two
    // conversationId-less unknown_conversation errors are structurally
    // identical, and the fallback used to fire unconditionally regardless of
    // what the operator had since done):
    //
    //  1. `_explicitReopenSinceBoot` — the operator has made an explicit
    //     reopen call at ANY point (see that field's comment for why this,
    //     not `currentConversationId`, is the primary signal: the boot
    //     restore's own send is structurally slower to fire than an
    //     explicit reopen's, so comparing only `currentConversationId` at
    //     this moment can be wrong about which one the operator actually
    //     asked for last).
    //  2. `currentConversationId !== pending.conversationId` — a secondary,
    //     belt-and-suspenders check for any other transition that moved the
    //     active conversation away from this restore's target without going
    //     through an explicit reopen (e.g. `deleteConversationLocally()`).
    //
    // Leaving the error on `pending.conversationId`'s own model above is
    // enough even when this guard skips the fallback: nobody may be looking
    // at it right now, but it is there if the operator navigates back.
    if (this._explicitReopenSinceBoot || this.currentConversationId !== pending.conversationId) return;

    this.historyStore.setLastActive(null).catch(() => {});
    // Fire-and-forget like the rest of this method's error-path writes:
    // `_startNewConversationSafely()` already swallows its own rejection.
    this._startNewConversationSafely();
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
          this._setCurrentConversationId(env.conversationId);
        } else if (this.currentConversationId == null) {
          this._setCurrentConversationId(env.conversationId);
        }
        // Any RESUME reply (a startup restore's or an explicit reopen's)
        // lands here too — SNAPSHOT is the shared reply shape for
        // NEW/RESUME/SNAPSHOT_REQUEST. Resolve its pending-resume entry the
        // instant the conversation it was waiting on actually arrives, so a
        // later unrelated `unknown_conversation` error can never be
        // attributed to it (see the "error" case below and the
        // `_pendingResumes` field comment).
        this._resolvePendingResume(env.conversationId);
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
        } else if (env.reason === "unknown_conversation") {
          this._handleUnknownConversationError(env);
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

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
//                          runAsForkedChild). A transient live fragment is
//                          applied to the model but skipped by the history
//                          gate below.
//   TOKEN_BATCH          -> same as STREAM_EVENT, once per batched event; a
//                          batch containing only transient fragments is
//                          display-only traffic and writes no history.
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

import { ConversationModel, STREAM_PARTIAL_EVENT_TYPE } from "./conversation-model.js";
import { DocumentsClient } from "./documents-client.js";
import { buildConversationArtifact, normalizeExportFormat } from "./history-export.js";
import { RUN_PHASE } from "./run-states.js";
import { buildContextMetadata } from "./context-binding.js";
import { isProfileComplete, deriveReadinessState, READINESS } from "./profile-cache.js";

export { READINESS };

// Run-terminal events, the points design.md decision 2 requires a final
// synchronous best-effort flush at: nothing the run produced may still be
// sitting in the debounce window when the run is over.
const RUN_TERMINAL_EVENT_TYPES = new Set(["run_done", "run_stopped", "run_error", "run_interrupted_by_restart"]);

function isRunTerminalEvent(event) {
  return !!event && RUN_TERMINAL_EVENT_TYPES.has(event.type);
}

// A live fragment (conversation-model.js's STREAM_PARTIAL_EVENT_TYPE, itself
// hand-synced with host/agent/protocol.js). Fragments are display-only
// traffic: a `stream_event`/`token_batch` carrying nothing else must not
// write history metadata, derive a title, or push a presentation update —
// only the durable events that share the envelope (a complete message, a
// lifecycle event) may (tasks.md 2.7).
function isTransientFragmentEvent(event) {
  return !!event && event.type === STREAM_PARTIAL_EVENT_TYPE;
}

// Coalescing window for presentation-metadata pushes and the local cache
// (tasks.md 2.1: 500–1000ms).
const HISTORY_FLUSH_DELAY_MS = 700;

// Hard ceiling on the pages one export will pull (the host pages 500 events
// at a time): 200 pages = 100k events, far beyond any real conversation, and
// the loop stops on its own long before this for anything that is one. It
// exists so a host that keeps claiming "more below" cannot pin the panel in a
// loop forever — the export fails and says so.
const MAX_EXPORT_PAGES = 200;

export class PanelController {
  /**
   * @param {object} deps
   * @param {import("./protocol-client.js").ProtocolClient} deps.protocolClient
   * @param {import("./history-store.js").HistoryStore} deps.historyStore
   * @param {import("./profile-cache.js").ProfileCache} deps.profileCache
   * @param {() => Promise<{installationId:string, connectionId:string}>} [deps.identity]
   * @param {() => (string|number|null)} [deps.scope] - scope-conversation-restore-per-tab
   *   (design.md "Keep one setter, give it the scope"): a RESOLVER for this
   *   panel's own scope — the tab id the panel booted on — supplied ONCE at
   *   construction rather than threaded through every `getLastActive()`/
   *   `setLastActive()` call site. Called fresh every time this controller
   *   needs the scope (`_setCurrentConversationId()`,
   *   `restoreOrStartConversation()`, `_handleUnknownConversationError()`),
   *   never cached here — `sidepanel.js`'s `boot()` is what actually freezes
   *   the value the resolver reads (see that function's own comment for why
   *   the freeze has to live there: the scope is not known yet at the moment
   *   this controller is constructed, only after `pageContext.start()`
   *   resolves). A missing/falsy result is "no identifiable scope" — every
   *   `historyStore` call below already degrades that to a no-op read/write
   *   (see history-store.js's `getLastActive`/`setLastActive`), so this
   *   defaulting to a resolver that always returns `null` is what makes an
   *   unscoped panel behave exactly like the spec's "No identifiable scope"
   *   fallback: it starts a new conversation and never touches another
   *   scope's remembered id. Accepting a plain value here too (not only a
   *   function) is a convenience for callers — mainly tests — that already
   *   know their fixed scope at construction time; it is wrapped in a
   *   trivial resolver so every internal call site can treat `this._scope`
   *   uniformly as "call it".
   */
  constructor({ protocolClient, historyStore, profileCache, identity, scope, requestTimeoutMs = 15000 }) {
    this.protocol = protocolClient;
    this.historyStore = historyStore;
    this.profileCache = profileCache;
    this._identity = identity || (async () => ({ installationId: null, connectionId: null }));
    this._scope = typeof scope === "function" ? scope : () => scope ?? null;
    this.models = new Map(); // conversationId -> ConversationModel
    this.currentConversationId = null;
    this._requestTimeoutMs = requestTimeoutMs;
    // Reply correlation for the request/reply history operations (LIST /
    // DELETE / DELETE_ALL / UPDATE / TRANSCRIPT_WINDOW). Each entry is
    // `{ resolve, timer }`; a reply carrying the matching `requestId` settles
    // it, and a timeout settles it with `null` so a dead port can never leave
    // a delete hanging and, more importantly, can never let the panel claim a
    // success the host never acknowledged (tasks.md 1.3).
    this._pendingRequests = new Map();
    this._requestSeq = 0;
    // Per-conversation presentation metadata this panel last PUSHED to the
    // host, so the (streaming) history persist path does not re-send an
    // unchanged title/hostname on every token batch.
    this._hostMetadataSent = new Map();
    this._hostMetadataTimer = null;
    // The HOST's own title per conversation, as last confirmed by a
    // `list_conversations` reply, an accepted `update_conversation`, or the
    // local cache row adopted when the panel resumes a conversation (see
    // `_adoptCachedHostTitle()`). A title is derived from the first user
    // message only while the host has none (see `_derivedTitleFor()`): the
    // operator can rename a conversation (tasks.md 4.3) and the next stream
    // tick must not overwrite that rename with the same derived default it
    // started from.
    this._hostTitles = new Map();
    // The FIRST question this panel knows for each conversation: the earliest
    // recorded prompt (the local prompt store records in run order) or the
    // prompt the panel is sending right now. Kept in memory because
    // `_derivedTitleFor()` runs synchronously inside the coalesced persist
    // path and must not await storage; `historyStore.promptsFor()` is the
    // durable source the map is hydrated from at resume time.
    this._firstPromptText = new Map();
    // Migration-plan rollout gate: null = not yet proven, true = the host
    // answered a history request, false = the host refused one with
    // `unknown_message_type`. See hostHistorySupport().
    this._hostHistorySupported = null;
    this._hostHistoryProbe = null;
    // Metadata the panel has derived but not yet pushed to the host, keyed by
    // conversation — the coalescing buffer behind _queueHostMetadata().
    this._pendingHostMetadata = new Map();
    // Hostname of the page each conversation's runs were bound to (from the
    // Send-time page context), so the host summary can carry it (task 1.1)
    // without the panel having to re-resolve a page it no longer displays.
    this._pageHostnameByConversation = new Map();
    this._idempotencySeq = 0;
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

  // ---- host-authoritative history (tasks.md 1.1-1.3, 3.2) -----------------

  /**
   * Send one request/reply history operation and settle on the reply that
   * carries the matching `requestId`. Always resolves (never rejects): a dead
   * port, a timeout, or a companion that does not know the message type all
   * settle as `null`, which every caller below treats as "the host did not
   * confirm" — the state from which a panel must NOT claim success.
   */
  _sendRequest(method, payload) {
    const requestId = `req_${++this._requestSeq}`;
    return new Promise((resolve) => {
      // Deliberately NOT unref'd: a pending request's deadline is the only
      // thing standing between "the host never answered" and a promise that
      // never settles. It is cleared the moment the reply (or a refusal)
      // arrives, and it is short-lived either way.
      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        resolve(null);
      }, this._requestTimeoutMs);
      this._pendingRequests.set(requestId, { resolve, timer });
      try {
        this.protocol[method]({ ...payload, requestId });
      } catch {
        // The request never left (ProtocolClient throws when its port is
        // gone) — settle now instead of waiting out the timeout.
        clearTimeout(timer);
        this._pendingRequests.delete(requestId);
        resolve(null);
      }
    });
  }

  /** Settle the pending request this reply answers. Returns true when the
   * reply was consumed (i.e. it belonged to a request we sent). */
  _resolveRequest(env) {
    if (!env || typeof env.requestId !== "string") return false;
    const pending = this._pendingRequests.get(env.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pendingRequests.delete(env.requestId);
    pending.resolve(env);
    return true;
  }

  /** Settle every outstanding history request with "no answer" — used when
   * the host has proven it cannot answer any of them (see the
   * unknown_message_type branch in _onEnvelope). */
  _settleAllRequests() {
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this._pendingRequests.clear();
  }

  /**
   * Fetch the host's AUTHORITATIVE conversation list and reconcile the local
   * cache against it (tasks.md 1.2, spec chat-history-lifecycle
   * "Authoritative listing and reconciliation").
   *
   * @returns {Promise<{reconciled: number, orphans: string[], removed: string[]}|null>}
   *   `null` when the host did not answer — the caller keeps the cached list
   *   and shows an offline/stale state rather than inventing one.
   */
  async reconcileHistory({ limit } = {}) {
    if (this._hostHistorySupported === false) return null; // host cannot answer — keep the cache, show the offline state
    const reply = await this._sendRequest("listConversations", limit ? { limit } : {});
    if (!reply || !Array.isArray(reply.conversations)) return null;
    this._hostHistorySupported = true;
    for (const summary of reply.conversations) {
      if (!summary || typeof summary.conversationId !== "string") continue;
      this._hostTitles.set(summary.conversationId, summary.title ?? null);
    }
    return this.historyStore.reconcile(reply.conversations);
  }

  /**
   * Load one older transcript page into a conversation's model (tasks.md 3.2
   * / design.md decision 3 — "lazy older-event retrieval"). The model caps
   * how much of it can be retained; the reply's `limitReached` tells the
   * caller the memory budget is exhausted.
   */
  async loadOlderEvents(conversationId = this.currentConversationId, { limit } = {}) {
    const model = conversationId ? this.models.get(conversationId) : null;
    if (!model || this._hostHistorySupported === false) return null;
    const beforeSeq = model.oldestLoadedSeq();
    const reply = await this._sendRequest("requestTranscriptWindow", { conversationId, beforeSeq, limit });
    if (!reply || !Array.isArray(reply.events)) return null;
    const applied = model.applyOlderPage(reply);
    this._notify();
    return applied;
  }

  /**
   * Delete one conversation on the HOST, and only then drop it locally
   * (tasks.md 1.3 / design.md decision 5: "clear local cache only after
   * acknowledgement, then reconcile"). A failure or an unacknowledged
   * request leaves the local cache untouched and returns `ok:false` — the UI
   * must never present a local-only removal as a completed deletion (spec
   * chat-history-lifecycle "Complete deletion": "the UI never claims success
   * for a local-only removal").
   */
  async deleteConversation(conversationId, { idempotencyKey } = {}) {
    if (this._hostHistorySupported === false) {
      // This host answered `unknown_message_type` for our history protocol:
      // there is nothing to ask it, and a local-only removal is exactly what
      // the spec forbids. Fail explicitly instead.
      return { ok: false, reason: "host_protocol_unsupported" };
    }
    const key = idempotencyKey || this._newIdempotencyKey("del", conversationId);
    const reply = await this._sendRequest("deleteConversation", { conversationId, idempotencyKey: key });
    if (!reply || reply.deleted !== true) {
      return { ok: false, reason: (reply && reply.reason) || (this._hostHistorySupported === false ? "host_protocol_unsupported" : "host_unavailable") };
    }
    await this.historyStore.remove(conversationId);
    this.models.delete(conversationId);
    this._hostMetadataSent.delete(conversationId);
    this._hostTitles.delete(conversationId);
    this._firstPromptText.delete(conversationId);
    this._pendingHostMetadata.delete(conversationId);
    this._pageHostnameByConversation.delete(conversationId);
    if (this.currentConversationId === conversationId) this._setCurrentConversationId(null);
    this._notify();
    return {
      ok: true,
      onDiskRemoved: reply.onDiskRemoved !== false,
      hadActiveRun: !!reply.hadActiveRun,
      alreadyDeleted: !!reply.alreadyDeleted
    };
  }

  /**
   * Delete-all against the host (tasks.md 1.3). The local cache is cleared
   * only for a sweep the host completed in full; a partial sweep keeps the
   * cache and reports the failures so the operator sees what actually
   * happened.
   */
  async deleteAllConversations({ idempotencyKey } = {}) {
    if (this._hostHistorySupported === false) return { ok: false, reason: "host_protocol_unsupported", failed: [] };
    const key = idempotencyKey || this._newIdempotencyKey("delall", "all");
    const reply = await this._sendRequest("deleteAllConversations", { idempotencyKey: key });
    if (!reply || reply.deleted !== true) {
      const reason = (reply && reply.reason) || (this._hostHistorySupported === false ? "host_protocol_unsupported" : "host_unavailable");
      return { ok: false, reason, failed: (reply && reply.failed) || [] };
    }
    const cleared = await this.historyStore.clearAll();
    this.models.clear();
    this._hostMetadataSent.clear();
    this._hostTitles.clear();
    this._firstPromptText.clear();
    this._pendingHostMetadata.clear();
    this._pageHostnameByConversation.clear();
    this._setCurrentConversationId(null);
    this._notify();
    return { ok: true, count: typeof reply.count === "number" ? reply.count : cleared, hadActiveRuns: reply.hadActiveRuns || 0 };
  }

  _newIdempotencyKey(prefix, conversationId) {
    this._idempotencySeq = (this._idempotencySeq || 0) + 1;
    return `${prefix}_${conversationId}_${this._idempotencySeq}_${Date.now()}`;
  }

  /**
   * Rename / pin / archive one conversation on the HOST (tasks.md 4.3, spec
   * chat-history-lifecycle "Organization and export": "rename, pin, archive,
   * and export a conversation without changing its transcript contents"). One
   * operation for all three, because they are one thing: a presentation
   * metadata write the host owns and revisions.
   *
   * The `ifRevision` guard is what makes two panels editing the same row safe
   * (design.md risk "Cross-panel races"): the panel sends the revision it last
   * saw, and a stale one comes back as `revision_conflict` instead of
   * silently clobbering a newer edit from the other panel.
   *
   * @returns {Promise<{ok: true, meta: object} | {ok: false, reason: string}>}
   */
  async updateConversationPresentation(conversationId, patch = {}) {
    if (this._hostHistorySupported === false) return { ok: false, reason: "host_protocol_unsupported" };
    if (!patch || Object.keys(patch).length === 0) return { ok: false, reason: "empty_conversation_update" };
    const entry = await this.historyStore.get(conversationId);
    const ifRevision = entry && Number.isInteger(entry.revision) ? entry.revision : null;
    // `ifRevision` travels INSIDE the patch object: protocol-client.js's
    // updateConversation() spreads a patch into the flat wire envelope
    // (`{conversationId, ...patch, requestId}`), which is the shape
    // host/agent/protocol.js's validateConversationUpdate() reads.
    const reply = await this._sendRequest("updateConversation", {
      conversationId,
      patch: { ...patch, ...(ifRevision != null ? { ifRevision } : {}) }
    });
    if (!reply || reply.ok !== true) {
      return { ok: false, reason: (reply && reply.reason) || "host_unavailable" };
    }
    const meta = reply.meta || {};
    // Adopt exactly what the host confirmed, and nothing else: `reconcile()`
    // is wrong here — it treats every conversation the reply does not mention
    // as an orphan, and this reply mentions one. `upsert()` leaves the fields
    // the host did not answer for (hostname/createdAt) alone.
    await this.historyStore.upsert({
      conversationId,
      title: meta.title ?? null,
      hostname: meta.hostname ?? null,
      updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : Date.now(),
      pinned: meta.pinned === true,
      archived: meta.archived === true,
      revision: Number.isInteger(meta.revision) ? meta.revision : undefined,
      stale: false,
      // Propagated only when the host's own record carries it; `undefined`
      // leaves the entry's existing knowledge (including "unknown") intact.
      hasData: typeof meta.hasData === "boolean" ? meta.hasData : undefined
    });
    // The host's title is now settled, so the derived default must never be
    // re-sent over it (see `_deriveHostMetadataPatch()`), and neither must the
    // title/hostname this panel already pushed.
    this._hostTitles.set(conversationId, meta.title ?? null);
    const sent = this._hostMetadataSent.get(conversationId) || {};
    const nextSent = { ...sent };
    for (const key of Object.keys(patch)) if (key in meta) nextSent[key] = meta[key];
    this._hostMetadataSent.set(conversationId, nextSent);
    this._notify();
    return { ok: true, meta };
  }

  /**
   * Read a conversation's WHOLE transcript from the host, newest page first
   * (the host pages downward by `beforeSeq`), for export.
   *
   * The panel's own model cannot answer this: it is a bounded window (tasks.md
   * 3.3) that deliberately holds only the newest slice of a long
   * conversation. Export walks the host's pages instead, so the artifact
   * contains the transcript rather than whatever the screen happened to be
   * showing.
   *
   * @returns {Promise<{ok: true, events: Array<object>, pages: number}
   *   | {ok: false, reason: string}>}
   */
  async collectTranscript(conversationId, { limit } = {}) {
    if (this._hostHistorySupported === false) return { ok: false, reason: "host_protocol_unsupported" };
    if (!conversationId) return { ok: false, reason: "unknown_conversation" };
    const pages = [];
    const events = [];
    let beforeSeq = 0;
    for (let fetched = 0; fetched < MAX_EXPORT_PAGES; fetched += 1) {
      const reply = await this._sendRequest("requestTranscriptWindow", {
        conversationId,
        beforeSeq,
        ...(limit ? { limit } : {})
      });
      if (!reply || !Array.isArray(reply.events)) {
        return { ok: false, reason: (reply && reply.reason) || "host_unavailable" };
      }
      pages.push(reply);
      events.push(...reply.events);
      const firstSeq = Number.isInteger(reply.firstSeq) ? reply.firstSeq : 0;
      // Stops on: the host says there is nothing older, an empty page, or a
      // page that does not move the cursor. The last two are the same
      // defensive stop — a host answering with its newest page again must not
      // make this loop forever.
      if (reply.hasOlder !== true || reply.events.length === 0 || !firstSeq || firstSeq === beforeSeq) break;
      beforeSeq = firstSeq;
    }
    return { ok: true, events, pages: pages.length };
  }

  /**
   * Export one conversation as a local Markdown/JSON artifact (spec
   * chat-history-lifecycle "Organization and export"). Builds the text only —
   * the caller writes the download; nothing here mutates the transcript, the
   * cache, or the host.
   *
   * @returns {Promise<{ok: true, format, filename, mimeType, content,
   *   eventCount, messageCount} | {ok: false, reason: string}>}
   */
  async exportConversation(conversationId, { format = "md", exportedAt } = {}) {
    const normalized = normalizeExportFormat(format);
    if (!normalized) return { ok: false, reason: "unknown_format" };
    const collected = await this.collectTranscript(conversationId);
    if (!collected.ok) return collected;
    const entry = await this.historyStore.get(conversationId);
    const summary = { ...(entry || {}), conversationId };
    const prompts = await this.historyStore.promptsFor(conversationId);
    const artifact = buildConversationArtifact({
      summary,
      events: collected.events,
      prompts,
      format: normalized,
      exportedAt: exportedAt ?? Date.now()
    });
    return { ok: true, ...artifact };
  }

  /**
   * Push the presentation metadata this panel owns to the host (tasks.md
   * 1.1), coalesced like the local cache itself: at most one write per
   * conversation per window, and only when a field actually changed. A run
   * terminal or a snapshot flushes immediately (lifecycle), streaming
   * updates ride the timer.
   */
  _queueHostMetadata(model, { immediate = false } = {}) {
    if (!model || !model.conversationId) return;
    const patch = this._deriveHostMetadataPatch(model);
    if (!patch) return;
    const pending = this._pendingHostMetadata.get(model.conversationId) || {};
    this._pendingHostMetadata.set(model.conversationId, { ...pending, ...patch });
    if (immediate) {
      this._flushHostMetadata();
      return;
    }
    if (this._hostMetadataTimer) return;
    this._hostMetadataTimer = setTimeout(() => {
      this._hostMetadataTimer = null;
      this._flushHostMetadata();
    }, HISTORY_FLUSH_DELAY_MS);
    if (this._hostMetadataTimer.unref) this._hostMetadataTimer.unref();
  }

  /**
   * The title this panel may DERIVE for a conversation, or null when there is
   * none to give. A derived title is a DEFAULT, never an edit, so it is only
   * ever offered while the host has no title of its own — an operator rename
   * (tasks.md 4.3) lives there, and a panel that resumes someone else's
   * conversation must never overwrite a title it did not author.
   *
   * The text is the conversation's FIRST question and nothing else. A later
   * question is not this conversation's name, and a conversation rebuilt from
   * a snapshot without a local prompt echo holds an explicit placeholder in
   * that first slot — pushing either as a title would be worse than pushing
   * nothing. `_firstPromptText` is consulted first (the earliest recorded
   * prompt, synchronous by construction — see its field comment); the model's
   * own leading user item is the fallback, which is what covers a prompt this
   * panel just sent before the host echoed a runId back.
   */
  _derivedTitleFor(model) {
    if (this._hostTitles.get(model.conversationId)) return null;
    const remembered = this._firstPromptText.get(model.conversationId);
    let text = typeof remembered === "string" && remembered ? remembered : null;
    if (text == null) {
      const firstUser = model.items.find((i) => i.kind === "user");
      text = firstUser && firstUser.isPlaceholder !== true ? firstUser.text : null;
    }
    return text ? text.slice(0, 60) : null;
  }

  /** Remember a conversation's FIRST question, once, from whichever flow
   * learned it first — the earliest recorded prompt (`reopenConversation()`)
   * or the prompt the panel is sending right now (the START envelope). A
   * later prompt never replaces an earlier one. */
  _rememberFirstPrompt(conversationId, text) {
    if (this._firstPromptText.has(conversationId)) return;
    if (typeof text !== "string" || !text) return;
    this._firstPromptText.set(conversationId, text);
  }

  /** Adopt the host title this conversation's LOCAL CACHE row carries, when
   * nothing fresher is known. `_hostTitles` is filled by `reconcileHistory()`
   * and accepted renames, but boot does not reconcile — so a resumed
   * conversation's title would otherwise look unknown and the derived default
   * would overwrite a rename the panel simply had not listed yet. A title a
   * fresher reply already put in the map wins; a row with no title adopts
   * null, which is the honest "still untitled" the derive gate needs. */
  async _adoptCachedHostTitle(conversationId) {
    if (this._hostTitles.has(conversationId)) return;
    const entry = await this.historyStore.get(conversationId);
    if (this._hostTitles.has(conversationId)) return;
    this._hostTitles.set(conversationId, (entry && entry.title) || null);
  }

  _deriveHostMetadataPatch(model) {
    const sent = this._hostMetadataSent.get(model.conversationId) || {};
    const patch = {};
    const derivedTitle = this._derivedTitleFor(model);
    if (derivedTitle && derivedTitle !== sent.title) patch.title = derivedTitle;
    const hostname = this._pageHostnameByConversation.get(model.conversationId);
    if (hostname && hostname !== sent.hostname) patch.hostname = hostname;
    return Object.keys(patch).length ? patch : null;
  }

  _flushHostMetadata() {
    if (this._hostMetadataTimer) {
      clearTimeout(this._hostMetadataTimer);
      this._hostMetadataTimer = null;
    }
    const queued = [...this._pendingHostMetadata];
    this._pendingHostMetadata.clear();
    for (const [conversationId, patch] of queued) {
      const sent = this._hostMetadataSent.get(conversationId) || {};
      // Recorded only on a confirmed write: a failed push must be retried by
      // the next change rather than silently marked as sent. An accepted title
      // is also the host's title from now on, which is what stops the derived
      // default from being re-sent (see `_deriveHostMetadataPatch()`).
      this._sendRequest("updateConversation", { conversationId, patch }).then((reply) => {
        if (!reply || reply.ok !== true) return;
        this._hostMetadataSent.set(conversationId, { ...sent, ...patch });
        if ("title" in patch) this._hostTitles.set(conversationId, (reply.meta && reply.meta.title) ?? patch.title ?? null);
      });
    }
  }

  /** Flush everything the debounce holds for one model (run terminal, stop,
   * snapshot, unload). The local cache flush is fire-and-forget; the host
   * metadata push is coalesced but immediate. */
  flushHistory(model = this.currentModel()) {
    if (model) this._queueHostMetadata(model, { immediate: true });
    this.historyStore.flush();
  }

  /**
   * The ONLY place `currentConversationId` is assigned (design.md "Funnel all
   * active-conversation assignment through one setter"). Every one of the
   * four spots that used to write the field directly — both adopt branches in
   * `_onEnvelope`'s `snapshot` case, `reopenConversation()`, and the clear in
   * `deleteConversation()` — now calls this instead, so the persisted
   * "last active" identity can never drift from the in-memory one: whichever
   * of the four transitions actually happens, this setter sees it.
   *
   * Persistence is fire-and-forget with the rejection swallowed, the same
   * treatment `_persistHistoryEntry()` already gives history writes —
   * `chrome.storage.session` being unavailable must never block using the
   * panel, and this setter runs synchronously so callers can keep treating
   * the assignment itself as instant.
   *
   * scope-conversation-restore-per-tab: the write is scoped by `this._scope()`
   * (read fresh on every call, never cached — see the constructor's `scope`
   * doc), so this is the ONLY place a conversation id is ever remembered
   * against a scope, matching the ONLY place it is ever assigned in memory.
   * A scope that resolves to nothing makes the write a no-op (history-store.js's
   * own guard), which is correct: an unscoped panel has nothing of its own to
   * remember.
   */
  _setCurrentConversationId(conversationId) {
    this.currentConversationId = conversationId;
    this.historyStore.setLastActive(this._scope(), conversationId).catch(() => {});
  }

  async init() {
    this.profile = await this.profileCache.read();
    this.profileCache.onChange((p) => {
      this.profile = p;
      this._notify();
    });
    this.protocol.connect();
    // The panel's history operations are ADDITIVE protocol messages (see
    // protocol-client.js's MSG comments). This is the migration plan's
    // rollout gate, wired to the only thing that can actually decide it: does
    // THIS host answer them? Until a host proves it does, the panel behaves
    // exactly as it did before this change — the local cache as the list, the
    // full host-bounded snapshot instead of a window, and no delete that
    // claims the host removed something. `_probeHostHistory()` runs on every
    // handshake that becomes ok, so the modern case flips to the bounded,
    // host-authoritative behaviour as soon as the connection exists.
    this.protocol.onHandshakeChange((state) => {
      if (state === "ok" && this._hostHistorySupported == null) this._probeHostHistory();
    });
    this._probeHostHistory();
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

  /**
   * Whether the connected host speaks this change's history protocol
   * (`list_conversations` / `update_conversation` / `delete_conversation` /
   * `delete_all_conversations` / `transcript_window_request`): `null` = not
   * yet proven (no answer to the probe), `true` = a history request was
   * answered, `false` = the host refused the protocol with
   * `unknown_message_type`.
   *
   * The three states are deliberately distinct, and every consumer compares
   * against `false` explicitly rather than truthiness. "We do not know yet"
   * is not a refusal: the history view reports it as a different state
   * (tasks.md 4.3's offline vs error), and the model cap treats anything
   * short of an actual refusal as the windowed protocol (see
   * `_getOrCreateModel`).
   */
  hostHistorySupport() {
    return this._hostHistorySupported;
  }

  /** Ask the host once whether it speaks the history protocol. Fire-and-
   * forget: the answer only decides which implementation the panel uses. A
   * probe that learned nothing (no handshake yet, a dropped reply) is NOT
   * memoized, so the next handshake change tries again instead of latching
   * the panel into the fallback forever. */
  _probeHostHistory() {
    if (this._hostHistorySupported === false) return null;
    if (this._hostHistoryProbe) return this._hostHistoryProbe;
    this._hostHistoryProbe = this._sendRequest("listConversations", {}).then((reply) => {
      if (reply && Array.isArray(reply.conversations)) this._hostHistorySupported = true;
      else this._hostHistoryProbe = null;
      return this._hostHistorySupported;
    });
    return this._hostHistoryProbe;
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
      // Windowed rendering is only honest when the host can serve older pages
      // (migration plan's feature gate): against a host that has REFUSED the
      // history protocol, the panel renders the whole host-bounded snapshot
      // exactly as before rather than a window with no way to load more.
      //
      // The tri-state matters here, not a boolean: `null` (the probe has not
      // answered yet) is not a refusal, and a model created during that
      // window keeps whatever cap it was built with for the panel's whole
      // lifetime. Treating "not proven yet" as "cannot serve pages" is what
      // let a snapshot that beat the probe reply sit on an unbounded event
      // window forever; the windowed protocol is the expected surface, so
      // anything short of an actual refusal stays capped.
      model = new ConversationModel(conversationId, {
        maxWindowEvents: this.hostHistorySupport() === false ? Infinity : undefined
      });
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
    // The store records prompts in run order, so its FIRST entry is this
    // conversation's first question. Remembering it here is what lets an
    // untitled conversation be titled from a question asked before this panel
    // instance existed (a resumed, reloaded or otherwise older conversation)
    // instead of only from a question this panel happened to send itself.
    this._rememberFirstPrompt(conversationId, prompts.size ? prompts.values().next().value : null);
    // The host's own title for a conversation this panel instance has not
    // listed is still known LOCALLY: the cache row carries the title the last
    // reconcile (or this panel's own rename) put there. Adopt it before
    // anything can derive a default, so resuming can never overwrite a title
    // this panel did not author. `reconcileHistory()` runs on a later History
    // open and its fresher, host-authoritative answer wins over this adoption.
    await this._adoptCachedHostTitle(conversationId);
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

    // scope-conversation-restore-per-tab: reads ONLY this panel's own scope
    // (spec "Last active conversation restored per panel scope" — "SHALL NOT
    // adopt a conversation remembered for a different scope"). A scope that
    // resolves to nothing (spec "No identifiable scope") makes
    // `getLastActive()` resolve to `null` without ever touching the stored
    // map (see history-store.js), which falls straight into the
    // `!restorable` branch below exactly like "First ever open" — there is
    // no separate code path to fall through to another scope's id.
    const lastActiveId = await this.historyStore.getLastActive(this._scope());
    let restorable = false;
    if (lastActiveId) {
      const list = await this.historyStore.list();
      const entry = list.find((c) => c.conversationId === lastActiveId);
      // `stale` (tasks.md 1.2): the host's authoritative list no longer
      // reports this conversation, so the local row is a leftover, not a
      // reopenable conversation — never auto-resume it. `deletedLocally` is
      // kept for entries migrated from the v1 index.
      restorable = !!entry && !entry.deletedLocally && !entry.stale;
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
   * @param {object|null} [opts.elementRecord] - openspec/changes/
   *   add-design-mode-element-picker, design.md D7: a design-mode picked
   *   element's `{selector, tagName, markup, markupTruncated, styles,
   *   rectClipped}`, travelling as its OWN field beside `attachments` —
   *   never spliced into `text`. The caller (sidepanel.js) has already
   *   re-validated its recorded page identity against this exact send via
   *   page-context.js's sameIdentity() (design.md D8) before calling this.
   */
  async sendMessage(text, { tabScope = "any", profileId, modelId, pageContext = null, attachments = null, effort = null, elementRecord = null } = {}) {
    const model = this.currentModel();
    if (!model) throw new Error("PanelController.sendMessage: no active conversation");
    model.addLocalUserMessage(text, { attachments: attachments || [] });
    // Remember which page this conversation is bound to, so the host summary
    // can carry a hostname even after the operator navigates away (task 1.1).
    if (pageContext && pageContext.hostname) {
      this._pageHostnameByConversation.set(this.currentConversationId, pageContext.hostname);
    }
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
      ...(elementRecord ? { elementRecord } : {}),
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

  /**
   * @param {"approve"|"deny"} decision
   * @param {{remember?: boolean}} [opts] - Task 7.3: `remember` is forwarded
   *   to the wire ONLY when true, and only ever offered by the panel for a
   *   card whose `rememberable` field said so (never for a protected
   *   decision — see sidepanel.js's renderPermission()).
   */
  respondApproval(decision, { remember = false } = {}) {
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
      requestId,
      ...(remember === true ? { remember: true } : {})
    });
    model.clearPendingApproval();
    this._notify();
  }

  /** Task 2.4: the panel's answer to a LOCAL download-pause decision — see
   * protocol-client.js's downloadDecision() for why this never touches the
   * host's approval-token machinery. */
  respondDownloadDecision(decision) {
    const model = this.currentModel();
    if (!model || !model.pendingDownloadDecision) return;
    const { requestId, category, filename, url } = model.pendingDownloadDecision;
    this.protocol.downloadDecision({ requestId, decision });
    // Task 2.4: record it in THIS conversation's own timeline immediately —
    // the durable host-side half (background.js's fire-and-forget
    // download_decision_recorded relay) only becomes visible again on a
    // later reconnect/resume, and must not be the only place this decision
    // is ever shown.
    model.recordDownloadDecision({ requestId, decision, category, filename, url });
    model.clearPendingDownloadDecision();
    this._notify();
  }

  /**
   * Task 7.2: mirror the host's own "invalidate every outstanding decision
   * when the EFFECTIVE mode changes" behavior (host/agent/companion.js calls
   * `this._pendingApprovals.rejectAll(...)`, which resolves every suspended
   * canUseTool call `deny` — see reports/wave1-contracts.md). That denial
   * eventually reaches the panel as an ordinary tool_result on the SDK
   * stream, but only after a round trip; this clears the card from view
   * immediately on the panel's OWN successful mode-change request instead of
   * waiting for it. Clearing here also closes the race respondApproval()
   * would otherwise have: once cleared, `!model.pendingApproval` makes a
   * stale click a no-op rather than sending a decision for a request the
   * host has already forgotten. Applied across every conversation this
   * panel currently holds a model for — a mode change is companion-process-
   * wide, not scoped to whichever conversation is showing.
   */
  invalidateAllPendingApprovals() {
    for (const model of this.models.values()) model.clearPendingApproval();
    // Task 2.4: a permission-mode change must invalidate an outstanding
    // download decision exactly like it invalidates an ordinary approval
    // card — chrome.downloads has no tabId, so background.js tracks these
    // entirely on its own (never through the host's approval-token
    // machinery this method's own rejectAll() half already covers), which
    // means clearing this panel's OWN view of the card is not enough: a
    // stale background.js entry would still let a late Allow/Deny resume or
    // cancel the download for real. Tell it to forget every pending
    // decision too, so a late reply becomes the same silent no-op an
    // already-cleared pendingApproval already is.
    for (const model of this.models.values()) model.clearPendingDownloadDecision();
    this.protocol.invalidateDownloadDecisions("the permission mode changed; this decision was invalidated");
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

  // scope-conversation-restore-per-tab: clearing the remembered identity
  // happens inside deleteConversation() via `_setCurrentConversationId(null)`,
  // which writes under `this._scope()` — so a delete only ever clears THIS
  // controller's own scope's entry, never another scope's.
  //
  // The old local-only `deleteConversationLocally()` is GONE: it removed the
  // panel's list entry while the host transcript stayed put, which is exactly
  // the "UI claims success for a local-only removal" failure the lifecycle
  // spec forbids. Callers use `deleteConversation()` above, which talks to
  // the host first.

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
    //     through an explicit reopen (e.g. `deleteConversation()`).
    //
    // Leaving the error on `pending.conversationId`'s own model above is
    // enough even when this guard skips the fallback: nobody may be looking
    // at it right now, but it is there if the operator navigates back.
    if (this._explicitReopenSinceBoot || this.currentConversationId !== pending.conversationId) return;

    this.historyStore.setLastActive(this._scope(), null).catch(() => {});
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

    // A refusal is an ANSWER. An `error` envelope carrying one of OUR
    // requestIds (the companion's history handlers echo the id on their
    // failure replies) settles that request — it must not fall through to the
    // conversation-scoped error handling, and the caller must not have to
    // wait out a timeout and misreport an answered refusal as an unreachable
    // host.
    if (env.type === "error" && this._resolveRequest(env)) return;

    // An OLDER companion answers each of our history messages with the
    // existing `unknown_message_type` error (and no requestId — it has never
    // heard of this protocol, see protocol-client.js's MSG comments). That is
    // the migration plan's gate closing: remember it, settle every
    // outstanding history request right now (waiting out each one's timeout
    // would be a stall, not a fallback), and from here on behave exactly as
    // the pre-change panel did.
    if (env.type === "error" && env.reason === "unknown_message_type") {
      this._hostHistorySupported = false;
      this._settleAllRequests();
      this._notify();
      return;
    }

    switch (env.type) {
      // Request/reply history replies (tasks.md 1.1-1.3, 3.2). Each settles
      // the promise `_sendRequest()` created for it; nothing here mutates a
      // conversation model, so they return rather than falling through.
      case "list_conversations":
      case "delete_conversation":
      case "delete_all_conversations":
      case "transcript_window":
      case "update_conversation":
        this._resolveRequest(env);
        return;
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
          // This panel asked for a NEW conversation and this is its snapshot,
          // so the display adopts it even though one was already open. A
          // conversation merely RESUMED is never adopted here:
          // reopenConversation() sets currentConversationId itself before
          // asking and never sets the flag.
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
        this._persistHistoryEntry(model, { immediate: true });
        this._notify();
        break;
      }
      case "start": {
        if (env.runId) {
          const model = this.models.get(env.conversationId);
          if (model) {
            model.bindRunToLastUserMessage(env.runId);
            if (this._pendingSend) {
              const promptText = this._pendingSend.text;
              this.historyStore.recordPrompt(env.conversationId, env.runId, promptText).catch(() => {});
              this._pendingSend = null;
              // Mirror the store's own first-write-wins order: this send is
              // the conversation's first question only while its user item is
              // the leading one. In a resumed conversation whose earlier
              // question is unknown, this later question must not become the
              // title (see `_derivedTitleFor()`).
              if (model.items.find((i) => i.kind === "user")?.runId === env.runId) this._rememberFirstPrompt(env.conversationId, promptText);
            }
          }
        }
        this._notify();
        break;
      }
      case "stream_event": {
        const model = this.models.get(env.conversationId);
        if (model) {
          const event = normalizeEvent(env.event, env.runId);
          model.applyEvent(event);
          // A fragment-only envelope changes nothing durable: no history
          // write, no title derivation, no presentation push.
          if (!isTransientFragmentEvent(event)) this._persistHistoryEntry(model, { immediate: isRunTerminalEvent(event) });
        }
        this._notify();
        break;
      }
      case "token_batch": {
        const model = this.models.get(env.conversationId);
        if (model && Array.isArray(env.events)) {
          let terminal = false;
          let durable = false;
          for (const e of env.events) {
            const event = normalizeEvent(e, env.runId);
            model.applyEvent(event);
            if (isTransientFragmentEvent(event)) continue;
            durable = true;
            if (isRunTerminalEvent(event)) terminal = true;
          }
          // A batch of ONLY fragments is display-only traffic: the batcher
          // coalesces a fragment with the complete message it belongs to when
          // both are pending, but a lone fragment batch must not touch
          // history either way.
          if (durable) this._persistHistoryEntry(model, { immediate: terminal });
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
      // Task 2.4: LOCAL-only envelope types background.js synthesizes for
      // the chrome.downloads pause/decision gate — never emitted by
      // host/agent/protocol.js (see protocol-client.js's downloadDecision()
      // header for why). Routed by `env.conversationId`, which
      // background.js stamps from its own runId->conversationId tracking;
      // falling back to the currently-open conversation on the rare
      // occasion a run had not yet reported one covers a decision honestly
      // rather than dropping it silently.
      case "download_protected_decision": {
        const model = this._getOrCreateModel(env.conversationId || this.currentConversationId);
        if (model) {
          model.setPendingDownloadDecision({
            requestId: env.requestId,
            // The run this decision was raised for (background.js's
            // mostRecentActiveRun() at pause time) — kept so a later
            // run-teardown stream_event for THIS SAME run can clear it (see
            // ConversationModel.applyEvent()'s run_stopped/run_done/
            // run_error/run_interrupted_by_restart cases), independently of
            // background.js's own parallel invalidation of its map.
            runId: env.runId || null,
            category: env.category || "download",
            filename: env.filename,
            url: env.url,
            ts: env.ts || Date.now()
          });
        }
        this._notify();
        break;
      }
      case "download_notice": {
        const model = env.conversationId ? this.models.get(env.conversationId) : this.currentModel();
        if (model) {
          model.recordDownloadNotice({ filename: env.filename, url: env.url, outcome: env.outcome, detail: env.detail, ts: env.ts });
        }
        this._notify();
        break;
      }
      // Task 2.4: background.js's own invalidation of a download decision it
      // no longer considers answerable (the run it belonged to ended, or the
      // permission mode changed) — clears this panel's card too, so a stale
      // Allow/Deny click here is a no-op exactly like a naturally-resolved
      // one already is. Matched by requestId (never blindly cleared by
      // conversationId alone) so an unrelated later decision for the same
      // conversation is never dropped by mistake.
      case "download_decision_invalidated": {
        const model = env.conversationId ? this.models.get(env.conversationId) : this.currentModel();
        if (model && model.pendingDownloadDecision && model.pendingDownloadDecision.requestId === env.requestId) {
          model.clearPendingDownloadDecision();
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

  /**
   * Cache this model's conversation row locally and tell the host the
   * presentation metadata it owns (tasks.md 1.1/2.1).
   *
   * Both halves are COALESCED by default — a token batch must not rewrite
   * storage or hit the wire per event — and flushed immediately at the
   * lifecycle points design.md decision 2 names (`immediate: true` from a run
   * terminal or a snapshot).
   */
  _persistHistoryEntry(model, { immediate = false } = {}) {
    // The local cache gets the same derived default as the host push (see
    // `_derivedTitleFor()`): only while no title is known yet, and only from
    // this conversation's first real question. Otherwise the cache keeps
    // whatever the host reconcile put there, so a rename is not reverted on
    // the row either.
    const derivedTitle = this._derivedTitleFor(model);
    this.historyStore
      .upsert({
        conversationId: model.conversationId,
        title: derivedTitle || undefined,
        hostname: this._pageHostnameByConversation.get(model.conversationId) || undefined,
        interrupted: model.meta ? !!model.meta.interrupted : model.hasActiveRun() ? false : undefined,
        // What this panel can see for itself: a model with at least one item
        // has a question or a run in it. `false` therefore means "this
        // conversation is empty right now" — a brand-new conversation is
        // known-empty before any reconcile, and its first question (or the
        // host's own transcript, rebuilt through a snapshot) flips it back to
        // true on the very next persist.
        hasData: model.items.length > 0
      })
      .catch(() => {});
    this._queueHostMetadata(model, { immediate });
    if (immediate) this.historyStore.flush();
  }
}

function normalizeEvent(event, envelopeRunId) {
  if (!event) return event;
  return event.runId ? event : { ...event, runId: envelopeRunId };
}

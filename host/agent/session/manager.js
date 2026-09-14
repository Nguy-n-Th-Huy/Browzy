// Conversation lifecycle: start/resume/new/stop, one active run per
// conversation, and companion-restart recovery (task 3.5).
//
// Owns nothing about the SDK or the browser directly — it wires together
// storage/transcript-store.js (durable, sequenced events), a shared
// BrowserLease (serializes runs across conversations) and ApprovalRegistry,
// and hands out Run objects (session/run.js) that the companion actually
// drives through the SDK.

import crypto from "node:crypto";

import { Run, RUN_STATES } from "./run.js";
import { newRunId } from "../broker/browser-lease.js";
import { QUEUE_LIMIT, QUEUE_ENTRY_STATES } from "../storage/transcript-store.js";
import { PendingRecordingsStore } from "../storage/pending-recordings.js";
import { UsageLedger } from "../storage/usage-ledger.js";
import { RecordingAttachmentsStore, RECORDING_ATTACHMENT_STATES } from "../storage/recording-attachments.js";
import { sanitizeActionEvent, PerStreamSeqTracker } from "../storage/action-timeline.js";
import { migrateConversationMetadata, buildSdkSessionRef, SDK_SESSION_REF_STATUS, validateBudgetPolicy } from "../storage/conversation-metadata.js";
import { isTransientEvent } from "../protocol.js";

export function newConversationId() {
  return `conv_${crypto.randomBytes(9).toString("hex")}`;
}

export class SessionManager {
  /**
   * @param {object} deps
   * @param {import("../storage/transcript-store.js").TranscriptStore} deps.store
   * @param {import("../broker/browser-lease.js").BrowserLease} deps.lease
   * @param {import("../policy/approvals.js").ApprovalRegistry} deps.approvals
   * @param {import("../storage/pending-recordings.js").PendingRecordingsStore} [deps.pendingRecordings] -
   *   defaults to a real store over the standard agent-root path; injectable
   *   so tests can point it at a scratch file. Optional/additive: existing
   *   call sites that never pass this dep are unaffected unless they call
   *   recordRecordingComplete()/listPendingRecordings() (task 6.3).
   * @param {import("../storage/usage-ledger.js").UsageLedger} [deps.usageLedger] -
   *   tasks.md 5.3/5.4: the epoch-based usage ledger. Defaults to a real
   *   ledger over the standard agent-root path; injectable so tests can point
   *   it at a scratch root. Constructor never touches disk either way.
   * @param {import("../storage/recording-attachments.js").RecordingAttachmentsStore} [deps.recordingAttachments] -
   *   tasks.md 6.1/6.3/6.4: the durable recording-attachment claim store.
   *   Defaults to a real store over the standard agent-root path; injectable
   *   so tests can point it at a scratch file. Constructor never touches disk.
   */
  constructor({ store, lease, approvals, pendingRecordings, usageLedger, recordingAttachments, releaseNativeLease }) {
    this.store = store;
    this.lease = lease;
    this.approvals = approvals;
    // Passed down to every Run so finishing one also hands the shared browser
    // bridge back to host/native-host.js's guard — see Run's own note. Left
    // undefined in tests, where there is no pipe to talk to.
    this.releaseNativeLease = releaseNativeLease;
    this.pendingRecordings = pendingRecordings || new PendingRecordingsStore();
    this.usageLedger = usageLedger || new UsageLedger();
    this.recordingAttachments = recordingAttachments || new RecordingAttachmentsStore();
    this._activeRuns = new Map(); // conversationId -> Run
    // Explicit-delete tombstones (task: close reports/05-panel-evidence.md's
    // "No DELETE_CONVERSATION message type" gap, "handled explicitly, not
    // left racy" requirement). Deleting a conversation only synchronously
    // stops its Run (run.stop() aborts the SDK call and emits run_stopped
    // immediately), but the SDK's own query() generator notices the abort
    // and unwinds ASYNCHRONOUSLY — its `finally` block still calls
    // finishRun()/emits further events after deleteConversation() has
    // already removed the on-disk directory. Without this guard,
    // TranscriptStore.appendEvent()'s auto-vivify fallback
    // (`loadMeta() || createConversation()`) and updateMeta()'s
    // read-or-default-then-atomicWrite would silently resurrect a
    // half-formed conversation directory out from under a delete the panel
    // already told the user succeeded. Membership is checked by every
    // store-write path this class owns (see startRun's onEvent sink,
    // finishRun, setSkillsBinding) before it touches the store for a given
    // conversationId. In-memory only, per companion process — a fresh
    // process's disk-backed listConversations() simply won't list a
    // genuinely deleted conversation at all, so nothing needs to persist
    // this across a restart.
    this._deletedConversations = new Set();
    // Action-timeline reconnect dedup (task 5.10's host half): one
    // PerStreamSeqTracker per conversation, lazily seeded from this
    // conversation's own persisted history the first time it is touched in
    // THIS process (see recordActionEvents() below) — never simply reset to
    // empty on a fresh companion process, which would otherwise accept a
    // redelivered batch as new after a restart.
    this._actionEventCursors = new Map(); // conversationId -> PerStreamSeqTracker
    this._actionEventCursorsSeeded = new Set();

    // Queued-message drain wiring (openspec/changes/add-message-queue-and-
    // steering, design.md decision 4). This class owns the durable queue and
    // every transition on it, but it deliberately knows nothing about the SDK
    // or how a turn is actually run — starting a claimed message's turn needs
    // the submission payload, the profile/model resolution and the skills
    // binding, which all live in companion.js. So the drain itself is an
    // injected callback (same injection shape as `releaseNativeLease` above):
    // companion.js sets `onQueueDrain` to a function that claims the next
    // message and launches its turn, and every terminal path here calls
    // `_maybeDrainQueue()` once. Left null in tests that exercise the queue
    // bookkeeping alone, in which case a drain check is simply a no-op.
    this.onQueueDrain = null;

    // Live-push hook for queue transitions (the queue's counterpart to the
    // per-run event sink that companion.js's forked-child wiring installs on
    // every Run). Set where that wiring lives; unset means "durable append
    // only", which is all any test of the queue's own bookkeeping needs.
    this.onConversationEvent = null;

    // Per-conversation reentrancy guard for the drain (design.md decision 4:
    // "Drain is serialized per conversation with an in-flight guard"). The
    // callback is required to be SYNCHRONOUS about the decision — it claims
    // and launches, then returns; it must never await the whole turn, or this
    // guard would still be held when that turn's own terminal arrives and
    // silently swallow the next drain.
    this._drainsInFlight = new Set();
  }

  newConversation(meta = {}) {
    const conversationId = newConversationId();
    // Defensive: newConversationId() is a fresh random id (crypto.randomBytes(9),
    // 2^72 space) so colliding with a previously-deleted id is not a realistic
    // event, but a conversationId must never be permanently unwritable if it
    // somehow did collide.
    this._deletedConversations.delete(conversationId);
    this.store.createConversation(conversationId, meta);
    return conversationId;
  }

  listConversations(limit) {
    return this.store.listConversations(limit);
  }

  /**
   * Wire-facing summaries for the LIST_CONVERSATIONS protocol message (see
   * host/agent/companion.js's _handleListConversations()). Every field the
   * panel's history screen needs to render and reopen a conversation: the
   * presentation metadata the host is authoritative for (tasks.md 1.1 —
   * `title`, `hostname`, `pinned`, `archived`, `revision`), the interrupted
   * flag that survives a companion restart (resumeConversation()/
   * recoverAfterRestart() below), and whether THIS process currently has
   * that conversation's run actively queued or running — in-memory,
   * per-process, which is exactly right: after a restart
   * recoverAfterRestart() already clears any stale activeRunId and sets
   * interrupted instead of leaving a ghost "active" conversation for a
   * process that no longer exists.
   *
   * `hasData` is the store's answer to "does this conversation hold at least
   * one stored event" (transcript-store.js's listConversations() derives it
   * from the live seq allocator, so it is true for a conversation whose meta
   * has not flushed yet). The panel hides conversations that are explicitly
   * empty from its history LIST; nothing is filtered HERE, because a page of
   * empty conversations must never hide real ones from paging, orphans or
   * delete-all, which all run against this same authoritative list.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit] - cap on returned summaries; `total` still
   *   reports the full count so the panel can tell a capped list apart from
   *   a complete one.
   * @returns {{conversations: Array<object>, total: number, hasMore: boolean}}
   */
  conversationSummaries({ limit } = {}) {
    const total = this.store.conversationCount();
    const list = this.store.listConversations(limit);
    return {
      conversations: list.map((meta) => ({
        conversationId: meta.conversationId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        title: meta.title ?? null,
        hostname: meta.hostname ?? null,
        pinned: meta.pinned === true,
        archived: meta.archived === true,
        revision: meta.revision || 0,
        interrupted: Boolean(meta.interrupted),
        hasActiveRun: this.hasActiveRun(meta.conversationId),
        hasData: meta.hasData === true
      })),
      total,
      hasMore: list.length < total
    };
  }

  /**
   * Write presentation metadata the panel owns (title/hostname) or asks for
   * (pin/archive) — tasks.md 1.1/1.3. Guarded by the delete tombstone like
   * every other write path on this class: a conversation deleted in THIS
   * process must never be resurrected by a late metadata write from a panel
   * that had not yet seen the delete.
   *
   * @returns {{ok: true, meta: object} | {ok: false, reason: string, revision: number}}
   */
  updateConversationPresentation(conversationId, patch = {}) {
    if (this._deletedConversations.has(conversationId)) {
      return { ok: false, reason: "conversation_deleted", revision: 0 };
    }
    return this.store.updatePresentation(conversationId, patch);
  }

  /** Whether this process already committed a delete for this conversation
   * (the tombstone — see deleteConversation()'s doc comment). Lets the
   * DELETE_CONVERSATION handler answer a second delete idempotently instead
   * of falsely reporting `unknown_conversation`. */
  wasDeleted(conversationId) {
    return this._deletedConversations.has(conversationId);
  }

  /** Whether a conversation with this id currently exists on disk (not
   * deleted). Used by companion.js to reply unknown_conversation rather than
   * a false "deleted:true" for an id that was never valid. */
  hasConversation(conversationId) {
    // Tasks.md 2.3: the tombstone (this._deletedConversations), not a
    // successful on-disk rmSync, is what commits "this conversation no
    // longer exists" for every read in THIS process — deleteConversation()'s
    // disk removal is best-effort (a still-open file handle from an
    // aborting SDK subprocess can make it throw on Windows; finishRun()'s
    // late-unwind sweep retries it). Without this check, a reader in the
    // window between a tombstoned delete and that retry succeeding would
    // see loadMeta() still return the not-yet-removed file and report a
    // just-deleted conversation as present again — exactly the late
    // resurrection this guard exists to prevent.
    if (this._deletedConversations.has(conversationId)) return false;
    return Boolean(this.store.loadMeta(conversationId));
  }

  /**
   * Reconstruct session display from disk (spec: "Resume after restart"):
   * returns the transcript snapshot and marks any run that was active at
   * last-known state as interrupted. Never resumes browser actions.
   */
  resumeConversation(conversationId, afterSeq = 0) {
    const meta = this.store.loadMeta(conversationId);
    if (!meta) throw new Error(`unknown conversation: ${conversationId}`);
    if (meta.activeRunId && !this._activeRuns.has(conversationId)) {
      this.store.updateMeta(conversationId, { activeRunId: null, interrupted: true });
      this.store.appendEvent(conversationId, {
        type: "run_interrupted_by_restart",
        runId: meta.activeRunId
      });
    }
    // Second reconciliation site for the queue (design.md decision 2, tasks.md
    // 5.1): the same repair recoverAfterRestart() runs must also fire here,
    // because a conversation can be opened in a process that never lost its
    // in-memory state (a panel reload, not a companion restart) while a
    // previous companion process's claim was left `dispatching` on disk. A
    // conversation that DOES have a live run in this process is skipped: its
    // dispatching entry belongs to that run, not to a crash.
    if (!this._activeRuns.has(conversationId)) this._reconcileMessageQueue(conversationId);
    return this.store.snapshot(conversationId, afterSeq);
  }

  snapshotSince(conversationId, afterSeq = 0) {
    return this.store.snapshot(conversationId, afterSeq);
  }

  /** One older page of the durable event log, by sequence range (task 3.2). */
  transcriptWindow(conversationId, opts) {
    return this.store.transcriptWindow(conversationId, opts);
  }

  hasActiveRun(conversationId) {
    const run = this._activeRuns.get(conversationId);
    return !!run && (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING);
  }

  activeRun(conversationId) {
    return this._activeRuns.get(conversationId) || null;
  }

  /**
   * @param {object} [opts]
   * @param {Array<number>|'any'} [opts.tabScope]
   * @param {string} [opts.runId] - a pre-generated run id. Only a queued
   *   message's claim passes one: the claim writes it into the entry's
   *   `claimedByRunId` BEFORE this call, so a crash between the two halves is
   *   decidable from durable records alone (design.md decision 2). Every other
   *   caller omits it and the Run mints its own.
   * @throws if the conversation already has an active run (spec: "prevent
   *   more than one active run per conversation").
   */
  startRun(conversationId, { tabScope = "any", runId } = {}) {
    if (!this.store.loadMeta(conversationId)) throw new Error(`unknown conversation: ${conversationId}`);
    if (this.hasActiveRun(conversationId)) {
      throw new Error(`conversation ${conversationId} already has an active run`);
    }
    const run = new Run({
      conversationId,
      lease: this.lease,
      approvals: this.approvals,
      tabScope,
      runId,
      releaseNativeLease: this.releaseNativeLease,
      // Guarded against the explicit-delete race documented on
      // this._deletedConversations above: an event emitted after this
      // conversation was deleted (e.g. the SDK query() generator's `finally`
      // unwinding asynchronously, after abortController.abort() but before
      // deleteConversation() returned) is dropped rather than resurrecting
      // the just-removed on-disk directory.
      onEvent: (event) => {
        if (this._deletedConversations.has(conversationId)) return;
        // Live stream fragments (protocol.js's STREAM_PARTIAL_EVENT_TYPE)
        // are transient by contract: they exist to drive the panel's live
        // display while a message is still being produced, and must never
        // become part of this conversation's durable record. Dropping them
        // HERE, at the one call that writes an event through to disk, is
        // what keeps `store.appendEvent` the only path to a stored record
        // and replay/snapshot/reconnect exactly the complete-message history
        // they are today — with no `seq` allocated to a fragment and nothing
        // for a later reconnect to rebuild from (design.md decisions 2/3).
        if (isTransientEvent(event)) return;
        this.store.appendEvent(conversationId, event);
      }
    });
    this._activeRuns.set(conversationId, run);
    this.store.updateMeta(conversationId, { activeRunId: run.runId, interrupted: false });
    this.store.appendEvent(conversationId, { type: "run_created", runId: run.runId, tabScope });
    return run;
  }

  /**
   * The skills session this conversation is bound to (task 7.2 / spec
   * "Skill version and lifecycle isolation"): `{ cwd, skillsDir,
   * allowedSkillNames, catalogSnapshot, skillOverrides }`, first computed by
   * host/agent/companion.js's `_bindSkillsForRun()` on the conversation's
   * FIRST run and persisted here so every later run of the SAME conversation
   * reuses the identical bound snapshot rather than re-deriving from a
   * possibly-changed live catalog — this is what makes "a skill refreshed or
   * disabled mid-conversation does not silently change a running
   * conversation" true across turns, not just within one run.
   *
   * @returns {object|null}
   */
  getSkillsBinding(conversationId) {
    const meta = this.store.loadMeta(conversationId);
    return (meta && meta.skillsBinding) || null;
  }

  /** Persist this conversation's first-run skills binding (see getSkillsBinding). */
  setSkillsBinding(conversationId, binding) {
    if (this._deletedConversations.has(conversationId)) return; // see this._deletedConversations' header comment
    this.store.updateMeta(conversationId, { skillsBinding: binding });
  }

  /**
   * The versioned conversation metadata envelope (tasks.md 2.1 / design.md
   * decision 2), migrating a legacy or missing record to the current schema
   * on first read and persisting that result so later reads are cheap and
   * stable (host/agent/storage/conversation-metadata.js's own migration
   * contract: never reconstructs `appProfile` from a legacy record).
   *
   * @param {string} conversationId
   * @returns {object|null} null for an unknown/deleted conversation
   */
  getConversationMetadata(conversationId) {
    // See hasConversation()'s identical guard: the tombstone, not a
    // successful on-disk removal, is what commits a delete for THIS
    // process's reads too — never resurrect a deleted conversation's
    // metadata (including its sdkSessionRef) just because the underlying
    // rmSync had not yet (or failed to) finish.
    if (this._deletedConversations.has(conversationId)) return null;
    const meta = this.store.loadMeta(conversationId);
    if (!meta) return null;
    const migrated = migrateConversationMetadata(meta);
    // migrateConversationMetadata() returns the SAME reference when no
    // migration was needed (see its own docstring) — only write when it
    // actually built a new envelope, so a hot read path never triggers a
    // redundant disk write.
    if (migrated !== (meta.conversationMetadata || null) && !this._deletedConversations.has(conversationId)) {
      this.store.updateMeta(conversationId, { conversationMetadata: migrated });
    }
    return migrated;
  }

  /**
   * Bind this run's app-immutable identity (secret-free profile identity,
   * session-schema identity, permission-policy identity — tasks.md 2.1/2.2)
   * into the conversation's metadata envelope, ONCE. A later run's call is a
   * no-op for these three fields — mirrors setSkillsBinding's own "bound on
   * first run, reused verbatim afterward" contract, so a mid-conversation
   * profile/skill change never silently rewrites an already-bound
   * conversation's recorded identity (that comparison/rejection is 2.4's
   * job, not this method's).
   *
   * @param {string} conversationId
   * @param {{appProfile: object, sessionSchemaIdentity: object|null, permissionPolicy: object|null}} snapshot
   * @returns {object|null} the resulting (possibly unchanged) envelope, or
   *   null for an unknown/deleted conversation
   */
  bindConversationAppSnapshot(conversationId, { appProfile, sessionSchemaIdentity, permissionPolicy }) {
    const current = this.getConversationMetadata(conversationId);
    if (!current) return null;
    if (current.appProfile) return current; // already bound; never overwritten
    if (this._deletedConversations.has(conversationId)) return current; // see this._deletedConversations' header comment
    const next = { ...current, appProfile, sessionSchemaIdentity, permissionPolicy };
    this.store.updateMeta(conversationId, { conversationMetadata: next });
    return next;
  }

  /**
   * Atomic (compare-and-set style) SDK-reference ownership (tasks.md 2.3).
   * Called by host/agent/companion.js's `_runQuery()` the moment a run's
   * `system`/`init` message reports a `session_id` — for a fresh (never
   * resumed) query() that is this conversation's FIRST captured id; for a
   * resumed query() the SDK always echoes the SAME id back (gate-0.2
   * evidence G1/G10), so this is also the normal per-turn confirmation path.
   *
   * "Atomic" here means "single-writer, single-active-run" — real filesystem
   * locking is unnecessary because SessionManager.startRun() already
   * guarantees at most one Run exists per conversationId at a time (this
   * class's own invariant, enforced above), so at most one caller can ever
   * reach this method for a given conversationId concurrently. The
   * compare-and-set contract this method still enforces on top of that:
   *   - No existing ref, OR the existing ref's `sessionId` matches exactly
   *     -> claim succeeds, ref is written/refreshed to ACTIVE.
   *   - An existing ref whose last known status is NOT ACTIVE (MISSING or
   *     RESUME_FAILED — see markSdkSessionRefStatus) -> claim succeeds even
   *     for a DIFFERENT `sessionId`. That old id was already established as
   *     unresumable (getResumeSessionId() only ever offers an ACTIVE id, so
   *     THIS run could not have attempted to resume it) — the fresh id
   *     replacing it is this conversation's new working session, not a
   *     surprise.
   *   - An existing ACTIVE ref with a DIFFERENT `sessionId` -> claim is
   *     REJECTED (the stored ref is left untouched) rather than silently
   *     overwritten — an unexpected different id while the recorded one was
   *     still believed usable (no `forkSession`/explicit new-session choice
   *     was requested) is a fact worth surfacing, never a silent identity
   *     swap.
   *
   * @param {string} conversationId
   * @param {{sessionId: string}} params
   * @returns {{claimed: boolean, ref: object|null, conflict?: boolean}}
   */
  claimSdkSessionRef(conversationId, { sessionId }) {
    if (this._deletedConversations.has(conversationId)) return { claimed: false, ref: null };
    const current = this.getConversationMetadata(conversationId);
    if (!current) return { claimed: false, ref: null };
    const existingRef = current.sdkSessionRef;
    const sameId = existingRef && existingRef.sessionId === sessionId;
    const existingIsStale = existingRef && existingRef.status !== SDK_SESSION_REF_STATUS.ACTIVE;
    if (existingRef && !sameId && !existingIsStale) {
      return { claimed: false, ref: existingRef, conflict: true };
    }
    const ref = buildSdkSessionRef({ sessionId, status: SDK_SESSION_REF_STATUS.ACTIVE, previous: sameId ? existingRef : null });
    const next = { ...current, sdkSessionRef: ref };
    this.store.updateMeta(conversationId, { conversationMetadata: next });
    return { claimed: true, ref };
  }

  /**
   * Record an explicit resume-failure outcome (tasks.md 2.5) WITHOUT
   * clearing the captured `sessionId` — "never auto-clear a ref on resume
   * failure": the id stays on disk so an explicit later retry (or a human
   * inspecting state) still has it, and so a transient failure can never be
   * silently "fixed" by quietly starting a brand-new session under the same
   * conversation next turn. Only companion.js's classified resume-failure
   * path calls this (see `_runQuery()`'s catch block); a run that never
   * attempted resume never touches this.
   *
   * @param {string} conversationId
   * @param {string} status - one of SDK_SESSION_REF_STATUS (MISSING or
   *   RESUME_FAILED)
   * @returns {object|null} the updated ref, or null if there was nothing to
   *   mark (unknown/deleted conversation, or no ref was ever captured)
   */
  markSdkSessionRefStatus(conversationId, status) {
    if (this._deletedConversations.has(conversationId)) return null;
    const current = this.getConversationMetadata(conversationId);
    const existingRef = current && current.sdkSessionRef;
    if (!existingRef) return null;
    const ref = buildSdkSessionRef({ sessionId: existingRef.sessionId, status, previous: existingRef });
    const next = { ...current, sdkSessionRef: ref };
    this.store.updateMeta(conversationId, { conversationMetadata: next });
    return ref;
  }

  /**
   * The session id a run should pass as the SDK's `resume` option, or `null`
   * when none should be attempted — ONLY when a ref exists AND its last
   * known status is ACTIVE (tasks.md 2.5: a MISSING/RESUME_FAILED ref is
   * never retried automatically; that would be exactly the "quiet
   * degradation" this change exists to eliminate — see
   * markSdkSessionRefStatus's own doc comment).
   *
   * @param {string} conversationId
   * @returns {string|null}
   */
  getResumeSessionId(conversationId) {
    const current = this.getConversationMetadata(conversationId);
    const ref = current && current.sdkSessionRef;
    if (!ref || ref.status !== SDK_SESSION_REF_STATUS.ACTIVE) return null;
    return ref.sessionId;
  }

  /**
   * This conversation's configured usage policy (tasks.md 5.1), or null for
   * an unknown/deleted conversation. Never a fabricated limit: unset fields
   * read back as null.
   */
  getBudgetPolicy(conversationId) {
    const current = this.getConversationMetadata(conversationId);
    return (current && current.budgetPolicy) || null;
  }

  /**
   * Persist a validated usage policy for this conversation (tasks.md 5.1).
   * Rejects out-of-range/unknown fields rather than storing a lie.
   * @returns {{ok: true, policy: object} | {ok: false, reason: string}}
   */
  setBudgetPolicy(conversationId, policy) {
    if (this._deletedConversations.has(conversationId)) return { ok: false, reason: "conversation_deleted" };
    const validated = validateBudgetPolicy(policy);
    if (!validated.ok) return validated;
    const current = this.getConversationMetadata(conversationId);
    if (!current) return { ok: false, reason: "unknown_conversation" };
    const next = { ...current, budgetPolicy: validated.policy };
    this.store.updateMeta(conversationId, { conversationMetadata: next });
    return { ok: true, policy: validated.policy };
  }

  /**
   * Start a new usage epoch for this conversation (tasks.md 5.4): SDK totals
   * reset on resume/clear (gate-0.2 G10), so the ledger must stop differencing
   * against pre-reset cumulatives. Bumps BOTH the ledger file's epoch and
   * conversationMetadata.usageEpoch together; the old epoch's pending rows
   * stay pending/unknown in place (usage-ledger.js never migrates or zeroes
   * them). Returns the new epoch, or null for an unknown/deleted conversation.
   */
  bumpUsageEpoch(conversationId, reason = null) {
    if (this._deletedConversations.has(conversationId)) return null;
    const current = this.getConversationMetadata(conversationId);
    if (!current) return null;
    const epoch = this.usageLedger.beginEpoch(conversationId, reason);
    const next = { ...current, usageEpoch: epoch };
    this.store.updateMeta(conversationId, { conversationMetadata: next });
    this.store.appendEvent(conversationId, { type: "usage_epoch_started", epoch, reason });
    return epoch;
  }

  /**
   * Phase-1 recording claim for an explicitly selected IDLE conversation
   * (tasks.md 6.3): `selected -> attached`, verified and idempotent.
   *
   * Fail-closed in this order: unknown/deleted conversation, conversation
   * with an ACTIVE run (only idle conversations may be selected — never
   * route one conversation's claim into another's live run), missing pending
   * reference, attachment-store conflict. The pending reference is removed
   * only after the `attached` state is durably persisted (the store's own
   * attach() orders it that way); a removal failure still leaves the claim
   * attached, and the stale pending entry is dropped here on the next claim
   * attempt for the same recording.
   *
   * @returns {{ok: true, record: object, idempotent?: boolean} | {ok: false, reason: string}}
   */
  async claimPendingRecording({ recordingId, conversationId, idempotencyKey }) {
    if (this._deletedConversations.has(conversationId) || !this.store.loadMeta(conversationId)) {
      return { ok: false, reason: "unknown_conversation" };
    }
    if (this.hasActiveRun(conversationId)) {
      return { ok: false, reason: "conversation_not_idle" };
    }
    const pending = this.pendingRecordings.get(String(recordingId));
    const selected = this.recordingAttachments.select({ recordingId, conversationId, idempotencyKey });
    if (!selected.ok) return { ok: false, reason: selected.reason };
    if (!pending) {
      // No pending reference: either already consumed by an earlier attach
      // (idempotent re-claim — the store answers from durable state) or a
      // genuinely unknown recording.
      const existing = this.recordingAttachments.get(String(idempotencyKey));
      if (existing && existing.state !== RECORDING_ATTACHMENT_STATES.SELECTED) {
        return { ok: true, idempotent: true, record: existing };
      }
      if (existing) {
        await this.recordingAttachments.markFailed(String(idempotencyKey), "recording_pending_reference_missing");
        return { ok: false, reason: "recording_pending_reference_missing" };
      }
      return { ok: false, reason: "recording_pending_reference_missing" };
    }
    const attached = await this.recordingAttachments.attach(String(idempotencyKey), {
      verify: ({ recordingId: rid, conversationId: cid }) => {
        if (!this.store.loadMeta(cid) || this._deletedConversations.has(cid)) {
          return { ok: false, reason: "unknown_conversation" };
        }
        if (this.hasActiveRun(cid)) return { ok: false, reason: "conversation_not_idle" };
        const ref = this.pendingRecordings.get(String(rid));
        if (!ref) return { ok: false, reason: "recording_pending_reference_missing" };
        return {
          ok: true,
          integrity: { path: ref.path || null, schema: ref.schema || "v0", transcriptStatus: ref.transcriptStatus || "ok" }
        };
      },
      consumePending: (rid) => this.pendingRecordings.remove(String(rid))
    });
    if (!attached.ok) return { ok: false, reason: attached.reason };
    const record = attached.record;
    if (this._deletedConversations.has(conversationId)) return { ok: false, reason: "conversation_deleted" };
    this.store.appendEvent(conversationId, {
      type: "recording_attachment",
      recordingId: record.recordingId,
      idempotencyKey: record.idempotencyKey,
      state: record.state
    });
    return { ok: true, idempotent: !!attached.idempotent, record };
  }

  /**
   * Every currently active (queued or running) run started by THIS process
   * for the given profileId — used to cancel runs when their credential is
   * revoked (host/agent/companion.js's onCredentialRevoked wiring; design.md
   * decision 4: "removing a credential ... cancels associated runs"). A run
   * is tagged with the profileId it was started with by companion.js's
   * _handleStart() (`run.profileId = profileId`) before this can match it.
   *
   * @param {string} profileId
   * @returns {Array<{conversationId: string, run: Run}>}
   */
  activeRunsForProfile(profileId) {
    const matches = [];
    for (const [conversationId, run] of this._activeRuns) {
      if (run.profileId === profileId && (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING)) {
        matches.push({ conversationId, run });
      }
    }
    return matches;
  }

  /**
   * Stop the conversation's active run, and (for an operator stop) pause the
   * message queue behind it.
   *
   * The pause is deliberately conditioned on the reason: `stopRun` is also
   * this class's internal cancellation primitive for a deleted conversation
   * and for a revoked credential, and neither of those is the operator
   * intervening — auto-pausing the drain there would strand pending messages
   * behind a resume action nobody asked for. Only "user_stop" (the wire
   * STOP's own default reason) pauses, and only when there is something to
   * pause (design.md decision 5 / tasks.md 3.4).
   *
   * @param {string} conversationId
   * @param {string} [reason]
   * @returns {boolean} whether a run was actually stopped
   */
  stopRun(conversationId, reason = "user_stop") {
    const run = this._activeRuns.get(conversationId);
    if (!run) return false;
    if (run.state === RUN_STATES.STOPPED || run.state === RUN_STATES.DONE) return false;
    run.stop(reason);
    if (!this._deletedConversations.has(conversationId)) {
      this.store.updateMeta(conversationId, { activeRunId: null });
      if (reason === "user_stop") this._pauseQueue(conversationId, "user_stop");
    }
    // A terminal by any name is a drain trigger (design.md decision 4). The
    // paused queue set just above makes this a no-op for an operator stop;
    // for every other reason it is what lets the next pending turn start
    // without waiting for the aborted SDK query's own unwind to reach
    // finishRun().
    this._maybeDrainQueue(conversationId);
    return true;
  }

  /**
   * Retire a finished run and clear this conversation's active-run slot.
   *
   * `finished` is the Run this call is about. It matters because an interrupt
   * claims its successor the moment the interrupted run is stopped, so the
   * interrupted run's ASYNCHRONOUS unwind can reach here after a DIFFERENT run
   * already owns this conversation's slot; without it, that late call would
   * mark the successor done, delete it from the active map, and clear its
   * `activeRunId` — killing a live run from a dead one's bookkeeping. Callers
   * that pass nothing keep the pre-existing behavior (the slot's current
   * occupant is retired), which is correct for the one caller class that has
   * no run object: nothing else reaches here without one.
   */
  finishRun(conversationId, finished = null) {
    const current = this._activeRuns.get(conversationId);
    if (finished && current && current !== finished) return; // superseded — see above
    if (current) current.markDone();
    this._activeRuns.delete(conversationId);
    if (this._deletedConversations.has(conversationId)) {
      // Late-unwind sweep (tasks.md 2.3): deleteConversation() already
      // removed the on-disk directory synchronously, but the SDK's own
      // query() generator can still be unwinding asynchronously when a
      // delete races an active run (gate-0.2 evidence G5: ~7s abort->settle
      // latency) — e.g. the CLI subprocess still holding its session
      // `.jsonl` file open under this conversation's `configDir` at the
      // moment the first delete ran (a real possibility on Windows, where an
      // open handle can make an rmSync throw despite `force: true`).
      // Retrying now that this run has genuinely finished and released every
      // handle it held closes that window without resurrecting anything —
      // it only ever re-removes a directory a real deleteConversation() call
      // already committed to removing. Best-effort: a failure here must
      // never throw out of finishRun (mirrors every other best-effort
      // cleanup in this file).
      try {
        this.store.deleteConversation(conversationId);
      } catch {
        // best-effort — see comment above
      }
      return;
    }
    this.store.updateMeta(conversationId, { activeRunId: null });
    // Post-terminal drain (design.md decision 4): run_done, run_stopped and
    // run_error all funnel through here, so this one call covers the whole
    // terminal matrix — including the early returns above that finish a run
    // without a query() ever running.
    this._maybeDrainQueue(conversationId);
  }

  // --- Queued messages ------------------------------------------------
  //
  // openspec/changes/add-message-queue-and-steering: a message submitted
  // while this conversation's run is active is accepted into a bounded,
  // durable, per-conversation queue and runs as a subsequent turn in
  // submission order (design.md decisions 1-9).
  //
  // Shape of the state, and why it is split the way it is:
  //   - `meta.messageQueue` holds the LIVE entries only — `{messageId, mode,
  //     state, claimedByRunId, idempotencyKey, enqueuedAt}` — bounded by
  //     QUEUE_LIMIT and rewritten atomically with the rest of meta.json.
  //   - The operator's text, its bound page context, its attachments and the
  //     profile/model it was submitted under live in the message's own
  //     `message_queued` event in the append-only log, and nowhere else. Meta
  //     stays small and bounded no matter how long a message's text is, and no
  //     restore path can render that text twice (design.md decisions 1/9).
  //   - `messageId` is the seq of that event, so the two halves are joined by
  //     a monotonic id the log itself assigned, not by anything in memory.
  //
  // A claim is the only transition that makes a message runnable, and it is
  // two-phase and durable (design.md decision 2): the entry goes
  // `dispatching` with a PRE-GENERATED `claimedByRunId`, `message_claimed` is
  // appended, and only then is the run created with that same id. A crash
  // between the phases is therefore decidable from disk alone — see
  // `_reconcileMessageQueue()`.

  /** Live entries for one conversation (never null). */
  queueEntries(conversationId) {
    const meta = this.store.loadMeta(conversationId);
    return Array.isArray(meta && meta.messageQueue) ? meta.messageQueue : [];
  }

  /** Just the entries still waiting for a turn (`pending`), in FIFO order. */
  pendingQueueEntries(conversationId) {
    return this.queueEntries(conversationId).filter((entry) => entry.state === QUEUE_ENTRY_STATES.PENDING);
  }

  /** The entry a delivery with this idempotency key already created, or null.
   * Backs R7's durable half: a retried send resolves to the SAME entry, not a
   * second one, without depending on any in-memory memo surviving. */
  findQueuedByIdempotencyKey(conversationId, idempotencyKey) {
    if (!idempotencyKey) return null;
    return this.queueEntries(conversationId).find((entry) => entry.idempotencyKey === idempotencyKey) || null;
  }

  /**
   * The stored submission payload of one queued message — everything a turn
   * needs that is NOT in the entry: the operator's text, the page-context
   * snapshot captured at SUBMISSION time (design.md decision 8: a queued
   * message's page context binds at submit and is never re-resolved when its
   * turn starts), attachment refs, element record, effort, profile, model,
   * session choice and tab scope.
   *
   * @returns {object|null} null when the message's own event is not in the
   *   log (a torn tail, or a hand-edited meta) — the caller treats that as a
   *   failed message rather than guessing at a turn.
   */
  queuedMessageSubmission(conversationId, messageId) {
    const event = this.store
      .allEvents(conversationId)
      .find((e) => e.seq === messageId && e.type === "message_queued");
    return (event && event.submission) || null;
  }

  /**
   * Append one event to the conversation's log AND forward it to connected
   * panels as it is stored (the live-push half of design.md decision 9: queue
   * transitions must be visible even while NO run is active, when the run
   * event sink that normally carries live traffic does not exist).
   *
   * `onQueueDrain`'s sibling, `onConversationEvent`, is what companion.js's
   * forked-child wiring uses to push these; unset in tests, where the durable
   * append is all that is being exercised. Tombstone-guarded exactly like
   * every other write path on this class — a late queue write must never
   * resurrect a deleted conversation.
   */
  _emitConversationEvent(conversationId, event) {
    if (this._deletedConversations.has(conversationId)) return null;
    const stored = this.store.appendEvent(conversationId, event);
    try {
      if (this.onConversationEvent) this.onConversationEvent(conversationId, stored);
    } catch {
      // A live-push failure must never break queue bookkeeping: the event is
      // already durable by this point, and the panel rebuilds from the log.
    }
    return stored;
  }

  /**
   * Accept one message into the queue: append its durable `message_queued`
   * event (the ONLY home of its text and submission payload) and add the live
   * entry that points at it.
   *
   * The bound is checked BEFORE anything is appended (tasks.md 2.2), so a
   * refusal leaves no trace at all: no entry, no event, and the operator's
   * draft is still theirs to edit. A submission that arrives while the queue
   * is paused also re-arms it (design.md decision 5 — "resume on explicit
   * resume or the next submission").
   *
   * @param {object} params
   * @param {"queue"|"interrupt"} params.mode
   * @param {string|null} [params.idempotencyKey]
   * @param {object} params.submission - see queuedMessageSubmission()
   * @returns {{ok: true, entry: object, idempotent?: boolean}
   *          | {ok: false, reason: string, limit?: number}}
   */
  enqueueMessage(conversationId, { mode = "queue", idempotencyKey = null, submission }) {
    if (this._deletedConversations.has(conversationId)) return { ok: false, reason: "conversation_deleted" };
    const meta = this.store.loadMeta(conversationId);
    if (!meta) return { ok: false, reason: "unknown_conversation" };
    const queue = this.queueEntries(conversationId);

    // R7: a retry carrying the same key resolves to the entry the first
    // delivery created, and never appends a second message event.
    const existing = idempotencyKey ? queue.find((entry) => entry.idempotencyKey === idempotencyKey) : null;
    if (existing) return { ok: true, entry: existing, idempotent: true };

    const pendingCount = queue.filter((entry) => entry.state === QUEUE_ENTRY_STATES.PENDING).length;
    if (pendingCount >= QUEUE_LIMIT) return { ok: false, reason: "queue_full", limit: QUEUE_LIMIT };

    // `messageId` is the seq this append is about to receive. Resolving it
    // BEFORE the append is what lets the event itself carry the id every
    // consumer (entry, ack, later claimed/consumed events) uses, without a
    // second write to rewrite it in. Safe by construction: nothing here
    // awaits, and `nextSeq()` seeds from the log, so no other append can
    // interleave between this line and the one below.
    const messageId = this.store.nextSeq(conversationId);
    const stored = this._emitConversationEvent(conversationId, {
      type: "message_queued",
      messageId,
      mode,
      submission
    });
    const entry = {
      messageId: stored.seq,
      mode,
      state: QUEUE_ENTRY_STATES.PENDING,
      claimedByRunId: null,
      idempotencyKey: idempotencyKey || null,
      enqueuedAt: Date.now()
    };
    this.store.updateMeta(conversationId, { messageQueue: [...queue, entry] });
    this.clearQueuePause(conversationId, "submission");
    return { ok: true, entry };
  }

  /**
   * The two-phase claim (design.md decision 2), for one conversation:
   *   1. pick the next runnable entry — the designated interrupt successor
   *      first if it is still pending, else the FIFO head;
   *   2. write it `dispatching` with the pre-generated run id it will own and
   *      append `message_claimed`;
   *   3. create the run through the normal startRun() path with that id.
   *
   * Steps 1-3 are synchronous, so two concurrent triggers cannot both claim
   * the same entry: the second one reads the state the first already wrote.
   *
   * @returns {{run: Run, entry: object, submission: object}|null} null when
   *   there is nothing to claim.
   */
  claimNextQueuedMessage(conversationId) {
    if (this._deletedConversations.has(conversationId)) return null;
    const meta = this.store.loadMeta(conversationId);
    if (!meta) return null;
    const queue = this.queueEntries(conversationId);
    const pending = queue.filter((entry) => entry.state === QUEUE_ENTRY_STATES.PENDING);
    if (pending.length === 0) return null;
    // R3's claim order: the designated interrupt successor first, everything
    // else in FIFO order after it (design.md decision 7 — interrupt is the
    // only jumper).
    const successorId = meta.successorMessageId ?? null;
    const ordered = successorId == null
      ? pending
      : [...pending.filter((entry) => entry.messageId === successorId), ...pending.filter((entry) => entry.messageId !== successorId)];

    for (const entry of ordered) {
      // A message whose own `message_queued` event is gone cannot be run
      // honestly — there is no text to send and no submission-time context to
      // bind. It is failed (a visible terminal outcome) and dropped rather
      // than left at the head of the queue, where it would block every
      // message behind it forever; the loop then tries the next one.
      const submission = this.queuedMessageSubmission(conversationId, entry.messageId);
      if (!submission) {
        this._dropQueueEntry(conversationId, entry.messageId);
        this._emitConversationEvent(conversationId, {
          type: "message_failed",
          messageId: entry.messageId,
          reason: "submission_missing"
        });
        continue;
      }

      // R6: the interrupt that designated this successor is only claimed as an
      // interrupt if the run it was meant to preempt actually reached its
      // terminal via `run_stopped`/`user_interrupt`. When it did not (the
      // companion died first, and restart recovery recorded
      // `run_interrupted_by_restart` instead), the honest outcome is the
      // fallback note — the message still runs next, it just cannot claim it
      // preempted anything.
      if (entry.messageId === successorId && !this._lastTerminalWasUserInterrupt(conversationId)) {
        this._emitConversationEvent(conversationId, { type: "message_interrupt_fallback", messageId: entry.messageId });
      }

      const runId = newRunId();
      const claimed = { ...entry, state: QUEUE_ENTRY_STATES.DISPATCHING, claimedByRunId: runId };
      this._replaceQueueEntry(conversationId, entry.messageId, claimed);
      this._emitConversationEvent(conversationId, { type: "message_claimed", messageId: entry.messageId, runId });

      let run;
      try {
        run = this.startRun(conversationId, { tabScope: submission.tabScope || "any", runId });
      } catch (err) {
        // Defensive: the drain checks for an active run immediately before this
        // call, so a refusal here means something claimed the conversation
        // between the two — revert the entry to pending (it must not stay
        // `dispatching` with no run) and let the next terminal drain try again.
        this._requeueEntry(conversationId, entry.messageId, runId, "run_claim_failed");
        return null;
      }
      return { run, entry: claimed, submission };
    }
    return null;
  }

  /**
   * R3's consumption half, called by the companion once a claimed run's
   * begin() succeeded (the lease was granted and the run actually started):
   * append `message_consumed` and drop the entry. Idempotent and safe to call
   * for a run that was never claimed by a message (an ordinary send), in
   * which case it does nothing.
   *
   * @returns {boolean} whether an entry was consumed
   */
  consumeMessageForRun(conversationId, runId) {
    const entry = this._claimedEntryForRun(conversationId, runId);
    if (!entry) return false;
    this._dropQueueEntry(conversationId, entry.messageId);
    this._emitConversationEvent(conversationId, { type: "message_consumed", messageId: entry.messageId, runId });
    return true;
  }

  /**
   * R3's rollback half: a claimed run whose begin() returned false was
   * stopped while it waited for the lease, so nothing ever ran and the
   * message must return to `pending` — never lost, never left `dispatching`.
   * The successor designation is kept: the operator's run-now intent survives
   * the stop, and the message is claimed first once the drain re-arms.
   */
  requeueMessageForRun(conversationId, runId, reason) {
    const entry = this._claimedEntryForRun(conversationId, runId);
    if (!entry) return false;
    this._requeueEntry(conversationId, entry.messageId, runId, reason);
    return true;
  }

  /** The live entry a given run claimed, if any (state `dispatching`). */
  _claimedEntryForRun(conversationId, runId) {
    if (!runId) return null;
    return (
      this.queueEntries(conversationId).find(
        (entry) => entry.state === QUEUE_ENTRY_STATES.DISPATCHING && entry.claimedByRunId === runId
      ) || null
    );
  }

  /**
   * Cancel one still-pending message (spec: "Cancel a pending message").
   * Once a turn has claimed it the request is REFUSED with the claimed state
   * disclosed — the run's own Stop is the control at that point, and pretending
   * otherwise would promise a cancellation the claim already made impossible.
   *
   * @returns {{ok: true, messageId: number}
   *          | {ok: false, reason: string, state?: string}}
   */
  cancelQueuedMessage(conversationId, messageId) {
    if (this._deletedConversations.has(conversationId)) return { ok: false, reason: "conversation_deleted" };
    const meta = this.store.loadMeta(conversationId);
    if (!meta) return { ok: false, reason: "unknown_message" };
    const entry = this.queueEntries(conversationId).find((candidate) => candidate.messageId === messageId);
    if (entry) {
      if (entry.state !== QUEUE_ENTRY_STATES.PENDING) {
        return { ok: false, reason: "already_claimed", state: entry.state };
      }
      this._dropQueueEntry(conversationId, messageId);
      this._emitConversationEvent(conversationId, { type: "message_cancelled", messageId, reason: "user_cancel" });
      return { ok: true, messageId };
    }
    // No live entry. Between a claim and its consumption the entry is still in
    // the queue, but after a successful `begin()` it is gone — so a cancel
    // that raced the claim would otherwise be told "unknown_message", which is
    // false and invites the operator to believe nothing ever ran. The log
    // decides: a claimed message is refused with its real lifecycle state.
    const events = this.store.allEvents(conversationId);
    const claimed = events.some((e) => e.type === "message_claimed" && e.messageId === messageId);
    if (claimed) {
      const consumed = events.some((e) => e.type === "message_consumed" && e.messageId === messageId);
      return { ok: false, reason: "already_claimed", state: consumed ? "consumed" : QUEUE_ENTRY_STATES.DISPATCHING };
    }
    return { ok: false, reason: "unknown_message" };
  }

  /**
   * Clear the durable pause flag. Returns whether it actually changed, so the
   * caller can decide whether a `message_queue_resumed` event is warranted —
   * the event records an operator-visible transition, not a routine no-op.
   */
  clearQueuePause(conversationId, reason) {
    if (this._deletedConversations.has(conversationId)) return false;
    const meta = this.store.loadMeta(conversationId);
    if (!meta || !meta.queuePaused) return false;
    this.store.updateMeta(conversationId, { queuePaused: false });
    this._emitConversationEvent(conversationId, { type: "message_queue_resumed", reason });
    return true;
  }

  /**
   * R2's interrupt, in one place: designate `messageId` as the successor and
   * try to preempt the active run through the EXISTING stop path. There is no
   * second cancellation primitive — `stopRun` is the same call the wire STOP
   * and the delete paths use, so blocking further dispatch, invalidating
   * outstanding decisions and releasing the lease all come along unchanged.
   *
   * @returns {"no_active_run"|"interrupted"|"not_cancellable"} what actually
   *   happened, for the caller's reply/telemetry. "not_cancellable" is the
   *   honest failure the panel must disclose: the run reached a terminal
   *   state before the stop could take effect, so the message stays an
   *   ordinary queued turn (no jump) and carries the fallback note.
   */
  interruptWithSuccessor(conversationId, messageId) {
    if (!this.hasActiveRun(conversationId)) return "no_active_run";
    if (!this.store.loadMeta(conversationId)) return "no_active_run";
    this.store.updateMeta(conversationId, { successorMessageId: messageId });
    // The successor is already designated when this runs, so the drain it
    // triggers claims the interrupt's message first (R3's claim order).
    const stopped = this.stopRun(conversationId, "user_interrupt");
    if (stopped) return "interrupted";
    // Nothing was preempted, so nothing may be claimed as preempted: drop the
    // designation and record the fallback on the message itself (R6). The
    // message still runs next — it just does so as an ordinary queued turn.
    this.store.updateMeta(conversationId, { successorMessageId: null });
    this._emitConversationEvent(conversationId, { type: "message_interrupt_fallback", messageId });
    return "not_cancellable";
  }

  /** Public drain trigger for the two explicit callers (a submission that
   * found queued work, and the resume action). All the decisions live in
   * `_maybeDrainQueue`'s preconditions. */
  drainQueue(conversationId) {
    this._maybeDrainQueue(conversationId);
  }

  /**
   * The explicit resume action (`resume_queue`): clear the pause and drain in
   * submission order. Also the operator's escape hatch if a drain was ever
   * missed — the precondition checks in `_maybeDrainQueue()` make a resume
   * with nothing to do a harmless no-op.
   *
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  resumeQueue(conversationId) {
    if (this._deletedConversations.has(conversationId)) return { ok: false, reason: "conversation_deleted" };
    if (!this.store.loadMeta(conversationId)) return { ok: false, reason: "unknown_conversation" };
    this.clearQueuePause(conversationId, "resume");
    this._maybeDrainQueue(conversationId);
    return { ok: true };
  }

  /** Pause the drain because the operator stopped the run that was active. A
   * `dispatching` entry counts as something to pause: it is about to return to
   * `pending` (R3's rollback), and re-starting it the instant the operator
   * pressed Stop would re-enter exactly the state they just interrupted. */
  _pauseQueue(conversationId, reason) {
    const meta = this.store.loadMeta(conversationId);
    if (!meta || meta.queuePaused) return;
    if (this.queueEntries(conversationId).length === 0) return;
    this.store.updateMeta(conversationId, { queuePaused: true });
    this._emitConversationEvent(conversationId, { type: "message_queue_paused", reason });
  }

  /**
   * R4's single trigger point. Every terminal path in this class calls it,
   * and the checks below are exactly the reasons NOT to drain: no callback
   * wired, a drain already running for this conversation, a deleted
   * conversation, a paused queue, a run that is still active, or nothing left
   * to claim. The actual starting of a turn is delegated to `onQueueDrain`
   * (see its field comment); a callback failure must never break run
   * bookkeeping, so it is contained here.
   */
  _maybeDrainQueue(conversationId) {
    if (this._deletedConversations.has(conversationId)) return;
    if (this._drainsInFlight.has(conversationId)) return;
    if (!this.onQueueDrain) return;
    const meta = this.store.loadMeta(conversationId);
    if (!meta || meta.queuePaused) return;
    if (this.hasActiveRun(conversationId)) return;
    if (this.pendingQueueEntries(conversationId).length === 0) return;
    this._drainsInFlight.add(conversationId);
    try {
      this.onQueueDrain(conversationId);
    } catch {
      // see the method comment: queue state stays exactly as the last durable
      // transition left it, and the resume action is still available.
    } finally {
      this._drainsInFlight.delete(conversationId);
    }
  }

  /** Replace one live entry in place (by messageId), leaving the rest — and
   * the successor designation — untouched. */
  _replaceQueueEntry(conversationId, messageId, next) {
    const queue = this.queueEntries(conversationId).map((entry) => (entry.messageId === messageId ? next : entry));
    this.store.updateMeta(conversationId, { messageQueue: queue });
  }

  /** Remove one entry, clearing the successor designation when the removed
   * message was the designated one (a cancelled/consumed successor must not
   * leave meta pointing at an id no longer in the queue). */
  _dropQueueEntry(conversationId, messageId) {
    const meta = this.store.loadMeta(conversationId);
    const queue = this.queueEntries(conversationId).filter((entry) => entry.messageId !== messageId);
    this.store.updateMeta(conversationId, {
      messageQueue: queue,
      ...(meta && meta.successorMessageId === messageId ? { successorMessageId: null } : {})
    });
  }

  /** R3's rollback: entry back to `pending`, `message_requeued` appended. */
  _requeueEntry(conversationId, messageId, runId, reason) {
    const entry = this.queueEntries(conversationId).find((candidate) => candidate.messageId === messageId);
    if (!entry) return;
    this._replaceQueueEntry(conversationId, messageId, {
      ...entry,
      state: QUEUE_ENTRY_STATES.PENDING,
      claimedByRunId: null
    });
    this._emitConversationEvent(conversationId, { type: "message_requeued", messageId, reason });
  }

  /** Did this conversation's most recent run terminal record an operator
   * interrupt? Read from the durable log, never from memory: the answer must
   * survive the crash that makes the question worth asking (R6). */
  _lastTerminalWasUserInterrupt(conversationId) {
    const terminals = this.store
      .allEvents(conversationId)
      .filter(
        (e) =>
          e.type === "run_done" ||
          e.type === "run_stopped" ||
          e.type === "run_error" ||
          e.type === "run_interrupted_by_restart"
      );
    if (terminals.length === 0) return false;
    const last = terminals[terminals.length - 1];
    return last.type === "run_stopped" && last.reason === "user_interrupt";
  }

  /**
   * R8's recovery reconciliation, run from both sites that repair a
   * conversation's interrupted state (recoverAfterRestart at companion
   * startup, and resumeConversation's snapshot repair). For every entry left
   * `dispatching` by a previous process:
   *
   *   - the log has `run_started` for its `claimedByRunId` → the run really
   *     did start and is now interrupted: append `message_consumed` if it is
   *     missing (so state and events never disagree) and drop the entry. The
   *     message is NEVER replayed — "no automatic replay after dispatch" is
   *     untouched by this change.
   *   - the log has no `run_started` for it (including an unknown run id) →
   *     nothing ran, so replay is safe and correct: back to `pending` with a
   *     `message_requeued` naming the reason.
   *
   * `queuePaused` is deliberately NOT touched here: it persists across a
   * restart, and nothing in this method drains (design.md decision 5 / R8 —
   * no auto-drain at boot).
   *
   * @returns {boolean} whether anything was reconciled
   */
  _reconcileMessageQueue(conversationId) {
    const meta = this.store.loadMeta(conversationId);
    if (!meta) return false;
    const queue = this.queueEntries(conversationId);
    const dispatching = queue.filter((entry) => entry.state === QUEUE_ENTRY_STATES.DISPATCHING);
    if (dispatching.length === 0) return false;

    // One log read for the whole pass: the events this decides from are the
    // complete log's, not a bounded window's (see allEvents()).
    const events = this.store.allEvents(conversationId);
    const runStarted = new Set(events.filter((e) => e.type === "run_started").map((e) => e.runId));
    const consumed = new Set(
      events.filter((e) => e.type === "message_consumed").map((e) => e.messageId)
    );

    let nextQueue = queue;
    let successorMessageId = meta.successorMessageId ?? null;
    for (const entry of dispatching) {
      if (entry.claimedByRunId && runStarted.has(entry.claimedByRunId)) {
        if (!consumed.has(entry.messageId)) {
          this._emitConversationEvent(conversationId, {
            type: "message_consumed",
            messageId: entry.messageId,
            runId: entry.claimedByRunId
          });
        }
      } else {
        this._emitConversationEvent(conversationId, {
          type: "message_requeued",
          messageId: entry.messageId,
          reason: "restart_before_start"
        });
        nextQueue = nextQueue.map((candidate) =>
          candidate.messageId === entry.messageId
            ? { ...candidate, state: QUEUE_ENTRY_STATES.PENDING, claimedByRunId: null }
            : candidate
        );
      }
    }
    const survivingIds = new Set(
      nextQueue.filter((entry) => entry.state === QUEUE_ENTRY_STATES.PENDING).map((entry) => entry.messageId)
    );
    if (successorMessageId != null && !survivingIds.has(successorMessageId)) successorMessageId = null;
    const finalQueue = nextQueue.filter((entry) => entry.state === QUEUE_ENTRY_STATES.PENDING);
    this.store.updateMeta(conversationId, { messageQueue: finalQueue, successorMessageId });
    return true;
  }

  /**
   * Cancel every live message of a conversation being deleted.
   *
   * Called BEFORE the delete tombstone is set, on purpose: this is the one
   * write that must happen while the conversation still exists, because after
   * the tombstone every write path here is (correctly) a silent no-op and the
   * log is about to be removed anyway. "No run starts into a deleted
   * conversation" then follows from the tombstone plus the drain's own
   * tombstone check — nothing here has to outlive the directory.
   */
  _cancelAllQueuedMessages(conversationId, reason) {
    const meta = this.store.loadMeta(conversationId);
    if (!meta) return;
    const queue = this.queueEntries(conversationId);
    if (queue.length === 0) return;
    const remaining = [];
    for (const entry of queue) {
      if (entry.state !== QUEUE_ENTRY_STATES.PENDING) {
        remaining.push(entry);
        continue;
      }
      this._emitConversationEvent(conversationId, { type: "message_cancelled", messageId: entry.messageId, reason });
    }
    this.store.updateMeta(conversationId, { messageQueue: remaining, successorMessageId: null, queuePaused: false });
  }

  /**
   * Explicit local deletion (spec 5.3: "explicit local history deletion"),
   * closing reports/05-panel-evidence.md's "No DELETE_CONVERSATION message
   * type" gap. Removes only this app's own conversation data and SDK
   * artifacts (host/agent/storage/transcript-store.js's deleteConversation:
   * "Recordings live in a separate tree ... and are untouched" — design.md
   * section 5's separate retention for recorded demonstrations holds).
   *
   * Tasks.md 2.3 also names "SDK mapping, ledger, recording claims, and
   * conversation-owned artifacts" as things deletion must remove. Concretely,
   * today:
   *   - SDK mapping (`sdkSessionRef`) lives inside this SAME conversation's
   *     `conversationMetadata`, and the SDK's own on-disk session storage
   *     lives under `skills.configDir` (= `${conversationDir}/claude-config`)
   *     — both are inside the directory this method removes, so no separate
   *     step is needed.
   *   - "Ledger" is this manager's own `usageLedger` per-conversation file
   *     (tasks.md 5.3/5.4: `usage/<conversationId>.json`) — removed here via
   *     `deleteForConversation()`, alongside the directory, so no usage row
   *     survives its conversation.
   *   - "Recording claims": `PendingRecordingsStore` is companion-wide, not
   *     conversation-owned, and only ever holds a recording BEFORE any
   *     conversation has claimed it — once attached, a recording becomes a
   *     `recording_complete`/`recording_attachment` transcript event, which
   *     lives inside (and is removed with) this same directory. The durable
   *     claim records in `RecordingAttachmentsStore` ARE conversation-owned,
   *     so they are swept here via `deleteForConversation()`; unclaimed
   *     pending references are intentionally untouched (they belong to no
   *     conversation).
   *   - "Conversation-owned artifacts" (screenshots, user attachments) live
   *     under `conversationArtifactsDir(conversationId)`, itself inside
   *     `conversationDir(conversationId)` — removed by the same rmSync.
   *
   * "Handled explicitly, not left racy" for an active run (tasks.md 2.3:
   * "Deletion marks a tombstone before aborting"): this conversationId is
   * tombstoned (this._deletedConversations) FIRST, before the run is
   * stopped (aborting the SDK call and invalidating its approvals) or
   * anything on disk is removed — so any event the aborting run's query()
   * loop still emits asynchronously afterward (including a late
   * claimSdkSessionRef()/markSdkSessionRefStatus() call) is dropped rather
   * than resurrecting the just-deleted directory. See the field's own
   * header comment and the guards in startRun/finishRun/setSkillsBinding/
   * claimSdkSessionRef/markSdkSessionRefStatus above.
   *
   * The on-disk removal itself is best-effort (try/catch): a still-open
   * file handle from the aborting SDK subprocess can make the underlying
   * rmSync throw despite `force: true` (observed on Windows) — the
   * tombstone above, not this rmSync succeeding, is what actually commits
   * "this conversation no longer exists" for every future read in THIS
   * process (hasConversation/loadMeta consult the tombstone-guarded store,
   * and every write path is guarded the same way). finishRun()'s own
   * late-unwind sweep retries this exact removal once the aborting run has
   * genuinely finished, closing the window without resurrecting anything.
   *
   * @returns {{ hadActiveRun: boolean, onDiskRemoved: boolean }}
   */
  deleteConversation(conversationId) {
    // The messages queued for this conversation are cancelled WITH it (R5,
    // "Conversation deleted with messages pending"): no pending message may
    // start a run into a conversation that is going away. This is the one
    // queue write that happens BEFORE the tombstone, deliberately — see
    // _cancelAllQueuedMessages()'s own comment. Nothing after the tombstone
    // can write at all.
    this._cancelAllQueuedMessages(conversationId, "conversation_deleted");
    this._deletedConversations.add(conversationId);
    const hadActiveRun = this.hasActiveRun(conversationId);
    this.stopRun(conversationId, "conversation_deleted");
    this._activeRuns.delete(conversationId);
    this._actionEventCursors.delete(conversationId);
    this._actionEventCursorsSeeded.delete(conversationId);
    // Conversation-owned P1 state goes with it (see the method docstring):
    // the usage ledger file and every durable recording-attachment claim.
    try {
      this.usageLedger.deleteForConversation(conversationId);
    } catch {
      // best-effort — the tombstone above already commits the delete
    }
    try {
      this.recordingAttachments.deleteForConversation(conversationId);
    } catch {
      // best-effort — see above
    }
    let onDiskRemoved = false;
    try {
      const result = this.store.deleteConversation(conversationId);
      onDiskRemoved = !result || result.removed !== false;
    } catch {
      // A still-open handle from the aborting SDK subprocess can defeat the
      // rmSync on Windows (see the docstring); finishRun()'s late-unwind
      // sweep retries it. Reported, never hidden: the caller must be able to
      // say "the host no longer serves this conversation, but its bytes are
      // not gone yet".
      onDiskRemoved = false;
    }
    return { hadActiveRun, onDiskRemoved };
  }

  /**
   * Delete-all (tasks.md 1.3): tombstone + stop + sweep every
   * conversation-owned side record for every conversation, then remove the
   * on-disk tree. A partial sweep is reported, never rounded up to success —
   * the panel may only clear its local cache for a delete-all the host
   * actually completed.
   *
   * @returns {{ removed: string[], failed: Array<{conversationId: string, reason: string}>, hadActiveRuns: number }}
   */
  deleteAllConversations() {
    const ids = this.store.listConversations().map((meta) => meta.conversationId);
    let hadActiveRuns = 0;
    for (const conversationId of ids) {
      this._cancelAllQueuedMessages(conversationId, "conversation_deleted"); // see deleteConversation()'s comment
      this._deletedConversations.add(conversationId);
      if (this.hasActiveRun(conversationId)) hadActiveRuns += 1;
      this.stopRun(conversationId, "conversation_deleted");
      this._activeRuns.delete(conversationId);
      this._actionEventCursors.delete(conversationId);
      this._actionEventCursorsSeeded.delete(conversationId);
      try {
        this.usageLedger.deleteForConversation(conversationId);
      } catch {
        // best-effort — the tombstone above already commits the delete
      }
      try {
        this.recordingAttachments.deleteForConversation(conversationId);
      } catch {
        // best-effort — see above
      }
    }
    const { removed, failed } = this.store.deleteAllConversations();
    return { removed, failed, hadActiveRuns };
  }

  /**
   * The conversation a just-finished narrated recording should be attached
   * to live, or null when none is unambiguously "active" (task 6.3 / spec:
   * "Recording finishes without an open conversation"). Priority:
   *   1. Whichever conversation's run currently holds the shared browser
   *      lease — it is the one actually driving the SAME browser bridge the
   *      recording was just captured through, so it is the least ambiguous
   *      target when it exists.
   *   2. If nothing holds the lease (e.g. between actions) but exactly one
   *      conversation has an active run (queued or running), that one.
   *   3. Otherwise (nothing active, or more than one candidate with no
   *      lease holder to disambiguate them) — null, meaning "no SDK run is
   *      active" per the spec scenario, so the caller persists it instead.
   */
  activeConversationIdForRecording() {
    const holder = this.lease.currentHolder();
    if (holder && holder.conversationId && this.hasActiveRun(holder.conversationId)) {
      return holder.conversationId;
    }
    const activeIds = [];
    for (const [conversationId, run] of this._activeRuns) {
      if (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING) activeIds.push(conversationId);
    }
    return activeIds.length === 1 ? activeIds[0] : null;
  }

  /**
   * Route one finished narrated recording (task 6.3): append it to the
   * active conversation's transcript when one exists, else persist it for
   * later attachment. Idempotent by recordingId in both branches, so a
   * re-delivered event (companion restart, extension retry) never appends
   * or lists the same recording twice — a reconnecting panel resyncing via
   * its normal afterSeq cursor therefore never sees a duplicate either.
   *
   * Tasks.md 6.3 reconciliation order: an OPEN attachment claim for this
   * recording (a panel-selected idle conversation, recorded durably in
   * recording-attachments.js) wins over active-run routing — completion with
   * no active run reconciles to the SELECTED owner rather than an arbitrary
   * run, and even when a run IS active a prior explicit selection is still
   * the least ambiguous target. Only when no open claim exists does the
   * lease/active-run heuristic below apply.
   *
   * @returns {string|null} the conversationId it was attached to, or null
   *   when it was persisted to the pending list instead.
   */
  recordRecordingComplete(recording) {
    const recordingId = recording && recording.recordingId;
    const openClaim = recordingId ? this.recordingAttachments.findOpenClaimForRecording(String(recordingId)) : null;
    if (openClaim && this.store.loadMeta(openClaim.conversationId) && !this._deletedConversations.has(openClaim.conversationId)) {
      this._appendRecordingToConversation(openClaim.conversationId, recording);
      return openClaim.conversationId;
    }
    const conversationId = this.activeConversationIdForRecording();
    if (!conversationId) {
      this.pendingRecordings.add(recording);
      return null;
    }
    this._appendRecordingToConversation(conversationId, recording);
    return conversationId;
  }

  /** Idempotent transcript append shared by both routing branches above. */
  _appendRecordingToConversation(conversationId, recording) {
    const alreadyRecorded = this.store
      .eventsAfter(conversationId, 0)
      .some((e) => e.type === "recording_complete" && e.recordingId === recording.recordingId);
    if (!alreadyRecorded) {
      this.store.appendEvent(conversationId, { type: "recording_complete", ...recording });
    }
  }

  /** Every recording still waiting for a conversation to claim it. */
  listPendingRecordings() {
    return this.pendingRecordings.list();
  }

  /**
   * Task 2.4 durable half: append background.js's chrome.downloads pause
   * decision to this conversation's transcript, exactly like every other
   * durable, non-live-streamed fact this module records (mirrors
   * _appendRecordingToConversation's idempotent-append shape above). The
   * decision itself was made entirely LOCALLY by the extension/panel — this
   * call happens AFTER the download was already resumed/cancelled, so its
   * only job is making that outcome as durable as every other protected
   * decision's outcome already is.
   *
   * Idempotent on requestId so a retried/duplicate send never double-records
   * the same decision. Returns false (and records nothing) for an unknown or
   * already-deleted conversation, exactly like `recordActionEvents`'s own
   * caller-side `hasConversation` guard in companion.js.
   */
  recordDownloadDecision(conversationId, record) {
    if (!this.store.loadMeta(conversationId) || this._deletedConversations.has(conversationId)) return false;
    const alreadyRecorded = this.store
      .eventsAfter(conversationId, 0)
      .some((e) => e.type === "download_decision_recorded" && e.requestId === record.requestId);
    if (!alreadyRecorded) {
      this.store.appendEvent(conversationId, { type: "download_decision_recorded", ...record });
    }
    return true;
  }

  /**
   * Persist a batch of raw wire action-timeline events (task 5.10's host
   * half; design.md decision 5c) into this conversation's own transcript,
   * as `{type: "action_event", event}` entries — reusing the SAME durable,
   * sequenced per-conversation log (and its existing snapshot/afterSeq
   * resync machinery) every other session-level fact already goes through,
   * rather than inventing a second storage/resync mechanism. Every event is
   * independently validated + allowlist-copied by sanitizeActionEvent()
   * (storage/action-timeline.js) before it can reach disk — a malformed or
   * disallowed event is rejected, never partially stored. A per-conversation
   * PerStreamSeqTracker (lazily seeded from this conversation's OWN already-
   * persisted action_event history the first time it is touched by this
   * process) rejects anything at or below a stream's highest accepted `seq`,
   * so a redelivered/replayed batch — a retried native message, a companion
   * restart racing an in-flight send — can never create a duplicate row,
   * even across a restart.
   *
   * @param {string} conversationId
   * @param {Array<object>} rawEvents
   * @returns {{stored: number, rejected: number, duplicate: number}}
   * @throws if conversationId is unknown
   */
  recordActionEvents(conversationId, rawEvents) {
    if (!this.store.loadMeta(conversationId)) throw new Error(`unknown conversation: ${conversationId}`);

    let tracker = this._actionEventCursors.get(conversationId);
    if (!tracker) {
      tracker = new PerStreamSeqTracker();
      this._actionEventCursors.set(conversationId, tracker);
    }
    if (!this._actionEventCursorsSeeded.has(conversationId)) {
      // Reconstruct "highest seq already stored per stream" from this
      // conversation's own persisted log. eventsAfter(id, 0) returns the
      // most-recent slice when the log exceeds its snapshot cap — since
      // seq is strictly increasing at append time, the most-recent slice
      // still contains every stream's true current maximum.
      for (const stored of this.store.eventsAfter(conversationId, 0)) {
        const ev = stored && stored.type === "action_event" ? stored.event : null;
        if (ev && typeof ev.streamKey === "string" && Number.isInteger(ev.seq)) {
          tracker.seed(ev.streamKey, ev.seq);
        }
      }
      this._actionEventCursorsSeeded.add(conversationId);
    }

    let stored = 0;
    let rejected = 0;
    let duplicate = 0;
    for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
      const result = sanitizeActionEvent(raw);
      if (!result.ok) {
        rejected++;
        continue;
      }
      const { event } = result;
      if (!tracker.accept(event.streamKey, event.seq)) {
        duplicate++;
        continue;
      }
      if (this._deletedConversations.has(conversationId)) continue; // see this._deletedConversations' header comment
      this.store.appendEvent(conversationId, { type: "action_event", event });
      stored++;
    }
    return { stored, rejected, duplicate };
  }

  /**
   * Companion restart recovery: mark every conversation that has an
   * unresolved activeRunId (the process died before finishRun/stopRun ever
   * ran) as interrupted. Idempotent; safe to call once at companion startup
   * before any conversation is resumed interactively.
   */
  recoverAfterRestart() {
    const recovered = [];
    for (const meta of this.store.listConversations()) {
      if (meta.activeRunId) {
        this.store.updateMeta(meta.conversationId, { activeRunId: null, interrupted: true });
        this.store.appendEvent(meta.conversationId, {
          type: "run_interrupted_by_restart",
          runId: meta.activeRunId
        });
        recovered.push(meta.conversationId);
      }
      // R8's reconciliation, at the site that repairs a conversation whose
      // process died: a message left `dispatching` by that process is either
      // returned to `pending` (its run never emitted run_started — nothing
      // ran, replay is safe) or recorded as consumed by the interrupted run
      // (it did start; it is NEVER replayed). Runs after the active-runId
      // repair above so `run_interrupted_by_restart` is already in the log
      // when the claim-time interrupt check reads it.
      this._reconcileMessageQueue(meta.conversationId);
    }
    return recovered;
  }
}

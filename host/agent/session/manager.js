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
import { PendingRecordingsStore } from "../storage/pending-recordings.js";
import { UsageLedger } from "../storage/usage-ledger.js";
import { RecordingAttachmentsStore, RECORDING_ATTACHMENT_STATES } from "../storage/recording-attachments.js";
import { sanitizeActionEvent, PerStreamSeqTracker } from "../storage/action-timeline.js";
import { migrateConversationMetadata, buildSdkSessionRef, SDK_SESSION_REF_STATUS, validateBudgetPolicy } from "../storage/conversation-metadata.js";

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

  listConversations() {
    return this.store.listConversations();
  }

  /**
   * Wire-facing summaries for the LIST_CONVERSATIONS protocol message (see
   * host/agent/companion.js's _handleListConversations()). Every field the
   * panel's history screen needs to render and reopen a conversation,
   * including the interrupted flag that survives a companion restart
   * (resumeConversation()/recoverAfterRestart() below) and whether THIS
   * process currently has that conversation's run actively queued or
   * running — in-memory, per-process, which is exactly right: after a
   * restart recoverAfterRestart() already clears any stale activeRunId and
   * sets interrupted instead of leaving a ghost "active" conversation for a
   * process that no longer exists.
   *
   * @returns {Array<{conversationId:string, createdAt:number, updatedAt:number, interrupted:boolean, hasActiveRun:boolean}>}
   */
  conversationSummaries() {
    return this.store.listConversations().map((meta) => ({
      conversationId: meta.conversationId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      interrupted: Boolean(meta.interrupted),
      hasActiveRun: this.hasActiveRun(meta.conversationId)
    }));
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
    return this.store.snapshot(conversationId, afterSeq);
  }

  snapshotSince(conversationId, afterSeq = 0) {
    return this.store.snapshot(conversationId, afterSeq);
  }

  hasActiveRun(conversationId) {
    const run = this._activeRuns.get(conversationId);
    return !!run && (run.state === RUN_STATES.QUEUED || run.state === RUN_STATES.RUNNING);
  }

  activeRun(conversationId) {
    return this._activeRuns.get(conversationId) || null;
  }

  /**
   * @throws if the conversation already has an active run (spec: "prevent
   *   more than one active run per conversation").
   */
  startRun(conversationId, { tabScope = "any" } = {}) {
    if (!this.store.loadMeta(conversationId)) throw new Error(`unknown conversation: ${conversationId}`);
    if (this.hasActiveRun(conversationId)) {
      throw new Error(`conversation ${conversationId} already has an active run`);
    }
    const run = new Run({
      conversationId,
      lease: this.lease,
      approvals: this.approvals,
      tabScope,
      releaseNativeLease: this.releaseNativeLease,
      // Guarded against the explicit-delete race documented on
      // this._deletedConversations above: an event emitted after this
      // conversation was deleted (e.g. the SDK query() generator's `finally`
      // unwinding asynchronously, after abortController.abort() but before
      // deleteConversation() returned) is dropped rather than resurrecting
      // the just-removed on-disk directory.
      onEvent: (event) => {
        if (this._deletedConversations.has(conversationId)) return;
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

  stopRun(conversationId, reason = "user_stop") {
    const run = this._activeRuns.get(conversationId);
    if (!run) return false;
    if (run.state === RUN_STATES.STOPPED || run.state === RUN_STATES.DONE) return false;
    run.stop(reason);
    if (!this._deletedConversations.has(conversationId)) {
      this.store.updateMeta(conversationId, { activeRunId: null });
    }
    return true;
  }

  finishRun(conversationId) {
    const run = this._activeRuns.get(conversationId);
    if (run) run.markDone();
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
   * @returns {{ hadActiveRun: boolean }}
   */
  deleteConversation(conversationId) {
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
    try {
      this.store.deleteConversation(conversationId);
    } catch {
      // best-effort — see comment above; finishRun()'s late-unwind sweep retries
    }
    return { hadActiveRun };
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
    }
    return recovered;
  }
}

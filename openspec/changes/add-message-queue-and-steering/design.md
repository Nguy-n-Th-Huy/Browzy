## Context

See proposal.md — Why for motivation. Current state this design builds on (all anchors verified by reading):

- One active run per conversation is enforced at admission: `startRun()` throws (`host/agent/session/manager.js:230-237`); a run starts `QUEUED` behind the shared browser lease (`host/agent/session/run.js:14-47`) and stopped-while-queued releases immediately (`run.js:71-77`).
- Run creation already persists its identity: `updateMeta({activeRunId, interrupted:false})` plus a `run_created` event (`manager.js:265-267`); stop clears it (`manager.js:582-584`, `:614`).
- Restart recovery exists and runs before any conversation is resumed: unresolved `activeRunId` → `{activeRunId:null, interrupted:true}` + `run_interrupted_by_restart` (`manager.js:910-925`), and the same repair fires on snapshot (`manager.js:200-207`).
- Storage: one append-only sequenced event log plus a small atomically rewritten `meta.json` per conversation (`host/agent/storage/transcript-store.js:1-15`) — "reopen a persisted conversation" is already derived from these, not memory.
- Queueing one layer up already exists and must not be duplicated: conversations queue behind the lease, `run_queued`/`run_started` flow through the transcript, and the panel renders a `QUEUED` phase (`Đang chờ lượt`, `extension/sidepanel/run-states.js`).
- Send idempotency exists (`idempotencyKey` replay semantics, `host/agent/companion.js:937-941`; panel-side key minting `panel-controller.js` `_newIdempotencyKey`).
- Panel restore machinery for in-flight state exists: sequenced-event snapshot + pending-decision restore (panel spec "Pending decision restored on reconnect"), and the panel already requires that a submitted message appears immediately (panel spec "Ready conversation").

## Goals / Non-Goals

**Goals:**

- A message submitted during a run is never lost and never blocks the composer: accepted, ordered, observable, cancellable-until-claimed, and durable across reload and restart.
- Interrupt ("run now") is honest: it reuses the existing stop path, is best-effort by construction, and discloses the fallback instead of pretending.
- Queue state is reconstructible from durable storage alone — no panel presence required for drain, no in-memory state on the critical path.

**Non-Goals:**

- No change to lease-level queueing between conversations, to `stop()`'s meaning for an active run, or to the approval gate.
- No absorption of a message into the active run (one message = one future turn; simpler than browser-use's mid-run injection, and matches this runtime's turn model).
- No scheduling, cron, run-internal tool steering, or multi-operator semantics.
- The composer's enhancement control keeps its existing availability rule (disabled while a run is queued/streaming/stopping/waiting) — explicitly unchanged.

## Decisions

1. **The queue is host-owned state in `meta.json`: a bounded `messageQueue` array of live entries, with message text staying in the event log.** Each entry holds `{messageId (event seq), mode: queue|interrupt, state: pending|dispatching, claimedByRunId, enqueuedAt}`; consumed/cancelled entries leave the array and live on as events. Bounded by the queue limit, so the meta document stays small, and it inherits the atomic write-then-rename guarantee (`transcript-store.js`). Alternatives rejected: a separate `queue.json` (a second atomic file buys nothing the meta rewrite does not already give), panel-side queue (dies on reload; contradicts the panel spec's authoritative-host-state rule), deriving current state by folding the whole log at read time (races with live claims for no benefit).

2. **Claim is a two-phase durable transition, decided by events on recovery.** Drain picks message M: (a) write `meta.messageQueue` with M → `dispatching`, `claimedByRunId = R` where R is a **pre-generated run id**, and append `message_claimed`; (b) create the run with that id (existing `startRun` path: `activeRunId = R`, `run_created`); (c) when the run actually starts executing (`run.begin` after the lease is granted), append `message_consumed` and drop M from the array. Recovery reconciliation, folded into the existing restart-recovery pass (`manager.js:910-925`, `:200-207`):
   - dispatching M whose claimed run never emitted `run_started` (claimed-but-never-started, including "run id unknown") → M returns to `pending`, `message_requeued` appended. Nothing ran; replay is safe and correct.
   - dispatching M whose run was interrupted after `run_started` → M follows the run's interruption outcome; it is never automatically replayed (consistent with "Recover without duplicate side effects").
   This makes "owned by exactly one turn" decidable from durable records alone, and keeps the pre-existing `run_interrupted_by_restart` path untouched.

3. **Interrupt reuses `stopRun(conversationId, "user_interrupt")` and designates a successor; it never invents a second cancellation primitive.** On interrupt send: record the message as `mode:"interrupt"` and as the designated successor; if a run is active, call `stopRun` (existing semantics: abort generation, block dispatch, invalidate approvals via `run.js:131-134`, emit `run_stopped`, release the lease). When the run settles, the successor is claimed first; remaining pending messages keep FIFO order after it. Fallback disclosure rule: if `stopRun` reported no active run, or the run reached a terminal state other than stopped before the cancellation took effect, the message proceeds as an ordinary next turn and the panel shows the fallback note — never a claimed interrupt. Alternatives rejected: a bespoke "cancel for steering" path (would bifurcate stop semantics and risk the honest-cancellation guarantees), silent fallback (dishonest).

4. **Drain has one trigger point plus two explicit ones.** A single post-terminal hook (covering `run_done`, `run_stopped`, `run_error`, interrupted-by-restart reconciliation, and delete) checks: conversation not deleted, not paused, queue non-empty → claim next (successor first). Explicit triggers: the resume action, and any new submission while paused (submission resumes the drain). Drain is serialized per conversation with an in-flight guard; claim transitions are conditional on the message's current state, so double triggers are idempotent. Drain requires no panel connection.

5. **Stop pauses the drain; pause is durable.** `queuePaused` lives in `meta.json`, set when the operator stops an active run with messages pending, cleared by explicit resume or by a new submission. Rationale: an operator who pressed Stop is intervening; auto-starting the next queued turn re-enters the state they just interrupted. Alternative (auto-drain after stop) rejected for that reason; alternative (pause only in memory) rejected because a panel reload would lose the visible paused state.

6. **Bound = 20 pending per conversation**, refused with a distinguishable reason (`QUEUE_FULL`) and no draft loss. One constant in one place; raising it later is not a contract change. Matches browser-use V4's documented queue bound.

7. **Ordering is FIFO by enqueue sequence; interrupt is the only jumper.** A new submission neither jumps the queue nor reorders it; the run-now choice is the explicit way to jump.

8. **Page context binds at submission, not at drain.** The queued message stores the page-context snapshot captured at submit time (existing capture path); the drain creates the turn with that stored binding instead of re-capturing the current tab. This preserves the panel requirement that each submitted message retains its exact page-context identity.

9. **Events, not polling, and one text source.** New events in the transcript family: `message_queued`, `message_claimed`, `message_consumed`, `message_cancelled`, `message_failed`, `message_requeued`. The message text lives only in its original message event; queue events carry ids and states, so no restore path can render text twice.

10. **Approvals are untouched.** Queued turns pass `canUseTool` when they run, under the then-current mode and remembered decisions; queueing never answers a pending decision; interrupt invalidation falls out of the existing stop path (`approvals.invalidateForRun`). No new approval semantics are introduced.

11. **Panel vocabulary split stays clean:** message chips describe the message (`Đang chờ lượt` pending, `Sắp chạy` dispatching/claimed, `Đã hủy` cancelled; fallback note `Chưa dừng kịp — tin nhắn sẽ chạy sau lượt hiện tại`), the header pill keeps describing the run. Copy is reviewable wording, not a contract; it reuses the existing reviewed phrases where they exist.

## Risks / Trade-offs

- [Risk] Claim/drain races (run terminal event vs resume click vs new submission) → Mitigation: single serialized drain with an in-flight guard; claim transitions conditional and idempotent; tests drive all three triggers concurrently.
- [Risk] A run terminal path is missed and a queue stalls with messages visible but never draining → Mitigation: one hook on the manager's terminal handling covering every terminal event (including interruption reconciliation), plus a resume affordance as the operator's escape hatch; tests enumerate the terminal matrix.
- [Risk] Restart reconciliation misclassifies a run that started but whose `run_started` event was not yet flushed → ordering is explicit: claim → run creation → run start; reconciliation treats "no `run_started`" as never-ran only because `run_started` is appended by `run.begin` before any dispatch. The crash matrix in tests pins both branches.
- [Risk] Meta growth if cancelled entries were kept → entries leave the array on terminal states; only live pending/dispatching entries persist, bounded at 20.
- [Risk] Interrupt invalidating a pending decision surprises an operator who only wanted to change course → Accepted: that is exactly Stop's disclosed semantics today; the panel copy for run-now should say the current turn is stopped.
- [Risk] Composer changes accidentally widen the enhancement control's availability → Mitigation: the enhancement gate keeps its own requirement and its own tests; only the send control's enablement changes.

## Edge cases (explicit handling)

- Send while the conversation's run is still lease-queued → normal queue entry; ordering is per conversation, lease wait is orthogonal.
- Interrupt with no active run → ordinary queued submission, no interruption claimed.
- Interrupt while other messages are pending → successor runs first, others keep order after it.
- Stop with messages pending → paused; resume or new submission re-arms.
- Conversation deleted with pending messages → messages cancelled with the conversation (tombstone semantics); no run starts into a deleted conversation.
- Companion restart: pending stays pending; dispatching-without-`run_started` returns to pending; dispatching-after-`run_started` follows the interrupted run. Panels reopen to exact states.
- Panel closed during drain → drain proceeds (host-side); state visible on reopen; no panel dependency.
- Queue full → refusal with reason; composer keeps the draft.
- Duplicate delivery with same idempotency key → resolves to the existing entry.
- A message queued while a decision is outstanding → waits; does not resolve the decision.

## Migration Plan

No data migration: `messageQueue`/`queuePaused` are additive meta fields; absent means empty/unpaused. Rollback: remove the drain trigger and successor designation; queued messages remain ordinary submitted messages in the log and the previous refusal behavior returns. No message data is lost in either direction.

## Open Questions

None blocking. The bound value (20) and the Vietnamese copy are constants set here for review; both are tunable without changing the behavior contract.

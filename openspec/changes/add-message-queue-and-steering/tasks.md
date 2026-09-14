## 1. Queue state and protocol

- [x] 1.1 Extend the conversation meta handling in `host/agent/storage/transcript-store.js` with a bounded live `messageQueue` array (`{messageId, mode, state, claimedByRunId, enqueuedAt}`) and a `queuePaused` flag; add the queue bound as one exported constant (20 per design.md decision 6).
- [x] 1.2 Add the queue events to the transcript family via the existing `appendEvent`: `message_queued`, `message_claimed`, `message_consumed`, `message_cancelled`, `message_failed`, `message_requeued`. Events carry ids and states only — never message text.
- [x] 1.3 Extend `host/agent/protocol.js`: the send message gains `mode: "queue" | "interrupt"`, reuses the existing `idempotencyKey`, and gains a queued-send ack carrying the entry's state plus a `QUEUE_FULL` refusal shape. Wire validation for both.
- [x] 1.4 Extend the existing send idempotency store so a retried send resolves to the same queue entry (key → messageId) and replays the recorded state instead of creating a second entry. ← (verify: retry with the same key yields exactly one entry and the identical ack; a new key creates a new entry)

## 2. Admission while a run is active

- [x] 2.1 In `host/agent/companion.js` + `session/manager.js`: accept a send while the conversation's run is active — append the message event, append `message_queued`, add the pending entry, and return the queued ack — instead of reaching the `startRun` refusal (`manager.js:230-237`).
- [x] 2.2 Enforce the bound before appending anything: at the limit, refuse with `QUEUE_FULL` naming the limit; no entry, no message event.
- [x] 2.3 Store the submission-time page-context snapshot with the queue entry so the drain binds the turn to the original context rather than re-capturing the current tab. ← (verify: a message queued on page A, with a tab switch before its drain, still targets A; a message queued while the run awaits a decision resolves nothing)

## 3. Claim and drain

- [x] 3.1 Implement the two-phase claim (design.md decision 2): pre-generate the run id, write the entry to `dispatching` with `claimedByRunId` plus `message_claimed`, then create the run through the existing `startRun` path with that id.
- [x] 3.2 Mark consumption when the run begins after lease grant (`run.begin`): append `message_consumed` and remove the entry from `messageQueue`. ← (verify: every entry's lifecycle matches its events; no consumed entry survives in meta; no pending entry is missing from it)
- [x] 3.3 Add the single post-terminal drain hook covering `run_done`, `run_stopped`, `run_error` and the interruption-reconciliation path, serialized per conversation with an in-flight guard; claim transitions stay conditional on current entry state so concurrent triggers are idempotent.
- [x] 3.4 Operator control: operator Stop with pending entries sets `queuePaused`; add the `resumeQueue` operation (clears the flag and drains FIFO); any new submission also resumes; conversation delete cancels pending entries via `message_cancelled` under the existing tombstone semantics. ← (verify: stop → no entry starts until resume; resume drains in submission order; deleted conversation leaves no entry and starts no run)

## 4. Interrupt ("run now")

- [x] 4.1 Handle `mode: "interrupt"`: designate the entry as successor; when a run is active call `stopRun(conversationId, "user_interrupt")` (existing stop path — no new cancellation primitive); when idle, behave as an ordinary queued submission.
- [x] 4.2 On settle, claim the successor before any other pending entry; remaining entries keep FIFO order after it.
- [x] 4.3 Fallback honesty: when stop was a no-op or the run terminalized without stopping, record the entry as delivered-as-queued and surface the fallback note; never claim an interrupt that did not happen. ← (verify: the matrix — idle / active-stopped / active-race-finished — yields exactly one honest outcome each, and the stopped case invalidates pending decisions via the stop path)

## 5. Recovery and restore

- [x] 5.1 Extend `recoverAfterRestart()` (`manager.js:910-925`) and the snapshot repair (`manager.js:200-207`): a `dispatching` entry whose run never emitted `run_started` (or whose run id is unknown) returns to `pending` with `message_requeued`; a `dispatching` entry whose run started follows that run's interruption outcome and is never automatically replayed.
- [x] 5.2 Guarantee no auto-drain at boot or reopen: pending entries stay pending until an explicit resume or a new submission.
- [x] 5.3 Include queue state (entries, states, paused flag) in the conversation snapshot payload the panel reads, exactly once per entry. ← (verify: crash matrix A/B — never-started returns to pending and runs once; started-interrupted is not replayed and renders as its interrupted turn; snapshot and events never disagree)

## 6. Panel

- [x] 6.1 `extension/sidepanel/panel-controller.js` + `sidepanel.js`: keep the send control usable while the conversation's run is running, stopping, or waiting for a decision; submitting queues by default; add the run-now choice. Leave the enhancement control's availability rule untouched.
- [x] 6.2 Message rendering: waiting / will-run-next / cancelled chips, the interrupt-fallback note, a cancel control only while pending, and a resume control when the drain is paused — message chips describe the message; the header pill stays run-scoped (`run-states.js`).
- [x] 6.3 Restore rendering: rebuild queue states from the snapshot/events, rendered exactly once — a queued message appears immediately at submission (existing "appears immediately" requirement) and no reload creates a second copy.
- [x] 6.4 `QUEUE_FULL` refusal shows the reason and keeps the composer text for editing or resubmission. ← (verify: panel states reviewed visually at 320/400/480 in both themes — waiting, cancelled, paused, fallback — following the existing visual-QA bar; draft survives the refusal in a test)

## 7. Tests

- [x] 7.1 New `host/test/message-queue.test.mjs`: admission while active, bound refusal, dedupe, conditional claim transitions, successor ordering, stop-pause/resume, delete-cancel.
- [x] 7.2 New `host/test/message-queue-recovery.test.mjs`: the restart matrix (pending / dispatching-never-started / dispatching-started), the single-commit invariant, and self-consistency between `messageQueue` and the event log after replayed crashes.
- [x] 7.3 Interrupt tests: idle, active-stopped, race-finished; approval invalidation through the stop path; fallback disclosure recorded only when true.
- [x] 7.4 Panel tests (existing extract-based pattern): composer enablement during runs, chips/cancel/resume states, draft preservation on refusal, restore without duplication, and unchanged enhancement-control availability. ← (verify: new tests fail before implementation and pass after; enhancement availability assertions pin the untouched rule)
- [x] 7.5 Run `node host/test/*.test.mjs` and the root `test/*.test.mjs` sweep. ← (verify: only files already known-red before this change fail, and none of them is touched by it)

## 8. Docs and status

- [x] 8.1 Update the README side-panel status section to describe queue/steering as real only once the behavior ships; remove any "still in development" overlap for these surfaces at that point. ← (verify: README text matches shipped behavior; no promise ahead of the build)

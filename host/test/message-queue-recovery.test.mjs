#!/usr/bin/env node
//
// Queued messages — durability and restart recovery
// (openspec/changes/add-message-queue-and-steering, R8 / design.md
// decision 2, tasks.md 5.1-5.3 + 7.2).
//
// The crash matrix, driven with real on-disk stores and TWO manager instances
// over the same agent home (a "restart" is: throw away the first process's
// in-memory state — its Run objects, its lease, its store instance — and
// build a second one over the same files):
//
//   dispatching + the log has run_started  → consumed by the interrupted run:
//                                            never replayed, recorded as
//                                            consumed if that was missing.
//   dispatching + no run_started           → nothing ran: back to pending,
//                                            and it runs exactly once later.
//   paused                                 → survives, and nothing drains at
//                                            boot; the resume action re-arms.
//
// Plus the invariants: a claimed message is owned by exactly one turn, the
// live queue and the event log never disagree after recovery, and the
// snapshot the panel reads carries the queue state exactly once per message.
//
// Run: node host/test/message-queue-recovery.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, intervalMs));
  return fn();
}
function freshHome() {
  process.env.OCIC_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-message-queue-recovery-"));
}

/** One "companion process" worth of in-memory state over a fresh store — the
 * restart under test is exactly "discard this and build another one". */
function buildManager({ onDrain = null } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const manager = new SessionManager({ store, lease, approvals });
  const drained = [];
  if (onDrain) {
    manager.onQueueDrain = (conversationId) => {
      const claimed = manager.claimNextQueuedMessage(conversationId);
      drained.push(claimed);
      onDrain(claimed);
    };
  }
  return { store, lease, approvals, manager, drained };
}

function gatedSdk() {
  const calls = [];
  const parked = [];
  return {
    calls,
    release(prompt) {
      const index = parked.findIndex((entry) => entry.prompt === prompt);
      if (index === -1) throw new Error(`no parked run for prompt ${JSON.stringify(prompt)}`);
      const [entry] = parked.splice(index, 1);
      entry.resolve();
    },
    async *query({ prompt }) {
      calls.push({ prompt });
      await new Promise((resolve) => parked.push({ prompt, resolve }));
      yield { type: "assistant", text: `ok:${prompt}` };
    }
  };
}

/** A fresh CompanionCore over the SAME agent home (the reopened process). */
function buildCore({ sdk }) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async () => ({ content: [] }), shutdown: () => {} });
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk,
    profileProvider: {
      async snapshotForRun(profileId, modelId) {
        return {
          model: modelId || "claude-fake-model",
          env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
          revision: 1,
          profileId: profileId || "default"
        };
      }
    }
  });
  return { core, store, lease, sessionManager };
}

function types(list) {
  return list.map((e) => e.type + (e.reason ? `:${e.reason}` : ""));
}

/**
 * The invariant every recovery scenario must leave behind: the live queue and
 * the event log agree. Concretely — no entry survives in `dispatching` (every
 * one of those is decided by the log), every live entry has its own
 * `message_queued` record, and no message that was ever CONSUMED goes back
 * into the queue afterwards (a requeue before its consumption is the correct
 * outcome of a crash at the claim point; a requeue after it would mean the
 * same message was owned twice).
 */
function assertQueueLogConsistency(store, conversationId) {
  const meta = store.loadMeta(conversationId);
  const events = store.allEvents(conversationId);
  const queued = events.filter((e) => e.type === "message_queued").map((e) => e.messageId);
  for (const entry of meta.messageQueue || []) {
    assert(entry.state === "pending", `recovery must leave no dispatching entry (found ${entry.state})`);
    assert(entry.claimedByRunId === null, "a requeued entry carries no run owner");
    assert(queued.includes(entry.messageId), `entry ${entry.messageId} has no message_queued record`);
  }
  const consumedAt = new Map();
  events.forEach((event, index) => {
    if (event.type === "message_consumed") consumedAt.set(event.messageId, index);
  });
  events.forEach((event, index) => {
    if (event.type !== "message_requeued") return;
    const consumed = consumedAt.get(event.messageId);
    // A requeue is legitimate while the message has not run yet (consumption
    // later in the log, or never). It is a bug only when it follows one.
    assert(
      consumed === undefined || index < consumed,
      `message ${event.messageId} was consumed and then requeued — it ran, so it must never re-enter the queue`
    );
  });
}

console.log("\nMessage queue recovery — the crash matrix\n");

await test("dispatching WITH run_started: consumed by the interrupted run, recorded, and never replayed", async () => {
  freshHome();
  const p1 = buildManager();
  const conversationId = p1.store.createConversation("conv_crash_started").conversationId;
  const enqueued = p1.manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "already started", tabScope: "any", profileId: null, modelId: null }
  });
  assert(enqueued.ok, "the message was queued");
  const claimed = p1.manager.claimNextQueuedMessage(conversationId);
  assert(claimed && claimed.run, "the drain claimed it and created its turn");
  assert(await claimed.run.begin(), "the run really started (run_started is now in the log)");
  assert(
    p1.store.allEvents(conversationId).some((e) => e.type === "run_started" && e.runId === claimed.run.runId),
    "the log proves the run started"
  );
  // "Crash" here: no finishRun, no consume. The process is simply replaced.

  const p2 = buildManager();
  p2.manager.recoverAfterRestart();
  const meta2 = p2.store.loadMeta(conversationId);
  assert(meta2.activeRunId === null && meta2.interrupted === true, "the interrupted run is repaired");
  assert(meta2.messageQueue.length === 0, "the message is not waiting in the queue — a turn owns it");
  const events2 = p2.store.allEvents(conversationId);
  assert(
    events2.some((e) => e.type === "message_consumed" && e.messageId === enqueued.entry.messageId),
    "consumption is recorded even though the crash prevented the live append"
  );
  assert(
    events2.some((e) => e.type === "run_interrupted_by_restart" && e.runId === claimed.run.runId),
    "and it follows the existing interrupted-run handling"
  );
  assert(!types(events2).some((t) => t.startsWith("message_requeued")), "an already-started message is never requeued");
  assert(p2.manager.claimNextQueuedMessage(conversationId) === null, "there is nothing left to replay");
  assertQueueLogConsistency(p2.store, conversationId);
});

await test("dispatching WITHOUT run_started: back to pending, and it runs exactly once afterward", async () => {
  freshHome();
  const p1 = buildManager();
  const conversationId = p1.store.createConversation("conv_crash_claimed").conversationId;
  const enqueued = p1.manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "claimed but never started", tabScope: "any", profileId: null, modelId: null }
  });
  const claimed = p1.manager.claimNextQueuedMessage(conversationId);
  assert(claimed, "the claim happened (the entry is dispatching with a run id)");
  assert(
    !p1.store.allEvents(conversationId).some((e) => e.type === "run_started"),
    "and nothing ever ran — there is no run_started for it"
  );
  assert(
    p1.store.loadMeta(conversationId).messageQueue[0].state === "dispatching",
    "the durable state the crash left behind is exactly 'claimed, not started'"
  );

  const p2 = buildManager();
  p2.manager.recoverAfterRestart();
  const meta2 = p2.store.loadMeta(conversationId);
  assert(meta2.messageQueue.length === 1 && meta2.messageQueue[0].state === "pending", "the message is pending again");
  assert(meta2.messageQueue[0].claimedByRunId === null, "and it is owned by no run");
  assert(meta2.queuePaused === false, "nothing about this paused the queue");
  assert(
    p2.store.allEvents(conversationId).some((e) => e.type === "message_requeued" && e.reason === "restart_before_start"),
    "the requeue names its reason"
  );
  assert(!p2.manager.hasActiveRun(conversationId), "no run was recreated by recovery");
  assertQueueLogConsistency(p2.store, conversationId);

  // Reopen it (a real CompanionCore over the same home) and send anything:
  // the recovered message runs once, as the oldest pending turn.
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  assert(
    core.sessionManager.pendingQueueEntries(conversationId).length === 1,
    "reopening alone must not drain it (no auto-drain at reopen)"
  );
  const fresh = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a new message" })
  );
  assert(fresh.queued === true, "the new send is queued behind the recovered one");
  await waitUntil(() => sdk.calls.length === 1);
  assert(sdk.calls[0].prompt === "claimed but never started", "the recovered message runs first, with its own text");
  assert(sdk.calls.length === 1, "exactly once — a claim is not a second copy of the message");
  sdk.release("claimed but never started");
  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "a new message", "then the new submission");
  sdk.release("a new message");

  const events = core.sessionManager.snapshotSince(conversationId, 0).events;
  assert(
    events.filter((e) => e.type === "message_consumed" && e.messageId === enqueued.entry.messageId).length === 1,
    "the recovered message is consumed exactly once"
  );
  assertQueueLogConsistency(core.sessionManager.store, conversationId);
});

await test("a paused queue survives the restart, nothing drains at boot, and the snapshot shows it exactly once", async () => {
  freshHome();
  const p1 = buildManager();
  const conversationId = p1.store.createConversation("conv_crash_paused").conversationId;
  const a = p1.manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "A", tabScope: "any", profileId: null, modelId: null }
  });
  const b = p1.manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "B", tabScope: "any", profileId: null, modelId: null }
  });
  assert(a.ok && b.ok, "both messages were queued");
  // The operator stopped the run that was active: pause is written durably
  // (the run itself is irrelevant to the recovery under test, so it is not
  // started here — stopRun() only pauses when something is pending, which is
  // the state this scenario is about).
  const run = p1.manager.startRun(conversationId, {});
  assert(p1.manager.stopRun(conversationId, "user_stop") === true, "the run stops");
  assert(run.state === "stopped", "and is really stopped");
  assert(p1.store.loadMeta(conversationId).queuePaused === true, "Stop paused the drain");
  assert(
    types(p1.store.allEvents(conversationId)).includes("message_queue_paused:user_stop"),
    "the pause is recorded before the crash"
  );

  const p2 = buildManager({ onDrain: () => {} });
  const recovered = p2.manager.recoverAfterRestart();
  const meta2 = p2.store.loadMeta(conversationId);
  assert(recovered.length === 0, "a cleanly stopped run leaves nothing for the interrupted-run repair");
  assert(meta2.queuePaused === true, "the pause survives the restart");
  assert(meta2.messageQueue.length === 2 && meta2.messageQueue.every((e) => e.state === "pending"), "both messages are still pending");
  assert(!p2.manager.hasActiveRun(conversationId), "and nothing is running");
  assert(p2.drained.length === 0, "no drain trigger fires at boot");
  assertQueueLogConsistency(p2.store, conversationId);

  // The snapshot the panel reads carries the queue state once per message.
  const snapshot = p2.store.snapshot(conversationId, 0);
  assert(snapshot.meta.queuePaused === true, "the snapshot reports the pause");
  assert(snapshot.meta.messageQueue.length === 2, "and both entries");
  assert(
    snapshot.events.filter((e) => e.type === "message_queued").length === 2,
    "each message has exactly one message_queued record — no duplicate text"
  );

  // Reopening still does not drain; the operator's resume does.
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  assert(sdk.calls.length === 0, "reopening a paused queue starts nothing");
  const resumed = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.RESUME_QUEUE, { conversationId }));
  assert(resumed.ok === true, "resume is accepted");
  await waitUntil(() => sdk.calls.length === 1);
  assert(sdk.calls[0].prompt === "A", "the oldest pending message runs first");
  sdk.release("A");
  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "B", "then the next one, in submission order");
  sdk.release("B");
});

await test("an interrupt whose preemption never landed is disclosed as a fallback on the restored successor", async () => {
  freshHome();
  const p1 = buildManager();
  const conversationId = p1.store.createConversation("conv_crash_interrupt").conversationId;
  const run = p1.manager.startRun(conversationId, {});
  const successor = p1.manager.enqueueMessage(conversationId, {
    mode: "interrupt",
    submission: { text: "run now", tabScope: "any", profileId: null, modelId: null }
  });
  assert(successor.ok, "the interrupt message was queued");
  // The designation is written BEFORE the stop path runs (design.md decision
  // 3's ordering), so a crash in that window leaves a lasting successor with
  // no `run_stopped`/`user_interrupt` behind it.
  p1.store.updateMeta(conversationId, { successorMessageId: successor.entry.messageId });

  const p2 = buildManager({ onDrain: () => {} });
  p2.manager.recoverAfterRestart();
  const events2 = p2.store.allEvents(conversationId);
  assert(
    events2.some((e) => e.type === "run_interrupted_by_restart" && e.runId === run.runId),
    "the interrupted run is recorded as interrupted-by-restart, not as an operator interrupt"
  );
  assert(!types(events2).includes("run_stopped:user_interrupt"), "so the interrupt provably did not land");

  p2.manager.resumeQueue(conversationId);
  assert(p2.drained.length === 1 && p2.drained[0], "the restored successor is claimed");
  assert(
    p2.store.allEvents(conversationId).some((e) => e.type === "message_interrupt_fallback" && e.messageId === successor.entry.messageId),
    "and the fallback is disclosed on it, before the claim"
  );
  assert(
    types(p2.store.allEvents(conversationId)).indexOf("message_interrupt_fallback") <
      types(p2.store.allEvents(conversationId)).indexOf("message_claimed"),
    "the note precedes the claim, so the panel can render it with the message's next state"
  );
  assert(p2.store.loadMeta(conversationId).successorMessageId === successor.entry.messageId, "the successor designation survives until its turn runs");
});

console.log("\nMessage queue recovery — invariants\n");

await test("the claim of a message and the creation of its turn commit together, so no message is owned twice", async () => {
  freshHome();
  const p1 = buildManager();
  const conversationId = p1.store.createConversation("conv_single_commit").conversationId;
  const enqueued = p1.manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "one owner", tabScope: "any", profileId: null, modelId: null }
  });
  const claimed = p1.manager.claimNextQueuedMessage(conversationId);
  const meta1 = p1.store.loadMeta(conversationId);
  const events1 = p1.store.allEvents(conversationId);
  assert(meta1.messageQueue[0].state === "dispatching", "the durable entry is dispatching");
  assert(meta1.messageQueue[0].claimedByRunId === claimed.run.runId, "and names exactly the run that was created");
  assert(meta1.activeRunId === claimed.run.runId, "which is the conversation's active run");
  assert(
    events1.some((e) => e.type === "message_claimed" && e.messageId === enqueued.entry.messageId && e.runId === claimed.run.runId),
    "and the claim event names the same pair"
  );
  // Recovery of that half-committed state never produces a second owner.
  const p2 = buildManager();
  p2.manager.recoverAfterRestart();
  const meta2 = p2.store.loadMeta(conversationId);
  assert(meta2.messageQueue.length === 1 && meta2.messageQueue[0].state === "pending", "it is pending again, owned by nobody");
  assert(p2.store.allEvents(conversationId).filter((e) => e.type === "message_claimed").length === 1, "no second claim was written by recovery");
  assert(meta2.activeRunId === null, "and no run is left claiming it");
  assertQueueLogConsistency(p2.store, conversationId);
});

await test("recovery is idempotent: a second pass over already-reconciled state changes nothing", async () => {
  freshHome();
  const p1 = buildManager();
  const conversationId = p1.store.createConversation("conv_recover_twice").conversationId;
  p1.manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "pending", tabScope: "any", profileId: null, modelId: null }
  });
  const claimed = p1.manager.claimNextQueuedMessage(conversationId);
  assert(claimed, "claimed (dispatching, never started)");

  const p2 = buildManager();
  p2.manager.recoverAfterRestart();
  const afterFirst = JSON.stringify(p2.store.loadMeta(conversationId).messageQueue);
  const eventsAfterFirst = p2.store.allEvents(conversationId).length;
  // Both repair sites run in a real process (startup recovery, then the
  // snapshot repair a panel's RESUME triggers).
  p2.manager.recoverAfterRestart();
  p2.manager.resumeConversation(conversationId, 0);
  assert(JSON.stringify(p2.store.loadMeta(conversationId).messageQueue) === afterFirst, "the second pass left the queue identical");
  assert(
    p2.store.allEvents(conversationId).length === eventsAfterFirst,
    "and appended nothing — no duplicate requeue records"
  );
  assertQueueLogConsistency(p2.store, conversationId);
});

await test("a live conversation's dispatching entry is left alone by the snapshot repair", async () => {
  freshHome();
  const { store, manager } = buildManager();
  const conversationId = store.createConversation("conv_live_reopen").conversationId;
  manager.enqueueMessage(conversationId, {
    mode: "queue",
    submission: { text: "in flight", tabScope: "any", profileId: null, modelId: null }
  });
  const claimed = manager.claimNextQueuedMessage(conversationId);
  assert(claimed, "claimed by the live run");
  // The panel reopens while the turn is genuinely in flight in THIS process:
  // reconciliation must not steal the entry away from the run that owns it.
  manager.resumeConversation(conversationId, 0);
  const meta = store.loadMeta(conversationId);
  assert(meta.messageQueue.length === 1 && meta.messageQueue[0].state === "dispatching", "still owned by the live run");
  assert(meta.messageQueue[0].claimedByRunId === claimed.run.runId, "with the same owner");
  assert(
    !types(store.allEvents(conversationId)).some((t) => t.startsWith("message_requeued")),
    "and no requeue was written for a turn that is still running"
  );
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

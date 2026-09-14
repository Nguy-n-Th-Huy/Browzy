#!/usr/bin/env node
//
// Queued messages (openspec/changes/add-message-queue-and-steering, host
// half): a message submitted while the conversation's run is active is
// accepted into a bounded, durable queue and runs as the next turn, in
// submission order; the bound refuses with a distinguishable reason and
// leaves no trace; a retried send with the same idempotency key resolves to
// the existing entry; a pending message is cancellable and a claimed one is
// not; interrupt reuses the stop path and claims no preemption it did not
// achieve; Stop pauses the drain and resume (or a new submission) re-arms
// it; deleting a conversation cancels its pending messages.
//
// The fake `sdk.query()` is GATED: every call parks until the test releases
// THAT call by its prompt, so "this run is active" is a fact the test owns
// rather than a timing assumption — and a run parked earlier can be left
// parked while a later one is exercised.
//
// Run: node host/test/message-queue.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore, QUEUE_LIMIT } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";
import { isBorrowedTabMutationAuthorized } from "../agent/tools/mapping.js";

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

/** A fresh agent home per test: conversations are real on-disk state, and the
 * queue's whole point is that it is durable, so isolation has to be real too. */
function freshHome() {
  process.env.OCIC_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-message-queue-"));
}

async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, intervalMs));
  return fn();
}

/** A gated fake SDK: every query parks until `release(prompt)` finishes that
 * exact call. Prompts are unique per test, so a release is never ambiguous. */
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
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      await new Promise((resolve) => parked.push({ prompt, resolve }));
      yield { type: "assistant", text: `ok:${prompt}` };
    }
  };
}

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

function buildCore({ sdk } = {}) {
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
    sdk: sdk || gatedSdk(),
    profileProvider: fakeProfileProvider()
  });
  return { core, store, lease, approvals, sessionManager };
}

async function newConversation(core) {
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  return reply.conversationId;
}

function events(core, conversationId) {
  return core.sessionManager.snapshotSince(conversationId, 0).events;
}
function queue(core, conversationId) {
  return core.sessionManager.queueEntries(conversationId);
}
function meta(core, conversationId) {
  return core.sessionManager.store.loadMeta(conversationId);
}
function types(list) {
  return list.map((e) => e.type + (e.reason ? `:${e.reason}` : ""));
}
function send(core, conversationId, body) {
  return core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, ...body }));
}

console.log("\nMessage queue — admission, bound, idempotency\n");

await test("a message submitted while the run is active is queued, and runs as the next turn with exactly its own text", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);

  await send(core, conversationId, { prompt: "first" });
  await waitUntil(() => sdk.calls.length === 1);

  const reply = await send(core, conversationId, { prompt: "second" });
  assert(reply.type === AGENT_MESSAGE_TYPES.START, "the send is accepted, not refused");
  assert(reply.accepted === true && reply.queued === true, "it is accepted as queued");
  assert(reply.runId === undefined, "a queued message has no run yet");
  assert(reply.entry.state === "pending", "the entry is pending");
  assert(Number.isInteger(reply.entry.messageId), "the entry names its message by id");
  assert(sdk.calls.length === 1, "the active run is untouched — no second turn was started");

  const live = queue(core, conversationId);
  assert(live.length === 1 && live[0].messageId === reply.entry.messageId, "exactly one live entry, the accepted one");
  const queuedEvent = events(core, conversationId).find((e) => e.type === "message_queued");
  assert(queuedEvent, "the durable message_queued event is the submission's record");
  assert(queuedEvent.submission.text === "second", "the text lives in that event, not in meta");
  assert(queuedEvent.messageId === reply.entry.messageId, "the entry's messageId is the event's own identity");
  assert(queuedEvent.seq === reply.entry.messageId, "messageId IS the seq of the message_queued event");

  sdk.release("first");
  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "second", "the queued turn ran the submitted text, not a reconstruction of it");
  assert(queue(core, conversationId).length === 0, "a consumed message leaves the live queue");
  assert(types(events(core, conversationId)).includes("message_claimed"), "the claim is recorded");
  assert(types(events(core, conversationId)).includes("message_consumed"), "consumption is recorded");
  sdk.release("second");
});

await test("the queue bound refuses the next submission with a reason naming the limit, and appends nothing at all", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);

  for (let i = 0; i < QUEUE_LIMIT; i++) {
    const ack = await send(core, conversationId, { prompt: `queued-${i}` });
    assert(ack.queued === true && ack.entry.state === "pending", `submission ${i} must be queued`);
  }
  assert(queue(core, conversationId).length === QUEUE_LIMIT, "the queue holds exactly its bound");

  const refused = await send(core, conversationId, { prompt: "one-too-many" });
  assert(refused.type === AGENT_MESSAGE_TYPES.ERROR && refused.reason === "queue_full", "a full queue is a distinguishable refusal");
  assert(refused.limit === QUEUE_LIMIT, "the refusal names the limit");
  assert(queue(core, conversationId).length === QUEUE_LIMIT, "nothing was queued");
  const queuedEvents = events(core, conversationId).filter((e) => e.type === "message_queued");
  assert(queuedEvents.length === QUEUE_LIMIT, "no message event was appended for the refused submission");
  assert(
    !queuedEvents.some((e) => e.submission.text === "one-too-many"),
    "the refused text never reached the log — the operator's draft is still the only copy"
  );
  sdk.release("run");
});

await test("a retried send with the same idempotency key resolves to the same entry; a different key is a new one", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);

  const first = await send(core, conversationId, { prompt: "retry me", idempotencyKey: "key-1" });
  const retry = await send(core, conversationId, { prompt: "retry me", idempotencyKey: "key-1" });
  assert(first.entry.messageId === retry.entry.messageId, "the retry resolves to the SAME entry");
  assert(retry.idempotent === true, "the retry says so");
  assert(queue(core, conversationId).length === 1, "exactly one entry exists for the key");
  assert(
    events(core, conversationId).filter((e) => e.type === "message_queued").length === 1,
    "and exactly one message event — the text is stored once"
  );

  const other = await send(core, conversationId, { prompt: "different", idempotencyKey: "key-2" });
  assert(other.entry.messageId !== first.entry.messageId, "a new key creates a new entry");

  // A retry that lands AFTER the entry was consumed must still resolve to the
  // original acceptance rather than queueing (R7's memo half).
  sdk.release("run");
  await waitUntil(() => sdk.calls.length === 2);
  const afterConsumed = await send(core, conversationId, { prompt: "retry me", idempotencyKey: "key-1" });
  assert(afterConsumed.idempotent === true, "a late retry replays the original acceptance");
  assert(afterConsumed.entry.messageId === first.entry.messageId, "still naming the original entry's message");
  assert(afterConsumed.runId === undefined, "and starting no run of its own — a retry is not a second send");
  sdk.release("retry me");
});

await test("a malformed mode or idempotency key is rejected at the wire boundary, before anything is queued", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);

  const badMode = await send(core, conversationId, { prompt: "x", mode: "interupt" });
  assert(badMode.type === AGENT_MESSAGE_TYPES.ERROR && badMode.reason === "malformed_mode", "a typo'd mode is refused, never coerced");
  const badKey = await send(core, conversationId, { prompt: "x", idempotencyKey: 42 });
  assert(badKey.type === AGENT_MESSAGE_TYPES.ERROR && badKey.reason === "malformed_idempotency_key", "a malformed key is refused");
  assert(queue(core, conversationId).length === 0, "neither refusal queued anything");
  sdk.release("run");
});

console.log("\nMessage queue — cancel and claim boundary\n");

await test("cancel removes a pending message, is idempotent about being too late, and never touches the active run", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);

  const a = await send(core, conversationId, { prompt: "cancel me" });
  const b = await send(core, conversationId, { prompt: "keep me" });

  const cancelled = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.CANCEL_MESSAGE, { conversationId, messageId: a.entry.messageId, requestId: "req-1" })
  );
  assert(cancelled.type === AGENT_MESSAGE_TYPES.CANCEL_MESSAGE && cancelled.ok === true, "a pending message is cancellable");
  assert(cancelled.messageId === a.entry.messageId && cancelled.requestId === "req-1", "the reply names the message and correlates");
  assert(types(events(core, conversationId)).includes("message_cancelled:user_cancel"), "the cancellation is a durable, visible outcome");
  assert(
    core.sessionManager.activeRun(conversationId).state === "running",
    "cancelling a queued message must not touch the run that is streaming"
  );

  const again = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.CANCEL_MESSAGE, { conversationId, messageId: a.entry.messageId })
  );
  assert(again.ok === false && again.reason === "unknown_message", "a second cancel of the same message is refused honestly");

  const live = queue(core, conversationId);
  assert(live.length === 1 && live[0].messageId === b.entry.messageId, "only the surviving message is still queued");

  // The cancelled message must never run: the next turn belongs to `keep me`.
  sdk.release("run");
  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "keep me", "the cancelled message never ran; the surviving one kept its order");
  sdk.release("keep me");
});

await test("once a turn has claimed a message, cancelling it is refused with the claimed state disclosed", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);

  const claimed = await send(core, conversationId, { prompt: "next" });
  sdk.release("run");
  await waitUntil(() => sdk.calls.length === 2); // the drain claimed it and its turn is running

  const late = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.CANCEL_MESSAGE, { conversationId, messageId: claimed.entry.messageId })
  );
  assert(late.ok === false && late.reason === "already_claimed", "a claimed message is not cancellable");
  assert(late.state === "consumed", "and the real lifecycle state is disclosed, not a vague refusal");
  assert(sdk.calls.length === 2, "the refused cancel did not stop or restart anything");
  assert(
    core.sessionManager.activeRun(conversationId).state === "running",
    "the claimed message's turn is still the active run — Stop is the control at this point"
  );
  sdk.release("next");
});

await test("a queued message's page context is the one captured at submission, not the tab current at drain", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run", context: { tabId: 1 } });
  await waitUntil(() => sdk.calls.length === 1);

  // Submitted while page 7 was bound; the operator then moved to page 9 for
  // the second message. Each turn must carry its OWN submission's binding.
  await send(core, conversationId, { prompt: "on page 7", context: { tabId: 7 } });
  await send(core, conversationId, { prompt: "on page 9", context: { tabId: 9 } });

  sdk.release("run");
  await waitUntil(() => sdk.calls.length === 2);
  const firstTurn = core.sessionManager.activeRun(conversationId);
  assert(isBorrowedTabMutationAuthorized(firstTurn, 7), "the first queued turn is bound to the page bound at ITS submission");
  assert(!isBorrowedTabMutationAuthorized(firstTurn, 9), "and not to a tab the operator switched to afterward");

  sdk.release("on page 7");
  await waitUntil(() => sdk.calls.length === 3);
  const secondTurn = core.sessionManager.activeRun(conversationId);
  assert(isBorrowedTabMutationAuthorized(secondTurn, 9), "the second turn carries its own submission-time binding");
  assert(!isBorrowedTabMutationAuthorized(secondTurn, 7), "and never inherits the previous message's binding");
  sdk.release("on page 9");
});

await test("a queued message whose own submission record is gone fails visibly instead of blocking the queue forever", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core, store, sessionManager } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);
  await send(core, conversationId, { prompt: "real one" });

  // A poisoned head: an entry pointing at a seq no message_queued event ever
  // occupied (a torn tail, or a hand-edited meta). It cannot be run honestly.
  store.updateMeta(conversationId, {
    messageQueue: [
      {
        messageId: 99999,
        mode: "queue",
        state: "pending",
        claimedByRunId: null,
        idempotencyKey: null,
        enqueuedAt: Date.now()
      },
      ...queue(core, conversationId)
    ]
  });

  sdk.release("run");
  await waitUntil(() => sdk.calls.length === 2);
  const recorded = events(core, conversationId);
  assert(
    recorded.some((e) => e.type === "message_failed" && e.messageId === 99999 && e.reason === "submission_missing"),
    "the un-runnable message is failed with a reason"
  );
  assert(sdk.calls[1].prompt === "real one", "and the message behind it still ran — one poison entry cannot stall the queue");
  assert(!queue(core, conversationId).some((e) => e.messageId === 99999), "the failed entry left the live queue");
  assert(queue(core, conversationId).length === 0, "the healthy entry was consumed, not stranded");
  sdk.release("real one");
  assert(sessionManager.hasActiveRun(conversationId), "sanity: the drained run is the active one");
});

console.log("\nMessage queue — interrupt (run now)\n");

await test("interrupt with no active run behaves as an ordinary send", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);

  const reply = await send(core, conversationId, { prompt: "now", mode: "interrupt" });
  assert(reply.accepted === true && typeof reply.runId === "string", "with nothing to interrupt it simply starts");
  assert(queue(core, conversationId).length === 0, "nothing was queued");
  assert(
    !types(events(core, conversationId)).includes("message_interrupt_fallback"),
    "and no fallback is claimed for an interrupt that was never attempted"
  );
  await waitUntil(() => sdk.calls.length === 1);
  sdk.release("now");
});

await test("interrupt while a run is active stops it through the stop path and runs the message as the immediate next turn", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core, sessionManager, approvals } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "slow" });
  await waitUntil(() => sdk.calls.length === 1);
  const interruptedRun = sessionManager.activeRun(conversationId);
  // An outstanding decision, to prove the interrupt invalidates it exactly
  // like Stop does (spec: "Interrupt while a decision is pending").
  const outstanding = approvals.issue({
    runId: interruptedRun.runId,
    action: "navigate",
    target: { url: "https://example.com" }
  });

  const earlier = await send(core, conversationId, { prompt: "earlier pending" });
  const now = await send(core, conversationId, { prompt: "run now", mode: "interrupt" });
  assert(now.queued === true && now.entry.mode === "interrupt", "the interrupt send is still an honest queue entry");

  const recorded = events(core, conversationId);
  assert(
    recorded.some((e) => e.type === "run_stopped" && e.reason === "user_interrupt"),
    "the active run was stopped under the existing stop semantics"
  );
  assert(interruptedRun.state === "stopped", "and it is really stopped, not merely reported so");
  assert(
    approvals.consume(outstanding, {
      runId: interruptedRun.runId,
      action: "navigate",
      target: { url: "https://example.com" }
    }).ok === false,
    "the interrupt invalidated the outstanding decision, exactly like Stop"
  );
  assert(!recorded.some((e) => e.type === "message_interrupt_fallback"), "a delivered interrupt claims no fallback");
  assert(Number.isInteger(earlier.entry.messageId), "the earlier pending message is still queued");

  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "run now", "the interrupt message runs as the immediate next turn");
  sdk.release("run now");
  await waitUntil(() => sdk.calls.length === 3);
  assert(sdk.calls[2].prompt === "earlier pending", "the earlier pending message keeps its place right after it");
  sdk.release("earlier pending");
});

await test("queueing never resolves a pending decision; interrupt does, under Stop's own rules", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "waiting on a decision" });
  await waitUntil(() => sdk.calls.length === 1);

  // The run is parked awaiting an approval, exactly as canUseTool parks it.
  const decisions = [];
  core._pendingApprovals.set("req-1", (resolution) => decisions.push(resolution), "token-1");

  const queued = await send(core, conversationId, { prompt: "just queue this" });
  assert(queued.queued === true, "the send is queued while the decision is outstanding");
  assert(core._pendingApprovals.has("req-1"), "the pending decision is untouched — queueing answers nothing");
  assert(decisions.length === 0, "and no resolver was called by the queueing itself");

  const interrupt = await send(core, conversationId, { prompt: "run now instead", mode: "interrupt" });
  assert(interrupt.queued === true, "the interrupt is accepted as a queued entry");
  assert(!core._pendingApprovals.has("req-1"), "the interrupt invalidates the outstanding decision, exactly like Stop");
  assert(
    decisions.length === 1 && decisions[0].decision === "deny" && String(decisions[0].reason).includes("user_interrupt"),
    "which resolves it as a denial naming the reason, never silently"
  );
  sdk.release("waiting on a decision");
});

console.log("\nMessage queue — operator-controlled drain\n");

await test("Stop pauses the drain; resume drains the pending messages in submission order", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "slow" });
  await waitUntil(() => sdk.calls.length === 1);
  await send(core, conversationId, { prompt: "A" });
  await send(core, conversationId, { prompt: "B" });

  const stop = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
  assert(stop.stopped === true, "Stop really stops the run");
  assert(meta(core, conversationId).queuePaused === true, "and pauses the drain, durably");
  assert(types(events(core, conversationId)).includes("message_queue_paused:user_stop"), "the pause is an operator-visible event");
  assert(queue(core, conversationId).every((e) => e.state === "pending"), "pending messages stay pending");
  assert(sdk.calls.length === 1, "nothing started automatically after the stop");
  assert(queue(core, conversationId).length === 2, "both pending messages are still there, individually cancellable");

  const resumed = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.RESUME_QUEUE, { conversationId, requestId: "rq" }));
  assert(
    resumed.type === AGENT_MESSAGE_TYPES.RESUME_QUEUE && resumed.ok === true && resumed.requestId === "rq",
    "resume is acknowledged"
  );
  assert(meta(core, conversationId).queuePaused === false, "the pause is cleared");
  assert(types(events(core, conversationId)).includes("message_queue_resumed:resume"), "and recorded");
  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "A", "the oldest pending message runs first");
  sdk.release("A");
  await waitUntil(() => sdk.calls.length === 3);
  assert(sdk.calls[2].prompt === "B", "then the next one, in submission order");
  sdk.release("B");

  // Resuming an unpaused, empty queue is a harmless no-op, not a duplicate run.
  const again = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.RESUME_QUEUE, { conversationId }));
  assert(again.ok === true && sdk.calls.length === 3, "a resume with nothing to drain starts nothing");
});

await test("a new submission re-arms a paused drain, and does not jump the messages already waiting", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "slow" });
  await waitUntil(() => sdk.calls.length === 1);
  await send(core, conversationId, { prompt: "A" });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
  assert(meta(core, conversationId).queuePaused === true, "the stop paused the drain");

  const c = await send(core, conversationId, { prompt: "C" });
  assert(c.queued === true, "the new submission is queued with the others");
  assert(meta(core, conversationId).queuePaused === false, "and re-arms the drain");
  assert(types(events(core, conversationId)).includes("message_queue_resumed:submission"), "recorded as a submission-triggered resume");
  await waitUntil(() => sdk.calls.length === 2);
  assert(sdk.calls[1].prompt === "A", "the waiting message keeps its order — the new send does not jump it");
  sdk.release("A");
  await waitUntil(() => sdk.calls.length === 3);
  assert(sdk.calls[2].prompt === "C", "and the new message runs after it");
  sdk.release("C");
});

await test("deleting a conversation cancels its pending messages and starts no run into it", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core, sessionManager } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  await send(core, conversationId, { prompt: "slow" });
  await waitUntil(() => sdk.calls.length === 1);
  const a = await send(core, conversationId, { prompt: "pending A" });
  const b = await send(core, conversationId, { prompt: "pending B" });

  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId, idempotencyKey: "del-1" })
  );
  assert(reply.deleted === true, "the delete is accepted");
  assert(sessionManager.hasConversation(conversationId) === false, "the conversation is gone for every read in this process");
  assert(sdk.calls.length === 1, "no pending message started a run into the deleted conversation");
  assert(
    sessionManager.cancelQueuedMessage(conversationId, a.entry.messageId).reason === "conversation_deleted",
    "a late cancel for it reports the conversation is deleted rather than a false success"
  );
  assert(Number.isInteger(b.entry.messageId), "both pending messages existed at delete time");
});

await test("every queue transition is pushed live with its stored event, run-scoped only when it belongs to a run", async () => {
  freshHome();
  const sdk = gatedSdk();
  const { core, sessionManager } = buildCore({ sdk });
  const conversationId = await newConversation(core);
  // The hook companion.js's forked-child wiring installs to reach panels that
  // are connected while NO run exists to emit anything.
  const pushed = [];
  sessionManager.onConversationEvent = (id, event) => pushed.push({ id, event });
  await send(core, conversationId, { prompt: "run" });
  await waitUntil(() => sdk.calls.length === 1);
  await send(core, conversationId, { prompt: "queued live" });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.RESUME_QUEUE, { conversationId }));

  const queued = pushed.find((p) => p.event.type === "message_queued");
  assert(queued && queued.id === conversationId, "a message queued while a run is active is pushed live");
  assert(queued.event.submission.text === "queued live", "with the stored event, text included");
  assert(Number.isInteger(queued.event.seq), "and its durable seq, which IS the messageId a panel binds to");
  assert(queued.event.runId === undefined, "it belongs to no run, so it names none");

  sdk.release("run");
  await waitUntil(() => pushed.some((p) => p.event.type === "message_consumed"));
  const claimed = pushed.find((p) => p.event.type === "message_claimed");
  const consumed = pushed.find((p) => p.event.type === "message_consumed");
  assert(claimed.event.runId === consumed.event.runId, "the claim and its consumption name the same run");
  assert(typeof consumed.event.runId === "string", "a run-owned transition carries its runId");
  assert(
    pushed.indexOf(claimed) < pushed.indexOf(consumed),
    "and they arrive in the order they happened"
  );
  sessionManager.onConversationEvent = null;
  sdk.release("queued live");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// Panel side of openspec/changes/add-message-queue-and-steering (tasks.md
// 6.1-6.4, 7.4): the composer stays usable while a run is active, a
// submission is queued by default with an explicit run-now choice, every
// queued message renders its OWN state (waiting / will-run-next / cancelled /
// failed, plus the interrupt-fallback note), cancel is offered only while
// pending, the drain's paused state offers an explicit resume, and a reload
// rebuilds all of it from the host's authoritative meta + events exactly once.
//
// Everything here drives the SHIPPED modules: the real ConversationModel and
// the real PanelController against a fake protocol client (the wire is the
// seam the panel owns), plus the real render/gating functions pulled out of
// sidepanel.js by test/_extract.mjs's brace-matching extractor — the same
// technique test/sidepanel-streaming-render.test.mjs and
// test/composer-enhance-prompt.test.mjs already use, because sidepanel.js
// touches `document`/`chrome.*` at module scope and cannot be imported here.
//
// Run: node test/sidepanel-message-queue.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFunction, compile } from "./_extract.mjs";
import { createDocument } from "./_fake-dom.mjs";
import { escapeHtml } from "../extension/sidepanel/markdown-lite.js";
import { iconMarkup } from "../extension/ui/icons.js";
import { ConversationModel } from "../extension/sidepanel/conversation-model.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";
import { RUN_PHASE, MESSAGE_QUEUE_LABEL_VI, QUEUE_FALLBACK_NOTE_VI, QUEUE_PAUSED_NOTE_VI } from "../extension/sidepanel/run-states.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL_FILE = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const SIDEPANEL_SRC = fs.readFileSync(SIDEPANEL_FILE, "utf8");
const extract = (name) => extractFunction(name, SIDEPANEL_FILE);

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
}

// ---- shipped render bundle (real sidepanel.js markup) ---------------------
// The chip glyph table is a presentation detail the renderer closes over; it
// is read out of the shipped source rather than re-listed here, so this test
// cannot pass against a table the panel no longer has.
function shippedConst(name) {
  const m = SIDEPANEL_SRC.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`));
  if (!m) throw new Error(`const ${name} not found in ${SIDEPANEL_FILE}`);
  return new Function(`return ${m[1]};`)();
}

const userItemRender = compile(
  [extract("renderUserItemHtml"), extract("renderUserQueueStateHtml"), extract("queueStateDetail")].join("\n\n"),
  {
    escapeHtml,
    iconMarkup,
    MESSAGE_QUEUE_LABEL_VI,
    QUEUE_FALLBACK_NOTE_VI,
    QUEUE_STATE_ICONS: shippedConst("QUEUE_STATE_ICONS")
  },
  "{ renderUserItemHtml, renderUserQueueStateHtml }"
);

const structureSignature = compile(extract("transcriptStructureSignature"), {}, "transcriptStructureSignature");

// ---- fake panel deps (the panel's own seams) -----------------------------
function makeProtocolStub() {
  const sent = [];
  const envelopeHandlers = [];
  const disconnectHandlers = [];
  return {
    sent,
    deliver(env) {
      for (const fn of envelopeHandlers) fn(env);
    },
    fireDisconnect() {
      for (const fn of disconnectHandlers) fn();
    },
    onEnvelope(fn) {
      envelopeHandlers.push(fn);
      return () => {};
    },
    onHandshakeChange() {
      return () => {};
    },
    onDisconnect(fn) {
      disconnectHandlers.push(fn);
      return () => {};
    },
    handshakeState() {
      return "ok";
    },
    start(opts) {
      sent.push({ method: "start", opts });
    },
    stop(opts) {
      sent.push({ method: "stop", opts });
    },
    cancelMessage(opts) {
      sent.push({ method: "cancelMessage", opts });
    },
    resumeQueue(opts) {
      sent.push({ method: "resumeQueue", opts });
    }
  };
}

function makeHistoryStoreStub() {
  const prompts = [];
  return {
    prompts,
    setLastActive: async () => {},
    recordPrompt: async (conversationId, runId, text) => {
      prompts.push({ conversationId, runId, text });
    },
    upsert: async () => {},
    flush() {},
    promptsFor: async () => new Map(),
    get: async () => null,
    list: async () => []
  };
}

function makeController({ requestTimeoutMs = 30 } = {}) {
  const protocol = makeProtocolStub();
  const historyStore = makeHistoryStoreStub();
  const controller = new PanelController({
    protocolClient: protocol,
    historyStore,
    profileCache: { read: async () => ({}), onChange() {} },
    identity: async () => ({ installationId: null, connectionId: null }),
    scope: () => "scope-1",
    requestTimeoutMs
  });
  const model = new ConversationModel("conv1");
  controller.models.set("conv1", model);
  controller.currentConversationId = "conv1";
  return { controller, model, protocol, historyStore };
}

function userItems(model) {
  return model.items.filter((i) => i.kind === "user");
}

// ==========================================================================
console.log("== queued send: ack binds the optimistic echo, never a second bubble ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("câu hỏi khi đang chạy");
  model.bindQueuedAck({ messageId: 12, mode: "queue", state: "pending" });
  ok(userItems(model).length === 1, "the just-sent echo is bound to the queue entry, not duplicated");
  ok(userItems(model)[0].messageId === 12, "the item carries the entry's messageId");
  ok(userItems(model)[0].queueState === "pending", "...and its live state");

  // The same message ALSO arrives as a live stream_event (design.md decision 9).
  model.applyEvent({ type: "message_queued", messageId: 12, mode: "queue", submission: { text: "câu hỏi khi đang chạy" } });
  ok(userItems(model).length === 1, "the live message_queued event does not add a second copy");

  // And with the opposite arrival order (event first, ack second).
  const m2 = new ConversationModel("c2");
  m2.addLocalUserMessage("thứ tự ngược");
  m2.applyEvent({ type: "message_queued", messageId: 4, mode: "queue", submission: { text: "thứ tự ngược" } });
  m2.bindQueuedAck({ messageId: 4, mode: "queue", state: "pending" });
  ok(userItems(m2).length === 1 && userItems(m2)[0].messageId === 4, "event-before-ack converges on the same single item");

  // A retried send (idempotent ack) resolves to the existing entry.
  model.addLocalUserMessage("câu hỏi khi đang chạy");
  model.bindQueuedAck({ messageId: 12, mode: "queue", state: "pending", idempotent: true });
  ok(userItems(model).length === 1, "an idempotent retry ack leaves exactly one bubble for that message");
  ok(userItems(model)[0].text === "câu hỏi khi đang chạy", "...and it is the original one");
}

console.log("\n== claim binds the queued message to its run: one bubble, no placeholder twin ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("tin nhắn xếp hàng");
  model.bindQueuedAck({ messageId: 7, mode: "queue", state: "pending" });
  model.applyEvent({ type: "message_claimed", messageId: 7, runId: "run-a" });
  model.applyEvent({ type: "run_created", runId: "run-a", seq: 8 });
  model.applyEvent({ type: "run_queued", runId: "run-a", seq: 9 });
  model.applyEvent({ type: "run_started", runId: "run-a", seq: 10 });
  ok(userItems(model).length === 1, "the run the message was claimed for does not create a second user item");
  ok(userItems(model)[0].runId === "run-a", "the bubble is bound to the claiming run");
  ok(userItems(model)[0].queueState === "dispatching", "a claimed message reads as about to run");
  model.applyEvent({ type: "message_consumed", messageId: 7, runId: "run-a", seq: 11 });
  ok(userItems(model)[0].queueState === null, "once consumed, the run's own state is what describes it (no chip)");
  ok(model.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.STREAMING, "and the header pill keeps describing the run");
}

console.log("\n== terminal outcomes are rendered truthfully and only when the host says so ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("hủy tôi");
  model.bindQueuedAck({ messageId: 3, mode: "queue", state: "pending" });
  model.applyEvent({ type: "message_cancelled", messageId: 3, reason: "user_cancelled" });
  ok(userItems(model)[0].queueState === "cancelled", "a cancelled message says so");
  ok(userItems(model)[0].queueError === "user_cancelled", "...carrying the host's reason");

  const requeued = new ConversationModel("c2");
  requeued.addLocalUserMessage("quay lại hàng đợi");
  requeued.bindQueuedAck({ messageId: 5, mode: "queue", state: "dispatching" });
  requeued.applyEvent({ type: "message_claimed", messageId: 5, runId: "run-x" });
  requeued.applyEvent({ type: "message_requeued", messageId: 5, reason: "restart_before_start" });
  ok(userItems(requeued)[0].queueState === "pending", "a requeued message is pending again");
  ok(userItems(requeued)[0].runId === null, "...with the abandoned claim's runId dropped, so the next claim binds the SAME bubble");
  requeued.applyEvent({ type: "message_claimed", messageId: 5, runId: "run-y" });
  requeued.applyEvent({ type: "run_created", runId: "run-y", seq: 20 });
  ok(userItems(requeued).length === 1 && userItems(requeued)[0].runId === "run-y", "the second claim binds that one bubble, not a new copy");

  const failed = new ConversationModel("c3");
  failed.addLocalUserMessage("lỗi");
  failed.bindQueuedAck({ messageId: 9, mode: "queue", state: "pending" });
  failed.applyEvent({ type: "message_failed", messageId: 9, reason: "run_stopped_before_start" });
  ok(userItems(failed)[0].queueState === "failed", "a failed message is distinguishable from a cancelled one");
}

console.log("\n== interrupt fallback is disclosed on the message it concerns ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("chạy ngay đi");
  model.bindQueuedAck({ messageId: 11, mode: "interrupt", state: "pending" });
  ok(userItems(model)[0].interruptFellBack === false, "no fallback note before the host reports one");
  ok(userItems(model)[0].queueMode === "interrupt", "the mode the operator chose is kept (so the attempt stays reflected after a reload too)");
  model.applyEvent({ type: "message_interrupt_fallback", messageId: 11 });
  ok(userItems(model)[0].interruptFellBack === true, "message_interrupt_fallback marks exactly that message");
  ok(userItems(model)[0].queueState === "pending", "...which still runs later, so it reads as waiting");
}

console.log("\n== a refused submission is marked as never accepted, and nothing else changes ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("tin nhắn bị từ chối");
  model.markSendRefused("queue_full");
  const item = userItems(model)[0];
  ok(item.queueState === "failed" && item.queueError === "queue_full", "the bubble says the message was not accepted, with the host's reason");
  ok(item.messageId === null, "a refused message never claims a queue entry");
  ok(userItems(model).length === 1, "the operator's text stays visible in the transcript (nothing typed is lost)");
}

console.log("\n== paused drain: durable flag + resume control state ==");
{
  const model = new ConversationModel("c1");
  ok(model.queuePaused === false, "a fresh conversation is not paused");
  model.applyEvent({ type: "message_queue_paused", reason: "user_stop" });
  ok(model.queuePaused === true, "message_queue_paused sets the paused state Stop's intervention implies");
  model.applyEvent({ type: "message_queue_resumed", reason: "user_action" });
  ok(model.queuePaused === false, "message_queue_resumed clears it");
}

console.log("\n== reload restore: one render per message, from the host's authoritative state ==");
{
  const model = new ConversationModel("c1");
  const snapshot = {
    conversationId: "c1",
    lastSeq: 20,
    firstSeq: 1,
    hasOlder: false,
    meta: {
      messageQueue: [{ messageId: 20, mode: "queue", state: "pending", claimedByRunId: null, idempotencyKey: null, enqueuedAt: 1 }],
      queuePaused: true,
      successorMessageId: null
    },
    events: [
      { seq: 18, type: "run_created", runId: "run-1", ts: 100 },
      { seq: 19, type: "run_started", runId: "run-1", ts: 110 },
      { seq: 20, type: "message_queued", messageId: 20, mode: "queue", submission: { text: "câu hỏi đang chờ" }, ts: 120 }
    ]
  };
  model.applySnapshot(snapshot);
  const queued = userItems(model).filter((i) => i.messageId === 20);
  ok(queued.length === 1, "a reloaded pending message is rendered exactly once");
  ok(queued[0].text === "câu hỏi đang chờ", "its text comes from the durable message_queued event (never re-resolved, never a placeholder)");
  ok(queued[0].queueState === "pending" && queued[0].runId === null, "and its pending state from the host's live queue list");
  ok(queued[0].queueMode === "queue", "the submission's mode is restored with it (the message_queued event is the one text/source for it)");
  ok(model.queuePaused === true, "the paused flag is restored from meta");

  // The same conversation reloaded AGAIN (a second snapshot) must not double it.
  model.applySnapshot(snapshot);
  ok(userItems(model).filter((i) => i.messageId === 20).length === 1, "a second rebuild still holds exactly one copy");

  // Claimed + dispatching: the entry is live, the claim event is in the window.
  const dispatching = new ConversationModel("c2");
  dispatching.applySnapshot({
    conversationId: "c2",
    lastSeq: 32,
    firstSeq: 1,
    hasOlder: false,
    meta: {
      messageQueue: [{ messageId: 30, mode: "queue", state: "dispatching", claimedByRunId: "run-2", idempotencyKey: null, enqueuedAt: 1 }],
      queuePaused: false,
      successorMessageId: null
    },
    events: [
      { seq: 30, type: "message_queued", messageId: 30, mode: "queue", submission: { text: "sắp chạy" }, ts: 100 },
      { seq: 31, type: "message_claimed", messageId: 30, runId: "run-2", ts: 110 },
      { seq: 32, type: "run_created", runId: "run-2", ts: 120 }
    ]
  });
  const claimed = userItems(dispatching).filter((i) => i.messageId === 30);
  ok(claimed.length === 1, "a reloaded claimed message is still one bubble");
  ok(claimed[0].runId === "run-2" && claimed[0].queueState === "dispatching", "...bound to its run and reading as about to run");
  ok(userItems(dispatching).filter((i) => i.runId === "run-2").length === 1, "the run's own rebuild path creates no second user item");

  // A message the host no longer lists, with its terminal event outside this
  // window: the panel drops the chip rather than claiming a state it cannot see.
  const stale = new ConversationModel("c3");
  stale.addLocalUserMessage("không còn trong hàng đợi");
  stale.bindQueuedAck({ messageId: 40, mode: "queue", state: "pending" });
  stale.applySnapshot({
    conversationId: "c3",
    lastSeq: 41,
    firstSeq: 41,
    hasOlder: true,
    meta: { messageQueue: [], queuePaused: false, successorMessageId: null },
    events: []
  });
  ok(userItems(stale).length === 0, "an event outside the window is not fabricated into a placeholder bubble");

  // A TERMINAL outcome in the window survives the reload even though the host
  // no longer lists the entry: absence from the live list must not erase a
  // cancelled/failed chip the event stream still proves.
  const cancelled = new ConversationModel("c4");
  cancelled.applySnapshot({
    conversationId: "c4",
    lastSeq: 51,
    firstSeq: 50,
    hasOlder: false,
    meta: { messageQueue: [], queuePaused: false, successorMessageId: null },
    events: [
      { seq: 50, type: "message_queued", messageId: 50, mode: "queue", submission: { text: "đã hủy" }, ts: 100 },
      { seq: 51, type: "message_cancelled", messageId: 50, reason: "user_cancelled", ts: 110 }
    ]
  });
  ok(cancelled.items[0].queueState === "cancelled", "a cancelled message stays cancelled after a reload (no assumed reset)");
}

console.log("\n== unknown/newer event types stay inert (an older panel must not fail) ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("vẫn ổn");
  model.applyEvent({ type: "message_queue_compacted", messageId: 1, whatever: true });
  ok(userItems(model).length === 1, "an unrecognized event neither crashes nor alters the transcript");
}

// ==========================================================================
console.log("\n== controller: Send carries mode + idempotency key, and the queued ack settles it ==");
{
  const { controller, model, protocol } = makeController();
  const outcome = controller.sendMessage("xin chào", { tabScope: "any" });
  const sent = protocol.sent[0];
  ok(sent.method === "start", "Send goes out as a START");
  ok(sent.opts.mode === "queue", "with the default queue mode");
  ok(typeof sent.opts.idempotencyKey === "string" && sent.opts.idempotencyKey.length > 0, "and an idempotency key, so a duplicate delivery resolves to one entry");
  ok(userItems(model).length === 1, "the message appears in the transcript immediately");

  protocol.deliver({
    type: "start",
    conversationId: "conv1",
    accepted: true,
    queued: true,
    entry: { messageId: 77, mode: "queue", state: "pending", enqueuedAt: 1 }
  });
  const settled = await outcome;
  ok(settled.accepted === true && settled.queued === true && settled.messageId === 77, "the queued ack resolves the send with the entry identity");
  ok(userItems(model)[0].messageId === 77 && userItems(model)[0].queueState === "pending", "and binds the bubble to that entry");
  ok(userItems(model).length === 1, "no second bubble");
}

console.log("\n== controller: an interrupt send asks for run-now, the default never does ==");
{
  const { controller, protocol } = makeController();
  controller.sendMessage("chạy ngay", { mode: "interrupt" });
  ok(protocol.sent[0].opts.mode === "interrupt", "run-now reaches the wire as mode:\"interrupt\"");
  const { controller: c2, protocol: p2 } = makeController();
  c2.sendMessage("bình thường");
  ok(p2.sent[0].opts.mode === "queue", "an ordinary send never claims an interrupt it did not ask for");
}

console.log("\n== controller: a queue_full refusal settles the send and preserves the draft's text ==");
{
  const { controller, model, protocol } = makeController();
  const outcome = controller.sendMessage("tin nhắn thứ 21");
  protocol.deliver({ type: "error", conversationId: "conv1", reason: "queue_full", limit: 20 });
  const settled = await outcome;
  ok(settled.accepted === false && settled.reason === "queue_full" && settled.limit === 20, "the refusal is reported with the host's limit");
  ok(userItems(model)[0].queueState === "failed" && userItems(model)[0].queueError === "queue_full", "the message is marked as never accepted");
  ok(!model.connectionError, "a full queue is not presented as a connection error");

  // The composer side of that same contract, driven for real.
  const fakeEl = { composerInput: { value: "" } };
  const fn = compile([extract("restoreRefusedDraft"), extract("sendRefusalNotice")].join("\n\n"), {
    el: fakeEl,
    autoGrow: () => {},
    clearAttachmentError: () => {},
    showAttachmentError: (m) => {
      fn.shown = m;
    },
    updateSendEnabled: () => {}
  }, "restoreRefusedDraft");
  fn("tin nhắn thứ 21", { accepted: false, reason: "queue_full", limit: 20 });
  ok(fakeEl.composerInput.value === "tin nhắn thứ 21", "the refused text goes back into the composer");
  ok(typeof fn.shown === "string" && fn.shown.includes("20"), "and the refusal reason names the queue bound");
  fakeEl.composerInput.value = "bản nháp mới";
  fn("tin nhắn thứ 21", { accepted: false, reason: "queue_full", limit: 20 });
  ok(fakeEl.composerInput.value === "bản nháp mới", "a newer draft is never clobbered by a late refusal");
}

console.log("\n== controller: cancel is refused honestly once the next turn has claimed the message ==");
{
  const { controller, model, protocol } = makeController();
  controller.sendMessage("hủy được không");
  protocol.deliver({
    type: "start",
    conversationId: "conv1",
    accepted: true,
    queued: true,
    entry: { messageId: 5, mode: "queue", state: "pending", enqueuedAt: 1 }
  });
  const pendingCancel = controller.cancelQueuedMessage(5);
  const req = protocol.sent.find((s) => s.method === "cancelMessage");
  ok(Boolean(req) && req.opts.messageId === 5 && typeof req.opts.requestId === "string", "cancel sends cancel_message with the messageId and a requestId");
  protocol.deliver({ type: "cancel_message", requestId: req.opts.requestId, ok: false, reason: "already_claimed", state: "dispatching" });
  const refused = await pendingCancel;
  ok(refused.ok === false && refused.reason === "already_claimed", "the refusal is reported to the caller");
  ok(userItems(model)[0].queueState === "dispatching", "and the disclosed state is what the message shows");

  const acceptedCancel = controller.cancelQueuedMessage(5);
  const req2 = protocol.sent.filter((s) => s.method === "cancelMessage").pop();
  protocol.deliver({ type: "cancel_message", requestId: req2.opts.requestId, ok: true, messageId: 5 });
  await acceptedCancel;
  ok(userItems(model)[0].queueState === "cancelled", "an accepted cancel reads as cancelled even before the event is replayed");
}

console.log("\n== controller: resume is offered while paused and only a confirmed answer unpauses ==");
{
  const { controller, model, protocol } = makeController();
  model.applyEvent({ type: "message_queue_paused", reason: "user_stop" });
  model.addLocalUserMessage("chờ đấy");
  model.bindQueuedAck({ messageId: 3, mode: "queue", state: "pending" });
  ok(model.queuePaused === true, "paused with a pending message the operator must not lose");

  const unanswered = controller.resumeQueue();
  const req = protocol.sent.find((s) => s.method === "resumeQueue");
  ok(Boolean(req) && typeof req.opts.requestId === "string", "resume sends resume_queue with a requestId");
  const timeoutOutcome = await unanswered; // no reply is delivered -> times out
  ok(timeoutOutcome === null, "an unanswered resume reports nothing back");
  ok(model.queuePaused === true, "and never claims the queue resumed");

  const answered = controller.resumeQueue();
  const req2 = protocol.sent.filter((s) => s.method === "resumeQueue").pop();
  protocol.deliver({ type: "resume_queue", requestId: req2.opts.requestId, ok: true });
  await answered;
  ok(model.queuePaused === false, "a confirmed resume clears the paused state");
}

console.log("\n== controller: a dropped connection settles the send instead of leaving it hanging ==");
{
  const { controller, model, protocol } = makeController();
  const outcome = controller.sendMessage("mất kết nối");
  protocol.fireDisconnect();
  const settled = await outcome;
  ok(settled.accepted === false && settled.reason === "host_unavailable", "the send is settled as not accepted");
  ok(userItems(model)[0].queueState === "failed", "and the message says so rather than claiming a queue entry");
}

console.log("\n== controller: the ordinary run path is unchanged (a runId still binds and records) ==");
{
  const { controller, model, protocol, historyStore } = makeController();
  const outcome = controller.sendMessage("câu hỏi bình thường");
  protocol.deliver({ type: "start", conversationId: "conv1", runId: "run-9", accepted: true, queued: false });
  const settled = await outcome;
  ok(settled.accepted === true && settled.runId === "run-9", "the immediate-run ack still resolves with the runId");
  ok(userItems(model)[0].runId === "run-9", "the echo is bound to it");
  ok(historyStore.prompts.some((p) => p.runId === "run-9" && p.text === "câu hỏi bình thường"), "and the local prompt echo is still recorded");
  ok(userItems(model)[0].queueState === null, "an immediately-started message carries no queue chip");
}

// ==========================================================================
console.log("\n== rendering: each state shows its own chip, cancel only while pending ==");
{
  const pending = userItemRender.renderUserItemHtml({ kind: "user", text: "chờ", messageId: 12, queueState: "pending" });
  ok(pending.includes(MESSAGE_QUEUE_LABEL_VI.pending), "a pending message is labelled \"Đang chờ lượt\"");
  ok(pending.includes('data-cancel-message-id="12"'), "...and carries a cancel control carrying the entry identity");
  ok(/class="[^"]*btn[^"]*"/.test(pending), "...as a real button (keyboard operable)");

  const dispatching = userItemRender.renderUserItemHtml({ kind: "user", text: "sắp chạy", messageId: 12, queueState: "dispatching" });
  ok(dispatching.includes(MESSAGE_QUEUE_LABEL_VI.dispatching), "a claimed message reads as about to run");
  ok(!dispatching.includes("data-cancel-message-id"), "...and its cancel affordance is gone (the run's Stop is what remains)");

  const cancelled = userItemRender.renderUserItemHtml({ kind: "user", text: "đã hủy", messageId: 12, queueState: "cancelled" });
  ok(cancelled.includes(MESSAGE_QUEUE_LABEL_VI.cancelled), "a cancelled message reads as cancelled");
  ok(!cancelled.includes("data-cancel-message-id"), "...with no cancel control either");

  const failed = userItemRender.renderUserItemHtml({ kind: "user", text: "lỗi", messageId: 12, queueState: "failed", queueError: "queue_full" });
  ok(failed.includes(MESSAGE_QUEUE_LABEL_VI.failed), "a failed message is distinguishable from a cancelled one");
  ok(failed.includes("Hàng đợi đã đầy"), "...and its tooltip carries the host's own reason");

  const fellBack = userItemRender.renderUserItemHtml({ kind: "user", text: "chạy ngay", messageId: 12, queueState: "pending", interruptFellBack: true });
  ok(fellBack.includes(QUEUE_FALLBACK_NOTE_VI), "an interrupt that fell back to the queue says so on the message");

  const runNow = userItemRender.renderUserItemHtml({ kind: "user", text: "chạy ngay", messageId: 12, queueState: "pending", queueMode: "interrupt" });
  ok(/title="[^"]*Chạy ngay/.test(runNow), "a message submitted with run-now records that intent on its chip (the attempt is reflected either way)");

  const plain = userItemRender.renderUserItemHtml({ kind: "user", text: "bình thường", runId: "r1" });
  ok(!plain.includes("msg-user-queue"), "an ordinary message renders exactly as before (no queue markup)");
  ok(plain.includes(escapeHtml("bình thường")) && plain.includes("msg-user-bubble"), "...still through the same bubble");
}

console.log("\n== rendering: queue state is structural, so a chip change repaints ==");
{
  const base = new ConversationModel("c1");
  base.addLocalUserMessage("tin nhắn");
  base.bindQueuedAck({ messageId: 2, mode: "queue", state: "pending" });
  const pendingSig = structureSignature(base, {});
  base.applyEvent({ type: "message_claimed", messageId: 2, runId: "r1" });
  const claimedSig = structureSignature(base, {});
  ok(pendingSig !== claimedSig, "pending -> dispatching changes the transcript's structure signature");
  base.applyEvent({ type: "message_consumed", messageId: 2, runId: "r1" });
  const consumedSig = structureSignature(base, {});
  ok(consumedSig !== claimedSig, "dispatching -> consumed does too (the chip leaves)");
  base.applyEvent({ type: "message_interrupt_fallback", messageId: 2 });
  ok(structureSignature(base, {}) !== consumedSig, "the interrupt-fallback note is part of the signature");
}

console.log("\n== composer gating: usable during a run, run-now gated with it, enhancement rule unchanged ==");
{
  const build = (running, value) => {
    const elStub = {
      composerInput: { value, disabled: undefined },
      btnSend: { disabled: undefined },
      btnEnhance: { disabled: undefined },
      btnRunNow: { disabled: undefined }
    };
    const fn = compile(extract("updateSendEnabled"), {
      el: elStub,
      panel: { currentPhase: () => (running ? RUN_PHASE.STREAMING : RUN_PHASE.READY), currentConversationId: "c1" },
      enhanceState: null,
      RUN_PHASE
    }, "updateSendEnabled");
    fn();
    return elStub;
  };

  const streaming = build(true, "soạn tin tiếp theo");
  ok(streaming.composerInput.disabled === false, "the composer stays usable while a run streams");
  ok(streaming.btnSend.disabled === false, "Send stays available (it queues), instead of acting as Stop");
  ok(streaming.btnRunNow.disabled === false, "run-now is offered for the same draft");
  ok(streaming.btnEnhance.disabled === true, "the enhancement control keeps its unchanged availability rule (disabled during a run)");

  const streamingEmpty = build(true, "   ");
  ok(streamingEmpty.btnSend.disabled === true && streamingEmpty.btnRunNow.disabled === true, "an empty draft enables neither send nor run-now");

  const idle = build(false, "soạn tin");
  ok(idle.btnSend.disabled === false && idle.btnRunNow.disabled === false, "idle with a draft: both are available");
  ok(idle.btnEnhance.disabled === false, "and enhancement is available again, exactly as before");
  ok(build(false, "/skill").btnEnhance.disabled === true, "a slash command still disables enhancement (dispatched text is never rewritten)");
  ok(build(false, "  ").btnEnhance.disabled === true, "an empty draft still disables enhancement");

  ok(!/function updateEnhanceEnabled/.test(SIDEPANEL_SRC), "no parallel gating function was introduced");
  ok(/el\.btnEnhance\.disabled = true;/.test(SIDEPANEL_SRC), "the run-state enhancement rule is still literally present");
}

console.log("\n== controls: Stop is its own control, run-now is explicit, the pause banner resumes ==");
{
  ok(/el\.btnRunNow\.addEventListener\("click", doSendRunNow\)/.test(SIDEPANEL_SRC), "run-now is wired to the interrupt dispatch");
  ok(/function doSendRunNow\(\)\s*\{[\s\S]*?pendingSendMode = "interrupt"/.test(SIDEPANEL_SRC), "...which is the one place that asks for mode interrupt");
  ok(/async function doSend\(\)\s*\{/.test(SIDEPANEL_SRC), "doSend() itself keeps its parameterless signature (pinned by the existing structural tests and the shared extractor)");
  ok(/el\.btnStop\.addEventListener\("click", \(\) => \{[\s\S]*?panel\.stop\("user_stop"\)/.test(SIDEPANEL_SRC), "Stop is a control of its own and stops the run");
  ok(
    /el\.btnRunNow\.style\.display = running \? "" : "none"/.test(SIDEPANEL_SRC) &&
      /el\.btnStop\.style\.display = running \? "" : "none"/.test(SIDEPANEL_SRC),
    "both appear only while a run is active"
  );
  ok(
    /el\.btnRunNow = queueControls\.btnRunNow/.test(SIDEPANEL_SRC) && /el\.btnStop = queueControls\.btnStop/.test(SIDEPANEL_SRC),
    "both controls are reached through the el map, so their listeners attach to the nodes actually in the row"
  );
  ok(/btnRunNow\.setAttribute\("aria-label"/.test(SIDEPANEL_SRC) && /btnRunNow\.setAttribute\("title"/.test(SIDEPANEL_SRC), "and is named/described for keyboard and assistive use");
  ok(/e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && e\.key === "Enter"/.test(SIDEPANEL_SRC), "Ctrl/Cmd+Enter reaches run-now from the composer too");
  ok(/el\.btnResumeQueue\.addEventListener\("click", \(\) => \{[\s\S]*?panel\.resumeQueue\(\)/.test(SIDEPANEL_SRC), "the paused banner's control resumes the drain");
  ok(/QUEUE_PAUSED_NOTE_VI/.test(SIDEPANEL_SRC), "the banner carries the paused copy");
  ok(
    /el\.queuePausedBanner\.style\.display = model && model\.queuePaused === true \? "" : "none"/.test(SIDEPANEL_SRC),
    "and it is shown from the host's durable paused flag, never from optimism"
  );
  ok(/wireQueuedMessageControls/.test(SIDEPANEL_SRC) && /panel\.cancelQueuedMessage\(messageId\)/.test(SIDEPANEL_SRC), "the rendered cancel control sends cancel_message through the controller");
  const doSendBlock = SIDEPANEL_SRC.match(/async function doSend\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  ok(!/panel\.stop\(/.test(doSendBlock), "doSend no longer stops a run on Send -- submitting queues instead");
  ok(/mode\b/.test(doSendBlock) && /await panel\.sendMessage\(/.test(doSendBlock), "and it forwards its mode to the controller");
}

console.log("\n== controls: real element construction (fake DOM) ==");
{
  // The shipped constructor, driven against test/_fake-dom.mjs exactly as it
  // runs in the panel: the buttons must actually land in the action row (a
  // detached control would be unreachable), start hidden, and carry an
  // accessible name.
  const doc = createDocument();
  const actions = doc.createElement("div");
  const enhance = doc.createElement("button");
  const send = doc.createElement("button");
  actions.appendChild(enhance);
  actions.appendChild(send);
  const composerWrap = doc.createElement("div");
  const composer = doc.createElement("div");
  const composerInput = doc.createElement("textarea");
  composer.appendChild(composerInput);
  composerWrap.appendChild(composer);

  const elStub = { btnSend: send, composerWrap, composerInput };
  const install = compile(extract("installQueueControls"), {
    document: doc,
    el: elStub,
    iconMarkup,
    QUEUE_PAUSED_NOTE_VI
  }, "installQueueControls");
  const controls = install();

  ok(
    controls.btnStop.parentNode === actions && controls.btnRunNow.parentNode === actions,
    "Stop and run-now are inserted into the composer's action row"
  );
  ok(
    actions.children.indexOf(controls.btnRunNow) === actions.children.indexOf(controls.btnStop) - 1 &&
      actions.children.indexOf(controls.btnStop) === actions.children.indexOf(send) - 1,
    "...both immediately before Send, run-now first (so Send keeps the right-hand position)"
  );
  ok(
    controls.btnStop.style.display === "none" && controls.btnRunNow.style.display === "none",
    "both start hidden (no run is active at boot) via an inline display, the only mechanism that beats their own class display"
  );
  ok(controls.btnStop.getAttribute("id") === "btn-stop" && controls.btnStop.getAttribute("aria-label") === "Dừng", "Stop is identified and named");
  ok(controls.btnStop.className.includes("btn-icon") && controls.btnStop.className.includes("is-danger-solid"), "Stop reuses the existing icon/danger primitives");
  ok(controls.btnRunNow.getAttribute("id") === "btn-run-now" && controls.btnRunNow.textContent === "Chạy ngay", "run-now is identified and labelled in Vietnamese");
  ok(/btn/.test(controls.btnRunNow.className), "run-now reuses the shared small-button primitive rather than inventing a style");
  ok(controls.banner.parentNode === composerWrap, "the paused banner sits in the composer wrap, above the composer");
  ok(controls.banner.style.display === "none", "...and starts hidden");
  ok(controls.banner.children[0].textContent === QUEUE_PAUSED_NOTE_VI, "it carries the paused copy");
  ok(controls.resumeButton.textContent === "Tiếp tục" && controls.resumeButton.getAttribute("id") === "btn-resume-queue", "with the resume control as a real button");
}

console.log(fail === 0 ? "\nALL SIDEPANEL MESSAGE-QUEUE TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

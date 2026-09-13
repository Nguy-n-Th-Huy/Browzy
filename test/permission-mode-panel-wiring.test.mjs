#!/usr/bin/env node
// openspec/changes/add-permission-modes-and-threat-signals — the panel-side
// wiring for tasks 7.2/7.3/2.4: conversation-model.js's protectedCategory/
// rememberable/pendingDownloadDecision state, panel-controller.js's
// remember-forwarding, download-decision responder, and mode-change
// invalidation, and protocol-client.js's wire shaping for both. Exercises
// the real ES modules directly (no chrome.* dependency in any of them),
// against a fake chrome.runtime.Port transport the same way
// test/sidepanel-protocol-client.test.mjs already does.
//
// Run: node test/permission-mode-panel-wiring.test.mjs

import { ConversationModel } from "../extension/sidepanel/conversation-model.js";
import { ProtocolClient } from "../extension/sidepanel/protocol-client.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";
import { HistoryStore } from "../extension/sidepanel/history-store.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeChromeStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(key) {
      delete data[key];
    }
  };
}

function fakePort() {
  const port = {
    sent: [],
    _msgListeners: [],
    _disconnectListeners: [],
    postMessage(msg) {
      port.sent.push(msg);
    },
    onMessage: { addListener: (fn) => port._msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port._disconnectListeners.push(fn) },
    disconnect() {},
    deliver(envelope) {
      for (const fn of port._msgListeners) fn({ type: "agent_msg", envelope });
    }
  };
  return port;
}

function makePanel() {
  const port = fakePort();
  const protocol = new ProtocolClient({ createTransport: () => port });
  protocol.connect();
  const panel = new PanelController({
    protocolClient: protocol,
    historyStore: new HistoryStore({ storage: fakeChromeStorage() }),
    profileCache: { read: async () => null },
    identity: async () => ({})
  });
  return { port, protocol, panel };
}

console.log("== conversation-model.js: approval_request carries protectedCategory/rememberable ==");
{
  const m = new ConversationModel("c1");
  m.applyEvent({ type: "approval_request", runId: "r1", action: "click_pay", target: { x: 1 }, requestId: "req1", protectedCategory: "credential", rememberable: false });
  ok(m.pendingApproval.protectedCategory === "credential", "protectedCategory is carried through onto pendingApproval");
  ok(m.pendingApproval.rememberable === false, "rememberable is carried through (false for a protected card)");
  m.clearPendingApproval();

  const m2 = new ConversationModel("c2");
  m2.applyEvent({ type: "approval_request", runId: "r2", action: "navigate", target: { url: "https://x" }, requestId: "req2", protectedCategory: null, rememberable: true });
  ok(m2.pendingApproval.protectedCategory === null, "protectedCategory is null for an ordinary (non-protected) card");
  ok(m2.pendingApproval.rememberable === true, "rememberable true is carried through for an ordinary card");

  const m3 = new ConversationModel("c3");
  m3.applyEvent({ type: "approval_request", runId: "r3", action: "x", target: {}, requestId: "req3" });
  ok(m3.pendingApproval.protectedCategory === null && m3.pendingApproval.rememberable === false, "missing fields default safely (null category, not rememberable) rather than throwing");
}

console.log("== conversation-model.js: pendingDownloadDecision is a distinct field from pendingApproval ==");
{
  const m = new ConversationModel("c4");
  m.setPendingDownloadDecision({ requestId: "dreq1", category: "download", filename: "a.exe", url: "https://x/a.exe", ts: Date.now() });
  ok(m.pendingDownloadDecision.requestId === "dreq1", "pendingDownloadDecision is set");
  ok(m.pendingApproval === null, "pendingApproval is untouched by a download decision — the two are never confused");
  ok(m.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.WAITING_FOR_PERMISSION, "a pending download decision reports the same waiting-for-permission phase an approval does");
  ok(m.isBusy() === false, "the busy indicator is suppressed while a download decision is outstanding, same as an approval");
  m.clearPendingDownloadDecision();
  ok(m.pendingDownloadDecision === null, "clearPendingDownloadDecision() clears it");

  m.recordDownloadNotice({ filename: "fast.txt", url: "https://x/fast.txt", outcome: "completed_before_pause", ts: Date.now() });
  const notice = m.items.find((i) => i.kind === "download_notice");
  ok(!!notice && notice.outcome === "completed_before_pause", "a download notice is recorded as an honest transcript item, not a decision");
}

console.log("== conversation-model.js: a run-teardown event clears a download decision that belongs to THAT run, not a different one (CRITICAL fix) ==");
{
  const m = new ConversationModel("c4b");
  m.setPendingDownloadDecision({ requestId: "dreq_stop", runId: "run_A", category: "download", filename: "a.exe", url: "https://x/a.exe", ts: Date.now() });
  // An unrelated run ending must never clear a different run's outstanding
  // download decision.
  m.applyEvent({ type: "run_stopped", runId: "run_B", reason: "user_stop" });
  ok(m.pendingDownloadDecision && m.pendingDownloadDecision.requestId === "dreq_stop", "a DIFFERENT run's teardown never clears this decision");

  // The run this decision actually belongs to stops — the whole point of
  // the fix: this used to never be cleared at all until the user answered.
  m.applyEvent({ type: "run_stopped", runId: "run_A", reason: "user_stop" });
  ok(m.pendingDownloadDecision === null, "Stop invalidates and clears an outstanding download decision for the run it belongs to");

  for (const eventType of ["run_done", "run_error", "run_interrupted_by_restart"]) {
    const m2 = new ConversationModel(`c4c_${eventType}`);
    m2.setPendingDownloadDecision({ requestId: `dreq_${eventType}`, runId: "run_X", category: "download", filename: "b.exe", url: "https://x/b.exe", ts: Date.now() });
    m2.applyEvent({ type: eventType, runId: "run_X" });
    ok(m2.pendingDownloadDecision === null, `${eventType} also invalidates and clears an outstanding download decision for the run it belongs to`);
  }
}

console.log("== conversation-model.js: recordDownloadDecision()/its replay case both add a permanent, deduplicated timeline item ==");
{
  const m = new ConversationModel("c4d");
  m.recordDownloadDecision({ requestId: "dreq_rec", decision: "allow", category: "download", filename: "invoice.pdf", url: "https://x/invoice.pdf" });
  const items1 = m.items.filter((i) => i.kind === "download_decision");
  ok(items1.length === 1 && items1[0].decision === "allow", "the LIVE record is added as a permanent transcript item the instant the user answers");

  // A later reconnect replaying the SAME durable event (host/agent/session/
  // manager.js's own idempotent append) must never duplicate the item the
  // live path already added.
  m.applyEvent({ type: "download_decision_recorded", requestId: "dreq_rec", decision: "allow", category: "download", filename: "invoice.pdf", url: "https://x/invoice.pdf" });
  ok(m.items.filter((i) => i.kind === "download_decision").length === 1, "a replayed durable record for the SAME requestId never duplicates the item");

  // A genuinely different decision (e.g. a second panel, or a pure replay
  // with no live path having run at all) still gets its own item.
  m.applyEvent({ type: "download_decision_recorded", requestId: "dreq_other", decision: "deny", category: "download", filename: "x.zip", url: "https://x/x.zip" });
  ok(m.items.filter((i) => i.kind === "download_decision").length === 2, "a DIFFERENT requestId's durable record still gets its own item");
}

console.log("== protocol-client.js: approvalDecision only sends remember when explicitly true ==");
{
  const { port, protocol } = makePanel();
  protocol.approvalDecision({ conversationId: "c1", decision: "approve", action: "a", target: {}, requestId: "req1" });
  ok(!("remember" in port.sent[0].envelope), "remember is omitted entirely when not requested");

  protocol.approvalDecision({ conversationId: "c1", decision: "approve", action: "a", target: {}, requestId: "req1", remember: true });
  ok(port.sent[1].envelope.remember === true, "remember:true is sent verbatim when explicitly requested");

  protocol.approvalDecision({ conversationId: "c1", decision: "deny", action: "a", target: {}, requestId: "req1", remember: false });
  ok(!("remember" in port.sent[2].envelope), "remember:false is never sent as false — omitted, matching 'ONLY when the user asked for it'");
}

console.log("== protocol-client.js: downloadDecision is its own local envelope type ==");
{
  const { port, protocol } = makePanel();
  protocol.downloadDecision({ requestId: "dreq1", decision: "allow" });
  const env = port.sent[0].envelope;
  ok(env.type === "download_decision" && env.requestId === "dreq1" && env.decision === "allow", "downloadDecision sends its own local, non-host-protocol envelope type");
}

console.log("== protocol-client.js: invalidateDownloadDecisions is its own local envelope type ==");
{
  const { port, protocol } = makePanel();
  protocol.invalidateDownloadDecisions("the permission mode changed; this decision was invalidated");
  const env = port.sent[0].envelope;
  ok(env.type === "download_decisions_invalidate" && env.reason === "the permission mode changed; this decision was invalidated", "invalidateDownloadDecisions sends its own local, non-host-protocol envelope type carrying the reason");
}

console.log("== panel-controller.js: respondApproval forwards remember only when the caller asked ==");
{
  const { port, panel } = makePanel();
  port.deliver({ type: "snapshot", conversationId: "conv1", lastSeq: 0, events: [] });
  port.deliver({
    type: "stream_event",
    conversationId: "conv1",
    runId: "run1",
    event: { type: "approval_request", requestId: "req1", action: "click", target: {}, protectedCategory: null, rememberable: true }
  });
  ok(panel.currentModel().pendingApproval.requestId === "req1", "the approval landed on the current conversation's model");

  panel.respondApproval("approve", { remember: true });
  const sentEnvelope = port.sent.find((m) => m.envelope.type === "approval_decision").envelope;
  ok(sentEnvelope.remember === true, "respondApproval forwards remember:true through to the wire");
  ok(panel.currentModel().pendingApproval === null, "the card is cleared immediately after responding");
}
{
  const { port, panel } = makePanel();
  port.deliver({ type: "snapshot", conversationId: "conv1", lastSeq: 0, events: [] });
  port.deliver({
    type: "stream_event",
    conversationId: "conv1",
    runId: "run1",
    event: { type: "approval_request", requestId: "req2", action: "pay", target: {}, protectedCategory: "credential", rememberable: false }
  });
  panel.respondApproval("approve");
  const sentEnvelope = port.sent.find((m) => m.envelope.type === "approval_decision").envelope;
  ok(!("remember" in sentEnvelope), "no remember option offered/used means nothing is sent — a protected card is never remembered");
}

console.log("== panel-controller.js: a late reply to an already-cleared approval is a no-op ==");
{
  const { port, panel } = makePanel();
  port.deliver({ type: "snapshot", conversationId: "conv1", lastSeq: 0, events: [] });
  port.deliver({
    type: "stream_event",
    conversationId: "conv1",
    runId: "run1",
    event: { type: "approval_request", requestId: "req3", action: "click", target: {}, protectedCategory: null, rememberable: true }
  });
  panel.currentModel().clearPendingApproval(); // simulates invalidateAllPendingApprovals() having already run
  const before = port.sent.length;
  panel.respondApproval("approve", { remember: true });
  ok(port.sent.length === before, "respondApproval sends nothing once the card is already gone — a late answer is rejected rather than applied");
}

console.log("== panel-controller.js: invalidateAllPendingApprovals() clears every open conversation's card (task 7.2) ==");
{
  const { port, panel } = makePanel();
  port.deliver({ type: "snapshot", conversationId: "convA", lastSeq: 0, events: [] });
  port.deliver({ type: "stream_event", conversationId: "convA", runId: "rA", event: { type: "approval_request", requestId: "reqA", action: "a", target: {} } });
  // A second, currently-not-shown conversation also has an outstanding card.
  panel._getOrCreateModel("convB").applyEvent({ type: "approval_request", runId: "rB", action: "b", target: {}, requestId: "reqB" });
  ok(panel.models.get("convA").pendingApproval && panel.models.get("convB").pendingApproval, "both conversations start with an outstanding card");

  // A download decision outstanding at the same time must be invalidated
  // too (CRITICAL fix) — both the panel's own view of it AND background.js's
  // side, via a new local download_decisions_invalidate message.
  panel._getOrCreateModel("convA").setPendingDownloadDecision({ requestId: "dreqA", runId: "rA", category: "download", filename: "a.exe", url: "https://x/a.exe", ts: Date.now() });

  panel.invalidateAllPendingApprovals();
  ok(panel.models.get("convA").pendingApproval === null, "the currently-shown conversation's card is cleared");
  ok(panel.models.get("convB").pendingApproval === null, "a card on a DIFFERENT, not-currently-shown conversation is also cleared — a mode change is companion-process-wide, not scoped to the visible tab");
  ok(panel.models.get("convA").pendingDownloadDecision === null, "an outstanding download decision is cleared by the SAME mode-change invalidation, not just an ordinary approval card");
  const invalidateMsg = port.sent.find((m) => m.envelope.type === "download_decisions_invalidate");
  ok(!!invalidateMsg, "background.js is told to forget every pending download decision too — clearing only the panel's OWN view would leave a stale entry there able to resume/cancel on a late reply");
}

console.log("== panel-controller.js: download_protected_decision / download_notice routing ==");
{
  const { port, panel } = makePanel();
  port.deliver({ type: "snapshot", conversationId: "conv1", lastSeq: 0, events: [] });
  port.deliver({
    type: "download_protected_decision",
    conversationId: "conv1",
    runId: "run1",
    requestId: "dreq1",
    category: "download",
    rememberable: false,
    filename: "invoice.pdf",
    url: "https://x/invoice.pdf"
  });
  const model = panel.models.get("conv1");
  ok(model.pendingDownloadDecision && model.pendingDownloadDecision.requestId === "dreq1", "a download_protected_decision envelope is routed to the matching conversation's model");
  ok(model.pendingDownloadDecision.runId === "run1", "the run it was raised for is carried through, so a later run-teardown event for THIS run can invalidate it");

  panel.respondDownloadDecision("allow");
  const env = port.sent.find((m) => m.envelope.type === "download_decision").envelope;
  ok(env.requestId === "dreq1" && env.decision === "allow", "respondDownloadDecision sends the local download_decision reply, never an approval_decision");
  ok(model.pendingDownloadDecision === null, "the card is cleared after responding");
  ok(model.items.some((i) => i.kind === "download_decision" && i.requestId === "dreq1"), "responding also records a permanent download_decision item in this conversation's own timeline immediately, not only on a later reconnect");

  port.deliver({ type: "download_notice", conversationId: "conv1", filename: "fast.txt", url: "https://x/fast.txt", outcome: "completed_before_pause" });
  ok(model.items.some((i) => i.kind === "download_notice"), "a download_notice envelope is recorded as a transcript item on the matching conversation");
}

console.log("== panel-controller.js: download_decision_invalidated clears the card, and only for a matching requestId (CRITICAL fix) ==");
{
  const { port, panel } = makePanel();
  port.deliver({ type: "snapshot", conversationId: "conv1", lastSeq: 0, events: [] });
  port.deliver({
    type: "download_protected_decision",
    conversationId: "conv1",
    runId: "run1",
    requestId: "dreq_stale",
    category: "download",
    filename: "a.exe",
    url: "https://x/a.exe"
  });
  const model = panel.models.get("conv1");
  ok(model.pendingDownloadDecision.requestId === "dreq_stale", "sanity: the card is showing before invalidation");

  // A DIFFERENT requestId being invalidated (e.g. a stale message about a
  // decision this panel never even saw) must never clear an unrelated,
  // still-live card.
  port.deliver({ type: "download_decision_invalidated", conversationId: "conv1", requestId: "dreq_unrelated" });
  ok(model.pendingDownloadDecision && model.pendingDownloadDecision.requestId === "dreq_stale", "an invalidation for a DIFFERENT requestId never clears this one");

  // background.js invalidates this run's decision (Stop, or a permission
  // mode change) — the panel must drop its card without waiting for the
  // user to respond, and a subsequent late Allow/Deny click must be a no-op.
  port.deliver({ type: "download_decision_invalidated", conversationId: "conv1", requestId: "dreq_stale", reason: "run run_stopped" });
  ok(model.pendingDownloadDecision === null, "the matching requestId's invalidation clears the card");

  const sentBefore = port.sent.length;
  panel.respondDownloadDecision("allow");
  ok(port.sent.length === sentBefore, "a late Allow click after invalidation sends nothing — respondDownloadDecision() no-ops exactly like respondApproval() already does for an already-cleared card");
}

console.log(fail === 0 ? "\nAll assertions passed." : `\n${fail} assertion(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);

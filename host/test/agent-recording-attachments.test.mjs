#!/usr/bin/env node
// tasks.md 6.1-6.5 (upgrade-agent-reliability-and-workflows, design.md
// decision 5): versioned recording attachment protocol + states, bounded
// redacted model-readable delivery path, idle-conversation claim + atomic
// pending reconciliation + idempotency, include-only-after-delivery-ack with
// submitted/unknown preserved across crash, and adversarial cases.
//
// Live attach/model-input QA (6.6) is explicitly out of scope here — no
// browser, no gateway — and stays unchecked in tasks.md.
//
// Run: node host/test/agent-recording-attachments.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RECORDING_ATTACHMENT_STATES,
  RecordingAttachmentsStore
} from "../agent/storage/recording-attachments.js";
import {
  MAX_RECORDING_DELIVERY_BYTES,
  MAX_RECORDING_DELIVERY_EVENTS,
  buildRecordingContentBlocks
} from "../agent/storage/recording-content.js";
import { PendingRecordingsStore } from "../agent/storage/pending-recordings.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { SessionManager } from "../agent/session/manager.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { validateRecordingAttach, AGENT_MESSAGE_TYPES } from "../agent/protocol.js";
import {
  attachmentStateInfo,
  validateAttachTarget
} from "../../extension/sidepanel/recordings-model.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-recattach-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function scratchFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ocic-recattach-")), "attachments.json");
}

// == 6.1: protocol + states ====================================================
console.log("== 6.1 versioned protocol and states ==");
{
  ok(AGENT_MESSAGE_TYPES.RECORDING_ATTACH === "recording_attach", "the claim has a named protocol message type");
  const v = validateRecordingAttach({ recording_id: "r1", conversation_id: "c1", idempotency_key: "k1" });
  ok(v.ok && v.claim.recordingId === "r1", "a well-formed claim validates (both naming conventions)");
  ok(!validateRecordingAttach({ recording_id: "", conversation_id: "c", idempotency_key: "k" }).ok, "empty recording id fails closed");
  ok(!validateRecordingAttach({ recording_id: "r", conversation_id: "c" }).ok, "missing idempotency key fails closed — an unkeyed claim could never be deduped");
  ok(!validateRecordingAttach(null).ok, "null body fails closed");

  const store = new RecordingAttachmentsStore({ file: scratchFile() });
  const sel = store.select({ recordingId: "rec1", conversationId: "conv1", idempotencyKey: "key1" });
  ok(sel.ok && sel.record.state === "selected" && sel.record.schemaVersion === 1, "select persists a versioned `selected` record with owner + key + integrity slot");
  ok(sel.record.history.length === 1 && sel.record.deliveryEvidence === null, "a fresh claim carries history and an empty delivery-evidence slot (no model input yet)");
  const resel = store.select({ recordingId: "rec1", conversationId: "conv1", idempotencyKey: "key1" });
  ok(resel.ok && resel.idempotent === true, "re-select with the same key is idempotent, not a duplicate");
  const conflict = store.select({ recordingId: "rec2", conversationId: "conv1", idempotencyKey: "key1" });
  ok(conflict.ok === false && conflict.reason === "attachment_key_conflict", "the same key for a different recording is an explicit conflict, never a silent overwrite");
  ok(validateAttachTarget({ recordingId: "r", conversationId: "c" }).ok, "panel-side target validation passes for a complete target");
  ok(!validateAttachTarget({ recordingId: "r" }).ok, "panel-side target validation fails closed on a missing conversation");
}

// == 6.2: scoped model-readable delivery path ===================================
console.log("\n== 6.2 bounded redacted delivery path ==");
{
  ok(attachmentStateInfo("attached").tone === "pending" && /chưa thấy/.test(attachmentStateInfo("attached").detail), "attached is rendered as reference-only, never as model delivery");
  ok(attachmentStateInfo("included").tone === "ok", "only `included` reads as model input");
  ok(attachmentStateInfo("bogus").state === "unknown", "unknown state strings fail closed to `unknown`");

  const good = buildRecordingContentBlocks({
    recordingId: "rec1",
    conversationId: "conv1",
    ownerConversationId: "conv1",
    summary: "demo",
    transcript: "người dùng mở trang cài đặt",
    traceEvents: [
      { text: "mở trang", url: "https://a.example/" },
      { action: "click", detail: "nút lưu", apiKey: "SHOULD-NEVER-REACH-MODEL" }
    ]
  });
  ok(good.ok && good.blocks.length === 1 && good.blocks[0].type === "text", "an owned recording with content builds exactly one text block");
  ok(good.evidence.channel === "recording_content_blocks" && good.evidence.eventsIncluded === 2, "evidence names the scoped channel with kept/total counts");
  ok(!good.blocks[0].text.includes("SHOULD-NEVER-REACH-MODEL") && good.evidence.redactedFields.length > 0, "secret-like fields are redacted and REPORTED, not silently dropped");
  ok(!buildRecordingContentBlocks({ recordingId: "rec1", conversationId: "convX", ownerConversationId: "conv1", transcript: "hi" }).ok, "cross-conversation delivery fails owner_mismatch rather than leaking one conversation's demo into another");

  const big = buildRecordingContentBlocks({
    recordingId: "rec1",
    conversationId: "conv1",
    ownerConversationId: "conv1",
    traceEvents: Array.from({ length: 200 }, (_, i) => ({ text: `bước ${i} ` + "x".repeat(200) }))
  });
  ok(big.ok && big.evidence.truncated === true && big.evidence.eventsIncluded === MAX_RECORDING_DELIVERY_EVENTS, `oversized traces truncate at ${MAX_RECORDING_DELIVERY_EVENTS} events with an explicit flag, never silently and never claimed complete`);
  ok(Buffer.byteLength(big.blocks[0].text, "utf8") <= MAX_RECORDING_DELIVERY_BYTES + 200, `rendered bytes stay within ~${MAX_RECORDING_DELIVERY_BYTES} (byte cap, not character cap)`);

  const empty = buildRecordingContentBlocks({ recordingId: "rec1", conversationId: "conv1", ownerConversationId: "conv1" });
  ok(empty.ok === false && empty.reason === "recording_no_deliverable_content", "missing/empty artifacts fail with an exact reason — the transcript must not claim model access");
}

// == 6.3: claim, reconciliation, idempotency ====================================
console.log("\n== 6.3 idle-conversation claim and reconciliation ==");
{
  freshHome();
  const store = new TranscriptStore();
  const sm = new SessionManager({ store, lease: new BrowserLease(), approvals: new ApprovalRegistry() });
  const convA = sm.newConversation();
  const convB = sm.newConversation();
  sm.pendingRecordings.add({ recordingId: "recA", path: "/tmp/recA", schema: "v0", summary: "A", transcriptStatus: "ok" });

  const claim = await sm.claimPendingRecording({ recordingId: "recA", conversationId: convA, idempotencyKey: "kA" });
  ok(claim.ok && claim.record.state === "attached", "an idle conversation claims its pending recording: selected -> attached");
  ok(!sm.pendingRecordings.has("recA"), "the pending reference is removed only after `attached` is durably persisted");
  ok(store.eventsAfter(convA, 0).some((e) => e.type === "recording_attachment" && e.state === "attached"), "the claim is a transcript event, not silent bookkeeping");

  // Owner mismatch / racing claims.
  const cross = await sm.claimPendingRecording({ recordingId: "recA", conversationId: convB, idempotencyKey: "kA" });
  ok(cross.ok === false, "a second conversation cannot steal the claim via the same key (key conflict, not silent reroute)");
  sm.pendingRecordings.add({ recordingId: "recB", path: "/tmp/recB", schema: "v0", summary: "B", transcriptStatus: "ok" });
  const missing = await sm.claimPendingRecording({ recordingId: "recB", conversationId: "conv_nope", idempotencyKey: "kB" });
  ok(missing.ok === false && missing.reason === "unknown_conversation", "claim against an unknown conversation fails closed");

  // Active-run conversation is not idle: start a run on convB and try.
  const run = sm.startRun(convB, { tabScope: "any" });
  const busy = await sm.claimPendingRecording({ recordingId: "recB", conversationId: convB, idempotencyKey: "kB2" });
  ok(busy.ok === false && busy.reason === "conversation_not_idle", "a conversation with an active run cannot be selected — never routed into a live run");
  sm.finishRun(convB);
  void run;

  // Completion with no active run reconciles to the SELECTED owner.
  sm.pendingRecordings.add({ recordingId: "recC", path: "/tmp/recC", schema: "v0", summary: "C", transcriptStatus: "ok" });
  await sm.claimPendingRecording({ recordingId: "recC", conversationId: convA, idempotencyKey: "kC" });
  const routedTo = sm.recordRecordingComplete({ recordingId: "recC", path: "/tmp/recC", schema: "v0", summary: "C", transcriptStatus: "ok" });
  ok(routedTo === convA, "completion reconciles to the explicitly selected owner, not to an arbitrary run or the pending list");
  ok(store.eventsAfter(convA, 0).filter((e) => e.type === "recording_complete" && e.recordingId === "recC").length === 1, "the routed completion is appended exactly once (idempotent re-delivery)");

  // Duplicate delivery of the same completion.
  sm.recordRecordingComplete({ recordingId: "recC", path: "/tmp/recC", schema: "v0", summary: "C", transcriptStatus: "ok" });
  ok(store.eventsAfter(convA, 0).filter((e) => e.type === "recording_complete" && e.recordingId === "recC").length === 1, "a re-delivered completion never appends twice");

  // Deletion sweeps claims; unclaimed pending references survive (ownerless).
  sm.deleteConversation(convA);
  ok(sm.recordingAttachments.listForConversation(convA).length === 0, "deletion removes the conversation's recording claims — no resurrection");
  ok(sm.pendingRecordings.has("recB"), "unclaimed companion-wide pending references are untouched by one conversation's deletion");
}

// == 6.4: submitted/unknown survive crash; included needs evidence ==============
console.log("\n== 6.4 delivery acknowledgement and crash survival ==");
{
  const file = scratchFile();
  const s1 = new RecordingAttachmentsStore({ file });
  s1.select({ recordingId: "rX", conversationId: "cX", idempotencyKey: "kX" });
  await s1.attach("kX", { verify: () => ({ ok: true, integrity: { path: "/tmp/rX" } }) });
  s1.markSubmitted("kX");
  // Crash: a NEW store instance over the same file (fresh companion process).
  const s2 = new RecordingAttachmentsStore({ file });
  const afterCrash = s2.get("kX");
  ok(afterCrash && afterCrash.state === "submitted", "`submitted` survives a companion restart — still awaiting reconciliation, never auto-included");
  ok(s2.markIncluded("kX", null).ok === false, "`included` without delivery evidence is refused (transcript `included` is impossible without model-input evidence)");
  const inc = s2.markIncluded("kX", { channel: "recording_content_blocks", eventsIncluded: 3, eventsTotal: 3, truncated: false });
  ok(inc.ok && s2.get("kX").state === "included" && s2.get("kX").deliveryEvidence.eventsIncluded === 3, "`included` persists only with the exact delivery evidence attached");
  ok(s2.markFailed("kX", "too_late").ok === false, "an included claim can never be failed afterward");
}
{
  const file = scratchFile();
  const s1 = new RecordingAttachmentsStore({ file });
  s1.select({ recordingId: "rY", conversationId: "cY", idempotencyKey: "kY" });
  await s1.attach("kY", { verify: () => ({ ok: true }) });
  // Cancel path: the run died between submit and ack.
  s1.markSubmitted("kY");
  s1.markUnknown("kY", "run_cancelled_before_ack");
  const s2 = new RecordingAttachmentsStore({ file });
  ok(s2.get("kY").state === "unknown", "`unknown` survives cancellation/restart until explicitly reconciled — never zeroed, never included");
  ok(s2.markSubmitted("kY").ok === false, "a terminal `unknown` row is never re-submitted as if fresh");
}

// == 6.5 adversarial: redacted/missing/oversized/owner/lease ====================
console.log("\n== 6.5 adversarial cases ==");
{
  // Missing file content at delivery time.
  const missing = buildRecordingContentBlocks({ recordingId: "rM", conversationId: "cM", ownerConversationId: "cM", traceEvents: [], transcript: "  " });
  ok(missing.ok === false, "a recording whose files are missing/empty fails delivery — the transcript does not claim model access");
  // Fully-secret trace still delivers structure, redacted — not a failure.
  const allSecret = buildRecordingContentBlocks({
    recordingId: "rS",
    conversationId: "cS",
    ownerConversationId: "cS",
    traceEvents: [{ apiKey: "k", password: "p" }]
  });
  ok(allSecret.ok && !allSecret.blocks[0].text.includes('"k"') && /redacted/.test(allSecret.blocks[0].text), "an all-secret trace delivers a redacted view that SAYS it is redacted");
  // Lease contention: attach verify can reject on any live-run signal.
  const file = scratchFile();
  const s = new RecordingAttachmentsStore({ file });
  s.select({ recordingId: "rL", conversationId: "cL", idempotencyKey: "kL" });
  const contended = await s.attach("kL", { verify: () => ({ ok: false, reason: "lease_contention" }) });
  ok(contended.ok === false && s.get("kL").state === "failed" && contended.reason === "lease_contention", "a contended attach fails with the exact reason and parks the claim as failed, not half-attached");
}

console.log(fail === 0 ? "\nALL RECORDING ATTACHMENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

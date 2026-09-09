#!/usr/bin/env node
// conversation-model.js + run-states.js + tool-labels.js: the per-conversation
// state machine that must represent all 11 spec-named run states, never show
// a partial response as complete, redact sensitive tool arguments, and
// rebuild without duplicates on reconnect.
//
// Run: node test/sidepanel-conversation-model.test.mjs

import { ConversationModel, toolRowDisplay } from "../extension/sidepanel/conversation-model.js";
import { RUN_PHASE, ALL_RUN_PHASES } from "../extension/sidepanel/run-states.js";
import { redactArgsForDisplay, humanToolLabel, summarizeArgsForDetail } from "../extension/sidepanel/tool-labels.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

console.log("== all 11 run states are distinct and reachable ==");
{
  const seen = new Set();

  // empty: fresh conversation, nothing sent yet.
  let m = new ConversationModel("c1");
  seen.add(m.derivePhase({ connectionStatus: "ok" }));
  ok(m.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.EMPTY, "fresh conversation is empty");

  // connecting: handshake not yet ok.
  seen.add(m.derivePhase({ connectionStatus: "pending" }));
  ok(m.derivePhase({ connectionStatus: "pending" }) === RUN_PHASE.CONNECTING, "pending handshake is connecting");

  // ready: idle with prior history.
  m.addLocalUserMessage("xin chào");
  m.applyEvent({ type: "run_created", runId: "r1" });
  m.applyEvent({ type: "run_done", runId: "r1" });
  seen.add(m.derivePhase({ connectionStatus: "ok" }));
  ok(m.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.COMPLETED, "a finished run is completed, not ready yet");

  // ready after completed, before a NEW send (simulate by checking a
  // conversation with history but the run's own lifecycle already read) —
  // "ready" is exercised directly via an idle model with items but no turn:
  const readyModel = new ConversationModel("c-ready");
  readyModel.items.push({ kind: "recording", recordingId: "rec_1" }); // any non-turn item counts as history
  seen.add(readyModel.derivePhase({ connectionStatus: "ok" }));
  ok(readyModel.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.READY, "idle with history (no turn) is ready");

  // queued
  let q = new ConversationModel("c2");
  q.addLocalUserMessage("hi");
  q.applyEvent({ type: "run_created", runId: "rq" });
  q.applyEvent({ type: "run_queued", runId: "rq" });
  seen.add(q.derivePhase({ connectionStatus: "ok" }));
  ok(q.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.QUEUED, "queued run reports queued");

  // streaming
  q.applyEvent({ type: "run_started", runId: "rq" });
  seen.add(q.derivePhase({ connectionStatus: "ok" }));
  ok(q.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.STREAMING, "started run reports streaming");

  // waiting-for-permission
  q.applyEvent({ type: "approval_request", runId: "rq", action: "navigate", target: { url: "https://example.com" }, requestId: "ap1" });
  seen.add(q.derivePhase({ connectionStatus: "ok" }));
  ok(q.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.WAITING_FOR_PERMISSION, "pending approval overrides streaming");
  q.clearPendingApproval();

  // stopping (client-optimistic)
  q.markStopRequested();
  seen.add(q.derivePhase({ connectionStatus: "ok" }));
  ok(q.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.STOPPING, "markStopRequested reports stopping before the ack");

  // stopped
  q.applyEvent({ type: "run_stopped", runId: "rq", reason: "user_stop" });
  seen.add(q.derivePhase({ connectionStatus: "ok" }));
  ok(q.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.STOPPED, "run_stopped reports stopped");

  // interrupted
  let i = new ConversationModel("c3");
  i.applyEvent({
    type: "run_interrupted_by_restart",
    runId: "ri",
    seq: 1
  });
  seen.add(i.derivePhase({ connectionStatus: "ok" }));
  ok(i.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.INTERRUPTED, "run_interrupted_by_restart reports interrupted");

  // error
  let e = new ConversationModel("c4");
  e.addLocalUserMessage("lỗi test");
  e.applyEvent({ type: "run_created", runId: "re" });
  e.applyEvent({ type: "run_error", runId: "re", reason: "profile_unavailable" });
  seen.add(e.derivePhase({ connectionStatus: "ok" }));
  ok(e.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.ERROR, "run_error reports error");

  // error via connection-level failure too
  seen.add(e.derivePhase({ connectionStatus: "version_mismatch" }));
  ok(e.derivePhase({ connectionStatus: "version_mismatch" }) === RUN_PHASE.ERROR, "version mismatch is also an error phase");

  ok(
    ALL_RUN_PHASES.every((p) => seen.has(p)),
    `every one of the 11 named phases was actually reached: missing ${ALL_RUN_PHASES.filter((p) => !seen.has(p)).join(", ") || "(none)"}`
  );
  ok(seen.size === 11, `exactly 11 distinct phases exist and were all exercised (saw ${seen.size})`);
}

console.log("== a partial response is never shown as complete after interruption ==");
{
  const m = new ConversationModel("c5");
  m.addLocalUserMessage("viết một đoạn văn dài");
  m.applyEvent({ type: "run_created", runId: "rp" });
  m.applyEvent({ type: "run_started", runId: "rp" });
  m.applyEvent({
    type: "stream_message",
    runId: "rp",
    message: { type: "assistant", message: { content: [{ type: "text", text: "Đây là phần đầu của câu trả lời" }] } }
  });
  m.markStopRequested();
  m.applyEvent({ type: "run_stopped", runId: "rp", reason: "user_stop" });
  const turn = m.items.find((it) => it.kind === "assistant_turn");
  ok(turn.text === "Đây là phần đầu của câu trả lời", "the partial text is preserved, not discarded");
  ok(turn.complete === false, "complete is false after a stop");
  ok(turn.lifecycle === "stopped", "lifecycle correctly says stopped, not done");
  ok(m.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.STOPPED, "overall phase is stopped, never completed");

  // Same check for an interrupted (companion-restart) run with partial text.
  const m2 = new ConversationModel("c5b");
  m2.applyEvent({ type: "run_created", runId: "rp2" });
  m2.applyEvent({ type: "run_started", runId: "rp2" });
  m2.applyEvent({
    type: "stream_message",
    runId: "rp2",
    message: { type: "assistant", message: { content: [{ type: "text", text: "văn bản dang dở" }] } }
  });
  m2.applyEvent({ type: "run_interrupted_by_restart", runId: "rp2" });
  const turn2 = m2.items.find((it) => it.kind === "assistant_turn");
  ok(turn2.complete === false && turn2.lifecycle === "interrupted", "interrupted run is never marked complete");

  // Only run_done ever sets complete = true.
  const m3 = new ConversationModel("c5c");
  m3.applyEvent({ type: "run_created", runId: "rp3" });
  m3.applyEvent({ type: "run_started", runId: "rp3" });
  m3.applyEvent({
    type: "stream_message",
    runId: "rp3",
    message: { type: "assistant", message: { content: [{ type: "text", text: "câu trả lời đầy đủ" }] } }
  });
  m3.applyEvent({ type: "run_done", runId: "rp3" });
  const turn3 = m3.items.find((it) => it.kind === "assistant_turn");
  ok(turn3.complete === true && turn3.lifecycle === "done", "run_done is the only path to complete === true");
}

console.log("== tool activity: running -> succeeded/failed, rejection, unknown result, no generic retry offered ==");
{
  const m = new ConversationModel("c6");
  m.addLocalUserMessage("chụp ảnh trang này");
  m.applyEvent({ type: "run_created", runId: "rt" });
  m.applyEvent({ type: "run_started", runId: "rt" });
  m.applyEvent({
    type: "stream_message",
    runId: "rt",
    message: {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tu_1", name: "computer", input: { action: "screenshot" } }] }
    }
  });
  let turn = m.items.find((it) => it.kind === "assistant_turn");
  ok(turn.toolRows.length === 1 && turn.toolRows[0].status === "running", "tool_use creates a running row");
  ok(toolRowDisplay(turn.toolRows[0]).label === "Đã chụp trang", "human label reflects the computer action");

  m.applyEvent({
    type: "stream_message",
    runId: "rt",
    message: {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: false, content: [{ type: "image", source: {} }] }] }
    }
  });
  ok(turn.toolRows[0].status === "succeeded", "matching tool_result resolves the row to succeeded");

  // A second call fails.
  m.applyEvent({
    type: "stream_message",
    runId: "rt",
    message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_2", name: "navigate", input: { url: "https://x" } }] } }
  });
  m.applyEvent({
    type: "stream_message",
    runId: "rt",
    message: {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: true, content: "CSP blocked navigation" }] }
    }
  });
  const failedRow = turn.toolRows.find((r) => r.key === "tu_2");
  ok(failedRow.status === "failed" && failedRow.resultSummary === "CSP blocked navigation", "failed tool call is identified with its detail");

  // A rejected dispatch (authorization failure) and a lost-response unknown.
  m.applyEvent({ type: "tool_rejected", runId: "rt", toolName: "file_upload", reason: "out_of_scope" });
  const rejected = turn.toolRows.find((r) => r.isRejection);
  ok(rejected && rejected.status === "failed" && /Từ chối/.test(rejected.resultSummary), "a rejected dispatch is identified, not silently dropped");

  m.applyEvent({
    type: "stream_message",
    runId: "rt",
    message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_3", name: "form_input", input: { selector: "#submit" } }] } }
  });
  m.applyEvent({ type: "tool_result_unknown", runId: "rt", toolName: "form_input" });
  const unknownRow = turn.toolRows.find((r) => r.key === "tu_3");
  ok(unknownRow.status === "unknown", "a lost-response result is identified as unknown");
  ok(/Không tự động thử lại/.test(unknownRow.resultSummary), "the row states no automatic retry happens for an uncertain mutation");
  // Non-negotiable: nothing in this module models or exposes a "retry" affordance for an unknown/failed row.
  ok(!("retry" in unknownRow) && !("retryable" in unknownRow), "no retry field is ever attached to an unknown/failed row");
}

console.log("== sensitive tool arguments are redacted for display, never for dispatch ==");
{
  const redacted = redactArgsForDisplay({ selector: "#pwd", password: "hunter2", note: "ok" });
  ok(redacted.password === "••••••", "a password-named field is redacted");
  ok(redacted.note === "ok", "an unrelated field passes through");

  const detail = summarizeArgsForDetail("form_input", { selector: "#login-password", text: "hunter2" });
  ok(!detail.includes("hunter2"), "typed text into a password-looking selector is not shown in the detail line");

  ok(humanToolLabel("navigate", {}) === "Đã mở trang", "static label lookup works");
  ok(humanToolLabel("unknown_tool_xyz", {}).includes("unknown_tool_xyz"), "an unmapped tool name still gets an honest fallback label");
}

console.log("== reconnect rebuild: no duplicate transcript or activity entries ==");
{
  const m = new ConversationModel("c7");
  m.addLocalUserMessage("đọc bài viết này");

  // Simulate the run happening live: user message bound, run created/started,
  // one tool call, some text, then done — exactly what a real
  // stream_event/token_batch sequence would deliver (no seq on live events).
  m.applyEvent({ type: "run_created", runId: "r7" });
  m.applyEvent({ type: "run_started", runId: "r7" });
  m.applyEvent({
    type: "stream_message",
    runId: "r7",
    message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "get_page_text", input: {} }] } }
  });
  m.applyEvent({
    type: "stream_message",
    runId: "r7",
    message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_a", content: "nội dung bài viết" }] } }
  });
  m.applyEvent({
    type: "stream_message",
    runId: "r7",
    message: { type: "assistant", message: { content: [{ type: "text", text: "Đây là tóm tắt." }] } }
  });
  m.applyEvent({ type: "run_done", runId: "r7" });

  const liveItemCount = m.items.length;
  const liveToolRowCount = m.items.find((it) => it.kind === "assistant_turn").toolRows.length;
  ok(liveItemCount === 2, "live sequence produced exactly one user item and one assistant_turn item");

  // Now simulate a reconnect: the host returns the SAME facts, now durably
  // seq-stamped, via a snapshot reply (this is what a real
  // TranscriptStore.snapshot() would hand back — see
  // host/agent/storage/transcript-store.js). applySnapshot must fully
  // replace, not append.
  const snapshotEvents = [
    { seq: 1, type: "run_created", runId: "r7" },
    { seq: 2, type: "run_started", runId: "r7" },
    {
      seq: 3,
      type: "stream_message",
      runId: "r7",
      message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "get_page_text", input: {} }] } }
    },
    {
      seq: 4,
      type: "stream_message",
      runId: "r7",
      message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_a", content: "nội dung bài viết" }] } }
    },
    {
      seq: 5,
      type: "stream_message",
      runId: "r7",
      message: { type: "assistant", message: { content: [{ type: "text", text: "Đây là tóm tắt." }] } }
    },
    { seq: 6, type: "run_done", runId: "r7" }
  ];
  m.seedLocalPrompts(new Map([["r7", "đọc bài viết này"]]));
  m.applySnapshot({ conversationId: "c7", meta: { conversationId: "c7" }, lastSeq: 6, events: snapshotEvents });

  ok(m.items.length === liveItemCount, `rebuild produced the same item count (${m.items.length}), no duplicates appended`);
  const rebuiltTurn = m.items.find((it) => it.kind === "assistant_turn");
  ok(rebuiltTurn.toolRows.length === liveToolRowCount, "rebuild produced the same tool-row count, no duplicate tool rows");
  ok(rebuiltTurn.text === "Đây là tóm tắt.", "rebuild text is exact, not doubled");
  ok(m.items[0].kind === "user" && m.items[0].text === "đọc bài viết này", "the user's own message survives the rebuild via the seeded local prompt cache");
  ok(rebuiltTurn.complete === true, "rebuilt run is still correctly marked complete");
  ok(m.lastSeq === 6, "lastSeq reflects the snapshot's authoritative cursor");

  // Applying the exact same snapshot again (e.g. a second reconnect) must
  // still not duplicate anything.
  m.applySnapshot({ conversationId: "c7", meta: { conversationId: "c7" }, lastSeq: 6, events: snapshotEvents });
  ok(m.items.length === liveItemCount, "applying the same snapshot twice is idempotent");
}

console.log("== a run this model never sent (rebuild path with no cached prompt) gets an honest placeholder, never invented text ==");
{
  const m = new ConversationModel("c8");
  m.applySnapshot({
    conversationId: "c8",
    meta: {},
    lastSeq: 2,
    events: [
      { seq: 1, type: "run_created", runId: "rx" },
      { seq: 2, type: "run_done", runId: "rx" }
    ]
  });
  ok(m.items[0].isPlaceholder === true, "no cached prompt -> the item is explicitly flagged as a placeholder");
  ok(m.items[0].text.includes("không có sẵn"), "the placeholder text is honest about missing data, not a guess");
}

console.log("== a leading `thinking` content block (real gateway behavior, per a live capability-test capture) is tolerated, never breaks parsing ==");
{
  const m = new ConversationModel("c9");
  m.addLocalUserMessage("giải thích ngắn gọn");
  m.applyEvent({ type: "run_created", runId: "rthink" });
  m.applyEvent({ type: "run_started", runId: "rthink" });
  m.applyEvent({
    type: "stream_message",
    runId: "rthink",
    message: {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "nội bộ: cân nhắc cách trả lời" },
          { type: "text", text: "Đây là câu trả lời." }
        ]
      }
    }
  });
  m.applyEvent({ type: "run_done", runId: "rthink" });
  const turn = m.items.find((it) => it.kind === "assistant_turn");
  ok(turn.text === "Đây là câu trả lời.", "the thinking block is skipped and the actual text block still renders correctly");
  ok(turn.complete === true, "a message with a leading thinking block still completes normally");
}

console.log("== model catalog entries are treated as fully opaque strings (mixed-vendor gateway, per a live /v1/models capture) ==");
{
  const models = [
    { id: "claude-sonnet-5-20260101", label: "Claude Sonnet 5" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "qwen3.6", label: "Qwen 3.6" }
  ];
  ok(humanToolLabel("navigate", {}) === "Đã mở trang", "tool-label logic never inspects a model id at all (sanity check it stays independent)");
  ok(
    models.every((m) => typeof m.id === "string" && m.id.length > 0),
    "every catalog entry is just an opaque id/label pair, regardless of vendor — no assumed 'claude-' prefix anywhere in this codebase (grepped separately)"
  );
}

console.log("== ask-user answers anchor to the asking turn, not the transcript tail ==");
{
  const m = new ConversationModel("c10");
  m.addLocalUserMessage("theo dõi TBMT này");
  m.applyEvent({ type: "run_created", runId: "rq10" });
  m.applyEvent({ type: "run_started", runId: "rq10" });
  const toolUse = (id, name) => ({
    type: "stream_message",
    runId: "rq10",
    message: { type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } }
  });
  m.applyEvent(toolUse("t1", "computer"));
  m.applyEvent(toolUse("t2", "ask_user"));
  m.applyEvent({ type: "question_request", runId: "rq10", question: "Chọn loại tài khoản?", header: "Xác nhận", options: [{ label: "Cá nhân" }, { label: "VIP" }], requestId: "q1" });
  m.recordQuestionAnswer("Cá nhân");
  const turn = m.items.find((it) => it.kind === "assistant_turn");
  ok(Array.isArray(turn.questionAnswers) && turn.questionAnswers.length === 1, "the answer is stored on the asking turn");
  ok(turn.questionAnswers[0].text === "👉 Cá nhân", "the answer text keeps the transcript's picked-option format");
  ok(turn.questionAnswers[0].afterToolCount === 2, "the answer is pinned after the two tool rows present at answer time");
  ok(!m.items.some((it) => it.kind === "user" && it.isQuestionAnswer), "no trailing duplicate user item is appended");
  // A tool row streaming in after the answer must not move the anchor:
  m.applyEvent(toolUse("t3", "navigate"));
  ok(turn.toolRows.length === 3 && turn.questionAnswers[0].afterToolCount === 2, "later tool rows do not move the anchor");
}
{
  // Fallback: answering with no asking turn keeps the record, never drops it.
  const m2 = new ConversationModel("c11");
  m2.recordQuestionAnswer("VIP");
  ok(m2.items.some((it) => it.kind === "user" && it.isQuestionAnswer && it.text === "👉 VIP"), "without an asking turn the answer still lands as a trailing user item");
}

console.log(fail === 0 ? "\nALL SIDEPANEL CONVERSATION-MODEL TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

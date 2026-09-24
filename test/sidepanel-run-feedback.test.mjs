import assert from "node:assert/strict";
import { ConversationModel, toolRowDisplay } from "../extension/sidepanel/conversation-model.js";
import { iconMarkup } from "../extension/ui/icons.js";
import { cleanEvidence, evidenceHtml, renderReport, timelineCounts } from "../extension/sidepanel/run-feedback.js";
import { ArtifactClient } from "../extension/sidepanel/artifact-client.js";
import { chunkBuffer, flattenChunkedMessage } from "../host/agent/broker/chunked-transport.js";
import { extractFunction, compile } from "./_extract.mjs";
import { escapeHtml } from "../extension/sidepanel/markdown-lite.js";

const events = [
  { type: "run_started", runId: "r", ts: 1000 },
  { type: "jev_phase", runId: "r", phase: "verifying", step: 2, ts: 2000 },
  { type: "jev_memory", runId: "r", index: 1 },
  { type: "jev_step", runId: "r", step: 1, operation: "TYPE_TEXT", dispatched: true, evidence: { before: { observedAt: 1000, text: "<img onerror=bad>", screenshot: { status: "disabled" } }, after: { unavailableReason: "result_unknown" } } },
  { type: "jev_step", runId: "r", step: 2, operation: "DONE", dispatched: false }
];
const model = new ConversationModel("c");
events.forEach(e => model.applyEvent(e));
assert.equal(model.busyLabel(), "Đang kiểm chứng");
model.pendingApproval = {};
assert.equal(model.busyLabel(), null);
model.pendingApproval = null;
const turn = model.items.find(i => i.kind === "assistant_turn");
assert.deepEqual(timelineCounts(turn.toolRows), { operations: 1, activity: 2, legacy: 0 });
assert.deepEqual(timelineCounts([{ jev: { operation: "CLICK" } }]), { operations: 0, activity: 0, legacy: 1 });
const evidence = turn.toolRows[1].jev.evidence;
assert.ok(evidenceHtml(evidence).includes("&lt;img"));
assert.ok(evidenceHtml(evidence).includes("Ảnh đã tắt"));
assert.ok(!evidenceHtml(evidence).includes("<img"));
assert.equal(cleanEvidence({ before: { text: "a".repeat(5000), screenshot: { data: "secret", status: "available", artifactId: "a" } } }).before.text.length, 1000);
assert.ok(!JSON.stringify(cleanEvidence({ before: { screenshot: { data: "secret" } } })).includes("secret"));
const replay = new ConversationModel("c");
replay.applySnapshot({ conversationId: "c", meta: {}, lastSeq: events.length, firstSeq: 1, hasOlder: false, events: events.map((e,i) => ({ ...e, seq: i+1 })) });
assert.deepEqual(replay.items.find(i => i.kind === "assistant_turn").toolRows, turn.toolRows);
model.applyEvent({ type: "run_done", runId: "r", ts: 3000 });
model.applyEvent({ type: "jev_phase", runId: "r", phase: "executing" });
assert.equal(model.busyLabel(), null);
assert.equal(turn.jevPhase.phase, "verifying");
const unknown = new ConversationModel("unknown");
unknown.applyEvent({ type: "jev_step", runId: "u", step: 1, operation: "CLICK", dispatched: true, skippedReason: "result_unknown", evidence: { after: { unavailableReason: "result_unknown" } } });
assert.equal(unknown.items.find(i => i.kind === "assistant_turn").toolRows[0].status, "unknown");
assert.ok(toolRowDisplay(unknown.items.find(i => i.kind === "assistant_turn").toolRows[0]).label.includes("chưa xác định kết quả"));
const failedEvents = [{ type: "run_started", runId: "f", ts: 1000 }, { type: "jev_step", runId: "f", step: 1, operation: "CLICK", dispatched: true, actionOutcome: "failed", actionError: { code: "TOOL_ERROR", message: '<img src=x onerror=bad>' + 'x'.repeat(300) } }];
const failedModel = new ConversationModel("failed");
failedEvents.forEach(e => failedModel.applyEvent(e));
const failedRow = failedModel.items.find(i => i.kind === "assistant_turn").toolRows[0];
assert.equal(failedRow.status, "failed");
assert.equal(failedRow.jev.actionError.message.length, 200);
assert.equal(timelineCounts([failedRow]).operations, 1);
assert.ok(toolRowDisplay(failedRow).label.includes("thất bại"));
assert.ok(!toolRowDisplay(failedRow).label.includes("Đã click"));
const rowHtml = compile([extractFunction("toolRowHtml", "extension/sidepanel/sidepanel.js"), extractFunction("statusWordVi", "extension/sidepanel/sidepanel.js")].join("\n"), { toolRowDisplay, escapeHtml, evidenceHtml, iconMarkup }, "toolRowHtml")(failedRow);
assert.ok(rowHtml.includes('data-status="failed"'));
assert.ok(rowHtml.includes("&lt;img"));
assert.ok(!rowHtml.includes("<img"));
const failedReplay = new ConversationModel("failed");
failedReplay.applySnapshot({ conversationId: "failed", meta: {}, lastSeq: 2, firstSeq: 1, hasOlder: false, events: failedEvents.map((e,i) => ({ ...e, seq: i+1 })) });
assert.deepEqual(failedReplay.items.find(i => i.kind === "assistant_turn").toolRows[0], failedRow);
assert.ok(toolRowDisplay({ ...failedRow, jev: { ...failedRow.jev, actionError: { code: "TARGET_OBSTRUCTED", message: "intercepted" } } }).detail.includes("mục tiêu bị che khuất"));
const availableMarkup = evidenceHtml(cleanEvidence({ before: { screenshot: { status: "available", artifactId: 'a" onclick="bad' } } }));
assert.ok(availableMarkup.includes('data-artifact-id="a&quot; onclick=&quot;bad"'));
assert.ok(!availableMarkup.includes('<img'));

const text = 'Kết quả [Nguồn](https://example.com)\n\n### Chi tiết bổ sung\n<img onerror=bad>\nURL truy vấn';
assert.ok(renderReport({ text, lifecycle: "done", jevOutcome: { doneVerified: true } }).includes('<details class="report-details">'));
for (const lifecycle of ["running", "stopped", "error", "done"]) assert.ok(!renderReport({ text, lifecycle, jevOutcome: { doneVerified: false } }).includes("<details"));
assert.ok(!renderReport({ text, lifecycle: "done", jevOutcome: { doneVerified: true } }).includes("<img"));
for (const [open, close] of [["```markdown", "```"], ["~~~~markdown", "~~~~~"], ["````markdown", "`````"], ["```", ""], ["~~~~", "~~~"]]) {
  const example = `Example:\n${open}\n### Additional details\nImportant example content\n${close}\nMain conclusion`;
  const html = renderReport({ text: example, lifecycle: "done", jevOutcome: { doneVerified: true } });
  assert.ok(!html.includes("<details"), `heading in ${open} is never a disclosure`);
  assert.ok(html.includes("Main conclusion"));
}
const afterFence = renderReport({ text: "Example:\r\n```markdown\r\n### Additional details\r\n```\r\nMain conclusion\r\n### Chi tiết bổ sung\r\nDiagnostics", lifecycle: "done", jevOutcome: { doneVerified: true } });
assert.ok(afterFence.indexOf("Main conclusion") < afterFence.indexOf("<details"));
assert.ok(afterFence.includes("Diagnostics</p></details>"));

let request;
const client = new ArtifactClient({ send: args => { request = args; } });
let pending = client.fetch({ conversationId: "c", artifactId: "a" });
const envelopes = flattenChunkedMessage(chunkBuffer(new Uint8Array([1,2,3]), { meta: { ...request, kind: "action_artifact_reply", mimeType: "image/jpeg" } }));
envelopes.forEach(e => client.handleEnvelope(e));
assert.deepEqual((await pending).bytes, new Uint8Array([1,2,3]));
pending = client.fetch({ conversationId: "c", artifactId: "a" });
client.handleEnvelope({ ...envelopes[0], ...request, conversationId: "other" });
assert.equal((await pending).found, false);
pending = client.fetch({ conversationId: "c", artifactId: "a" });
client.handleEnvelope({ ...envelopes[0], ...request, mimeType: "image/svg+xml" });
assert.equal((await pending).found, false);
pending = client.fetch({ conversationId: "c", artifactId: "a" });
client.handleEnvelope({ type: "action_artifact", ...request, found: false, reason: "expired" });
assert.equal((await pending).reason, "expired");
pending = client.fetch({ conversationId: "c", artifactId: "a" });
client.disconnect();
assert.equal((await pending).reason, "disconnected");
assert.equal(client.sequences.size, 0);
pending = client.fetch({ conversationId: "c", artifactId: "a" });
client.handleEnvelope({ ...envelopes[0], ...request, totalBytes: 17 * 1024 * 1024 });
assert.equal((await pending).found, false);
pending = client.fetch({ conversationId: "c", artifactId: "a" });
const corrupt = flattenChunkedMessage(chunkBuffer(new Uint8Array([1,2,3]), { meta: { ...request, kind: "action_artifact_reply", mimeType: "image/jpeg" } }));
client.handleEnvelope(corrupt[0]);
client.handleEnvelope({ ...corrupt[1], size: 4 });
assert.equal((await pending).found, false);

const renderTimeline = compile(extractFunction("renderTimelineCollapsed", "extension/sidepanel/sidepanel.js"), { timelineCounts, timelineExpandedRuns: new Set(), timelineDurationLabel: () => "38s", toolRowHtml: () => "", escapeHtml, iconMarkup: () => "", renderMemoryRecallHtml: () => "" }, "renderTimelineCollapsed");
assert.ok(renderTimeline(turn).includes("1 thao tác trình duyệt · 2 lập kế hoạch/kiểm tra"));
console.log("PASS feedback: phase/permission/terminal priority, exact counts, bounded escaped evidence, replay, safe disclosure, historical artifact identity/MIME/chunks/unavailability");

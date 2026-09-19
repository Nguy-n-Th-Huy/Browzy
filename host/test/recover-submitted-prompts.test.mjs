#!/usr/bin/env node
// Regression cover for host/agent/recover-submitted-prompts.mjs — the one-off
// recovery for conversations recorded BEFORE `message_submitted` existed, whose
// questions survive only in the SDK's own session transcript.
//
// Why this needs a test of its own: the tool decides what counts as something
// the OPERATOR typed, and it writes into a real conversation log. Two failure
// modes are silent and expensive — recovering an SDK-injected turn (a subagent
// notification, the empty-answer nudge) puts words in the user's mouth on the
// transcript, and recovering twice duplicates every question. Both are pinned
// here against real fixture bytes, including the string-shaped `content` an SDK
// injected turn uses, which the tool's first implementation let straight
// through because that branch never reached the synthetic filter.
//
// Run: node host/test/recover-submitted-prompts.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-recover-prompts-"));
process.env.OCIC_AGENT_HOME = scratch;

const { recoverPrompts, summarize } = await import("../agent/recover-submitted-prompts.mjs");

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

const T0 = Date.parse("2026-09-14T09:00:00.000Z");

/** One conversation fixture: meta.json + events.jsonl + an SDK transcript. */
function makeConversation(id, { runs = [], events = [], sdkLines = null, activeRunId = null } = {}) {
  const dir = path.join(scratch, "conversations", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ conversationId: id, createdAt: T0, updatedAt: T0, lastSeq: events.length, interrupted: false, activeRunId }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((event, index) => JSON.stringify({ seq: index + 1, ...event })).join("\n") + (events.length ? "\n" : "")
  );
  if (sdkLines) {
    const projects = path.join(dir, "claude-config", "projects", `slug-${id}`);
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, "session.jsonl"), sdkLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  return dir;
}

const userTurn = (text, ts) => ({ type: "user", isSidechain: false, uuid: `u-${ts}`, timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const injectedTurn = (text, ts) => ({ type: "user", isSidechain: false, uuid: `i-${ts}`, timestamp: new Date(ts).toISOString(), message: { role: "user", content: text } });
const toolResultTurn = (ts) => ({
  type: "user",
  isSidechain: false,
  uuid: `t-${ts}`,
  timestamp: new Date(ts).toISOString(),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] }
});
const sidechainTurn = (text, ts) => ({ ...userTurn(text, ts), isSidechain: true, uuid: `s-${ts}` });

const runCreated = (runId, ts) => ({ type: "run_created", runId, ts, tabScope: "any" });
const runDone = (runId, ts) => ({ type: "run_done", runId, ts });

const readEvents = (id) =>
  fs
    .readFileSync(path.join(scratch, "conversations", id, "events.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

console.log("\nRecovering user turns from the SDK session transcript\n");

// --- 1. a clean, single-turn legacy conversation ---------------------------
{
  const id = "conv_clean";
  const prompt = "Tìm TBMT trên bộ lọc tìm kiếm có Nơi thực hiện là Hải Phòng";
  makeConversation(id, {
    events: [runCreated("run_a", T0 + 1000), runDone("run_a", T0 + 2000)],
    sdkLines: [userTurn(prompt, T0 + 500)]
  });

  const dry = recoverPrompts({ only: [id] });
  ok(dry[0].status === "would-recover", "a legacy conversation with a real SDK turn is reported as recoverable");
  ok(readEvents(id).filter((e) => e.type === "message_submitted").length === 0, "...and the dry run writes nothing at all");

  const applied = recoverPrompts({ only: [id], apply: true });
  ok(applied[0].status === "recovered", "applying it reports the recovery");
  const submitted = readEvents(id).filter((e) => e.type === "message_submitted");
  ok(submitted.length === 1 && submitted[0].submission.text === prompt, "...appending the operator's own text verbatim");
  ok(submitted[0].runId === "run_a", "...bound to the run that instant created");
  ok(submitted[0].ts === T0 + 500, "...keeping the instant the operator actually typed it");
  ok(submitted[0].recoveredFrom === "sdk-session-transcript", "...and recording that it was recovered, not written at run time");
  ok(submitted[0].seq > 2, "...appended after every existing event, never reordering the log");

  const again = recoverPrompts({ only: [id], apply: true });
  ok(again[0].status === "already-ok", "a second run is a no-op");
  ok(readEvents(id).filter((e) => e.type === "message_submitted").length === 1, "...so no question is ever duplicated");
}

// --- 2. SDK-injected turns are never recovered -----------------------------
{
  const id = "conv_injected";
  const synthetic = [
    "<task-notification>\n<task-id>a0c44642df6bbff48</task-id>",
    "[Your previous response had no visible output. Please continue and produce a useful response.]",
    "[Request interrupted by user]",
    "<system-reminder>context goes here</system-reminder>",
    'Use the "ocic-session-skills:check-boctin-nhathau" skill.',
    "\u200B<task-notification>\n<task-id>zero-width-prefixed</task-id>"
  ];
  makeConversation(id, {
    events: [runCreated("run_b", T0 + 1000), runDone("run_b", T0 + 2000)],
    sdkLines: synthetic.map((text, index) => injectedTurn(text, T0 + 100 * index))
  });

  const result = recoverPrompts({ only: [id], apply: true });
  ok(result[0].status === "nothing-to-recover", "a transcript of only SDK-injected turns recovers nothing");
  ok(readEvents(id).filter((e) => e.type === "message_submitted").length === 0, "...and never puts those words in the operator's mouth");
}

// --- 3. mixed content: only the real operator turns survive ----------------
{
  const id = "conv_mixed";
  const first = "phân tích trang này";
  const second = "giải thích hơn, tôi không hiểu";
  makeConversation(id, {
    events: [runCreated("run_c1", T0 + 1000), runDone("run_c1", T0 + 5000), runCreated("run_c2", T0 + 6000), runDone("run_c2", T0 + 9000)],
    sdkLines: [
      toolResultTurn(T0 + 200),
      userTurn(first, T0 + 500),
      injectedTurn("[Your previous response had no visible output. Please continue and produce a useful response.]", T0 + 3000),
      sidechainTurn("a subagent's own prompt", T0 + 4000),
      userTurn(second, T0 + 5500)
    ]
  });

  recoverPrompts({ only: [id], apply: true });
  const submitted = readEvents(id).filter((e) => e.type === "message_submitted");
  ok(submitted.length === 2, "only the two real operator turns are recovered");
  ok(submitted[0].submission.text === first && submitted[0].runId === "run_c1", "the first question binds to the first run");
  ok(submitted[1].submission.text === second && submitted[1].runId === "run_c2", "and the second to the run IT created, not the previous one");
}

// --- 4. a conversation with an active run is left alone --------------------
{
  const id = "conv_busy";
  makeConversation(id, {
    activeRunId: "run_live",
    events: [runCreated("run_live", T0 + 1000)],
    sdkLines: [userTurn("câu hỏi của lượt đang chạy", T0 + 500)]
  });

  const result = recoverPrompts({ only: [id], apply: true });
  ok(result[0].status === "active-run", "a conversation with a live run is refused");
  ok(readEvents(id).filter((e) => e.type === "message_submitted").length === 0, "...because appending behind a live seq allocator is not worth the risk");
}

// --- 5. no SDK transcript, or no run to bind to: nothing is invented -------
{
  const noTranscript = "conv_no_transcript";
  makeConversation(noTranscript, { events: [runCreated("run_d", T0), runDone("run_d", T0 + 1)] });
  ok(recoverPrompts({ only: [noTranscript] })[0].status === "nothing-to-recover", "a conversation with no SDK transcript recovers nothing");

  const emptyLog = "conv_no_runs";
  makeConversation(emptyLog, { events: [], sdkLines: [userTurn("một câu hỏi không có lượt chạy nào", T0)] });
  ok(recoverPrompts({ only: [emptyLog] })[0].status === "no-run-to-bind", "a question with no recorded run is not turned into a runId-less entry");

  const healthy = "conv_healthy";
  makeConversation(healthy, {
    events: [{ type: "message_submitted", runId: "run_e", ts: T0, submission: { text: "đã có sẵn", attachments: [] } }, runCreated("run_e", T0 + 1)],
    sdkLines: [userTurn("đã có sẵn", T0)]
  });
  ok(recoverPrompts({ only: [healthy] })[0].status === "already-ok", "a conversation the fix already covers is skipped entirely");
}

console.log("\nTally of the whole scratch store:");
for (const [status, count] of summarize(recoverPrompts())) console.log(`  ${status}: ${count}`);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL PROMPT-RECOVERY TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

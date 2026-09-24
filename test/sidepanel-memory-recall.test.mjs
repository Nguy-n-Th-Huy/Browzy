#!/usr/bin/env node
//
// The panel side of task memory (openspec/changes/add-task-memory tasks.md
// 7.1, 7.2, 7.5 and the START privacy field):
//   - a `memory_recalled` event becomes one disclosure on its turn, kept
//     apart from toolRows so it is never counted as an operation, and a
//     replayed event (reconnect snapshot) does not duplicate it;
//   - a turn without the event carries no disclosure;
//   - the renderer emits the line inside the timeline group and outside the
//     counted rows;
//   - protocol-client's start() carries `privacy` only when given;
//   - the recall tool has a Vietnamese label.
//
// Run: node test/sidepanel-memory-recall.test.mjs

import fs from "node:fs";

import { ConversationModel } from "../extension/sidepanel/conversation-model.js";
import { ProtocolClient } from "../extension/sidepanel/protocol-client.js";
import { humanToolLabel } from "../extension/sidepanel/tool-labels.js";
import { timelineCounts } from "../extension/sidepanel/run-feedback.js";

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail += 1;
};

function turnOf(model, runId) {
  return model.items.find((item) => item.kind === "assistant_turn" && item.runId === runId);
}

console.log("\n== the disclosure on the turn ==");
{
  const model = new ConversationModel("c1");
  model.applyEvent({ type: "run_created", runId: "r1" });
  model.applyEvent({ type: "memory_recalled", runId: "r1", host: "dauthau.asia", memoryIds: ["m1", "m2"], confirmedAt: [1000, 5000], ts: 10 });
  model.applyEvent({ type: "run_started", runId: "r1" });
  model.applyEvent({ type: "run_done", runId: "r1" });
  const turn = turnOf(model, "r1");
  ok(turn && turn.memoryRecall, "the turn carries the recall");
  ok(turn.memoryRecall.host === "dauthau.asia" && turn.memoryRecall.count === 2 && turn.memoryRecall.lastConfirmedAt === 5000, JSON.stringify(turn.memoryRecall));
  ok(turn.toolRows.length === 0, "the recall is not a tool row");
  ok(timelineCounts(turn.toolRows).operations === 0, "and is not counted as an operation");

  model.applyEvent({ type: "memory_recalled", runId: "r1", host: "dauthau.asia", memoryIds: ["m1", "m2"], confirmedAt: [1000, 5000], ts: 10 });
  ok(turnOf(model, "r1").memoryRecall.count === 2, "a replayed event overwrites rather than duplicating");

  model.applyEvent({ type: "run_created", runId: "r2" });
  model.applyEvent({ type: "run_done", runId: "r2" });
  ok(!turnOf(model, "r2")?.memoryRecall, "a run without recall has no disclosure");
}

console.log("\n== the renderer ==");
{
  const source = fs.readFileSync(new URL("../extension/sidepanel/sidepanel.js", import.meta.url), "utf8");
  ok(/function renderMemoryRecallHtml\(turn\)/.test(source), "a dedicated renderer exists");
  ok(/Đã tham khảo cách làm lần trước/.test(source), "the disclosure copy is the spec's");
  const group = source.slice(source.indexOf("function renderTimelineCollapsed(turn)"), source.indexOf("function renderMemoryRecallHtml(turn)"));
  ok(group.includes("${renderMemoryRecallHtml(turn)}") && group.indexOf("renderMemoryRecallHtml") < group.indexOf("tool-timeline-list\" id="), "the line sits inside the group, before (and outside) the counted list");
  ok(!group.slice(0, group.indexOf("summaryLabel =") + 400).includes("memoryRecall"), "the summary's operation count ignores the recall");
  const css = fs.readFileSync(new URL("../extension/sidepanel/sidepanel.css", import.meta.url), "utf8");
  ok(/\.memory-recall-note\s*\{/.test(css), "the line has its own quiet style");
}

console.log("\n== START carries the privacy policy ==");
{
  const sent = [];
  const port = { postMessage: (msg) => sent.push(msg), onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} };
  const client = new ProtocolClient({ createTransport: () => port });
  client.connect();
  client.start({ conversationId: "c", prompt: "x", tabScope: "any", privacy: { rawPromptCaching: false } });
  client.start({ conversationId: "c", prompt: "y", tabScope: "any" });
  const starts = sent.map((m) => m.envelope).filter((e) => e.type === "start");
  ok(starts[0].privacy && starts[0].privacy.rawPromptCaching === false, "privacy rides START when given");
  ok(!("privacy" in starts[1]), "and is absent otherwise");
  const controller = fs.readFileSync(new URL("../extension/sidepanel/panel-controller.js", import.meta.url), "utf8");
  ok(/\.\.\.this\._privacyForStart\(\)/.test(controller), "the panel's Send attaches the history privacy policy");
}

console.log("\n== the tool label ==");
ok(humanToolLabel("task_memory") === "Đã xem lại cách làm lần trước", `label: ${humanToolLabel("task_memory")}`);

console.log(fail === 0 ? "\nALL SIDEPANEL MEMORY RECALL TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// Live streaming render (add-live-streaming-and-thinking tasks 3.1-3.6/4.4):
// the REAL shipped functions in extension/sidepanel/sidepanel.js, pulled out
// by test/_extract.mjs's brace-matching extractor (the same technique
// test/sidepanel-threat-warnings.test.mjs and
// test/sidepanel-permission-mode-retry.test.mjs already use) because
// sidepanel.js touches `document`/`chrome.*` at module scope and cannot be
// imported directly in plain Node.
//
// The acceptance-critical properties this file pins:
//   * a live turn paints its answer into ONE stable `.stream-answer-text`
//     node, and the in-place painter updates that node in place — identity,
//     and a delta-only `appendData` write for prefix growth, so a selection or
//     caret anchored inside the already-visible text survives every batch —
//     without touching anything else in the transcript, the cursor that
//     follows the growing text included;
//   * `transcriptStructureSignature()` is unchanged while ONLY streamed text
//     grows, and changes for every structural fact (busy, lifecycle, tool
//     row, thinking appearing, conversation switch) — which is what makes
//     "no transcript rebuild while streaming" a decision, not a hope;
//   * the "Suy luận" disclosure is keyboard-operable markup with an exposed
//     state, subordinate to the answer, and a redacted block carries no
//     content;
//   * its expansion default is UI-only and run-keyed: expanded while thinking
//     is arriving, collapsed once the run is not live, an explicit override
//     honored in either direction;
//   * a streamed-then-completed turn renders exactly the same content as the
//     same final state reached with no fragments at all (no duplicated text);
//   * a Jev run (openspec/changes/add-typesafe-jev-provider, design.md §8)
//     renders its step rows and its terminal outcome line under the turn, with
//     no assistant text anywhere, and its busy indicator resolves through the
//     run's own lifecycle rather than through any text arriving.
//
// Run: node test/sidepanel-streaming-render.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFunction, compile } from "./_extract.mjs";
import { createDocument } from "./_fake-dom.mjs";
import { escapeHtml, renderMarkdownLite } from "../extension/sidepanel/markdown-lite.js";
import { renderReport, evidenceHtml } from "../extension/sidepanel/run-feedback.js";
import { iconMarkup } from "../extension/ui/icons.js";
import { ConversationModel, toolRowDisplay } from "../extension/sidepanel/conversation-model.js";
import { jevOutcomeLineVi } from "../extension/sidepanel/tool-labels.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL_FILE = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const extract = (name) => extractFunction(name, SIDEPANEL_FILE);
const SIDEPANEL_SRC = fs.readFileSync(SIDEPANEL_FILE, "utf8");

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

console.log("== completed run durations stay frozen when a second run starts and history replays ==");
{
  let clockMs = 38_000;
  const duration = compile(extract("timelineDurationLabel"), { Date: { now: () => clockMs } }, "timelineDurationLabel");
  for (const terminal of ["run_done", "run_stopped", "run_error", "run_interrupted_by_restart"]) {
    const model = new ConversationModel(`timing-${terminal}`);
    const events = [
      { type: "run_started", runId: "first", ts: 1000 },
      { type: "jev_step", runId: "first", step: 1, operation: "CLICK", tool: "computer", ts: 2000 },
      { type: terminal, runId: "first", ts: 38_000 }
    ];
    events.forEach((event) => model.applyEvent(event));
    const first = () => model.items.find((item) => item.kind === "assistant_turn" && item.runId === "first");
    ok(duration(first()) === "37s", `${terminal} captures the actual 37-second duration`);
    clockMs = 160_000;
    events.push({ type: "run_started", runId: "second", ts: clockMs });
    model.applyEvent(events.at(-1));
    ok(duration(first()) === "37s", `${terminal} stays 37s after a second-run event`);
    model.applySnapshot({ conversationId: `timing-${terminal}`, meta: {}, lastSeq: events.length, firstSeq: 1, hasOlder: false,
      events: events.map((event, index) => ({ ...event, seq: index + 1 })) });
    ok(duration(first()) === "37s", `${terminal} restores the persisted end time on replay`);
    clockMs = 38_000;
  }
  ok(duration({ lifecycle: "done", ts: 1000, toolRows: [{ endedAt: null }] }) === "", "historical turns without any end timestamp never show today's age");
  ok(duration({ lifecycle: "running", ts: 1000, toolRows: [{ endedAt: null }] }) === "37s", "active turns retain a live elapsed timer");
}

// The turn-rendering bundle. Unrelated sub-renderers (timeline, warnings,
// documents, cards, busy indicator) are injected as empty-string collaborators
// because every turn below has none of them; the streaming tail, the thinking
// block and their shared markup contract are the shipped code under test.
const turnRender = compile(
  [
    extract("turnStatusNote"),
    extract("renderJevOutcomeHtml"),
    extract("thinkingIsExpanded"),
    extract("renderProseHtml"),
    extract("renderThinkingBlockHtml"),
    extract("renderTurnHtml")
  ].join("\n\n"),
  {
    escapeHtml,
    renderMarkdownLite,
    renderReport,
    iconMarkup,
    jevOutcomeLineVi,
    SKILL_ERROR_TITLES_VI: {},
    renderBusyIndicator: () => "",
    renderTimelineCollapsed: () => "",
    timelineDurationLabel: () => "",
    renderWarningsHtml: () => "",
    renderUserItemHtml: () => "",
    renderAnswerSourceCitation: () => "",
    renderDocumentCardHtml: () => "",
    thinkingExpandedRuns: new Map(), // UI-only, injected for the extracted bundle
    panel: { currentModel: () => null }
  },
  "{ turnStatusNote, renderJevOutcomeHtml, thinkingIsExpanded, renderProseHtml, renderThinkingBlockHtml, renderTurnHtml }"
);

// The shipped per-row markup (toolRowHtml + statusWordVi), so a Jev step row's
// label and its "nothing was dispatched" pill are asserted against the real
// renderer rather than a copy.
const toolRowRender = compile(
  [extract("toolRowHtml"), extract("statusWordVi")].join("\n\n"),
  { escapeHtml, iconMarkup, toolRowDisplay, evidenceHtml },
  "{ toolRowHtml, statusWordVi }"
);

const paintBundle = compile(
  [extract("setNodeTextIfChanged"), extract("paintStreamingTail")].join("\n\n"),
  {},
  "{ paintStreamingTail }"
);

const structureSignature = compile(extract("transcriptStructureSignature"), {}, "transcriptStructureSignature");

function turn(over = {}) {
  return {
    kind: "assistant_turn",
    runId: "r1",
    lifecycle: "running",
    complete: false,
    text: "",
    thinking: "",
    redactedThinking: false,
    toolRows: [],
    warnings: [],
    documents: [],
    questionAnswers: [],
    ts: 1000,
    lastContentKind: null,
    ...over
  };
}

console.log("== a live turn streams into one stable answer node; a finished turn uses the markdown renderer ==");
{
  const live = turn({ text: "Xin **chào**", lastContentKind: "text" });
  const liveHtml = turnRender.renderTurnHtml(live, { isLatestStreaming: true, busy: false, elapsedVisible: false });
  ok(liveHtml.includes('class="stream-answer-text"'), "a live turn paints the answer into a stable streaming node");
  ok(liveHtml.includes('data-run-id="r1"'), "...carrying the run id the in-place path keys on");
  ok(liveHtml.includes(escapeHtml("Xin **chào**")), "...as escaped live text, not markdown-rendered while it streams");
  ok(liveHtml.includes('class="stream-cursor"'), "the streaming cursor renders after the growing text");

  const done = turn({ text: "Xin **chào**", lifecycle: "done", complete: true });
  const doneHtml = turnRender.renderTurnHtml(done, { isLatestStreaming: false, busy: false, elapsedVisible: false });
  ok(doneHtml.includes(renderMarkdownLite("Xin **chào**")), "a finished turn renders through renderMarkdownLite() exactly as before");
  ok(!doneHtml.includes("stream-answer-text"), "...and not through the streaming node");
  ok(!doneHtml.includes("stream-cursor"), "the cursor is gone once the run is not live");
}

console.log("== the \"Suy luận\" disclosure: keyboard-operable, exposed state, subordinate, redacted without content ==");
{
  const withThinking = turn({ thinking: "bước một\nbước hai", lifecycle: "done", complete: true, text: "trả lời" });
  const html = turnRender.renderTurnHtml(withThinking, { isLatestStreaming: false, busy: false, elapsedVisible: false });
  ok(html.includes("Suy luận"), "the block is labeled with the panel's existing Vietnamese copy");
  ok(html.includes('<button class="thinking-summary" type="button"'), "the disclosure is a real button (native Enter/Space activation)");
  ok(html.includes('aria-expanded="false"'), "...whose collapsed state is exposed to assistive technology for a finished turn");
  ok(html.includes('aria-controls="think-r1"') && html.includes('id="think-r1"'), "...and which names the body it controls");
  ok(html.includes('id="think-r1" hidden'), "the collapsed body is present but hidden (expansion does not alter the record)");
  ok(html.includes(escapeHtml("bước một")), "the thinking text is rendered escaped as inert text");
  ok(html.indexOf("thinking-block") < html.indexOf("stream-answer-text") || html.indexOf("thinking-block") < html.indexOf("prose"),
     "the thinking block sits before the answer, reading as secondary content");

  const liveHtml = turnRender.renderTurnHtml(
    turn({ thinking: "đang nghĩ", text: "trả lời" }),
    { isLatestStreaming: true, busy: false, elapsedVisible: false }
  );
  ok(liveHtml.includes('aria-expanded="true"'), "thinking still arriving is expanded by default");
  ok(!/id="think-r2?"[^>]*hidden/.test(liveHtml) && !liveHtml.includes('id="think-r1" hidden'), "...so its body is not hidden while it updates");

  const noThinking = turnRender.renderTurnHtml(turn({ text: "x", lifecycle: "done", complete: true }), {
    isLatestStreaming: false, busy: false, elapsedVisible: false
  });
  ok(!noThinking.includes("thinking-block"), "a turn with no thinking renders no block at all (no empty placeholder)");

  const redacted = turnRender.renderTurnHtml(
    turn({ thinking: "", redactedThinking: true, lifecycle: "done", complete: true, text: "trả lời" }),
    { isLatestStreaming: false, busy: false, elapsedVisible: false }
  );
  ok(redacted.includes("thinking-block") && redacted.includes("không thể hiển thị"), "a redacted block is represented as thinking that occurred, without content");
  ok(
    redacted.includes('<span class="thinking-redacted">Mô hình đã suy luận nhưng nội dung không thể hiển thị.</span>'),
    "...its body is exactly the placeholder line, with no fabricated or leaked content"
  );
}

console.log("== expansion state: UI-only, run-keyed, expanded live / collapsed after, an explicit choice wins ==");
{
  const overrides = new Map();
  ok(turnRender.thinkingIsExpanded({ runId: "run-a" }, { live: true, overrides }) === true, "default while thinking is arriving: expanded");
  ok(turnRender.thinkingIsExpanded({ runId: "run-a" }, { live: false, overrides }) === false, "default once the run is no longer live: collapsed");
  overrides.set("run-a", false);
  ok(turnRender.thinkingIsExpanded({ runId: "run-a" }, { live: true, overrides }) === false, "an explicit collapse is honored for the rest of the run");
  overrides.set("run-b", true);
  ok(turnRender.thinkingIsExpanded({ runId: "run-b" }, { live: false, overrides }) === true, "an explicit expand survives the run going non-live");
  ok(turnRender.thinkingIsExpanded({ runId: "run-c" }, { live: false, overrides }) === false, "...and keys only its own run");
}

console.log("== the streaming render path is wired into the shipped renderer ==");
{
  ok(SIDEPANEL_SRC.includes("${renderProseHtml(turn,"), "renderTurnHtml composes the prose through the extracted helper");
  ok(SIDEPANEL_SRC.includes("${thinkingHtml}"), "renderTurnHtml renders the thinking block");
  ok(SIDEPANEL_SRC.includes("paintStreamingTail(nodes, latest)"), "renderTranscript takes the in-place path");
  ok(SIDEPANEL_SRC.includes("signature === lastStructureSignature"), "...gated on the structural signature being unchanged");
  ok(SIDEPANEL_SRC.includes("  wireThinkingToggles();"), "the disclosure wiring runs on every structural render");
  ok(SIDEPANEL_SRC.includes("thinkingExpandedRuns.set(runId, willExpand)"), "an explicit toggle records the UI-only override keyed by run id");
  ok(SIDEPANEL_SRC.includes("btn.setAttribute(\"aria-expanded\", willExpand ? \"true\" : \"false\")"), "...and exposes the new state on the control");
  ok(SIDEPANEL_SRC.includes("el.transcript.innerHTML = renderOlderTranscriptControl(model) + html;"), "the structural renderer stays the one innerHTML authority");
}

console.log("== the structural signature changes for structure, and NOT for streamed text growth ==");
{
  const m = new ConversationModel("conv-sig");
  m.addLocalUserMessage("hỏi");
  m.applyEvent({ type: "run_created", runId: "r" });
  m.applyEvent({ type: "run_started", runId: "r" });
  const busySig = structureSignature(m, { busy: true });

  const partial = (event) => ({ type: "stream_partial", runId: "r", message: { type: "stream_event", event } });
  m.applyEvent(partial({ type: "message_start", message: { id: "m1", content: [] } }));
  m.applyEvent(partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Xin " } }));
  const streamedSig = structureSignature(m, { busy: false });
  ok(streamedSig !== busySig, "the first streamed text changes the shape (the busy indicator clears and the streaming node appears)");

  m.applyEvent(partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "chào bạn" } }));
  ok(
    structureSignature(m, { busy: false }) === streamedSig,
    "a longer streamed answer of the same turn changes ONLY the buffer — the signature is identical, so the in-place path applies"
  );

  m.applyEvent(partial({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "nghĩ" } }));
  const thinkingSig = structureSignature(m, { busy: false });
  ok(thinkingSig !== streamedSig, "thinking appearing changes the shape (its block must be created once)");
  m.applyEvent(partial({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: " thêm" } }));
  ok(structureSignature(m, { busy: false }) === thinkingSig, "...while more thinking text does not");

  m.applyEvent({ type: "stream_message", runId: "r", message: { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "navigate", input: {} }] } } });
  const toolSig = structureSignature(m, { busy: false });
  ok(toolSig !== thinkingSig, "a tool row changes the shape");

  m.applyEvent({ type: "run_done", runId: "r" });
  const doneSig = structureSignature(m, { busy: false });
  ok(doneSig !== toolSig, "a lifecycle change changes the shape");

  ok(structureSignature(m, { busy: true }) !== doneSig, "the busy indicator's presence is part of the shape");
  ok(doneSig.startsWith("conv-sig"), "the conversation id is in the signature, so switching conversations can never reuse nodes");

  const other = new ConversationModel("conv-other");
  other.applyEvent({ type: "run_created", runId: "r" });
  other.applyEvent({ type: "run_started", runId: "r" });
  ok(structureSignature(other, { busy: false }) !== structureSignature(m, { busy: false }), "a different conversation never shares a signature");
}

console.log("== the in-place painter reuses existing nodes and touches nothing else ==");
{
  const doc = createDocument();
  const parent = doc.createElement("div");
  const prose = doc.createElement("div");
  prose.className = "prose";
  const answer = doc.createElement("span");
  answer.className = "stream-answer-text";
  const cursor = doc.createElement("span");
  cursor.className = "stream-cursor";
  prose.appendChild(answer);
  prose.appendChild(cursor);
  const block = doc.createElement("div");
  block.className = "thinking-block is-live";
  const thinking = doc.createElement("div");
  thinking.className = "thinking-body";
  block.appendChild(thinking);
  const sentinel = doc.createElement("span");
  sentinel.className = "turn-status-note";
  parent.appendChild(prose);
  parent.appendChild(block);
  parent.appendChild(sentinel);

  const answerNode = answer;
  const cursorNode = cursor;
  const first = paintBundle.paintStreamingTail({ answer, thinking }, turn({ text: "Xin " }));
  ok(first === true && answer.textContent === "Xin ", "the first batch paints the streamed text");
  paintBundle.paintStreamingTail({ answer, thinking }, turn({ text: "Xin chào", thinking: "nghĩ" }));
  ok(answer === answerNode && answer.textContent === "Xin chào", "a later batch updates the SAME answer node in place");
  ok(cursor === cursorNode && prose.children[1] === cursorNode, "...and the streaming cursor keeps its identity and position after the growing text");
  ok(thinking.textContent === "nghĩ", "thinking streams into its own stable node");
  ok(parent.children.length === 3 && parent.children[0] === prose && parent.children[2] === sentinel, "no sibling node is created, replaced or dropped — no transcript rebuild");

  thinking.textContent = "Mô hình đã suy luận nhưng nội dung không thể hiển thị.";
  paintBundle.paintStreamingTail({ answer, thinking }, turn({ text: "Xin chào", thinking: "" }));
  ok(thinking.textContent === "Mô hình đã suy luận nhưng nội dung không thể hiển thị.", "an empty thinking buffer never overwrites a redacted block's message");

  ok(paintBundle.paintStreamingTail(null, turn({ text: "x" })) === false, "no streaming nodes -> the caller falls back to the structural render");
  ok(paintBundle.paintStreamingTail({}, turn({ text: "x" })) === false, "a turn with no answer node reports not-painted");
}

console.log("== prefix growth APPENDS only the delta into one text node (a live selection inside it survives every batch) ==");
{
  // A browser-faithful element whose text lives in a single child text node:
  // `textContent` reads/writes that node, and assigning it replaces the
  // children — exactly the DOM semantics the shipped painter relies on. The
  // shared fake DOM models no text nodes, so the node a selection range is
  // anchored in is only observable through this shape.
  //
  // The text node additionally records HOW it is written to, because node
  // identity alone cannot tell a selection-safe update from a selection-
  // destroying one: assigning the whole string to `data` runs the DOM
  // "replace data" algorithm over the visible range and collapses any live
  // selection or caret anchored inside it, while `appendData(delta)` leaves
  // existing ranges alone. A real Chromium probe of this shipped painter
  // (round-2 verification) observed exactly that: `data = next` collapsed the
  // selection, `appendData` preserved it with byte-identical final text.
  const textNode = (data) => ({
    nodeType: 3,
    _data: String(data),
    dataWrites: [],
    appendCalls: [],
    insertCalls: [],
    get data() { return this._data; },
    set data(value) { this.dataWrites.push(String(value)); this._data = String(value); },
    get textContent() { return this._data; },
    appendData(suffix) { this.appendCalls.push(String(suffix)); this._data += String(suffix); },
    insertData(offset, text) {
      this.insertCalls.push([offset, String(text)]);
      this._data = this._data.slice(0, offset) + String(text) + this._data.slice(offset);
    }
  });
  const liveTextSpan = (initial) => {
    const span = {
      nodeType: 1,
      _child: null,
      get firstChild() { return this._child; },
      get textContent() { return this._child ? this._child.data : ""; },
      set textContent(value) {
        const s = String(value == null ? "" : value);
        this._child = s === "" ? null : textNode(s);
      }
    };
    if (initial != null) span.textContent = initial;
    return span;
  };

  const answer = liveTextSpan("Xin ");
  const originalTextNode = answer.firstChild;
  ok(originalTextNode.nodeType === 3, "the live answer starts as one text node inside the shipped span shape");

  paintBundle.paintStreamingTail({ answer }, turn({ text: "Xin chào" }));
  ok(answer.textContent === "Xin chào", "a prefix-growth batch extends the text");
  ok(answer.firstChild === originalTextNode, "...by writing into the SAME text node (the node a selection would be anchored in survives)");
  ok(originalTextNode.appendCalls.length === 1 && originalTextNode.appendCalls[0] === "chào", "...as the exact delta, appended — so the replace-data algorithm never touches the visible range");
  ok(originalTextNode.dataWrites.length === 0 && originalTextNode.insertCalls.length === 0, "...and never by assigning the whole `data` (which would collapse a selection or caret inside it)");

  paintBundle.paintStreamingTail({ answer }, turn({ text: "Xin chào bạn" }));
  ok(answer.firstChild === originalTextNode && answer.textContent === "Xin chào bạn", "...and it stays that same node across further batches");
  ok(originalTextNode.appendCalls.length === 2 && originalTextNode.appendCalls[1] === " bạn", "...each batch appending only its own delta");
  ok(originalTextNode.dataWrites.length === 0, "...with no whole-`data` write ever occurring while the text only grows");

  paintBundle.paintStreamingTail({ answer }, turn({ text: "Xin chào bạn" }));
  ok(answer.firstChild === originalTextNode && originalTextNode.appendCalls.length === 2 && originalTextNode.dataWrites.length === 0, "a batch that repeats the same text is a no-op, not a rewrite");

  const replaced = paintBundle.paintStreamingTail({ answer }, turn({ text: "Kết quả khác" }));
  ok(replaced === true && answer.textContent === "Kết quả khác", "a non-prefix supersede still replaces the text correctly");
  ok(answer.firstChild !== originalTextNode, "...and that replacement is a real child replacement, exactly as before");
  ok(originalTextNode.dataWrites.length === 0, "...so the superseded node is dropped, not rewritten in place");

  const fresh = liveTextSpan(null);
  paintBundle.paintStreamingTail({ answer: fresh }, turn({ text: "Bắt đầu" }));
  ok(fresh.textContent === "Bắt đầu" && fresh.firstChild.appendCalls.length === 0, "the initial paint of an empty node still goes through textContent (the append path is growth-only)");
}

console.log("== streamed-then-completed renders the same content as a full render of the final state ==");
{
  const seed = (m, runId) => {
    m.addLocalUserMessage("hỏi");
    m.applyEvent({ type: "run_created", runId });
    m.applyEvent({ type: "run_started", runId });
  };
  const partial = (runId, event) => ({ type: "stream_partial", runId, message: { type: "stream_event", event } });
  const complete = { type: "stream_message", runId: "rs", message: { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Xin chào bạn!" }] } } };

  const streamed = new ConversationModel("conv-a");
  seed(streamed, "rs");
  streamed.applyEvent(partial("rs", { type: "message_start", message: { id: "msg_1", content: [] } }));
  streamed.applyEvent(partial("rs", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Xin " } }));
  streamed.applyEvent(partial("rs", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "chào" } }));
  const midTurn = streamed.items.find((i) => i.kind === "assistant_turn");
  ok(midTurn.text === "Xin chào", "mid-stream the turn already shows the answer so far");
  streamed.applyEvent(complete);
  streamed.applyEvent({ type: "run_done", runId: "rs" });
  const streamedTurn = streamed.items.find((i) => i.kind === "assistant_turn");

  const noFragments = new ConversationModel("conv-a");
  seed(noFragments, "rs");
  noFragments.applyEvent(complete);
  noFragments.applyEvent({ type: "run_done", runId: "rs" });
  const plainTurn = noFragments.items.find((i) => i.kind === "assistant_turn");

  ok(streamedTurn.text === "Xin chào bạn!", "the streamed-then-completed text is exact, never duplicated");
  ok(streamedTurn.text === plainTurn.text, "it equals the same final state reached with no fragments at all");
  const streamedHtml = turnRender.renderTurnHtml(streamedTurn, { isLatestStreaming: false, busy: false, elapsedVisible: false });
  const plainHtml = turnRender.renderTurnHtml(plainTurn, { isLatestStreaming: false, busy: false, elapsedVisible: false });
  ok(streamedHtml === plainHtml, "and it renders byte-for-byte the same as a full render of that final state");
  ok(streamedHtml.includes(renderMarkdownLite("Xin chào bạn!")), "...through the normal markdown answer renderer");
}

console.log("== a Jev run renders its steps and outcome with no assistant text, and resolves its busy state ==");
{
  const RUN = "rv";
  const seed = (m) => {
    m.addLocalUserMessage("đăng nhập giúp tôi");
    m.bindRunToLastUserMessage(RUN);
    m.applyEvent({ type: "run_created", runId: RUN });
    m.applyEvent({ type: "run_started", runId: RUN });
  };
  const stepEvent = (step, operation, target, over = {}) => ({
    type: "jev_step",
    runId: RUN,
    step,
    operation,
    intent: "phần tử theo ý định của mô hình",
    target,
    targetProbability: 0.9,
    confidence: 0.85,
    tool: "computer",
    argsSummary: "action: left_click",
    latencies: { decisionMs: 400, selectionMs: 250, dispatchMs: 80 },
    pageChanged: true,
    ...over
  });
  const turnOf = (m) => m.items.find((i) => i.kind === "assistant_turn");
  const renderOpts = { isLatestStreaming: false, busy: false, elapsedVisible: false };

  // Mid-run: the loop is working, no assistant text has been produced, and the
  // busy indicator is what the operator sees (the model's own isBusy() is the
  // shipped condition the renderer reads).
  const live = new ConversationModel("conv-jev");
  seed(live);
  live.applyEvent(stepEvent(1, "CLICK", { index: 1, label: "Nút Đăng nhập" }));
  ok(live.isBusy() === true, "a text-less Jev run in progress reports busy — the working indicator is accurate, not a stall");
  ok(live.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.STREAMING, "…and its phase is streaming while the loop runs");

  const liveHtml = turnRender.renderTurnHtml(turnOf(live), { isLatestStreaming: true, busy: true, elapsedVisible: false });
  ok(!liveHtml.includes("stream-cursor"), "no answer cursor is drawn for a run that produces no answer text");

  // The run ends: the busy indicator resolves through the run's own lifecycle,
  // with no text ever having arrived. This jev_end predates the completion
  // check's `doneVerified` field on purpose — a transcript recorded by an
  // older host — so it also pins the backward-compatible disclosure below;
  // the verified and unverified-new shapes are asserted in their own block.
  live.applyEvent({ type: "jev_end", runId: RUN, outcome: "done", reason: null, steps: 1, doneIsDecided: true });
  live.applyEvent({ type: "run_done", runId: RUN });
  const doneTurn = turnOf(live);
  ok(live.isBusy() === false, "the busy indicator resolves on run_done for a text-less Jev run — nothing waits for assistant text");
  ok(live.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.COMPLETED, "the panel reports completed");
  ok(doneTurn.text === "" && doneTurn.toolRows.length === 1, "the turn shows its step and no invented answer");

  const doneHtml = turnRender.renderTurnHtml(doneTurn, renderOpts);
  ok(doneHtml.includes('data-jev-outcome="done"'), "the terminal outcome line is rendered under the turn");
  ok(doneHtml.includes("Đã xong") && doneHtml.includes("chưa được kiểm chứng độc lập"), "…as done-as-decided, with the disclosure that it was the model's own judgment");
  ok(/<div class="prose"[^>]*><\/div>/.test(doneHtml), "the answer body is empty — no fabricated assistant prose for a Jev run");

  // Rebuilt: the same transcript through a snapshot renders byte-identically.
  const events = [
    { seq: 1, type: "run_created", runId: RUN },
    { seq: 2, type: "run_started", runId: RUN },
    { seq: 3, type: "jev_step", runId: RUN, step: 1, operation: "CLICK", intent: "phần tử theo ý định của mô hình", target: { index: 1, label: "Nút Đăng nhập" }, targetProbability: 0.9, confidence: 0.85, tool: "computer", argsSummary: "action: left_click", latencies: { decisionMs: 400, selectionMs: 250, dispatchMs: 80 }, pageChanged: true },
    { seq: 4, type: "jev_end", runId: RUN, outcome: "done", reason: null, steps: 1, doneIsDecided: true },
    { seq: 5, type: "run_done", runId: RUN }
  ];
  const rebuilt = new ConversationModel("conv-jev");
  rebuilt.seedLocalPrompts(new Map([[RUN, "đăng nhập giúp tôi"]]));
  rebuilt.applySnapshot({ conversationId: "conv-jev", meta: {}, lastSeq: 5, firstSeq: 1, hasOlder: false, events });
  const rebuiltHtml = turnRender.renderTurnHtml(turnOf(rebuilt), renderOpts);
  ok(turnOf(rebuilt).toolRows.length === 1, "the rebuilt transcript restores the step rows exactly once");
  ok(rebuiltHtml === doneHtml, "live and rebuilt render byte-identical markup (step rows, labels and the outcome line alike)");

  // A late jev_end (after the run's own terminal event) must still reach the
  // DOM — it is part of the structure signature for exactly this reason.
  const late = new ConversationModel("conv-jev-late");
  seed(late);
  const beforeEnd = structureSignature(late, { busy: false });
  late.applyEvent({ type: "jev_end", runId: RUN, outcome: "blocked", reason: "no_progress", steps: 4, doneIsDecided: false });
  ok(structureSignature(late, { busy: false }) !== beforeEnd, "the outcome line is part of the structure signature, so a jev_end renders even when nothing else changed");

  // Stopped: labelled distinctly, never as a completion.
  const stopped = new ConversationModel("conv-jev-stop");
  seed(stopped);
  stopped.applyEvent(stepEvent(1, "CLICK", { index: 2, label: "Áp dụng" }));
  stopped.applyEvent({ type: "run_stopped", runId: RUN, reason: "user_stop" });
  stopped.applyEvent({ type: "jev_end", runId: RUN, outcome: "stopped", reason: "stopped", steps: 1, doneIsDecided: false });
  const stoppedHtml = turnRender.renderTurnHtml(turnOf(stopped), renderOpts);
  ok(stoppedHtml.includes('data-jev-outcome="stopped"') && stoppedHtml.includes("Đã dừng"), "a stopped Jev run is labelled stopped");
  ok(stoppedHtml.includes("lượt chạy đã bị dừng"), "…with the runtime's own stop reason translated, never the raw token");
  ok(!stoppedHtml.includes(">stopped<") && !/lý do: stopped/.test(stoppedHtml), "…and no raw reason token is shown");
  ok(!stoppedHtml.includes("chưa được kiểm chứng độc lập"), "…and is never labelled as a decided completion");
  ok(stoppedHtml.includes("câu trả lời chưa hoàn chỉnh"), "the run-lifecycle note still applies alongside it");

  // Failed: distinctly labelled as a failure, coloured as an error.
  const failed = new ConversationModel("conv-jev-fail");
  seed(failed);
  failed.applyEvent({ type: "run_error", runId: RUN, reason: "invalid_decision", detail: "probabilities do not sum to 1" });
  failed.applyEvent({ type: "jev_end", runId: RUN, outcome: "error", reason: "invalid_decision", steps: 0, doneIsDecided: false });
  const failedHtml = turnRender.renderTurnHtml(turnOf(failed), renderOpts);
  ok(failedHtml.includes('data-jev-outcome="error"') && failedHtml.includes("Thất bại"), "a failed Jev run is labelled as a failure");
  ok(failedHtml.includes("câu trả lời của TypeSafe không hợp lệ"), "…with the invalid decision translated, not the raw reason token");
  ok(!failedHtml.includes("invalid_decision"), "…so the runtime's English identifier never reaches the operator");
  ok(/class="turn-status-note is-error"[^>]*data-jev-outcome="error"/.test(failedHtml), "…in the error treatment, so it reads as an error and not as a quieter outcome");
  ok(turnRender.renderJevOutcomeHtml({ toolRows: [] }) === "", "a turn with no Jev outcome renders no outcome line at all (every LLM turn is unchanged)");
}

console.log("== a Jev done is labelled as verified or as the decision model's judgment alone ==");
{
  const RUN = "rv";
  const seed = (m) => {
    m.addLocalUserMessage("đăng nhập giúp tôi");
    m.bindRunToLastUserMessage(RUN);
    m.applyEvent({ type: "run_created", runId: RUN });
    m.applyEvent({ type: "run_started", runId: RUN });
  };
  const renderOpts = { isLatestStreaming: false, busy: false, elapsedVisible: false };
  const turnOf = (m) => m.items.find((i) => i.kind === "assistant_turn");

  // Verified: the completion check confirmed the goal (add-jev-run-context
  // design.md §7/§8) — the terminal line says so and never reads as the
  // decision model's judgment alone.
  const verified = new ConversationModel("conv-jev-verified");
  seed(verified);
  verified.applyEvent({
    type: "jev_step",
    runId: RUN,
    step: 1,
    operation: "DONE",
    tool: null,
    target: null,
    latencies: { decisionMs: 250 },
    pageChanged: false,
    skippedReason: "done",
    verification: { achieved: true }
  });
  verified.applyEvent({ type: "jev_end", runId: RUN, outcome: "done", reason: null, steps: 1, doneIsDecided: true, doneVerified: true });
  verified.applyEvent({ type: "run_done", runId: RUN });
  const verifiedHtml = turnRender.renderTurnHtml(turnOf(verified), renderOpts);
  ok(verifiedHtml.includes('data-jev-outcome="done"') && verifiedHtml.includes('data-jev-verified="true"'), "a done the completion check confirmed is marked verified");
  ok(verifiedHtml.includes("kiểm tra hoàn thành đã xác nhận"), "…and the terminal line says the check confirmed it");
  ok(!verifiedHtml.includes("chưa được kiểm chứng độc lập"), "…never also reading as the decision model's judgment alone");

  // Judgment alone: the check could not be made, so the run still ends done
  // with the older disclosure — and the DOM says which case this is.
  const judged = new ConversationModel("conv-jev-judged");
  seed(judged);
  judged.applyEvent({ type: "jev_end", runId: RUN, outcome: "done", reason: null, steps: 2, doneIsDecided: true, doneVerified: false });
  judged.applyEvent({ type: "run_done", runId: RUN });
  const judgedHtml = turnRender.renderTurnHtml(turnOf(judged), renderOpts);
  ok(judgedHtml.includes('data-jev-verified="false"'), "a done with no completion check is marked unverified");
  ok(judgedHtml.includes("theo quyết định của mô hình, chưa được kiểm chứng độc lập"), "…and keeps the judgment-alone disclosure");

  // The two disclosed check failures are distinguishable in the rendered line
  // too, and neither prints the raw error text (add-jev-run-context §7/§8).
  const noReport = new ConversationModel("conv-jev-no-report");
  seed(noReport);
  noReport.applyEvent({
    type: "jev_end",
    runId: RUN,
    outcome: "done",
    reason: null,
    steps: 1,
    doneIsDecided: true,
    doneVerified: true,
    summaryError: "the completion check confirmed the goal but produced no report"
  });
  noReport.applyEvent({ type: "run_done", runId: RUN });
  const noReportHtml = turnRender.renderTurnHtml(turnOf(noReport), renderOpts);
  ok(noReportHtml.includes('data-jev-verified="true"') && noReportHtml.includes("không tạo được báo cáo"), "a confirmed completion whose report failed says so");
  ok(!noReportHtml.includes("produced no report"), "…without leaking the raw error text into the panel");
  ok(!noReportHtml.includes("chưa được kiểm chứng"), "…and still reads as confirmed");

  const checkFailed = new ConversationModel("conv-jev-check-failed");
  seed(checkFailed);
  checkFailed.applyEvent({
    type: "jev_end",
    runId: RUN,
    outcome: "done",
    reason: null,
    steps: 2,
    doneIsDecided: true,
    doneVerified: false,
    summaryError: "HTTP 503"
  });
  checkFailed.applyEvent({ type: "run_done", runId: RUN });
  const checkFailedHtml = turnRender.renderTurnHtml(turnOf(checkFailed), renderOpts);
  ok(
    checkFailedHtml.includes('data-jev-verified="false"') && checkFailedHtml.includes("không thực hiện được kiểm tra hoàn thành"),
    "a done whose check could not be made names that failure"
  );
  ok(checkFailedHtml.includes("chưa được kiểm chứng độc lập") && !checkFailedHtml.includes("HTTP 503"), "…on the judgment-alone line, with no raw error text");
  ok(!judgedHtml.includes("không thực hiện được kiểm tra hoàn thành"), "…while a record without summaryError keeps the older line exactly");

  // Disputed to the bound: blocked with the unverified-completion reason, never
  // rendered as a done.
  const disputed = new ConversationModel("conv-jev-disputed");
  seed(disputed);
  disputed.applyEvent({
    type: "jev_step",
    runId: RUN,
    step: 1,
    operation: "DONE",
    tool: null,
    target: null,
    latencies: { decisionMs: 250 },
    pageChanged: false,
    skippedReason: "completion_rejected",
    verification: { achieved: false }
  });
  disputed.applyEvent({ type: "jev_end", runId: RUN, outcome: "blocked", reason: "completion_unverified", steps: 1, doneIsDecided: false });
  disputed.applyEvent({ type: "run_done", runId: RUN });
  const disputedHtml = turnRender.renderTurnHtml(turnOf(disputed), renderOpts);
  ok(disputedHtml.includes('data-jev-outcome="blocked"'), "a completion the check kept disputing is rendered as blocked");
  ok(disputedHtml.includes("kiểm tra hoàn thành chưa xác nhận hoặc không thực hiện được"), "…with the unverified-completion reason translated");
  ok(!disputedHtml.includes("data-jev-verified"), "…and no verified marker is claimed for a blocked outcome");
  ok(!disputedHtml.includes("Đã xong"), "…so it is never presented as a completion");
}

console.log("== a Jev step row renders its own label, and a step that was never dispatched says so ==");
{
  const model = new ConversationModel("conv-jev-rows");
  model.addLocalUserMessage("mua vé");
  model.bindRunToLastUserMessage("rr");
  model.applyEvent({ type: "run_created", runId: "rr" });
  model.applyEvent({ type: "run_started", runId: "rr" });
  model.applyEvent({ type: "jev_step", runId: "rr", step: 1, operation: "TYPE_TEXT", intent: "ô nhập email", target: { index: 5, label: "Email" }, targetProbability: 0.9, confidence: 0.9, tool: "form_input", argsSummary: "ref: ref_5", textField: "Email", latencies: { decisionMs: 300, selectionMs: 220, dispatchMs: 60 }, pageChanged: false });
  model.applyEvent({ type: "jev_step", runId: "rr", step: 2, operation: "CLICK", intent: "nút Thanh toán", target: { index: 6, label: "Thanh toán" }, targetProbability: 0.7, confidence: 0.7, tool: null, argsSummary: null, skippedReason: "action_denied", latencies: { decisionMs: 320, selectionMs: 210, dispatchMs: 0 }, pageChanged: false });
  const rows = model.items.find((i) => i.kind === "assistant_turn").toolRows;

  const executedHtml = toolRowRender.toolRowHtml(rows[0]);
  ok(
    executedHtml.includes("Đã nhập văn bản (mô hình quyết định) — Jev chọn: Email"),
    `an executed step reads as the model's operation and the element Jev selected (got "${toolRowDisplay(rows[0]).label}")`
  );
  ok(executedHtml.includes("ý định: ô nhập email"), "…naming the intent the element was selected for");
  ok(!executedHtml.includes("xác suất thao tác"), "…with no operation-probability copy anywhere");
  ok(!executedHtml.includes("Không thực thi"), "…with no skipped pill");
  ok(executedHtml.includes("trường văn bản: Email") && executedHtml.includes("chọn phần tử 220ms"), "the expandable detail names the text field and Jev's selection latency");

  const skippedHtml = toolRowRender.toolRowHtml(rows[1]);
  ok(skippedHtml.includes('data-status="skipped"'), "a step that dispatched nothing carries the skipped status");
  ok(skippedHtml.includes("Không thực thi"), "…and is labelled as not executed, never as a success");
  ok(skippedHtml.includes("Chưa gửi thao tác nào"), "…stating in the row itself that nothing was sent");
  ok(!skippedHtml.includes("Đã click"), "…and never implying the click happened");
  ok(toolRowRender.statusWordVi("skipped") === "Không thực thi", "the status word for the shipped renderer is Vietnamese");

  // A run-memory row (add-jev-run-context design.md §8) renders through the
  // same real row renderer: its label names the record and what triggered it,
  // and its detail carries the model's context verbatim.
  const memoryModel = new ConversationModel("conv-jev-memory");
  memoryModel.applyEvent({ type: "run_started", runId: "rm" });
  memoryModel.applyEvent({
    type: "jev_memory",
    runId: "rm",
    index: 1,
    kind: "plan",
    trigger: "start",
    memory: { plan: "Mở trang danh sách rồi lọc theo tỉnh", doneWhen: "Danh sách đã lọc hiển thị", notes: "Bắt đầu" },
    latencyMs: 800
  });
  const memoryRow = memoryModel.items.find((i) => i.kind === "assistant_turn").toolRows[0];
  const memoryHtml = toolRowRender.toolRowHtml(memoryRow);
  ok(memoryHtml.includes("Kế hoạch lượt chạy — khi bắt đầu"), "a memory row renders its own label in the timeline");
  ok(
    memoryHtml.includes("kế hoạch: Mở trang danh sách rồi lọc theo tỉnh") && memoryHtml.includes("điều kiện hoàn thành: Danh sách đã lọc hiển thị"),
    "…with the model's context in its expandable detail"
  );
  ok(!memoryHtml.includes("Không thực thi"), "…and never the skipped pill: recording context is not an unexecuted action");
}

console.log(fail === 0 ? "\nALL SIDEPANEL STREAMING RENDER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

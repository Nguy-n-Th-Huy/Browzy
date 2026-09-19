#!/usr/bin/env node
//
// The TypeSafe/Jev run loop (host/agent/jev/runtime.js) driven end to end with
// a fake tool bridge, REAL `Run`/`ApprovalRegistry` objects, and the REAL
// `createCanUseTool` approval gate plus the REAL shared dispatch checks — per
// openspec/changes/add-jev-run-context design.md §10 ("Step decisions from the
// configured model; Jev selects the element") and the `typesafe-jev-provider`
// spec's "Step decisions from the configured model", "Guarded execution
// through the existing dispatch discipline", "Bounded run and honest
// outcomes", and "Observable step record" requirements.
//
// The configured model prepares content and verifies completion; TypeSafe's
// three independent heads choose complete actions and monitor progress.
// Both protocols go to a local stub HTTP
// server (no live provider), and the browser side is a fake bridge that
// records what would have been dispatched — so the assertions here are about
// the loop's decisions, its gates, and its events, never about a real browser.
//
// Every scenario also asserts the invariant the whole design rests on: no
// dispatch happens unless the shared host-side checks passed, no element
// reaches a dispatch unless TypeSafe offered it, and no generated text value is
// ever persisted in a durable event.
//
// Run: node host/test/jev-runtime.test.mjs

import http from "node:http";

import { Run, RUN_STATES } from "../agent/session/run.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { createCanUseTool } from "../agent/policy/can-use-tool.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { isBorrowedTabMutationAuthorized, authorizeBorrowedTabMutation } from "../agent/tools/mapping.js";
import { runTypesafeRun, MAX_ACTIONS, MAX_DECISIONS, MAX_REPLAY_URL_CHARS, MEMORY_UPDATE_EVERY_ACTIONS, MAX_MEMORY_UPDATES, MAX_VERIFICATION_REJECTIONS, MAX_RECOVERIES, SCROLL_ONLY_STREAK_LIMIT } from "../agent/jev/runtime.js";
import { ACTION_PLAN, NEXT_STEP, TARGET_SELECTION, RUN_PLAN, MEMORY_REVISION, COMPLETION_CHECK, STALL_RECOVERY, FINAL_REPORT } from "../agent/jev/text-helper.js";
import { HOST_DROPPED_ERROR } from "../tool-runtime.js";
import { fetchSource } from "../agent/jev/source-fetch.js";
import { deriveRunDraft } from "../agent/skills/workflows-materialize.js";

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

const TAB_ID = 7;

// --- snapshots -------------------------------------------------------------

function snapshot(overrides = {}) {
  return {
    v: 1,
    docNonce: "runtime-test-document",
    url: "https://example.com/search",
    title: "Flight search",
    viewport: { w: 800, h: 600 },
    scroll: { y: 0, height: 600 },
    text: "Find flights",
    truncated: { elements: false, text: false, omitted: 0 },
    elements: [
      { ref: "ref_1", role: "textbox", label: "Where to?", tag: "input", type: "text", value: "", editable: true },
      { ref: "ref_2", role: "button", label: "Search", tag: "button" }
    ],
    ...overrides
  };
}

// A page after a value was typed into the textbox.
function filledSnapshot() {
  const snap = snapshot();
  snap.elements[0].value = "Zurich";
  return snap;
}

// A page after the search button was clicked.
function resultsSnapshot() {
  const snap = filledSnapshot();
  snap.url = "https://example.com/results";
  snap.text = "2 flights found";
  return snap;
}

function unavailablePage(url = "chrome://newtab/", options = {}) {
  const { legacy = false, tabId = TAB_ID, reason = "restricted_page" } = options;
  const text = legacy
    ? `Restricted page: tab ${tabId} (${url}) is a browser-internal or store page that cannot be read by content scripts. Identify this limitation to the user rather than guessing its content or opening a different tab.`
    : JSON.stringify({ v: 1, available: false, reason, tabId, url });
  return { content: [{ type: "text", text }], ...(!legacy ? { isError: true } : {}) };
}

async function startupHarness({ initial = unavailablePage(), callTool, ...options } = {}) {
  let first = true;
  return harness({
    ...options,
    callTool: async (request) => {
      if (request.name === "page_snapshot" && first) {
        first = false;
        return initial;
      }
      return callTool ? callTool(request) : undefined;
    }
  });
}

// --- stub model server -----------------------------------------------------

/** A one-hot probability map over exactly the offered ids. */
function oneHot(ids, chosen) {
  const probabilities = {};
  for (const id of ids) probabilities[id] = id === chosen ? 1 : 0;
  return probabilities;
}

/** The full runtime answer. Monitors are independently negative by default. */
function selectionAnswer(body, chosen) {
  return Object.fromEntries(Object.entries(body.questions).map(([name, head]) => {
    const choice = name === "action" ? chosen : "no";
    return [name, { choice, probabilities: oneHot(Object.keys(head.criteria), choice), confidence: 0.9 }];
  }));
}

/** First target-bearing offered action, used by the scripted fill scenario. */
function firstOfferedKey(body) {
  if (body?.questions?.action) return Object.entries(body.questions.action.criteria).find(([, criterion]) => JSON.parse(criterion).ref)?.[0] ?? null;
  const headName = Object.keys(body?.questions ?? {})[0];
  if (!headName) return null;
  const ids = Object.keys(body.questions[headName].criteria ?? {});
  return ids[0] ?? null;
}

function completion(content) {
  return { choices: [{ message: { content } }], usage: { total_tokens: 4 } };
}

// The memory the default text-model stub plans and revises with. Tests that
// care about the content script their own; this one only has to be a valid
// memory so the ordinary paths (plan → decide → check) run as designed.
const RUN_MEMORY = Object.freeze({ plan: "Mở trang kết quả và kiểm tra danh sách chuyến bay.", doneWhen: "Trang kết quả hiển thị danh sách chuyến bay.", notes: "Đang ở trang tìm kiếm." });
const REVISED_MEMORY = Object.freeze({ plan: "Mở trang kết quả và đọc bảng kết quả.", doneWhen: "Bảng kết quả hiển thị chuyến bay đã chọn.", notes: "Trang đã điều hướng sang kết quả." });

const instructionOf = (body) => body?.messages?.[0]?.content;

/** The text-model calls the stub answered for one instruction, in order. */
const chatCalls = (server, instruction) =>
  server.state.bodies.filter((b, i) => String(server.state.paths[i]).endsWith("/chat/completions") && instructionOf(b) === instruction);

/** Shared state Jev actually received for routine decisions. */
const stepDecisions = (server) => server.state.bodies.filter((body) => body?.questions?.action).map((body) => body.state);

const contextOf = (body) => {
  const content = body?.messages?.[1]?.content;
  return JSON.parse(Array.isArray(content) ? content.find((part) => part.type === "text").text : content);
};
const actionPlanCalls = (server, reason) => chatCalls(server, ACTION_PLAN).filter((body) => contextOf(body).reason === reason);
const preparedPlan = (memory) => ({ memory, textValues: [], navigation: [] });

/**
 * The default reply to every instruction the step script does not own, derived
 * from the request's own instruction — never from a call index, so a test that
 * adds a plan or a revision cannot silently shift another call's reply:
 *   - the plan and every revision answer a valid memory;
 *   - the completion check confirms with a report;
 *   - the stall consultation REFUSES (`block`), so a guard-tripped run keeps
 *     ending blocked with its own honest reason unless a test scripts a way
 *     forward.
 */
function defaultTextReply(body) {
  const instruction = instructionOf(body);
  if (instruction === RUN_PLAN || instruction === MEMORY_REVISION) return completion(JSON.stringify(RUN_MEMORY));
  if (instruction === COMPLETION_CHECK) return completion(JSON.stringify({ achieved: true, report: "Đã tìm thấy 2 chuyến bay." }));
  if (instruction === STALL_RECOVERY) return completion(JSON.stringify({ action: "block" }));
  if (instruction === FINAL_REPORT) return completion(JSON.stringify({ report: FINAL_REPORT_TEXT }));
  return completion(JSON.stringify(withEvaluation({ operation: "BLOCKED" })));
}

/**
 * Every step decision carries a bounded `evaluation` of the step before it,
 * and the validator refuses a decision without one. A test that is not about
 * the evaluation scripts the operation it cares about and gets a plausible
 * one here, so the field is exercised on every path without fifty fixtures
 * repeating it; a test that IS about it scripts its own (or omits it
 * deliberately to assert the refusal).
 */
// The answer a finished run owes the operator. Scripted here so every test
// exercises the call the run now makes on its way out.
const FINAL_REPORT_TEXT = "Opened the search page and stopped there; no result was retrieved.";

/** The run's answer text, in order. */
const jevResults = (events) => events.filter((e) => e.type === "jev_result");

function withEvaluation(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return step;
  if (typeof step.operation !== "string") return step;
  if (Object.prototype.hasOwnProperty.call(step, "evaluation")) return step;
  return { ...step, evaluation: "Bước trước đã chạy; trang hiện tại là cơ sở cho bước này." };
}

/**
 * One stub server for preparation/check/report completions and Jev decisions.
 *
 *   - `steps`: the step-decision scripting — an array of step objects consumed
 *     one per Jev request (the last entry repeats), or a
 *     `(body, index) => step` function. A step is a plain
 *     `{operation, intent?, text?, url?}` object, or `{status, payload}` to
 *     simulate a transport failure, or a raw string to answer unparsable JSON.
 *   - `select`: a candidate selector — a legacy table index ("2", "3:2"),
 *     an opaque action key, a full
 *     `{answers}` body, `{status, payload}`, `{raw}`, or a function of
 *     `(body, index)`; the default picks the first offered scripted operation.
 *     Explicit answer bodies are never repaired or normalized by this fixture.
 *   - `text`: a completion, `{status, payload}`, or `undefined` to fall back to
 *     `defaultTextReply` — for any `/chat/completions` call.
 */
async function startModelServer({ steps, select, text } = {}) {
  const state = { paths: [], bodies: [], systemone: 0, chat: 0, decisions: 0, preparationContexts: [] };
  const scripted = typeof steps === "function" ? steps : Array.isArray(steps) ? (body, index) => steps[Math.min(index, steps.length - 1)] : () => ({ operation: "BLOCKED" });
  // Static scripts declare the content they require up front. Functional
  // scripts should supply explicit ACTION_PLAN replies for dynamic content;
  // calling them during preparation could trigger test side effects early.
  const defaultPlan = (body) => {
    const context = contextOf(body);
    const remaining = Array.isArray(steps) ? steps.slice(state.decisions) : [];
    const type = remaining.find((step) => step?.operation === "TYPE_TEXT");
    const field = context.elements?.find((el) => el.operations?.includes("TYPE_TEXT") && !el.readonly);
    const navigation = [...new Set(remaining.filter((step) => step?.operation === "NAVIGATE").map((step) => step.url))].map((url) => ({ url, purpose: "Navigate to the scenario's requested page" }));
    return { memory: RUN_MEMORY, textValues: type && field ? [{ element: field.index, value: type.text }] : [], navigation };
  };
  const actionKey = (body, step, chosen) => {
    const operation = step?.operation === "BLOCKED" ? "ASK" : step?.operation;
    const candidates = Object.entries(body.questions.action.criteria).map(([key, criterion]) => [key, JSON.parse(criterion)]).filter(([, action]) => action.operation === operation);
    if (typeof chosen === "string" && /^a\d+$/.test(chosen)) return chosen;
    if (typeof chosen === "string") {
      const [index, option] = chosen.split(":").map(Number);
      const target = body.state.elements[index - 1];
      let matches = candidates.filter(([, action]) => action.ref === target?.ref);
      if (option) {
        const table = state.preparationContexts.at(-1)?.elements ?? [];
        const optionValue = table.find((el) => el.index === String(index))?.options?.[option - 1]?.value;
        matches = matches.filter(([, action]) => action.value === optionValue);
      }
      return matches[0]?.[0] ?? "NOT_OFFERED";
    }
    return candidates[0]?.[0] ?? "NOT_OFFERED";
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.paths.push(req.url);
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      state.bodies.push(body);
      if (String(req.url).endsWith("/chat/completions")) {
        state.chat += 1;
        const index = state.chat - 1;
        if (instructionOf(body) === ACTION_PLAN) {
          state.preparationContexts.push(contextOf(body));
          return respondChat(res, (text ? text(body, index) : undefined) ?? defaultPlan(body));
        }
        const reply = (text ? text(body, index) : undefined) ?? defaultTextReply(body);
        return respondChat(res, reply);
      }
      state.systemone += 1;
      const index = state.systemone - 1;
      state.decisions += 1;
      const step = scripted(body, state.decisions - 1);
      if (step && typeof step === "object" && (step.status || step.raw !== undefined || step.answers)) return respond(res, step);
      const chosen = select && ["CLICK", "TYPE_TEXT", "SELECT", "HOVER"].includes(step?.operation) ? select(body, index) : undefined;
      if (chosen && typeof chosen === "object" && (chosen.status || chosen.raw !== undefined || chosen.answers)) return respond(res, chosen);
      const key = actionKey(body, step, chosen);
      if (key === null) return sendJson(res, 200, { answers: {} });
      return sendJson(res, 200, { answers: selectionAnswer(body, key), usage: { total_tokens: 11 } });
    });
  });
  function respondChat(res, reply) {
    if (!reply) return sendJson(res, 500, { error: "stub had no scripted answer" });
    if (reply.status && reply.status !== 200) return sendJson(res, reply.status, reply.payload ?? { error: "stub error" });
    if (reply.raw !== undefined) return sendJson(res, 200, reply.raw);
    if (reply.choices) return sendJson(res, 200, reply);
    // A plain decision object (or a raw content string) becomes the assistant
    // message's content, exactly as a real completion would answer it.
    return sendJson(res, 200, completion(typeof reply === "string" ? reply : JSON.stringify(reply)));
  }
  function respond(res, reply) {
    if (!reply) return sendJson(res, 500, { error: "stub had no scripted answer" });
    if (reply.status && reply.status !== 200) return sendJson(res, reply.status, reply.payload ?? { error: "stub error" });
    if (reply.raw !== undefined) return sendJson(res, 200, reply.raw);
    return sendJson(res, 200, { answers: reply.answers, usage: { total_tokens: 11 } });
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

// --- run harness -----------------------------------------------------------

class TestTracker {
  constructor() {
    this.pending = new Map();
  }
  set(requestId, resolverFn, token) {
    this.pending.set(requestId, { resolverFn, token });
  }
  take(requestId) {
    const entry = this.pending.get(requestId);
    this.pending.delete(requestId);
    return entry;
  }
  clearRun() {
    this.pending.clear();
  }
  respond(requestId, decision) {
    const entry = this.take(requestId);
    if (entry) entry.resolverFn(decision);
  }
  get size() {
    return this.pending.size;
  }
}

/**
 * Build a started run plus the real approval gate wired to it.
 * `onApproval(event)` decides what the operator does with a card:
 * "approve" (default), "deny", "ignore" (let the registry TTL expire), or
 * "stop".
 */
async function harness({ tabScope = "any", snapshots = [snapshot()], onApproval = () => "approve", defaultTtlMs, callTool } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry(defaultTtlMs ? { defaultTtlMs } : undefined);
  const events = [];
  const bridgeCalls = [];
  const coercedArgs = [];
  const queue = [...snapshots];
  let lastSnapshot = queue.shift() ?? snapshot();

  const run = new Run({
    conversationId: "conv_jev",
    lease,
    approvals,
    tabScope,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval_request") {
        const verdict = onApproval(event);
        if (verdict === "approve" || verdict === "deny") {
          queueMicrotask(() => tracker.respond(event.requestId, { decision: verdict }));
        } else if (verdict === "stop") {
          queueMicrotask(() => run.stop("user_stop"));
        }
      }
    }
  });
  await run.begin();

  const tracker = new TestTracker();
  const canUseTool = createCanUseTool({ run, approvals, requestIdTracker: tracker });

  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name, args, meta) => {
      bridgeCalls.push({ name, args, meta });
      if (callTool) {
        const scripted = await callTool({ name, args, meta, bridgeCalls });
        if (scripted !== undefined) return scripted;
      }
      if (name === "page_snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(lastSnapshot) }] };
      }
      // Observation and approval preflight reads do not mutate the page.
      // Only a successful default action advances this scripted page state.
      if (name === "navigate" || name === "form_input" || (name === "computer" && args.action !== "screenshot")) {
        if (queue.length > 0) lastSnapshot = queue.shift();
      }
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    shutdown: () => {}
  });

  const coerceArgs = (args) => {
    coercedArgs.push(args);
    return { ...args, __coerced: true };
  };

  return { run, lease, approvals, events, tracker, canUseTool, toolBridge, bridgeCalls, coercedArgs, coerceArgs, snapshots: queue };
}

function providerFor(server, overrides = {}) {
  return {
    endpoint: server.url,
    apiKey: "ts-key",
    model: "jev-latest",
    goal: "Find a flight to Zurich",
    tabId: TAB_ID,
    textModel: { baseUrl: `${server.url}/v1`, model: "small-model", apiKey: "tm-key" },
    ...overrides
  };
}

const jevSteps = (events) => events.filter((e) => e.type === "jev_step");
const jevEnds = (events) => events.filter((e) => e.type === "jev_end");
const dispatches = (bridgeCalls) => bridgeCalls.filter((c) => c.name !== "page_snapshot");

// --- the capture path (openspec/changes/add-jev-run-screenshots) ----------
//
// The image content item the extension's `computer` screenshot action returns,
// and the two projections the capture tests assert on: which bridge calls were
// captures, and the data URL a `/chat/completions` user message carries.
const SCREENSHOT_B64 = "c2NyZWVuc2hvdC1ieXRlcw==";
function screenshotResult() {
  return {
    content: [
      { type: "text", text: "Successfully captured screenshot (800x600, jpeg) - ID: shot_1" },
      { type: "image", data: SCREENSHOT_B64, mimeType: "image/jpeg" }
    ]
  };
}
const captureCalls = (bridgeCalls) => bridgeCalls.filter((c) => c.name === "computer" && c.args?.action === "screenshot");
const captureStub = async ({ name, args }) => (name === "computer" && args?.action === "screenshot" ? screenshotResult() : undefined);
/** The image data URL of one request's user message, or null — a text-only
 * message is a plain string, which is the whole point of the assertion. */
const imageUrlOf = (body) => {
  const content = body?.messages?.[1]?.content;
  if (!Array.isArray(content)) return null;
  const part = content.find((block) => block && block.type === "image_url");
  return part ? part.image_url.url : null;
};
const expectedImageUrl = () => `data:image/jpeg;base64,${SCREENSHOT_B64}`;
// The run's own records with the per-run identity and call latencies dropped,
// for run-vs-run equality (two harnesses mint different run ids).
const stepsWithoutLatency = (events) => jevSteps(events).map(({ latencies, runId, conversationId, ...rest }) => rest);
const endsWithoutIdentity = (events) => jevEnds(events).map(({ runId, conversationId, ...rest }) => rest);

function assertOneEnd(events, outcome) {
  const ends = jevEnds(events);
  assert(ends.length === 1, `expected exactly one jev_end, got ${ends.length}`);
  assert(ends[0].outcome === outcome, `expected jev_end outcome ${outcome}, got ${ends[0].outcome}`);
  return ends[0];
}

console.log("\nJev runtime loop\n");

await test("the production bounds are the design's 60 actions / 120 decisions and the run-context limits", () => {
  assert(MAX_ACTIONS === 60 && MAX_DECISIONS === 120, `${MAX_ACTIONS}/${MAX_DECISIONS}`);
  assert(
    MEMORY_UPDATE_EVERY_ACTIONS === 5 && MAX_MEMORY_UPDATES === 8 && MAX_VERIFICATION_REJECTIONS === 3 && MAX_RECOVERIES === 2,
    `${MEMORY_UPDATE_EVERY_ACTIONS}/${MAX_MEMORY_UPDATES}/${MAX_VERIFICATION_REJECTIONS}/${MAX_RECOVERIES}`
  );
  assert(SCROLL_ONLY_STREAK_LIMIT === 8, `the scroll-only streak limit is the design's 8 (got ${SCROLL_ONLY_STREAK_LIMIT})`);
});

await test("happy path: one preparation supports Jev actions and completion requires verification", async () => {
  const server = await startModelServer({
    steps: [
      { operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" },
      { operation: "CLICK", intent: "the Search button" },
      { operation: "DONE" }
    ],
    select: (body, index) => (index === 1 ? "2" : firstOfferedKey(body))
  });
  const h = await harness({ snapshots: [snapshot(), filledSnapshot(), resultsSnapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.reason === null, JSON.stringify(outcome));
    assert(outcome.steps === 2, `expected 2 executed actions, got ${outcome.steps}`);
    const end = assertOneEnd(h.events, "done");
    assert(end.doneIsDecided === true && end.steps === 2 && end.reason === null, JSON.stringify(end));
    // The runtime never owns lifecycle: the companion finishes the run.
    assert(h.run.state === RUN_STATES.RUNNING, `the runtime must not finish the run (state ${h.run.state})`);

    const steps = jevSteps(h.events);
    assert(steps.length === 3, `one jev_step per cycle (expected 3, got ${steps.length})`);
    const [typeStep, clickStep, doneStep] = steps;
    assert(typeStep.operation === "TYPE_TEXT" && typeStep.tool === "form_input", JSON.stringify(typeStep));
    assert(typeStep.intent === "Where to?" && typeStep.decisionSource === "jev", "the observed target and decision origin must be recorded");
    assert(typeStep.target.index === typeStep.actionKey && typeStep.target.label === "Where to?", JSON.stringify(typeStep.target));
    assert(typeStep.target.role === "textbox" && clickStep.target.role === "button", "replay identities retain the observed roles");
    assert(typeStep.targetProbability === 1 && typeStep.confidence === 0.9, JSON.stringify(typeStep));
    assert(!("operationProbability" in typeStep), "no operation probability exists any more");
    assert(typeStep.textField === "Where to?", "the step must name the field that received the value");
    assert(!("value" in typeStep.argsSummary), `a typed value must never be recorded: ${JSON.stringify(typeStep.argsSummary)}`);
    assert(
      typeof typeStep.latencies.decisionMs === "number" && typeStep.latencies.selectionMs === undefined && typeof typeStep.latencies.dispatchMs === "number",
      JSON.stringify(typeStep.latencies)
    );
    assert(typeStep.pageChanged === true, "the typed value changed the observation");
    assert(clickStep.operation === "CLICK" && clickStep.tool === "computer", JSON.stringify(clickStep));
    assert(clickStep.intent === "Search" && clickStep.target.index === clickStep.actionKey, JSON.stringify(clickStep));
    assert(clickStep.argsSummary.action === "left_click" && clickStep.argsSummary.ref === "ref_2", JSON.stringify(clickStep.argsSummary));
    assert(clickStep.pageChanged === true, "the click navigated, so the observation changed");
    assert(doneStep.operation === "DONE" && doneStep.tool === null && doneStep.skippedReason === "done", JSON.stringify(doneStep));
    assert(doneStep.target === null && doneStep.latencies.selectionMs === undefined, "a DONE step selects no element");

    const dispatched = dispatches(h.bridgeCalls);
    assert(dispatched.length === 2, `expected exactly 2 dispatches, got ${dispatched.length}`);
    assert(dispatched[0].name === "form_input" && dispatched[0].args.value === "Zurich" && dispatched[0].args.ref === "ref_1", JSON.stringify(dispatched[0].args));
    assert(dispatched[1].name === "computer" && dispatched[1].args.action === "left_click", JSON.stringify(dispatched[1].args));
    // Every bridge call — observation included — carries the run's wire meta.
    assert(h.bridgeCalls.every((c) => c.meta && c.meta.runId === h.run.runId), "every dispatch must carry the run's wire meta");
    assert(h.bridgeCalls.every((c) => c.args.__coerced === true), "every dispatch must pass through coerceArgs");
    // The typed value reached exactly one dispatch and no durable event.
    const dispatchCount = dispatched.filter((c) => JSON.stringify(c.args).includes("Zurich")).length;
    assert(dispatchCount === 1, `the typed value must be dispatched once, not ${dispatchCount} times`);
    assert(!JSON.stringify(steps).includes("Zurich"), "no durable event may carry the typed value");

    // ONE step decision per cycle, each carrying the observation and the steps.
    const decisions = stepDecisions(server);
    assert(decisions.length === 3, `exactly one step decision per cycle (got ${decisions.length})`);
    assert(
      server.state.decisions === 3 && actionPlanCalls(server, "start").length === 1 && chatCalls(server, COMPLETION_CHECK).length === 1 && chatCalls(server, NEXT_STEP).length === 0,
      `one preparation, three Jev decisions and verification (${JSON.stringify(server.state.chat)})`
    );
    const secondDecision = decisions[1];
    assert(secondDecision.goal === "Find a flight to Zurich", JSON.stringify(secondDecision.goal));
    assert(secondDecision.page.url === "https://example.com/search", JSON.stringify(secondDecision.page));
    assert(secondDecision.recent_actions.length === 1 && secondDecision.recent_actions[0].kind === "fill", JSON.stringify(secondDecision.recent_actions));
    assert(secondDecision.recent_actions[0].action === "Where to?" && secondDecision.recent_actions[0].page_changed === true, JSON.stringify(secondDecision.recent_actions));
    assert(JSON.stringify(secondDecision.memory) === JSON.stringify(RUN_MEMORY), "the plan's memory rides every step decision");

    // TWO selection requests for the two target-bearing steps: one question
    // each, carrying the decided operation's own candidates and its intent.
    const selections = server.state.bodies.filter((b, i) => server.state.paths[i] === "/v1/systemone");
    assert(selections.length === 3, `one Jev decision per cycle including DONE (got ${selections.length})`);
    assert(selections[0].state.elements.length === 2, JSON.stringify(selections[0].state.elements));
    assert(selections.every((body) => Object.keys(body.questions).join(",") === "action,goal_done,stuck"), "every decision has all three independent heads");
    assert(selections.every((body) => Object.keys(body.questions.action.criteria).every((key) => /^a\d+$/.test(key))), "only offered opaque action keys can be selected");
    assert(selections[1].state.recent_actions.length === 1 && selections[1].state.recent_actions[0].kind === "fill", JSON.stringify(selections[1].state.recent_actions));
    // The TypeSafe decision succeeded through the real approval card.
    assert(h.events.some((e) => e.type === "approval_request"), "the click must have raised a real approval card");
    assert(h.run.unknownResults().length === 0, "no dispatch may be recorded as result-unknown here");
  } finally {
    await server.close();
  }
});

await test("SELECT records its control identity separately from the option for workflow replay", async () => {
  const selectSnapshot = snapshot({ elements: [{
    ref: "ref_1", role: "combobox", tag: "select", label: "Destination country", value: "ca",
    options: [{ label: "Canada", value: "ca", selected: true }, { label: "Japan", value: "jp" }]
  }] });
  const server = await startModelServer({ steps: [{ operation: "SELECT", intent: "choose Japan" }, { operation: "DONE" }], select: () => "1:2" });
  const h = await harness({ snapshots: [selectSnapshot, snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.steps === 1, JSON.stringify(outcome));
    const step = jevSteps(h.events)[0];
    assert(step.target.label === "Japan" && step.target.elementLabel === "Destination country" && step.target.role === "combobox", JSON.stringify(step));
    assert(step.argsSummary.value === "jp", "the option's page value is recorded");
    const conversationEvents = [{ type: "run_created" }, ...jevSteps(h.events), { type: "run_done" }]
      .map((event, index) => ({ ...event, runId: "run_select_workflow", seq: index + 1 }));
    const derived = deriveRunDraft({ conversationEvents, runId: "run_select_workflow" });
    assert(derived.ok, JSON.stringify(derived));
    const replay = derived.draft.steps[1];
    assert(replay.ref === "form_input" && replay.args.target.name === "Destination country" && replay.args.value === "jp", JSON.stringify(replay));
    assert(replay.args.ref === undefined && replay.args.tabId === undefined, "replay resolves a new element on the addressed tab");
  } finally {
    await server.close();
  }
});

await test("workflow recording keeps complete long starting URLs independently of the panel digest", async () => {
  assert(MAX_REPLAY_URL_CHARS === 8192, "capture and materialization share the bounded URL contract");
  for (const url of [
    "https://example.com/".padEnd(200, "x"),
    `https://example.com/search?q=${"flight+search+".repeat(30)}&destination=Z%C3%BCrich#results`,
    "https://example.com/".padEnd(MAX_REPLAY_URL_CHARS, "x")
  ]) {
    const server = await startModelServer({ steps: [{ operation: "WAIT" }, { operation: "DONE" }] });
    const h = await harness({ snapshots: [snapshot({ url }), snapshot()] });
    try {
      const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
      assert(outcome.outcome === "done" && outcome.steps === 1, JSON.stringify(outcome));
      const step = jevSteps(h.events)[0];
      assert(step.observed.url === url.slice(0, 200), "the panel digest is unchanged");
      assert(step.observed.replayUrl === url && step.observed.replayUrlTruncated === false, "the durable replay URL is explicitly complete");
      const conversationEvents = [{ type: "run_created" }, ...jevSteps(h.events), { type: "run_done" }]
        .map((event, index) => ({ ...event, runId: "run_long_url", seq: index + 1 }));
      const derived = deriveRunDraft({ conversationEvents, runId: "run_long_url" });
      assert(derived.ok && derived.draft.steps[0].ref === "navigate" && derived.draft.steps[0].args.url === url, JSON.stringify(derived));
    } finally {
      await server.close();
    }
  }
});

await test("workflow recording explicitly refuses an over-bound starting URL without saving its prefix for replay", async () => {
  const url = "https://example.com/".padEnd(MAX_REPLAY_URL_CHARS + 1, "x");
  const server = await startModelServer({ steps: [{ operation: "WAIT" }, { operation: "DONE" }] });
  const h = await harness({ snapshots: [snapshot({ url }), snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const step = jevSteps(h.events)[0];
    assert(step.observed.url.length === 200 && step.observed.replayUrl === null && step.observed.replayUrlTruncated === true, JSON.stringify(step.observed));
    assert(!JSON.stringify(step).includes(url), "the oversized URL is not written to the step");
    const conversationEvents = [{ type: "run_created" }, ...jevSteps(h.events), { type: "run_done" }]
      .map((event, index) => ({ ...event, runId: "run_oversize_url", seq: index + 1 }));
    const derived = deriveRunDraft({ conversationEvents, runId: "run_oversize_url", metaHostname: "example.com" });
    assert(!derived.ok && !derived.draft && derived.incomplete.some((r) => /starting page:.*capture limit/.test(r)), JSON.stringify(derived));
  } finally {
    await server.close();
  }
});

await test("a send-class click suspends on the approval card and dispatches only on allow", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const card = h.events.find((e) => e.type === "approval_request");
    assert(card, "an unresolved-ref click must raise the card");
    assert(JSON.stringify(card.target).includes("ref_2"), `the card must bind the actual target: ${JSON.stringify(card.target)}`);
    assert(dispatches(h.bridgeCalls).length === 1, "exactly one dispatch after the Allow");
    assert(h.tracker.size === 0, "the pending approval must have been consumed");
  } finally {
    await server.close();
  }
});

await test("a denied approval dispatches nothing and ends blocked naming the action", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot()], onApproval: () => "deny" });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "action_denied", JSON.stringify(outcome));
    assert(outcome.steps === 0, `a denied action is not an executed action (steps ${outcome.steps})`);
    const end = assertOneEnd(h.events, "blocked");
    assert(end.reason === "action_denied" && end.doneIsDecided === false, JSON.stringify(end));
    assert(dispatches(h.bridgeCalls).length === 0, "a denied approval must never reach the bridge");
    const step = jevSteps(h.events)[0];
    assert(step.operation === "CLICK" && step.skippedReason === "action_denied", JSON.stringify(step));
    assert(step.tool === "computer" && step.argsSummary.action === "left_click", "the record must show what was refused");
  } finally {
    await server.close();
  }
});

await test("a timed-out approval dispatches nothing and ends blocked (never an indefinite hang)", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot()], onApproval: () => "ignore", defaultTtlMs: 40 });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "action_denied", JSON.stringify(outcome));
    assert(h.events.some((e) => e.type === "approval_request"), "the card was raised and then expired");
    assert(dispatches(h.bridgeCalls).length === 0, "an expired approval must never reach the bridge");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a borrowed tab in scope is authorized by the shared gate before a form action lands", async () => {
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the origin field", text: "Zurich" }, { operation: "DONE" }]
  });
  const h = await harness({ tabScope: [TAB_ID], snapshots: [snapshot(), filledSnapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    assert(dispatches(h.bridgeCalls).length === 1, "the form action must dispatch on the borrowed tab");
    assert(isBorrowedTabMutationAuthorized(h.run, TAB_ID) === true, "the shared gate's automatic action set must have authorized typing on the borrowed tab");
  } finally {
    await server.close();
  }
});

await test("a tab outside the run's scope is refused at the observation, before any page_snapshot bridge call", async () => {
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the search field", text: "Zurich" }]
  });
  const h = await harness({ tabScope: [1, 2], snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "observation_failed", JSON.stringify(outcome));
    assert(outcome.error.code === "OBSERVATION_ERROR", JSON.stringify(outcome.error));
    assert(h.bridgeCalls.length === 0, `an out-of-scope tab must not reach the bridge at all (got ${h.bridgeCalls.length} calls)`);
    assert(server.state.systemone === 0, "no decision may be requested without an observation");
    // The refusal is the shared module's own, recorded on the run — and the
    // failure it becomes names the refusal reason.
    const rejected = h.events.find((e) => e.type === "tool_rejected");
    assert(rejected && rejected.toolName === "page_snapshot" && rejected.reason === "tab_out_of_scope", JSON.stringify(rejected));
    assert(outcome.error.message.includes("tab_out_of_scope"), `the failure must carry the refusal reason: ${outcome.error.message}`);
    assert(jevSteps(h.events).length === 0, "nothing was observed, so no cycle may be recorded");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("a stop that lands before the observation is refused by the shared checks, with nothing dispatched", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }]
  });
  const h = await harness({ snapshots: [snapshot()] });
  // Stop in the instant between the loop's own state check and the
  // observation — the race the shared gate closes. (A run already stopped
  // before the loop starts returns from the entry check without observing.)
  let stopOnNextCoerce = true;
  const coerceArgs = (args) => {
    if (stopOnNextCoerce) {
      stopOnNextCoerce = false;
      h.run.stop("user_stop");
    }
    return h.coerceArgs(args);
  };
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    // A refusal whose cause is the stop is the loop's own honest stop, not a
    // failure to observe.
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(outcome.steps === 0, JSON.stringify(outcome));
    assert(h.bridgeCalls.length === 0, `a stopped run must not even read the page (got ${h.bridgeCalls.length} calls)`);
    assert(server.state.systemone === 0, "a stopped run must not request a decision");
    const rejected = h.events.find((e) => e.type === "tool_rejected");
    assert(rejected && rejected.toolName === "page_snapshot" && rejected.reason === "run_not_active", JSON.stringify(rejected));
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop between steps ends the loop before the next dispatch", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }]
  });
  let stopped = false;
  const h = await harness({
    snapshots: [snapshot(), snapshot()],
    onApproval: () => "approve"
  });
  // Stop as soon as the first step is recorded.
  const originalEmit = h.run.emit.bind(h.run);
  h.run.emit = (event) => {
    originalEmit(event);
    if (event.type === "jev_step" && !stopped) {
      stopped = true;
      h.run.stop("user_stop");
    }
  };
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(outcome.steps === 1, `the executed action is not undone (steps ${outcome.steps})`);
    assert(dispatches(h.bridgeCalls).length === 1, `no dispatch may follow a stop (got ${dispatches(h.bridgeCalls).length})`);
    assert(server.state.decisions === 1, `no decision may be requested after a stop (got ${server.state.decisions})`);
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop while a dispatch is in flight settles that action and stops honestly", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }]
  });
  let release;
  let started;
  const startedSignal = new Promise((resolve) => (started = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const h = await harness({
    snapshots: [snapshot()],
    callTool: async ({ name }) => {
      if (name === "computer") {
        started();
        await gate;
      }
      return undefined;
    }
  });
  try {
    const pending = runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    await startedSignal;
    h.run.stop("user_stop");
    release();
    const outcome = await pending;
    assert(outcome.outcome === "stopped", JSON.stringify(outcome));
    assert(outcome.steps === 1, `the in-flight action was executed and must be counted (steps ${outcome.steps})`);
    const step = jevSteps(h.events)[0];
    assert(step.operation === "WAIT" && step.tool === "computer" && step.skippedReason === undefined, JSON.stringify(step));
    assert(h.run.unknownResults().length === 0, "a settled dispatch is not result-unknown");
    assert(dispatches(h.bridgeCalls).length === 1, "no second dispatch after the stop");
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("the action bound ends the run blocked as step_budget", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }]
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { maxActions: 1 }
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "step_budget", JSON.stringify(outcome));
    assert(outcome.steps === 1, `steps ${outcome.steps}`);
    const end = assertOneEnd(h.events, "blocked");
    assert(end.reason === "step_budget", JSON.stringify(end));
    assert(dispatches(h.bridgeCalls).length === 1, "the bound must prevent the next action, not replay it");
    assert(jevSteps(h.events).length === 2, `the refused cycle is recorded too (got ${jevSteps(h.events).length})`);
    assert(jevSteps(h.events)[1].skippedReason === "step_budget", JSON.stringify(jevSteps(h.events)[1]));
  } finally {
    await server.close();
  }
});

await test("the decision bound ends the run blocked as decision_budget", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }]
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { maxDecisions: 1 }
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "decision_budget", JSON.stringify(outcome));
    assert(server.state.decisions === 1, `at most the bound's decisions may be requested (got ${server.state.decisions})`);
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("three unproductive actions per bounded recovery attempt end blocked as no_progress", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }]
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === 3 * (MAX_RECOVERIES + 1), `each bounded recovery grants one further three-action attempt (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === MAX_RECOVERIES, "all recovery attempts are bounded");
    assert(dispatches(h.bridgeCalls).length === outcome.steps, "every counted wait was actually dispatched");
    assert(jevSteps(h.events).every((s) => s.pageChanged === false), "every recorded step must show no change");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a run of scrolls that keeps offering the same elements ends blocked (the scroll brake)", async () => {
  const pages = [];
  for (let i = 0; i < 8; i++) pages.push(snapshot({ scroll: { y: 400 * i, height: 4000 } }));
  const server = await startModelServer({
    steps: [{ operation: "SCROLL_DOWN" }]
  });
  const h = await harness({ snapshots: pages });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    const recovery = h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery");
    assert(recovery.length <= MAX_RECOVERIES, "the scroll brake allows only bounded recovery");
    const firstRecoveryIndex = h.events.findIndex((e) => e.type === "jev_memory" && e.kind === "recovery");
    assert(h.events.slice(0, firstRecoveryIndex).filter((e) => e.type === "jev_step").length === 6, "the first table brake trips after six scrolls");
    assert(dispatches(h.bridgeCalls).length === outcome.steps, "only dispatched scrolls count");
    assert(jevSteps(h.events).slice(0, 6).every((s) => s.pageChanged === true), "the initial brake watches the unchanged table despite viewport progress");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("scrolls that keep revealing new controls are not stopped by the brake", async () => {
  const pages = [];
  for (let i = 0; i < 7; i++) {
    const page = snapshot({ scroll: { y: 400 * i, height: 4000 } });
    for (let k = 0; k <= i; k++) page.elements.push({ ref: `ref_extra_${k}`, role: "link", label: `Item ${k}`, tag: "a" });
    pages.push(page);
  }
  const server = await startModelServer({
    steps: [{ operation: "SCROLL_DOWN" }, { operation: "SCROLL_DOWN" }, { operation: "SCROLL_DOWN" }, { operation: "SCROLL_DOWN" },
      { operation: "SCROLL_DOWN" }, { operation: "SCROLL_DOWN" }, { operation: "DONE" }]
  });
  const h = await harness({ snapshots: pages });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", `a scroll that reveals a new control is progress — got ${JSON.stringify(outcome)}`);
    assert(outcome.steps === 6, `the six productive scrolls all ran (steps ${outcome.steps})`);
  } finally {
    await server.close();
  }
});

// --- The scroll-only streak (openspec/changes/fix-snapshot-text-and-jev-guards
// design.md §3) -------------------------------------------------------------
//
// A page whose every scroll changes the element table AND alternates direction
// is exactly the live 21-scroll failure: the table-based brake above can never
// fire (the table keeps changing), so the run's own behaviour — consecutive
// executed scroll steps — is what has to be counted.

/** `count` pages that each move the viewport AND change the element table. */
function scrollingPages(count) {
  const pages = [];
  for (let i = 0; i < count; i++) {
    const page = snapshot({ scroll: { y: 200 * i, height: 4000 } });
    page.elements = [...page.elements, { ref: `ref_item_${i}`, role: "link", label: `Item ${i}`, tag: "a" }];
    pages.push(page);
  }
  return pages;
}

await test("eight consecutive scrolls trip the scroll-only guard even when the table changes on every scroll (either direction)", async () => {
  const server = await startModelServer({
    steps: (body, index) => ({ operation: index % 2 === 0 ? "SCROLL_DOWN" : "SCROLL_UP" })
  });
  const h = await harness({ snapshots: scrollingPages(12) });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === SCROLL_ONLY_STREAK_LIMIT + 1, `the streak trips at ${SCROLL_ONLY_STREAK_LIMIT}; only one post-recovery scroll executes (steps ${outcome.steps})`);
    assert(dispatches(h.bridgeCalls).length === SCROLL_ONLY_STREAK_LIMIT + 1, "one additional post-recovery scroll is terminal");
    assert(jevSteps(h.events).every((s) => s.pageChanged === true), "every scroll moved the viewport and changed the table — the streak, not the table, is what stops it");
    // The trip takes the SAME one bounded consultation every stall takes; the
    // stub refuses it, so the run ends with the guard's own honest reason.
    assert(actionPlanCalls(server, "stall").length === 1, "exactly one preparation consultation follows the trip");
    assert(h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery").length === 1, "the successful recovery records its memory");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a non-scroll executed step resets the scroll-only streak", async () => {
  // Seven scrolls, one executed WAIT, seven more: fourteen scroll steps in one
  // run, and the run still reaches DONE — the WAIT reset the streak, so the
  // guard never saw the eight consecutive scrolls it exists for.
  const steps = [
    ...Array.from({ length: 7 }, () => ({ operation: "SCROLL_DOWN" })),
    { operation: "WAIT" },
    ...Array.from({ length: 7 }, () => ({ operation: "SCROLL_UP" })),
    { operation: "DONE" }
  ];
  const server = await startModelServer({ steps });
  const h = await harness({ snapshots: scrollingPages(20) });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    assert(outcome.steps === 15, `seven scrolls, the wait, seven more (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 0, "the reset means the guard never trips");
  } finally {
    await server.close();
  }
});

await test("after a recovery that followed a scroll-stall trip, one further executed scroll ends blocked as no_progress", async () => {
  const server = await startModelServer({
    steps: [{ operation: "SCROLL_DOWN" }],
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? preparedPlan(REVISED_MEMORY) : undefined)
  });
  const h = await harness({ snapshots: scrollingPages(14) });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === SCROLL_ONLY_STREAK_LIMIT + 1, `the recovery resets the streak, and the next scroll is terminal (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 1, "exactly one preparation recovery consultation");
    assert(h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery").length === 1, "the successful recovery is recorded");
    // The recovered plan rides the decision after the recovery — and that
    // decision is a scroll, which is exactly what the rule refuses.
    const decisions = stepDecisions(server);
    assert(decisions.length === SCROLL_ONLY_STREAK_LIMIT + 1, `one decision per executed step (got ${decisions.length})`);
    assert(JSON.stringify(decisions[SCROLL_ONLY_STREAK_LIMIT].memory) === JSON.stringify(REVISED_MEMORY), JSON.stringify(decisions[SCROLL_ONLY_STREAK_LIMIT].memory));
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a non-scroll executed step after a scroll-stall recovery clears the post-recovery rule", async () => {
  const steps = [
    ...Array.from({ length: SCROLL_ONLY_STREAK_LIMIT }, () => ({ operation: "SCROLL_DOWN" })),
    { operation: "WAIT" },
    ...Array.from({ length: 5 }, () => ({ operation: "SCROLL_UP" })),
    { operation: "DONE" }
  ];
  const server = await startModelServer({
    steps,
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? preparedPlan(REVISED_MEMORY) : undefined)
  });
  const h = await harness({ snapshots: scrollingPages(20) });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    assert(outcome.steps === SCROLL_ONLY_STREAK_LIMIT + 6, `the eight scrolls, the wait, and five more scrolls (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 1, "only the one recovery was needed");
  } finally {
    await server.close();
  }
});

await test("a spent recovery bound ends the scroll-only run blocked without consulting", async () => {
  const server = await startModelServer({ steps: [{ operation: "SCROLL_DOWN" }] });
  const h = await harness({ snapshots: scrollingPages(12) });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { maxRecoveries: 0 }
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === SCROLL_ONLY_STREAK_LIMIT, `the trip is the bound's own end (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 0, "a spent bound consults nobody");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("the scroll-only streak bound is overridable through limits, so tests can drive it cheaply", async () => {
  const server = await startModelServer({ steps: [{ operation: "SCROLL_DOWN" }] });
  const h = await harness({ snapshots: scrollingPages(6) });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { scrollOnlyStreak: 3 }
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === 4, `the override trips at three; one post-recovery scroll is terminal (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 1, "the override still takes one bounded preparation consultation");
  } finally {
    await server.close();
  }
});

await test("a recovery granted by the table-based brake keeps the brake's own semantics (no post-recovery scroll rule)", async () => {
  // The post-recovery rule belongs to the scroll-only streak (spec "Bounded
  // run and honest outcomes": the brake's recovery resets the guard it broke
  // and "lets the loop continue"). Here the model answers the brake's recovery
  // with one more scroll and then finishes: the run reaches DONE instead of
  // being blocked at that scroll.
  const pages = [];
  for (let i = 0; i < 8; i++) pages.push(snapshot({ scroll: { y: 400 * i, height: 4000 } }));
  const steps = [
    ...Array.from({ length: 6 }, () => ({ operation: "SCROLL_DOWN" })),
    { operation: "SCROLL_DOWN" },
    { operation: "DONE" }
  ];
  const server = await startModelServer({
    steps,
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? preparedPlan(REVISED_MEMORY) : undefined)
  });
  const h = await harness({ snapshots: pages });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", `the brake's recovery lets the loop continue — got ${JSON.stringify(outcome)}`);
    assert(outcome.steps === 7, `six same-table scrolls, the recovery, and one more scroll (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 1, "exactly one preparation recovery consultation");
  } finally {
    await server.close();
  }
});

await test("an identical re-click of an element whose click changed nothing is recorded as skipped, not dispatched again", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the first offered element" }],
    select: () => "1"
  });
  const h = await harness({ snapshots: [snapshot(), snapshot(), snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(dispatches(h.bridgeCalls).length === 1, "replanning cannot authorize a proven unchanged click again");
    const steps = jevSteps(h.events);
    assert(steps.length === 2 + 2 * MAX_RECOVERIES, `one click and bounded refused repeats (got ${steps.length})`);
    assert(steps.filter((step) => step.skippedReason === "repeated_no_change").length === 1 + 2 * MAX_RECOVERIES, "every unchanged repeat is refused across recovery");
    assert(steps[1].skippedReason === "repeated_no_change", JSON.stringify(steps[1]));
    assert(steps[1].tool === null && steps[1].argsSummary === null, "the repeat step records no dispatch it never made");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a NAVIGATE decision takes the small model's validated URL through the registered navigate operation", async () => {
  const url = "https://www.youtube.com/results?search_query=th%E1%BA%BF+gi%E1%BB%9Bi+c%E1%BB%A7a+anh";
  const server = await startModelServer({
    steps: [{ operation: "NAVIGATE", url }, { operation: "DONE" }]
  });
  const h = await harness({ snapshots: [snapshot(), snapshot()] });
  // Production (`companion._launchRun`) authorizes the bound tab for the run
  // before it starts; the navigate operation is mutating and not part of the
  // dispatch-time automatic action set, so the test mirrors that pre-grant.
  authorizeBorrowedTabMutation(h.run, TAB_ID);
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const navigations = dispatches(h.bridgeCalls).filter((d) => d.name === "navigate");
    assert(navigations.length === 1, `exactly one navigate dispatch (${JSON.stringify(dispatches(h.bridgeCalls))})`);
    assert(navigations[0].args.url === url, JSON.stringify(navigations[0].args));
    assert(navigations[0].args.tabId === TAB_ID, "the navigation targets the run's bound tab");
    const step = jevSteps(h.events)[0];
    assert(step.operation === "NAVIGATE" && step.tool === "navigate" && step.skippedReason == null, JSON.stringify(step));
  } finally {
    await server.close();
  }
});

await test("the run plan's memory rides in every decision request and is recorded as the first jev_memory", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot(), snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    // The plan rides EVERY request the configured model answers and the one
    // element-selection request TypeSafe answers (design.md §1).
    const decisions = stepDecisions(server);
    assert(decisions.length === 2, `one step decision per cycle expected (${decisions.length})`);
    assert(
      decisions.every((d) => JSON.stringify(d.memory) === JSON.stringify(RUN_MEMORY)),
      JSON.stringify(decisions.map((d) => d.memory))
    );
    const selections = server.state.bodies.filter((b, i) => server.state.paths[i] === "/v1/systemone");
    assert(selections.length === 2 && selections.every((body) => JSON.stringify(body.state.memory) === JSON.stringify(RUN_MEMORY)), "both action and DONE decisions see the plan");
    const checks = chatCalls(server, COMPLETION_CHECK);
    assert(checks.length === 1 && JSON.stringify(JSON.parse(checks[0].messages[1].content).memory) === JSON.stringify(RUN_MEMORY), "the completion check rides the memory too");
    const plans = h.events.filter((e) => e.type === "jev_memory");
    assert(plans.length === 1, `exactly the plan is recorded, got ${plans.length}`);
    assert(plans[0].index === 1 && plans[0].kind === "plan" && plans[0].trigger === "start", JSON.stringify(plans[0]));
    assert(JSON.stringify(plans[0].memory) === JSON.stringify(RUN_MEMORY), JSON.stringify(plans[0].memory));
    assert(typeof plans[0].latencyMs === "number", "the memory record carries its call's latency");
  } finally {
    await server.close();
  }
});

await test("failed required preparation records no memory and dispatches nothing", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }],
    select: () => "2",
    text: (body) => (instructionOf(body) === ACTION_PLAN ? { status: 400, payload: { error: "bad request" } } : undefined)
  });
  const h = await harness({ snapshots: [snapshot(), snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    // No memory exists, so neither the step decisions nor the selection
    // requests may carry one (the key is absent, never null).
    assert(stepDecisions(server).length === 0, "no Jev decision is asked without required preparation");
    const selections = server.state.bodies.filter((b, i) => server.state.paths[i] === "/v1/systemone");
    assert(selections.length === 0 && dispatches(h.bridgeCalls).length === 0, "preparation failure stops before decisions or dispatch");
    assert(h.events.filter((e) => e.type === "jev_memory").length === 0, "a failed plan records no memory event");
  } finally {
    await server.close();
  }
});

await test("a DONE decision ends only through one confirming completion check, carrying its report and a verified terminal record", async () => {
  const report = "Đã lọc TBMT tại Hải Phòng: 10 kết quả hiển thị. Bước tiếp theo: mở TBMT đầu tiên.";
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => (instructionOf(body) === COMPLETION_CHECK ? completion(JSON.stringify({ achieved: true, report })) : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true && outcome.summaryError === undefined, JSON.stringify(outcome));
    const reports = h.events.filter((e) => e.type === "jev_result");
    assert(reports.length === 1 && reports[0].text === report, `exactly one report, produced by the check (${JSON.stringify(reports)})`);
    const checks = chatCalls(server, COMPLETION_CHECK);
    assert(checks.length === 1, `exactly one completion check must be made (got ${checks.length})`);
    // The check saw the goal, the memory, the page, and the actions.
    const user = JSON.parse(checks[0].messages[1].content);
    assert(user.goal === "Find a flight to Zurich" && JSON.stringify(user.memory) === JSON.stringify(RUN_MEMORY), JSON.stringify(user.memory));
    assert(user.page.url === "https://example.com/search" && user.page.text === "Find flights", JSON.stringify(user.page));
    assert(Array.isArray(user.recent_actions), "the check carries the recent actions");
    const step = jevSteps(h.events)[0];
    assert(step.operation === "DONE" && step.skippedReason === "done" && JSON.stringify(step.verification) === JSON.stringify({ achieved: true }), JSON.stringify(step));
    const end = assertOneEnd(h.events, "done");
    assert(end.doneIsDecided === true && end.doneVerified === true && end.summaryError === undefined, JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a confirmation without a usable report is still verified, and the missing report is disclosed on jev_end", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => (instructionOf(body) === COMPLETION_CHECK ? completion(JSON.stringify({ achieved: true })) : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, `the verdict stands (${JSON.stringify(outcome)})`);
    // The check confirmed but wrote no report, so the run falls back to the
    // final report: an answer exists, and the missing CHECK report is still
    // disclosed on the terminal record.
    const answers = h.events.filter((e) => e.type === "jev_result");
    assert(answers.length === 1 && answers[0].text === FINAL_REPORT_TEXT, `the final report answers instead: ${JSON.stringify(answers)}`);
    const end = assertOneEnd(h.events, "done");
    assert(typeof end.summaryError === "string" && /no report/.test(end.summaryError), `the missing report is recorded, not hidden (${JSON.stringify(end)})`);
    assert(jevSteps(h.events)[0].verification.achieved === true, JSON.stringify(jevSteps(h.events)[0]));
  } finally {
    await server.close();
  }
});

await test("an unavailable completion check ends blocked and discloses the failure", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => (instructionOf(body) === COMPLETION_CHECK ? { status: 500, payload: { error: "model down" } } : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "completion_unverified" && outcome.doneVerified !== true, JSON.stringify(outcome));
    // An answer is produced — by the final report, from the run's own
    // material — but it is never the check's report, because the check never
    // made one.
    const answers = h.events.filter((e) => e.type === "jev_result");
    assert(answers.length === 1 && answers[0].text === FINAL_REPORT_TEXT, `no check report may be presented: ${JSON.stringify(answers)}`);
    const step = jevSteps(h.events)[0];
    assert(step.skippedReason === "completion_unverified" && step.verification.achieved === null && typeof step.verification.error === "string", JSON.stringify(step));
    const end = assertOneEnd(h.events, "blocked");
    assert(end.doneIsDecided === false && end.doneVerified !== true && typeof end.summaryError === "string", JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a rejected DONE claim is recorded as skipped with its guidance memory, and the loop continues", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => {
      if (instructionOf(body) !== COMPLETION_CHECK) return undefined;
      const checks = chatCalls(server, COMPLETION_CHECK).length;
      return checks === 1 ? completion(JSON.stringify({ achieved: false, memory: REVISED_MEMORY })) : completion(JSON.stringify({ achieved: true, report: "Đã xong." }));
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    const steps = jevSteps(h.events);
    assert(steps.length === 2, `two DONE cycles: the rejected claim and the confirmed one (${steps.length})`);
    assert(steps[0].skippedReason === "completion_rejected" && JSON.stringify(steps[0].verification) === JSON.stringify({ achieved: false }), JSON.stringify(steps[0]));
    assert(steps[1].skippedReason === "done" && steps[1].verification.achieved === true, JSON.stringify(steps[1]));
    const memories = h.events.filter((e) => e.type === "jev_memory");
    assert(memories.length === 2 && memories[1].index === 2 && memories[1].kind === "update" && memories[1].trigger === "verification", JSON.stringify(memories));
    assert(JSON.stringify(memories[1].memory) === JSON.stringify(REVISED_MEMORY), JSON.stringify(memories[1].memory));
    // The guidance rides the next decision request.
    const decisions = stepDecisions(server);
    assert(JSON.stringify(decisions[1].memory) === JSON.stringify(REVISED_MEMORY), JSON.stringify(decisions[1].memory));
  } finally {
    await server.close();
  }
});

await test("repeated rejections end blocked as completion_unverified, never claiming the disputed completion", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => (instructionOf(body) === COMPLETION_CHECK ? completion(JSON.stringify({ achieved: false })) : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "completion_unverified", JSON.stringify(outcome));
    const steps = jevSteps(h.events);
    assert(steps.length === 3 && steps.every((s) => s.skippedReason === "completion_rejected"), `every claim is recorded as a rejection (${JSON.stringify(steps.map((s) => s.skippedReason))})`);
    // The disputed claims produce no completion report; the run still answers
    // the operator from its own material, and the outcome stays blocked.
    const answers = h.events.filter((e) => e.type === "jev_result");
    assert(answers.length === 1 && answers[0].text === FINAL_REPORT_TEXT, `a disputed completion never produces a completion report: ${JSON.stringify(answers)}`);
    const checks = chatCalls(server, COMPLETION_CHECK);
    assert(checks.length === 3, `the check is made once per claim, bounded by ${MAX_VERIFICATION_REJECTIONS} (got ${checks.length})`);
    const end = assertOneEnd(h.events, "blocked");
    assert(end.reason === "completion_unverified" && end.doneIsDecided === false && !("doneVerified" in end), JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("the memory is revised when the action changes the page identity, and the revised memory rides the next decision", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }],
    select: () => "2",
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "navigated" ? preparedPlan(REVISED_MEMORY) : undefined)
  });
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const memories = h.events.filter((e) => e.type === "jev_memory");
    assert(memories.length === 2, `the plan and the navigation revision (got ${memories.length})`);
    assert(memories[1].index === 2 && memories[1].kind === "update" && memories[1].trigger === "navigated", JSON.stringify(memories[1]));
    const decisions = stepDecisions(server);
    assert(JSON.stringify(decisions[0].memory) === JSON.stringify(RUN_MEMORY), "the first decision rides the plan");
    assert(JSON.stringify(decisions[1].memory) === JSON.stringify(REVISED_MEMORY), "the next decision rides the revision");
  } finally {
    await server.close();
  }
});

await test("the memory is revised at the action cadence, bounded by the update cap", async () => {
  let revisionCalls = 0;
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "CLICK", intent: "the Search button" },
      { operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }],
    select: () => "2",
    text: (body) => {
      if (instructionOf(body) !== ACTION_PLAN || contextOf(body).reason !== "cadence") return undefined;
      revisionCalls += 1;
      return preparedPlan(REVISED_MEMORY);
    }
  });
  // Each click changes the element's own value, so the page changes without a
  // navigation: the cadence trigger (overridden to 1) is the only one in play.
  const pages = [snapshot(), filledSnapshot(), snapshot({ text: "Find flights now" }), snapshot({ text: "Find flights again" })];
  const h = await harness({ snapshots: pages });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { memoryUpdateEveryActions: 1, maxMemoryUpdates: 2 }
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "replan_limit", JSON.stringify(outcome));
    assert(revisionCalls === 2, `the cap must stop the third revision (calls ${revisionCalls})`);
    const memories = h.events.filter((e) => e.type === "jev_memory");
    assert(memories.length === 3, `the plan + two capped revisions (got ${memories.length})`);
    assert(memories.slice(1).every((m) => m.kind === "update" && m.trigger === "cadence" && m.index >= 2), JSON.stringify(memories));
    const decisions = stepDecisions(server);
    assert(JSON.stringify(decisions.at(-1).memory) === JSON.stringify(REVISED_MEMORY), "the last decision rides the last recorded revision");
  } finally {
    await server.close();
  }
});

await test("a failed required revision stops before another action and records no replacement memory", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }],
    select: () => "2",
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "cadence" ? completion("not json at all") : undefined)
  });
  const h = await harness({ snapshots: [snapshot(), filledSnapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { memoryUpdateEveryActions: 1 }
    });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    const memories = h.events.filter((e) => e.type === "jev_memory");
    assert(memories.length === 1 && memories[0].kind === "plan", `only the plan is recorded (${JSON.stringify(memories)})`);
    const decisions = stepDecisions(server);
    assert(decisions.length === 1 && JSON.stringify(decisions[0].memory) === JSON.stringify(RUN_MEMORY), "no decision follows a failed required revision");
    assert(dispatches(h.bridgeCalls).length === 1, "no action follows failed required preparation");
  } finally {
    await server.close();
  }
});

await test("a stop during a revision discards it: the previous memory stands and the run stops", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    select: () => "2",
    text: (body) => {
      if (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "cadence") h.run.stop("user_stop");
      return undefined;
    }
  });
  const h = await harness({ snapshots: [snapshot(), filledSnapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { memoryUpdateEveryActions: 1 }
    });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(h.events.filter((e) => e.type === "jev_memory").length === 1, "a revision that landed after a stop is discarded, never recorded");
    assert(server.state.systemone === 1, `no decision may follow the stop (got ${server.state.systemone})`);
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stall guard consults once, and a continue with guidance resets it and the run goes on", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }, { operation: "WAIT" }, { operation: "WAIT" }, { operation: "DONE" }],
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? preparedPlan(REVISED_MEMORY) : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, `a recovered run finishes normally (${JSON.stringify(outcome)})`);
    assert(outcome.steps === 3, `the three stalled actions still executed (steps ${outcome.steps})`);
    const memories = h.events.filter((e) => e.type === "jev_memory");
    assert(memories.length === 2, `the plan and the recovery (got ${memories.length})`);
    assert(memories[1].index === 2 && memories[1].kind === "recovery" && memories[1].trigger === "stall", JSON.stringify(memories[1]));
    assert(JSON.stringify(memories[1].memory) === JSON.stringify(REVISED_MEMORY), JSON.stringify(memories[1].memory));
    // A consultation dispatches nothing: the only browser actions are the
    // three executed waits.
    const dispatched = dispatches(h.bridgeCalls);
    assert(dispatched.length === 3 && dispatched.every((d) => d.name === "computer" && d.args.action === "wait"), JSON.stringify(dispatched.map((d) => d.name)));
    // The guidance rides the decision after the recovery.
    const decisions = stepDecisions(server);
    assert(JSON.stringify(decisions[3].memory) === JSON.stringify(REVISED_MEMORY), JSON.stringify(decisions[3].memory));
    assertOneEnd(h.events, "done");
  } finally {
    await server.close();
  }
});

await test("a recovery preparation refusal stops with its named failure and records no memory", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }],
    text: (body) => instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? completion("I cannot prepare a valid plan") : undefined
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(outcome.steps === 3, `three unproductive actions before the guard (steps ${outcome.steps})`);
    const consults = actionPlanCalls(server, "stall");
    assert(consults.length === 2, `one preparation consultation with its bounded malformed-response retry (got ${consults.length})`);
    assert(h.events.filter((e) => e.type === "jev_memory").length === 1, "a refused consultation records no recovery memory (only the plan stands)");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("a recovery call transport failure ends with preparation_failed", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }],
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? { status: 500, payload: { error: "recovery unavailable" } } : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(dispatches(h.bridgeCalls).length === 3, "a failed consultation dispatches nothing");
    assert(h.events.filter((e) => e.type === "jev_memory").length === 1, "a failed consultation records no recovery memory");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("the recovery bound stops further consultations: a second stall ends blocked with the same reason", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }],
    text: (body) => (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall" ? preparedPlan(REVISED_MEMORY) : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { maxRecoveries: 1 }
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === 6, `three actions, one reset, three more (steps ${outcome.steps})`);
    const consults = actionPlanCalls(server, "stall");
    assert(consults.length === 1, `the bound allows exactly one consultation (got ${consults.length})`);
    assert(h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery").length === 1, "only the successful recovery is recorded");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a stop during the plan discards the memory and stops the run", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => {
      if (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "start") h.run.stop("user_stop");
      return undefined;
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(h.events.filter((e) => e.type === "jev_memory").length === 0, "a plan that landed after a stop is discarded, never recorded");
    assert(server.state.systemone === 0, "a stopped run makes no decision");
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop during the completion check discards the verdict and stops the run", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) => {
      if (instructionOf(body) === COMPLETION_CHECK) h.run.stop("user_stop");
      return undefined;
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    // The verdict is discarded; the stopped run still tells the operator what
    // it did, and never presents the discarded verdict as a completion.
    const answers = h.events.filter((e) => e.type === "jev_result");
    assert(answers.length === 1 && answers[0].text === FINAL_REPORT_TEXT, `a discarded verdict is never the answer: ${JSON.stringify(answers)}`);
    const step = jevSteps(h.events)[0];
    assert(step.skippedReason === "stopped" && step.verification === undefined, JSON.stringify(step));
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while the DONE decision is in flight issues no completion check", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    // The stop lands inside the step-decision request, before its answer is
    // handled: the check must not be issued for a run that is already stopped.
    steps: () => {
      h.run.stop("user_stop");
      return { operation: "DONE" };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(outcome.steps === 0, `a stopped run executes nothing (steps ${outcome.steps})`);
    assert(chatCalls(server, COMPLETION_CHECK).length === 0, `no completion check may be issued after a stop (got ${chatCalls(server, COMPLETION_CHECK).length})`);
    // No completion check was made, so no completion report exists; the run
    // still answers with what it did before the stop.
    const answers = h.events.filter((e) => e.type === "jev_result");
    assert(answers.length === 1 && answers[0].text === FINAL_REPORT_TEXT, `the stopped run still answers: ${JSON.stringify(answers)}`);
    const step = jevSteps(h.events)[0];
    assert(step && step.skippedReason === "stopped" && step.verification === undefined, JSON.stringify(step));
    assert(step.operation === "DONE" && step.target === null && step.tool === null, "the refused record names the operation and nothing it never did");
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while a BLOCKED step is in flight ends stopped, never model_blocked", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    steps: () => {
      h.run.stop("user_stop");
      return { operation: "BLOCKED" };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the model's own block (${JSON.stringify(outcome)})`);
    const end = assertOneEnd(h.events, "stopped");
    assert(end.reason === "stopped" && !("doneVerified" in end), JSON.stringify(end));
    const step = jevSteps(h.events)[0];
    assert(step.skippedReason === "stopped" && step.operation === "ASK", JSON.stringify(step));
  } finally {
    await server.close();
  }
});

await test("a stop during a stall recovery stops the run instead of ending it blocked", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }],
    text: (body) => {
      if (instructionOf(body) !== ACTION_PLAN || contextOf(body).reason !== "stall") return undefined;
      h.run.stop("user_stop");
      return preparedPlan(REVISED_MEMORY);
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery").length === 0, "the recovery is discarded, never recorded");
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while a failing stall recovery is in flight stops the run instead of ending it blocked", async () => {
  // Three unchanged WAIT actions trip the fixed NO_PROGRESS_LIMIT, so the
  // guard's one bounded consultation is the window the stop lands in — and the
  // consultation itself FAILS. A run the operator already stopped reports its
  // own outcome: the failure may not surface as blocked/<guard reason>, and no
  // stop may be credited to the guard (round-4 review finding).
  const readOnly = snapshot({ elements: [{ ref: "ref_1", role: "button", label: "Search", tag: "button" }] });
  const h = await harness({ snapshots: [readOnly] });
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }],
    text: (body) => {
      if (instructionOf(body) === ACTION_PLAN && contextOf(body).reason === "stall") {
        h.run.stop("user_stop");
        return { status: 500, payload: { error: "model down" } };
      }
      return undefined;
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the guard's own reason (${JSON.stringify(outcome)})`);
    assert(outcome.steps === 3 && !("error" in outcome), JSON.stringify(outcome));
    assert(server.state.systemone === 3, "the three waits each require a Jev decision");
    assert(dispatches(h.bridgeCalls).length === 3, "only the pre-stop waits dispatch");
    const steps = jevSteps(h.events);
    assert(steps.length === 3 && steps.every((s) => s.operation === "WAIT" && s.pageChanged === false), JSON.stringify(steps));
    assert(actionPlanCalls(server, "stall").length === 1, "the guard still got its one bounded preparation consultation");
    assert(h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery").length === 0, "a failed recovery is never recorded either");
    const end = assertOneEnd(h.events, "stopped");
    assert(end.reason === "stopped" && end.steps === 3 && end.doneIsDecided === false, JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a stop landing while a guard-triggering decision is in flight issues no stall consultation", async () => {
  const h = await harness({ snapshots: [snapshot(), snapshot()] });
  const server = await startModelServer({
    // Step #0 clicks the search button and the page does not change, which arms
    // the repeated-click guard; the stop lands while step #1 — the same click
    // again — is in flight, so the guard trip must end the run stopped without
    // consulting the model.
    steps: (body, i) => {
      if (i === 1) h.run.stop("user_stop");
      return { operation: "CLICK", intent: "the Search button" };
    },
    select: () => "2"
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", JSON.stringify(outcome));
    assert(outcome.steps === 1, `only the first click executed (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === 0, "no recovery preparation may be issued after a stop");
    assert(h.events.filter((e) => e.type === "jev_memory" && e.kind === "recovery").length === 0, "no recovery is recorded for a stopped run");
    const steps = jevSteps(h.events);
    assert(steps.length === 2, `one step per cycle (got ${steps.length})`);
    assert(steps[1].skippedReason === "stopped", `the post-decision stop check outranks the guard (${JSON.stringify(steps[1])})`);
    assert(dispatches(h.bridgeCalls).length === 1, `no dispatch may follow a stop (got ${dispatches(h.bridgeCalls).length})`);
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while a stalled observation returns prefers stopped over the spent recovery bound", async () => {
  // The stopped run's guard would have ended it blocked/no_progress with the
  // recovery bound already spent; a stop outranks the bound (round-2 finding),
  // so the terminal outcome is `stopped` and no consultation is issued for a
  // run that is no longer running.
  let snapshots = 0;
  const h = await harness({
    snapshots: [snapshot()],
    callTool: async ({ name, bridgeCalls }) => {
      if (name === "page_snapshot") {
        snapshots += 1;
        // The 4th observation is the third cycle's — stop while it is in
        // flight, exactly the window the guard ordering exists for.
        if (bridgeCalls.filter((call) => call.name === "computer" && call.args.action === "wait").length === 3) h.run.stop("user_stop");
      }
      return undefined;
    }
  });
  const server = await startModelServer({ steps: [{ operation: "WAIT" }] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      limits: { maxRecoveries: 0 }
    });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the spent bound (${JSON.stringify(outcome)})`);
    assert(actionPlanCalls(server, "stall").length === 0, "a stopped run consults nobody");
    assert(outcome.steps === 3, "stop lands on the third wait's post-action observation");
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("the repeated-no-change guard consults once when no stop lands (the stop-window control)", async () => {
  // The same scenario as above without the stop: the guard trip DOES consult
  // (and, refused, ends blocked with its own reason) — so the zero above is
  // the stop suppressing the call, not a guard that never fires.
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot(), snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "no_progress", JSON.stringify(outcome));
    assert(outcome.steps === 1, `unchanged repeats remain refused after plan revision (steps ${outcome.steps})`);
    assert(actionPlanCalls(server, "stall").length === MAX_RECOVERIES, "only the bounded recovery preparations are made");
    assert(dispatches(h.bridgeCalls).length === 1, "consultations themselves dispatch nothing or erase no-effect evidence");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("a lost dispatch response is recorded as result-unknown, never retried", async () => {
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the search field", text: "Zurich" }]
  });
  let formCalls = 0;
  const h = await harness({
    snapshots: [snapshot()],
    callTool: async ({ name }) => {
      if (name === "form_input") {
        formCalls += 1;
        return { content: [{ type: "text", text: `Error: ${HOST_DROPPED_ERROR}` }] };
      }
      return undefined;
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "tool_result_unknown", JSON.stringify(outcome));
    assert(outcome.error.code === "RESULT_UNKNOWN", JSON.stringify(outcome.error));
    assert(formCalls === 1, `a lost response must never be retried (form_input called ${formCalls} times)`);
    assert(h.run.unknownResults().length === 1, "the run must record the unknown result");
    assert(h.events.some((e) => e.type === "tool_result_unknown"), "the durable tool_result_unknown event must exist");
    assert(jevSteps(h.events)[0].skippedReason === "result_unknown", JSON.stringify(jevSteps(h.events)[0]));
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("blank startup: URL-less goals reach a model navigation, then a real page, on the same bound tab", async () => {
  const goal = "tra tôi chuyến bay rẻ nhất Hải Phòng đi HCM";
  const destination = "https://example.com/flights";
  for (const [url, legacy] of [["chrome://newtab/", false], ["chrome://newtab/", true], ["about:blank", false], ["edge://newtab/", false], ["brave://newtab/", false], ["chrome://new-tab-page/", false]]) {
    const server = await startModelServer({ steps: [{ operation: "NAVIGATE", url: destination }, { operation: "DONE" }] });
    const h = await startupHarness({ initial: unavailablePage(url, { legacy }), snapshots: [snapshot({ url: destination })], callTool: captureStub });
    authorizeBorrowedTabMutation(h.run, TAB_ID);
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server, { goal, sendScreenshots: true }) });
      assert(outcome.outcome === "done" && outcome.steps === 1 && outcome.hasResult, JSON.stringify(outcome));
      assert(h.bridgeCalls.slice(0, 3).map((c) => c.name).join(",") === "page_snapshot,navigate,page_snapshot", "nothing captures, selects or reads DOM before navigation");
      assert(h.bridgeCalls.every((c) => c.args.tabId === TAB_ID && c.meta.runId === h.run.runId), "every call stays in the bound run and tab");
      const requests = chatCalls(server, ACTION_PLAN);
      const first = contextOf(requests[0]);
      assert(first.goal === goal && first.page === null && first.page_availability.status === "blank_start" && first.page_availability.url === url, JSON.stringify(first));
      assert(first.elements.length === 0 && imageUrlOf(requests[0]) === null && first.memory === null, "there is no invented observation, image or plan");
      assert(server.state.systemone === 2 && requests.length === 1, "one preparation supports navigation and the subsequent Jev DONE decision");
      assert(contextOf(chatCalls(server, COMPLETION_CHECK)[0]).page.url === destination, "completion verification is based on the arrived real page");
      assert(chatCalls(server, NEXT_STEP).length === 0, "bootstrap never falls back to per-step LLM decisions");
      const nav = jevSteps(h.events)[0];
      assert(nav.operation === "NAVIGATE" && nav.observed === null && nav.pageAvailability.status === "blank_start" && nav.pageChanged === true, JSON.stringify(nav));
      const conversationEvents = [{ type: "run_created" }, ...jevSteps(h.events), { type: "run_done" }]
        .map((event, index) => ({ ...event, runId: "run_blank_start", seq: index + 1 }));
      const derived = deriveRunDraft({ conversationEvents, runId: "run_blank_start" });
      assert(derived.ok && derived.draft.steps.length === 1 && derived.draft.steps[0].args.url === destination, "the genuine leading navigation materializes without a fabricated initial URL");
    } finally { await server.close(); }
  }
});

await test("blank startup: ASK surfaces operator-needed without inventing a page", async () => {
  const server = await startModelServer({ steps: [{ operation: "ASK" }] });
  const h = await startupHarness();
  try {
    const outcome = await runTypesafeRun({ ...h, provider: providerFor(server, { sendScreenshots: true }) });
    assert(outcome.outcome === "blocked" && outcome.reason === "needs_operator" && outcome.steps === 0 && outcome.hasResult, JSON.stringify(outcome));
    assert(jevResults(h.events).length === 1 && typeof jevResults(h.events)[0].text === "string" && jevResults(h.events)[0].text.length > 0, "one honest operator-needed explanation");
    assert(h.bridgeCalls.length === 1 && server.state.systemone === 1 && server.state.chat === 1, "only initial metadata, preparation and one Jev ASK decision");
    assert(jevSteps(h.events)[0].operation === "ASK" && jevSteps(h.events)[0].skippedReason === "needs_operator", "ASK reaches the existing operator-needed outcome");
    assertOneEnd(h.events, "blocked");
  } finally { await server.close(); }
});

await test("restricted and closed tabs produce a limitation answer without any bootstrap, DOM, capture or model call", async () => {
  const cases = [
    unavailablePage("chrome://settings/"), unavailablePage("chrome://settings/", { legacy: true }),
    unavailablePage("chrome://newtab/elsewhere"), unavailablePage("chrome://newtab/?q=x"),
    unavailablePage("chrome-extension://abc/index.html"), unavailablePage("https://chromewebstore.google.com/"),
    unavailablePage(null, { reason: "stale_context" }),
    { content: [{ type: "text", text: `Stale context: tab ${TAB_ID} is no longer open. The page bound to this run is gone — do not retry against a different or newly active tab; report this to the user and ask them to reopen the page or bind a new one.` }] }
  ];
  for (const initial of cases) {
    const server = await startModelServer({ steps: [{ operation: "NAVIGATE", url: "https://example.com/" }] });
    const h = await startupHarness({ initial });
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server, { sendScreenshots: true }) });
      assert(outcome.outcome === "blocked" && outcome.reason === "needs_operator" && outcome.hasResult && outcome.steps === 0, JSON.stringify(outcome));
      assert(server.state.chat === 0 && server.state.systemone === 0 && h.bridgeCalls.length === 1, "a restricted tab cannot trigger navigation or model calls");
      assert(jevSteps(h.events).length === 0 && jevResults(h.events).length === 1, "only the known limitation is answered; no observation/action is fabricated");
    } finally { await server.close(); }
  }
});

await test("blank startup only accepts the exact bound-tab refusal contract, never arbitrary error text", async () => {
  const cases = [
    unavailablePage("chrome://newtab/", { tabId: TAB_ID + 1 }),
    unavailablePage("chrome://newtab/", { tabId: TAB_ID + 1, legacy: true }),
    { content: [{ type: "text", text: 'Restricted page: tab 7 (chrome://newtab/) ...' }] },
    { content: [{ type: "text", text: JSON.stringify({ v: 2, available: false, reason: "restricted_page", tabId: TAB_ID, url: "chrome://newtab/" }) }] },
    { isError: true, content: [{ type: "text", text: JSON.stringify(snapshot()) }] }
  ];
  for (const initial of cases) {
    const server = await startModelServer({});
    const h = await startupHarness({ initial });
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server) });
      assert(outcome.outcome === "error" && outcome.reason === "observation_failed" && outcome.steps === 0, JSON.stringify(outcome));
      assert(server.state.chat === 0 && h.bridgeCalls.length === 1, "no unrelated tab or unrecognized response grants bootstrap capability");
    } finally { await server.close(); }
  }
});

await test("blank startup rejects premature completion, DOM actions and invalid decisions with an honest answer", async () => {
  const decisions = [{ operation: "DONE" }, { operation: "CLICK", intent: "a guessed button" }, { operation: "WAIT" }, { operation: "BLOCKED" }, { operation: "NAVIGATE" }, { operation: "NAVIGATE", url: "javascript:alert(1)" }, { status: 503, payload: { error: "unavailable" } }];
  for (const decision of decisions) {
    const server = await startModelServer({ steps: [decision] });
    const h = await startupHarness();
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server, { sendScreenshots: true }), sleep: async () => {} });
      assert(outcome.outcome !== "done" && outcome.steps === 0 && outcome.hasResult, JSON.stringify(outcome));
      assert(h.bridgeCalls.length === 1, `no unsupported startup action executes (${decision.operation})`);
      assert(chatCalls(server, COMPLETION_CHECK).length === 0 && chatCalls(server, FINAL_REPORT).length === 0, "no invented page supports verification or synthesis");
      assert(chatCalls(server, ACTION_PLAN).every((body) => contextOf(body).page === null), "preparation never invents an unread page");
      assert(jevResults(h.events).length === 1, "one bounded failure explanation");
    } finally { await server.close(); }
  }
});

await test("blank startup navigation uses the ordinary gate and counts against action and decision budgets", async () => {
  for (const mode of ["denied", "scope", "actions", "decisions", "spent_after_navigation"]) {
    let h;
    const server = await startModelServer({ text: (body) => instructionOf(body) === ACTION_PLAN ? { ...preparedPlan(RUN_MEMORY), navigation: [{ url: "https://example.com/", purpose: "Open the requested site" }] } : undefined, steps: () => {
      if (mode === "scope") h.run.tabScope = [999];
      return { operation: "NAVIGATE", url: "https://example.com/" };
    } });
    h = await startupHarness();
    authorizeBorrowedTabMutation(h.run, TAB_ID);
    const limits = mode === "actions" ? { maxActions: 0 } : mode === "decisions" ? { maxDecisions: 0 } : mode === "spent_after_navigation" ? { maxDecisions: 1 } : {};
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server), limits, ...(mode === "denied" ? { canUseTool: async () => ({ behavior: "deny" }) } : {}) });
      const navigated = mode === "spent_after_navigation";
      assert(outcome.outcome === "blocked" && outcome.steps === (navigated ? 1 : 0) && outcome.hasResult, JSON.stringify(outcome));
      assert(h.bridgeCalls.filter((c) => c.name === "navigate").length === (navigated ? 1 : 0), "budgets/scope/approval share the normal navigation path");
      assert(server.state.decisions === (mode === "decisions" ? 0 : 1), "bootstrap is charged as the run's first decision");
    } finally { await server.close(); }
  }
});

await test("blank startup navigation errors and uncertain results stop once without counting unconfirmed success", async () => {
  for (const mode of ["flag", "legacy_error", "invalid_url", "scope_error", "lost", "throw"]) {
    const server = await startModelServer({ steps: [{ operation: "NAVIGATE", url: "https://example.com/" }] });
    const h = await startupHarness({ callTool: async ({ name }) => {
      if (name !== "navigate") return undefined;
      if (mode === "throw") throw new Error("transport failed after sending");
      const text = mode === "lost" ? `Error: ${HOST_DROPPED_ERROR}` : mode === "invalid_url" ? 'Invalid URL: "x". Could not parse as a valid URL.' : mode === "scope_error" ? `Tab ${TAB_ID} is not in the MCP group.` : mode === "legacy_error" ? "Error: browser rejected navigation" : "navigation unavailable";
      return { content: [{ type: "text", text }], ...(mode === "flag" ? { isError: true } : {}) };
    } });
    authorizeBorrowedTabMutation(h.run, TAB_ID);
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server) });
      const unknown = mode === "lost" || mode === "throw";
      assert(outcome.outcome === "error" && outcome.reason === (unknown ? "tool_result_unknown" : "navigation_failed") && outcome.steps === 0 && outcome.hasResult, JSON.stringify(outcome));
      assert(h.bridgeCalls.length === 2 && server.state.decisions === 1, "one dispatch, no retry or post-failure snapshot");
      assert(h.run.unknownResults().length === (unknown ? 1 : 0), "uncertainty is recorded without claiming no side effect");
      assertOneEnd(h.events, "error");
    } finally { await server.close(); }
  }
});

await test("blank startup never bootstraps again when the post-navigation page remains unreadable", async () => {
  for (const refusal of [unavailablePage(), unavailablePage("chrome://newtab/", { legacy: true }), unavailablePage("chrome://settings/"), unavailablePage(null, { reason: "stale_context" }), { content: [{ type: "text", text: "Error: snapshot unavailable" }] }]) {
    const server = await startModelServer({ steps: [{ operation: "NAVIGATE", url: "https://example.com/" }] });
    const h = await startupHarness({ callTool: async ({ name }) => name === "page_snapshot" ? refusal : undefined });
    authorizeBorrowedTabMutation(h.run, TAB_ID);
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server, { sendScreenshots: true }) });
      assert(outcome.outcome !== "done" && outcome.steps === 1 && outcome.hasResult, JSON.stringify(outcome));
      assert(h.bridgeCalls.map((c) => c.name).join(",") === "page_snapshot,navigate,page_snapshot", "exactly one re-observation and no capture");
      assert(server.state.decisions === 1 && server.state.systemone === 1 && chatCalls(server, ACTION_PLAN).length === 1, "no second bootstrap or preparation against an unread page");
      assert(chatCalls(server, FINAL_REPORT).length === 0 && chatCalls(server, COMPLETION_CHECK).length === 0, "no success inference or synthesis without a page");
    } finally { await server.close(); }
  }
});

await test("Stop during blank startup discards pending clarification, navigation and failure replies", async () => {
  for (const mode of ["clarification", "decision_failure", "before_dispatch", "inflight", "inflight_error", "inflight_throw", "observation"]) {
    let h;
    const server = await startModelServer({ text: (body) => instructionOf(body) === ACTION_PLAN ? { ...preparedPlan(RUN_MEMORY), navigation: [{ url: "https://example.com/", purpose: "Open the requested site" }] } : undefined, steps: () => {
      if (["clarification", "decision_failure", "before_dispatch"].includes(mode)) h.run.stop("user_stop");
      if (mode === "decision_failure") return { status: 503, payload: { error: "unavailable" } };
      return mode === "clarification" ? { operation: "BLOCKED", needsOperator: true, intent: "Bạn muốn bay ngày nào?" } : { operation: "NAVIGATE", url: "https://example.com/" };
    } });
    h = await startupHarness({ callTool: async ({ name }) => {
      if (name === "navigate" && mode.startsWith("inflight")) {
        h.run.stop("user_stop");
        if (mode === "inflight_throw") throw new Error("transport stopped");
        if (mode === "inflight_error") return { isError: true, content: [{ type: "text", text: "Error: stopped" }] };
      }
      if (name === "page_snapshot" && mode === "observation") { h.run.stop("user_stop"); return unavailablePage(); }
      return undefined;
    } });
    authorizeBorrowedTabMutation(h.run, TAB_ID);
    try {
      const outcome = await runTypesafeRun({ ...h, provider: providerFor(server), sleep: async () => {} });
      assert(outcome.outcome === "stopped" && outcome.reason === "stopped" && !outcome.hasResult, JSON.stringify(outcome));
      assert(jevResults(h.events).length === 0 && chatCalls(server, FINAL_REPORT).length === 0, "no stale question or report after Stop");
      assert(h.bridgeCalls.filter((c) => c.name === "navigate").length <= 1, "never repeat an interrupted navigation");
      assertOneEnd(h.events, "stopped");
    } finally { await server.close(); }
  }
});

await test("an observation failure ends the run before any decision or dispatch", async () => {
  const server = await startModelServer({});
  const h = await harness({
    snapshots: [snapshot()],
    callTool: async ({ name }) => (name === "page_snapshot" ? { content: [{ type: "text", text: "Error: unknown tool page_snapshot" }] } : undefined)
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "observation_failed", JSON.stringify(outcome));
    assert(outcome.error.code === "OBSERVATION_ERROR", JSON.stringify(outcome.error));
    assert(outcome.steps === 0, `steps ${outcome.steps}`);
    assert(server.state.systemone === 0, "no decision may be requested without an observation");
    assert(dispatches(h.bridgeCalls).length === 0, "no browser action may be dispatched");
    const end = assertOneEnd(h.events, "error");
    assert(end.reason === "observation_failed", JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a run with no bound page tab fails observation before touching the bridge", async () => {
  const server = await startModelServer({});
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { tabId: null })
    });
    assert(outcome.outcome === "error" && outcome.reason === "observation_failed", JSON.stringify(outcome));
    assert(outcome.error.code === "OBSERVATION_ERROR", JSON.stringify(outcome.error));
    assert(outcome.steps === 0 && h.bridgeCalls.length === 0, "nothing may be dispatched without a bound tab");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("a malformed step decision is refused as invalid_decision and dispatches nothing", async () => {
  const server = await startModelServer({ steps: () => ({ operation: "TELEPORT", evaluation: "Chưa có bước nào trước đó." }) });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "invalid_decision", JSON.stringify(outcome));
    assert(outcome.error.code === "INVALID_RESPONSE", JSON.stringify(outcome.error));
    // The validator's refusal is asked exactly once more, and the recorded
    // failure names the model's own reply (fix-refused-answer-retry §3).
    assert(server.state.decisions === 1, `an invalid Jev action fails without executing or repeating (${server.state.decisions})`);
    assert(
      outcome.error.message.includes("action:choice_not_offered"),
      outcome.error.message
    );
    assert(dispatches(h.bridgeCalls).length === 0, "a refused decision must never reach the bridge");
    assert(server.state.systemone === 1, "the malformed Jev answer is the only decision request");
    assert(jevSteps(h.events).length === 0, "no step may be fabricated for a refused decision");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

// --- the one feedback retry (openspec/changes/fix-refused-answer-retry) -----
//
// The live failure: the step decision answered prose instead of a JSON object
// and one refused answer ended the run. The refusal is now asked once more
// with the reason carried back, and only its repetition is terminal.

/** The prose answer a gateway ignoring `json_object` occasionally returns. */
const PROSE_DECISION = "Chắc chắn rồi! Tôi sẽ nhập Zurich vào ô điểm đến rồi bấm tìm kiếm.";

await test("preparation prose followed by a valid plan recovers once before Jev executes", async () => {
  let preparations = 0;
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", text: "Zurich" }, { operation: "DONE" }],
    text: (body) => {
      if (instructionOf(body) !== ACTION_PLAN) return undefined;
      preparations++;
      return preparations === 1 ? completion(PROSE_DECISION) : { memory: RUN_MEMORY, textValues: [{ element: "1", value: "Zurich" }], navigation: [] };
    }
  });
  const h = await harness({ snapshots: [snapshot(), filledSnapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.reason === null, JSON.stringify(outcome));
    assert(outcome.steps === 1, `the recovered decision executed exactly one step (${outcome.steps})`);
    // The step the second answer named actually ran, with its own value.
    const dispatched = dispatches(h.bridgeCalls);
    assert(dispatched.length === 1 && dispatched[0].name === "form_input" && dispatched[0].args.value === "Zurich", JSON.stringify(dispatched));
    // Two NEXT_STEP requests for the first cycle (the refusal and the retry),
    // then one for the DONE cycle: exactly the one extra look.
    const decisions = chatCalls(server, ACTION_PLAN);
    assert(decisions.length === 2 && server.state.decisions === 2, "preparation retries once; Jev executes TYPE_TEXT then DONE");
    const [refused, retry] = decisions;
    assert(JSON.stringify(retry.messages[1]) === JSON.stringify(refused.messages[1]), "the retry re-sends the same step-decision context");
    assert(retry.messages[2].role === "assistant" && retry.messages[2].content === PROSE_DECISION, JSON.stringify(retry.messages[2]));
    assert(retry.messages[3].role === "user" && /^Your previous reply was refused: the text model's message content is not JSON/.test(retry.messages[3].content), retry.messages[3].content);
    assert(/no prose, no markdown fences\.$/.test(retry.messages[3].content), retry.messages[3].content);
    assert(jevSteps(h.events).length === 2, `the recovered step and the DONE cycle are recorded (${jevSteps(h.events).length})`);
    assertOneEnd(h.events, "done");
  } finally {
    await server.close();
  }
});

await test("preparation prose twice ends preparation_failed with no fabricated step", async () => {
  const server = await startModelServer({ text: (body) => instructionOf(body) === ACTION_PLAN ? completion(PROSE_DECISION) : undefined });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(outcome.error.code === "INVALID_RESPONSE", JSON.stringify(outcome.error));
    // The bounded preview of the model's own reply is in the recorded failure.
    assert(outcome.error.message.includes(`(reply starts: ${JSON.stringify(PROSE_DECISION)})`), outcome.error.message);
    assert(chatCalls(server, ACTION_PLAN).length === 2, "exactly two preparation attempts then terminal");
    assert(dispatches(h.bridgeCalls).length === 0, "a refused decision must never reach the bridge");
    assert(server.state.systemone === 0, "a refused decision never spends a TypeSafe request");
    assert(jevSteps(h.events).length === 0, "no step may be fabricated for a refused decision");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("an element-selection answer that is not offered is refused as invalid_decision", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    select: (body) => {
      return { answers: selectionAnswer(body, "99") };
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "invalid_decision", JSON.stringify(outcome));
    assert(outcome.error.code === "INVALID_RESPONSE", JSON.stringify(outcome.error));
    assert(dispatches(h.bridgeCalls).length === 0, "an unoffered key must never reach the bridge");
    assert(jevSteps(h.events).length === 0, "no step may be recorded for a refused selection");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("missing prepared text is refused before any Jev decision or typing", async () => {
  const server = await startModelServer({
    // A well-formed step that simply carries no value: the blocked outcome the
    // removed standalone value call used to produce (design.md §10).
    steps: [{ operation: "TYPE_TEXT", intent: "the destination field" }]
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(outcome.steps === 0, `nothing was typed, so nothing executed (steps ${outcome.steps})`);
    assert(dispatches(h.bridgeCalls).length === 0, "a missing value must never be typed");
    assert(server.state.systemone === 0, "a step with no value never reaches the element selection");
    assert(jevSteps(h.events).length === 0, "no action decision exists to record");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("missing and invalid prepared navigation URLs fail before any action", async () => {
  const missing = await startModelServer({ steps: [{ operation: "NAVIGATE" }] });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(missing) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may navigate without a URL");
    assert(jevSteps(h.events).length === 0 && missing.state.systemone === 0, "no candidate is offered for missing navigation content");
  } finally {
    await missing.close();
  }

  const invalid = await startModelServer({ steps: [{ operation: "NAVIGATE", url: "javascript:alert(1)" }] });
  const h2 = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h2.run, toolBridge: h2.toolBridge, coerceArgs: h2.coerceArgs, canUseTool: h2.canUseTool, provider: providerFor(invalid) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(outcome.error.code === "INVALID_RESPONSE", JSON.stringify(outcome.error));
    assert(dispatches(h2.bridgeCalls).length === 0, "an invalid URL must navigate nothing");
    assert(jevSteps(h2.events).length === 0 && invalid.state.systemone === 0, "invalid URL preparation never becomes an action");
    assertOneEnd(h2.events, "error");
  } finally {
    await invalid.close();
  }
});

await test("a Jev decision transport failure is a classified provider_error", async () => {
  const server = await startModelServer({
    steps: () => ({ status: 500, payload: { error: "model down" } })
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "provider_error", JSON.stringify(outcome));
    assert(outcome.error.code === "MODEL_UNAVAILABLE_ERROR", JSON.stringify(outcome.error));
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may dispatch when no step was decided");
    assert(jevSteps(h.events).length === 0, "no step may be fabricated when no step was decided");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

// --- stop ordering on the refusal/transport routes -------------------------
//
// The runtime's own invariant ("A stop outranks every one of them: once the
// run is no longer running, its outcome is `stopped`") must hold on the routes
// that never reach the loop's post-decision check: the step decision's own
// refusals (the `catch` branch) and the element-selection window. Each test
// below lets the stop land INSIDE the request whose answer would otherwise
// end the run blocked or failed, and asserts the stopped outcome plus the
// refused record the stop window emits.

await test("a stop during malformed text preparation outranks its validation failure", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    // The answer is a well-formed TYPE_TEXT step with no value, so its refusal
    // is `blocked`/`missing_value` — the verdict the stop must outrank.
    text: (body) => {
      if (instructionOf(body) !== ACTION_PLAN) return undefined;
      h.run.stop("user_stop");
      return { memory: RUN_MEMORY, textValues: [{ element: "1" }], navigation: [] };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the missing value (${JSON.stringify(outcome)})`);
    assert(outcome.steps === 0 && !("error" in outcome), JSON.stringify(outcome));
    assert(server.state.systemone === 0, "a stopped run spends no element selection");
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may dispatch after the stop");
    assert(jevSteps(h.events).length === 0, "stopped preparation produces no action decision");
    const end = assertOneEnd(h.events, "stopped");
    assert(end.reason === "stopped" && end.steps === 0 && end.doneIsDecided === false, JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a stop during invalid navigation preparation outranks URL validation", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    text: (body) => {
      if (instructionOf(body) !== ACTION_PLAN) return undefined;
      h.run.stop("user_stop");
      return { ...preparedPlan(RUN_MEMORY), navigation: [{ url: "ftp://example.com/x", purpose: "invalid route" }] };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the invalid URL (${JSON.stringify(outcome)})`);
    assert(!("error" in outcome), "a stopped run reports no text-model failure");
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may navigate after the stop");
    assert(jevSteps(h.events).length === 0 && server.state.systemone === 0, "no action request follows stopped preparation");
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while a malformed decision is in flight stops the run and records the refusal", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    steps: () => {
      h.run.stop("user_stop");
      return { operation: "TELEPORT" };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the malformed decision (${JSON.stringify(outcome)})`);
    assert(!("error" in outcome), "a stopped run reports no invalid decision");
    assert(server.state.systemone === 1, "stop lands inside the single malformed Jev request");
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may dispatch after the stop");
    const step = jevSteps(h.events)[0];
    // The validator refused before reading any operation, so the refused
    // record names none — but the stopped window still records the cycle.
    assert(step && step.skippedReason === "stopped", `the stopped window records a refused step (${JSON.stringify(step)})`);
    assert(step.operation == null && step.target === null && step.tool === null && step.argsSummary == null, JSON.stringify(step));
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while a failing step decision is in flight stops the run instead of reporting the failure", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    steps: () => {
      h.run.stop("user_stop");
      return { status: 500, payload: { error: "model down" } };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the transport failure (${JSON.stringify(outcome)})`);
    assert(!("error" in outcome), "a stopped run reports no transport failure");
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may dispatch after the stop");
    const step = jevSteps(h.events)[0];
    assert(step && step.skippedReason === "stopped" && step.operation == null, `the refused record is the cycle's own (${JSON.stringify(step)})`);
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a stop landing while the element-selection request is in flight stops the run, never action_denied", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    // The stop lands after the request reached the provider but before the
    // loop handles its answer: the gate would refuse the dispatch
    // (`blocked`/`action_denied`), which the stop must outrank.
    select: () => {
      h.run.stop("user_stop");
      return "2";
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the gate's refusal (${JSON.stringify(outcome)})`);
    assert(outcome.steps === 0 && !("error" in outcome), JSON.stringify(outcome));
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may reach the bridge after the stop");
    const step = jevSteps(h.events)[0];
    assert(step.operation === "CLICK" && step.decisionSource === "jev" && step.skippedReason === "stopped", JSON.stringify(step));
    // The answer WAS received, so the element it named is recorded as-is;
    // nothing dispatched, so no tool or args are.
    assert(step.target === null && step.tool === null && step.argsSummary == null, "stop discards the execution target before dispatch");
    const end = assertOneEnd(h.events, "stopped");
    assert(end.reason === "stopped" && end.steps === 0, JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a stop landing while a failing element selection is in flight stops the run, never invalid_decision", async () => {
  const h = await harness({ snapshots: [snapshot()] });
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    // An answer with no choice for the one question: its refusal is
    // `error`/`invalid_decision`, which the stop must outrank.
    select: () => {
      h.run.stop("user_stop");
      return { answers: {} };
    }
  });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "stopped" && outcome.reason === "stopped", `a stop outranks the refused selection (${JSON.stringify(outcome)})`);
    assert(!("error" in outcome), "a stopped run reports no invalid decision");
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may reach the bridge after the stop");
    const step = jevSteps(h.events)[0];
    assert(step && step.operation == null && step.skippedReason === "stopped" && step.target === null && step.tool === null, JSON.stringify(step));
    assertOneEnd(h.events, "stopped");
  } finally {
    await server.close();
  }
});

await test("a provider failure at the element-selection stage is classified as a provider error", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }],
    select: () => ({ status: 401, payload: { error: "bad key" } })
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "error" && outcome.reason === "provider_error", JSON.stringify(outcome));
    assert(outcome.error.code === "AUTH_ERROR", JSON.stringify(outcome.error));
    assert(dispatches(h.bridgeCalls).length === 0, "no dispatch after a provider failure");
    assert(jevSteps(h.events).length === 0, "no step may claim an element the provider never returned");
    assertOneEnd(h.events, "error");
  } finally {
    await server.close();
  }
});

await test("missing editable targets offer no typing; REPLAN records its skipped outcome and continues", async () => {
  // The page has no editable element at all: the TYPE_TEXT step cannot be
  // resolved, which is NOT a run failure (design.md §10) — the step is
  // recorded, counts one, and the next cycle is asked (here: DONE).
  const readOnly = snapshot({ elements: [{ ref: "ref_1", role: "button", label: "Search", tag: "button" }] });
  const server = await startModelServer({
    steps: [{ operation: "REPLAN" }, { operation: "DONE" }]
  });
  const h = await harness({ snapshots: [readOnly] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    assert(outcome.steps === 0, `nothing executed (steps ${outcome.steps})`);
    const steps = jevSteps(h.events);
    assert(steps.length === 2, `both cycles are recorded (got ${steps.length})`);
    assert(steps[0].operation === "REPLAN" && steps[0].skippedReason === "replan", JSON.stringify(steps[0]));
    assert(steps[0].target === null, JSON.stringify(steps[0]));
    assert(steps[0].latencies.selectionMs === undefined, "no selection was ever requested for it");
    assert(steps[1].skippedReason === "done", JSON.stringify(steps[1]));
    assert(server.state.systemone === 2 && actionPlanCalls(server, "replan").length === 1, "one Jev REPLAN consults once before DONE");
    assert(server.state.bodies.filter((body) => body?.questions).every((body) => Object.values(body.questions.action.criteria).every((criterion) => JSON.parse(criterion).operation !== "TYPE_TEXT")), "no unbound typing is offered");
    // The configured model sees the skipped step in the next request's recent
    // actions, which is what lets it correct.
    const decisions = stepDecisions(server);
    assert(decisions.length === 2, JSON.stringify(decisions.length));
    assert(decisions[1].recent_actions.length === 1 && decisions[1].recent_actions[0].action === "REPLAN", JSON.stringify(decisions[1].recent_actions));
    assert(decisions[1].recent_actions[0].kind === null && decisions[1].recent_actions[0].page_changed === false, JSON.stringify(decisions[1].recent_actions));
    assertOneEnd(h.events, "done");
  } finally {
    await server.close();
  }
});

await test("repeated REPLAN without actionable content exhausts its bound without dispatch", async () => {
  const readOnly = snapshot({ elements: [{ ref: "ref_1", role: "button", label: "Search", tag: "button" }] });
  const server = await startModelServer({ steps: [{ operation: "REPLAN" }] });
  const h = await harness({ snapshots: [readOnly] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "replan_limit", JSON.stringify(outcome));
    assert(outcome.steps === 0, `no action ever executed (steps ${outcome.steps})`);
    assert(
      jevSteps(h.events).every((s) => s.skippedReason === "replan"),
      JSON.stringify(jevSteps(h.events).map((s) => s.skippedReason))
    );
    assert(server.state.systemone === 4, "the fourth REPLAN reaches the default three-consultation bound");
    assert(actionPlanCalls(server, "replan").length === 3 && dispatches(h.bridgeCalls).length === 0, "replanning is bounded and never dispatches");
    assertOneEnd(h.events, "blocked");
  } finally {
    await server.close();
  }
});

await test("no dispatch ever occurs without the shared checks: a denied gate and a refused scope both stop short", async () => {
  // Gate denial: the approval callback refuses before the shared module runs.
  const denyServer = await startModelServer({ steps: [{ operation: "TYPE_TEXT", intent: "the search field", text: "Zurich" }] });
  const denied = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: denied.run,
      toolBridge: denied.toolBridge,
      coerceArgs: denied.coerceArgs,
      canUseTool: async () => ({ behavior: "deny", message: "operator refused" }),
      provider: providerFor(denyServer)
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "action_denied", JSON.stringify(outcome));
    assert(dispatches(denied.bridgeCalls).length === 0, "a gate denial must never reach the bridge");
    // Nothing even reached the shared module, so no rejection was recorded.
    assert(!denied.events.some((e) => e.type === "tool_rejected"), "a gate denial stops before the handler-side checks");
  } finally {
    await denyServer.close();
  }

  // Shared-check refusal: the gate allows, the handler-side checks refuse —
  // the tab leaves the run's scope between the observation (which passes the
  // same checks) and the action.
  const scopeServer = await startModelServer({ steps: [{ operation: "TYPE_TEXT", intent: "the search field", text: "Zurich" }] });
  const scopeHolder = {};
  const refused = await harness({
    tabScope: [TAB_ID],
    snapshots: [snapshot()],
  });
  scopeHolder.run = refused.run;
  try {
    const outcome = await runTypesafeRun({ run: refused.run, toolBridge: refused.toolBridge, coerceArgs: refused.coerceArgs, canUseTool: async (...args) => {
      const verdict = await refused.canUseTool(...args);
      scopeHolder.run.tabScope = [999];
      return verdict;
    }, provider: providerFor(scopeServer) });
    assert(outcome.outcome === "error" && outcome.reason === "observation_failed", JSON.stringify(outcome));
    assert(scopeServer.state.systemone === 1, "scope changes after the Jev choice and approval gate, at the guarded refresh");
    assert(dispatches(refused.bridgeCalls).length === 0, "a shared-check refusal must never reach the bridge with an action");
    assert(refused.events.some((e) => e.type === "tool_rejected" && e.reason === "tab_out_of_scope"), "the shared module's own rejection must be recorded");
  } finally {
    await scopeServer.close();
  }

  // Stop before the first cycle: nothing dispatches at all.
  const stopServer = await startModelServer({ steps: [{ operation: "WAIT" }] });
  const stopped = await harness({ snapshots: [snapshot()] });
  stopped.run.stop("user_stop");
  try {
    const outcome = await runTypesafeRun({ run: stopped.run, toolBridge: stopped.toolBridge, coerceArgs: stopped.coerceArgs, canUseTool: stopped.canUseTool, provider: providerFor(stopServer) });
    assert(outcome.outcome === "stopped", JSON.stringify(outcome));
    assert(stopped.bridgeCalls.length === 0, "a stopped run must not even observe");
    assert(stopServer.state.systemone === 0, "a stopped run must not request a decision");
  } finally {
    await stopServer.close();
  }
});

await test("an ASK decision ends operator-needed without dispatching", async () => {
  const server = await startModelServer({ steps: [{ operation: "ASK" }] });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "needs_operator" && outcome.needsOperator === true, JSON.stringify(outcome));
    assert(outcome.steps === 0, JSON.stringify(outcome));
    assert(dispatches(h.bridgeCalls).length === 0, "a BLOCKED decision dispatches nothing");
    const end = assertOneEnd(h.events, "blocked");
    assert(end.doneIsDecided === false, JSON.stringify(end));
    assert(jevSteps(h.events)[0].skippedReason === "needs_operator", JSON.stringify(jevSteps(h.events)[0]));
  } finally {
    await server.close();
  }
});

await test("scrolling uses the viewport centre and the snapshot's own scroll direction data", async () => {
  const tall = snapshot({ scroll: { y: 900, height: 2400 } });
  const server = await startModelServer({
    steps: [{ operation: "SCROLL_UP" }, { operation: "DONE" }]
  });
  const h = await harness({ snapshots: [tall, tall] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const scroll = dispatches(h.bridgeCalls)[0];
    assert(scroll.name === "computer" && scroll.args.action === "scroll", JSON.stringify(scroll.args));
    assert(scroll.args.scroll_direction === "up" && scroll.args.scroll_amount === 3, JSON.stringify(scroll.args));
    assert(scroll.args.coordinate[0] === 400 && scroll.args.coordinate[1] === 300, JSON.stringify(scroll.args.coordinate));
    assert(jevSteps(h.events)[0].target === null, "a targetless operation records no target");
  } finally {
    await server.close();
  }
});

await test("a SELECT decision writes the observed option value through form_input", async () => {
  const withSelect = snapshot({
    elements: [
      { ref: "ref_1", role: "combobox", label: "Cabin", tag: "select", value: "econ", options: [{ label: "Economy", value: "econ", selected: true }, { label: "Business", value: "biz" }] }
    ]
  });
  const server = await startModelServer({
    steps: [{ operation: "SELECT", intent: "the cabin dropdown" }, { operation: "DONE" }],
    select: () => "1:2"
  });
  const h = await harness({ snapshots: [withSelect, withSelect] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const write = dispatches(h.bridgeCalls)[0];
    assert(write.name === "form_input" && write.args.ref === "ref_1" && write.args.value === "biz", JSON.stringify(write.args));
    const step = jevSteps(h.events)[0];
    assert(step.operation === "SELECT" && step.target.index === step.actionKey && step.target.label === "Business", JSON.stringify(step));
    assert(step.argsSummary.value === "biz", "a select's page-derived option value is part of the record");
    assert(step.textField === undefined, "no text model was involved in a SELECT");
  } finally {
    await server.close();
  }
});

await test("a HOVER step rests the pointer by ref — one computer hover, no click, no approval card", async () => {
  // The dauthau.asia shape (openspec/changes/add-hover-step-operation
  // design.md §1/§2): the "Đấu thầu" submenu exists only while the pointer
  // rests on the menu item — a click leaves it closed.
  const menuClosed = snapshot({
    text: "Đấu thầu Nhà đầu tư",
    elements: [
      { ref: "ref_1", role: "link", label: "Đấu thầu", tag: "a" },
      { ref: "ref_2", role: "link", label: "Trang chủ", tag: "a" }
    ]
  });
  const menuOpen = snapshot({
    text: "Đấu thầu Nhà đầu tư Thông tin nhà thầu",
    elements: [
      { ref: "ref_1", role: "link", label: "Đấu thầu", tag: "a", expanded: true },
      { ref: "ref_3", role: "link", label: "Thông tin nhà thầu", tag: "a" }
    ]
  });
  const server = await startModelServer({
    steps: [{ operation: "HOVER", intent: "the Đấu thầu menu" }, { operation: "DONE" }],
    select: () => "1"
  });
  const h = await harness({ snapshots: [menuClosed, menuOpen, menuOpen] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.steps === 1, JSON.stringify(outcome));
    const dispatched = dispatches(h.bridgeCalls);
    assert(dispatched.length === 1, `exactly one dispatch (got ${dispatched.length})`);
    assert(dispatched[0].name === "computer" && dispatched[0].args.action === "hover", JSON.stringify(dispatched[0].args));
    assert(dispatched[0].args.ref === "ref_1" && dispatched[0].args.tabId === TAB_ID, JSON.stringify(dispatched[0].args));
    assert(!dispatched.some((d) => String(d.args.action).includes("click")), "a hover never clicks");
    // The selection asked the HOVER head, over exactly the CLICK candidate set.
    const selections = server.state.bodies.filter((b, i) => server.state.paths[i] === "/v1/systemone");
    assert(selections.length === 2, "Jev decides HOVER then DONE");
    assert(Object.keys(selections[0].questions).join(",") === "action,goal_done,stuck", "hover uses the shared three-head protocol");
    const offeredHovers = Object.values(selections[0].questions.action.criteria).map((criterion) => JSON.parse(criterion)).filter((action) => action.operation === "HOVER");
    assert(offeredHovers.map((action) => action.ref).join(",") === "ref_1,ref_2", "every offered element is hoverable");
    const step = jevSteps(h.events)[0];
    assert(step.operation === "HOVER" && step.tool === "computer" && step.skippedReason == null, JSON.stringify(step));
    assert(step.target.index === step.actionKey && step.target.label === "Đấu thầu", JSON.stringify(step.target));
    assert(step.argsSummary.action === "hover" && step.argsSummary.ref === "ref_1", JSON.stringify(step.argsSummary));
    assert(step.pageChanged === true, "the menu opening changed the observation");
    // Hover is non-send-class: the shared checks pass it without a card.
    assert(!h.events.some((e) => e.type === "approval_request"), "a hover needs no approval");
    assert(h.tracker.size === 0, "nothing is left pending");
    // The next decision sees the hover as its own recorded kind, with the
    // target's own label — not the click's.
    const decisions = stepDecisions(server);
    assert(decisions[1].recent_actions.length === 1 && decisions[1].recent_actions[0].kind === "hover", JSON.stringify(decisions[1].recent_actions));
    assert(decisions[1].recent_actions[0].action === "Đấu thầu" && decisions[1].recent_actions[0].page_changed === true, JSON.stringify(decisions[1].recent_actions));
  } finally {
    await server.close();
  }
});

await test("after a HOVER, a CLICK of an item the menu then offers dispatches normally (the dauthau shape)", async () => {
  const menuClosed = snapshot({
    text: "Đấu thầu Nhà đầu tư",
    elements: [
      { ref: "ref_1", role: "link", label: "Đấu thầu", tag: "a" },
      { ref: "ref_2", role: "link", label: "Trang chủ", tag: "a" }
    ]
  });
  const menuOpen = snapshot({
    text: "Đấu thầu Nhà đầu tư Thông tin nhà thầu",
    elements: [
      { ref: "ref_1", role: "link", label: "Đấu thầu", tag: "a", expanded: true },
      { ref: "ref_3", role: "link", label: "Thông tin nhà thầu", tag: "a" }
    ]
  });
  const server = await startModelServer({
    steps: [
      { operation: "HOVER", intent: "the Đấu thầu menu" },
      { operation: "CLICK", intent: "the Thông tin nhà thầu item" },
      { operation: "DONE" }
    ],
    select: (body, index) => (index === 0 ? "1" : "2")
  });
  const h = await harness({ snapshots: [menuClosed, menuOpen, menuOpen, menuOpen] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.steps === 2, JSON.stringify(outcome));
    const dispatched = dispatches(h.bridgeCalls);
    assert(dispatched.length === 2, `the hover and the click (got ${dispatched.length})`);
    assert(dispatched[0].args.action === "hover" && dispatched[0].args.ref === "ref_1", JSON.stringify(dispatched[0].args));
    assert(dispatched[1].args.action === "left_click" && dispatched[1].args.ref === "ref_3", JSON.stringify(dispatched[1].args));
    const [hoverStep, clickStep] = jevSteps(h.events);
    assert(hoverStep.operation === "HOVER" && hoverStep.tool === "computer", JSON.stringify(hoverStep));
    assert(clickStep.operation === "CLICK" && clickStep.target.label === "Thông tin nhà thầu", JSON.stringify(clickStep));
    // The click's selection ran against the OPENED menu's elements — the item
    // the hover revealed is offered to it.
    const selections = server.state.bodies.filter((b, i) => server.state.paths[i] === "/v1/systemone");
    assert(selections.length === 3, "Jev decides HOVER, CLICK, then DONE");
    assert(Object.keys(selections[1].questions).join(",") === "action,goal_done,stuck", "every action uses all three heads");
    const clickCandidates = Object.values(selections[1].questions.action.criteria).map((criterion) => JSON.parse(criterion)).filter((action) => action.operation === "CLICK");
    assert(clickCandidates.map((action) => action.ref).join(",") === "ref_1,ref_3", "click candidates come from the newly opened menu");
    // Exactly one card in the whole run — the click's; the hover's dispatch
    // needed none.
    const cards = h.events.filter((e) => e.type === "approval_request");
    assert(cards.length === 1, `only the click raises a card (got ${cards.length})`);
    assert(JSON.stringify(cards[0].target).includes("ref_3"), `the card binds the clicked item: ${JSON.stringify(cards[0].target)}`);
    assertOneEnd(h.events, "done");
  } finally {
    await server.close();
  }
});

// --- The capture path (openspec/changes/add-jev-run-screenshots) -----------
//
// Decision-layer contract: enabled captures accompany LLM preparation,
// replanning and fresh completion consultations through the guarded read-only
// path. Routine Jev decisions carry text only. Capture failures degrade that
// consultation to text; revoked scope still blocks subsequent observations.
// Disabled screenshots produce no capture at all.

await test("screenshots on: read-only captures accompany preparation, step evidence and completion", async () => {
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" }, { operation: "DONE" }]
  });
  const h = await harness({ snapshots: [snapshot(), filledSnapshot()], callTool: captureStub });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { sendScreenshots: true })
    });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));

    // Phase and before/after captures use the bound tab, unannotated,
    // through coerceArgs and the run's own wire meta, and never
    // suspended on an approval card (a capture changes nothing).
    const captures = captureCalls(h.bridgeCalls);
    assert(captures.length === 4, `preparation, before/after evidence, completion (got ${captures.length})`);
    assert(captures.every((c) => c.args.tabId === TAB_ID && c.args.annotate === false), JSON.stringify(captures.map((c) => c.args)));
    assert(captures.every((c) => !("save_to_disk" in c.args)), "a capture is never written to disk by this feature");
    assert(captures.every((c) => c.args.__coerced === true), "the capture passes through coerceArgs like every other call");
    assert(captures.every((c) => c.meta && c.meta.runId === h.run.runId), "the capture carries the run's wire meta");
    assert(!h.events.some((e) => e.type === "approval_request"), "a capture is a read: it never raises a card");

    // The capture rides the decision beside the SAME textual context.
    const decisions = chatCalls(server, ACTION_PLAN);
    assert(decisions.length === 1, `one initial preparation (got ${decisions.length})`);
    const [textPart, imagePart] = decisions[0].messages[1].content;
    assert(textPart.type === "text" && JSON.parse(textPart.text).page.url === "https://example.com/search", JSON.stringify(textPart));
    assert(JSON.stringify(imagePart) === JSON.stringify({ type: "image_url", image_url: { url: expectedImageUrl() } }), JSON.stringify(imagePart));
    assert(chatCalls(server, NEXT_STEP).length === 0, "routine decisions do not call the LLM");

    // Completion uses a fresh capture for its own observation. A routine
    // Jev decision has no screenshot to reuse across phases.
    const checks = chatCalls(server, COMPLETION_CHECK);
    assert(checks.length === 1, `exactly one completion check (got ${checks.length})`);
    assert(imageUrlOf(checks[0]) === expectedImageUrl(), "the check carries a fresh completion capture");
    assert(captureCalls(h.bridgeCalls).length === 4, "consultation and action evidence use distinct captures");

    // TypeSafe's element selection never carries a capture (it answers over
    // the structured observation only), and neither does any step record.
    const selections = server.state.bodies.filter((b, i) => server.state.paths[i] === "/v1/systemone");
    assert(selections.length === 2 && !JSON.stringify(selections).includes(SCREENSHOT_B64), "both complete-action requests remain text-only");
    assert(!JSON.stringify(jevSteps(h.events)).includes(SCREENSHOT_B64), "no durable step record carries the image");
    const actions = dispatches(h.bridgeCalls).filter((c) => !(c.name === "computer" && c.args?.action === "screenshot"));
    assert(actions.length === 1 && actions[0].name === "form_input", `the only non-capture dispatch is the typed step (got ${actions.length})`);
  } finally {
    await server.close();
  }
});

await test("screenshots on change nothing else: the capture-less run's own records are identical", async () => {
  const steps = [{ operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" }, { operation: "DONE" }];
  const pages = [snapshot(), filledSnapshot()];
  const onServer = await startModelServer({ steps });
  const offServer = await startModelServer({ steps });
  const on = await harness({ snapshots: [...pages], callTool: captureStub });
  const off = await harness({ snapshots: [...pages], callTool: captureStub });
  try {
    const withCapture = await runTypesafeRun({
      run: on.run,
      toolBridge: on.toolBridge,
      coerceArgs: on.coerceArgs,
      canUseTool: on.canUseTool,
      provider: providerFor(onServer, { sendScreenshots: true })
    });
    const withoutCapture = await runTypesafeRun({
      run: off.run,
      toolBridge: off.toolBridge,
      coerceArgs: off.coerceArgs,
      canUseTool: off.canUseTool,
      provider: providerFor(offServer)
    });
    assert(
      JSON.stringify(withCapture) === JSON.stringify(withoutCapture),
      `the terminal outcome must not change (${JSON.stringify(withCapture)} vs ${JSON.stringify(withoutCapture)})`
    );
    assert(
      JSON.stringify(endsWithoutIdentity(on.events)) === JSON.stringify(endsWithoutIdentity(off.events)),
      `the jev_end record must not change (${JSON.stringify(endsWithoutIdentity(on.events))} vs ${JSON.stringify(endsWithoutIdentity(off.events))})`
    );
    assert(
      JSON.stringify(stepsWithoutLatency(on.events), (key, value) => ["observedAt", "screenshot"].includes(key) ? undefined : value) === JSON.stringify(stepsWithoutLatency(off.events), (key, value) => ["observedAt", "screenshot"].includes(key) ? undefined : value),
      `the jev_step records must not change (${JSON.stringify(stepsWithoutLatency(on.events))} vs ${JSON.stringify(stepsWithoutLatency(off.events))})`
    );
    assert(captureCalls(on.bridgeCalls).length === 4 && captureCalls(off.bridgeCalls).length === 0, "only the toggled run captured");
  } finally {
    await onServer.close();
    await offServer.close();
  }
});

await test("screenshots off (or never resolved): no capture is made and every request is text-only", async () => {
  for (const [label, provider] of [
    ["the toggle off", (server) => providerFor(server, { sendScreenshots: false })],
    ["an unresolved toggle", (server) => providerFor(server)]
  ]) {
    const server = await startModelServer({
      steps: [{ operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" }, { operation: "DONE" }]
    });
    const h = await harness({ snapshots: [snapshot(), filledSnapshot()], callTool: captureStub });
    try {
      const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: provider(server) });
      assert(outcome.outcome === "done", `${label}: ${JSON.stringify(outcome)}`);
      assert(captureCalls(h.bridgeCalls).length === 0, `${label}: no capture may be made`);
      const bodies = server.state.bodies.filter((b, i) => String(server.state.paths[i]).endsWith("/chat/completions"));
      assert(bodies.length === 2, `${label}: preparation and completion check only (got ${bodies.length})`);
      assert(bodies.every((b) => typeof b.messages[1].content === "string"), `${label}: every request must be text-only`);
    } finally {
      await server.close();
    }
  }
});

await test("capture errors and missing image items degrade both consultation phases to text only", async () => {
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" }, { operation: "CLICK", intent: "the Search button" }, { operation: "DONE" }]
  });
  let captures = 0;
  const h = await harness({
    snapshots: [snapshot(), filledSnapshot(), resultsSnapshot()],
    callTool: async ({ name, args }) => {
      if (name !== "computer" || args?.action !== "screenshot") return undefined;
      captures += 1;
      if (captures === 1) throw new Error("the capture failed on this page"); // a capture ERROR
      if (captures === 6) return { content: [{ type: "text", text: "Successfully captured screenshot" }] }; // navigation replan has no image item
      return screenshotResult(); // the third cycle captures fine — a later cycle captures again
    }
  });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { sendScreenshots: true })
    });
    // Nothing about the run changes: the same outcome, the same executed
    // actions, no error, no disclosure.
    assert(outcome.outcome === "done" && outcome.doneVerified === true && outcome.steps === 2, JSON.stringify(outcome));
    assert(outcome.error === undefined && outcome.summaryError === undefined, JSON.stringify(outcome));
    assert(captures === 7, `three consultations and two before/after pairs (got ${captures})`);
    const decisions = chatCalls(server, ACTION_PLAN);
    assert(typeof decisions[0].messages[1].content === "string", "a failed capture makes that cycle's decision text-only");
    assert(typeof decisions[1].messages[1].content === "string", "a replan capture without an image item is text-only");
    assert(imageUrlOf(chatCalls(server, COMPLETION_CHECK)[0]) === expectedImageUrl(), "completion retries capture in its own phase after both failures");
    assert(chatCalls(server, NEXT_STEP).length === 0, "the three routine decisions are handled by Jev");
    const dispatched = dispatches(h.bridgeCalls).filter((c) => !(c.name === "computer" && c.args?.action === "screenshot"));
    assert(dispatched.length === 2, `the actions still dispatched (got ${dispatched.length})`);
  } finally {
    await server.close();
  }
});

await test("a capture that succeeds after a failed cycle is used, and a later cycle captures again", async () => {
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" }, { operation: "DONE" }]
  });
  let captures = 0;
  const h = await harness({
    snapshots: [snapshot(), filledSnapshot()],
    callTool: async ({ name, args }) => {
      if (name !== "computer" || args?.action !== "screenshot") return undefined;
      captures += 1;
      return captures === 1 ? { content: [{ type: "text", text: "Error: the tab is gone" }] } : screenshotResult();
    }
  });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { sendScreenshots: true })
    });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    assert(captures === 4, `later evidence and completion capture again (got ${captures})`);
    const decisions = chatCalls(server, ACTION_PLAN);
    assert(typeof decisions[0].messages[1].content === "string", "the failed cycle is text-only");
    assert(imageUrlOf(chatCalls(server, COMPLETION_CHECK)[0]) === expectedImageUrl(), "the later completion consultation carries the fresh capture");
  } finally {
    await server.close();
  }
});

await test("a lost capture response drops the image and never blocks (no result-unknown record)", async () => {
  const server = await startModelServer({ steps: [{ operation: "DONE" }] });
  const h = await harness({
    snapshots: [snapshot()],
    callTool: async ({ name, args }) =>
      name === "computer" && args?.action === "screenshot" ? { content: [{ type: "text", text: `Error: ${HOST_DROPPED_ERROR}` }] } : undefined
  });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { sendScreenshots: true })
    });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    assert(typeof chatCalls(server, ACTION_PLAN)[0].messages[1].content === "string", "the preparation is text-only");
    assert(typeof chatCalls(server, COMPLETION_CHECK)[0].messages[1].content === "string", "the check is text-only");
    // A capture is a READ: the observation's own precedent — a lost read is
    // nothing to be uncertain about, so no durable result-unknown is recorded.
    assert(!h.events.some((e) => e.type === "tool_result_unknown"), "a lost capture is not a result-unknown dispatch");
  } finally {
    await server.close();
  }
});

await test("a capture outside revoked tab scope never dispatches and fresh observation also refuses scope", async () => {
  const server = await startModelServer({ steps: [{ operation: "DONE" }] });
  const holder = {};
  const h = await harness({
    snapshots: [snapshot()],
    callTool: async ({ name, args }) => {
      if (name === "computer" && args?.action === "screenshot") return screenshotResult();
      // The observation passes, then the run's tab scope narrows: the capture's
      // own host-side check is what refuses it — exactly as it would refuse any
      // other dispatch to that tab.
      if (name === "page_snapshot") holder.run.tabScope = [999];
      return undefined;
    }
  });
  holder.run = h.run;
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { sendScreenshots: true })
    });
    assert(outcome.outcome === "error" && outcome.reason === "observation_failed", JSON.stringify(outcome));
    assert(captureCalls(h.bridgeCalls).length === 0, "the refused capture must never reach the bridge");
    assert(h.events.some((e) => e.type === "tool_rejected" && e.reason === "tab_out_of_scope"), "the shared module's own rejection is recorded");
    assert(typeof chatCalls(server, ACTION_PLAN)[0].messages[1].content === "string", "the preparation is text-only");
    assert(chatCalls(server, COMPLETION_CHECK).length === 0, "scope refusal cannot authorize a completion check");
  } finally {
    await server.close();
  }
});

// --- the selection floor, the element table, and the outcome history -------

/** A selection answer with a chosen key, its probabilities, and a confidence. */
function answerWith(body, chosen, probabilities, confidence) {
  const answers = selectionAnswer(body, chosen);
  answers.action = { choice: chosen, probabilities, confidence };
  return { answers };
}

function offeredAction(body, operation, ref) {
  return Object.entries(body.questions.action.criteria).find(([, text]) => {
    const action = JSON.parse(text);
    return action.operation === operation && (!ref || action.ref === ref);
  })?.[0];
}

await test("a selection below the confidence floor dispatches nothing and is recorded as an abstention", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "BLOCKED" }],
    select: (body) => {
      const key = offeredAction(body, "CLICK");
      return answerWith(body, key, oneHot(Object.keys(body.questions.action.criteria), key), 0.05);
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    const steps = jevSteps(h.events);
    assert(steps[0].skippedReason === "target_unresolved", JSON.stringify(steps[0]));
    assert(steps[0].targetAbstained === true, "an abstention is distinguishable from an empty element table");
    assert(steps[0].confidence === 0.05, `the confidence that caused it is recorded: ${steps[0].confidence}`);
    assert(dispatches(h.bridgeCalls).length === 0, "nothing may be dispatched on a guess");
    // The loop continued: the next decision was asked, and it ended the run.
    assert(server.state.decisions === 2, `the loop continues after an abstention (${server.state.decisions})`);
    assert(outcome.outcome === "blocked" && outcome.reason === "needs_operator", JSON.stringify(outcome));
  } finally {
    await server.close();
  }
});

await test("a near-tie dispatches nothing even when the provider is confident", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "BLOCKED" }],
    select: (body) => {
      const key = offeredAction(body, "CLICK");
      const ids = Object.keys(body.questions.action.criteria);
      const probabilities = Object.fromEntries(ids.map((id) => [id, 0]));
      probabilities[key] = 0.51;
      probabilities[ids.find((id) => id !== key)] = 0.49;
      return answerWith(body, key, probabilities, 0.95);
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    const steps = jevSteps(h.events);
    assert(steps[0].skippedReason === "target_unresolved" && steps[0].targetAbstained === true, JSON.stringify(steps[0]));
    assert(steps[0].runnerUpProbability === 0.49, `the runner-up is recorded: ${steps[0].runnerUpProbability}`);
    assert(dispatches(h.bridgeCalls).length === 0, "two candidates within a hair name no winner");
  } finally {
    await server.close();
  }
});

await test("a clear winner still dispatches when its absolute probability is small", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "BLOCKED" }],
    // A normalized distribution over every offered complete action: the
    // winner has only 40% mass but is clearly above each alternative.
    select: (body) => {
      const key = offeredAction(body, "CLICK", "ref_2");
      const ids = Object.keys(body.questions.action.criteria);
      return answerWith(body, key, Object.fromEntries(ids.map((id) => [id, id === key ? 0.4 : 0.6 / (ids.length - 1)])), 0.4);
    }
  });
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot()] });
  try {
    await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    const steps = jevSteps(h.events);
    assert(steps[0].skippedReason === undefined, `a clear winner must dispatch: ${JSON.stringify(steps[0])}`);
    assert(steps[0].target.label === "Search" && steps[0].actionProbability === 0.4, JSON.stringify(steps[0]));
    assert(dispatches(h.bridgeCalls).length === 1, "exactly one dispatch");
  } finally {
    await server.close();
  }
});

await test("the step decision sees the element table, and the recent steps say what happened", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "BLOCKED" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot()] });
  try {
    await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    const decisions = stepDecisions(server);
    assert(Array.isArray(decisions[0].elements) && decisions[0].elements.length === 2, JSON.stringify(decisions[0].elements));
    assert(decisions[0].elements[1].label === "Search", JSON.stringify(decisions[0].elements[1]));
    assert(
      decisions[0].elements.every((element) => ["ref_1", "ref_2"].includes(element.ref)),
      "Jev's target metadata contains only observed refs; selected action keys remain host-resolved"
    );
    const recent = decisions[1].recent_actions;
    assert(recent.length === 1 && recent[0].outcome === "executed", JSON.stringify(recent));
    assert(recent[0].target === "Search", `the element actually operated is named: ${JSON.stringify(recent[0])}`);
    assert(recent[0].page_changed === true, JSON.stringify(recent[0]));
  } finally {
    await server.close();
  }
});

await test("a skipped step tells the next decision that nothing was operated", async () => {
  const server = await startModelServer({
    // The offered action has insufficient confidence, so nothing dispatches.
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "ASK" }],
    select: (body) => {
      const key = offeredAction(body, "CLICK", "ref_2");
      return answerWith(body, key, oneHot(Object.keys(body.questions.action.criteria), key), 0.05);
    }
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    const recent = stepDecisions(server)[1].recent_actions;
    assert(recent.length === 1 && recent[0].outcome === "skipped", JSON.stringify(recent));
    assert(recent[0].skipped_reason === "target_unresolved", JSON.stringify(recent[0]));
    assert(recent[0].target == null, `an abstained action records no operated target: ${JSON.stringify(recent[0])}`);
  } finally {
    await server.close();
  }
});

await test("the cycle after typing settles before it decides again, bounded", async () => {
  // The typed value leaves the observation unchanged (the page has not
  // rendered anything yet): the loop re-observes, bounded, instead of
  // deciding on a page that has not answered.
  const unchanged = snapshot();
  const server = await startModelServer({
    steps: [{ operation: "TYPE_TEXT", intent: "the destination field", text: "Zurich" }, { operation: "BLOCKED" }],
    select: () => "1"
  });
  const h = await harness({ snapshots: [unchanged] });
  const sleeps = [];
  try {
    await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    const snapshots = h.bridgeCalls.filter((c) => c.name === "page_snapshot").length;
    assert(sleeps.length === 3 && sleeps.every((ms) => ms === 200), `the settle is bounded: ${JSON.stringify(sleeps)}`);
    // One observation before the run, one after the dispatch, three probes.
    assert(snapshots === 8, `settling adds three bounded probes alongside fresh decision and approval observations (${snapshots})`);
  } finally {
    await server.close();
  }
});

await test("an unchanged click has its own bounded settle waits", async () => {
  const server = await startModelServer({
    steps: [{ operation: "CLICK", intent: "the Search button" }, { operation: "BLOCKED" }],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot()] });
  const sleeps = [];
  try {
    await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      sleep: async (ms) => {
        sleeps.push(ms);
      }
    });
    assert(sleeps.length === 5 && sleeps.every((ms) => ms === 200), `bounded click settle: ${JSON.stringify(sleeps)}`);
  } finally {
    await server.close();
  }
});

await test("a run whose decision model speaks the Anthropic wire works end to end", async () => {
  // The selection stays on Jev's own route; only the decision model moves to
  // the project's own Messages wire — the `chatgpt` source reaches the same
  // wire through the companion gateway, so this covers both.
  const messages = [];
  const server = await startModelServer({ steps: [{ operation: "BLOCKED" }] });
  const decisionServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      messages.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
      const instruction = JSON.parse(raw).system;
      const reply =
        instruction === ACTION_PLAN
          ? JSON.stringify(preparedPlan({ plan: "p", doneWhen: "d", notes: "n" }))
          : JSON.stringify({ report: FINAL_REPORT_TEXT });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: reply }], usage: {} }));
    });
  });
  await new Promise((resolve) => decisionServer.listen(0, "127.0.0.1", resolve));
  const decisionUrl = `http://127.0.0.1:${decisionServer.address().port}`;
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { textModel: { kind: "anthropic", baseUrl: decisionUrl, model: "claude-x", apiKey: "sk-secret" } })
    });
    assert(outcome.outcome === "blocked" && outcome.reason === "needs_operator", JSON.stringify(outcome));
    assert(messages.length >= 1 && messages.every((m) => m.path === "/v1/messages"), JSON.stringify(messages.map((m) => m.path)));
    assert(messages.every((m) => m.headers["x-api-key"] === "sk-secret" && !m.headers.authorization), "the Anthropic wire's auth header only");
    assert(messages.every((m) => typeof m.body.system === "string" && m.body.response_format === undefined), "system prompt, no strict-JSON flag");
    assert(server.state.chat === 0, "no Chat Completions call may be made for this profile");
  } finally {
    await new Promise((resolve) => decisionServer.close(resolve));
    await server.close();
  }
});

await test("a blocked run answers the operator instead of ending in silence", async () => {
  const server = await startModelServer({ steps: [{ operation: "BLOCKED" }] });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked", JSON.stringify(outcome));
    const results = jevResults(h.events);
    assert(results.length === 1 && results[0].text === FINAL_REPORT_TEXT, JSON.stringify(results));
    assert(outcome.hasResult === true, "the terminal record says an answer was produced");
    // The report is told how the run ended, not left to infer it.
    const reports = chatCalls(server, FINAL_REPORT).map((b) => JSON.parse(b.messages[1].content));
    assert(reports.length === 1, `exactly one report call (${reports.length})`);
    assert(reports[0].run_ended.outcome === "blocked" && reports[0].run_ended.reason === "needs_operator", JSON.stringify(reports[0].run_ended));
    assert(typeof reports[0].page.text === "string", "the last observation rides the report");
  } finally {
    await server.close();
  }
});

await test("a confirmed completion keeps its own report and makes no second call", async () => {
  const server = await startModelServer({ steps: [{ operation: "DONE" }] });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    const results = jevResults(h.events);
    assert(results.length === 1, `exactly one answer per run (${results.length})`);
    assert(results[0].text.includes("chuyến bay") || results[0].text.length > 0, results[0].text);
    assert(chatCalls(server, FINAL_REPORT).length === 0, "a confirmed completion needs no final report call");
  } finally {
    await server.close();
  }
});

await test("a run the operator refused still reports what it did", async () => {
  const server = await startModelServer({ steps: [{ operation: "CLICK", intent: "the Search button" }], select: () => "2" });
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot()], onApproval: () => "deny" });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "action_denied", JSON.stringify(outcome));
    const results = jevResults(h.events);
    assert(results.length === 1 && results[0].text === FINAL_REPORT_TEXT, JSON.stringify(results));
    const reports = chatCalls(server, FINAL_REPORT).map((b) => JSON.parse(b.messages[1].content));
    assert(reports[0].run_ended.reason === "action_denied", JSON.stringify(reports[0].run_ended));
  } finally {
    await server.close();
  }
});

await test("a failed report changes neither outcome nor reason, and is disclosed", async () => {
  const server = await startModelServer({
    steps: [{ operation: "WAIT" }],
    text: (body) => (instructionOf(body) === FINAL_REPORT ? { status: 500, payload: { error: "no report today" } } : undefined)
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server), limits: { maxDecisions: 1 } });
    assert(outcome.outcome === "blocked" && outcome.reason === "decision_budget", JSON.stringify(outcome));
    assert(jevResults(h.events).length === 0, "no answer may be invented");
    assert(typeof outcome.summaryError === "string" && outcome.summaryError.length > 0, `the failure is disclosed: ${outcome.summaryError}`);
    assert(outcome.hasResult === false, "the terminal record says no answer was produced");
    const end = h.events.filter((e) => e.type === "jev_end")[0];
    assert(end.hasResult === false && typeof end.summaryError === "string", JSON.stringify(end));
  } finally {
    await server.close();
  }
});

await test("a run that never observed, and one whose decision model is unreachable, ask for no report", async () => {
  // No observation: the very first snapshot fails.
  const serverA = await startModelServer({ steps: [{ operation: "BLOCKED" }] });
  const hA = await harness({ snapshots: [], callTool: async () => ({ isError: true, content: [{ type: "text", text: "page_snapshot failed" }] }) });
  try {
    const outcome = await runTypesafeRun({ run: hA.run, toolBridge: hA.toolBridge, coerceArgs: hA.coerceArgs, canUseTool: hA.canUseTool, provider: providerFor(serverA) });
    assert(outcome.outcome === "error" && outcome.reason === "observation_failed", JSON.stringify(outcome));
    assert(jevResults(hA.events).length === 0, "a run with nothing to report reports nothing");
    assert(chatCalls(serverA, FINAL_REPORT).length === 0, "and asks for nothing");
  } finally {
    await serverA.close();
  }

  // The decision model itself is unreachable: asking it again is not a plan.
  const serverB = await startModelServer({ steps: [{ operation: "DONE" }], text: (body) => instructionOf(body) === ACTION_PLAN ? { status: 503, payload: { error: "upstream down" } } : undefined });
  const hB = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: hB.run, toolBridge: hB.toolBridge, coerceArgs: hB.coerceArgs, canUseTool: hB.canUseTool, provider: providerFor(serverB) });
    assert(outcome.outcome === "error" && outcome.reason === "preparation_failed", JSON.stringify(outcome));
    assert(chatCalls(serverB, FINAL_REPORT).length === 0, "no report is asked of an unreachable model");
    assert(jevResults(hB.events).length === 0, "and none is invented");
  } finally {
    await serverB.close();
  }
});

await test("a run blocked on the operator says so, distinctly from a dead end", async () => {
  const server = await startModelServer({
    steps: [{ operation: "BLOCKED", intent: "the results need a signed-in account", needsOperator: true }]
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "blocked" && outcome.reason === "needs_operator", JSON.stringify(outcome));
    const steps = jevSteps(h.events);
    assert(steps[0].skippedReason === "needs_operator", JSON.stringify(steps[0]));
    const reports = chatCalls(server, FINAL_REPORT).map((b) => JSON.parse(b.messages[1].content));
    assert(reports[0].run_ended.reason === "needs_operator", "the report is told it is a question, not a dead end");
  } finally {
    await server.close();
  }
});

await test("the conversation's earlier turns ride preparation and the report", async () => {
  const server = await startModelServer({ steps: [{ operation: "BLOCKED" }] });
  const h = await harness({ snapshots: [snapshot()] });
  const conversation = [
    { prompt: "find flights to Zurich", answer: "Found 2 flights.", outcome: "done", reason: null }
  ];
  try {
    await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { conversation })
    });
    const decision = contextOf(chatCalls(server, ACTION_PLAN)[0]);
    assert(Array.isArray(decision.conversation) && decision.conversation.length === 1, JSON.stringify(decision.conversation));
    assert(decision.conversation[0].prompt === "find flights to Zurich", JSON.stringify(decision.conversation[0]));
    assert(decision.conversation[0].outcome === "done", JSON.stringify(decision.conversation[0]));
    const report = JSON.parse(chatCalls(server, FINAL_REPORT)[0].messages[1].content);
    assert(Array.isArray(report.conversation) && report.conversation.length === 1, JSON.stringify(report.conversation));
  } finally {
    await server.close();
  }
});

await test("an informational goal is answered without operating the page", async () => {
  const server = await startModelServer({ steps: [{ operation: "DONE" }] });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    assert(jevResults(h.events).length === 1, "the question is answered");
    assert(dispatches(h.bridgeCalls).length === 0, "nothing was operated");
    assert(server.state.systemone === 1, "Jev requests completion through one three-head decision");
    assert(!h.events.some((event) => event.type === "approval_request"), "no approval card is raised for a read-only run");
  } finally {
    await server.close();
  }
});

await test("the answer looks back over the run's pages, and a repeated page costs one record", async () => {
  const server = await startModelServer({
    steps: [
      { operation: "CLICK", intent: "the Search button" },
      { operation: "CLICK", intent: "the Search button" },
      { operation: "BLOCKED" }
    ],
    select: () => "2"
  });
  // The results page is observed twice, unchanged: it must contribute one
  // record, or a stalled run fills the budget with copies of one screen.
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot(), resultsSnapshot()] });
  try {
    await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    const report = chatCalls(server, FINAL_REPORT).map((b) => JSON.parse(b.messages[1].content))[0];
    assert(report, "the run answered");
    const pages = report.observed_pages || [];
    assert(pages.length === 2, `the answer sees both distinct pages, not just the last (${JSON.stringify(pages.map((p) => p.url))})`);
    assert(pages[0].url.includes("/search") && pages[1].url.includes("/results"), "oldest first, so the answer can follow the run's path");
    assert(pages.filter((p) => p.url.includes("/results")).length === 1, "the page observed twice unchanged contributes one record");
  } finally {
    await server.close();
  }
});

// --- consulting sources beyond the driven page ------------------------------

/** A local document server for the sources a run may consult. */
async function startSourceServer(handler) {
  const state = { paths: [] };
  const server = http.createServer((req, res) => {
    state.paths.push(req.url);
    handler(req, res, state);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { port, url: `http://127.0.0.1:${port}`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

await test("a check that names sources has them read once, and the answer attributes them", async () => {
  const docs = await startSourceServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>KTD</title></head><body>Tích hợp hệ thống CNTT</body></html>");
  });
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) =>
      instructionOf(body) === COMPLETION_CHECK
        ? // A public-looking URL: the guarded client refuses an IP literal in
          // the private ranges before any resolver or fetch is consulted, which
          // is exactly what the "unread" test below relies on.
          completion(JSON.stringify({ achieved: true, sources: ["http://public.example.com/about"] }))
        : undefined
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server),
      // The guarded client refuses loopback by design (proven in
      // jev-source-fetch.test.mjs), so this drives the loop's wiring against a
      // local document server while keeping the real client's shape.
      fetchSourceImpl: ({ url }) =>
        fetchSource({
          url,
          resolver: async () => [{ address: "93.184.216.34", family: 4 }],
          fetchImpl: (target, init) => globalThis.fetch(String(target).replace(/^http:\/\/[^/]+/, docs.url), init)
        })
    });
    assert(outcome.outcome === "done" && outcome.doneVerified === true, JSON.stringify(outcome));
    assert(docs.state.paths.length === 1 && docs.state.paths[0] === "/about", `the named source is read once: ${JSON.stringify(docs.state.paths)}`);
    const report = chatCalls(server, FINAL_REPORT).map((b) => JSON.parse(b.messages[1].content))[0];
    assert(report && Array.isArray(report.consulted_sources), "the answer is written with the sources in hand");
    assert(report.consulted_sources[0].url.endsWith("/about"), JSON.stringify(report.consulted_sources[0]));
    assert(/Tích hợp hệ thống/.test(report.consulted_sources[0].text), "the document's prose reaches the answer");
    assert(jevResults(h.events).length === 1, "still exactly one answer per run");
  } finally {
    await docs.close();
    await server.close();
  }
});

await test("a source that cannot be read is named as unread, and the run still answers", async () => {
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) =>
      instructionOf(body) === COMPLETION_CHECK
        ? completion(JSON.stringify({ achieved: true, sources: ["http://10.0.0.5/internal", "not a url"] }))
        : undefined
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    assert(outcome.outcome === "done", JSON.stringify(outcome));
    const report = chatCalls(server, FINAL_REPORT).map((b) => JSON.parse(b.messages[1].content))[0];
    const sources = report.consulted_sources || [];
    assert(sources.length === 2, JSON.stringify(sources));
    assert(sources.every((s) => typeof s.unread === "string" && s.unread.length > 0), `both are named unread: ${JSON.stringify(sources)}`);
    assert(/BLOCKED_ADDRESS/.test(sources[0].unread), `a LAN address is refused by name: ${sources[0].unread}`);
    assert(jevResults(h.events).length === 1, "the run still answers");
  } finally {
    await server.close();
  }
});

await test("consultation off means nothing is fetched and nothing is reported as failed", async () => {
  const docs = await startSourceServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>never read</body></html>");
  });
  const server = await startModelServer({
    steps: [{ operation: "DONE" }],
    text: (body) =>
      instructionOf(body) === COMPLETION_CHECK
        ? completion(JSON.stringify({ achieved: true, report: "Đã xong, không cần nguồn ngoài." }))
        : undefined
  });
  const h = await harness({ snapshots: [snapshot()] });
  try {
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: h.coerceArgs,
      canUseTool: h.canUseTool,
      provider: providerFor(server, { consultSources: false })
    });
    assert(outcome.outcome === "done" && !outcome.summaryError, JSON.stringify(outcome));
    assert(docs.state.paths.length === 0, "nothing is fetched");
    assert(jevResults(h.events)[0].text === "Đã xong, không cần nguồn ngoài.", "the check's own report stands");
  } finally {
    await docs.close();
    await server.close();
  }
});

await test("nothing is fetched while the run is still browsing", async () => {
  const docs = await startSourceServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>x</body></html>");
  });
  const server = await startModelServer({
    steps: [
      { operation: "CLICK", intent: "the Search button" },
      { operation: "CLICK", intent: "the Search button" },
      { operation: "BLOCKED" }
    ],
    select: () => "2"
  });
  const h = await harness({ snapshots: [snapshot(), resultsSnapshot(), resultsSnapshot()] });
  try {
    await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool, provider: providerFor(server) });
    // A run that browsed and then ended blocked names no sources, so it reads
    // none — and in no case does a fetch happen between two steps.
    assert(docs.state.paths.length === 0, `the browsing loop fetches nothing: ${JSON.stringify(docs.state.paths)}`);
  } finally {
    await docs.close();
    await server.close();
  }
});

await test("verified Anthropic success enables search only on the final answer", async () => {
  const bodies = [];
  const jevServer = await startModelServer({ steps: [{ operation: "DONE" }] });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const value = body.system === ACTION_PLAN ? preparedPlan(RUN_MEMORY)
        : body.system === COMPLETION_CHECK ? { achieved: true, report: "Two flights observed." }
        : { report: "Two flights observed; source: https://example.com/reference" };
      const content = body.system === FINAL_REPORT ? [
        { type: "text", text: "Checking sources" },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://example.com/reference" }] },
        { type: "text", text: JSON.stringify(value) }
      ] : [{ type: "text", text: JSON.stringify(value) }];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content, stop_reason: "end_turn" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const h = await harness({ snapshots: [resultsSnapshot()] });
  try {
    const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool,
      provider: providerFor(jevServer, { searchSources: true, textModel: { kind: "anthropic", baseUrl: url, model: "claude-x", apiKey: "k" } }) });
    assert(outcome.outcome === "done" && outcome.doneVerified, JSON.stringify(outcome));
    assert(bodies.length === 3, "preparation, completion check, final answer");
    assert(bodies.slice(0, 2).every((body) => !body.tools), "preparation and verdict never search");
    assert(bodies[2].tools[0].name === "web_search", "successful answer can search");
    assert(jevServer.state.systemone === 1, "Jev chooses DONE independently of the Anthropic model");
    assert(jevResults(h.events).length === 1 && jevResults(h.events)[0].text.includes("https://example.com/reference"), "one attributed final answer");
  } finally { await new Promise((resolve) => server.close(resolve)); await jevServer.close(); }
});

for (const mode of ["success", "disabled", "failure", "stopped", "stopped_failure"]) {
  await test(`confirmed DONE synthesis: ${mode}`, async () => {
    let h;
    const server = await startModelServer({ steps: [{ operation: "DONE" }], text: (body) => {
      if (instructionOf(body) !== FINAL_REPORT) return undefined;
      if (mode.startsWith("stopped")) h.run.stop("user_stop");
      if (mode.endsWith("failure")) return { status: 401, payload: { error: { message: "unauthorized" } } };
      return completion(JSON.stringify({ report: "A grounded final answer." }));
    } });
    h = await harness({ snapshots: [resultsSnapshot()] });
    try {
      const outcome = await runTypesafeRun({ run: h.run, toolBridge: h.toolBridge, coerceArgs: h.coerceArgs, canUseTool: h.canUseTool,
        provider: providerFor(server, { searchSources: true, consultSources: mode !== "disabled", conversation: [{ prompt: "Find flights to Zurich", answer: "Two flights", outcome: "done" }] }) });
      const check = JSON.parse(chatCalls(server, COMPLETION_CHECK)[0].messages[1].content);
      assert(check.conversation[0].prompt === "Find flights to Zurich", "follow-up context reaches the verdict");
      assert(check.consult_sources === (mode !== "disabled"), "check sees consultation preference");
      const reports = chatCalls(server, FINAL_REPORT);
      assert(reports.length === (mode === "disabled" ? 0 : 1), "only enabled search synthesizes");
      if (reports.length) {
        const context = JSON.parse(reports[0].messages[1].content);
        assert(context.completion_check.achieved === true && context.completion_check.report.length > 0, "verdict evidence preserved");
        assert(context.page.text === "2 flights found" && context.conversation.length === 1, "page and conversation preserved");
      }
      const answers = jevResults(h.events);
      assert(answers.length === (mode.startsWith("stopped") ? 0 : 1), "one answer, no stale success after stop");
      assert(outcome.outcome === (mode.startsWith("stopped") ? "stopped" : "done"), JSON.stringify(outcome));
      if (!mode.startsWith("stopped")) assert(outcome.doneVerified === true, "synthesis cannot alter verification");
      if (mode === "failure") assert(outcome.summaryError && answers[0].text === "Đã tìm thấy 2 chuyến bay.", "failed synthesis retains honest fallback with disclosure");
    } finally { await server.close(); }
  });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
// Same Windows/Node-24 libuv shutdown race as the other stub-server suites:
// set the exit status and let the loop drain instead of process.exit().
process.exitCode = failed.length ? 1 : 0;

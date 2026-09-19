#!/usr/bin/env node
//
// The companion's TypeSafe (Jev) run path
// (openspec/changes/add-typesafe-jev-provider tasks.md 6.1/6.3).
//
// Everything here is offline: a real CompanionCore driven through its real
// envelope protocol, a fake SDK that records whether it was ever asked for a
// query, a fake settings/profile pair, a fake tool bridge standing in for the
// extension, and a local HTTP server standing in for TypeSafe's
// `/v1/systemone`. What is NOT faked is the machinery under test: the run
// path branch, skills suppression, the identity-compatibility gate and
// binding, the run's own terminal events, the shared dispatch checks, the real
// Jev runtime, and the real lease/queue arbitration.
//
// Covered (one test group per line of task 6.3):
//   - a happy-path run with fakes: no SDK query is ever built, the loop's
//     steps and outcome land in the durable transcript, and the conversation
//     binds the `typesafe:jev` marker identity;
//   - a dispatched decision actually reaches the tool bridge with the
//     observation's own ref (the model's answer carried a number, never a
//     ref — the mapping stays host-side);
//   - each input only the SDK path can honor is rejected with the single
//     named reason `unsupported_in_typesafe_mode`, naming the field, before
//     any provider request or browser dispatch;
//   - branch placement after the identity-compatibility gate: a conversation
//     bound to a different provider refuses a typesafe turn exactly as it
//     refuses any other incompatible turn;
//   - stop semantics: a stop between the decision and the dispatch prevents
//     the dispatch entirely and ends the turn stopped — never done, never
//     an error;
//   - lease/queue arbitration between a typesafe run and an LLM run: the LLM
//     run queues behind the Jev run holding the lease and proceeds after.
//
// Run: node host/test/agent-typesafe-run.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

import { CompanionCore, UserAttachmentStore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";
import { NEXT_STEP, ACTION_PLAN, RUN_PLAN, MEMORY_REVISION, COMPLETION_CHECK, STALL_RECOVERY } from "../agent/jev/text-helper.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-typesafe-run-"));
process.env.OCIC_AGENT_HOME = scratchRoot;
process.env.OCIC_AGENT_CONFIG_DIR = scratchRoot;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the TypeSafe stand-in -------------------------------------------------
//
// Two endpoints, one server: `/chat/completions` answers the configured
// model's preparation and completion calls. Routine NEXT_STEP requests fail
// explicitly. `/v1/systemone` scripts complete actions from the actual offered
// keys and answers all three independent heads on every routine cycle.
// The probabilities cover exactly the offered ids, sum to 1, and put the
// chosen id at the maximum: the same rules questions.js validates, derived
// from the request rather than hard-coded, so this stub cannot drift from the
// wire shape under test.
const TEXT_MEMORY = Object.freeze({
  plan: "Mở giỏ hàng và hoàn tất thanh toán.",
  doneWhen: "Trang xác nhận đơn hàng hiển thị.",
  notes: "Đang ở trang giỏ hàng."
});

function textModelReply(body) {
  const instruction = body?.messages?.[0]?.content;
  if (instruction === ACTION_PLAN) return JSON.stringify({ memory: TEXT_MEMORY, textValues: [], navigation: [] });
  if (instruction === RUN_PLAN || instruction === MEMORY_REVISION) return JSON.stringify(TEXT_MEMORY);
  if (instruction === COMPLETION_CHECK) return JSON.stringify({ achieved: true, report: "Đã hoàn tất: đơn hàng được xác nhận." });
  if (instruction === STALL_RECOVERY) return JSON.stringify({ action: "block" });
  return JSON.stringify({ operation: "BLOCKED", evaluation: STEP_EVALUATION });
}

// Every step decision carries a bounded evaluation of the step before it; a
// scripted entry that does not name one gets this, so each test stays about
// the behaviour it is testing.
const STEP_EVALUATION = "Bước trước đã chạy; trang hiện tại là cơ sở cho bước này.";

/** A scripted entry is an operation name or a full step decision. */
function normaliseStep(entry) {
  const step =
    typeof entry !== "string"
      ? entry
      : ["CLICK", "TYPE_TEXT", "SELECT"].includes(entry)
        ? { operation: entry, intent: "the checkout control" }
        : { operation: entry };
  if (!step || typeof step !== "object" || typeof step.operation !== "string") return step;
  return Object.prototype.hasOwnProperty.call(step, "evaluation") ? step : { ...step, evaluation: STEP_EVALUATION };
}

function completionEnvelope(content) {
  return { choices: [{ message: { content } }], usage: { total_tokens: 4 } };
}

function startSystemoneServer({ operation = "DONE", operations = null, delayMs = 0 } = {}) {
  const requests = [];
  const textRequests = [];
  let decisions = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      const instruction = body?.messages?.[0]?.content;
      if (String(req.url).endsWith("/chat/completions")) {
        textRequests.push({ headers: req.headers, body, instruction });
        if (instruction === NEXT_STEP) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Routine NEXT_STEP calls are forbidden in the decision layer" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completionEnvelope(textModelReply(body))));
        return;
      }
      if (req.method !== "POST" || !String(req.url).startsWith("/v1/systemone")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      requests.push({ headers: req.headers, body, headName: Object.keys(body.questions ?? {})[0] ?? null });
      const entry = Array.isArray(operations) && operations.length ? operations[Math.min(decisions, operations.length - 1)] : operation;
      decisions += 1;
      const actionOperation = typeof entry === "string" ? entry : entry.operation;
      const answers = {};
      for (const [headName, question] of Object.entries(body.questions ?? {})) {
        const ids = Object.keys(question.criteria ?? {});
        const selected = headName === "action"
          ? ids.find((id) => JSON.parse(question.criteria[id]).operation === actionOperation)
          : "no";
        if (!selected || !ids.includes(selected)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `No offered ${actionOperation} action in ${headName}` }));
          return;
        }
        const probabilities = {};
        for (const id of ids) probabilities[id] = id === selected ? 1 : 0;
        answers[headName] = { choice: selected, probabilities, confidence: 0.8 };
      }
      if (delayMs) await wait(delayMs);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers, usage: { total_tokens: 7 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        requests,
        textRequests,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

// --- the observation + bridge stand-in -------------------------------------

const SNAPSHOT_ELEMENT_REF = "ref_55";

function snapshotPayload({ url = "https://shop.example.test/cart", text = "Cart is empty", title = "Cart" } = {}) {
  return {
    v: 1,
    docNonce: "companion-document-1",
    url,
    title,
    viewport: { w: 800, h: 600 },
    scroll: { y: 0, height: 600 },
    text,
    truncated: { elements: false, text: false, omitted: 0 },
    elements: [
      {
        ref: SNAPSHOT_ELEMENT_REF,
        role: "button",
        label: "Checkout",
        tag: "button",
        type: "button",
        value: "",
        editable: false,
        disabled: false
      }
    ]
  };
}

/**
 * The tool-bridge stand-in. `calls` records every dispatch so a test can
 * prove what did and did not reach the extension; `hint` is what `describe_ref`
 * resolves to, which is what decides whether the gate sees a plain control or
 * a submit-class one. A `computer` screenshot (the run's per-cycle capture,
 * openspec/changes/add-jev-run-screenshots) answers the real image content
 * item.
 */
const SCREENSHOT_B64 = "c2NyZWVuc2hvdC1mcm9tLXRoZS1leHRlbnNpb24=";

function fakeBridge({ snapshot = snapshotPayload(), advanceOnAction = false, hint = { tagName: "button", attributes: { type: "button" }, text: "Checkout" } } = {}) {
  const calls = [];
  const bridge = new ToolBridge({
    init: async () => {},
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "page_snapshot") {
        return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
      }
      if (name === "describe_ref") {
        return { content: [{ type: "text", text: JSON.stringify({ ref: args.ref, ...hint }) }] };
      }
      if (name === "computer" && args?.action === "screenshot") {
        return {
          content: [
            { type: "text", text: "Successfully captured screenshot (800x600, jpeg)" },
            { type: "image", data: SCREENSHOT_B64, mimeType: "image/jpeg" }
          ]
        };
      }
      if (advanceOnAction && name === "computer") snapshot.text += ` Action ${calls.length} completed.`;
      return { content: [{ type: "text", text: `ok:${name}` }] };
    },
    shutdown: () => {}
  });
  bridge.calls = calls;
  return bridge;
}

const captureCalls = (bridge) => bridge.calls.filter((c) => c.name === "computer" && c.args?.action === "screenshot");
const imageUrlOf = (request) => {
  const content = request?.body?.messages?.[1]?.content;
  if (!Array.isArray(content)) return null;
  const part = content.find((block) => block && block.type === "image_url");
  return part ? part.image_url.url : null;
};
const expectedImageUrl = () => `data:image/jpeg;base64,${SCREENSHOT_B64}`;

/**
 * The profile snapshot the companion resolves. `sendScreenshots` is the
 * profile's own toggle (openspec/changes/add-jev-run-screenshots design.md
 * §4): the runs that are not about the capture set it OFF explicitly, and a
 * test that wants the documented default deletes the field (the companion
 * resolves "absent" to enabled).
 */
function typesafeSnapshot(endpoint, { model = "jev-latest", sendScreenshots = false } = {}) {
  return {
    runtime: "typesafe",
    model,
    env: { ANTHROPIC_BASE_URL: "typesafe:jev", ANTHROPIC_API_KEY: "" },
    typesafe: { endpoint, apiKey: "typesafe-key" },
    textModel: { baseUrl: `${endpoint}/text`, model: "text-model", apiKey: "text-key" },
    sendScreenshots,
    revision: 1,
    profileId: "default",
    credentialRevision: 1
  };
}

function anthropicSnapshot() {
  return {
    model: "claude-fake",
    env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
    revision: 1,
    profileId: "default",
    credentialRevision: 1
  };
}

function buildCore({ state, bridge, sdkCalls }) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const sdk = {
    async *query() {
      sdkCalls.push({ at: Date.now() });
      yield { type: "assistant", text: "sdk-ran" };
    }
  };
  const core = new CompanionCore({
    toolBridge: bridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk,
    profileProvider: {
      async snapshotForRun(profileId) {
        if (state.providerType === "typesafe") return state.snapshot ?? typesafeSnapshot("http://127.0.0.1:1");
        return anthropicSnapshot();
      }
    },
    settingsProvider: {
      async loadProfile() {
        // The single stored profile (profile.js reads one file), so the
        // record's own id is fixed and only its type is scripted.
        return { profileId: "default", providerType: state.providerType };
      }
    },
    attachmentStore: state.attachmentStore
  });
  return { core, sessionManager };
}

async function startConversation(core) {
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  return reply.conversationId;
}

async function transcriptEvents(core, conversationId) {
  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  // A snapshot request can race a run that is being torn down; an error
  // envelope there is "nothing to report yet", not a test failure.
  return Array.isArray(snap?.events) ? snap.events : [];
}

/**
 * Answer the first approval card the run raises. The panel's own reply shape
 * (companion.js's _handleApprovalDecision): {conversationId, requestId,
 * decision}.
 */
async function approveFirstCard(core, conversationId, decision = "approve") {
  const approved = await waitFor(async () => {
    const events = await transcriptEvents(core, conversationId);
    const request = events.find((e) => e.type === "approval_request");
    if (!request) return false;
    await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.APPROVAL_DECISION, { conversationId, requestId: request.requestId, decision })
    );
    return true;
  });
  return approved;
}

async function waitFor(predicate, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    if (ok) return true;
    await wait(stepMs);
  }
  return false;
}

console.log("\nTypeSafe (Jev) run path\n");

await test("a typesafe run never builds an SDK query: the loop's steps and done outcome land in the transcript", async () => {
  const server = await startSystemoneServer({ operation: "DONE" });
  const sdkCalls = [];
  const bridge = fakeBridge();
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`) };
  const { core } = buildCore({ state, bridge, sdkCalls });
  try {
    const conversationId = await startConversation(core);
    const start = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "default", modelId: "jev-latest", prompt: "check out the cart", tabScope: [9], context: { tabId: 9, url: "https://shop.example.test/cart", hostname: "shop.example.test" } })
    );
    assert(start.accepted === true, "the start must be accepted");
    const settled = await waitFor(async () => (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_done"));
    assert(settled, "the run must reach run_done");

    const events = await transcriptEvents(core, conversationId);
    assert(sdkCalls.length === 0, "a typesafe run must never call sdk.query()");
    assert(server.requests.length === 1, `Jev chooses DONE through one three-head request, got ${server.requests.length}`);
    const decisions = server.textRequests.filter((r) => r.instruction === NEXT_STEP);
    assert(decisions.length === 0, `no routine LLM step decisions, got ${decisions.length}`);
    assert(server.textRequests[0].headers.authorization === "Bearer text-key", "the plan carries the configured text model's bearer key");
    assert(server.textRequests.length === 2, "the LLM prepares once and verifies completion once");
    assert(server.textRequests[0].instruction === ACTION_PLAN, "action preparation is the first text-model call");
    assert(
      JSON.stringify(server.requests[0].body.state).includes(TEXT_MEMORY.plan),
      "the LLM plan must ride Jev's decision state"
    );

    const observation = bridge.callsCalls?.() ?? null;
    void observation;
    const step = events.find((e) => e.type === "jev_step");
    assert(step, "a jev_step must be recorded");
    assert(step.operation === "DONE" && step.skippedReason === "done", `the step records the done decision honestly, got ${JSON.stringify(step)}`);
    assert(typeof step.latencies?.decisionMs === "number", "the step records its decision latency");
    assert(step.verification?.achieved === true, `the DONE step records the confirming verdict, got ${JSON.stringify(step.verification)}`);
    const plan = events.find((e) => e.type === "jev_memory");
    assert(plan && plan.kind === "plan" && plan.trigger === "start" && plan.index === 1, `the plan is a durable memory row, got ${JSON.stringify(plan)}`);
    const end = events.find((e) => e.type === "jev_end");
    assert(end && end.outcome === "done" && end.doneIsDecided === true, `jev_end must record done-as-decided, got ${JSON.stringify(end)}`);
    assert(end.doneVerified === true, `the verified completion must be on the terminal record, got ${JSON.stringify(end)}`);
    assert(end.steps === 0, "no action executed for a DONE decision, so the step count is 0");
    assert(!events.some((e) => e.type === "run_error"), "a done run must not also report an error");
  } finally {
    await server.close();
  }
});

await test("a dispatched CLICK uses the observation's own ref and the shared checks, then the next decision ends the run", async () => {
  const server = await startSystemoneServer({ operations: ["CLICK", "DONE"] });
  const sdkCalls = [];
  // A submit-class control: the gate must classify it as needing the
  // operator's decision, which is what makes the card flow below reachable.
  const bridge = fakeBridge({ hint: { tagName: "button", attributes: { type: "submit" }, text: "Place order" } });
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`) };
  const { core } = buildCore({ state, bridge, sdkCalls });
  try {
    const conversationId = await startConversation(core);
    await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "click checkout", tabScope: [9], context: { tabId: 9, hostname: "shop.example.test" } })
    );
    // Clicking a `<button>` is send/submit-class, so the run suspends on the
    // SAME approval card an SDK run uses — the operator's Allow is what lets
    // the dispatch through (spec "Submit-class click waits for the operator").
    const cardShown = await approveFirstCard(core, conversationId, "approve");
    assert(cardShown, "the send-class click must suspend on an approval card");
    const finished = await waitFor(async () => (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_done"));
    assert(finished, "the two-cycle run must reach run_done");
    assert(server.requests.length === 2, `one Jev decision for CLICK and DONE, got ${server.requests.length}`);
    assert(server.requests[0].headers.authorization === "Bearer typesafe-key", "the selection request carries the TypeSafe bearer key");
    assert(server.requests.every((r) => Object.keys(r.body.questions).sort().join(",") === "action,goal_done,stuck"), "every decision asks all three independent heads");
    assert(server.textRequests.filter((r) => r.instruction === ACTION_PLAN).length === 1, "one LLM preparation spans the routine decisions");
    assert(server.textRequests.filter((r) => r.instruction === NEXT_STEP).length === 0, "no routine LLM step calls");
    assert(server.textRequests.filter((r) => r.instruction === COMPLETION_CHECK).length === 1, "the DONE cycle made exactly one completion check");

    const events = await transcriptEvents(core, conversationId);
    const steps = events.filter((e) => e.type === "jev_step");
    assert(steps.length === 2, `one jev_step per cycle, got ${steps.length}`);
    const click = steps[0];
    assert(click.operation === "CLICK", `the first step is the CLICK decision, got ${JSON.stringify(click)}`);
    assert(click.tool === "computer" && click.argsSummary?.action === "left_click", "the step names the executed browser tool and action");
    assert(click.argsSummary?.ref === SNAPSHOT_ELEMENT_REF, "the dispatched ref is the observation's ref, never a model-supplied one");
    assert(click.pageChanged === false, "an unchanged page is reported as unchanged, not omitted");
    const dispatch = bridge.calls.find((c) => c.name === "computer");
    assert(dispatch && dispatch.args.ref === SNAPSHOT_ELEMENT_REF, "the bridge received the host-mapped ref");
    assert(dispatch.args.tabId === 9, "and the run's bound tab");
    assert(steps[1].skippedReason === "done", "the second step is the DONE decision");
    assert(steps[1].verification?.achieved === true, `the confirmed DONE step carries its verdict (${JSON.stringify(steps[1].verification)})`);
    const end = events.find((e) => e.type === "jev_end");
    assert(end.outcome === "done" && end.steps === 1, `one action executed before done, got ${JSON.stringify(end)}`);
    assert(end.doneVerified === true, `the run-path terminal record carries the verified completion, got ${JSON.stringify(end)}`);
    assert(!events.some((e) => e.type === "run_error"), "the run ends without an error");
  } finally {
    await server.close();
  }
});

await test("several complete Jev actions share one preparation without any NEXT_STEP calls", async () => {
  const server = await startSystemoneServer({ operations: ["HOVER", "CLICK", "HOVER", "DONE"] });
  const sdkCalls = [];
  const bridge = fakeBridge({ advanceOnAction: true });
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`, { sendScreenshots: true }) };
  const { core } = buildCore({ state, bridge, sdkCalls });
  try {
    const conversationId = await startConversation(core);
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId, prompt: "inspect checkout and complete the cart", tabScope: [9], context: { tabId: 9, hostname: "shop.example.test" }
    }));
    assert(await waitFor(async () => (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_done")), "multi-action companion run finishes");
    const events = await transcriptEvents(core, conversationId);
    const steps = events.filter((e) => e.type === "jev_step");
    assert(steps.map((step) => step.operation).join(",") === "HOVER,CLICK,HOVER,DONE", `all Jev choices land durably: ${JSON.stringify(steps)}`);
    assert(steps.every((step) => step.decisionSource === "jev"), "every step preserves Jev attribution");
    assert(steps.slice(0, 3).every((step) => step.tool === "computer" && step.argsSummary.ref === SNAPSHOT_ELEMENT_REF), "all three actions use host-resolved observed targets");
    assert(server.requests.length === 4, "four real protocol decisions for three mutations and DONE");
    assert(server.requests.every((request) => Object.keys(request.body.questions).sort().join(",") === "action,goal_done,stuck"), "all requests exercise three-head validation");
    assert(server.textRequests.filter((request) => request.instruction === ACTION_PLAN).length === 1, "exactly one initial preparation");
    assert(!server.textRequests.some((request) => request.instruction === NEXT_STEP), "routine decisions never ask LLM NEXT_STEP");
    assert(server.textRequests.filter((request) => request.instruction === COMPLETION_CHECK).length === 1, "DONE requires independent completion verification");
    assert(captureCalls(bridge).length === 2, "only initial preparation and fresh completion capture images; routine Jev actions do not");
    const end = events.find((event) => event.type === "jev_end");
    assert(end?.outcome === "done" && end.doneVerified === true && end.steps === 3, "completion counts exactly the three executed actions");
    assert(sdkCalls.length === 0, "multi-action Jev run remains independent of the SDK");
  } finally {
    await server.close();
  }
});

await test("stop between the decision and the dispatch prevents the dispatch entirely", async () => {
  const server = await startSystemoneServer({ operation: "CLICK", delayMs: 150 });
  const sdkCalls = [];
  const bridge = fakeBridge();
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`) };
  const { core } = buildCore({ state, bridge, sdkCalls });
  try {
    const conversationId = await startConversation(core);
    await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "click checkout", tabScope: [9], context: { tabId: 9, hostname: "shop.example.test" } })
    );
    // The Jev decision is in flight (150ms); stop before it lands.
    assert(await waitFor(async () => server.requests.length === 1), "Jev decision must be in flight before Stop");
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
    const stopped = await waitFor(async () => (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_stopped"));
    assert(stopped, "the run reaches run_stopped");
    await wait(250); // let the in-flight decision resolve
    const events = await transcriptEvents(core, conversationId);
    assert(!bridge.calls.some((c) => c.name === "computer"), "a decision that lands after Stop must dispatch nothing");
    assert(server.requests.length === 1, "Stop prevents any further Jev decision");
    const end = events.find((e) => e.type === "jev_end");
    assert(end && end.outcome === "stopped", `the loop reports itself stopped, got ${JSON.stringify(end)}`);
    const step = events.find((e) => e.type === "jev_step");
    assert(step && step.skippedReason === "stopped" && !step.tool, `the stopped decision is recorded without a dispatch claim, got ${JSON.stringify(step)}`);
    assert(!events.some((e) => e.type === "run_error"), "a user stop is never an error");
  } finally {
    await server.close();
  }
});

await test("inputs only the SDK path can honor are rejected with one named reason before any provider request", async () => {
  const server = await startSystemoneServer({ operation: "DONE" });
  const sdkCalls = [];
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`) };
  const cases = [
    {
      field: "attachments",
      // A REAL stored artifact: the run path resolves attachment refs before
      // the typesafe branch, so the rejection must be the typesafe one, not
      // attachment_unavailable.
      prepare(core, conversationId) {
        core.attachmentStore.write(conversationId, "att-1", Buffer.from("hello"), { mimeType: "text/plain" });
        return { attachments: [{ id: "att-1", mimeType: "text/plain", byteLength: 5 }] };
      }
    },
    {
      field: "elementRecord",
      prepare() {
        return {
          elementRecord: {
            pageIdentity: { tabId: 9, url: "https://shop.example.test/cart" },
            selector: "button#checkout",
            tagName: "button",
            markup: "<button id=\"checkout\">Checkout</button>",
            markupTruncated: false,
            rectClipped: false,
            styles: { color: "rgb(0, 0, 0)" }
          }
        };
      }
    },
    { field: "slash_command", prepare: () => ({ prompt: "/some-skill do the thing" }) },
    {
      field: "upload_grants",
      prepare: () => ({ prompt: "check out" }),
      async after(core, conversationId) {
        // A real, existing regular file: the grant handler inspects the
        // filesystem, and a skipped path would leave no grant behind.
        const shared = path.join(scratchRoot, "shared.txt");
        fs.writeFileSync(shared, "shared with the agent");
        await core.handleEnvelope(
          makeEnvelope(AGENT_MESSAGE_TYPES.UPLOAD_GRANT, { conversationId, op: "grant", paths: [shared] })
        );
      }
    }
  ];

  try {
    for (const testCase of cases) {
      const bridge = fakeBridge();
      const { core } = buildCore({ state, bridge, sdkCalls });
      const conversationId = await startConversation(core);
      if (testCase.after) await testCase.after(core, conversationId);
      const extra = testCase.prepare(core, conversationId);
      await core.handleEnvelope(
        makeEnvelope(AGENT_MESSAGE_TYPES.START, {
          conversationId,
          prompt: extra.prompt ?? "do the task",
          modelId: "jev-latest",
          tabScope: [9],
          context: { tabId: 9, hostname: "shop.example.test" },
          ...(extra.attachments ? { attachments: extra.attachments } : {}),
          ...(extra.elementRecord ? { elementRecord: extra.elementRecord } : {})
        })
      );
      const rejected = await waitFor(async () =>
        (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_error" && e.reason === "unsupported_in_typesafe_mode")
      );
      assert(rejected, `${testCase.field}: the run must be rejected with unsupported_in_typesafe_mode`);
      const events = await transcriptEvents(core, conversationId);
      const error = events.find((e) => e.type === "run_error" && e.reason === "unsupported_in_typesafe_mode");
      assert(error.field === testCase.field, `${testCase.field}: the reason must name the field, got ${JSON.stringify(error.field)}`);
      assert(server.requests.length === 0, `${testCase.field}: no provider request may be made`);
      assert(!bridge.calls.some((c) => c.name === "page_snapshot"), `${testCase.field}: nothing may be observed`);
    }
  } finally {
    await server.close();
  }
});

await test("the branch sits after the identity gate: a conversation bound to another provider refuses the typesafe turn", async () => {
  const server = await startSystemoneServer({ operation: "DONE" });
  const sdkCalls = [];
  const bridge = fakeBridge();
  const state = { providerType: "anthropic" };
  const { core } = buildCore({ state, bridge, sdkCalls });
  try {
    const conversationId = await startConversation(core);
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "an anthropic turn" }));
    await waitFor(async () => (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_done"));
    assert(sdkCalls.length === 1, "the first (anthropic) turn ran through the SDK");

    // Now switch the profile to typesafe WITHOUT a new context.
    state.providerType = "typesafe";
    state.snapshot = typesafeSnapshot(`http://127.0.0.1:${server.port}`);
    const second = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a typesafe turn" }));
    assert(second.accepted === true, "the second send is accepted into the queue/run path");
    const refused = await waitFor(async () =>
      (await transcriptEvents(core, conversationId)).some((e) => e.type === "run_error" && e.reason === "conversation_identity_incompatible")
    );
    assert(refused, "the identity gate must refuse the incompatible turn (branch placement proof)");
    assert(server.requests.length === 0 && server.textRequests.length === 0, "the refusal happened before any provider request");
    assert(sdkCalls.length === 1, "and before any second SDK query");

    // With an explicit new context the same turn is allowed and runs the loop.
    const third = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, {
        conversationId,
        prompt: "a fresh typesafe turn",
        newSdkSession: true,
        tabScope: [9],
        context: { tabId: 9, hostname: "shop.example.test" }
      })
    );
    assert(third.accepted === true, "an explicit new context is accepted");
    const ran = await waitFor(async () => server.requests.length > 0);
    assert(ran, "the typesafe branch runs once the identity gate is satisfied");
    assert(sdkCalls.length === 1, "and still never calls the SDK");
  } finally {
    await server.close();
  }
});

await test("a typesafe run and an LLM run arbitrate on the shared lease exactly like two LLM runs", async () => {
  const server = await startSystemoneServer({ operation: "DONE", delayMs: 300 });
  const sdkCalls = [];
  const bridge = fakeBridge();
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`) };
  const { core } = buildCore({ state, bridge, sdkCalls });
  try {
    const conversationA = await startConversation(core);
    const conversationB = await startConversation(core);
    await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: conversationA, prompt: "jev run", tabScope: [9], context: { tabId: 9 } })
    );
    assert(await waitFor(async () => server.requests.length > 0, { timeoutMs: 2000 }), "Jev holds the lease during its in-flight decision");
    // While A holds the lease the operator switches the profile back to an
    // LLM provider and submits B — B resolves its provider only once it
    // actually starts, which is the point of the assertion below.
    state.providerType = "anthropic";

    // B starts while A holds the lease: accepted, queued, and no SDK call yet.
    const startB = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: conversationB, prompt: "llm run" }));
    assert(startB.accepted === true && startB.queued === true, `the second run must queue behind the Jev run, got ${JSON.stringify(startB)}`);
    assert(sdkCalls.length === 0, "the queued LLM run must not have queried yet");

    const ranB = await waitFor(async () => sdkCalls.length === 1, { timeoutMs: 5000 });
    assert(ranB, "once the Jev run releases the lease, the LLM run proceeds");
    const events = await transcriptEvents(core, conversationB);
    assert(events.some((e) => e.type === "run_started"), "the queued run started normally after the lease was released");
  } finally {
    await server.close();
  }
});

await test("the profile's screenshot toggle rides the provider object: on captures, off does not, and absent defaults on", async () => {
  const server = await startSystemoneServer({ operations: ["DONE"] });
  const sdkCalls = [];
  try {
    // ON: preparation and completion each consult their fresh observation;
    // routine Jev decisions remain text-only and take no capture themselves.
    const onBridge = fakeBridge();
    const onState = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`, { sendScreenshots: true }) };
    const on = buildCore({ state: onState, bridge: onBridge, sdkCalls });
    const onConversation = await startConversation(on.core);
    await on.core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: onConversation, prompt: "check out the cart", tabScope: [9], context: { tabId: 9, hostname: "shop.example.test" } })
    );
    assert(await waitFor(async () => (await transcriptEvents(on.core, onConversation)).some((e) => e.type === "run_done")), "the toggled-on run reaches run_done");
    const captures = captureCalls(onBridge);
    assert(captures.length === 2, `one preparation capture and one fresh completion capture (got ${captures.length})`);
    assert(captures[0].args.tabId === 9 && captures[0].args.annotate === false, JSON.stringify(captures[0].args));
    assert(!("save_to_disk" in captures[0].args), "the capture is never written to disk");
    const decisions = server.textRequests.filter((r) => r.instruction === ACTION_PLAN);
    assert(decisions.length === 1, `one plan preparation (got ${decisions.length})`);
    assert(imageUrlOf(decisions[0]) === expectedImageUrl(), `the preparation carries the capture (${JSON.stringify(decisions[0].body.messages[1].content)})`);
    const checks = server.textRequests.filter((r) => r.instruction === COMPLETION_CHECK);
    assert(checks.length === 1 && imageUrlOf(checks[0]) === expectedImageUrl(), "the completion check carries its fresh observation's capture");
    assert(captureCalls(onBridge).length === 2, "no additional routine Jev capture");
    assert(server.requests.length === 1 && !JSON.stringify(server.requests).includes(SCREENSHOT_B64), "Jev chooses DONE with text-only state");

    // OFF: no capture is made and every request is text-only.
    const offBridge = fakeBridge();
    const offState = { providerType: "typesafe", snapshot: typesafeSnapshot(`http://127.0.0.1:${server.port}`, { sendScreenshots: false }) };
    const off = buildCore({ state: offState, bridge: offBridge, sdkCalls });
    const offConversation = await startConversation(off.core);
    const before = server.textRequests.length;
    await off.core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: offConversation, prompt: "check out the cart", tabScope: [9], context: { tabId: 9, hostname: "shop.example.test" } })
    );
    assert(await waitFor(async () => (await transcriptEvents(off.core, offConversation)).some((e) => e.type === "run_done")), "the toggled-off run reaches run_done");
    assert(captureCalls(offBridge).length === 0, "the toggle off captures nothing at all");
    const offRequests = server.textRequests.slice(before);
    assert(offRequests.length >= 2 && offRequests.every((r) => typeof r.body.messages[1].content === "string"), "every request of the toggled-off run is text-only");

    // ABSENT (a profile stored before the toggle existed): the companion
    // resolves the documented default, which is ENABLED.
    const defaultBridge = fakeBridge();
    const defaultSnapshot = typesafeSnapshot(`http://127.0.0.1:${server.port}`, { sendScreenshots: true });
    delete defaultSnapshot.sendScreenshots;
    const defaultState = { providerType: "typesafe", snapshot: defaultSnapshot };
    const defaults = buildCore({ state: defaultState, bridge: defaultBridge, sdkCalls });
    const defaultConversation = await startConversation(defaults.core);
    await defaults.core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: defaultConversation, prompt: "check out the cart", tabScope: [9], context: { tabId: 9, hostname: "shop.example.test" } })
    );
    assert(
      await waitFor(async () => (await transcriptEvents(defaults.core, defaultConversation)).some((e) => e.type === "run_done")),
      "the defaulted run reaches run_done"
    );
    assert(captureCalls(defaultBridge).length === 2, "an absent toggle enables both LLM consultation captures (the documented default)");
  } finally {
    await server.close();
  }
});

await test("the conversation projection carries prompts, answers and outcomes — and nothing else", async () => {
  const bridge = fakeBridge();
  const state = { providerType: "typesafe", snapshot: typesafeSnapshot("http://127.0.0.1:1") };
  const { core, sessionManager } = buildCore({ state, bridge, sdkCalls: [] });
  const conversationId = await startConversation(core);
  const store = sessionManager.store;

  // A previous turn, as the transcript actually records one: the operator's
  // prompt, the answer the run produced, its steps, and how it ended.
  store.appendEvent(conversationId, { type: "message_submitted", runId: "run_prev", submission: { text: "tìm chuyến bay đi Zurich", attachments: [] } });
  store.appendEvent(conversationId, {
    type: "jev_step",
    runId: "run_prev",
    step: 1,
    operation: "CLICK",
    target: { index: "2", label: "Search" },
    tool: "computer",
    argsSummary: { action: "left_click", ref: "ref_2" },
    latencies: { decisionMs: 10 },
    pageChanged: true
  });
  store.appendEvent(conversationId, { type: "jev_result", runId: "run_prev", text: "Đã tìm thấy 2 chuyến bay.", latencyMs: 20 });
  store.appendEvent(conversationId, { type: "jev_end", runId: "run_prev", outcome: "done", reason: null, steps: 1, doneIsDecided: true, doneVerified: true, hasResult: true });

  const turns = core._typesafeConversationTurns(conversationId);
  assert(turns.length === 1, `one earlier turn (${turns.length})`);
  assert(turns[0].prompt === "tìm chuyến bay đi Zurich", JSON.stringify(turns[0]));
  assert(turns[0].answer === "Đã tìm thấy 2 chuyến bay.", JSON.stringify(turns[0]));
  assert(turns[0].outcome === "done", JSON.stringify(turns[0]));
  const flat = JSON.stringify(turns);
  assert(!flat.includes("ref_2") && !flat.includes("left_click"), `no step record or tool argument may ride along: ${flat}`);
  assert(!flat.includes("jev_step") && !flat.includes("latencies"), `nothing but prompt/answer/outcome: ${flat}`);

  // Another conversation's turns are never borrowed.
  const other = await startConversation(core);
  assert(core._typesafeConversationTurns(other).length === 0, "a fresh conversation has no earlier turns");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.error(`FAILED: ${f.name}\n${f.err}`);
  process.exit(1);
}

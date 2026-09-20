import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Run } from "../agent/session/run.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { createCanUseTool } from "../agent/policy/can-use-tool.js";
import { authorizeBorrowedTabMutation } from "../agent/tools/mapping.js";
import { runTypesafeRun } from "../agent/jev/runtime.js";
import { ACTION_PLAN, NEXT_STEP, COMPLETION_CHECK, FINAL_REPORT } from "../agent/jev/text-helper.js";

const memory = { plan: "Complete the requested form", doneWhen: "Confirmation appears", notes: "Only observed fields" };
const field = (ref = "field", label = "Name") => ({ ref, label, role: "textbox", tag: "input", editable: true, value: "" });
const button = (ref = "go", label = "Continue") => ({ ref, label, role: "button", tag: "button" });
const page = () => ({ docNonce: "doc1", url: "https://example.com/form", text: "Form", title: "Form", elements: [field(), button()], viewport: { w: 800, h: 600 }, scroll: { y: 0, height: 600 } });
const prepare = (textValues = []) => ({ memory, textValues, navigation: [] });
const content = (body) => { const v = body.messages[1].content; return JSON.parse(Array.isArray(v) ? v[0].text : v); };

async function drive({ initial = page(), plan = () => prepare(), choose = () => ({ operation: "DONE" }), mutate,
  gate = async () => ({ behavior: "allow" }), check = () => ({ achieved: true, report: "Confirmed" }),
  decisionHook, limits = {}, screenshots = false, bridgeHook, sleepHook,
  report = () => ({ report: "Stopped honestly" }), fetchSourceImpl } = {}) {
  let current = structuredClone(initial);
  const events = [], bodies = [], actions = [], snapshots = [];
  let plans = 0, decisions = 0;
  const pending = new Map();
  const tracker = { set(id, resolve) { pending.set(id, resolve); }, take(id) { const resolve = pending.get(id); pending.delete(id); return resolve; } };
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "decision-tests", lease: new BrowserLease(), approvals, tabScope: "any", onEvent: (e) => {
    events.push(e);
    if (e.type === "approval_request") queueMicrotask(() => tracker.take(e.requestId)?.({ decision: "approve" }));
  } });
  await run.begin();
  // Production authorizes the operator's bound (borrowed) tab for mutation
  // at launch (companion.js's `_launchRun`); this suite exercises the
  // decision loop, not the separate borrowed-tab gate, so its fixed tab is
  // granted the same way here.
  authorizeBorrowedTabMutation(run, 7);
  const actualGate = createCanUseTool({ run, approvals, requestIdTracker: tracker });
  const state = { run, events, actions, bodies, get page() { return current; }, set page(v) { current = v; } };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); bodies.push(body);
      let payload;
      if (body.questions) {
        decisions++;
        const choices = Object.entries(body.questions.action.criteria).map(([key, value]) => ({ key, ...JSON.parse(value) }));
        const wanted = choose({ body, choices, index: decisions - 1, state });
        const match = choices.find((c) => c.operation === wanted.operation && (!wanted.ref || c.ref === wanted.ref));
        assert(match, `unoffered ${JSON.stringify(wanted)}: ${JSON.stringify(choices)}`);
        const selected = { action: match.key, goal_done: wanted.goalDone ? "yes" : "no", stuck: wanted.stuck ? "yes" : "no" };
        const answers = Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [name, {
          choice: selected[name], probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === selected[name] ? 1 : 0])), confidence: wanted.confidence ?? .9
        }]));
        await decisionHook?.(state, body, decisions - 1);
        payload = wanted.invalid ? { answers: {} } : { answers };
      } else {
        const instruction = body.messages[0].content;
        assert.notEqual(instruction, NEXT_STEP, "routine cycle must never ask NEXT_STEP");
        const result = instruction === ACTION_PLAN ? plan({ body, context: content(body), index: plans++, state }) :
          instruction === COMPLETION_CHECK ? check(state) : instruction === FINAL_REPORT ? report({ state, body, context: content(body) }) : null;
        assert(result !== null, "unexpected helper instruction");
        payload = { choices: [{ message: { content: typeof result === "string" ? result : JSON.stringify(result) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload));
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await runTypesafeRun({ run, fetchSourceImpl, provider: { tabId: 7, endpoint: url, apiKey: "test", model: "jev", goal: "Fill the form", sendScreenshots: screenshots,
      textModel: { baseUrl: url, model: "planner", apiKey: "test" } },
      toolBridge: { async call(name, args) {
        const hooked = await bridgeHook?.(name, args, state);
        if (hooked) return hooked;
        if (name === "page_snapshot") { snapshots.push(structuredClone(current)); return { result: { content: [{ type: "text", text: JSON.stringify(current) }] } }; }
        if (args.action === "screenshot") return { result: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] } };
        actions.push({ name, args }); await mutate?.(name, args, state);
        return { result: { content: [{ type: "text", text: "ok" }] } };
      } }, coerceArgs: (args) => args, canUseTool: async (name, args) => {
        const verdict = await gate(name, args, state);
        return verdict.behavior === "allow" ? actualGate(name, args) : verdict;
      }, limits: { maxRecoveries: 0, ...limits }, sleep: async (ms) => { await sleepHook?.(ms, state); } });
    return { result, ...state, plans, decisions, snapshots };
  } finally { run.stop("test_cleanup"); await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); }
}

test("a delayed search response settles before another decision can resubmit", async () => {
  let waits = 0;
  const h = await drive({
    choose: ({ index, state }) => {
      if (index) assert.equal(state.page.text, "Search results ready");
      return { operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) };
    },
    sleepHook: (ms, s) => { assert.equal(ms, 200); if (++waits === 3) s.page.text = "Search results ready"; }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 1); assert.equal(waits, 5);
});

test("executed steps carry bounded before/after evidence and real artifact references without image bytes", async () => {
  let captures = 0;
  const h = await drive({ screenshots: true,
    choose: ({ index }) => ({ operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    mutate: (name, args, s) => { s.page.text = "Results ready"; s.page.docNonce = "results"; },
    bridgeHook: (name, args) => {
      if (args.action !== "screenshot") return;
      return { result: { content: [{ type: "text", text: `Successfully captured screenshot (800x600, jpeg) - ID: screenshot_${++captures}` },
        { type: "image", data: "PRIVATE_IMAGE_BYTES", mimeType: "image/jpeg" }] } };
    }
  });
  const step = h.events.find((event) => event.type === "jev_step" && event.dispatched);
  assert.equal(step.evidence.before.text, "Form"); assert.equal(step.evidence.after.text, "Results ready");
  assert.equal(step.evidence.before.screenshot.artifactId, "screenshot_2"); assert.equal(step.evidence.after.screenshot.artifactId, "screenshot_3");
  assert.equal(step.evidence.changes.documentChanged, true);
  assert(!JSON.stringify(h.events).includes("PRIVATE_IMAGE_BYTES"));
  assert(h.events.filter((event) => event.type === "jev_step" && !event.dispatched).every((event) => event.dispatched === false));
  const phases = h.events.filter((event) => event.type === "jev_phase");
  for (const phase of ["observing", "planning", "deciding", "executing", "waiting", "verifying"]) assert(phases.some((event) => event.phase === phase));
  assert.equal(phases.find((event) => event.phase === "executing").step, 1);
});

test("screenshot opt-out retains text evidence without any capture", async () => {
  let captures = 0;
  const h = await drive({ choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    bridgeHook: (name, args) => { if (args.action === "screenshot") captures++; }
  });
  const step = h.events.find((event) => event.dispatched);
  assert.equal(captures, 0); assert.equal(step.evidence.before.screenshot.status, "disabled");
  assert.equal(step.evidence.after.screenshot.status, "disabled");
  assert(h.events.some((event) => event.type === "jev_phase" && event.phase === "reporting"));
});

test("a recycled ref after navigation cannot become the original click's after-target", async () => {
  const h = await drive({
    choose: ({ index }) => ({ operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    mutate: (name, args, s) => { s.page.docNonce = "results-doc"; s.page.elements[1].label = "Download Excel"; s.page.text = "Search results"; }
  });
  const step = h.events.find((event) => event.type === "jev_step" && event.dispatched);
  assert.equal(step.evidence.before.target.label, "Continue");
  assert.equal(step.evidence.after.target, null);
  assert.equal(step.evidence.changes.documentChanged, true);
  assert.equal(step.evidence.after.text, "Search results");
  assert.equal(h.result.doneVerified, true);
});

for (const failure of ["throw", "unknown", "blank"]) test(`failed after-capture never retries the mutation (${failure})`, async () => {
  let captures = 0;
  const h = await drive({ screenshots: true, choose: ({ index }) => ({ operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    bridgeHook: (name, args) => {
      if (args.action !== "screenshot" || ++captures !== 3) return;
      if (failure === "throw") throw new Error("capture failed");
      if (failure === "unknown") return { resultUnknown: true };
      return { result: { content: [{ type: "text", text: "Successfully captured screenshot (800x600, jpeg) - ID: screenshot_3 — WARNING: this capture came back essentially blank" },
        { type: "image", data: "blank", mimeType: "image/jpeg" }] } };
    }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 1);
  const shot = h.events.find((event) => event.dispatched).evidence.after.screenshot;
  assert.equal(shot.status, "unavailable"); assert(!shot.artifactId);
});

test("a document replacement during pre-action capture cannot authorize a stale click", async () => {
  let captures = 0;
  const h = await drive({ screenshots: true,
    choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    bridgeHook: (name, args, s) => { if (args.action === "screenshot" && ++captures === 2) s.page.docNonce = "replacement"; }
  });
  assert.equal(h.actions.length, 0); assert(h.events.some((event) => event.skippedReason === "stale_observation"));
  assert(h.events.some((event) => event.staleReason === "stale_capture"));
});

test("a click dispatches when the page churns elsewhere during evidence capture", async () => {
  let captures = 0;
  const h = await drive({ screenshots: true,
    choose: ({ index }) => ({ operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    bridgeHook: (name, args, s) => {
      // Only the target's own row must survive unchanged: a rotating ad, a
      // lazy-loaded widget, or a refreshed counter elsewhere on the page
      // (the incident's measured 661-to-660 element drift) must not veto a
      // click on a target the capture never touched.
      if (args.action === "screenshot" && ++captures === 2) {
        s.page.elements = [...s.page.elements, { ref: "ad", label: "Sponsored", role: "generic", tag: "div" }];
      }
    }
  });
  assert.equal(h.actions.length, 1);
  assert(!h.events.some((event) => event.skippedReason === "stale_observation"));
  const step = h.events.find((event) => event.type === "jev_step" && event.dispatched);
  assert.equal(step.evidence.before.screenshot.status, "unavailable");
  assert.equal(step.evidence.before.screenshot.reason, "stale_capture");
});

test("a click is still skipped stale when the target's own state changes during evidence capture", async () => {
  let captures = 0;
  const h = await drive({ screenshots: true,
    choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    bridgeHook: (name, args, s) => {
      if (args.action === "screenshot" && ++captures === 2) {
        s.page.elements = s.page.elements.map((el) => (el.ref === "go" ? { ...el, label: "Continue now" } : el));
      }
    }
  });
  assert.equal(h.actions.length, 0);
  assert(h.events.some((event) => event.skippedReason === "stale_observation" && event.staleReason === "stale_capture"));
});

test("a targetless action is still skipped stale when the page churns elsewhere during evidence capture", async () => {
  let captures = 0;
  const h = await drive({ screenshots: true,
    choose: ({ index }) => ({ operation: index ? "ASK" : "WAIT" }),
    bridgeHook: (name, args, s) => {
      // Unlike a click or a hover, a WAIT has no target row of its own to
      // anchor on: its surroundings are the only thing the post-capture
      // re-read can judge, so a page that gains an element here — the same
      // kind of unrelated churn a targeted dispatch now tolerates — must
      // still refuse this dispatch.
      if (args.action === "screenshot" && ++captures === 2) {
        s.page.elements = [...s.page.elements, { ref: "ad", label: "Sponsored", role: "generic", tag: "div" }];
      }
    }
  });
  assert.equal(h.actions.length, 0);
  assert(h.events.some((event) => event.skippedReason === "stale_observation" && event.staleReason === "stale_capture"));
});

test("unknown mutation outcome keeps before evidence and does not read or retry after uncertainty", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK", ref: "go" }),
    bridgeHook: (name, args) => args.action === "left_click" ? { resultUnknown: true } : undefined });
  const step = h.events.find((event) => event.dispatched);
  assert.equal(h.result.reason, "tool_result_unknown"); assert.equal(step.evidence.after.unavailableReason, "result_unknown");
  assert.equal(h.decisions, 1); assert.equal(step.evidence.before.text, "Form");
});

test("a popup obstruction is removed before the underlying search can run", async () => {
  const initial = page(); initial.elements[1].disabled = true; initial.elements.push(button("close", "Close popup")); initial.text = "Popup blocks the form";
  const h = await drive({ initial,
    choose: ({ index, choices }) => {
      if (index === 0) assert(!choices.some((choice) => choice.ref === "go"));
      return [{ operation: "CLICK", ref: "close" }, { operation: "CLICK", ref: "go" }, { operation: "DONE" }][index];
    },
    mutate: (name, args, s) => {
      if (args.ref === "close") { s.page.elements.pop(); s.page.elements[1].disabled = false; s.page.text = "Search form"; }
      else s.page.text = "Result A";
    },
    check: (s) => ({ achieved: s.page.text === "Result A", report: "Result A" })
  });
  assert.deepEqual(h.actions.map((action) => action.args.ref), ["close", "go"]); assert.equal(h.result.doneVerified, true);
});

test("empty search results are reported as empty without invented records", async () => {
  const h = await drive({ choose: ({ index }) => ({ operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    mutate: (name, args, s) => { s.page.text = "0 results. No matching tenders."; },
    check: (s) => ({ achieved: s.page.text.startsWith("0 results"), report: "No matching tenders were found." })
  });
  assert.equal(h.actions.length, 1); assert.equal(h.result.doneVerified, true);
  assert.equal(h.events.find((event) => event.type === "jev_result").text, "No matching tenders were found.");
});

test("an enabled search intercepted by an overlay recovers by closing it before retrying", async () => {
  const initial = page();
  initial.text = "A popup covers the enabled search form";
  initial.elements.push(button("close", "Close popup"));
  let verificationCalls = 0;
  const h = await drive({ initial,
    choose: ({ index, choices, body }) => {
      if (index === 0) assert(choices.some((choice) => choice.operation === "CLICK" && choice.ref === "go"), "covered control remains enabled and offered");
      if (index === 1) assert.equal(body.state.recent_actions.at(-1).outcome, "failed", "next decision sees the failed attempt, not a claimed success");
      return [{ operation: "CLICK", ref: "go" }, { operation: "CLICK", ref: "close" },
        { operation: "CLICK", ref: "go" }, { operation: "DONE" }][index];
    },
    bridgeHook: (name, args, s) => {
      if (args.action === "left_click" && args.ref === "go" && s.page.elements.some((element) => element.ref === "close")) {
        s.actions.push({ name, args });
        return { result: { isError: true, content: [{ type: "text", text: "Target is obstructed by an overlay; page unchanged." }] } };
      }
    },
    mutate: (name, args, s) => {
      if (args.ref === "close") { s.page.elements = s.page.elements.filter((element) => element.ref !== "close"); s.page.text = "Search form ready"; }
      else s.page.text = "Search result: Tender A";
    },
    check: (s) => {
      verificationCalls++;
      assert.equal(s.actions.length, 3, "completion is checked only after the unobstructed retry");
      return { achieved: s.page.text === "Search result: Tender A", report: s.page.text };
    }
  });
  assert.deepEqual(h.actions.map((action) => action.args.ref), ["go", "close", "go"]);
  const steps = h.events.filter((event) => event.type === "jev_step" && event.dispatched);
  assert.equal(steps.length, 3); assert.equal(steps[0].pageChanged, false);
  assert.equal(steps[0].actionOutcome, "failed"); assert.equal(steps[0].actionError.code, "TARGET_OBSTRUCTED");
  assert.equal(steps[1].actionOutcome, "succeeded"); assert.equal(steps[2].actionOutcome, "succeeded");
  assert.equal(steps[0].evidence.before.text, steps[0].evidence.after.text);
  assert.equal(steps[1].pageChanged, true); assert.equal(steps[2].evidence.after.text, "Search result: Tender A");
  assert.equal(verificationCalls, 1); assert.equal(h.plans, 1); assert.equal(h.decisions, 4);
  assert.equal(h.result.doneVerified, true);
  assert.equal(h.events.filter((event) => event.type === "jev_result").length, 1);
});

test("a failed form input is counted as attempted and reports a safe error without echoing its value", async () => {
  const privateValue = "private-input-never-in-events";
  const h = await drive({ plan: () => prepare([{ element: "1", value: privateValue }]),
    choose: ({ index, body }) => {
      if (index) assert.equal(body.state.recent_actions.at(-1).outcome, "failed");
      return { operation: index ? "ASK" : "TYPE_TEXT" };
    },
    bridgeHook: (name, args, s) => {
      if (name !== "form_input") return;
      s.actions.push({ name, args });
      return { result: { isError: true, content: [{ type: "text", text: `Failed to enter ${args.value}` }] } };
    }
  });
  const step = h.events.find((event) => event.type === "jev_step" && event.dispatched);
  assert.equal(step.actionOutcome, "failed"); assert.equal(step.actionError.code, "TOOL_ERROR");
  assert.equal(h.actions.length, 1); assert.equal(h.result.reason, "needs_operator");
  assert(!JSON.stringify(h.events).includes(privateValue));
});

test("changing a query and submitting again uses the new results rather than the first answer", async () => {
  const initial = page(); initial.elements[1].submit = submitState("");
  const h = await drive({ initial, plan: ({ index }) => prepare([{ element: "1", value: index ? "printers" : "computers" }]),
    choose: ({ index }) => [{ operation: "TYPE_TEXT" }, { operation: "CLICK", ref: "go" }, { operation: "REPLAN" },
      { operation: "TYPE_TEXT" }, { operation: "CLICK", ref: "go" }, { operation: "DONE" }][index],
    mutate: (name, args, s) => {
      if (name === "form_input") { s.page.elements[0].value = args.value; s.page.elements[1].submit = submitState(args.value); }
      else { s.page.text = `Results for ${s.page.elements[0].value}`; s.page.docNonce += "next"; }
    }, check: (s) => ({ achieved: s.page.text === "Results for printers", report: s.page.text })
  });
  assert.equal(h.actions.length, 4); assert.equal(h.result.doneVerified, true);
  assert.equal(h.events.find((event) => event.type === "jev_result").text, "Results for printers");
});

const submitState = (value = "computers", pageNumber = "1") => ({
  scope: "observed_form_state", incomplete: true,
  action: "https://example.com/search", method: "get",
  submitter: { name: "submit", type: "submit", value: "Search" },
  fields: [{ name: "query", type: "text", value }, { name: "page", type: "text", value: pageNumber }]
});

test("same visible submission across document reload verifies results before a second click", async () => {
  const initial = page(); initial.elements[1].submit = submitState();
  let verified = 0;
  const h = await drive({ initial,
    choose: ({ state }) => ({ operation: "CLICK", ref: state.page.elements[1].ref }),
    mutate: (name, args, s) => { s.page.docNonce = "results-doc"; s.page.elements[1].ref = "new-search-ref"; s.page.text = "815 results: Tender A, Tender B, Tender C"; },
    check: (s) => { verified++; assert(s.page.text.includes("815 results")); return { achieved: true, report: "Tender A, Tender B, Tender C" }; }
  });
  assert.equal(h.actions.length, 1); assert.equal(verified, 1); assert.equal(h.result.doneVerified, true);
  assert(h.events.some((event) => event.verificationTrigger === "repeated_submission"));
});

test("changed visible form state including pagination permits the next submission", async () => {
  const initial = page(); initial.elements[1].submit = submitState();
  const h = await drive({ initial,
    choose: ({ index }) => ({ operation: index < 2 ? "CLICK" : "DONE", ...(index < 2 ? { ref: "go" } : {}) }),
    mutate: (name, args, s) => { s.page.docNonce = `doc${s.actions.length + 1}`; s.page.text = `Result page ${s.actions.length}`; s.page.elements[1].submit = submitState("computers", String(s.actions.length + 1)); },
    check: (s) => ({ achieved: s.page.text === "Result page 2", report: s.page.text })
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 2);
  assert.equal(h.events.find((event) => event.type === "jev_result").text, "Result page 2");
  assert(!h.events.some((event) => event.verificationTrigger === "repeated_submission"));
});

test("a meaningful intervening navigation permits revisiting and submitting the same form", async () => {
  const initial = page(); initial.elements[1].submit = submitState(); initial.elements.push(button("back", "Return to form"));
  const h = await drive({ initial,
    choose: ({ index }) => [{ operation: "CLICK", ref: "go" }, { operation: "CLICK", ref: "back" }, { operation: "CLICK", ref: "go" }, { operation: "DONE" }][index],
    mutate: (name, args, s) => { s.page.docNonce = `doc${s.actions.length + 1}`; s.page.text = `Page state ${s.actions.length}`; }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 3);
  assert(!h.events.some((event) => event.verificationTrigger === "repeated_submission"));
});

test("a rejected repeated-submit checkpoint permits a bounded retry and never claims success", async () => {
  const initial = page(); initial.elements[1].submit = submitState();
  const h = await drive({ initial, choose: () => ({ operation: "CLICK", ref: "go" }),
    mutate: (name, args, s) => { s.page.docNonce = `doc${s.actions.length + 1}`; },
    check: () => ({ achieved: false }), limits: { maxVerificationRejections: 2 }
  });
  assert.equal(h.result.reason, "completion_unverified"); assert.equal(h.actions.length, 2); assert.equal(h.plans, 2);
});

test("approval refresh rejects a changed submission even when the submit button is unchanged", async () => {
  const initial = page(); initial.elements[1].submit = submitState();
  const h = await drive({ initial, choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    gate: (name, args, s) => { s.page.elements[1].submit = submitState("changed query"); return { behavior: "allow" }; }
  });
  assert.equal(h.actions.length, 0); assert(h.events.some((event) => event.skippedReason === "stale_observation"));
});

test("a target whose own label changes before dispatch is recorded as target_changed", async () => {
  const h = await drive({
    choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    gate: (name, args, s) => { s.page.elements[1].label = "Submit now"; return { behavior: "allow" }; }
  });
  assert.equal(h.actions.length, 0);
  assert(h.events.some((event) => event.staleReason === "target_changed"));
});

test("replanning cannot erase unchanged-click evidence", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK", ref: "go" }), limits: { maxRecoveries: 2 } });
  assert.equal(h.result.reason, "no_progress"); assert.equal(h.actions.length, 1); assert.equal(h.plans, 3);
});

test("a transient toast does not hide the later navigation during click settle", async () => {
  let waits = 0;
  const h = await drive({
    choose: ({ index, state }) => {
      if (index) assert.equal(state.page.docNonce, "search-results");
      return { operation: index ? "DONE" : "CLICK", ...(!index ? { ref: "go" } : {}) };
    },
    mutate: (name, args, s) => { s.page.text = "Submitting..."; },
    sleepHook: (ms, s) => { if (++waits === 2) { s.page.docNonce = "search-results"; s.page.text = "Results"; } }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 1);
});

test("completion and accumulated observations carry actual href evidence", async () => {
  const initial = page();
  initial.elements.push({ ref: "result", role: "link", label: "Tender", href: "https://example.com/real-slug-918.html" });
  const h = await drive({ initial });
  const context = content(h.bodies.find((body) => body.messages?.[0]?.content === COMPLETION_CHECK));
  assert.deepEqual(context.page.links, [{ url: initial.elements[2].href, label: "Tender" }]);
  assert.deepEqual(context.observed_pages[0].links, context.page.links);
});

test("a failed model-proposed source cannot authorize an invented link in the final report", async () => {
  const invented = "https://example.com/invented-tender-IB999.html";
  const actual = "https://example.com/actual-tender-full-title-718.html";
  const initial = page();
  initial.elements.push({ ref: "result", role: "link", label: "Actual tender", href: actual });
  const fetched = [];
  let reportCalls = 0;
  const h = await drive({ initial,
    check: () => ({ achieved: true, sources: [invented] }),
    fetchSourceImpl: async ({ url }) => { fetched.push(url); throw new Error("Source unavailable"); },
    report: () => {
      reportCalls++;
      return { report: reportCalls === 1 ? `[Tender](${invented})` : `[Actual tender](${actual}). The additional source could not be read.` };
    }
  });
  assert.deepEqual(fetched, [invented]);
  assert.equal(reportCalls, 2, "real helper rejects unread-source URL and requests one grounded correction");
  assert.equal(h.result.outcome, "done");
  assert.equal(h.result.doneVerified, true);
  const reports = h.events.filter((event) => event.type === "jev_result");
  assert.equal(reports.length, 1);
  assert(reports[0].text.includes(actual));
  assert(!reports[0].text.includes(invented));
});

test("cancellation during click settle prevents further observations and decisions", async () => {
  let waits = 0;
  const h = await drive({ choose: () => ({ operation: "CLICK", ref: "go" }),
    sleepHook: (ms, s) => { waits++; s.run.stop("during_settle"); } });
  assert.equal(h.result.outcome, "stopped"); assert.equal(h.decisions, 1); assert.equal(waits, 1);
});

for (const goalDone of [false, true]) test(`completion verification is independent of action confidence (${goalDone ? "monitor" : "DONE"})`, async () => {
  const h = await drive({ choose: () => ({ operation: goalDone ? "CLICK" : "DONE", goalDone, confidence: .01 }) });
  assert.equal(h.result.outcome, "done"); assert.equal(h.result.doneVerified, true); assert.equal(h.actions.length, 0);
});

test("uncertain DONE still cannot bypass a rejecting completion verifier", async () => {
  const h = await drive({ choose: () => ({ operation: "DONE", confidence: .01 }),
    check: () => ({ achieved: false }), limits: { maxVerificationRejections: 1 } });
  assert.equal(h.result.reason, "completion_unverified"); assert.equal(h.actions.length, 0);
});

test("one preparation supports several Jev actions and hover reveals a fresh candidate", async () => {
  const h = await drive({ plan: () => prepare([{ element: "1", value: "Ada" }]),
    choose: ({ index, choices }) => {
      if (index === 2) assert(choices.some((c) => c.ref === "menu"), "fresh hover target offered");
      return [{ operation: "TYPE_TEXT" }, { operation: "HOVER", ref: "go" }, { operation: "CLICK", ref: "menu" }, { operation: "DONE" }][index];
    }, mutate: (name, args, s) => {
      if (name === "form_input") s.page.elements[0].value = args.value;
      if (args.action === "hover") s.page.elements.push(button("menu", "Confirm"));
      if (args.action === "left_click") s.page.text = "Confirmation";
    } });
  assert.equal(h.result.outcome, "done"); assert.equal(h.result.doneVerified, true);
  assert.equal(h.actions.length, 3); assert.equal(h.plans, 1); assert.equal(h.decisions, 4);
  assert(h.events.filter((e) => e.type === "jev_step").every((e) => e.decisionSource === "jev"));
  assert(!JSON.stringify(h.events.filter((e) => e.type === "jev_step")).includes("Ada"));
});

test("new field requires replan; consumed content never becomes an offered repeat", async () => {
  const h = await drive({ plan: ({ index }) => prepare([{ element: index ? "3" : "1", value: index ? "London" : "Ada" }]),
    choose: ({ index, choices }) => {
      if (index === 1) assert(!choices.some((c) => c.operation === "TYPE_TEXT"), "consumed or unprepared content absent");
      return [{ operation: "TYPE_TEXT" }, { operation: "REPLAN" }, { operation: "TYPE_TEXT", ref: "city" }, { operation: "DONE" }][index];
    }, mutate: (name, args, s) => { s.page.elements.find((el) => el.ref === args.ref).value = args.value;
      if (args.ref === "field") s.page.elements.push(field("city", "City")); } });
  assert.equal(h.result.outcome, "done"); assert.equal(h.plans, 2);
  assert.deepEqual(h.actions.map((a) => [a.args.ref, a.args.value]), [["field", "Ada"], ["city", "London"]]);
});

test("new-element watermark survives host rereads until the next Jev decision only", async () => {
  const h = await drive({
    bridgeHook: (name, args, s) => {
      if (name !== "page_snapshot") return;
      const observed = structuredClone(s.page);
      for (const element of s.page.elements) element.isNew = false;
      return { result: { content: [{ type: "text", text: JSON.stringify(observed) }] } };
    },
    choose: ({ index, body }) => {
      const menu = body.state.elements.find((el) => el.ref === "menu");
      if (index === 1) assert.equal(menu?.new, true, "post-hover evidence retained through top-of-loop read");
      if (index === 2) assert.equal(menu?.new, false, "one decision consumes the hint");
      return { operation: index === 0 ? "HOVER" : index === 1 ? "WAIT" : "DONE", ...(index === 0 ? { ref: "go" } : {}) };
    }, mutate: (name, args, s) => { if (args.action === "hover") s.page.elements.push({ ...button("menu", "Menu item"), isNew: true }); }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 2);
});

test("new-element hints never cross document replacement with reused refs", async () => {
  let afterHoverReads = 0;
  const h = await drive({
    bridgeHook: (name, args, s) => {
      if (name !== "page_snapshot" || !s.page.elements.some((el) => el.ref === "menu")) return;
      afterHoverReads++;
      if (afterHoverReads >= 2) { s.page.docNonce = "doc2"; s.page.elements.find((el) => el.ref === "menu").isNew = false; }
    },
    choose: ({ index, body }) => {
      if (index) assert.equal(body.state.elements.find((el) => el.ref === "menu")?.new, false);
      return { operation: index ? "DONE" : "HOVER", ...(!index ? { ref: "go" } : {}) };
    }, mutate: (name, args, s) => { if (args.action === "hover") s.page.elements.push({ ...button("menu"), isNew: true }); }
  });
  assert.equal(h.result.outcome, "done");
});

for (const change of ["value", "label", "docNonce", "readonly", "removed"]) test(`approval refresh refuses stale ${change}`, async () => {
  const h = await drive({ plan: () => prepare([{ element: "1", value: "Ada" }]), choose: ({ index }) => ({ operation: index ? "ASK" : "TYPE_TEXT" }),
    gate: (name, args, s) => { if (change === "docNonce") s.page.docNonce = "replacement";
      else if (change === "removed") s.page.elements.shift(); else s.page.elements[0][change] = change === "readonly" ? true : "changed";
      return { behavior: "allow" }; } });
  assert.equal(h.actions.length, 0); assert.equal(h.result.reason, "needs_operator");
  assert(h.events.some((e) => e.skippedReason === "stale_observation"));
});

test("document identity missing refuses required field preparation", async () => {
  const initial = page(); delete initial.docNonce;
  const h = await drive({ initial, plan: () => prepare([{ element: "1", value: "Ada" }]) });
  assert.equal(h.result.reason, "preparation_failed"); assert.equal(h.decisions, 0); assert.equal(h.actions.length, 0);
});

test("document identity missing cannot authorize any target mutation", async () => {
  const initial = page(); delete initial.docNonce;
  const h = await drive({ initial, choose: () => ({ operation: "HOVER" }) });
  assert.equal(h.result.reason, "no_progress"); assert.equal(h.actions.length, 0);
  assert(h.events.some((e) => e.skippedReason === "stale_observation"));
});

test("completion monitor preempts mutation and unavailable check blocks", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK", goalDone: true }), check: () => "invalid" });
  assert.equal(h.result.reason, "completion_unverified"); assert.equal(h.result.outcome, "blocked"); assert.equal(h.actions.length, 0);
});

test("an uncertain action with positive completion monitor requires a successful verifier", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK", goalDone: true, confidence: .1 }),
    check: () => ({ achieved: false }), limits: { maxVerificationRejections: 1 } });
  assert.equal(h.result.reason, "completion_unverified"); assert.equal(h.actions.length, 0);
  assert(h.bodies.some((b) => b.messages?.[0]?.content === COMPLETION_CHECK));
});

test("an explicitly selected REPLAN without progress is bounded by the replan budget", async () => {
  const h = await drive({ choose: () => ({ operation: "REPLAN" }), limits: { maxReplansWithoutProgress: 2 } });
  assert.equal(h.result.reason, "replan_limit"); assert.equal(h.plans, 3); assert.equal(h.actions.length, 0);
});

test("a stuck monitor that never stops firing still ends blocked once its one permitted action changes nothing", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK", ref: "go", stuck: true }), limits: { maxReplansWithoutProgress: 2 } });
  // The first stuck judgment buys one revised plan; the second lets the same
  // CLICK it keeps selecting actually run once. That attempt changes nothing,
  // so the existing repeated-no-change and no-progress guards — not another
  // identical planning consultation — are what end the run.
  assert.equal(h.result.outcome, "blocked"); assert.equal(h.result.reason, "no_progress");
  assert.equal(h.plans, 3); assert.equal(h.actions.length, 1);
});

test("a wrong-page run whose every decision is stuck reaches the site the goal names instead of spending its replan budget", async () => {
  const target = "https://example.com/target-site";
  const h = await drive({
    plan: () => ({ memory, textValues: [], navigation: [{ url: target, purpose: "Reach the site the goal names" }] }),
    choose: ({ state }) => (state.page.url === target ? { operation: "DONE" } : { operation: "NAVIGATE", stuck: true }),
    mutate: (name, args, s) => { if (name === "navigate") { s.page.url = args.url; s.page.docNonce = "target-doc"; s.page.text = "Target site"; } },
    check: (s) => ({ achieved: s.page.url === target, report: "Reached the target site" }),
    limits: { maxReplansWithoutProgress: 2 }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.result.doneVerified, true);
  const navigations = h.actions.filter((a) => a.name === "navigate");
  assert.equal(navigations.length, 1); assert.equal(navigations[0].args.url, target);
  const step = h.events.find((e) => e.type === "jev_step" && e.tool === "navigate");
  assert.equal(step.pageChanged, true); assert.equal(step.evidence.after.url, target);
});

test("a prepared navigation dispatches even though the page moved before dispatch", async () => {
  const target = "https://example.com/target-site";
  const h = await drive({
    plan: () => ({ memory, textValues: [], navigation: [{ url: target, purpose: "Reach the required site" }] }),
    choose: ({ index }) => (index ? { operation: "DONE" } : { operation: "NAVIGATE" }),
    gate: (name, args, s) => { if (name === "navigate") s.page.url = "https://example.com/redirected"; return { behavior: "allow" }; },
    mutate: (name, args, s) => { if (name === "navigate") { s.page.url = args.url; s.page.docNonce = "target-doc"; } }
  });
  assert.equal(h.actions.length, 1); assert.equal(h.actions[0].name, "navigate");
  assert(!h.events.some((e) => e.skippedReason === "stale_observation"));
});

test("a targeted CLICK in the same page-moved situation still skips as a stale observation", async () => {
  const h = await drive({
    choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    gate: (name, args, s) => { s.page.url = "https://example.com/redirected"; return { behavior: "allow" }; }
  });
  assert.equal(h.actions.length, 0);
  assert(h.events.some((e) => e.skippedReason === "stale_observation"));
  assert(h.events.some((e) => e.staleReason === "url_changed"));
});

// Companion of "a document replacement during pre-action capture cannot
// authorize a stale click" above: the same mid-capture page movement that
// still cancels a CLICK only degrades a NAVIGATE's recorded evidence.
test("a page that moves during the pre-dispatch capture degrades the navigation's evidence instead of cancelling it", async () => {
  const target = "https://example.com/target-site";
  let captures = 0;
  const h = await drive({ screenshots: true,
    plan: () => ({ memory, textValues: [], navigation: [{ url: target, purpose: "Reach the required site" }] }),
    choose: ({ index }) => (index ? { operation: "DONE" } : { operation: "NAVIGATE" }),
    bridgeHook: (name, args, s) => { if (args.action === "screenshot" && ++captures === 2) s.page.docNonce = "replacement"; },
    mutate: (name, args, s) => { if (name === "navigate") { s.page.url = args.url; s.page.docNonce = "target-doc"; } }
  });
  assert.equal(h.actions.filter((a) => a.name === "navigate").length, 1);
  const step = h.events.find((e) => e.type === "jev_step" && e.tool === "navigate");
  assert.equal(step.evidence.before.screenshot.reason, "stale_capture");
});

test("WAIT remains bounded by the no-progress guard", async () => {
  const h = await drive({ choose: () => ({ operation: "WAIT" }) });
  assert.equal(h.result.reason, "no_progress"); assert.equal(h.actions.length, 3);
});

test("stop during decision discards mutation and emits a stopped record", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK" }), decisionHook: (s) => s.run.stop("operator") });
  assert.equal(h.result.outcome, "stopped"); assert.equal(h.actions.length, 0);
  assert(h.events.some((e) => e.type === "jev_step" && e.skippedReason === "stopped"));
});

test("stop during approval prevents post-stop observation and dispatch", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK" }), gate: (name, args, s) => { s.run.stop("operator"); return { behavior: "allow" }; } });
  assert.equal(h.result.outcome, "stopped"); assert.equal(h.actions.length, 0); assert.equal(h.snapshots.length, 2);
});

test("malformed Jev response never dispatches", async () => {
  const h = await drive({ choose: () => ({ operation: "CLICK", invalid: true }) });
  assert.equal(h.result.reason, "invalid_decision"); assert.equal(h.actions.length, 0);
});

test("model latency cannot authorize a target from a replaced document", async () => {
  const h = await drive({ choose: ({ index }) => ({ operation: index ? "ASK" : "HOVER" }),
    decisionHook: (s, body, index) => { if (!index) s.page.docNonce = "doc2"; } });
  assert.equal(h.result.reason, "needs_operator"); assert.equal(h.actions.length, 0);
  assert(h.events.some((e) => e.skippedReason === "stale_observation"));
  assert(h.events.some((e) => e.staleReason === "document_changed"));
});

test("consumed text is not reused when the site clears the field again", async () => {
  const h = await drive({ plan: () => prepare([{ element: "1", value: "Ada" }]),
    choose: ({ index, choices }) => {
      if (index) assert(!choices.some((c) => c.operation === "TYPE_TEXT"));
      return { operation: index ? "DONE" : "TYPE_TEXT" };
    }, mutate: (name, args, s) => { s.page.text = "Field submitted and cleared"; } });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 1);
});

test("selection keeps the exact offered option value and control identity", async () => {
  const initial = page(); initial.elements = [{ ref: "choice", role: "combobox", tag: "select", label: "Country", value: "us", options: [
    { value: "us", label: "USA", selected: true }, { value: "gb", label: "United Kingdom", selected: false }
  ] }];
  const h = await drive({ initial, choose: ({ index }) => ({ operation: index ? "DONE" : "SELECT" }),
    mutate: (name, args, s) => { s.page.elements[0].value = args.value; } });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions[0].args.value, "gb");
  const step = h.events.find((e) => e.type === "jev_step");
  assert.equal(step.target.label, "United Kingdom"); assert.equal(step.target.elementLabel, "Country");
});

test("rejected completion reads the page afresh before deciding again", async () => {
  let checks = 0;
  const h = await drive({ check: (s) => { checks++; if (checks === 1) { s.page.text = "Updated after check"; return { achieved: false, memory }; }
    return { achieved: true, report: "Confirmed" }; }, choose: ({ index, body }) => {
      if (index) assert.equal(body.state.page.text, "Updated after check"); return { operation: "DONE" };
    } });
  assert.equal(h.result.outcome, "done"); assert.equal(checks, 2); assert.equal(h.actions.length, 0);
});

test("lost mutation result stops without a retry", async () => {
  let writes = 0;
  const h = await drive({ plan: () => prepare([{ element: "1", value: "Ada" }]), choose: () => ({ operation: "TYPE_TEXT" }),
    bridgeHook: (name) => { if (name === "form_input") { writes++; return { resultUnknown: true }; } } });
  assert.equal(h.result.reason, "tool_result_unknown"); assert.equal(writes, 1); assert.equal(h.decisions, 1);
});

test("completion guidance invalidates unused content from the previous plan revision", async () => {
  const h = await drive({ plan: () => prepare([{ element: "1", value: "old-value" }]),
    choose: ({ index, choices }) => { if (index) assert(!choices.some((c) => c.operation === "TYPE_TEXT"), "old plan content invalidated");
      return { operation: index ? "ASK" : "DONE" }; },
    check: () => ({ achieved: false, memory: { ...memory, plan: "Do not enter the old value; ask the operator" } }) });
  assert.equal(h.result.reason, "needs_operator"); assert.equal(h.actions.length, 0);
  const steps = h.events.filter((e) => e.type === "jev_step");
  assert.equal(steps[1].planRevision, steps[0].planRevision + 1);
});

test("required planning fails instead of falling back to step reasoning", async () => {
  const h = await drive({ plan: () => "not a plan" });
  assert.equal(h.result.reason, "preparation_failed"); assert.equal(h.decisions, 0); assert.equal(h.actions.length, 0);
  assert.equal(h.plans, 2, "one preparation with its single corrective retry");
  assert.equal(h.bodies.filter((b) => b.messages?.[0]?.content === FINAL_REPORT).length, 0, "failed planner is not called again for a report");
});

test("ASK stops without mutation and exposes operator-needed metadata", async () => {
  const h = await drive({ choose: () => ({ operation: "ASK" }) });
  assert.equal(h.result.reason, "needs_operator"); assert.equal(h.result.needsOperator, true);
  assert.equal(h.actions.length, 0);
  assert.equal(h.events.find((e) => e.type === "jev_end").needsOperator, true);
});

test("fresh screenshots go only to planning and verification", async () => {
  const h = await drive({ screenshots: true, choose: ({ index }) => ({ operation: index ? "DONE" : "HOVER" }),
    mutate: (name, args, s) => { s.page.text = "Changed"; } });
  assert.equal(h.result.outcome, "done");
  const llm = h.bodies.filter((b) => b.messages);
  assert.equal(llm.length, 2); assert(llm.every((b) => Array.isArray(b.messages[1].content)));
  assert(h.bodies.filter((b) => b.questions).every((b) => !JSON.stringify(b).includes("aGk=")));
});

test("visual notes are scoped to the preparation observation", async () => {
  const h = await drive({ plan: () => ({ ...prepare(), visualNotes: "Closed menu visible" }),
    choose: ({ index, body }) => {
      if (!index) assert.equal(body.state.visual_notes, "Closed menu visible");
      else assert.equal(body.state.visual_notes, undefined, "old visual evidence removed after state change");
      return { operation: index ? "DONE" : "HOVER" };
    }, mutate: (name, args, s) => { s.page.text = "Menu opened"; }
  });
  assert.equal(h.result.outcome, "done");
});

for (const replacement of [false, true]) test(`fresh decision clears obsolete ineffective-click guard (${replacement ? "replacement document" : "delayed progress"})`, async () => {
  let readsAfterFirstClick = 0;
  const h = await drive({
    choose: ({ index }) => ({ operation: index < 2 ? "CLICK" : "DONE", ...(index < 2 ? { ref: "go" } : {}) }),
    bridgeHook: (name, args, s) => {
      if (name !== "page_snapshot" || s.actions.length !== 1) return;
      readsAfterFirstClick++;
      // First read is the unchanged post-action observation. Only the next
      // cycle sees the asynchronously completed update or document reload.
      if (readsAfterFirstClick >= 2) {
        if (replacement) s.page.docNonce = "replacement-same-url";
        else s.page.text = "First click completed asynchronously";
      }
    },
    mutate: (name, args, s) => { if (s.actions.length === 2) s.page.text = "Second click completed"; }
  });
  assert.equal(h.result.outcome, "done"); assert.equal(h.actions.length, 2);
  assert(!h.events.some((e) => e.skippedReason === "repeated_no_change"));
});

test("a targetless action underneath the page is recorded as signature_changed", async () => {
  const h = await drive({
    choose: ({ index }) => ({ operation: index ? "ASK" : "WAIT" }),
    gate: (name, args, s) => { s.page.elements.push({ ref: "extra", label: "New", role: "generic", tag: "div" }); return { behavior: "allow" }; }
  });
  assert(h.events.some((event) => event.staleReason === "signature_changed"));
});

test("a prepared text value already present on the field is recorded as prepared_record_invalid", async () => {
  const h = await drive({
    plan: () => prepare([{ element: "1", value: "Alice" }]),
    choose: ({ index }) => ({ operation: index ? "ASK" : "TYPE_TEXT" }),
    // The eligibility sweep inside dispatch() invalidates a text binding once
    // the field already carries the prepared value — here simulating an
    // external change landing between the decision and its dispatch, the same
    // window every other reason code in this file exercises.
    gate: (name, args, s) => { s.page.elements[0].value = "Alice"; return { behavior: "allow" }; }
  });
  assert(h.events.some((event) => event.staleReason === "prepared_record_invalid"));
});

test("a re-read failure immediately before dispatch is recorded as reread_failed", async () => {
  let decided = false;
  const h = await drive({
    choose: ({ index }) => ({ operation: index ? "ASK" : "CLICK", ...(!index ? { ref: "go" } : {}) }),
    decisionHook: () => { decided = true; },
    // The next page_snapshot after a decision is dispatch()'s own preflight
    // re-read; answering it with a shape lacking `url`/`elements` fails
    // observe() itself, distinct from any document, URL or target change.
    bridgeHook: (name) => {
      if (name === "page_snapshot" && decided) { decided = false; return { result: { content: [{ type: "text", text: "{}" }] } }; }
    }
  });
  assert(h.events.some((event) => event.staleReason === "reread_failed"));
});

test("a denied dispatch records its host-authored refusal reason", async () => {
  const h = await drive({
    choose: () => ({ operation: "CLICK", ref: "go" }),
    gate: () => ({ behavior: "deny", message: "operator refused" })
  });
  assert.equal(h.result.outcome, "blocked"); assert.equal(h.result.reason, "action_denied");
  const step = h.events.find((event) => event.type === "jev_step" && event.skippedReason === "action_denied");
  assert.equal(step.deniedReason, "approval_gate_refused");
});

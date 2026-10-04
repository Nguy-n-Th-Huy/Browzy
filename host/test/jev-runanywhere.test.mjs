#!/usr/bin/env node
//
// The RunAnywhere Jev source (host/agent/jev/client.js's RunAnywhere section):
// the Jev decision body translated to RunAnywhere's `/v1/decisions` array
// questions, a head larger than RunAnywhere's option limit decided as a
// two-round bracket, and the answers translated back so `validateDecision`
// accepts them. Runs against an injected fetch that answers like the live
// service (response shape captured from inference.runanywhere.ai); no live
// provider is contacted.
//
// Run: node host/test/jev-runanywhere.test.mjs

import { requestDecision, RUNANYWHERE_MAX_OPTIONS, JevError } from "../agent/jev/client.js";
import { buildDecisionRequest } from "../agent/jev/questions.js";

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

/** Answers every question like Eve: a CLICK on the last element (the "Log in" button) wins. */
function fakeRunAnywhere(calls, { omit } = {}) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, request });
    const answers = {};
    for (const q of request.questions) {
      if (q.id === omit) continue;
      if (q.type === "yes_no") {
        answers[q.id] = { type: "yes_no", probabilities: { yes: 0.2, no: 0.8 }, label_mass: 1 };
        continue;
      }
      const loginRef = JSON.parse(request.input).elements.find((e) => e.label === "Log in")?.ref;
      const winner = q.options.find((o) => o.description.includes('"CLICK"') && o.description.includes(`"${loginRef}"`)) ?? q.options[0];
      const rest = (1 - 0.9) / (q.options.length - 1);
      const probabilities = Object.fromEntries(q.options.map((o) => [o.name, o === winner ? 0.9 : rest]));
      answers[q.id] = { type: "choice", probabilities, label_mass: 1, choice: winner.name };
    }
    const json = { object: "decisions", model: "eve", prompt_format_version: 3, answers, usage: { prompt_tokens: 10, total_tokens: 10, completion_tokens: 0, reasoning_tokens: 0 } };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function decisionBody(count) {
  const elements = Array.from({ length: count }, (_, i) => ({ ref: `ref_${i}`, role: "button", label: i === count - 1 ? "Log in" : `Item ${i}`, tag: "button" }));
  return buildDecisionRequest({ model: "eve", goal: "Log in", snapshot: { url: "https://example.com/", title: "Example", text: "", docNonce: "n", elements } });
}

await test("a small decision is one request with yes_no and choice questions", async () => {
  const { body, candidates } = decisionBody(3);
  const calls = [];
  const result = await requestDecision({ source: "runanywhere", endpoint: "https://ra.example/", apiKey: "ra-key", model: "eve", body, fetchImpl: fakeRunAnywhere(calls) });
  assert(calls.length === 1, `expected 1 request, got ${calls.length}`);
  assert(calls[0].url === "https://ra.example/v1/decisions", calls[0].url);
  assert(calls[0].headers.Authorization === "Bearer ra-key" || calls[0].headers.authorization === "Bearer ra-key", "Bearer key");
  const { request } = calls[0];
  assert(request.model === "eve" && typeof request.input === "string" && JSON.parse(request.input).goal === "Log in", "input carries the state");
  const byId = Object.fromEntries(request.questions.map((q) => [q.id, q]));
  assert(byId.goal_done.type === "yes_no" && byId.stuck.type === "yes_no", "yes/no heads become yes_no");
  assert(byId.action.type === "choice" && byId.action.options.every((o) => typeof o.name === "string"), "action becomes choice");
  const action = candidates.get(result.decision.actionKey);
  assert(action.operation === "CLICK" && action.target.label === "Log in", JSON.stringify(action));
  assert(result.decision.confidence === 0.9 && result.decision.goalDone === false && result.decision.stuck === false, JSON.stringify(result.decision));
});

await test("a head over the option limit is decided as a two-round bracket offering every option", async () => {
  const { body, candidates } = decisionBody(40);
  const offered = Object.keys(body.questions.action.criteria);
  assert(offered.length > RUNANYWHERE_MAX_OPTIONS, `need > ${RUNANYWHERE_MAX_OPTIONS} options, got ${offered.length}`);
  const calls = [];
  const result = await requestDecision({ source: "runanywhere", endpoint: "https://ra.example", apiKey: "k", model: "eve", body, fetchImpl: fakeRunAnywhere(calls) });
  assert(calls.length === 2, `expected 2 requests, got ${calls.length}`);
  const groups = calls[0].request.questions.filter((q) => q.id.startsWith("action__g"));
  assert(groups.length >= 2 && groups.every((q) => q.options.length >= 2 && q.options.length <= RUNANYWHERE_MAX_OPTIONS), "balanced groups within the limit");
  const asked = groups.flatMap((q) => q.options.map((o) => o.name)).sort();
  assert(JSON.stringify(asked) === JSON.stringify([...offered].sort()), "every option is offered exactly once");
  const final = calls[1].request.questions;
  assert(final.length === 1 && final[0].id === "action__final" && final[0].options.length === groups.length, "the final asks the group winners");
  const action = candidates.get(result.decision.actionKey);
  assert(action.target?.label === "Log in", JSON.stringify(action));
  const sum = Object.values(result.decision.probabilities).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1) < 1e-9 && Object.keys(result.decision.probabilities).length === offered.length, "probabilities cover every option and sum to 1");
  assert(result.usage.prompt_tokens === 20, "usage sums both rounds");
});

await test("a missing answer is INVALID_RESPONSE, never a guessed decision", async () => {
  const { body } = decisionBody(3);
  try {
    await requestDecision({ source: "runanywhere", endpoint: "https://ra.example", apiKey: "k", model: "eve", body, fetchImpl: fakeRunAnywhere([], { omit: "action" }) });
    throw new Error("expected a JevError");
  } catch (err) {
    assert(err instanceof JevError && err.code === "INVALID_RESPONSE", `${err.name}: ${err.message}`);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);

#!/usr/bin/env node
//
// The OpenAI Decisions Jev source (host/agent/jev/client.js's OpenAI section):
// URL, text and image input, head -> `choice` question translation, answers[]
// mapping back to the validated Jev shape, malformed responses, transport
// errors, and the capability probe. Runs against an injected fetch; no live
// provider is contacted and only fake keys are used.
//
// Run: node host/test/jev-openai-decisions.test.mjs

import { requestDecision, openaiDecisionsUrl, openaiRequestBody, JevError } from "../agent/jev/client.js";
import { buildDecisionRequest } from "../agent/jev/questions.js";
import { runTypesafeCapabilityTest, CAPABILITY_IMAGE } from "../agent/jev/capability.js";

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

const KEY = "test-key";

function decisionBody(count = 3) {
  const elements = Array.from({ length: count }, (_, i) => ({ ref: `ref_${i}`, role: "button", label: i === count - 1 ? "Log in" : `Item ${i}`, tag: "button" }));
  return buildDecisionRequest({ model: "gpt-6-luna", goal: "Log in", snapshot: { url: "https://example.com/", title: "Example", text: "", docNonce: "n", elements } });
}

/**
 * Answers like the Decisions API: `operation` picks CLICK, every target
 * question picks the "Log in" element, yes/no questions answer no.
 */
function fakeOpenAI(calls, { mutate, status = 200, errorBody } = {}) {
  return async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, request });
    if (status !== 200) return new Response(JSON.stringify(errorBody ?? { error: { message: "nope" } }), { status });
    const answers = request.questions.map((q) => {
      const winner = q.choices.find((c) => c.value === "CLICK") ?? q.choices.find((c) => c.description.includes('"Log in"')) ?? q.choices.find((c) => c.value === "no") ?? q.choices[0];
      const rest = 0.1 / (q.choices.length - 1);
      return {
        name: q.name,
        type: "choice",
        choice: winner.value,
        probabilities: q.choices.map((c) => ({ value: c.value, probability: c === winner ? 0.9 : rest })),
        confidence: 0.9
      };
    });
    const json = { object: "decisions", answers, usage: { input_tokens: 12, total_tokens: 12 } };
    return new Response(JSON.stringify(mutate ? mutate(json) : json), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof JevError && err.code === code, `expected ${code}, got ${err.name}: ${err.message}`);
    return err;
  }
  throw new Error(`expected JevError ${code}`);
}

const noSleep = async () => {};

await test("the URL appends /v1/decisions and tolerates a trailing slash", () => {
  assert(openaiDecisionsUrl("https://api.openai.com") === "https://api.openai.com/v1/decisions", "plain base");
  assert(openaiDecisionsUrl("https://api.openai.com/") === "https://api.openai.com/v1/decisions", "trailing slash");
  assert(openaiDecisionsUrl("https://proxy.example/oai") === "https://proxy.example/oai/v1/decisions", "custom base");
});

const operationOf = (body, key) => JSON.parse(body.questions.action.criteria[key]).operation;

await test("one request asks the action factored (operation, then element per operation) with Bearer auth and a string input", async () => {
  const { body, candidates } = decisionBody(3);
  const calls = [];
  const result = await requestDecision({ source: "openai", endpoint: "https://api.openai.com/", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI(calls), sleep: noSleep });
  assert(calls.length === 1, `expected 1 request, got ${calls.length}`);
  assert(calls[0].url === "https://api.openai.com/v1/decisions", calls[0].url);
  assert(calls[0].headers.Authorization === `Bearer ${KEY}` || calls[0].headers.authorization === `Bearer ${KEY}`, "Bearer key");
  const { request } = calls[0];
  assert(request.model === "gpt-6-luna", "model from the profile");
  assert(typeof request.input === "string" && request.input === JSON.stringify(body.state), "input is JSON.stringify(state)");
  const names = request.questions.map((q) => q.name);
  assert(JSON.stringify(names) === '["operation","target_CLICK","target_HOVER","goal_done","stuck"]', `factored questions, got ${JSON.stringify(names)}`);
  assert(request.questions.every((q) => q.type === "choice" && typeof q.instructions === "string" && q.instructions), "every question is a choice with instructions");
  const families = new Set(Object.keys(body.questions.action.criteria).map((key) => operationOf(body, key)));
  const operation = request.questions[0];
  assert(operation.choices.length === families.size && operation.choices.every((c) => families.has(c.value) && c.description && !c.description.startsWith("{")), "one described choice per operation family");
  const clickTargets = request.questions[1];
  assert(clickTargets.choices.length === 3 && clickTargets.choices.every((c) => operationOf(body, c.value) === "CLICK"), "the CLICK question offers exactly the CLICK candidates");
  assert(clickTargets.choices.some((c) => c.description.startsWith('button "Log in"')), `targets are described by role and label, got ${JSON.stringify(clickTargets.choices)}`);
  for (const name of ["goal_done", "stuck"]) {
    const q = request.questions.find((x) => x.name === name);
    assert(q.choices.length === 2 && q.choices.every((c) => c.description === body.questions[name].criteria[c.value]), `${name} maps its criteria`);
  }
  const action = candidates.get(result.decision.actionKey);
  assert(action.operation === "CLICK" && action.target.label === "Log in", JSON.stringify(action));
  assert(Math.abs(result.decision.actionProbability - 0.81) < 1e-9, `joint probability P(op) * P(element | op), got ${result.decision.actionProbability}`);
  const total = Object.values(result.decision.probabilities).reduce((a, b) => a + b, 0);
  assert(Math.abs(total - 1) < 1e-9 && Object.keys(result.decision.probabilities).length === Object.keys(body.questions.action.criteria).length, "the joint covers every offered key and sums to 1");
  assert(result.decision.confidence === result.decision.actionProbability, "the action confidence is the chosen joint probability");
  assert(result.usage.input_tokens === 12 && typeof result.latencyMs === "number", "usage and latency");
});

await test("a large action head offers every candidate, split by operation, without bracketing", async () => {
  const { body } = decisionBody(40);
  const calls = [];
  await requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI(calls), sleep: noSleep });
  assert(calls.length === 1, "single request");
  const offered = calls[0].request.questions.filter((q) => q.name.startsWith("target_")).reduce((n, q) => n + q.choices.length, 0);
  const singles = calls[0].request.questions.find((q) => q.name === "operation").choices.filter((c) => !calls[0].request.questions.some((q) => q.name === `target_${c.value}`)).length;
  assert(offered + singles === Object.keys(body.questions.action.criteria).length, "every candidate is offered exactly once");
  assert(calls[0].request.questions.find((q) => q.name === "target_CLICK").choices.length === 40, "all 40 CLICK targets in one question");
});

await test("rounded probabilities (two decimals) are rescaled per question, and an all-zero question becomes uniform", async () => {
  const { body, candidates } = decisionBody(40);
  // 40 CLICK targets: "Log in" 0.61, the other 39 each 0.01 -> sums to 1.00.
  // 40 HOVER targets: every one rounds to 0.00 -> carries no preference.
  // operation: CLICK 0.91, HOVER 0.03, the reserved ones 0.01 each.
  const mutate = (json) => ({
    ...json,
    answers: json.answers.map((a) => {
      if (a.name === "target_HOVER") return { ...a, probabilities: a.probabilities.map((p) => ({ ...p, probability: 0 })) };
      if (a.name === "target_CLICK") return { ...a, probabilities: a.probabilities.map((p) => ({ ...p, probability: p.value === a.choice ? 0.61 : 0.01 })) };
      if (a.name === "operation") return { ...a, probabilities: a.probabilities.map((p) => ({ ...p, probability: p.value === "CLICK" ? 0.91 : p.value === "HOVER" ? 0.03 : 0.01 })) };
      return a;
    })
  });
  const result = await requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate }), sleep: noSleep });
  const action = candidates.get(result.decision.actionKey);
  assert(action.operation === "CLICK" && action.target.label === "Log in", JSON.stringify(action));
  const total = Object.values(result.decision.probabilities).reduce((a, b) => a + b, 0);
  assert(Math.abs(total - 1) < 1e-9, `the joint sums to 1 after rescaling, got ${total}`);
  const hovers = Object.entries(result.decision.probabilities).filter(([key]) => operationOf(body, key) === "HOVER").map(([, p]) => p);
  assert(hovers.every((p) => Math.abs(p - hovers[0]) < 1e-12) && hovers[0] > 0, "an all-zero HOVER question is spread uniformly");
});

await test("an abstained target question (only type and name) is uniform within its family; an abstained operation is refused", async () => {
  const { body, candidates } = decisionBody(3);
  const abstain = (name) => (json) => ({ ...json, answers: json.answers.map((a) => (a.name === name ? { type: a.type, name: a.name } : a)) });
  const result = await requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate: abstain("target_HOVER") }), sleep: noSleep });
  assert(candidates.get(result.decision.actionKey).target.label === "Log in", "the answered CLICK family still decides");
  const hovers = Object.entries(result.decision.probabilities).filter(([key]) => operationOf(body, key) === "HOVER").map(([, p]) => p);
  assert(hovers.length === 3 && hovers.every((p) => Math.abs(p - hovers[0]) < 1e-12), "the abstained HOVER family is uniform");
  const total = Object.values(result.decision.probabilities).reduce((a, b) => a + b, 0);
  assert(Math.abs(total - 1) < 1e-9, `the joint still sums to 1, got ${total}`);
  const chosenFamily = await requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate: abstain("target_CLICK") }), sleep: noSleep });
  const ranked = Object.values(chosenFamily.decision.probabilities).sort((a, b) => b - a);
  assert(ranked[0] - ranked[1] < 1e-9, `abstaining on the chosen family leaves its elements tied, so the selection margin abstains (got ${ranked.slice(0, 2)})`);
  for (const name of ["operation", "goal_done", "stuck"]) {
    await expectError(requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate: abstain(name) }), sleep: noSleep }), "INVALID_RESPONSE");
  }
});

await test("a body whose action criteria are not the runtime protocol is asked head by head", async () => {
  const head = (criteria) => ({ instructions: { rules: ["Pick."] }, criteria });
  const legacy = { state: {}, questions: { action: head({ a: "free text", b: "other" }), goal_done: head({ yes: "y", no: "n" }), stuck: head({ yes: "y", no: "n" }) } };
  const names = openaiRequestBody(legacy, null).request.questions.map((q) => q.name);
  assert(JSON.stringify(names) === '["action","goal_done","stuck"]', JSON.stringify(names));
});

await test("a capture is sent as one user message with input_text and an inline input_image", async () => {
  const { body } = decisionBody(3);
  const calls = [];
  await requestDecision({
    source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body,
    image: { data: "QUJD", mimeType: "image/png" }, fetchImpl: fakeOpenAI(calls), sleep: noSleep
  });
  const { input } = calls[0].request;
  assert(Array.isArray(input) && input.length === 1 && input[0].role === "user", "one user message");
  const [text, image] = input[0].content;
  assert(text.type === "input_text" && text.text === JSON.stringify(body.state), "state text part");
  assert(image.type === "input_image" && image.image_url === "data:image/png;base64,QUJD", "inline data URL");
});

await test("an incomplete image object falls back to string input", () => {
  const { body } = decisionBody(3);
  for (const image of [null, undefined, {}, { data: "", mimeType: "image/png" }, { data: "QUJD" }]) {
    assert(typeof openaiRequestBody(body, image).request.input === "string", `string input for ${JSON.stringify(image)}`);
  }
});

await test("a head with one option is answered locally and not sent; no questions remain when all are single-option", () => {
  const head = (criteria) => ({ instructions: { rules: ["Pick."] }, criteria });
  const mixed = { state: {}, questions: { action: head({ a: "only" }), complete: head({ yes: "y", no: "n" }) } };
  const one = openaiRequestBody(mixed, null);
  assert(JSON.stringify(one.request.questions.map((q) => q.name)) === '["complete"]', "only the multi-option head is sent");
  const answer = one.local.action;
  assert(answer.choice === "a" && answer.probabilities.a === 1 && answer.confidence === 1, JSON.stringify(answer));
  const all = openaiRequestBody({ state: {}, questions: { action: head({ a: "only" }) } }, null);
  assert(all.request.questions.length === 0 && all.local.action.choice === "a", "nothing to ask");
});

await test("a missing confidence is INVALID_RESPONSE and none is derived", async () => {
  const { body } = decisionBody(3);
  const mutate = (json) => ({ ...json, answers: json.answers.map((a) => (a.name === "operation" ? { ...a, confidence: undefined } : a)) });
  await expectError(requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate }), sleep: noSleep }), "INVALID_RESPONSE");
});

await test("answers that are not an array, a missing head, or partial probabilities are INVALID_RESPONSE", async () => {
  const { body } = decisionBody(3);
  const run = (mutate) => requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate }), sleep: noSleep });
  await expectError(run((json) => ({ ...json, answers: { action: {} } })), "INVALID_RESPONSE");
  await expectError(run((json) => ({ ...json, answers: json.answers.filter((a) => a.name !== "stuck") })), "INVALID_RESPONSE");
  await expectError(run((json) => ({ ...json, answers: json.answers.filter((a) => a.name !== "target_CLICK") })), "INVALID_RESPONSE");
  await expectError(run((json) => ({ ...json, answers: json.answers.map((a) => (a.name === "target_CLICK" ? { ...a, probabilities: a.probabilities.slice(1) } : a)) })), "INVALID_RESPONSE");
  await expectError(run((json) => ({ ...json, answers: json.answers.map((a) => (a.name === "operation" ? { ...a, probabilities: a.probabilities.map((p) => ({ ...p, probability: "0.5" })) } : a)) })), "INVALID_RESPONSE");
});

await test("usage defaults to {} when the response carries none", async () => {
  const { body } = decisionBody(3);
  const result = await requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { mutate: (json) => ({ ...json, usage: undefined }) }), sleep: noSleep });
  assert(JSON.stringify(result.usage) === "{}", JSON.stringify(result.usage));
});

await test("401 is AUTH_ERROR without retrying and the provider message is carried", async () => {
  const { body } = decisionBody(3);
  const calls = [];
  const err = await expectError(
    requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI(calls, { status: 401, errorBody: { error: { message: "bad credentials" } } }), sleep: noSleep }),
    "AUTH_ERROR"
  );
  assert(calls.length === 1, `no retry on 401, got ${calls.length} calls`);
  assert(/bad credentials/.test(err.message), err.message);
  assert(!err.message.includes(KEY), "the key is never in an error");
});

await test("429 is RATE_LIMIT_ERROR after bounded retries", async () => {
  const { body } = decisionBody(3);
  const calls = [];
  await expectError(requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI(calls, { status: 429 }), sleep: noSleep }), "RATE_LIMIT_ERROR");
  assert(calls.length === 3, `1 attempt + 2 retries, got ${calls.length}`);
});

await test("an unusable 400 is INVALID_RESPONSE", async () => {
  const { body } = decisionBody(3);
  await expectError(requestDecision({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", body, fetchImpl: fakeOpenAI([], { status: 400 }), sleep: noSleep }), "INVALID_RESPONSE");
});

// --- capability ---------------------------------------------------------

function capabilityFetch(calls, { rejectImage = false } = {}) {
  const decisions = fakeOpenAI(calls);
  return async (url, init) => {
    if (String(url).endsWith("/v1/decisions")) {
      const request = JSON.parse(init.body);
      if (rejectImage && Array.isArray(request.input)) {
        calls.push({ url, request });
        return new Response(JSON.stringify({ error: { message: "image rejected" } }), { status: 400 });
      }
      return decisions(url, init);
    }
    calls.push({ url, request: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"text": "OK"}' } }], usage: { total_tokens: 1 } }), { status: 200 });
  };
}

const TEXT_MODEL = { baseUrl: "https://text.example.com/v1", model: "small", apiKey: "tm-test-key" };

await test("capability: a text probe and an image probe both succeed", async () => {
  const calls = [];
  const result = await runTypesafeCapabilityTest({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", textModel: TEXT_MODEL, fetchImpl: capabilityFetch(calls), sleep: noSleep });
  assert(result.status === "pass", JSON.stringify(result));
  const decisionCalls = calls.filter((c) => String(c.url).endsWith("/v1/decisions"));
  assert(decisionCalls.length === 2, `two decision probes, got ${decisionCalls.length}`);
  assert(typeof decisionCalls[0].request.input === "string", "first probe is text");
  const image = decisionCalls[1].request.input[0].content[1];
  assert(image.type === "input_image" && image.image_url === `data:${CAPABILITY_IMAGE.mimeType};base64,${CAPABILITY_IMAGE.data}`, "second probe carries the embedded PNG");
  assert(result.capabilities.image === "pass", "image stage passes");
});

await test("capability: a rejected image probe fails the result and names the image stage", async () => {
  const calls = [];
  const result = await runTypesafeCapabilityTest({ source: "openai", endpoint: "https://api.openai.com", apiKey: KEY, model: "gpt-6-luna", textModel: TEXT_MODEL, fetchImpl: capabilityFetch(calls, { rejectImage: true }), sleep: noSleep });
  assert(result.status === "fail", "fails overall");
  assert(result.capabilities.systemone === "pass" && result.capabilities.image === "fail", JSON.stringify(result.capabilities));
  assert(result.errors.image?.code === "INVALID_RESPONSE" && !result.errors.systemone, JSON.stringify(result.errors));
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);

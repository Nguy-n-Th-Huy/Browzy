#!/usr/bin/env node
//
// The three-stage TypeSafe capability test (host/agent/jev/capability.js) — per
// openspec/changes/add-typesafe-jev-provider design.md §9 and the
// `typesafe-jev-provider` spec's "TypeSafe capability test" requirement
// (successful test, invalid structured response, the text-model failure being
// distinguishable, and — openspec/changes/add-jev-run-screenshots design.md §5
// — the image stage reported separately and never gating).
//
// All three stages must always be attempted independently and provider
// failures must be classified into the result rather than thrown. Every
// scenario runs against a local stub server; no live provider is contacted.
//
// Run: node host/test/jev-capability.test.mjs

import http from "node:http";

import { runTypesafeCapabilityTest, CAPABILITY_IMAGE, CAPABILITY_TEXT_GOAL } from "../agent/jev/capability.js";
import { TEXT_PROBE } from "../agent/jev/text-helper.js";

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

const TYPESAFE_KEY = "ts-super-secret-key";
const TEXT_KEY = "tm-super-secret-key";
const TEXT_MODEL = { baseUrl: "https://text.example.com/v1", model: "small-model", apiKey: TEXT_KEY };

function validAnswers(body) {
  const answers = {};
  for (const [name, head] of Object.entries(body.questions)) {
    const ids = Object.keys(head.criteria);
    answers[name] = { choice: ids[0], probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])), confidence: 0.9 };
  }
  return { answers, usage: { total_tokens: 3 } };
}

function validCompletion() {
  return { choices: [{ message: { content: '{"text": "Continue"}' } }], usage: { total_tokens: 5 } };
}

async function startStub(handler) {
  const state = { paths: [], headers: [], bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.paths.push(req.url);
      state.headers.push(req.headers);
      try {
        state.bodies.push(JSON.parse(raw));
      } catch {
        state.bodies.push(null);
      }
      handler(req, res, state);
    });
  });
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

// A port nothing listens on: an ephemeral port that was bound and then
// released, so the refusal is guaranteed rather than assuming port 1 is free.
async function deadPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

// Runs both stages against one stub: `/v1/systemone` and `/chat/completions`.
function runAgainst(stub, extra = {}) {
  return runTypesafeCapabilityTest({
    endpoint: stub.url,
    apiKey: TYPESAFE_KEY,
    model: "jev-latest",
    textModel: { ...TEXT_MODEL, baseUrl: `${stub.url}/v1` },
    sleep: async () => {},
    ...extra
  });
}

console.log("\nJev capability test\n");

await test("all three stages pass and the result records them", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    assert(result.status === "pass", JSON.stringify(result));
    assert(
      result.capabilities.systemone === "pass" && result.capabilities.textModel === "pass" && result.capabilities.image === "pass",
      JSON.stringify(result.capabilities)
    );
    // The search stage is the one stage this profile cannot pass: its decision
    // model speaks Chat Completions, which has no provider-side server tools.
    // It is reported, and it changes nothing — `status` is still a pass.
    assert(result.capabilities.search === "fail", JSON.stringify(result.capabilities));
    assert(result.errors.search?.code === "SEARCH_UNAVAILABLE", JSON.stringify(result.errors));
    assert(!result.errors.systemone && !result.errors.textModel && !result.errors.image, JSON.stringify(result.errors));
    assert(!Number.isNaN(Date.parse(result.timestamp)), `timestamp must be ISO: ${result.timestamp}`);
    assert(stub.state.paths.includes("/v1/systemone") && stub.state.paths.includes("/v1/chat/completions"), stub.state.paths.join(","));
  } finally {
    await stub.close();
  }
});

await test("the vercel source proves the gateway wire and lifts confidences", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v4/ai/evaluation-model") {
      const body = state.bodies[state.bodies.length - 1];
      const { answers } = validAnswers(body);
      for (const answer of Object.values(answers)) delete answer.confidence;
      return sendJson(res, 200, {
        answers,
        providerMetadata: { typesafe: { confidence: { action: 1, goal_done: 1, stuck: 1 } } },
        usage: { inputTokens: 8, outputTokens: 2 }
      });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { source: "vercel", model: "typesafe-ai/jev" });
    assert(result.status === "pass", JSON.stringify(result));
    const gatewayIndex = stub.state.paths.indexOf("/v4/ai/evaluation-model");
    assert(gatewayIndex !== -1, stub.state.paths.join(","));
    assert(stub.state.headers[gatewayIndex]["ai-model-id"] === "typesafe-ai/jev", "the gateway header must name the model");
    assert(stub.state.bodies[gatewayIndex].model === undefined, "the gateway body must not carry model");
  } finally {
    await stub.close();
  }
});

await test("the openrouter source proves its own decision route", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/api/alpha/decisions") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { source: "openrouter", model: "typesafe/jev-1.13" });
    assert(result.status === "pass", JSON.stringify(result));
    const index = stub.state.paths.indexOf("/api/alpha/decisions");
    assert(index !== -1, stub.state.paths.join(","));
    assert(stub.state.bodies[index].model === "typesafe/jev-1.13", "the model id rides in the body on this route");
    assert(!stub.state.paths.includes("/v1/systemone"), "the direct route must not be contacted for this source");
  } finally {
    await stub.close();
  }
});

await test("the vercel source classifies an invalid gateway answer as INVALID_RESPONSE", async () => {
  const stub = await startStub((req, res) => {
    if (req.url === "/v4/ai/evaluation-model") {
      return sendJson(res, 200, {
        answers: { operation: { choice: "NOT_OFFERED", probabilities: { NOT_OFFERED: 1 } } },
        providerMetadata: { typesafe: { confidence: { operation: 1 } } },
        usage: {}
      });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { source: "vercel", model: "typesafe-ai/jev" });
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.capabilities.systemone === "fail" && result.capabilities.textModel === "pass", JSON.stringify(result.capabilities));
    assert(result.errors.systemone && result.errors.systemone.code === "INVALID_RESPONSE", JSON.stringify(result.errors));
  } finally {
    await stub.close();
  }
});

await test("the two requests carry the pinned shapes and never echo a key", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    const systemone = stub.state.bodies[stub.state.paths.indexOf("/v1/systemone")];
    assert(systemone.model === "jev-latest", "the configured model must ride along");
    assert(Object.keys(systemone.questions).join(",") === "action,goal_done,stuck", "the probe must exercise all runtime heads");
    assert(Object.keys(systemone.questions.action.criteria).length > 1, "the capability question must offer a real choice");
    const chat = stub.state.bodies[stub.state.paths.indexOf("/v1/chat/completions")];
    assert(chat.model === "small-model" && chat.max_tokens === 1024, JSON.stringify({ model: chat.model, max_tokens: chat.max_tokens }));
    assert(chat.response_format.type === "json_object", JSON.stringify(chat.response_format));
    // The decision-model stage sends what a real decision sends: a pass has
    // to prove the source answers in the required shape WHILE reasoning, the
    // combination every step of a run depends on.
    assert(chat.reasoning.effort === "medium", `the decision-class reasoning parameter must be part of the tested request: ${JSON.stringify(chat.reasoning)}`);
    for (const header of stub.state.headers) {
      assert(header.authorization.startsWith("Bearer "), "both stages authenticate");
    }
    const wire = JSON.stringify(result);
    assert(!wire.includes(TYPESAFE_KEY) && !wire.includes(TEXT_KEY), "the result must never carry a credential");
  } finally {
    await stub.close();
  }
});

await test("a 200 structured answer that fails validation is INVALID_RESPONSE for the systemone stage only", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") {
      const body = state.bodies[state.bodies.length - 1];
      const ids = Object.keys(body.questions.action.criteria);
      const probabilities = Object.fromEntries(ids.map((id) => [id, 0.5]));
      return sendJson(res, 200, { answers: { operation: { choice: "NOT_OFFERED", probabilities, confidence: 0.9 } } });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.capabilities.systemone === "fail" && result.capabilities.textModel === "pass", JSON.stringify(result.capabilities));
    assert(result.errors.systemone.code === "INVALID_RESPONSE", JSON.stringify(result.errors.systemone));
    assert(result.errors.textModel === undefined, "the working stage must not be reported as failing");
    assert(stub.state.paths.includes("/v1/chat/completions"), "the text stage must still be attempted");
  } finally {
    await stub.close();
  }
});

await test("a text-model auth failure is distinguishable from a TypeSafe success", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 401, { error: "bad text key" });
  });
  try {
    const result = await runAgainst(stub);
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.capabilities.systemone === "pass" && result.capabilities.textModel === "fail", JSON.stringify(result.capabilities));
    assert(result.errors.textModel.code === "AUTH_ERROR", JSON.stringify(result.errors.textModel));
    assert(result.errors.systemone === undefined, JSON.stringify(result.errors));
  } finally {
    await stub.close();
  }
});

await test("a text reply that is not exactly {text} is INVALID_RESPONSE", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, { choices: [{ message: { content: '{"value": "x"}' } }] });
  });
  try {
    const result = await runAgainst(stub);
    assert(result.errors.textModel.code === "INVALID_RESPONSE", JSON.stringify(result.errors.textModel));
  } finally {
    await stub.close();
  }
});

await test("a reported missing value also fails the text stage as INVALID_RESPONSE", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, { choices: [{ message: { content: '{"text": null}' } }] });
  });
  try {
    const result = await runAgainst(stub);
    assert(result.errors.textModel.code === "INVALID_RESPONSE", JSON.stringify(result.errors.textModel));
  } finally {
    await stub.close();
  }
});

await test("all three stages failing yields a fail with every stage named", async () => {
  const stub = await startStub((req, res) => sendJson(res, 500, { error: "broken" }));
  try {
    const result = await runAgainst(stub);
    assert(result.status === "fail", JSON.stringify(result));
    assert(result.errors.systemone.code === "MODEL_UNAVAILABLE_ERROR", JSON.stringify(result.errors.systemone));
    assert(result.errors.textModel.code === "MODEL_UNAVAILABLE_ERROR", JSON.stringify(result.errors.textModel));
    assert(result.errors.image.code === "MODEL_UNAVAILABLE_ERROR", JSON.stringify(result.errors.image));
    // A 500 is a terminal unavailability code (only 429/503/529 retry), so each
    // stage makes exactly one attempt — which is also the proof that a failed
    // stage never aborts the stages after it.
    assert(stub.state.paths.length === 3, `expected one attempt per stage (got ${stub.state.paths.length})`);
  } finally {
    await stub.close();
  }
});

await test("an unreachable text model is NETWORK_ERROR while the TypeSafe stage still passes", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, validCompletion());
  });
  // The text model points at a port nothing listens on.
  const deadPortNumber = await deadPort();
  try {
    const result = await runTypesafeCapabilityTest({
      endpoint: stub.url,
      apiKey: TYPESAFE_KEY,
      model: "jev-latest",
      textModel: { baseUrl: `http://127.0.0.1:${deadPortNumber}/v1`, model: "small-model", apiKey: TEXT_KEY },
      sleep: async () => {}
    });
    assert(result.capabilities.systemone === "pass", JSON.stringify(result.capabilities));
    assert(result.errors.textModel.code === "NETWORK_ERROR", JSON.stringify(result.errors.textModel));
  } finally {
    await stub.close();
  }
});

await test("provider failures never throw out of the capability test", async () => {
  // A closed port on both stages: the function must return, not reject.
  const result = await runTypesafeCapabilityTest({
    endpoint: `http://127.0.0.1:${await deadPort()}`,
    apiKey: TYPESAFE_KEY,
    model: "jev-latest",
    textModel: { baseUrl: `http://127.0.0.1:${await deadPort()}/v1`, model: "small-model", apiKey: TEXT_KEY },
    sleep: async () => {}
  });
  assert(result.status === "fail", JSON.stringify(result));
  assert(result.errors.systemone.code === "NETWORK_ERROR" && result.errors.textModel.code === "NETWORK_ERROR", JSON.stringify(result.errors));
});

await test("the text stage's context names a concrete value, so a correct model cannot answer 'missing'", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    assert(result.status === "pass", JSON.stringify(result));
    const completionIndex = stub.state.paths.indexOf("/v1/chat/completions");
    assert(completionIndex !== -1, stub.state.paths.join(","));
    const completionBody = stub.state.bodies[completionIndex];
    const user = completionBody.messages.find((m) => m.role === "user");
    assert(user && /Type the word OK/.test(String(user.content)), `the context must name the value to enter: ${user ? user.content : "no user message"}`);
  } finally {
    await stub.close();
  }
});

await test("the image stage is the text probe with one embedded PNG added", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    assert(result.capabilities.image === "pass", JSON.stringify(result.capabilities));
    const completions = stub.state.bodies.filter((body) => Array.isArray(body?.messages));
    const imageRequest = completions.find((body) => Array.isArray(body.messages[1].content));
    assert(imageRequest, `the third stage must send multimodal content (${JSON.stringify(completions.map((b) => typeof b.messages[1].content))})`);
    // The SAME instruction and goal as the text stage, so a stage-3 failure can
    // only be the image part.
    assert(imageRequest.messages[0].content === TEXT_PROBE, "the image stage carries the text probe's own instruction");
    const [textPart, imagePart] = imageRequest.messages[1].content;
    assert(textPart.type === "text" && JSON.parse(textPart.text).goal === CAPABILITY_TEXT_GOAL, `the context is the text stage's own (${textPart.text})`);
    assert(imagePart.type === "image_url", JSON.stringify(imagePart));
    assert(
      imagePart.image_url.url === `data:${CAPABILITY_IMAGE.mimeType};base64,${CAPABILITY_IMAGE.data}`,
      "the embedded PNG rides the data URL verbatim"
    );
    // A real PNG (signature + IHDR), not a placeholder string.
    const bytes = Buffer.from(CAPABILITY_IMAGE.data, "base64");
    assert(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "the probe image must be a real PNG");
    assert(bytes.subarray(12, 16).toString("ascii") === "IHDR", "and carry a PNG header chunk");
    assert(imageRequest.max_tokens === 1024 && imageRequest.reasoning.effort === "low", JSON.stringify(imageRequest));
    // The text stage itself stayed text-only.
    const textRequest = completions.find((body) => typeof body.messages[1].content === "string" && body.messages[0].content === TEXT_PROBE);
    assert(textRequest, "the second stage must still be a plain text completion");
  } finally {
    await stub.close();
  }
});

await test("a model that rejects image content fails only the image stage and stays runnable", async () => {
  // A text-only endpoint: it answers plain completions and refuses any request
  // whose user message is the multimodal array.
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    const body = state.bodies[state.bodies.length - 1];
    if (Array.isArray(body?.messages?.[1]?.content)) {
      return sendJson(res, 400, { error: { type: "invalid_request_error", message: "this model does not support image input" } });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    assert(result.capabilities.systemone === "pass" && result.capabilities.textModel === "pass", JSON.stringify(result.capabilities));
    assert(result.capabilities.image === "fail", JSON.stringify(result.capabilities));
    assert(result.errors.image && result.errors.image.code === "INVALID_RESPONSE", JSON.stringify(result.errors));
    assert(result.errors.systemone === undefined && result.errors.textModel === undefined, "the passing stages must not be reported as failing");
    // The image stage NEVER gates `status` (design.md §5): a text-only model
    // stays runnable with the screenshot toggle off.
    assert(result.status === "pass", `a failed image stage must not fail the test: ${JSON.stringify(result)}`);
  } finally {
    await stub.close();
  }
});

await test("an image stage answering outside the single-key contract is INVALID_RESPONSE for the image stage alone", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    const body = state.bodies[state.bodies.length - 1];
    if (Array.isArray(body?.messages?.[1]?.content)) return sendJson(res, 200, { choices: [{ message: { content: '{"text": null}' } }] });
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub);
    assert(result.capabilities.textModel === "pass" && result.capabilities.image === "fail", JSON.stringify(result.capabilities));
    assert(result.errors.image.code === "INVALID_RESPONSE", JSON.stringify(result.errors.image));
    assert(result.status === "pass", JSON.stringify(result.status));
  } finally {
    await stub.close();
  }
});

// --- stage 4: the provider-side web search ----------------------------------

// An Anthropic-wire decision model, so the stage is actually attempted: the
// stub answers `/v1/messages` and decides, per test, what the search did.
function anthropicTextModel(stub) {
  return { kind: "anthropic", baseUrl: `${stub.url}/anthropic`, model: "claude-opus-5", apiKey: TEXT_KEY };
}

/** A Messages 200 whose blocks say a search ran and returned results. */
function searchedOk() {
  return {
    content: [
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "today" } },
      { type: "web_search_tool_result", tool_use_id: "srv_1", content: [{ type: "web_search_result", url: "https://example.com", title: "Example" }] },
      { type: "text", text: '{"text": "Continue"}' }
    ],
    usage: { input_tokens: 9, output_tokens: 4 }
  };
}

await test("a source that really searches passes the search stage", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    if (req.url === "/anthropic/v1/messages") {
      const body = state.bodies[state.bodies.length - 1];
      // The probe declares the tool; the other Anthropic-wire stages must not.
      if (Array.isArray(body.tools)) return sendJson(res, 200, searchedOk());
      return sendJson(res, 200, { content: [{ type: "text", text: '{"text": "Continue"}' }], usage: {} });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { textModel: anthropicTextModel(stub) });
    assert(result.capabilities.search === "pass", JSON.stringify(result.capabilities));
    assert(!result.errors.search, JSON.stringify(result.errors));
    const probe = stub.state.bodies.find((b) => b && Array.isArray(b.tools));
    assert(probe.tools[0].name === "web_search" && probe.tools[0].type === "web_search_20260209", JSON.stringify(probe.tools));
    assert(probe.tools[0].max_uses === 1, "the probe searches once — a capability test is not research");
  } finally {
    await stub.close();
  }
});

await test("a declared tool the source never runs is not a pass", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    if (req.url === "/anthropic/v1/messages") {
      // Accepts `tools`, answers plain text, never searches — the silent
      // ignore a capability test exists to catch.
      return sendJson(res, 200, { content: [{ type: "text", text: '{"text": "Continue"}' }], usage: {} });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { textModel: anthropicTextModel(stub) });
    assert(result.capabilities.search === "fail", JSON.stringify(result.capabilities));
    assert(/never ran it/.test(result.errors.search.message), result.errors.search.message);
    assert(result.status === "pass", "a missing search never decides the overall status");
  } finally {
    await stub.close();
  }
});

await test("a search that ran and failed is not a pass, and arrives inside a 200", async () => {
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    if (req.url === "/anthropic/v1/messages") {
      const body = state.bodies[state.bodies.length - 1];
      if (Array.isArray(body.tools)) {
        return sendJson(res, 200, {
          content: [
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "today" } },
            // An errored server tool: an OBJECT content, not a list.
            { type: "web_search_tool_result", tool_use_id: "srv_1", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
            { type: "text", text: '{"text": "Continue"}' }
          ],
          usage: {}
        });
      }
      return sendJson(res, 200, { content: [{ type: "text", text: '{"text": "Continue"}' }], usage: {} });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { textModel: anthropicTextModel(stub) });
    assert(result.capabilities.search === "fail", JSON.stringify(result.capabilities));
    assert(/max_uses_exceeded/.test(result.errors.search.message), result.errors.search.message);
  } finally {
    await stub.close();
  }
});

await test("a source that rejects the current tool type is retried once on the earlier one", async () => {
  const seen = [];
  const stub = await startStub((req, res, state) => {
    if (req.url === "/v1/systemone") return sendJson(res, 200, validAnswers(state.bodies[state.bodies.length - 1]));
    if (req.url === "/anthropic/v1/messages") {
      const body = state.bodies[state.bodies.length - 1];
      if (Array.isArray(body.tools)) {
        seen.push(body.tools[0].type);
        if (body.tools[0].type === "web_search_20260209") {
          return sendJson(res, 400, { error: { type: "invalid_request_error", message: "tools.0.type: unsupported tool type" } });
        }
        return sendJson(res, 200, searchedOk());
      }
      return sendJson(res, 200, { content: [{ type: "text", text: '{"text": "Continue"}' }], usage: {} });
    }
    return sendJson(res, 200, validCompletion());
  });
  try {
    const result = await runAgainst(stub, { textModel: anthropicTextModel(stub) });
    assert(result.capabilities.search === "pass", JSON.stringify(result.errors.search ?? result.capabilities));
    assert(
      seen.length === 2 && seen[0] === "web_search_20260209" && seen[1] === "web_search_20250305",
      `the current type is tried first and the earlier one exactly once: ${JSON.stringify(seen)}`
    );
  } finally {
    await stub.close();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
// Same Windows/Node-24 libuv shutdown race as the other stub-server suites:
// set the exit status and let the loop drain instead of process.exit().
process.exitCode = failed.length ? 1 : 0;

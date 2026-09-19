#!/usr/bin/env node
//
// The TypeSafe decision client (host/agent/jev/client.js): the single
// `POST /v1/systemone` element-selection request, its retry policy, its failure
// taxonomy, and its delegation of answer validation to questions.js — per
// openspec/changes/add-jev-run-context design.md §10 and the
// `typesafe-jev-provider` spec's "Provider error during a decision" and
// "Invalid answer is refused" scenarios.
//
// Everything runs against a local stub HTTP server (or an injected fetch); no
// live provider is contacted.
//
// Run: node host/test/jev-client.test.mjs

import http from "node:http";

import { requestDecision, postJson, JevError, backoffDelayMs, systemoneUrl, classifyStatus } from "../agent/jev/client.js";
import { buildSelectionRequest } from "../agent/jev/questions.js";

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

function snapshot() {
  return {
    v: 1,
    url: "https://example.com/",
    title: "Example",
    viewport: { w: 800, h: 600 },
    scroll: { y: 0, height: 600 },
    text: "Example page",
    truncated: { elements: false, text: false, omitted: 0 },
    elements: [
      { ref: "ref_1", role: "button", label: "Search", tag: "button" },
      { ref: "ref_2", role: "textbox", label: "Query", tag: "input", value: "", editable: true }
    ]
  };
}

function bodyFor() {
  return buildSelectionRequest({ model: "jev-latest", goal: "Search for flights", snapshot: snapshot(), operation: "CLICK", intent: "the Search button" }).body;
}

// A valid answer for the request's own single head: the offered key is the
// declared choice, with probabilities spread evenly across the offered keys.
function answerFor(body, { target = "1" } = {}) {
  const headName = Object.keys(body.questions)[0];
  const ids = Object.keys(body.questions[headName].criteria);
  const probabilities = ids.length === 1 ? { [ids[0]]: 1 } : Object.fromEntries(ids.map((id) => [id, id === target ? 0.8 : 0.2 / (ids.length - 1)]));
  return { answers: { [headName]: { choice: target, probabilities, confidence: 0.9 } }, model: "jev-stub", usage: { input_tokens: 12, output_tokens: 4 } };
}

/** Start a stub server; `handler(req, res, state)` decides each response. */
async function startStub(handler) {
  const state = { requests: [], paths: [], headers: [], bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.requests.push(req.method + " " + req.url);
      state.paths.push(req.url);
      state.headers.push(req.headers);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      state.bodies.push(parsed);
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

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

/** Send an arbitrary (non-JSON) body with its own content type. */
function sendRaw(res, status, contentType, payload) {
  res.writeHead(status, { "Content-Type": contentType, Connection: "close" });
  res.end(payload);
}

async function expectJevError(promise, code, label) {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof JevError, `${label}: expected a JevError, got ${err?.name}: ${err?.message}`);
    assert(err.code === code, `${label}: expected code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`${label}: expected a JevError with code ${code}, but the call resolved`);
}

console.log("\nJev decision client\n");

await test("posts the body to /v1/systemone with Bearer auth and returns the validated decision", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendJson(res, 200, answerFor(body)));
  try {
    const result = await requestDecision({ endpoint: stub.url, apiKey: "ts-secret", body });
    assert(stub.state.paths[0] === "/v1/systemone", `unexpected path ${stub.state.paths[0]}`);
    assert(stub.state.requests[0] === "POST /v1/systemone", stub.state.requests[0]);
    assert(stub.state.headers[0].authorization === "Bearer ts-secret", "Authorization header must carry the key");
    assert(/application\/json/.test(stub.state.headers[0]["content-type"]), "Content-Type must be JSON");
    assert(JSON.stringify(stub.state.bodies[0]) === JSON.stringify(body), "the exact body must be sent");
    assert(result.decision.operation === "CLICK", JSON.stringify(result.decision));
    assert(result.decision.targetKey === "1", JSON.stringify(result.decision));
    assert(result.usage.input_tokens === 12, "usage must be returned");
    assert(typeof result.latencyMs === "number" && result.latencyMs >= 0, "latency must be returned");
  } finally {
    await stub.close();
  }
});

await test("the vercel source posts the pinned gateway wire and lifts confidences from providerMetadata", async () => {
  const body = bodyFor();
  const base = answerFor(body);
  const answers = {};
  const confidence = {};
  for (const [head, answer] of Object.entries(base.answers)) {
    const { confidence: c, ...rest } = answer;
    answers[head] = rest;
    confidence[head] = c;
  }
  const gateway = { answers, providerMetadata: { typesafe: { confidence } }, usage: { inputTokens: 30, outputTokens: 6 } };
  const stub = await startStub((req, res) => sendJson(res, 200, gateway));
  try {
    const result = await requestDecision({ source: "vercel", endpoint: stub.url, apiKey: "vk-secret", model: "typesafe-ai/jev", body });
    assert(stub.state.paths[0] === "/v4/ai/evaluation-model", `unexpected path ${stub.state.paths[0]}`);
    const headers = stub.state.headers[0];
    assert(headers.authorization === "Bearer vk-secret", "Authorization must carry the gateway key");
    assert(headers["ai-model-id"] === "typesafe-ai/jev", `ai-model-id missing: ${JSON.stringify(headers)}`);
    assert(headers["ai-evaluation-model-specification-version"] === "4", "the specification version must be pinned");
    assert(headers["ai-gateway-protocol-version"] === "0.0.1" && headers["ai-gateway-auth-method"] === "api-key", "the gateway protocol headers must be pinned");
    const sent = stub.state.bodies[0];
    assert(sent.model === undefined, "the gateway body must not carry model");
    assert(sent.providerOptions && typeof sent.providerOptions === "object", "providerOptions must be present");
    assert(
      JSON.stringify(sent.state) === JSON.stringify(body.state) && JSON.stringify(sent.questions) === JSON.stringify(body.questions),
      "state and questions pass through unchanged"
    );
    assert(result.decision.operation === "CLICK" && result.decision.targetKey === "1", JSON.stringify(result.decision));
    assert(result.usage.inputTokens === 30, `gateway usage must pass through: ${JSON.stringify(result.usage)}`);
  } finally {
    await stub.close();
  }
});

await test("the vercel source refuses an answer whose confidence exists nowhere", async () => {
  const body = bodyFor();
  const base = answerFor(body);
  const answers = {};
  for (const [head, answer] of Object.entries(base.answers)) {
    const { confidence, ...rest } = answer;
    answers[head] = rest;
  }
  const gateway = { answers, providerMetadata: { typesafe: { confidence: {} } }, usage: {} };
  const stub = await startStub((req, res) => sendJson(res, 200, gateway));
  try {
    await expectJevError(
      requestDecision({ source: "vercel", endpoint: stub.url, apiKey: "k", model: "typesafe-ai/jev", body }),
      "INVALID_RESPONSE",
      "missing confidence"
    );
  } finally {
    await stub.close();
  }
});

await test("the openrouter source posts the decision route with the model in the body", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendJson(res, 200, answerFor(body)));
  try {
    const result = await requestDecision({
      source: "openrouter",
      endpoint: stub.url,
      apiKey: "or-secret",
      model: "typesafe/jev-1.13",
      body
    });
    assert(stub.state.paths[0] === "/api/alpha/decisions", `unexpected path ${stub.state.paths[0]}`);
    assert(stub.state.headers[0].authorization === "Bearer or-secret", "Authorization must carry the OpenRouter key");
    assert(JSON.stringify(stub.state.bodies[0]) === JSON.stringify(body), "the exact body must be sent, model included");
    assert(result.decision.operation === "CLICK" && result.decision.targetKey === "1", JSON.stringify(result.decision));
  } finally {
    await stub.close();
  }
});

await test("the openrouter source refuses an answer carrying no confidence rather than inventing one", async () => {
  const body = bodyFor();
  const base = answerFor(body);
  const answers = {};
  for (const [head, answer] of Object.entries(base.answers)) {
    const { confidence, ...rest } = answer;
    answers[head] = rest;
  }
  const stub = await startStub((req, res) => sendJson(res, 200, { answers, usage: {} }));
  try {
    await expectJevError(
      requestDecision({ source: "openrouter", endpoint: stub.url, apiKey: "k", model: "typesafe/jev-1.13", body }),
      "INVALID_RESPONSE",
      "missing confidence"
    );
  } finally {
    await stub.close();
  }
});

await test("an unknown source reaches no network at all", async () => {
  const body = bodyFor();
  let threw = null;
  try {
    await requestDecision({ source: "not-a-jev-wire", endpoint: "https://example.invalid", apiKey: "k", body });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof TypeError, `expected a TypeError, got ${threw?.name}: ${threw?.message}`);
});

await test("a non-2xx body's own message is surfaced (bounded) instead of a bare status", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) =>
    sendJson(res, 400, { error: { message: JSON.stringify({ error_type: "max_tokens_exceeded" }), type: "AI_APICallError" } })
  );
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "400 with message");
    assert(/max_tokens_exceeded/.test(err.message), `the provider's own message must ride along: ${err.message}`);
    assert(err.detail.status === 400, JSON.stringify(err.detail));
    assert(/max_tokens_exceeded/.test(String(err.detail.providerMessage)), JSON.stringify(err.detail));
  } finally {
    await stub.close();
  }
});

await test("a trailing slash on the endpoint does not double the path separator", () => {
  assert(systemoneUrl("https://api.typesafe.ai/") === "https://api.typesafe.ai/v1/systemone", systemoneUrl("https://api.typesafe.ai/"));
  assert(systemoneUrl("https://api.typesafe.ai") === "https://api.typesafe.ai/v1/systemone", systemoneUrl("https://api.typesafe.ai"));
});

await test("a 200 body whose choice is not offered is refused as INVALID_RESPONSE", async () => {
  const body = bodyFor();
  const bad = answerFor(body);
  bad.answers.click_target.choice = "TELEPORT";
  const stub = await startStub((req, res) => sendJson(res, 200, bad));
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "unoffered choice");
    assert(/failed validation/.test(err.message), err.message);
    assert(/no action executed/.test(err.message), "the failure must state that nothing executed");
  } finally {
    await stub.close();
  }
});

await test("a 200 body whose probabilities do not sum to 1 is refused", async () => {
  const body = bodyFor();
  const bad = answerFor(body);
  const ids = Object.keys(bad.answers.click_target.probabilities);
  // Every offered key at 0.6: the declared choice still ties for the maximum,
  // so the SUM is the only rule this body can fail.
  for (const id of ids) bad.answers.click_target.probabilities[id] = 0.6;
  const stub = await startStub((req, res) => sendJson(res, 200, bad));
  try {
    await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "bad sum");
  } finally {
    await stub.close();
  }
});

await test("a non-JSON 200 body names its content type and a bounded, collapsed preview", async () => {
  const body = bodyFor();
  const html = "<!doctype html>\n<html>\n  <head><title>Gateway</title></head>\n  <body>not the API</body>\n</html>";
  const stub = await startStub((req, res) => sendRaw(res, 200, "text/html; charset=utf-8", html));
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "non-JSON body");
    assert(/not JSON/.test(err.message), err.message);
    assert(/no action executed/.test(err.message), "the failure must state that nothing executed");
    assert(/content-type text\/html; charset=utf-8/.test(err.message), `the content type must ride along: ${err.message}`);
    assert(err.message.includes('body starts: "<!doctype html> <html> <head><title>Gateway</title></head> <body>not the API</body> </html>"'), `the preview must be whitespace-collapsed: ${err.message}`);
    assert(err.detail.status === 200, JSON.stringify(err.detail));
    assert(err.detail.contentType === "text/html; charset=utf-8", JSON.stringify(err.detail));
    assert(err.detail.bodyPreview === "<!doctype html> <html> <head><title>Gateway</title></head> <body>not the API</body> </html>", JSON.stringify(err.detail));
    assert(err.detail.emptyBody === undefined, JSON.stringify(err.detail));
    assert(stub.state.requests.length === 1, "a non-JSON 200 must not be retried");
  } finally {
    await stub.close();
  }
});

await test("a long non-JSON body is previewed capped at 120 characters with an ellipsis", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendRaw(res, 200, "text/html", `<html><body><div>${"x".repeat(400)}</div></body></html>`));
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "long non-JSON body");
    const head = "<html><body><div>";
    assert(err.detail.bodyPreview === `${head}${"x".repeat(120 - head.length)}…`, `the preview must be the body's beginning, cut at the cap: ${JSON.stringify(err.detail.bodyPreview)}`);
    assert(err.detail.bodyPreview.length === 121, "120 characters plus the cut marker");
    assert(!err.detail.bodyPreview.includes("</div>"), "the whole body must never ride along");
    assert(err.message.includes(JSON.stringify(err.detail.bodyPreview)), `the message must quote the preview: ${err.message}`);
  } finally {
    await stub.close();
  }
});

await test("an empty 200 body is reported as empty", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendRaw(res, 200, "application/json", ""));
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "empty body");
    assert(/the body is empty/.test(err.message), err.message);
    assert(/content-type application\/json/.test(err.message), err.message);
    assert(err.detail.status === 200 && err.detail.emptyBody === true, JSON.stringify(err.detail));
    assert(err.detail.bodyPreview === undefined, JSON.stringify(err.detail));
  } finally {
    await stub.close();
  }
});

await test("a whitespace-only 200 body is reported as empty, quoting nothing", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendRaw(res, 200, "text/plain", "   \n\t \n"));
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "INVALID_RESPONSE", "whitespace-only body");
    assert(/the body is empty/.test(err.message), err.message);
    assert(!/body starts/.test(err.message), `no blank preview may be quoted: ${err.message}`);
    assert(err.detail.contentType === "text/plain", JSON.stringify(err.detail));
  } finally {
    await stub.close();
  }
});

await test("a 200 body that cannot be read keeps the classification and is flagged unreadable", async () => {
  const body = bodyFor();
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => {
      throw new Error("body stream already read");
    }
  });
  const err = await expectJevError(requestDecision({ endpoint: "http://127.0.0.1:9", apiKey: "k", body, fetchImpl }), "INVALID_RESPONSE", "unreadable body");
  assert(/not JSON/.test(err.message) && /no action executed/.test(err.message), err.message);
  assert(err.detail.status === 200 && err.detail.bodyUnreadable === true, JSON.stringify(err.detail));
  assert(err.detail.bodyPreview === undefined, JSON.stringify(err.detail));
});

await test("status classification maps each family to its taxonomy code", () => {
  assert(classifyStatus(401) === "AUTH_ERROR" && classifyStatus(403) === "AUTH_ERROR", "401/403 are auth failures");
  assert(classifyStatus(429) === "RATE_LIMIT_ERROR", "429 is a rate limit");
  assert(classifyStatus(503) === "MODEL_UNAVAILABLE_ERROR" && classifyStatus(529) === "MODEL_UNAVAILABLE_ERROR", "503/529 are unavailability");
  assert(classifyStatus(500) === "MODEL_UNAVAILABLE_ERROR" && classifyStatus(502) === "MODEL_UNAVAILABLE_ERROR", "500/502 are unavailability");
  assert(classifyStatus(400) === "INVALID_RESPONSE" && classifyStatus(404) === "INVALID_RESPONSE", "other statuses are response failures");
});

await test("auth rejections fail immediately with AUTH_ERROR and are not retried", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendJson(res, 401, { error: "bad key" }));
  try {
    const err = await expectJevError(requestDecision({ endpoint: stub.url, apiKey: "k", body }), "AUTH_ERROR", "401");
    assert(err.detail.status === 401, "the status must ride along in the detail");
    assert(stub.state.requests.length === 1, `a 401 must not be retried (made ${stub.state.requests.length} requests)`);
  } finally {
    await stub.close();
  }
});

await test("a rate limit is retried twice with 0.5s/1s backoff and then fails as RATE_LIMIT_ERROR", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendJson(res, 429, { error: "slow down" }));
  const sleeps = [];
  try {
    await expectJevError(
      requestDecision({ endpoint: stub.url, apiKey: "k", body, sleep: async (ms) => sleeps.push(ms) }),
      "RATE_LIMIT_ERROR",
      "429 x3"
    );
    assert(stub.state.requests.length === 3, `expected 3 attempts, got ${stub.state.requests.length}`);
    assert(sleeps.join(",") === "500,1000", `unexpected backoff: ${sleeps.join(",")}`);
  } finally {
    await stub.close();
  }
});

await test("a retryable status that succeeds on the retry is not a failure", async () => {
  const body = bodyFor();
  let calls = 0;
  const stub = await startStub((req, res) => {
    calls += 1;
    if (calls === 1) return sendJson(res, 503, { error: "unavailable" });
    return sendJson(res, 200, answerFor(body));
  });
  const sleeps = [];
  try {
    const result = await requestDecision({ endpoint: stub.url, apiKey: "k", body, sleep: async (ms) => sleeps.push(ms) });
    assert(result.decision.operation === "CLICK", JSON.stringify(result.decision));
    assert(calls === 2 && sleeps.join(",") === "500", `expected one retry after 500ms, got ${calls} calls / ${sleeps.join(",")}`);
  } finally {
    await stub.close();
  }
});

await test("an exhausted 503 is MODEL_UNAVAILABLE_ERROR", async () => {
  const body = bodyFor();
  const stub = await startStub((req, res) => sendJson(res, 503, { error: "unavailable" }));
  try {
    await expectJevError(
      requestDecision({ endpoint: stub.url, apiKey: "k", body, sleep: async () => {} }),
      "MODEL_UNAVAILABLE_ERROR",
      "503 x3"
    );
    assert(stub.state.requests.length === 3, "a 503 gets exactly two retries");
  } finally {
    await stub.close();
  }
});

await test("a network failure is repeated once, then fails as NETWORK_ERROR", async () => {
  const body = bodyFor();
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connect ECONNREFUSED 127.0.0.1:1");
  };
  await expectJevError(
    requestDecision({ endpoint: "http://127.0.0.1:1", apiKey: "k", body, fetchImpl, sleep: async (ms) => sleeps.push(ms) }),
    "NETWORK_ERROR",
    "network"
  );
  assert(calls === 2, `a lost connection gets exactly one repeat (called ${calls} times)`);
  assert(sleeps.join(",") === "500", `unexpected backoff: ${sleeps.join(",")}`);
});

await test("a request our own deadline aborts is repeated once, then TIMEOUT_ERROR", async () => {
  const body = bodyFor();
  let calls = 0;
  const fetchImpl = (url, opts) => {
    calls += 1;
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    });
  };
  await expectJevError(
    requestDecision({ endpoint: "http://127.0.0.1:9", apiKey: "k", body, fetchImpl, timeoutMs: 30, sleep: async () => {} }),
    "TIMEOUT_ERROR",
    "timeout"
  );
  assert(calls === 2, `a timeout gets exactly one repeat (called ${calls} times)`);
});

await test("a missing credential is refused locally without any request", async () => {
  const body = bodyFor();
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("must not be called");
  };
  await expectJevError(requestDecision({ endpoint: "http://127.0.0.1:9", apiKey: "", body, fetchImpl }), "AUTH_ERROR", "no credential");
  assert(called === false, "no request may be issued without a credential");
});

await test("postJson is the single retry implementation the whole subsystem shares", async () => {
  const stub = await startStub((req, res) => sendJson(res, 200, { ok: true }));
  try {
    const { json, status } = await postJson({ url: `${stub.url}/chat/completions`, apiKey: "k", body: { a: 1 } });
    assert(json.ok === true && status === 200, JSON.stringify({ json, status }));
    assert(stub.state.paths[0] === "/chat/completions", stub.state.paths[0]);
  } finally {
    await stub.close();
  }
  assert(backoffDelayMs(0) === 500 && backoffDelayMs(1) === 1000, `${backoffDelayMs(0)}, ${backoffDelayMs(1)}`);
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

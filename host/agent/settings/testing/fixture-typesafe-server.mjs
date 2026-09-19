// An in-process, local-only fixture HTTP server that speaks just enough of
// the three TypeSafe/Jev provider protocols to exercise the settings and
// capability code paths for real — `POST /v1/systemone` (the direct source's
// structured choice request, design.md §4), `POST /chat/completions` (the
// OpenAI-compatible text-model request, design.md §5), and
// `POST /v4/ai/evaluation-model` (the `vercel` source's Vercel AI Gateway
// wire, whose answers carry confidences under
// `providerMetadata.typesafe.confidence`) — without ever touching a real,
// billed provider.
//
// Structure follows host/agent/settings/testing/fixture-anthropic-server.mjs:
// one small `ctx` object holds the currently scripted scenario plus the
// request log, a `handleRequest` switch maps a scenario name to a response,
// and `startFixtureTypesafeServer` returns the base URL, the port, a
// `setScenario` hook, and the recorded calls. The default success answer is
// DERIVED from the request that arrived (the first offered criterion of each
// required head, one-hot) rather than hard-coded: a capability request and a
// runtime decision request offer different criteria, and the fixture must be
// valid for whichever one it is answering.
//
// Every scenario here is deterministic and scripted; nothing in this file
// talks to a real model or a real network endpoint.

import http from "node:http";

// A one-hot probability map over exactly the offered ids — the shape every
// valid choice answer must have (sum 1, finite [0,1] values, declared choice
// the maximum).
function oneHot(ids, chosen) {
  const probabilities = {};
  for (const id of ids) probabilities[id] = id === chosen ? 1 : 0;
  return probabilities;
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * The structurally valid answer to the questions that just arrived: the first
 * offered criterion of the operation head (or whatever `ctx.chooseOperation`
 * returns), one-hot, plus the same for that operation's own target head when
 * the request offered one. A request that carries no `questions` at all (a
 * malformed caller) still gets this shape with an empty `answers`, which the
 * client must classify as INVALID_RESPONSE just like any other invalid body.
 */
function derivedAnswers(parsedBody) {
  const questions = parsedBody && typeof parsedBody === "object" ? parsedBody.questions : null;
  const answers = {};
  if (questions?.action) {
    for (const [name, head] of Object.entries(questions)) {
      const ids = Object.keys(head.criteria ?? {});
      const chosen = ids[0];
      answers[name] = { choice: chosen, probabilities: oneHot(ids, chosen), confidence: 1 };
    }
    return answers;
  }
  if (!questions || typeof questions !== "object" || !questions.operation) return answers;
  const operationIds = Object.keys(questions.operation.criteria || {});
  if (operationIds.length === 0) return answers;
  const chosenOperation = operationIds[0];
  answers.operation = { choice: chosenOperation, probabilities: oneHot(operationIds, chosenOperation), confidence: 1 };

  const targetHead = questions[`${chosenOperation.toLowerCase()}_target`];
  if (targetHead) {
    const targetIds = Object.keys(targetHead.criteria || {});
    if (targetIds.length > 0) {
      const chosenTarget = targetIds[0];
      answers[`${chosenOperation.toLowerCase()}_target`] = {
        choice: chosenTarget,
        probabilities: oneHot(targetIds, chosenTarget),
        confidence: 1
      };
    }
  }
  return answers;
}

/**
 * A deliberately invalid answer body: the operation choice is not among the
 * offered criteria, so the client's strict validation must refuse it with
 * `INVALID_RESPONSE` (specs/typesafe-jev-provider "Invalid structured answer").
 */
function invalidAnswerBody() {
  return { answers: { operation: { choice: "NOT_AN_OFFERED_OPERATION", probabilities: { NOT_AN_OFFERED_OPERATION: 1 }, confidence: 1 } } };
}

/**
 * Answer one decision request according to the scripted scenario.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {object} ctx
 * @param {string} rawBody
 */
function handleSystemone(res, ctx, rawBody) {
  switch (ctx.systemoneScenario) {
    case "error-401":
      return sendJson(res, 401, { error: { type: "authentication_error", message: "invalid api key" } });
    case "error-403":
      return sendJson(res, 403, { error: { type: "permission_error", message: "forbidden" } });
    case "error-404-model":
      return sendJson(res, 404, { error: { type: "not_found_error", message: "model: jev-latest not found" } });
    case "error-429":
      return sendJson(res, 429, { error: { type: "rate_limit_error", message: "rate limited" } }, { "retry-after": "1" });
    case "error-503":
      return sendJson(res, 503, { error: { type: "overloaded_error", message: "overloaded" } });
    case "error-529":
      return sendJson(res, 529, { error: { type: "overloaded_error", message: "overloaded" } });
    case "error-500":
      return sendJson(res, 500, { error: { type: "api_error", message: "internal error" } });
    case "hang":
      return; // never respond — exercises the caller's deadline / TIMEOUT_ERROR
    case "invalid-response":
      return sendJson(res, 200, ctx.systemoneBody || invalidAnswerBody());
    case "invalid-json":
      return sendJson(res, 200, "not json at all");
    case "empty-body":
      return sendJson(res, 200, {});
    case "success":
    default: {
      if (ctx.systemoneBody) return sendJson(res, ctx.systemoneStatus || 200, ctx.systemoneBody);
      let parsed = null;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        // A caller that sent a non-JSON body still gets a validly shaped
        // answer for an empty question set — the client's own validation is
        // what rejects a malformed request, not this fixture.
      }
      return sendJson(res, 200, { answers: derivedAnswers(parsed), usage: { input_tokens: 12, output_tokens: 4 } });
    }
  }
}

/**
 * Answer one Vercel AI Gateway evaluation request (the `vercel` source's
 * wire): the same answers as the direct endpoint, but each choice's
 * confidence sits under `providerMetadata.typesafe.confidence` rather than on
 * the answer, and usage is camelCase — exactly the shape
 * host/agent/jev/client.js's `normalizeVercelResponse()` is built for.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {object} ctx
 * @param {string} rawBody
 */
function handleVercel(res, ctx, rawBody) {
  switch (ctx.vercelScenario) {
    case "error-401":
      return sendJson(res, 401, { error: { type: "authentication_error", message: "invalid api key" } });
    case "error-429":
      return sendJson(res, 429, { error: { type: "rate_limit_error", message: "rate limited" } }, { "retry-after": "1" });
    case "invalid-response":
      return sendJson(res, 200, ctx.vercelBody || { answers: { operation: { choice: "NOT_AN_OFFERED_OPERATION", probabilities: { NOT_AN_OFFERED_OPERATION: 1 } } } });
    case "success":
    default: {
      if (ctx.vercelBody) return sendJson(res, ctx.vercelStatus || 200, ctx.vercelBody);
      let parsed = null;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        // Same rule as handleSystemone: the client's own validation rejects a
        // malformed request, not this fixture.
      }
      const raw = derivedAnswers(parsed);
      const answers = {};
      const confidence = {};
      for (const [head, answer] of Object.entries(raw)) {
        const { confidence: c, ...rest } = answer;
        answers[head] = rest;
        confidence[head] = typeof c === "number" ? c : 1;
      }
      return sendJson(res, 200, {
        answers,
        providerMetadata: { typesafe: { confidence } },
        usage: { inputTokens: 12, outputTokens: 4 }
      });
    }
  }
}

/**
 * Answer one text-model completion request according to the scripted scenario.
 * The default success content is exactly the `{"text": ...}` object the
 * text-helper requires (design.md §5); `ctx.textValue` overrides the value.
 * `reject-image` models a TEXT-ONLY endpoint: it answers a plain completion and
 * refuses any request whose user message is the multimodal array, which is how
 * the capability test's image stage fails while its text stage passes
 * (openspec/changes/add-jev-run-screenshots design.md §5).
 *
 * @param {import("node:http").ServerResponse} res
 * @param {object} ctx
 * @param {string} rawBody
 */
function handleCompletion(res, ctx, rawBody) {
  switch (ctx.completionScenario) {
    case "error-401":
      return sendJson(res, 401, { error: { type: "invalid_request_error", message: "invalid api key" } });
    case "error-429":
      return sendJson(res, 429, { error: { type: "rate_limit_error", message: "rate limited" } }, { "retry-after": "1" });
    case "error-500":
      return sendJson(res, 500, { error: { type: "server_error", message: "internal error" } });
    case "hang":
      return; // never respond
    case "text-null":
      return sendJson(res, 200, completionBody('{"text": null}'));
    case "invalid-response":
      return sendJson(res, 200, completionBody(ctx.completionText || "this is not a JSON object"));
    case "invalid-json":
      return sendJson(res, 200, "not json at all");
    case "reject-image": {
      let parsed = null;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = null;
      }
      const multimodal = Array.isArray(parsed?.messages?.[1]?.content);
      if (multimodal) {
        return sendJson(res, 400, { error: { type: "invalid_request_error", message: "this model does not support image input" } });
      }
      return sendJson(res, 200, completionBody(JSON.stringify({ text: typeof ctx.textValue === "string" ? ctx.textValue : "fixture text value" })));
    }
    case "success":
    default: {
      if (ctx.completionBody) return sendJson(res, ctx.completionStatus || 200, ctx.completionBody);
      const value = typeof ctx.textValue === "string" ? ctx.textValue : "fixture text value";
      return sendJson(res, 200, completionBody(JSON.stringify({ text: value })));
    }
  }
}

/** The OpenAI-compatible success envelope around a raw assistant message. */
function completionBody(content) {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} ctx
 */
function handleRequest(req, res, ctx) {
  let rawBody = "";
  req.on("data", (chunk) => (rawBody += chunk));
  req.on("end", () => {
    const url = req.url || "";
    const headers = req.headers || {};

    if (req.method !== "POST") {
      return sendJson(res, 404, { error: { type: "not_found_error", message: "unknown route" } });
    }
    if (url.startsWith("/v1/systemone")) {
      ctx.calls.push({ route: "systemone", url, headers, body: rawBody });
      return handleSystemone(res, ctx, rawBody);
    }
    if (url.startsWith("/chat/completions")) {
      ctx.calls.push({ route: "completion", url, headers, body: rawBody });
      return handleCompletion(res, ctx, rawBody);
    }
    if (url.startsWith("/v4/ai/evaluation-model")) {
      ctx.calls.push({ route: "vercel", url, headers, body: rawBody });
      return handleVercel(res, ctx, rawBody);
    }
    return sendJson(res, 404, { error: { type: "not_found_error", message: "unknown route" } });
  });
}

/**
 * Start the fixture server.
 *
 * @param {{
 *   scenario?: string,
 *   systemoneScenario?: string,   // overrides `scenario` for /v1/systemone only
 *   completionScenario?: string,  // overrides `scenario` for /chat/completions only
 *   systemoneBody?: object|string,      // explicit success body (bypasses the derived answer)
 *   completionBody?: object|string,
 *   completionText?: string,            // raw assistant content for the invalid-response scenario
 *   textValue?: string                  // value inside the default {"text": ...} completion
 * }} [opts]
 * @returns {Promise<{
 *   url: string, port: number, close: () => Promise<void>, server: import("node:http").Server,
 *   calls: Array<{route: string, url: string, headers: object, body: string}>,
 *   setScenario: (scenario: string, route?: "systemone"|"completion") => void,
 *   setSystemoneBody: (body: object|string|null, status?: number) => void,
 *   setCompletionBody: (body: object|string|null, status?: number) => void
 * }>}
 */
export async function startFixtureTypesafeServer(opts = {}) {
  const baseScenario = opts.scenario || "success";
  const ctx = {
    systemoneScenario: opts.systemoneScenario || baseScenario,
    vercelScenario: opts.vercelScenario || baseScenario,
    completionScenario: opts.completionScenario || baseScenario,
    systemoneBody: opts.systemoneBody ?? null,
    vercelBody: opts.vercelBody ?? null,
    completionBody: opts.completionBody ?? null,
    completionText: opts.completionText,
    textValue: opts.textValue,
    calls: []
  };

  const server = http.createServer((req, res) => handleRequest(req, res, ctx));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    calls: ctx.calls,
    setScenario: (scenario, route) => {
      if (route === "systemone") ctx.systemoneScenario = scenario;
      else if (route === "vercel") ctx.vercelScenario = scenario;
      else if (route === "completion") ctx.completionScenario = scenario;
      else {
        ctx.systemoneScenario = scenario;
        ctx.vercelScenario = scenario;
        ctx.completionScenario = scenario;
      }
    },
    setSystemoneBody: (body, status) => {
      ctx.systemoneBody = body;
      if (status !== undefined) ctx.systemoneStatus = status;
    },
    setVercelBody: (body, status) => {
      ctx.vercelBody = body;
      if (status !== undefined) ctx.vercelStatus = status;
    },
    setCompletionBody: (body, status) => {
      ctx.completionBody = body;
      if (status !== undefined) ctx.completionStatus = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

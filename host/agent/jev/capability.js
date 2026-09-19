// The three-stage TypeSafe capability test (openspec/changes/
// add-typesafe-jev-provider design.md §9 "Settings surface" and §10
// "Fixtures and offline testing"; openspec/changes/add-jev-run-screenshots
// design.md §5; spec `typesafe-jev-provider`, "TypeSafe capability test").
//
// Stage 1 asks the configured endpoint the runtime's three independent heads
// (action, goal_done, stuck) over a small synthetic observation
// — `POST /v1/systemone`, or the Vercel gateway's
// `POST /v4/ai/evaluation-model` when the profile's source is `vercel` — and
// validates the answer with the same validator a live run uses — a 200 body
// that fails validation is `INVALID_RESPONSE`, not
// a pass. Stage 2 issues one minimal completion against the configured text
// model and requires the reply to parse as exactly `{"text": "..."}` from a
// context whose goal NAMES the value to enter — so a correct model always has
// a value and the stage tests the wire, never the model's judgment. Stage 3
// issues the SAME minimal completion with a small embedded PNG attached, so a
// pass proves the wire accepts image content — the capability the screenshot
// toggle depends on.
//
// All THREE stages are ALWAYS attempted, independently: a broken text model
// must not hide a working TypeSafe endpoint (or the reverse, or anything
// between), because the settings page's job is to tell the operator which
// stage to fix. Stage 3's outcome is recorded but NEVER decides `status`: a
// model that rejects images stays runnable with screenshots disabled
// (design.md §5), so `status` remains systemone AND textModel. Every provider
// failure is classified into the returned `errors` object and never
// propagated — the caller (host/agent/settings/profile.js's `testCapability`)
// records the outcome rather than handling an exception.
//
// Nothing in this module, its requests, or its result ever carries a
// credential: the two keys are used for the Authorization header only.

import {
  postJson,
  systemoneUrl,
  openrouterDecisionsUrl,
  vercelEvaluationUrl,
  vercelRequestBody,
  normalizeVercelResponse,
  VERCEL_PROTOCOL_HEADERS,
  JevError
} from "./client.js";
import { validateDecision, buildDecisionRequest } from "./questions.js";
import {
  buildDecisionProbeRequest,
  buildImageProbeRequest,
  buildSearchProbeRequest,
  decisionRequestAuth,
  decisionRequestUrl,
  decisionWire,
  parseTextResult,
  searchWasPerformed,
  WEB_SEARCH_TOOL_FALLBACK
} from "./text-helper.js";

export const CAPABILITY_GOAL = "Confirm that this provider answers a structured choice question about a page.";

// Stage 2's own goal/field pair. The value to enter is NAMED in the goal, so
// a correct model always has one and only the WIRE is under test. The earlier
// pair (a "Continue" button and a goal about choice questions) let a strong
// model — verified live — correctly answer `{"text": null}` ("there is no
// text to enter"), which is model success and wire-inconclusive, yet the
// recorder classified it as a failed stage. A capability test must not fail
// because the model reasoned correctly.
export const CAPABILITY_TEXT_GOAL = "Type the word OK into the selected field.";
export const CAPABILITY_TEXT_FIELD = Object.freeze({ label: "Confirmation", role: "textbox", value: "" });

// Stage 3's embedded probe image (design.md §5): a real, self-contained 8x8
// PNG held as a host-side constant — small enough to ride one request, valid
// enough that a strict provider cannot reject it as a corrupt image, and
// containing nothing about the user's page or machine. The stage's whole point
// is the WIRE (does this endpoint accept an image part at all), so the probe
// instruction and goal are the text stage's own.
export const CAPABILITY_IMAGE = Object.freeze({
  mimeType: "image/png",
  data:
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGUlEQVR42mO4Y6Px69cvTJIBqyiQZBiUOgBZVIXBXrxGwgAAAABJRU5ErkJggg=="
});

// Exercise the actual runtime builder and all three heads over a tiny page.
function capabilityQuestionBody(model) {
  return buildDecisionRequest({ model, goal: CAPABILITY_GOAL, snapshot: { url: "about:blank", title: "TypeSafe capability check", text: "", elements: [{ ref: "ref_1", role: "button", label: "Continue", tag: "button" }] } }).body;
}

function classifyFailure(err) {
  if (err instanceof JevError) return { code: err.code, message: err.message };
  // Unreachable in practice (postJson always throws a JevError); classified as
  // a protocol failure rather than ever letting an unclassified throw look
  // like a pass.
  return { code: "INVALID_RESPONSE", message: `unclassified capability-test failure: ${err?.message ?? String(err)}` };
}

/**
 * @param {object} opts
 * @param {"typesafe"|"vercel"|"openrouter"} [opts.source] - which Jev wire
 *   this profile uses; the stage-1 request is built exactly as a live
 *   decision for it is
 * @param {string} opts.endpoint - TypeSafe base endpoint (or the Vercel
 *   gateway base when `source` is `vercel`, or the OpenRouter base when it is
 *   `openrouter`)
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {{ baseUrl: string, model: string, apiKey: string }} opts.textModel
 * @param {Function} [opts.fetchImpl] - injectable fetch (tests)
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable backoff (tests)
 * @returns {Promise<{
 *   status: "pass"|"fail",
 *   capabilities: { systemone: "pass"|"fail", textModel: "pass"|"fail", image: "pass"|"fail", search: "pass"|"fail" },
 *   errors: { systemone?: {code: string, message: string}, textModel?: {code: string, message: string}, image?: {code: string, message: string} },
 *   timestamp: string
 * }>}
 */
/**
 * Did this failure reject the web-search tool TYPE, rather than the request?
 * An endpoint that knows server tools but not this generation's type answers
 * 400 naming the type; an endpoint that knows no server tools at all answers
 * the same way about the `tools` field. Both are worth one retry on the
 * earlier type, and neither is worth more than that.
 */
function rejectsToolType(err) {
  const message = String(err?.message ?? "");
  return /tool|web_search|unsupported|unknown|invalid/i.test(message);
}

export async function runTypesafeCapabilityTest({ source = "typesafe", endpoint, apiKey, model, textModel, fetchImpl, timeoutMs, now = Date.now, sleep }) {
  const capabilities = { systemone: "fail", textModel: "fail", image: "fail", search: "fail" };
  const errors = {};

  // Stage 1: the structured-choice endpoint — built on the profile's own
  // source wire (the direct System One request, or the Vercel evaluation
  // request with its pinned headers and confidence normalization), exactly
  // as a live decision is, so a pass proves the protocol this configuration
  // will actually speak.
  try {
    const body = capabilityQuestionBody(model);
    const { json } =
      source === "vercel"
        ? await postJson({
            url: vercelEvaluationUrl(endpoint),
            apiKey,
            body: vercelRequestBody(body),
            extraHeaders: { ...VERCEL_PROTOCOL_HEADERS, "ai-model-id": String(model ?? "") },
            fetchImpl,
            timeoutMs,
            now,
            sleep
          })
        : await postJson({
            url: source === "openrouter" ? openrouterDecisionsUrl(endpoint) : systemoneUrl(endpoint),
            apiKey,
            body,
            fetchImpl,
            timeoutMs,
            now,
            sleep
          });
    const answers = source === "vercel" ? normalizeVercelResponse(json).answers : json && typeof json === "object" ? json.answers : null;
    const answer = validateDecision({ questions: body.questions, answers });
    if (!answer.ok) {
      throw new JevError("INVALID_RESPONSE", `the endpoint answered 200 with a choice answer that failed validation (${answer.reason}); no action executed.`);
    }
    capabilities.systemone = "pass";
  } catch (err) {
    errors.systemone = classifyFailure(err);
  }

  // Stage 2: the decision model. The DECISION-class reasoning parameters are
  // part of the request here exactly as they are in a run, so a capability
  // pass proves what this configuration will actually send — including that
  // the source can answer in the required shape while reasoning is enabled,
  // which is the combination every step of a run depends on. The goal names the value
  // to enter (CAPABILITY_TEXT_GOAL), so a correct model always has one.
  try {
    const body = buildDecisionProbeRequest({
      textModel,
      goal: CAPABILITY_TEXT_GOAL,
      field: { ...CAPABILITY_TEXT_FIELD },
      page: { title: "TypeSafe capability check", text: "" },
      history: []
    });
    const { json } = await postJson({
      url: decisionRequestUrl(textModel),
      apiKey: textModel?.apiKey,
      body,
      ...decisionRequestAuth(textModel),
      fetchImpl,
      timeoutMs,
      now,
      sleep
    });
    const parsed = parseTextResult(json);
    if (!parsed.ok) {
      // The capability stage validates "parses as a JSON object with a single
      // text key" — a reported-missing value is not that, so it is classified
      // as the same malformed-response code here (the runtime keeps the two
      // apart; the capability result only has one text-model failure slot).
      throw new JevError("INVALID_RESPONSE", `${parsed.message}; the text model did not produce the required {"text": ...} object.`);
    }
    capabilities.textModel = "pass";
  } catch (err) {
    errors.textModel = classifyFailure(err);
  }

  // Stage 3: the image probe (openspec/changes/add-jev-run-screenshots
  // design.md §5) — the SAME instruction, goal, field, and transport rules as
  // stage 2, with a small embedded PNG attached. A pass proves the wire
  // accepts image content; a failure names the image stage so the operator can
  // turn the screenshot toggle off or choose a vision-capable model. It is
  // recorded independently and never decides `status` below: a text-only model
  // remains runnable (the toggle exists for exactly that case), and a combined
  // failure could not tell the operator which capability broke.
  try {
    const body = buildImageProbeRequest({
      textModel,
      image: CAPABILITY_IMAGE,
      goal: CAPABILITY_TEXT_GOAL,
      field: { ...CAPABILITY_TEXT_FIELD },
      page: { title: "TypeSafe capability check", text: "" },
      history: []
    });
    const { json } = await postJson({
      url: decisionRequestUrl(textModel),
      apiKey: textModel?.apiKey,
      body,
      ...decisionRequestAuth(textModel),
      fetchImpl,
      timeoutMs,
      now,
      sleep
    });
    const parsed = parseTextResult(json);
    if (!parsed.ok) {
      // Same classification rule as stage 2: a reported-missing value and any
      // other unusable body are both "the wire did not answer the probe's
      // required shape" (the capability result has one slot per stage).
      throw new JevError("INVALID_RESPONSE", `${parsed.message}; the text model did not produce the required {"text": ...} object for the image test.`);
    }
    capabilities.image = "pass";
  } catch (err) {
    errors.image = classifyFailure(err);
  }

  // Stage 4: the provider-side web search. Established by ASKING, never
  // inferred from the source's name — two endpoints carrying the same name
  // differ, a gateway may translate a request into a protocol that has no
  // server tools, and a model old enough speaks only the earlier tool type.
  // So the stage runs a real search and reads the result blocks: a declared
  // tool the endpoint accepted and then ignored is a failure here, because a
  // pass tells the operator the answer call can search.
  //
  // Its outcome NEVER decides `status`. Search is supporting material for the
  // answer, not a requirement of driving a browser, and a profile without it
  // consults the URLs the decision model can name exactly as before.
  try {
    if (decisionWire(textModel) !== "anthropic") {
      throw new JevError("SEARCH_UNAVAILABLE", "this decision-model transport has no provider-side search; the run consults named URLs instead.");
    }
    let searched = null;
    for (const toolType of [undefined, WEB_SEARCH_TOOL_FALLBACK]) {
      try {
        const { json } = await postJson({
          url: decisionRequestUrl(textModel),
          apiKey: textModel?.apiKey,
          body: buildSearchProbeRequest({ textModel, ...(toolType ? { toolType } : {}) }),
          ...decisionRequestAuth(textModel),
          fetchImpl,
          timeoutMs,
          now,
          sleep
        });
        searched = searchWasPerformed(json);
        break;
      } catch (err) {
        // A rejected tool TYPE is the one failure worth a second attempt: the
        // earlier type exists for models that predate the current one. Any
        // other failure is this stage's answer.
        if (toolType || !rejectsToolType(err)) throw err;
      }
    }
    if (!searched || !searched.ok) {
      throw new JevError("SEARCH_UNAVAILABLE", searched ? searched.reason : "the search probe produced no answer");
    }
    capabilities.search = "pass";
  } catch (err) {
    errors.search = classifyFailure(err);
  }

  const status = capabilities.systemone === "pass" && capabilities.textModel === "pass" ? "pass" : "fail";
  return { status, capabilities, errors, timestamp: new Date(now()).toISOString() };
}

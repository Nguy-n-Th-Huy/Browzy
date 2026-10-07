// The TypeSafe "System One" decision client (openspec/changes/
// add-typesafe-jev-provider design.md §4 "Decision client"; spec
// `typesafe-jev-provider`, "Single-request decision protocol with strict
// validation").
//
// One POST /v1/systemone per decision cycle, Bearer-authenticated, carrying
// the request body questions.js built. This module owns exactly three things
// and nothing else (it never touches the browser, the run, or any cache):
//
//   1. the retry policy, ported from the reference's `post_json`
//      (browser-use/jev-ultrafast jev_ultrafast/model.py): statuses
//      429/503/529 get at most 2 retries with a 0.5 * 2^n second backoff;
//      every other outcome fails immediately. The same helper is exported
//      (`postJson`) so the text helper and the capability test speak to their
//      endpoints with the identical policy instead of a second copy of it —
//      the reference shares one `post_json` across both calls too.
//      One deliberate extension beyond the reference: a TRANSPORT failure
//      (timeout or dropped connection) gets ONE repeat as well, because
//      every call through this helper is read-only — a decision, a text
//      value, a capability probe — and a mutation only ever happens later,
//      through the guarded action dispatch on a different call path, so
//      repeating a lost read can never double-apply anything. A live,
//      observed provider stall window (2026-09) killed an otherwise-healthy
//      request mid-run; this repeat is what turns that into a hiccup.
//   2. the failure taxonomy: every non-success becomes a typed `JevError`
//      carrying a `code`, so a caller can distinguish an auth failure from a
//      rate limit from a structurally invalid 200 body. The code strings for
//      the transport/response failures are the ones
//      host/agent/settings/errors.js's PROVIDER_ERROR_CODES already uses
//      (`AUTH_ERROR`, `RATE_LIMIT_ERROR`, `MODEL_UNAVAILABLE_ERROR`,
//      `TIMEOUT_ERROR`, `NETWORK_ERROR`, `INVALID_RESPONSE`) so the settings
//      layer can record a capability result without translating between two
//      vocabularies. `MISSING_VALUE` is the one addition, and it is produced
//      only by the text helper's `{"text": null}` outcome (design.md §5); it
//      never leaves this subsystem as a provider code.
//   3. answer validation, delegated to questions.js's
//      `validateDecision` — the reference validates in `choose()` right after
//      its own `post_json`, and design.md §4 pins the same shape here
//      ("The client returns the validated decision plus usage and latency").
//      A 200 body that fails validation is INVALID_RESPONSE, never a
//      partially-trusted decision.
//
// A profile's Jev "source" picks the wire: `typesafe` (default) is the
// provider's own `POST /v1/systemone`; `vercel` is the Vercel AI Gateway's
// `POST /v4/ai/evaluation-model`; `openrouter` is OpenRouter's
// `POST /api/alpha/decisions` (see the dedicated sections below the URL
// helpers) — same typed questions, different transport, credentials, and
// confidence placement. Everything else — retry policy, taxonomy,
// validation — is shared, so every source ends in exactly one validated
// decision shape.
//
// None of these sources is a chat-completion or Messages endpoint, and Jev is
// never reachable through one: it answers a `state` plus typed `questions`
// over its own decision route, and a provider's general-purpose ports refuse
// the model outright (the Vercel gateway says so in as many words —
// "evaluation model, not a language model").

import { validateDecision, decisionRequestBytes, MAX_REQUEST_BYTES, DecisionRequestTooLargeError } from "./questions.js";

export const JEV_ERROR_CODES = Object.freeze([
  "AUTH_ERROR",
  "RATE_LIMIT_ERROR",
  "MODEL_UNAVAILABLE_ERROR",
  "TIMEOUT_ERROR",
  "NETWORK_ERROR",
  "INVALID_RESPONSE",
  "MISSING_VALUE"
]);

export class JevError extends Error {
  /**
   * @param {string} code - one of JEV_ERROR_CODES
   * @param {string} message - operator-facing, names the failed stage and
   *   states that no action executed
   * @param {{ cause?: unknown, detail?: Record<string, unknown> }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JevError";
    this.code = code;
    this.detail = opts.detail || {};
  }
}

// Reference: httpx.Client(timeout=25) in model.py.
export const DEFAULT_TIMEOUT_MS = 25_000;
export const RETRYABLE_STATUSES = Object.freeze([429, 503, 529]);
export const MAX_RETRIES = 2;
// A transport failure (timeout / dropped connection) gets ONE repeat; see the
// file header's rationale (read-only calls, no double-apply surface).
export const MAX_TRANSPORT_RETRIES = 1;

/** The reference's `time.sleep(0.5 * 2**attempt)` backoff, in milliseconds. */
export function backoffDelayMs(attempt) {
  return 0.5 * 2 ** attempt * 1000;
}

export function systemoneUrl(endpoint) {
  return `${String(endpoint ?? "").replace(/\/+$/, "")}/v1/systemone`;
}

// --- The Vercel AI Gateway source -----------------------------------------
//
// A `vercel`-source typesafe profile reaches the SAME Jev model through the
// Vercel AI Gateway instead of TypeSafe's own endpoint. The gateway exposes
// evaluation models only through its AI-SDK protocol — its
// Anthropic-compatible and OpenAI-compatible endpoints refuse the model
// outright ("evaluation model, not a language model") — so the constants
// below are that wire, captured from the AI SDK's own requests (ai@7.0.105,
// 2026-09) and pinned here: the model rides in the `ai-model-id` header, the
// body drops `model` and carries an empty `providerOptions`, and each
// answer's confidence arrives under `providerMetadata.typesafe.confidence`
// instead of on the answer itself. These header literals are deliberately
// explicit versions: a gateway protocol change makes the capability test
// fail loudly (MODEL_UNAVAILABLE_ERROR / INVALID_RESPONSE — never a silent
// bad decision), and this block is the one place to update.
export const VERCEL_EVALUATION_PATH = "/v4/ai/evaluation-model";
export const VERCEL_PROTOCOL_HEADERS = Object.freeze({
  "ai-evaluation-model-specification-version": "4",
  "ai-gateway-auth-method": "api-key",
  "ai-gateway-protocol-version": "0.0.1"
});

export function vercelEvaluationUrl(endpoint) {
  return `${String(endpoint ?? "").replace(/\/+$/, "")}${VERCEL_EVALUATION_PATH}`;
}

/**
 * The gateway's request body: the same `state`/`questions` the direct source
 * sends, with `model` stripped (it rides in the `ai-model-id` header) and the
 * empty `providerOptions` object every AI SDK request carries. Never mutates
 * the original body.
 */
export function vercelRequestBody(body) {
  return { state: body?.state, questions: body?.questions, providerOptions: {} };
}

/**
 * Normalize a gateway evaluation response into the shape `validateDecision`
 * reads. The gateway reports each choice's confidence in
 * `providerMetadata.typesafe.confidence[head]` rather than on the answer;
 * this lifts it onto the answer ONLY when the answer itself carries no
 * numeric confidence — an absent value stays absent, and the validator
 * refuses that decision rather than a missing number being invented.
 * Non-object answers and a response without answers pass through untouched
 * (the validator refuses them). Pure: never mutates `json`.
 *
 * @returns {{ answers: unknown, usage: object }}
 */
export function normalizeVercelResponse(json) {
  const answers = json && typeof json === "object" ? json.answers : null;
  const shared = json && typeof json === "object" ? json?.providerMetadata?.typesafe?.confidence : null;
  let normalized = answers;
  if (answers && typeof answers === "object" && !Array.isArray(answers) && shared && typeof shared === "object") {
    normalized = {};
    for (const [head, answer] of Object.entries(answers)) {
      normalized[head] =
        answer && typeof answer === "object" && typeof answer.confidence !== "number" && typeof shared[head] === "number"
          ? { ...answer, confidence: shared[head] }
          : answer;
    }
  }
  const usage = json && typeof json === "object" && json.usage && typeof json.usage === "object" ? json.usage : {};
  return { answers: normalized, usage };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify a non-2xx HTTP status into the taxonomy (design.md §4's list, with
 * one documented assignment per status family):
 *   401/403                       -> AUTH_ERROR
 *   429                           -> RATE_LIMIT_ERROR
 *   500/502/503/504/529           -> MODEL_UNAVAILABLE_ERROR
 *   any other non-2xx             -> INVALID_RESPONSE (the endpoint answered
 *                                    something this protocol cannot use)
 */
export function classifyStatus(status) {
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 429) return "RATE_LIMIT_ERROR";
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return "MODEL_UNAVAILABLE_ERROR";
  return "INVALID_RESPONSE";
}

/**
 * The provider's own human-readable reason out of a non-2xx body, bounded.
 * Shaped for the Vercel gateway's error envelope
 * (`{"error":{"message":"…"}}`), whose message is sometimes itself a JSON
 * string (`{"error_type":"max_tokens_exceeded"}`) — unwrapped once more in
 * that case, because that inner token is the actionable fact. Returns "" for
 * anything it cannot read; the caller then falls back to the classified
 * status alone, never to a fabricated reason.
 *
 * @param {string} rawBody
 * @returns {string}
 */
export function extractProviderMessage(rawBody) {
  if (typeof rawBody !== "string" || rawBody.trim() === "") return "";
  const unwrap = (value) => {
    if (typeof value !== "string" || value.trim() === "") return "";
    try {
      const inner = JSON.parse(value);
      if (inner && typeof inner === "object") {
        if (typeof inner.error_type === "string" && inner.error_type) return inner.error_type;
        if (typeof inner.message === "string" && inner.message) return inner.message;
        return "";
      }
    } catch {
      // not JSON — the value itself is the message
    }
    return value;
  };
  try {
    const parsed = JSON.parse(rawBody);
    const message = parsed && typeof parsed === "object" ? parsed?.error?.message : null;
    const text = unwrap(message);
    if (text) return text.slice(0, 160);
  } catch {
    // fall through to the raw body
  }
  return rawBody.trim().slice(0, 160);
}

/** The preview's ceiling, in characters (the `…` that marks a cut is extra). */
const BODY_PREVIEW_LIMIT = 120;

/**
 * The readable beginning of a non-JSON body, for the failure message and its
 * detail: whitespace runs collapsed to single spaces, trimmed, capped so an
 * HTML page cannot dump its whole self into an error, with `…` marking the
 * cut. The live case this exists for — a gateway's SPA HTML served in place of
 * the endpoint — is recognizable from the first few characters, and 120 of
 * them are bounded the way the non-2xx path's 500-character body already is.
 *
 * @param {string} rawBody
 * @returns {string}
 */
function bodyPreview(rawBody) {
  const collapsed = String(rawBody ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > BODY_PREVIEW_LIMIT ? `${collapsed.slice(0, BODY_PREVIEW_LIMIT)}…` : collapsed;
}

/**
 * POST a JSON body with the shared retry policy. Throws JevError; returns the
 * parsed JSON on success. Never retries a network failure or a timeout — the
 * reference only retries the three retryable statuses, and a lost response is
 * exactly the case where a blind retry could double-apply something.
 *
 * A 2xx body that cannot be parsed as JSON is INVALID_RESPONSE with the
 * response's content type and a bounded preview of the body in the message and
 * in `detail: { status, contentType?, bodyPreview?, emptyBody?, bodyUnreadable? }`
 * — a misrouted endpoint (an HTML page in place of the API) is attributable
 * from the failure itself.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.apiKey
 * @param {object} opts.body
 * @param {Record<string, string>} [opts.extraHeaders] - source-specific
 *   protocol headers (the Vercel evaluation wire's pinned literals). Merged
 *   UNDER the fixed headers below, so a source can add protocol fields but
 *   can never override Authorization/Content-Type/Accept.
 * @param {Function} [opts.fetchImpl] - injectable fetch (tests)
 * @param {number} [opts.timeoutMs]
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @returns {Promise<{ json: unknown, latencyMs: number, status: number }>}
 */
export async function postJson({ url, apiKey, body, extraHeaders, authHeader, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, sleep = defaultSleep }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new JevError("NETWORK_ERROR", "no fetch implementation is available to reach the provider; no action executed.");
  }
  if (!apiKey) {
    throw new JevError("AUTH_ERROR", "no credential is configured for this provider call; no action executed.");
  }

  const startedAt = now();
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    let response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          // Source-specific protocol headers first: they may add fields, but
          // the fixed ones below always win their own names.
          ...(extraHeaders || {}),
          // Every Jev source and every OpenAI-compatible host authenticates
          // with a Bearer token; the Anthropic Messages wire authenticates
          // with `x-api-key` instead, and sending a Bearer beside it would
          // ask that API to read the key as an OAuth token. One named header
          // per call, never both.
          ...(authHeader ? { [authHeader]: apiKey } : { Authorization: `Bearer ${apiKey}` }),
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      // Our own timeout aborts the request, so the abort is the authority on
      // which of the two it was — a provider that closes the socket early
      // still lands in NETWORK_ERROR via the signal's un-aborted state.
      const code = controller.signal.aborted ? "TIMEOUT_ERROR" : "NETWORK_ERROR";
      // One bounded repeat for a transient stall (see MAX_TRANSPORT_RETRIES'
      // and the file header's rationale: every call here is read-only, so a
      // repeat can never double-apply anything).
      if (attempt < MAX_TRANSPORT_RETRIES) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw new JevError(code, `${code === "TIMEOUT_ERROR" ? "the provider request timed out" : "the provider request failed at the network layer"}: ${err?.message ?? String(err)}; no action executed.`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    const status = Number(response?.status);
    if (RETRYABLE_STATUSES.includes(status) && attempt < MAX_RETRIES) {
      await sleep(backoffDelayMs(attempt));
      continue;
    }
    if (!(status >= 200 && status < 300)) {
      const code = classifyStatus(status);
      // Read the provider's own message (bounded) before throwing: the
      // Vercel gateway reports the real cause in the body (e.g.
      // `max_tokens_exceeded`, "TypeSafe Choice questions support at most
      // 255 options"), and that text is what lets the operator fix the cause
      // instead of reading a bare 4xx. Best-effort — a body that cannot be
      // read never replaces the classified status error.
      let providerMessage = "";
      let rawBody = "";
      try {
        rawBody = await response.text();
        providerMessage = extractProviderMessage(rawBody);
      } catch {
        // classification stands on its own
      }
      // A retryable status that exhausted its retries is still its own
      // classification (RATE_LIMIT_ERROR / MODEL_UNAVAILABLE_ERROR), which is
      // what tells the operator "try again later" rather than "fix settings".
      throw new JevError(code, `the provider returned HTTP ${status}${providerMessage ? ` (${providerMessage})` : ""}; no action executed.`, {
        detail: { status, ...(providerMessage ? { providerMessage } : {}), ...(rawBody ? { body: rawBody.slice(0, 500) } : {}) }
      });
    }

    // Read the success body once as TEXT, then parse it. Reading first is what
    // makes a non-JSON body attributable: `response.json()` consumes the body
    // with no way to see what was actually served, so the failure could only
    // assert "not JSON". The live case — a gateway answering an unknown route
    // with its SPA HTML — is now named by its content type and its opening
    // characters. Bounded by the response already in hand: no re-fetch.
    let rawBody;
    try {
      rawBody = await response.text();
    } catch (err) {
      // A body that cannot be read at all has nothing to preview; the
      // classification message stands unchanged, flagged in the detail.
      throw new JevError("INVALID_RESPONSE", `the provider answered HTTP ${status} with a body that is not JSON; no action executed.`, {
        cause: err,
        detail: { status, bodyUnreadable: true }
      });
    }

    let json;
    try {
      json = JSON.parse(rawBody);
    } catch (err) {
      const contentType = typeof response.headers?.get === "function" ? response.headers.get("content-type") : null;
      const preview = bodyPreview(rawBody);
      // An unparseable body that is empty (or whitespace-only) says so rather
      // than quoting an empty start; anything else quotes its beginning.
      const described = `content-type ${contentType || "unknown"}; ${preview ? `body starts: ${JSON.stringify(preview)}` : "the body is empty"}`;
      throw new JevError("INVALID_RESPONSE", `the provider answered HTTP ${status} with a body that is not JSON (${described}); no action executed.`, {
        cause: err,
        detail: {
          status,
          ...(contentType ? { contentType } : {}),
          ...(preview ? { bodyPreview: preview } : {}),
          ...(rawBody === "" ? { emptyBody: true } : {})
        }
      });
    }
    return { json, latencyMs: now() - startedAt, status };
  }
}

// --- The OpenRouter source ------------------------------------------------
//
// An `openrouter`-source typesafe profile reaches the SAME Jev model through
// OpenRouter's decision route. The request is the direct source's body — the
// model id (namespaced, e.g. `typesafe/jev-1.13`), the `state`, and the typed
// `questions` — posted to `/api/alpha/decisions` with the account's Bearer
// key. OpenRouter publishes this route under `/alpha/`, so it is the source
// whose protocol is most likely to move; keeping its path in one exported
// constant is what makes a move show up as one loud capability failure
// (MODEL_UNAVAILABLE_ERROR / INVALID_RESPONSE) instead of a quietly wrong
// decision.
//
// Response shape: read as the direct source's — `answers[head]` carrying the
// choice, its probabilities, and its own numeric `confidence`. There is
// deliberately NO normalizer lifting a confidence from somewhere else here,
// because none has been observed on this route: if the route reports
// confidence elsewhere, `validateDecision` refuses the answer and the run
// reports an invalid decision, which is the honest outcome. A normalizer is
// written only against a captured live response, exactly as the Vercel
// constants above were captured — never from a guess, because the selection
// floor acts on that number.
export const OPENROUTER_DECISIONS_PATH = "/api/alpha/decisions";

export function openrouterDecisionsUrl(endpoint) {
  return `${String(endpoint ?? "").replace(/\/+$/, "")}${OPENROUTER_DECISIONS_PATH}`;
}

// --- The RunAnywhere source -----------------------------------------------
//
// A `runanywhere`-source profile asks RunAnywhere's Eve decision model
// (`POST /v1/decisions`, https://docs.runanywhere.ai/wally-cloud/decisions).
// Its wire differs from Jev's in three ways, all bridged here so the rest of
// the subsystem keeps speaking the one Jev shape:
//
//   - the request is `{ model, input, questions: [...] }`: the Jev `state`
//     rides as the JSON `input` string, and each Jev head becomes one array
//     question — a `yes`/`no` head as `yes_no` (its criteria as the labels),
//     every other head as `choice` with `options: [{ name, description }]`;
//   - a `choice` question takes at most RUNANYWHERE_MAX_OPTIONS options, while
//     a Jev action head offers up to 250. A larger head is decided as a
//     two-round bracket: the options are split into balanced groups asked
//     together in the first request, then the group winners are asked in a
//     second. Every option is offered, none is dropped;
//   - the answer carries `probabilities` (summing to 1) but no `confidence`.
//     The confidence is the chosen option's probability. For a bracket, an
//     option's probability is P(its group's winner wins the final) * P(it
//     wins its group), which still sums to 1 across every offered option, and
//     the choice is the highest of those — so `validateDecision` checks a
//     bracket answer exactly as it checks a direct one.
export const RUNANYWHERE_DECISIONS_PATH = "/v1/decisions";
export const RUNANYWHERE_MAX_OPTIONS = 26;

export function runanywhereDecisionsUrl(endpoint) {
  return `${String(endpoint ?? "").replace(/\/+$/, "")}${RUNANYWHERE_DECISIONS_PATH}`;
}

function runanywhereQuestionText(head) {
  const rules = head?.instructions?.rules;
  const text = Array.isArray(rules) ? rules.join("\n") : typeof rules === "string" ? rules : "";
  const extra = head?.instructions && typeof head.instructions === "object" ? { ...head.instructions } : {};
  delete extra.rules;
  const context = Object.keys(extra).length ? `\n${JSON.stringify(extra)}` : "";
  return `${text || "Choose the best option."}${context}`;
}

function isYesNoCriteria(ids) {
  return ids.length === 2 && ids.includes("yes") && ids.includes("no");
}

/** Split `ids` into the fewest balanced groups of at most `max` ids each. */
function balancedGroups(ids, max) {
  const count = Math.ceil(ids.length / max);
  const groups = [];
  for (let g = 0, start = 0; g < count; g++) {
    const size = Math.floor(ids.length / count) + (g < ids.length % count ? 1 : 0);
    groups.push(ids.slice(start, start + size));
    start += size;
  }
  return groups;
}

function runanywhereQuestion(id, question, ids, criteria) {
  if (isYesNoCriteria(ids)) return { id, type: "yes_no", question, yes: String(criteria.yes ?? "yes"), no: String(criteria.no ?? "no") };
  return { id, type: "choice", question, options: ids.map((name) => ({ name, description: String(criteria[name] ?? "") })) };
}

/** The answer's probabilities over exactly `ids`, or null when they do not cover them. */
function runanywhereProbabilities(json, qid, ids) {
  const probabilities = json?.answers?.[qid]?.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return null;
  const picked = {};
  for (const id of ids) {
    if (typeof probabilities[id] !== "number") return null;
    picked[id] = probabilities[id];
  }
  return picked;
}

function choiceAnswer(probabilities) {
  const ids = Object.keys(probabilities);
  const choice = ids.reduce((best, id) => (probabilities[id] > probabilities[best] ? id : best), ids[0]);
  return { choice, probabilities, confidence: probabilities[choice] };
}

/**
 * Ask RunAnywhere every head of a Jev body and return Jev-shaped `answers`
 * (still to be validated by the caller) plus summed usage.
 */
async function runanywhereAnswers({ endpoint, apiKey, model, body, post }) {
  const heads = Object.entries(body?.questions ?? {}).filter(([, head]) => head && typeof head === "object" && !Array.isArray(head));
  const input = JSON.stringify(body?.state ?? {});
  const answers = {};
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  const ask = async (questions) => {
    const { json } = await post({ url: runanywhereDecisionsUrl(endpoint), apiKey, body: { model, input, questions } });
    usage.prompt_tokens += Number(json?.usage?.prompt_tokens) || 0;
    usage.total_tokens += Number(json?.usage?.total_tokens) || 0;
    return json;
  };
  const missing = (qid) =>
    new JevError("INVALID_RESPONSE", `RunAnywhere returned no usable probabilities for "${qid}"; no action executed.`, { detail: { reason: `${qid}:probabilities_missing` } });

  // Round 1: every head (a large head as its groups) in one request.
  const round1 = [];
  const plans = [];
  for (const [name, head] of heads) {
    const criteria = head.criteria ?? {};
    const ids = Object.keys(criteria);
    const question = runanywhereQuestionText(head);
    if (ids.length === 1) {
      // One offered option is the whole probability mass; there is nothing to ask.
      answers[name] = choiceAnswer({ [ids[0]]: 1 });
    } else if (ids.length <= RUNANYWHERE_MAX_OPTIONS) {
      round1.push(runanywhereQuestion(name, question, ids, criteria));
      plans.push({ name, ids });
    } else {
      const groups = balancedGroups(ids, RUNANYWHERE_MAX_OPTIONS);
      if (groups.length > RUNANYWHERE_MAX_OPTIONS) throw new DecisionRequestTooLargeError();
      groups.forEach((group, g) => round1.push(runanywhereQuestion(`${name}__g${g}`, question, group, criteria)));
      plans.push({ name, ids, groups, question, criteria });
    }
  }
  if (!round1.length) return { answers, usage };
  const first = await ask(round1);

  // Round 2: the final between each bracketed head's group winners.
  const finals = [];
  for (const plan of plans) {
    if (!plan.groups) {
      const probabilities = runanywhereProbabilities(first, plan.name, plan.ids);
      if (!probabilities) throw missing(plan.name);
      answers[plan.name] = choiceAnswer(probabilities);
      continue;
    }
    plan.groupProbabilities = plan.groups.map((group, g) => {
      const probabilities = runanywhereProbabilities(first, `${plan.name}__g${g}`, group);
      if (!probabilities) throw missing(`${plan.name}__g${g}`);
      return probabilities;
    });
    plan.winners = plan.groupProbabilities.map((probabilities) => choiceAnswer(probabilities).choice);
    finals.push(runanywhereQuestion(`${plan.name}__final`, plan.question, plan.winners, plan.criteria));
  }
  if (finals.length) {
    const second = await ask(finals);
    for (const plan of plans.filter((p) => p.groups)) {
      const final = runanywhereProbabilities(second, `${plan.name}__final`, plan.winners);
      if (!final) throw missing(`${plan.name}__final`);
      const probabilities = {};
      plan.groups.forEach((group, g) => {
        for (const id of group) probabilities[id] = final[plan.winners[g]] * plan.groupProbabilities[g][id];
      });
      answers[plan.name] = choiceAnswer(probabilities);
    }
  }
  return { answers, usage };
}

// --- The OpenAI Decisions source ------------------------------------------
//
// An `openai`-source profile asks OpenAI's Decisions API (`POST /v1/decisions`,
// model `gpt-6-luna`), which answers typed questions over text and inline
// images. Every question is a `choice` (a yes/no head too: the `predicate`
// type returns no `confidence`, which the validator needs), every offered
// option is sent without bracketing, and the `answers` array is mapped back to
// the Jev shape. The runtime's `action` head is asked factored (operation, then
// element per operation; see below) in the same request. A missing probability
// or confidence is a malformed response; nothing is derived or invented.
export const OPENAI_DECISIONS_PATH = "/v1/decisions";

export function openaiDecisionsUrl(endpoint) {
  return `${String(endpoint ?? "").replace(/\/+$/, "")}${OPENAI_DECISIONS_PATH}`;
}

// The runtime's `action` head offers every element once per operation, each
// described only as `{"operation","ref"}`. Jev is trained on that table; a
// general decision model is not: CLICK and HOVER on the same element split the
// mass between them, and a bare ref has to be looked up in `state.elements`.
// Observed live (2026-10): top choices of 0.1–0.3 with a runner-up within 0.05,
// so most cycles abstained. The `action` head is therefore asked factored, in
// the same single request: one `operation` question over the operation
// families, and one `target_<OPERATION>` question per family that offers more
// than one candidate, each choice described by the element's role and label.
// The joint P(key) = P(operation) * P(key | operation) sums to 1 over every
// offered key, so `validateDecision` checks it exactly as a direct answer.
const OPENAI_OPERATION_DESCRIPTIONS = Object.freeze({
  CLICK: "Click an element: links, buttons, checkboxes, radios, tabs, fields to focus.",
  HOVER: "Only move the pointer over an element to open a pointer-only menu. Never for a link or button that should be activated.",
  TYPE_TEXT: "Type prepared text into a field. For a date field with a prepared date, type it rather than using its calendar.",
  SELECT: "Choose an option in a dropdown (native select).",
  NAVIGATE: "Open a prepared URL.",
  SCROLL_DOWN: "Scroll down to reveal more of the page.",
  SCROLL_UP: "Scroll up.",
  WAIT: "Wait for the page to finish changing.",
  REPLAN: "Request fresh planning or content for a new field.",
  ASK: "Ask the operator for help.",
  DONE: "Request verification that the goal is complete; never proves success."
});

function parseActionCriterion(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && typeof parsed.operation === "string" && parsed.operation ? parsed : null;
  } catch {
    return null;
  }
}

function describeOpenAITarget(action, element) {
  const role = element?.role ? `${element.role} ` : "";
  const label = element?.label ? JSON.stringify(element.label) : "(no label)";
  const parts = [`${role}${label} [${action.ref}]`];
  if (element?.value) parts.push(`current value ${JSON.stringify(element.value)}`);
  if (action.option !== undefined) parts.push(`option ${JSON.stringify(action.option)}`);
  else if (action.value !== undefined) parts.push(`value ${JSON.stringify(action.value)}`);
  if (action.url) parts.push(`url ${action.url}${action.purpose ? ` (${action.purpose})` : ""}`);
  return parts.join(", ");
}

/**
 * The factored questions for a runtime `action`/`goal_done`/`stuck` body, or
 * null when the body is not that protocol or an action criterion cannot be
 * read (then every head is asked as-is).
 */
function openaiFactoredQuestions(body) {
  const heads = body?.questions;
  if (!heads?.action || !heads.goal_done || !heads.stuck) return null;
  const families = new Map();
  for (const [key, text] of Object.entries(heads.action.criteria ?? {})) {
    const action = parseActionCriterion(text);
    if (!action) return null;
    if (!families.has(action.operation)) families.set(action.operation, []);
    families.get(action.operation).push({ key, action });
  }
  if (!families.size) return null;
  const elements = new Map((Array.isArray(body?.state?.elements) ? body.state.elements : []).map((el) => [el?.ref, el]));
  const rules = runanywhereQuestionText(heads.action);
  const questions = [];
  if (families.size > 1) {
    questions.push({
      type: "choice",
      name: "operation",
      instructions: `${rules}\nChoose the kind of action to take next; the element is chosen separately.`,
      choices: [...families.keys()].map((value) => ({ value, description: OPENAI_OPERATION_DESCRIPTIONS[value] ?? value }))
    });
  }
  for (const [operation, members] of families) {
    if (members.length < 2) continue;
    questions.push({
      type: "choice",
      name: `target_${operation}`,
      instructions: `${rules}\nIf the next action is ${operation}, which element should it act on?`,
      choices: members.map(({ key, action }) => ({ value: key, description: describeOpenAITarget(action, elements.get(action.ref)) }))
    });
  }
  for (const name of ["goal_done", "stuck"]) {
    const head = heads[name];
    questions.push({
      type: "choice",
      name,
      instructions: runanywhereQuestionText(head),
      choices: Object.keys(head.criteria ?? {}).map((value) => ({ value, description: String(head.criteria[value] ?? "") }))
    });
  }
  return { questions, families };
}

/** Recompose the factored answers into the Jev `action` answer (joint probabilities). */
function composeFactoredAction(answers, families) {
  const operationProbabilities = families.size > 1 ? answers.operation.probabilities : { [families.keys().next().value]: 1 };
  const probabilities = {};
  for (const [operation, members] of families) {
    const within = members.length > 1 ? answers[`target_${operation}`].probabilities : { [members[0].key]: 1 };
    for (const { key } of members) probabilities[key] = operationProbabilities[operation] * within[key];
  }
  return choiceAnswer(probabilities);
}

/**
 * The OpenAI request for one Jev body, plus the answers decided locally.
 * `input` is the state JSON string, or one user message carrying the state and
 * an inline base64 `input_image` when `image` ({ data, mimeType }) is given.
 * A head with exactly one option is answered locally (probability 1) and not
 * sent; `request.questions` is empty when nothing remains to ask.
 */
export function openaiRequestBody(body, image) {
  const stateText = JSON.stringify(body?.state ?? {});
  const hasImage = image && typeof image.data === "string" && image.data && typeof image.mimeType === "string" && image.mimeType;
  const input = hasImage
    ? [
        {
          role: "user",
          content: [
            { type: "input_text", text: stateText },
            { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }
          ]
        }
      ]
    : stateText;
  const factored = openaiFactoredQuestions(body);
  if (factored) return { request: { input, questions: factored.questions }, local: {}, factored };
  const questions = [];
  const local = {};
  const heads = Object.entries(body?.questions ?? {}).filter(([, head]) => head && typeof head === "object" && !Array.isArray(head));
  for (const [name, head] of heads) {
    const criteria = head.criteria ?? {};
    const ids = Object.keys(criteria);
    if (ids.length === 1) {
      local[name] = choiceAnswer({ [ids[0]]: 1 });
    } else {
      questions.push({
        type: "choice",
        name,
        instructions: runanywhereQuestionText(head),
        choices: ids.map((value) => ({ value, description: String(criteria[value] ?? "") }))
      });
    }
  }
  return { request: { input, questions }, local };
}

/** Map OpenAI's `answers[]` to Jev answers for the asked `questions`; throws INVALID_RESPONSE on any gap. */
export function normalizeOpenAIResponse(json, questions) {
  const bad = (reason) => new JevError("INVALID_RESPONSE", `OpenAI returned an unusable decision (${reason}); no action executed.`, { detail: { reason } });
  const list = json && typeof json === "object" ? json.answers : null;
  if (!Array.isArray(list)) throw bad("answers_missing");
  const answers = {};
  for (const question of questions) {
    const item = list.find((entry) => entry && typeof entry === "object" && entry.name === question.name);
    if (!item) throw bad(`${question.name}:answer_missing`);
    // Observed live (2026-10-07): the API may abstain from a conditional
    // `target_<OPERATION>` question ("if the next action is X, which
    // element?") when it judges X unlikely — the answer then carries only
    // `type` and `name`. An abstention expresses no preference within that
    // family, so it is uniform there; the joint and the selection floor decide
    // whether anything in it is decisive enough to act. Every other question
    // must be answered in full.
    const abstained = item.choice === undefined && item.probabilities === undefined && item.confidence === undefined;
    if (abstained && question.name.startsWith("target_")) {
      const uniform = Object.fromEntries(question.choices.map(({ value }) => [value, 1 / question.choices.length]));
      answers[question.name] = { choice: question.choices[0].value, probabilities: uniform, confidence: 0 };
      continue;
    }
    if (!Array.isArray(item.probabilities)) {
      // Observed live (2026-10-07): an answer to a many-choice question came
      // back without the documented array. Its shape — never its values — is
      // named so the log shows what the API actually sent.
      const kind = item.probabilities === null ? "null" : typeof item.probabilities;
      throw bad(`${question.name}:probabilities_missing; answer fields ${Object.keys(item).join(",")}; probabilities ${kind}; ${question.choices.length} choices offered`);
    }
    const probabilities = {};
    for (const entry of item.probabilities) {
      if (entry && typeof entry === "object" && typeof entry.value === "string" && typeof entry.probability === "number") {
        probabilities[entry.value] = entry.probability;
      }
    }
    for (const { value } of question.choices) {
      if (typeof probabilities[value] !== "number") throw bad(`${question.name}:probabilities_incomplete`);
    }
    // The API reports rounded probabilities (observed live: two decimals, so a
    // 0.91 operation times a 0.99 element is 0.9009). Over a question with many
    // near-equal choices, those roundings move the sum far from 1 — even to 0
    // when every choice rounds down — though the answer itself is sound. Each
    // question's distribution is therefore rescaled by its own sum; an all-zero
    // report carries no preference and becomes uniform. Either way the
    // selection floor still decides whether the result is decisive enough to act.
    const sum = question.choices.reduce((total, { value }) => total + probabilities[value], 0);
    for (const { value } of question.choices) {
      if (probabilities[value] < 0) throw bad(`${question.name}:probability_negative`);
      probabilities[value] = sum > 0 ? probabilities[value] / sum : 1 / question.choices.length;
    }
    if (typeof item.confidence !== "number") throw bad(`${question.name}:confidence_missing`);
    answers[question.name] = { choice: item.choice, probabilities, confidence: item.confidence };
  }
  const usage = json.usage && typeof json.usage === "object" ? json.usage : {};
  return { answers, usage };
}

/**
 * One decision cycle's request, validated. See the file header.
 *
 * Five sources, one validated result:
 *   - `typesafe` (default): `POST {endpoint}/v1/systemone`, the body exactly
 *     as `buildSelectionRequest` built it;
 *   - `vercel`: `POST {endpoint}/v4/ai/evaluation-model` — the gateway's
 *     pinned protocol: the model in `ai-model-id`, `providerOptions` added,
 *     `model` stripped from the body, and each answer's confidence lifted
 *     from `providerMetadata` before validation;
 *   - `openrouter`: `POST {endpoint}/api/alpha/decisions`, the same body the
 *     direct source sends (the model id rides in it) and the same answer
 *     shape read back;
 *   - `runanywhere`: `POST {endpoint}/v1/decisions`, translated to and from
 *     RunAnywhere's array-question protocol (see its section above);
 *   - `openai`: `POST {endpoint}/v1/decisions`, translated to and from OpenAI's
 *     `choice` questions, optionally with an inline `image` (see its section).
 *
 * @param {object} opts
 * @param {"typesafe"|"vercel"|"openrouter"|"runanywhere"|"openai"} [opts.source] - which wire this profile uses
 * @param {string} opts.endpoint - base endpoint (path appended per source)
 * @param {string} opts.apiKey
 * @param {string} [opts.model] - required by the `vercel` source (header)
 * @param {object} opts.body - the body questions.js's `buildSelectionRequest` returned
 * @param {{ data: string, mimeType: string }} [opts.image] - page capture sent as an inline `input_image`; only the `openai` source uses it
 * @returns {Promise<{ decision: object, usage: object, latencyMs: number }>}
 * @throws {JevError}
 */
export async function requestDecision({ source = "typesafe", endpoint, apiKey, model, body, image, fetchImpl, timeoutMs, now, sleep }) {
  if (body?.questions?.action && decisionRequestBytes(body) > MAX_REQUEST_BYTES) throw new DecisionRequestTooLargeError();
  if (source === "openai") {
    const startedAt = (now ?? Date.now)();
    const { request, local, factored } = openaiRequestBody(body, image);
    let answers = local;
    let usage = {};
    if (request.questions.length) {
      const { json } = await postJson({ url: openaiDecisionsUrl(endpoint), apiKey, body: { model, ...request }, fetchImpl, timeoutMs, now, sleep });
      const mapped = normalizeOpenAIResponse(json, request.questions);
      answers = factored
        ? { action: composeFactoredAction(mapped.answers, factored.families), goal_done: mapped.answers.goal_done, stuck: mapped.answers.stuck }
        : { ...local, ...mapped.answers };
      usage = mapped.usage;
    }
    const validation = validateDecision({ questions: body?.questions, answers });
    if (!validation.ok) {
      throw new JevError("INVALID_RESPONSE", `the provider returned a decision that failed validation (${validation.reason}); no action executed.`, {
        detail: { reason: validation.reason }
      });
    }
    return { decision: validation.decision, usage, latencyMs: (now ?? Date.now)() - startedAt };
  }
  if (source === "runanywhere") {
    const startedAt = (now ?? Date.now)();
    const post = (request) => postJson({ ...request, fetchImpl, timeoutMs, now, sleep });
    const { answers, usage } = await runanywhereAnswers({ endpoint, apiKey, model, body, post });
    const validation = validateDecision({ questions: body?.questions, answers });
    if (!validation.ok) {
      throw new JevError("INVALID_RESPONSE", `the provider returned a decision that failed validation (${validation.reason}); no action executed.`, {
        detail: { reason: validation.reason }
      });
    }
    return { decision: validation.decision, usage, latencyMs: (now ?? Date.now)() - startedAt };
  }
  let url;
  let requestBody = body;
  let extraHeaders;
  if (source === "typesafe") {
    url = systemoneUrl(endpoint);
  } else if (source === "vercel") {
    url = vercelEvaluationUrl(endpoint);
    requestBody = vercelRequestBody(body);
    extraHeaders = { ...VERCEL_PROTOCOL_HEADERS, "ai-model-id": String(model ?? "") };
  } else if (source === "openrouter") {
    url = openrouterDecisionsUrl(endpoint);
  } else {
    // A stored source that is none of the known wires is a configuration error
    // (profile writers validate before persisting, so this is unreachable in
    // production); refused before any request rather than coerced into one of
    // one of the known protocols.
    throw new TypeError(`unknown decision source "${source}"`);
  }

  const { json, latencyMs } = await postJson({
    url,
    apiKey,
    body: requestBody,
    extraHeaders,
    fetchImpl,
    timeoutMs,
    now,
    sleep
  });
  const { answers, usage } =
    source === "vercel"
      ? normalizeVercelResponse(json)
      : {
          answers: json && typeof json === "object" ? json.answers : null,
          usage: json && typeof json === "object" && json.usage && typeof json.usage === "object" ? json.usage : {}
        };
  const validation = validateDecision({ questions: body?.questions, answers });
  if (!validation.ok) {
    throw new JevError("INVALID_RESPONSE", `the provider returned a decision that failed validation (${validation.reason}); no action executed.`, {
      detail: { reason: validation.reason }
    });
  }
  return { decision: validation.decision, usage, latencyMs };
}

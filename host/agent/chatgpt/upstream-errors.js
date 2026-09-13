// Upstream Codex failure -> Anthropic HTTP error mapping (spec: "Upstream
// error mapping"). Pure module: given the upstream HTTP status and body text
// (a request that never got as far as a stream), or a parsed Codex SSE
// `error`/`response.failed` event (a failure that arrives inside an already
// -200 stream), or a network-layer failure with neither, it returns exactly
// what the gateway needs to answer the client:
//
//   { status, headers, anthropicErrorBody, authFailed, sessionExpired }
//
// `authFailed` / `sessionExpired` are advisory flags for the caller, which
// owns the actual profile-state and retry decisions (host/agent/settings/
// errors.js's SESSION_EXPIRED code, and the "refresh once and retry once on
// 401" rule) — this module never touches secrets, profiles, or the network,
// so it cannot make those calls itself. The duty that follows from a
// `sessionExpired` result depends on which shape produced it, so the caller
// must not treat the two alike: a 401 answered to the retry that used a
// freshly refreshed token is a session the caller must record as expired
// (host/agent/chatgpt/upstream-client.js marks that one case explicitly with
// `sessionExpiredAfterRefresh`), whereas a 401 built from a failed
// token-acquisition has ALREADY been recorded by host/agent/chatgpt/auth.js's
// own onSessionExpired hook before it threw. It never copies an
// Authorization header or token into any field it returns.
//
// Ported (classification shape only) from router-for-me/CLIProxyAPI @
// ac02da6 (MIT), internal/runtime/executor/codex_executor_terminal.go.

const KNOWN_ERROR_TYPE_STATUS = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429
};

function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}

/** Pull {type, code, message, resets_in_seconds, resets_at} out of an
 * upstream error body, regardless of whether it is raw JSON text, an object
 * nested under `.error`, or already the bare error object. */
function extractErrorFields(source) {
  if (source == null) return {};
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (trimmed === "") return {};
    try {
      return extractErrorFields(JSON.parse(trimmed));
    } catch {
      return { message: trimmed };
    }
  }
  if (typeof source !== "object") return {};
  const nested = source.error && typeof source.error === "object" ? source.error : source;
  return {
    type: nested.type,
    code: nested.code,
    message: nested.message,
    resets_in_seconds: nested.resets_in_seconds,
    resets_at: nested.resets_at
  };
}

function isUsageLimit(fields) {
  return typeof fields.type === "string" && fields.type.toLowerCase() === "usage_limit_reached";
}

function isContextLength(fields) {
  const code = String(fields.code || "").toLowerCase();
  if (code === "context_length_exceeded" || code === "context_too_large") return true;
  const message = String(fields.message || "").toLowerCase();
  return /context window|context length|too many tokens/.test(message);
}

function isModelCapacity(fields) {
  const code = String(fields.code || "").toLowerCase();
  if (code === "model_at_capacity") return true;
  const message = String(fields.message || "").toLowerCase();
  return message.includes("model") && message.includes("at capacity");
}

/** seconds until `resets_at`/`resets_in_seconds`, using an injectable clock so tests are deterministic. */
function computeRetryAfterSeconds(fields, now) {
  if (typeof fields.resets_in_seconds === "number" && fields.resets_in_seconds > 0) {
    return Math.ceil(fields.resets_in_seconds);
  }
  if (typeof fields.resets_at === "number" && fields.resets_at > 0) {
    const diffMs = fields.resets_at * 1000 - now().getTime();
    if (diffMs > 0) return Math.ceil(diffMs / 1000);
  }
  return undefined;
}

/**
 * @param {
 *   | { httpStatus: number, body?: unknown }
 *   | { streamEventType: "error" | "response.failed", streamEventBody: Record<string, any> }
 *   | { networkError: true, message?: string }
 * } input
 * @param {{ now?: () => Date }} [opts] `now` defaults to `() => new Date()`; pass a fixed clock in tests.
 * @returns {{ status: number, headers: Record<string,string>, anthropicErrorBody: object, authFailed: boolean, sessionExpired: boolean }}
 */
export function mapUpstreamError(input, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => new Date();

  if (input && input.networkError) {
    return {
      status: 502,
      headers: {},
      anthropicErrorBody: anthropicError("api_error", input.message || "network failure contacting ChatGPT"),
      authFailed: false,
      sessionExpired: false
    };
  }

  let fields;
  let httpStatus;
  if (input && input.streamEventType) {
    const body = input.streamEventBody || {};
    // "error" events carry `.error`; "response.failed" events carry
    // `.response.error`. Prefer whichever one is actually populated.
    const errorSource = body.response && body.response.error ? body.response : body;
    fields = extractErrorFields(errorSource);
    httpStatus = undefined;
  } else {
    fields = extractErrorFields(input && input.body);
    httpStatus = input && typeof input.httpStatus === "number" ? input.httpStatus : undefined;
  }

  if (isUsageLimit(fields)) {
    const retryAfterSeconds = computeRetryAfterSeconds(fields, now);
    const headers = {};
    if (retryAfterSeconds !== undefined) headers["retry-after"] = String(retryAfterSeconds);
    const message =
      retryAfterSeconds !== undefined
        ? `ChatGPT usage limit reached; resets in ${retryAfterSeconds}s`
        : "ChatGPT usage limit reached";
    return {
      status: 429,
      headers,
      anthropicErrorBody: anthropicError("rate_limit_error", message),
      authFailed: false,
      sessionExpired: false
    };
  }

  if (isContextLength(fields)) {
    return {
      status: 400,
      headers: {},
      anthropicErrorBody: anthropicError("invalid_request_error", "prompt is too long for the model's context window"),
      authFailed: false,
      sessionExpired: false
    };
  }

  if (isModelCapacity(fields)) {
    return {
      status: 529,
      headers: {},
      anthropicErrorBody: anthropicError("overloaded_error", fields.message || "the model is at capacity"),
      authFailed: false,
      sessionExpired: false
    };
  }

  // A stream-embedded failure has no HTTP status of its own (headers already
  // committed as 200); fall back to whatever the upstream error's own `type`
  // implies, so classification stays consistent between an early rejection
  // and one that arrives mid-stream.
  const effectiveStatus =
    httpStatus !== undefined ? httpStatus : KNOWN_ERROR_TYPE_STATUS[String(fields.type || "").toLowerCase()];

  if (effectiveStatus === 401) {
    return {
      status: 401,
      headers: {},
      anthropicErrorBody: anthropicError("authentication_error", fields.message || "ChatGPT authentication failed"),
      authFailed: true,
      sessionExpired: true
    };
  }

  if (effectiveStatus === 429) {
    return {
      status: 429,
      headers: {},
      anthropicErrorBody: anthropicError("rate_limit_error", fields.message || "rate limited"),
      authFailed: false,
      sessionExpired: false
    };
  }

  if (typeof effectiveStatus === "number" && effectiveStatus >= 500) {
    return {
      status: 529,
      headers: {},
      anthropicErrorBody: anthropicError("overloaded_error", fields.message || "upstream is overloaded"),
      authFailed: false,
      sessionExpired: false
    };
  }

  if (typeof effectiveStatus === "number" && effectiveStatus >= 400) {
    return {
      status: 400,
      headers: {},
      anthropicErrorBody: anthropicError("invalid_request_error", fields.message || "invalid request"),
      authFailed: false,
      sessionExpired: false
    };
  }

  return {
    status: 502,
    headers: {},
    anthropicErrorBody: anthropicError("api_error", fields.message || "upstream request failed"),
    authFailed: false,
    sessionExpired: false
  };
}

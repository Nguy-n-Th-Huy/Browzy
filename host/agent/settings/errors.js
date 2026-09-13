// Typed, actionable error taxonomy for provider connectivity and the
// capability test (design.md decision 4 / task 4.3).
//
// Every failure mode the spec calls out by name gets its own `code` so a
// caller (the eventual extension/settings/ UI, or a test) can render/assert
// on a specific, distinct error instead of a single generic "connection
// failed" message that hides what actually went wrong.

export const PROVIDER_ERROR_CODES = /** @type {const} */ ([
  "STARTUP_ERROR", // the endpoint/runtime never became reachable within the startup budget
  "AUTH_ERROR", // 401/403 — bad or rejected credential
  "MODEL_UNAVAILABLE_ERROR", // provider rejected the model id (404 / not_found)
  "RATE_LIMIT_ERROR", // 429
  "TIMEOUT_ERROR", // exceeded the provider-test deadline with no classifiable response
  "NETWORK_ERROR", // DNS/TCP/TLS failure, connection reset, or a 5xx we can't attribute to a specific cause
  "PROTOCOL_ERROR", // the endpoint does not speak the Anthropic Messages API (e.g. OpenAI Chat Completions only)
  "TOOL_ERROR", // the model/gateway never completed the fixture tool round trip
  "VISION_ERROR", // the model/gateway rejected or never completed the image sub-test
  "REDIRECT_REJECTED", // the endpoint issued a cross-origin redirect for an authenticated request
  "NO_CREDENTIAL", // snapshotForRun called with no stored/available credential
  "INVALID_PROFILE", // the stored profile itself fails validation (corrupt, or references a removed model)

  // ChatGPT subscription provider (add-chatgpt-subscription-provider).
  "CALLBACK_PORT_IN_USE", // the loopback OAuth callback listener could not bind 127.0.0.1:1455
  "SIGN_IN_TIMEOUT", // 5 minutes (browser) or 15 minutes (device code) passed without a valid callback/approval
  "SIGN_IN_CANCELLED", // the user cancelled an in-progress sign-in, or a new sign-in superseded it
  "SIGN_IN_FAILED", // the authorization/token exchange failed for a reason other than timeout or cancellation
  "SESSION_EXPIRED", // a ChatGPT refresh was rejected (invalid_grant/refresh_token_reused) — sign-in required again
  "SECRET_TOO_LARGE", // the credential does not fit the OS secret store's size limit and was NOT truncated
  "USAGE_LIMIT_REACHED", // upstream reported the signed-in ChatGPT account's usage limit
  "UPSTREAM_REJECTED_CLIENT" // upstream 403/400 whose message names the client/originator/instructions
]);

export class ProviderError extends Error {
  /**
   * @param {(typeof PROVIDER_ERROR_CODES)[number]} code
   * @param {string} message
   * @param {{ cause?: unknown, detail?: Record<string, unknown> }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    if (!PROVIDER_ERROR_CODES.includes(code)) {
      throw new Error(`unknown ProviderError code: ${code}`);
    }
    this.code = code;
    this.detail = opts.detail || {};
  }
}

/**
 * Classify a Node network-layer error (from `fetch`/`http`/`https`) into one
 * of the taxonomy codes. Used by the redirect-safe HTTP client shared by
 * discovery and the capability-test preflight.
 *
 * @param {unknown} err
 * @returns {ProviderError}
 */
export function classifyNetworkError(err) {
  const message = err && err.message ? String(err.message) : String(err);
  const cause = err && err.cause ? err.cause : err;
  const code = cause && cause.code;
  if (code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) {
    return new ProviderError("TIMEOUT_ERROR", `request timed out: ${message}`, { cause: err });
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    (typeof code === "string" && code.startsWith("ERR_TLS")) ||
    /certificate|SSL|TLS/i.test(message)
  ) {
    return new ProviderError("NETWORK_ERROR", `network/TLS failure: ${message}`, { cause: err });
  }
  return new ProviderError("NETWORK_ERROR", `network failure: ${message}`, { cause: err });
}

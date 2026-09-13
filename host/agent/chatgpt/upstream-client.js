// Talks to the Codex `responses` backend on behalf of the loopback gateway
// (gateway.js): translates one Anthropic Messages request, sends it with the
// spec's exact headers, applies the single refresh-and-retry-once-on-401
// rule, and turns the still-open upstream SSE response into an async
// iterable of parsed Codex events the gateway feeds through
// translate-stream.js.
//
// Pure with respect to the gateway's own concerns (no node:http, no token
// registry, no knowledge of the client connection) — everything about
// talking to `https://chatgpt.com/backend-api/codex/responses` lives here so
// gateway.js only orchestrates HTTP routing and token lifecycle.
//
// Ported (header/body shape only, not the wire-cloaking bits) from
// router-for-me/CLIProxyAPI @ ac02da6 (MIT),
// internal/runtime/executor/codex_executor_request.go /
// codex_executor_execute.go / codex_executor_auth.go. Deliberately NOT
// ported: the `codex-tui` user agent/originator, uTLS fingerprinting, and
// retry/failover across accounts — see design.md decision 6.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { translateAnthropicRequestToCodex, ChatGPTTranslationError } from "./translate-request.js";
import { createSSEParser } from "./translate-stream.js";
import { mapUpstreamError } from "./upstream-errors.js";
import { ProviderError } from "../settings/errors.js";

export const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

let cachedVersion = null;
function packageVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    cachedVersion = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

/** `browzy/<host package version> (<platform>)` — spec: "a User-Agent
 * identifying Browzy and its version". Never a client this companion is not
 * (design.md decision 6: no `codex-tui` impersonation). */
export function buildUserAgent() {
  return `browzy/${packageVersion()} (${process.platform})`;
}

/**
 * A deterministic prompt-cache key for one conversation, reused as the
 * upstream `session_id` too (spec: "session_id equal to the request's prompt
 * cache key"). Anthropic's Messages API is stateless — the SDK resends the
 * full running message history on every turn — so a value derived from the
 * conversation's first user message is stable across every turn of the SAME
 * conversation without this gateway needing to track any session state of
 * its own. Prefers `metadata.user_id` when the caller (the SDK) sets one,
 * since that is the field the Anthropic Messages API defines for this exact
 * purpose; the derived fallback is this module's own choice, documented here
 * because the spec does not name a specific source.
 *
 * @param {{ profileId: string, anthropicRequestBody: object }} args
 * @returns {string}
 */
export function computePromptCacheKey({ profileId, anthropicRequestBody }) {
  const metadataUserId =
    anthropicRequestBody && anthropicRequestBody.metadata && typeof anthropicRequestBody.metadata.user_id === "string"
      ? anthropicRequestBody.metadata.user_id.trim()
      : "";
  if (metadataUserId) return metadataUserId;
  const messages = Array.isArray(anthropicRequestBody && anthropicRequestBody.messages) ? anthropicRequestBody.messages : [];
  const firstUser = messages.find((m) => m && m.role === "user");
  const seed = firstUser ? JSON.stringify(firstUser.content ?? "") : "";
  const hash = createHash("sha256").update(`${profileId}:${seed}`).digest("hex");
  return `browzy-${hash.slice(0, 32)}`;
}

function sessionExpiredGatewayError(message) {
  return {
    status: 401,
    headers: {},
    anthropicErrorBody: { type: "error", error: { type: "authentication_error", message } },
    authFailed: true,
    sessionExpired: true
  };
}

/** A failure while OBTAINING an access token (never an upstream HTTP
 * response) — classified separately from mapUpstreamError's HTTP-shaped
 * inputs. `SESSION_EXPIRED`/`NO_CREDENTIAL` become a 401 telling the user to
 * sign in again; the auth module itself has already recorded any actual
 * state transition (its own onSessionExpired hook — see host/agent/chatgpt/
 * auth.js) before this ever throws, so this function never touches profile
 * state. Anything else (a network failure reaching the token endpoint) maps
 * like any other network failure. */
function authErrorToGatewayError(err) {
  if (err instanceof ProviderError && (err.code === "SESSION_EXPIRED" || err.code === "NO_CREDENTIAL")) {
    return sessionExpiredGatewayError("Your ChatGPT session has expired. Sign in with ChatGPT again.");
  }
  return mapUpstreamError({ networkError: true, message: err && err.message ? err.message : String(err) });
}

async function readJsonBody(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function translationErrorToGatewayError(err) {
  return {
    status: err.status,
    headers: {},
    anthropicErrorBody: { type: "error", error: { type: err.anthropicErrorType, message: err.message } },
    authFailed: false,
    sessionExpired: false
  };
}

/**
 * Send one translated Anthropic request to the Codex backend, handling the
 * spec's "On HTTP 401 it SHALL refresh the access token once and retry once"
 * rule. Never throws for an ordinary upstream/auth/translation failure —
 * those all come back as `{ error }` — except when `signal` aborts the
 * in-flight fetch (an `AbortError`, left for the caller's own abort handling)
 * or a genuinely unexpected exception.
 *
 * `sessionExpiredAfterRefresh` (boolean) marks the ONE case where the caller
 * owns a profile-state transition: the request was retried with a freshly
 * refreshed access token and was still answered 401 — spec: "A 401 still
 * failing after the single refresh -> HTTP 401 `authentication_error`, and
 * the profile becomes `SESSION_EXPIRED`". Every other error shape leaves
 * profile state alone.
 *
 * @param {{
 *   fetchImpl: typeof fetch,
 *   baseUrl?: string,
 *   model: string,
 *   anthropicRequestBody: object,
 *   profileId: string,
 *   getAccessToken: (profileId: string, opts?: { forceRefresh?: boolean }) => Promise<{ accessToken: string, accountId: string }>,
 *   userAgent: string,
 *   signal?: AbortSignal
 * }} params
 * @returns {Promise<{ response: Response, toolNameMap: Map<string,string> } | { error: ReturnType<typeof mapUpstreamError> & { sessionExpiredAfterRefresh?: boolean } }>}
 */
export async function sendCodexRequest({
  fetchImpl,
  baseUrl = DEFAULT_CODEX_RESPONSES_URL,
  model,
  anthropicRequestBody,
  profileId,
  getAccessToken,
  userAgent,
  signal
}) {
  const promptCacheKey = computePromptCacheKey({ profileId, anthropicRequestBody });

  let translated;
  try {
    translated = translateAnthropicRequestToCodex(anthropicRequestBody, { model, promptCacheKey });
  } catch (err) {
    if (err instanceof ChatGPTTranslationError) return { error: translationErrorToGatewayError(err) };
    throw err;
  }

  async function postWithToken({ accessToken, accountId }) {
    return fetchImpl(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId || "",
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        session_id: promptCacheKey,
        originator: "browzy",
        "User-Agent": userAgent
      },
      body: JSON.stringify(translated.body),
      signal
    });
  }

  let tokenInfo;
  try {
    tokenInfo = await getAccessToken(profileId, {});
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return { error: authErrorToGatewayError(err) };
  }

  let res;
  try {
    res = await postWithToken(tokenInfo);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return { error: mapUpstreamError({ networkError: true, message: err.message }) };
  }

  if (res.status === 401) {
    let refreshed;
    try {
      refreshed = await getAccessToken(profileId, { forceRefresh: true });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // The refresh itself failed — e.g. SESSION_EXPIRED from a rejected
      // invalid_grant/refresh_token_reused. The auth module has already
      // recorded that transition via its own onSessionExpired hook; this
      // gateway only needs to answer the client.
      return { error: authErrorToGatewayError(err) };
    }
    try {
      res = await postWithToken(refreshed);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      return { error: mapUpstreamError({ networkError: true, message: err.message }) };
    }
    if (res.status === 401) {
      // Spec: "A 401 still failing after the single refresh -> HTTP 401
      // `authentication_error`, and the profile becomes `SESSION_EXPIRED`."
      // The refresh above SUCCEEDED and the retry still came back 401, so
      // unlike the branch above this is a session that the caller must record
      // as expired: `sessionExpiredAfterRefresh` is how that exact case is
      // reported (mapUpstreamError's other 401 shape — a token-acquisition
      // failure — is already recorded by the auth module's own
      // onSessionExpired hook before it throws, so it carries no such marker
      // and must NOT be recorded twice, e.g. for a profile that has no
      // credential stored at all rather than an expired one).
      const body = await readJsonBody(res);
      return { error: { ...mapUpstreamError({ httpStatus: 401, body }), sessionExpiredAfterRefresh: true } };
    }
  }

  if (!res.ok) {
    const body = await readJsonBody(res);
    return { error: mapUpstreamError({ httpStatus: res.status, body }) };
  }

  return { response: res, toolNameMap: translated.toolNameMap };
}

/** Parse one raw SSE `{event, data}` frame's `data` field as JSON (Codex
 * events are always a JSON object). A malformed/non-JSON data field becomes
 * an empty object rather than throwing — a malformed frame is treated by the
 * stream state machine as an unrecognized event type (a no-op), not a reason
 * to tear down the whole stream. */
function parseFrame(frame) {
  let data;
  try {
    data = JSON.parse(frame.data);
  } catch {
    data = {};
  }
  return { event: frame.event, data };
}

/**
 * Turn an upstream SSE `Response`'s body into an async iterable of parsed
 * `{ event, data }` Codex frames. Consumes the body exactly once. Works with
 * either a web `ReadableStream` (undici/global fetch) or a Node.js Readable
 * (a test's own http server response, when passed through unwrapped).
 *
 * @param {Response} response
 * @returns {AsyncGenerator<{ event: string, data: object }>}
 */
export async function* iterateCodexSSE(response) {
  const parser = createSSEParser();
  const body = response.body;
  if (!body) return;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(value)) yield parseFrame(frame);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released (e.g. the stream errored before this ran).
      }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      for (const frame of parser.push(chunk)) yield parseFrame(frame);
    }
  }
}

// The loopback Anthropic-Messages-compatible gateway a `chatgpt` profile's
// run points its SDK subprocess at (spec: "Loopback Anthropic gateway").
//
// Attribution for this directory: the wire behaviour it exposes is ported
// from router-for-me/CLIProxyAPI @ ac02da6 (MIT) — see NOTICE and the headers
// of auth.js, translate-request.js, translate-stream.js, upstream-errors.js
// and upstream-client.js. What is NOT ported is this file's own shape: the
// loopback-only bind, the ephemeral port, and the per-run tokens bound to
// {profile, model, credential revision} are this project's design
// (design.md decisions 1 and 2); CLIProxyAPI serves many clients with its own
// API-key model and is not ported here.
//
// `node:http` on `127.0.0.1`, an OS-assigned port (`listen(0)`), started
// lazily on first need and closed when the companion exits. Every request
// must present a gateway token (32 random bytes, base64url) bound to one
// profile, one model, and the profile's credential revision at issue time;
// a request whose token's credential revision no longer matches the
// profile's CURRENT credential revision is rejected and the token dropped —
// this is what makes a sign-out or a session-expiry take effect for
// already-issued tokens without this module needing to track those events
// itself (design.md decision 2). The one profile-state transition it DOES
// own is the post-refresh 401 (spec: "Upstream error mapping" — a request
// answered 401 again after its single refresh retry), which it records
// through its injectable `onSessionExpired` hook; a credential-revision bump
// follows from that same recorder, so already-issued tokens stop working
// exactly as they do after a sign-out.
//
// Routes: `POST /v1/messages` (streaming and non-streaming, translated
// through translate-request.js/translate-stream.js and sent upstream via
// upstream-client.js), `POST /v1/messages/count_tokens` (a local estimate,
// never an upstream call), `GET /v1/models` (the bound profile's own model
// list). Anything else: 404. No token, an unknown token, or a stale one:
// 401. Every error body is Anthropic-shaped.
//
// Fully injectable (`createChatgptGateway(options)`), like
// host/agent/chatgpt/auth.js: tests run a real `node:http` server against a
// real local mock upstream, with `getAccessToken`/`loadProfile`/`fetchImpl`
// swapped for fakes — never a real ChatGPT/OpenAI endpoint. The module-scope
// default instance (`ensureGatewayStarted`/`issueGatewayToken`/
// `revokeGatewayTokensForProfile`/`closeGateway`) is what
// host/agent/settings/profile.js's `chatgpt` branch and host/agent/
// companion.js actually use.

import crypto from "node:crypto";
import http from "node:http";
import { getAccessToken as chatgptGetAccessToken } from "./auth.js";
import { loadProfile as loadRealProfile, recordChatgptSessionExpired } from "../settings/profile.js";
import {
  sendCodexRequest,
  iterateCodexSSE,
  buildUserAgent,
  DEFAULT_CODEX_RESPONSES_URL
} from "./upstream-client.js";
import { createCodexStreamState, feedCodexEvent, serializeAnthropicSSEEvent, accumulateNonStreamMessage } from "./translate-stream.js";

// Anthropic requests carrying a full conversation's screenshots/history can
// legitimately be large; this is a sanity ceiling against a runaway or
// malicious body, not a tight budget — Anthropic's own public API applies a
// comparable order-of-magnitude limit.
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function anthropicErrorBody(type, message) {
  return { type: "error", error: { type, message } };
}

function writeJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length, ...extraHeaders });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Token registry
// ---------------------------------------------------------------------------

function createTokenRegistry({ randomBytesFn }) {
  /** token -> { profileId, model, credentialRevision, purpose, controllers: Set<AbortController> } */
  const tokens = new Map();

  function issue({ profileId, model, credentialRevision, purpose }) {
    const token = toBase64Url(randomBytesFn(32));
    tokens.set(token, { profileId, model, credentialRevision, purpose, controllers: new Set() });
    return token;
  }

  function get(token) {
    return tokens.get(token) || null;
  }

  function abortAndDelete(token, entry) {
    for (const controller of entry.controllers) {
      try {
        controller.abort();
      } catch {
        // Best-effort — an already-settled controller throws on abort() in
        // some runtimes; either way the request is ending.
      }
    }
    tokens.delete(token);
  }

  function revoke(token) {
    const entry = tokens.get(token);
    if (entry) abortAndDelete(token, entry);
  }

  function revokeAllForProfile(profileId) {
    for (const [token, entry] of tokens) {
      if (entry.profileId === profileId) abortAndDelete(token, entry);
    }
  }

  return { issue, get, revoke, revokeAllForProfile, size: () => tokens.size };
}

// ---------------------------------------------------------------------------
// Request body reading with a size ceiling
// ---------------------------------------------------------------------------

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error("request body exceeds the gateway's size limit");
        err.code = "BODY_TOO_LARGE";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function extractToken(req) {
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) return apiKeyHeader.trim();
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleCountTokens(res, bodyBuffer) {
  let parsed;
  try {
    parsed = bodyBuffer.length ? JSON.parse(bodyBuffer.toString("utf8")) : {};
  } catch {
    return writeJson(res, 400, anthropicErrorBody("invalid_request_error", "request body was not valid JSON"));
  }
  // A local estimate ONLY — never an upstream call (spec: "count_tokens ...
  // a local estimate, never an upstream call"). JSON length / 4, rounded up,
  // is the same rough characters-per-token heuristic used elsewhere in this
  // codebase for a bounded, offline estimate.
  const estimate = Math.max(0, Math.ceil(Buffer.byteLength(JSON.stringify(parsed), "utf8") / 4));
  writeJson(res, 200, { input_tokens: estimate });
}

async function handleModels(res, tokenEntry, loadProfileImpl) {
  const profile = await loadProfileImpl();
  const models = profile && profile.profileId === tokenEntry.profileId && Array.isArray(profile.models) ? profile.models : [];
  const epoch = new Date(0).toISOString();
  const data = models.map((m) => ({ id: m.id, display_name: m.label || m.id, type: "model", created_at: epoch }));
  writeJson(res, 200, {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null
  });
}

async function handleMessages(req, res, bodyBuffer, tokenEntry, ctx) {
  let anthropicRequestBody;
  try {
    anthropicRequestBody = bodyBuffer.length ? JSON.parse(bodyBuffer.toString("utf8")) : {};
  } catch {
    return writeJson(res, 400, anthropicErrorBody("invalid_request_error", "request body was not valid JSON"));
  }

  // Spec: "The model named in a request SHALL be replaced by the token's
  // bound model" — the SDK's own background calls (e.g. conversation
  // titling) name a Claude model id; the run's bound model is always used.
  const boundModel = tokenEntry.model;
  anthropicRequestBody.model = boundModel;
  const wantsStream = anthropicRequestBody.stream === true;

  const abortController = new AbortController();
  tokenEntry.controllers.add(abortController);
  // The ServerResponse's "close" — not the IncomingMessage's — is what fires
  // when the SDK subprocess tears the connection down mid-response (spec
  // "request abort when the client disconnects"). `req` is already fully
  // consumed by the time a response is streaming, so its "close" never
  // signals a client abort; `res` "close" fires on both a normal end (a
  // harmless abort() on an already-settled controller) and a real disconnect.
  const onClientClose = () => abortController.abort();
  res.on("close", onClientClose);

  const cleanup = () => {
    res.removeListener("close", onClientClose);
    tokenEntry.controllers.delete(abortController);
  };

  let result;
  try {
    result = await sendCodexRequest({
      fetchImpl: ctx.fetchImpl,
      baseUrl: ctx.upstreamUrl,
      model: boundModel,
      anthropicRequestBody,
      profileId: tokenEntry.profileId,
      getAccessToken: ctx.getAccessToken,
      userAgent: ctx.userAgent,
      signal: abortController.signal
    });
  } catch (err) {
    cleanup();
    if (err && err.name === "AbortError") {
      if (!res.writableEnded) res.destroy();
      return;
    }
    return writeJson(res, 502, anthropicErrorBody("api_error", "unexpected gateway failure contacting ChatGPT"));
  }

  if (result.error) {
    cleanup();
    // Spec (Upstream error mapping): "A 401 still failing after the single
    // refresh -> HTTP 401 `authentication_error`, and the profile becomes
    // `SESSION_EXPIRED`." The upstream client reports exactly that case with
    // `sessionExpiredAfterRefresh` (so a first 401 that succeeds after its
    // refresh — the case above this one — and a 401 already recorded by the
    // auth module are both untouched). Recording it HERE, before the client
    // is answered, is what makes the rest of the session-expiry machinery
    // take effect: profile.js bumps the credential revision (every
    // already-issued gateway token for this profile is refused from now on)
    // and fires the existing onCredentialRevoked listeners, which is where
    // the companion cancels the profile's runs and revokes its gateway
    // tokens. The recorder is idempotent, so the many in-flight requests
    // that can each hit this at once produce exactly one transition.
    if (result.error.sessionExpiredAfterRefresh) {
      try {
        await ctx.onSessionExpired(tokenEntry.profileId);
      } catch {
        // Failing to record the transition must never swallow the 401 the
        // client is owed; the next request's own auth path will retry it.
      }
    }
    return writeJson(res, result.error.status, result.error.anthropicErrorBody, result.error.headers);
  }

  const { response, toolNameMap } = result;
  const state = createCodexStreamState({ toolNameMap });

  if (wantsStream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let sawError = false;
    try {
      for await (const frame of iterateCodexSSE(response)) {
        const anthropicFrames = feedCodexEvent(state, frame);
        for (const outFrame of anthropicFrames) {
          res.write(serializeAnthropicSSEEvent(outFrame.event, outFrame.data));
          if (outFrame.event === "error") sawError = true;
        }
        if (typeof res.flush === "function") res.flush();
        if (sawError) break;
      }
    } catch (err) {
      if (!(err && err.name === "AbortError") && !sawError) {
        try {
          res.write(
            serializeAnthropicSSEEvent("error", anthropicErrorBody("api_error", "the upstream stream ended unexpectedly"))
          );
        } catch {
          // The connection may already be gone — nothing left to write to.
        }
      }
    } finally {
      cleanup();
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // Non-stream: buffer every upstream frame, then accumulate one Anthropic
  // message (spec: "Non-streaming requests SHALL return the same content as
  // one Anthropic message object").
  const frames = [];
  try {
    for await (const frame of iterateCodexSSE(response)) frames.push(frame);
  } catch (err) {
    cleanup();
    if (err && err.name === "AbortError") {
      if (!res.writableEnded) res.destroy();
      return;
    }
    return writeJson(res, 502, anthropicErrorBody("api_error", "the upstream stream ended unexpectedly"));
  }
  cleanup();

  let accumulated;
  try {
    accumulated = accumulateNonStreamMessage(frames, { toolNameMap });
  } catch {
    return writeJson(res, 502, anthropicErrorBody("api_error", "the upstream response ended without a terminal event"));
  }
  if (accumulated.error) {
    return writeJson(res, accumulated.error.status, accumulated.error.anthropicErrorBody, accumulated.error.headers);
  }
  writeJson(res, 200, accumulated.message);
}

// ---------------------------------------------------------------------------
// Gateway factory
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {string} [options.host] default `127.0.0.1` — spec: loopback only.
 * @param {string} [options.upstreamUrl] default the real Codex `responses` endpoint.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(profileId: string, opts?: { forceRefresh?: boolean }) => Promise<{accessToken:string, accountId:string}>} [options.getAccessToken]
 * @param {() => Promise<object|null>} [options.loadProfile]
 * @param {(profileId: string) => Promise<void>} [options.onSessionExpired] records the
 *   `SESSION_EXPIRED` transition for a profile whose request was answered 401
 *   after its single refresh retry (default: host/agent/settings/profile.js's
 *   `recordChatgptSessionExpired`). Injectable like every other collaborator
 *   here so a test can observe the call without touching a real profile.
 * @param {string} [options.userAgent]
 * @param {(size: number) => Buffer | Uint8Array} [options.randomBytes]
 * @param {number} [options.maxBodyBytes]
 */
export function createChatgptGateway(options = {}) {
  const host = options.host || "127.0.0.1";
  const upstreamUrl = options.upstreamUrl || DEFAULT_CODEX_RESPONSES_URL;
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const getAccessToken = options.getAccessToken || chatgptGetAccessToken;
  const loadProfileImpl = options.loadProfile || loadRealProfile;
  const onSessionExpired = options.onSessionExpired || recordChatgptSessionExpired;
  const userAgent = options.userAgent || buildUserAgent();
  const randomBytesFn = options.randomBytes || ((size) => crypto.randomBytes(size));
  const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;

  const registry = createTokenRegistry({ randomBytesFn });
  const ctx = { fetchImpl, upstreamUrl, getAccessToken, userAgent, onSessionExpired };

  let server = null;
  let startPromise = null;

  async function authenticate(req) {
    const token = extractToken(req);
    if (!token) return null;
    const entry = registry.get(token);
    if (!entry) return null;
    // Spec: "a request whose token's credential revision no longer equals
    // the profile's current credential revision is rejected 401 and the
    // token revoked" — checked fresh on every request, not only at issue
    // time, so a sign-out or session-expiry (both of which bump
    // credentialRevision) takes effect for an already-issued token
    // immediately, without this module needing to observe either event.
    const currentProfile = await loadProfileImpl();
    const currentRevision =
      currentProfile && currentProfile.profileId === entry.profileId ? currentProfile.credentialRevision || 0 : null;
    if (currentRevision === null || currentRevision !== entry.credentialRevision) {
      registry.revoke(token);
      return null;
    }
    return entry;
  }

  async function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      return writeJson(res, 400, anthropicErrorBody("invalid_request_error", "malformed request URL"));
    }

    let entry;
    try {
      entry = await authenticate(req);
    } catch {
      entry = null;
    }
    if (!entry) {
      return writeJson(res, 401, anthropicErrorBody("authentication_error", "missing, unknown, or revoked gateway token"));
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      let body;
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (err) {
        if (err && err.code === "BODY_TOO_LARGE") {
          return writeJson(res, 413, anthropicErrorBody("invalid_request_error", "request body is too large"));
        }
        return writeJson(res, 400, anthropicErrorBody("invalid_request_error", "failed to read request body"));
      }
      return handleMessages(req, res, body, entry, ctx);
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      let body;
      try {
        body = await readBody(req, maxBodyBytes);
      } catch (err) {
        if (err && err.code === "BODY_TOO_LARGE") {
          return writeJson(res, 413, anthropicErrorBody("invalid_request_error", "request body is too large"));
        }
        return writeJson(res, 400, anthropicErrorBody("invalid_request_error", "failed to read request body"));
      }
      return handleCountTokens(res, body);
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return handleModels(res, entry, loadProfileImpl);
    }

    return writeJson(res, 404, anthropicErrorBody("not_found_error", `no route for ${req.method} ${url.pathname}`));
  }

  /** Idempotent, lazy start (spec: "started on first need"). Concurrent
   * callers before the first start settles all await the SAME listen(). */
  async function ensureStarted() {
    if (server) return { port: server.address().port };
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        onRequest(req, res).catch(() => {
          try {
            writeJson(res, 500, anthropicErrorBody("api_error", "internal gateway error"));
          } catch {
            // The response may already be underway/closed — nothing more to do.
          }
        });
      });
      s.once("error", (err) => {
        startPromise = null;
        reject(err);
      });
      s.listen(0, host, () => {
        server = s;
        resolve({ port: s.address().port });
      });
    });
    return startPromise;
  }

  /**
   * @param {{ profileId: string, model: string, credentialRevision: number, purpose: string }} args
   * @returns {{ token: string, release: () => void }} `release` is
   *   idempotent — safe to call more than once, and safe to call after the
   *   gateway itself has already closed.
   */
  function issueToken({ profileId, model, credentialRevision, purpose }) {
    const token = registry.issue({ profileId, model, credentialRevision, purpose });
    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        registry.revoke(token);
      }
    };
  }

  function revokeAllForProfile(profileId) {
    registry.revokeAllForProfile(profileId);
  }

  /** Idempotent close — closing an already-closed (or never-started)
   * gateway is a no-op. `server.close()` alone waits for every keep-alive
   * connection to drain, which undici's connection pool never does on its
   * own — so after a short grace for in-flight responses, lingering sockets
   * are force-closed (`closeAllConnections`, Node >=18.2). Without that, a
   * companion shutting down mid-idle-pool would never get the close
   * callback, and the caller's exit path would stall until its own bound. */
  async function close() {
    if (!server) {
      startPromise = null;
      return;
    }
    const s = server;
    server = null;
    startPromise = null;
    await new Promise((resolve) => {
      s.close(() => {
        clearTimeout(graceTimer);
        resolve();
      });
      const graceTimer = setTimeout(() => {
        if (typeof s.closeAllConnections === "function") s.closeAllConnections();
        // If closeAllConnections somehow never settles the callback (an old
        // Node build without it), don't hang shutdown.
        setTimeout(resolve, 250).unref?.();
      }, 100);
      graceTimer.unref?.();
    });
  }

  return {
    ensureStarted,
    issueToken,
    revokeAllForProfile,
    close,
    // Test-only introspection — never used by production callers.
    _tokenCount: () => registry.size(),
    _port: () => (server ? server.address().port : null)
  };
}

// ---------------------------------------------------------------------------
// Production default instance
// ---------------------------------------------------------------------------

function buildDefaultGateway() {
  return createChatgptGateway({ getAccessToken: chatgptGetAccessToken, loadProfile: loadRealProfile });
}

let activeGateway = buildDefaultGateway();

export function ensureGatewayStarted(...args) {
  return activeGateway.ensureStarted(...args);
}
export function issueGatewayToken(...args) {
  return activeGateway.issueToken(...args);
}
export function revokeGatewayTokensForProfile(...args) {
  return activeGateway.revokeAllForProfile(...args);
}
export function closeGateway(...args) {
  return activeGateway.close(...args);
}

/**
 * Test-only: swap the module-scope default gateway instance for a fully
 * fake one (e.g. pointed at a local mock upstream with a fake
 * `getAccessToken`), or restore the real production instance by passing
 * nothing. Every default export above dispatches through the CURRENT
 * `activeGateway` at call time, so host/agent/settings/profile.js's
 * `import { ensureGatewayStarted, ... } from "./gateway.js"`-style callers
 * see the swap immediately without re-importing anything.
 * @param {ReturnType<typeof createChatgptGateway>} [gateway]
 */
export function _setActiveGatewayForTests(gateway) {
  activeGateway = gateway || buildDefaultGateway();
}

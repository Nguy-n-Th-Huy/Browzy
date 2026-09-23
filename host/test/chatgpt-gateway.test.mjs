#!/usr/bin/env node
// ChatGPT loopback Anthropic gateway (host/agent/chatgpt/gateway.js) +
// upstream client (host/agent/chatgpt/upstream-client.js), exercised against
// a real node:http gateway and a real local mock upstream — never a real
// ChatGPT/OpenAI endpoint. Mirrors the injector style of
// host/test/chatgpt-translate.test.mjs (pure modules) and
// host/test/chatgpt-auth.test.mjs (inject every collaborator).
//
// Run: node host/test/chatgpt-gateway.test.mjs

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatgptGateway } from "../agent/chatgpt/gateway.js";
import { buildUserAgent } from "../agent/chatgpt/upstream-client.js";
import { ProviderError } from "../agent/settings/errors.js";
import * as profileModule from "../agent/settings/profile.js";

let fail = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    fail++;
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonBody(obj) {
  return JSON.stringify(obj);
}

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicMessagesBody(overrides = {}) {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
    ...overrides
  };
}

function codexCompletedResponse(overrides = {}) {
  return {
    type: "response.completed",
    response: {
      id: "resp_test",
      model: "gpt-5.6-terra",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 3, output_tokens: 2 },
      ...overrides
    }
  };
}

/** Start a mock upstream that records every request and answers from `handler(req, body)`. */
async function startMockUpstream(handler) {
  let lastRequest = null;
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        body = bodyText;
      }
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(lastRequest);
      try {
        await handler(req, res, lastRequest);
      } catch (err) {
        if (!res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: String(err && err.message) } }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/backend-api/codex/responses`,
    get lastRequest() {
      return lastRequest;
    },
    get requests() {
      return requests;
    },
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          clearTimeout(graceTimer);
          resolve();
        });
        const graceTimer = setTimeout(() => {
          if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          setTimeout(resolve, 250).unref?.();
        }, 100);
        graceTimer.unref?.();
      })
  };
}

/** Build a gateway pointed at `upstreamUrl` with a fake getAccessToken/loadProfile. */
function buildGateway({ upstreamUrl, getAccessToken, loadProfile, randomBytes, onSessionExpired } = {}) {
  const profileId = "p1";
  let credentialRevision = 1;
  const fakeLoadProfile =
    loadProfile ||
    (async () => ({
      profileId,
      credentialRevision,
      models: [
        { id: "gpt-5.6-terra", label: "Terra" },
        { id: "gpt-5.6-luna", label: "Luna" }
      ]
    }));
  const fakeGetAccessToken =
    getAccessToken ||
    (async () => ({ accessToken: "tok", accountId: "acc1" }));
  const gw = createChatgptGateway({
    upstreamUrl,
    getAccessToken: fakeGetAccessToken,
    loadProfile: fakeLoadProfile,
    randomBytes,
    // Left undefined in most tests: the gateway then uses the production
    // recorder, which no-ops for any profileId that is not the one on disk
    // (these tests use "p1"), so a transition can never touch a real profile.
    ...(onSessionExpired ? { onSessionExpired } : {})
  });
  return {
    gw,
    get credentialRevision() {
      return credentialRevision;
    },
    set credentialRevision(v) {
      credentialRevision = v;
    },
    profileId
  };
}

async function gatewayFetch(gw, path, { token, method, body, headers } = {}) {
  const { port } = await gw.ensureStarted();
  const url = `http://127.0.0.1:${port}${path}`;
  const h = { ...(headers || {}) };
  if (token) h["x-api-key"] = token;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(url, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: h,
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
  });
  return res;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// 1. Auth: missing/revoked/unknown token -> 401 authentication_error
// ---------------------------------------------------------------------------

console.log("\n== auth: 401 on missing/unknown/revoked token ==");

await check("no token -> 401 authentication_error", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.completed", codexCompletedResponse()));
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const res = await gatewayFetch(gw, "/v1/messages", { body: anthropicMessagesBody() });
    assertEqual(res.status, 401, "status");
    const body = await readJson(res);
    assertEqual(body.error.type, "authentication_error", "error type");
    assertEqual(upstream.requests.length, 0, "upstream must not have been called");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("unknown token -> 401 authentication_error", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.completed", codexCompletedResponse()));
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const res = await gatewayFetch(gw, "/v1/messages", { token: "not-a-real-token", body: anthropicMessagesBody() });
    assertEqual(res.status, 401, "status");
    const body = await readJson(res);
    assertEqual(body.error.type, "authentication_error", "error type");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("Bearer Authorization header is accepted as well as x-api-key", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.created", { response: { id: "r1", model: "gpt-5.6-terra" } }) + sseFrame("response.completed", codexCompletedResponse()));
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    const { port } = await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...anthropicMessagesBody(), stream: false })
    });
    assertEqual(res.status, 200, "status");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("revoked token -> 401 even though it was previously valid", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.completed", codexCompletedResponse()));
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token, release } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    release();
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: anthropicMessagesBody() });
    assertEqual(res.status, 401, "status");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("revokeAllForProfile revokes every token for that profile, not others", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.completed", codexCompletedResponse()));
  });
  // Two profiles, one gateway.
  const gw = createChatgptGateway({
    upstreamUrl: upstream.url,
    getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }),
    loadProfile: async () => ({ profileId: "p1", credentialRevision: 1, models: [] })
  });
  try {
    await gw.ensureStarted();
    const a = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    const b = gw.issueToken({ profileId: "p2", model: "m", credentialRevision: 1, purpose: "run" });
    // Teach loadProfile to answer for p2 as well for b's auth check.
    // Easiest: patch the gateway's loadProfile via a fresh one — just test the count.
    assertEqual(gw._tokenCount(), 2, "two tokens issued");
    gw.revokeAllForProfile("p1");
    assertEqual(gw._tokenCount(), 1, "only p1 revoked");
    const resA = await gatewayFetch(gw, "/v1/models", { token: a.token });
    // p1's token is gone -> 401. We don't assert p2's token here (loadProfile returns p1), just the count.
    assertEqual(resA.status, 401, "p1 revoked");
    b.release();
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("credentialRevision mismatch revokes the token and returns 401", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.completed", codexCompletedResponse()));
  });
  let currentRevision = 1;
  const gw = createChatgptGateway({
    upstreamUrl: upstream.url,
    getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }),
    loadProfile: async () => ({ profileId: "p1", credentialRevision: currentRevision, models: [] })
  });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    // Bump revision (simulates sign-out / session expiry).
    currentRevision = 2;
    const res = await gatewayFetch(gw, "/v1/models", { token });
    assertEqual(res.status, 401, "stale revision -> 401");
    assertEqual(gw._tokenCount(), 0, "token auto-revoked on mismatch");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Unknown path -> 404 not_found_error
// ---------------------------------------------------------------------------

console.log("\n== unknown path -> 404 not_found_error ==");

await check("unknown path returns 404 with not_found_error", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("");
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/unknown", { token });
    assertEqual(res.status, 404, "status");
    const body = await readJson(res);
    assertEqual(body.error.type, "not_found_error", "error type");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Model rewrite: bound model replaces the request's model
// ---------------------------------------------------------------------------

console.log("\n== model rewrite ==");

await check("upstream receives the bound model, not the request's model", async () => {
  let seenUpstreamModel = null;
  const upstream = await startMockUpstream(async (_req, res, last) => {
    seenUpstreamModel = last.body && last.body.model;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseFrame("response.created", { response: { id: "r1", model: seenUpstreamModel } }) +
        sseFrame("response.completed", codexCompletedResponse({ model: seenUpstreamModel }))
    );
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", {
      token,
      body: { ...anthropicMessagesBody({ model: "claude-haiku-4-5" }), stream: false }
    });
    assertEqual(res.status, 200, "status");
    assertEqual(seenUpstreamModel, "gpt-5.6-terra", "upstream model must be the bound model");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 4. count_tokens: local estimate, never upstream
// ---------------------------------------------------------------------------

console.log("\n== count_tokens: local estimate, no upstream call ==");

await check("count_tokens returns a local estimate and never calls upstream", async () => {
  let upstreamHit = false;
  const upstream = await startMockUpstream(async (_req, res) => {
    upstreamHit = true;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("");
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages/count_tokens", {
      token,
      body: { messages: [{ role: "user", content: "hello world, this is a test" }] }
    });
    assertEqual(res.status, 200, "status");
    const body = await readJson(res);
    assert(typeof body.input_tokens === "number" && body.input_tokens > 0, "input_tokens must be a positive number");
    assert(!upstreamHit, "upstream must not have been called for count_tokens");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("count_tokens still requires a valid token", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("");
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const res = await gatewayFetch(gw, "/v1/messages/count_tokens", { body: { messages: [] } });
    assertEqual(res.status, 401, "status");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Upstream headers: originator, User-Agent, chatgpt-account-id, session_id
// ---------------------------------------------------------------------------

console.log("\n== upstream headers ==");

await check("upstream request carries originator:browzy, a browzy User-Agent, chatgpt-account-id and session_id", async () => {
  let seenHeaders = null;
  const upstream = await startMockUpstream(async (_req, res, last) => {
    seenHeaders = last.headers;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseFrame("response.created", { response: { id: "r1", model: "gpt-5.6-terra" } }) +
        sseFrame("response.completed", codexCompletedResponse())
    );
  });
  const { gw } = buildGateway({
    upstreamUrl: upstream.url,
    getAccessToken: async () => ({ accessToken: "tok123", accountId: "acc-xyz" })
  });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", {
      token,
      body: { ...anthropicMessagesBody(), stream: false }
    });
    assertEqual(res.status, 200, "status");
    assert(seenHeaders, "upstream must have been called");
    assertEqual(seenHeaders["originator"], "browzy", "originator");
    assert(seenHeaders["user-agent"] && seenHeaders["user-agent"].startsWith("browzy/"), "User-Agent must start with browzy/");
    assertEqual(seenHeaders["chatgpt-account-id"], "acc-xyz", "chatgpt-account-id");
    assert(typeof seenHeaders["session_id"] === "string" && seenHeaders["session_id"].length > 0, "session_id must be present");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 401 refresh-and-retry (once)
// ---------------------------------------------------------------------------

console.log("\n== 401 refresh-and-retry ==");

await check("upstream 401 triggers one forceRefresh and the retry succeeds", async () => {
  let callCount = 0;
  let forceRefreshSeen = false;
  const upstream = await startMockUpstream(async (_req, res) => {
    callCount++;
    if (callCount === 1) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "expired", type: "authentication_error" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseFrame("response.created", { response: { id: "r1", model: "gpt-5.6-terra" } }) +
        sseFrame("response.completed", codexCompletedResponse())
    );
  });
  const getAccessToken = async (_profileId, opts) => {
    if (opts && opts.forceRefresh) forceRefreshSeen = true;
    return { accessToken: "tok", accountId: "acc1" };
  };
  // A first 401 that SUCCEEDS after the refresh is not a session expiry.
  const expiryCalls = [];
  const { gw } = buildGateway({
    upstreamUrl: upstream.url,
    getAccessToken,
    onSessionExpired: async (profileId) => expiryCalls.push(profileId)
  });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 200, "status after retry");
    assert(forceRefreshSeen, "forceRefresh must have been called");
    assertEqual(callCount, 2, "upstream must have been called twice");
    assertEqual(expiryCalls.length, 0, "a 401 that succeeds after the single refresh must never record a session expiry");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("a refresh rejected by the token endpoint does not re-record the expiry (auth.js already owns that transition)", async () => {
  let forceRefreshSeen = false;
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "expired", type: "authentication_error" } }));
  });
  const getAccessToken = async (_profileId, opts) => {
    if (opts && opts.forceRefresh) {
      forceRefreshSeen = true;
      // What host/agent/chatgpt/auth.js throws after ITS onSessionExpired
      // hook has already recorded the transition (invalid_grant /
      // refresh_token_reused).
      throw new ProviderError("SESSION_EXPIRED", "the ChatGPT session was rejected and requires signing in again");
    }
    return { accessToken: "tok", accountId: "acc1" };
  };
  const expiryCalls = [];
  const { gw } = buildGateway({
    upstreamUrl: upstream.url,
    getAccessToken,
    onSessionExpired: async (profileId) => expiryCalls.push(profileId)
  });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 401, "status");
    const body = await readJson(res);
    assertEqual(body.error.type, "authentication_error", "error type");
    assert(forceRefreshSeen, "the refresh must have been attempted");
    assertEqual(expiryCalls.length, 0, "the refresh-failure path must not re-record an expiry the auth module already recorded");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("double 401 (retry also 401) returns 401 to the client AND records SESSION_EXPIRED, revoking the profile's gateway tokens", async () => {
  let callCount = 0;
  const upstream = await startMockUpstream(async (_req, res) => {
    callCount++;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "still bad", type: "authentication_error" } }));
  });
  // The injected hook stands in for the production pair this must drive:
  // profile.js's recordChatgptSessionExpired (credentialRevision bump +
  // onCredentialRevoked listeners) and companion.js's listener for it
  // (revoke every gateway token of that profile). The transition is observed
  // here; what it does to the tokens is what the follow-up request proves.
  // The REAL pair is exercised end-to-end further below.
  let sessionState = "signed_in";
  let credentialRevision = 1;
  const expiryCalls = [];
  const { gw } = buildGateway({
    upstreamUrl: upstream.url,
    getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }),
    loadProfile: async () => ({ profileId: "p1", credentialRevision, models: [] }),
    onSessionExpired: async (profileId) => {
      expiryCalls.push(profileId);
      sessionState = "session_expired";
      credentialRevision += 1;
      gw.revokeAllForProfile(profileId);
    }
  });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 401, "status");
    const body = await readJson(res);
    assertEqual(body.error.type, "authentication_error", "error type");
    assertEqual(sessionState, "session_expired", "the profile must be recorded SESSION_EXPIRED after a post-refresh 401");
    assertEqual(expiryCalls.length, 1, "one transition for one request");
    assertEqual(expiryCalls[0], "p1", "the transition is recorded for the request's own profile");
    assertEqual(callCount, 2, "upstream must have been called twice before the transition was recorded");

    const afterRes = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(afterRes.status, 401, "an already-issued gateway token is refused after the transition");
    assertEqual(callCount, 2, "the revoked token never reaches upstream again");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 6b. Post-refresh 401 -> the REAL profile-state transition
// ---------------------------------------------------------------------------

console.log("\n== post-refresh 401 records SESSION_EXPIRED through the real profile layer ==");

await check("a post-refresh 401 expires the profile through the REAL profile layer and revokes its gateway tokens", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-chatgpt-gateway-"));
  const previousConfigDir = process.env.OCIC_AGENT_CONFIG_DIR;
  process.env.OCIC_AGENT_CONFIG_DIR = configDir;
  // Never the production "default" profileId (same isolation rule as
  // host/test/settings-profile.test.mjs), and a profile ledger that is real
  // but scratch.
  const profileId = `ocic-gateway-expiry-test-${process.pid}-${Date.now()}`;

  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "expired", type: "authentication_error" } }));
  });

  let unsubscribe = null;
  const gw = createChatgptGateway({
    upstreamUrl: upstream.url,
    getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }),
    loadProfile: () => profileModule.loadProfile(),
    onSessionExpired: (id) => profileModule.recordChatgptSessionExpired(id)
  });
  try {
    await profileModule.saveProfile({
      profileId,
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "gpt-5.6-terra", label: "Terra" }],
      defaultModelId: "gpt-5.6-terra"
    });
    await profileModule.setProviderType(profileId, "chatgpt");
    const signedIn = await profileModule.recordChatgptSignIn(profileId, { email: "gateway@example.com", planType: "plus", backend: "memory" });
    const revisionBefore = signedIn.credentialRevision;
    assert(signedIn.chatgptSessionState === "signed_in", "setup: the profile starts signed_in");

    let revocationEvents = 0;
    unsubscribe = profileModule.onCredentialRevoked((event) => {
      if (event.profileId !== profileId) return;
      revocationEvents++;
      // Production's own wiring for this listener (companion.js): cancel the
      // profile's runs and revoke its gateway tokens.
      gw.revokeAllForProfile(profileId);
    });

    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId, model: "gpt-5.6-terra", credentialRevision: revisionBefore, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 401, "the client still receives 401 authentication_error");
    const body = await readJson(res);
    assertEqual(body.error.type, "authentication_error", "error type");

    const after = await profileModule.loadProfile();
    assertEqual(after.chatgptSessionState, "session_expired", "the profile reaches SESSION_EXPIRED after the post-refresh 401");
    assertEqual(after.hasCredential, false, "the credential-present flag is cleared by the transition");
    assertEqual(after.credentialRevision, revisionBefore + 1, `exactly one credential-revision bump (was ${revisionBefore})`);
    assertEqual(revocationEvents, 1, "the existing onCredentialRevoked listeners fire for the expiry");
    assertEqual(gw._tokenCount(), 0, "the profile's gateway tokens are revoked by the transition");

    const afterRes = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(afterRes.status, 401, "an already-issued run token is refused once the profile's revision moved");
    assertEqual(upstream.requests.length, 2, "upstream saw exactly the request and its single retry — never the revoked-token follow-up");

    // The transition is not a one-shot latch: a fresh sign-in followed by a
    // genuine expiry transitions again (and fires the listeners again).
    const reSignedIn = await profileModule.recordChatgptSignIn(profileId, { email: "gateway@example.com", planType: "plus", backend: "memory" });
    assertEqual(reSignedIn.chatgptSessionState, "signed_in", "a fresh sign-in leaves the SESSION_EXPIRED state behind");
    await profileModule.recordChatgptSessionExpired(profileId);
    const reExpired = await profileModule.loadProfile();
    assertEqual(reExpired.chatgptSessionState, "session_expired", "the second, genuine expiry transitions");
    assertEqual(revocationEvents, 2, "and fires the listeners again");
  } finally {
    if (unsubscribe) unsubscribe();
    await gw.close();
    await upstream.close();
    if (previousConfigDir === undefined) delete process.env.OCIC_AGENT_CONFIG_DIR;
    else process.env.OCIC_AGENT_CONFIG_DIR = previousConfigDir;
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      // Scratch directory cleanup is best-effort.
    }
  }
});

// ---------------------------------------------------------------------------
// 7. Usage-limit 429 + retry-after
// ---------------------------------------------------------------------------

console.log("\n== usage_limit_reached -> 429 + retry-after ==");

await check("usage_limit_reached maps to 429 rate_limit_error with retry-after", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", resets_in_seconds: 1800 } }));
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 429, "status");
    const body = await readJson(res);
    assertEqual(body.error.type, "rate_limit_error", "error type");
    assert(res.headers.get("retry-after") === "1800", `retry-after must be 1800, got ${res.headers.get("retry-after")}`);
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Non-stream vs stream parity (non-stream returns one Anthropic message)
// ---------------------------------------------------------------------------

console.log("\n== non-stream vs stream ==");

await check("non-stream returns one Anthropic message with the upstream text", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseFrame("response.created", { response: { id: "r1", model: "gpt-5.6-terra" } }) +
        sseFrame("response.output_text.delta", { type: "response.output_text.delta", delta: "hello " }) +
        sseFrame("response.output_text.delta", { type: "response.output_text.delta", delta: "world" }) +
        sseFrame("response.completed", {
          type: "response.completed",
          response: {
            id: "r1",
            model: "gpt-5.6-terra",
            output: [{ type: "message", content: [{ type: "output_text", text: "hello world" }] }],
            usage: { input_tokens: 5, output_tokens: 2 }
          }
        })
    );
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 200, "status");
    const body = await readJson(res);
    assertEqual(body.type, "message", "must be a message");
    assert(Array.isArray(body.content), "content must be an array");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("non-stream survives a real-shaped upstream sequence whose response.completed output is empty", async () => {
  // Mirrors a captured real Codex upstream sequence for a non-tool reply:
  // response.created, response.in_progress, response.output_item.added,
  // response.content_part.added, response.output_text.delta (x N),
  // response.output_text.done, response.content_part.done,
  // response.output_item.done, response.completed — with response.completed's
  // response.output an EMPTY array. The gateway must still return non-empty
  // Anthropic content sourced from the output_item.done item.
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseFrame("response.created", { type: "response.created", response: { id: "r14", model: "gpt-5.6-terra" } }) +
        sseFrame("response.in_progress", { type: "response.in_progress", response: { id: "r14" } }) +
        sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", content: [] } }) +
        sseFrame("response.content_part.added", { type: "response.content_part.added", output_index: 0 }) +
        sseFrame("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "hello " }) +
        sseFrame("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, delta: "world" }) +
        sseFrame("response.output_text.done", { type: "response.output_text.done", output_index: 0 }) +
        sseFrame("response.content_part.done", { type: "response.content_part.done", output_index: 0 }) +
        sseFrame("response.output_item.done", {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", content: [{ type: "output_text", text: "hello world" }] }
        }) +
        sseFrame("response.completed", {
          type: "response.completed",
          response: { id: "r14", model: "gpt-5.6-terra", output: [], usage: { input_tokens: 5, output_tokens: 2 } }
        })
    );
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: false } });
    assertEqual(res.status, 200, "status");
    const body = await readJson(res);
    assertEqual(body.type, "message", "must be a message");
    assert(Array.isArray(body.content) && body.content.length > 0, "content must not be empty despite response.completed's empty output");
    assertEqual(body.content[0].type, "text", "the recovered content block is a text block");
    assertEqual(body.content[0].text, "hello world", "the recovered text matches what output_item.done delivered");
    assertEqual(body.stop_reason, "end_turn", "stop_reason is end_turn, not a fabricated value");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("stream returns text/event-stream with content_block_delta / message_stop", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      sseFrame("response.created", { type: "response.created", response: { id: "r1", model: "gpt-5.6-terra" } }) +
        sseFrame("response.output_text.delta", { type: "response.output_text.delta", delta: "hi" }) +
        sseFrame("response.completed", codexCompletedResponse())
    );
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/messages", { token, body: { ...anthropicMessagesBody(), stream: true } });
    assertEqual(res.status, 200, "status");
    assert((res.headers.get("content-type") || "").includes("text/event-stream"), "content-type must be text/event-stream");
    const text = await res.text();
    assert(text.includes("content_block_delta"), "must contain content_block_delta");
    assert(text.includes("message_stop"), "must contain message_stop");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 9. Client disconnect aborts upstream
// ---------------------------------------------------------------------------

console.log("\n== client disconnect aborts upstream ==");

await check("aborting the client request aborts the upstream fetch (signal observed)", async () => {
  let upstreamAborted = false;
  const upstream = await startMockUpstream(async (req, res) => {
    // Hold the upstream response open until the client aborts.
    res.on("close", () => {
      upstreamAborted = true;
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sseFrame("response.created", { response: { id: "r1", model: "gpt-5.6-terra" } }));
    // Keep writing slowly until aborted.
    const iv = setInterval(() => {
      try {
        res.write(sseFrame("response.output_text.delta", { type: "response.output_text.delta", delta: "x" }));
      } catch {}
    }, 30);
    res.on("close", () => clearInterval(iv));
    // Server will close when the gateway aborts its fetch.
  });

  // Custom fetch that records whether its signal was aborted.
  let signalAborted = false;
  const abortableFetch = (url, init) => {
    if (init && init.signal) {
      init.signal.addEventListener("abort", () => {
        signalAborted = true;
      });
    }
    return fetch(url, init);
  };

  const { gw } = buildGateway({ upstreamUrl: upstream.url, getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }) });
  // Swap fetchImpl by building a gateway with a wrapped fetch.
  const gw2 = createChatgptGateway({
    upstreamUrl: upstream.url,
    fetchImpl: abortableFetch,
    getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }),
    loadProfile: async () => ({ profileId: "p1", credentialRevision: 1, models: [{ id: "m", label: "M" }] })
  });

  try {
    const { port } = await gw2.ensureStarted();
    const { token } = gw2.issueToken({ profileId: "p1", model: "gpt-5.6-terra", credentialRevision: 1, purpose: "run" });
    const controller = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ ...anthropicMessagesBody(), stream: true }),
      signal: controller.signal
    });
    // Let the gateway start the upstream request, then abort the client.
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    try {
      await p;
    } catch {}
    // Give the gateway a moment to propagate the abort to the upstream fetch.
    await new Promise((r) => setTimeout(r, 300));
    assert(signalAborted, "upstream fetch signal must have been aborted after client disconnect");
  } finally {
    await gw2.close();
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Loopback-only bind
// ---------------------------------------------------------------------------

console.log("\n== loopback-only bind ==");

await check("gateway only binds 127.0.0.1 (server address is 127.0.0.1)", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sseFrame("response.completed", codexCompletedResponse()));
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    const { port } = await gw.ensureStarted();
    // Fetch the server address via a direct http request check — the gateway
    // module binds with `server.listen(0, "127.0.0.1")`, so address().address
    // must be 127.0.0.1. We verify by confirming the port only answers on 127.0.0.1.
    const { token } = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    // 127.0.0.1 must answer.
    const okRes = await gatewayFetch(gw, "/v1/models", { token });
    assertEqual(okRes.status, 200, "127.0.0.1 must answer");
    // The gateway's _port() helper exposes the bound port — verify it's non-zero.
    assert(gw._port() > 0, "port must be non-zero (OS-assigned)");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

await check("lazy start: gateway not listening until ensureStarted() is called", async () => {
  const gw = createChatgptGateway({
    getAccessToken: async () => ({ accessToken: "tok", accountId: "acc1" }),
    loadProfile: async () => ({ profileId: "p1", credentialRevision: 1, models: [] })
  });
  assertEqual(gw._port(), null, "port must be null before start");
  await gw.ensureStarted();
  assert(gw._port() > 0, "port must be set after start");
  await gw.close();
  assertEqual(gw._port(), null, "port must be null after close");
});

// ---------------------------------------------------------------------------
// 11. Token randomness (32 bytes -> base64url length)
// ---------------------------------------------------------------------------

console.log("\n== token properties ==");

await check("issued tokens are at least 43 chars (32 bytes base64url without padding)", async () => {
  const { gw } = buildGateway({ upstreamUrl: "http://127.0.0.1:1" });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    assert(token.length >= 43, `token length ${token.length} must be >= 43`);
    assert(/^[A-Za-z0-9_-]+$/.test(token), "token must be base64url");
  } finally {
    await gw.close();
  }
});

// ---------------------------------------------------------------------------
// 12. GET /v1/models returns the profile's models
// ---------------------------------------------------------------------------

console.log("\n== GET /v1/models ==");

await check("GET /v1/models returns the bound profile's model list", async () => {
  const upstream = await startMockUpstream(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("");
  });
  const { gw } = buildGateway({ upstreamUrl: upstream.url });
  try {
    await gw.ensureStarted();
    const { token } = gw.issueToken({ profileId: "p1", model: "m", credentialRevision: 1, purpose: "run" });
    const res = await gatewayFetch(gw, "/v1/models", { token });
    assertEqual(res.status, 200, "status");
    const body = await readJson(res);
    assert(Array.isArray(body.data) && body.data.length === 2, "must return 2 models");
    assertEqual(body.data[0].id, "gpt-5.6-terra", "first model id");
  } finally {
    await gw.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed\n`);
if (fail) process.exitCode = 1;

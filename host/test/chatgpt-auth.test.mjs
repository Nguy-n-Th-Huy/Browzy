#!/usr/bin/env node
//
// ChatGPT (Codex) OAuth sign-in / credential lifecycle
// (host/agent/chatgpt/auth.js), exercised entirely against local mock HTTP
// servers and an ephemeral loopback callback port — never a real OpenAI
// endpoint, and never the real OS credential store (every instance here
// injects its own in-memory fake secret store; see createFakeSecretStore()).
//
// Run: node host/test/chatgpt-auth.test.mjs

import http from "node:http";
import nodeCrypto from "node:crypto";
import { createChatgptAuth, chatgptSecretTarget } from "../agent/chatgpt/auth.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Test doubles ---

/** An in-memory secret store — never the real OS credential store. */
function createFakeSecretStore() {
  const store = new Map();
  return {
    calls: { store: 0, read: 0, delete: 0 },
    store,
    async storeSecretImpl(target, secret, opts) {
      this.calls.store++;
      store.set(target, secret);
      return { backend: opts && opts.memoryOnly ? "memory" : "fake-os" };
    },
    async readSecretImpl(target) {
      this.calls.read++;
      return store.has(target) ? store.get(target) : null;
    },
    async deleteSecretImpl(target) {
      this.calls.delete++;
      const existed = store.has(target);
      store.delete(target);
      return existed;
    }
  };
}

/** A base64url JWT-shaped ID token — never signature-verified by auth.js. */
function makeIdToken(claims) {
  const seg = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${seg({ alg: "none", typ: "JWT" })}.${seg(claims)}.sig`;
}

function idTokenFor({ email, accountId, planType }) {
  return makeIdToken({
    email,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: planType }
  });
}

/**
 * A minimal JSON/form-aware mock HTTP server on an ephemeral loopback port.
 * `routes` maps an exact pathname to `(body, req) -> { status, json }`.
 */
function startMockServer(routes) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf-8");
      const pathname = req.url.split("?")[0];
      const handler = routes[pathname];
      if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      let body = {};
      const contentType = req.headers["content-type"] || "";
      try {
        body = contentType.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        body = {};
      }
      let result;
      try {
        result = await handler(body, req);
      } catch (err) {
        result = { status: 500, json: { error: "handler_threw", message: err.message } };
      }
      res.writeHead(result.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.json || {}));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serverUrl(server, pathname) {
  return `http://127.0.0.1:${server.address().port}${pathname}`;
}

/** Pull `redirect_uri`/`state`/`code_challenge` back out of a returned authUrl. */
function parseAuthUrl(authUrl) {
  const u = new URL(authUrl);
  return {
    origin: `${u.protocol}//${u.host}`,
    pathname: u.pathname,
    params: u.searchParams,
    redirectUri: u.searchParams.get("redirect_uri"),
    state: u.searchParams.get("state"),
    challenge: u.searchParams.get("code_challenge")
  };
}

async function getText(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A standard authorization_code + refresh_token mock OAuth token server. The
// refresh branch is overridable per test via `onRefresh`.
function startTokenServer({ email = "user@example.com", accountId = "acct_1", planType = "plus", onRefresh } = {}) {
  let refreshCallCount = 0;
  const server = startMockServer({
    "/oauth/token": async (body) => {
      if (body.grant_type === "authorization_code") {
        return {
          status: 200,
          json: {
            access_token: `access-${body.code}`,
            refresh_token: `refresh-${body.code}`,
            id_token: idTokenFor({ email, accountId, planType }),
            expires_in: 3600
          }
        };
      }
      if (body.grant_type === "refresh_token") {
        refreshCallCount++;
        if (onRefresh) return onRefresh(body, refreshCallCount);
        return {
          status: 200,
          json: { access_token: `access-rotated-${refreshCallCount}`, refresh_token: `refresh-rotated-${refreshCallCount}`, expires_in: 3600 }
        };
      }
      return { status: 400, json: { error: "unsupported_grant_type" } };
    }
  });
  return server.then((s) => ({ server: s, url: serverUrl0(s, "/oauth/token"), getRefreshCallCount: () => refreshCallCount }));
}
function serverUrl0(s, p) {
  return serverUrl(s, p);
}

console.log("\nChatGPT (Codex) OAuth sign-in and credential lifecycle\n");

// --- Authorize URL / PKCE ---

await check("startBrowserSignIn returns an authorize URL with the exact spec params", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const parsed = parseAuthUrl(authUrl);
    assert(authUrl.startsWith("https://auth.openai.com/oauth/authorize?"), authUrl);
    assert(parsed.params.get("client_id") === "app_EMoamEEZ73f0CkXaXp7hrann", parsed.params.get("client_id"));
    assert(parsed.params.get("response_type") === "code");
    assert(parsed.params.get("scope") === "openid email profile offline_access");
    assert(parsed.params.get("code_challenge_method") === "S256");
    assert(parsed.params.get("prompt") === "login");
    assert(parsed.params.get("id_token_add_organizations") === "true");
    assert(parsed.params.get("codex_cli_simplified_flow") === "true");
    assert(typeof parsed.state === "string" && parsed.state.length > 0);
    assert(typeof parsed.challenge === "string" && parsed.challenge.length > 0);
    assert(parsed.redirectUri.endsWith("/auth/callback"), parsed.redirectUri);
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("the PKCE challenge equals base64url(sha256(verifier)) for a 96-byte verifier", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  let capturedVerifier = null;
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({}),
    randomBytes: (size) => {
      const bytes = nodeCrypto.randomBytes(size);
      if (size === 96) capturedVerifier = bytes;
      return bytes;
    }
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const parsed = parseAuthUrl(authUrl);
    const verifierB64Url = Buffer.from(capturedVerifier)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const expectedChallenge = nodeCrypto
      .createHash("sha256")
      .update(verifierB64Url)
      .digest()
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    assert(parsed.challenge === expectedChallenge, `${parsed.challenge} !== ${expectedChallenge}`);
    assert(capturedVerifier.length === 96, `verifier must be 96 raw bytes, got ${capturedVerifier.length}`);
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

// --- Browser callback: state mismatch, success, cancel, timeout, supersede ---

await check("a callback with a mismatched state shows an error page and stays pending", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId, authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri } = parseAuthUrl(authUrl);
    const res = await getText(`${redirectUri}?code=irrelevant&state=totally-wrong-state`);
    assert(res.status === 400, res.status);
    assert(/close this tab/i.test(res.text), res.text);
    const status = auth.getSignInStatus(signInId);
    assert(status.state === "pending", JSON.stringify(status));
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("a matching callback exchanges the code, stores the credential, and reports signed_in", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer({ email: "alice@example.com", accountId: "acct_alice", planType: "pro" });
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId, authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    const res = await getText(`${redirectUri}?code=abc123&state=${state}`);
    assert(res.status === 200, res.status);
    assert(/close this tab/i.test(res.text), res.text);
    const status = auth.getSignInStatus(signInId);
    assert(status.state === "signed_in", JSON.stringify(status));
    assert(status.account.email === "alice@example.com", JSON.stringify(status.account));
    assert(status.account.planType === "pro", JSON.stringify(status.account));
    assert(store.store.get(chatgptSecretTarget("p1")) === JSON.stringify({ v: 1, refresh_token: "refresh-abc123", account_id: "acct_alice" }));
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("cancelSignIn marks a pending sign-in as SIGN_IN_CANCELLED and closes the listener", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId, authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri } = parseAuthUrl(authUrl);
    await auth.cancelSignIn(signInId);
    const status = auth.getSignInStatus(signInId);
    assert(status.state === "failed" && status.code === "SIGN_IN_CANCELLED", JSON.stringify(status));
    // The listener must actually be closed — a request against it now fails to connect.
    await sleep(20);
    let connectFailed = false;
    try {
      await getText(`${redirectUri}?code=x&state=y`);
    } catch {
      connectFailed = true;
    }
    assert(connectFailed, "expected the callback listener to be closed after cancellation");
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("a browser sign-in times out with SIGN_IN_TIMEOUT when no valid callback arrives", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    browserSignInTimeoutMs: 40,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId } = await auth.startBrowserSignIn({ profileId: "p1" });
    await sleep(150);
    const status = auth.getSignInStatus(signInId);
    assert(status.state === "failed" && status.code === "SIGN_IN_TIMEOUT", JSON.stringify(status));
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("starting a new browser sign-in for the same profile cancels the previous one", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const first = await auth.startBrowserSignIn({ profileId: "p1" });
    const second = await auth.startBrowserSignIn({ profileId: "p1" });
    assert(first.signInId !== second.signInId);
    const firstStatus = auth.getSignInStatus(first.signInId);
    assert(firstStatus.state === "failed" && firstStatus.code === "SIGN_IN_CANCELLED", JSON.stringify(firstStatus));
    // The second sign-in must still be usable.
    const { redirectUri, state } = parseAuthUrl(second.authUrl);
    const res = await getText(`${redirectUri}?code=abc&state=${state}`);
    assert(res.status === 200, res.status);
    const secondStatus = auth.getSignInStatus(second.signInId);
    assert(secondStatus.state === "signed_in", JSON.stringify(secondStatus));
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("binding an already-used callback port fails with CALLBACK_PORT_IN_USE", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const busyServer = http.createServer(() => {});
  await new Promise((resolve) => busyServer.listen(0, "127.0.0.1", resolve));
  const busyPort = busyServer.address().port;
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: busyPort,
    browserRedirectUri: `http://127.0.0.1:${busyPort}/auth/callback`,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    let code = null;
    try {
      await auth.startBrowserSignIn({ profileId: "p1" });
    } catch (err) {
      code = err.code;
    }
    assert(code === "CALLBACK_PORT_IN_USE", `expected CALLBACK_PORT_IN_USE, got ${code}`);
  } finally {
    auth._dispose();
    tokenServer.server.close();
    busyServer.close();
  }
});

// --- Device-code sign-in ---

await check("device sign-in: pending polls (403) until approval, then reports signed_in", async () => {
  const store = createFakeSecretStore();
  let pollCount = 0;
  const server = await startMockServer({
    "/device/usercode": async () => ({ status: 200, json: { device_auth_id: "dev1", user_code: "ABCD-1234", interval: "0.03" } }),
    "/device/token": async () => {
      pollCount++;
      if (pollCount < 3) return { status: 403, json: { error: "authorization_pending" } };
      return { status: 200, json: { authorization_code: "device-code-xyz", code_verifier: "verifier-from-device" } };
    },
    "/oauth/token": async (body) => {
      assert(body.grant_type === "authorization_code");
      assert(body.redirect_uri === "https://auth.openai.com/deviceauth/callback");
      return {
        status: 200,
        json: {
          access_token: "device-access",
          refresh_token: "device-refresh",
          id_token: idTokenFor({ email: "dev@example.com", accountId: "acct_dev", planType: "team" }),
          expires_in: 3600
        }
      };
    }
  });
  const auth = createChatgptAuth({
    deviceUserCodeUrl: serverUrl(server, "/device/usercode"),
    deviceTokenUrl: serverUrl(server, "/device/token"),
    tokenUrl: serverUrl(server, "/oauth/token"),
    defaultDevicePollIntervalMs: 10,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId, userCode, verificationUrl, expiresAt } = await auth.startDeviceSignIn({ profileId: "p1" });
    assert(userCode === "ABCD-1234", userCode);
    assert(verificationUrl === "https://auth.openai.com/codex/device", verificationUrl);
    assert(typeof expiresAt === "number" && expiresAt > Date.now());
    // Poll until the background loop reaches a terminal state.
    let status;
    for (let i = 0; i < 50; i++) {
      status = auth.getSignInStatus(signInId);
      if (status.state !== "pending") break;
      await sleep(20);
    }
    assert(status.state === "signed_in", JSON.stringify(status));
    assert(status.account.email === "dev@example.com", JSON.stringify(status.account));
    assert(pollCount >= 3, pollCount);
  } finally {
    auth._dispose();
    server.close();
  }
});

await check("device sign-in stops after its cap with SIGN_IN_TIMEOUT when never approved", async () => {
  const store = createFakeSecretStore();
  const server = await startMockServer({
    "/device/usercode": async () => ({ status: 200, json: { device_auth_id: "dev1", user_code: "NEVER-1234", interval: "0.01" } }),
    "/device/token": async () => ({ status: 403, json: { error: "authorization_pending" } })
  });
  const auth = createChatgptAuth({
    deviceUserCodeUrl: serverUrl(server, "/device/usercode"),
    deviceTokenUrl: serverUrl(server, "/device/token"),
    deviceSignInTimeoutMs: 60,
    defaultDevicePollIntervalMs: 15,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId } = await auth.startDeviceSignIn({ profileId: "p1" });
    let status;
    for (let i = 0; i < 50; i++) {
      status = auth.getSignInStatus(signInId);
      if (status.state !== "pending") break;
      await sleep(20);
    }
    assert(status.state === "failed" && status.code === "SIGN_IN_TIMEOUT", JSON.stringify(status));
  } finally {
    auth._dispose();
    server.close();
  }
});

// --- Refresh: rotation ordering, single-flight, reused-token, secret-too-large ---

await check("getAccessToken persists the rotated refresh token before its promise resolves", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  let storedBeforeResolve = false;
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: async (...args) => {
      const result = await store.storeSecretImpl(...args);
      storedBeforeResolve = true;
      return result;
    },
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    storedBeforeResolve = false; // reset — only the upcoming refresh's store matters now

    const before = store.store.get(chatgptSecretTarget("p1"));
    const { accessToken } = await auth.getAccessToken("p1", { forceRefresh: true });
    assert(storedBeforeResolve === true, "the rotated refresh token must be persisted before getAccessToken() resolves");
    const after = store.store.get(chatgptSecretTarget("p1"));
    assert(after !== before, "the stored secret must change after a rotating refresh");
    assert(accessToken === "access-rotated-1", accessToken);
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("two concurrent getAccessToken calls trigger exactly one refresh request", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);

    const [a, b] = await Promise.all([
      auth.getAccessToken("p1", { forceRefresh: true }),
      auth.getAccessToken("p1", { forceRefresh: true })
    ]);
    assert(a.accessToken === b.accessToken, `expected the same token from both concurrent calls, got ${a.accessToken} / ${b.accessToken}`);
    assert(tokenServer.getRefreshCallCount() === 1, `expected exactly one refresh request, got ${tokenServer.getRefreshCallCount()}`);
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("a cached, non-expiring access token is reused without any refresh request", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    const first = await auth.getAccessToken("p1");
    const second = await auth.getAccessToken("p1");
    assert(first.accessToken === second.accessToken);
    assert(tokenServer.getRefreshCallCount() === 0, "a fresh, non-expiring token must never trigger a refresh");
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("a refresh rejected as refresh_token_reused removes the secret, fires the callback, and reports SESSION_EXPIRED", async () => {
  const store = createFakeSecretStore();
  let sessionExpiredEvents = [];
  const tokenServer = await startTokenServer({
    onRefresh: () => ({ status: 400, json: { error: "refresh_token_reused" } })
  });
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({}),
    onSessionExpired: async (event) => {
      sessionExpiredEvents.push(event);
    }
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    assert(store.store.has(chatgptSecretTarget("p1")), "the secret must exist right after sign-in");

    let code = null;
    try {
      await auth.getAccessToken("p1", { forceRefresh: true });
    } catch (err) {
      code = err.code;
    }
    assert(code === "SESSION_EXPIRED", `expected SESSION_EXPIRED, got ${code}`);
    assert(!store.store.has(chatgptSecretTarget("p1")), "the secret must be removed after refresh_token_reused");
    assert(sessionExpiredEvents.length === 1 && sessionExpiredEvents[0].profileId === "p1", JSON.stringify(sessionExpiredEvents));
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("an oversize credential fails with SECRET_TOO_LARGE and is never stored", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    maxSecretBytes: 32,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId, authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    const status = auth.getSignInStatus(signInId);
    assert(status.state === "failed" && status.code === "SECRET_TOO_LARGE", JSON.stringify(status));
    assert(!store.store.has(chatgptSecretTarget("p1")), "an oversize secret must never be stored, truncated or otherwise");
    assert(store.calls.store === 0, "storeSecretImpl must never have been called");
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("a memory-only sign-in reports the memory backend and the credential is usable afterward", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  let signedInBackend = null;
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({}),
    onSignedIn: async (event) => {
      signedInBackend = event.backend;
    }
  });
  try {
    const { signInId, authUrl } = await auth.startBrowserSignIn({ profileId: "p1", memoryOnly: true });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    assert(auth.getSignInStatus(signInId).state === "signed_in");
    assert(signedInBackend === "memory", signedInBackend);
    const { accessToken } = await auth.getAccessToken("p1");
    assert(accessToken === "access-abc", accessToken);
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

await check("signOut clears memory tokens, deletes the secret, and fires onSignedOut", async () => {
  const store = createFakeSecretStore();
  const tokenServer = await startTokenServer();
  let signedOutEvents = [];
  const auth = createChatgptAuth({
    tokenUrl: tokenServer.url,
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({}),
    onSignedOut: async (event) => {
      signedOutEvents.push(event);
    }
  });
  try {
    const { authUrl } = await auth.startBrowserSignIn({ profileId: "p1" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    assert(store.store.has(chatgptSecretTarget("p1")));

    await auth.signOut("p1");
    assert(!store.store.has(chatgptSecretTarget("p1")), "signOut must remove the stored secret");
    assert(signedOutEvents.length === 1 && signedOutEvents[0].profileId === "p1");

    let code = null;
    try {
      await auth.getAccessToken("p1", { forceRefresh: true });
    } catch (err) {
      code = err.code;
    }
    assert(code === "NO_CREDENTIAL", `expected NO_CREDENTIAL after sign-out, got ${code}`);
  } finally {
    auth._dispose();
    tokenServer.server.close();
  }
});

// --- No token leakage ---

await check("no ChatGPT token value ever appears in a thrown error message", async () => {
  const SENTINEL = "SENTINEL-TOKEN-VALUE-DO-NOT-LEAK-9f3a7c";
  const messages = [];
  const store = createFakeSecretStore();
  const server = await startMockServer({
    "/oauth/token": async (body) => {
      if (body.grant_type === "authorization_code") {
        return {
          status: 200,
          json: {
            access_token: SENTINEL,
            refresh_token: SENTINEL,
            id_token: idTokenFor({ email: "leak@example.com", accountId: "acct_leak", planType: "plus" }),
            expires_in: 3600
          }
        };
      }
      // A real server would never echo the token back, but even if a buggy
      // one did, that response body must never be forwarded verbatim into a
      // thrown message — only classified (invalid_grant vs. other failure).
      return { status: 400, json: { error: "invalid_grant", error_description: `refresh token ${SENTINEL} is invalid` } };
    }
  });
  const auth = createChatgptAuth({
    tokenUrl: serverUrl(server, "/oauth/token"),
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    storeSecretImpl: store.storeSecretImpl.bind(store),
    readSecretImpl: store.readSecretImpl.bind(store),
    deleteSecretImpl: store.deleteSecretImpl.bind(store),
    loadCredentialInfo: async () => ({})
  });
  try {
    const { signInId, authUrl } = await auth.startBrowserSignIn({ profileId: "p-leak" });
    const { redirectUri, state } = parseAuthUrl(authUrl);
    await getText(`${redirectUri}?code=abc&state=${state}`);
    messages.push(JSON.stringify(auth.getSignInStatus(signInId)));

    try {
      await auth.getAccessToken("p-leak", { forceRefresh: true });
    } catch (err) {
      messages.push(err.message);
      messages.push(JSON.stringify(err.detail || {}));
    }

    // Also exercise the state-mismatch and cancel paths, which never see a
    // real token but must not somehow echo internal state either.
    const second = await auth.startBrowserSignIn({ profileId: "p-leak-2" });
    const parsedSecond = parseAuthUrl(second.authUrl);
    const mismatchRes = await getText(`${parsedSecond.redirectUri}?code=abc&state=wrong`);
    messages.push(mismatchRes.text);
    await auth.cancelSignIn(second.signInId);
    messages.push(JSON.stringify(auth.getSignInStatus(second.signInId)));
  } finally {
    auth._dispose();
    server.close();
  }
  const joined = messages.join("\n");
  assert(!joined.includes(SENTINEL), `sentinel token value leaked into an error/status message: ${joined}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;

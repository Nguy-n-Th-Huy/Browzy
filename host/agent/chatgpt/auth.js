// ChatGPT (Codex) OAuth sign-in, credential storage, and access-token
// lifecycle (add-chatgpt-subscription-provider design.md decision 3).
//
// The OAuth endpoints, client id, PKCE shape, device-flow field names and
// scopes are ported from router-for-me/CLIProxyAPI @ ac02da6 (MIT):
//   internal/auth/codex/openai_auth.go   (authorize URL, code exchange, refresh)
//   internal/auth/codex/pkce.go          (96-byte verifier, S256 challenge)
//   internal/auth/codex/jwt_parser.go    (ID-token claim shape)
//   sdk/auth/codex_device.go             (device usercode/poll/exchange)
// Deliberately NOT ported: the `codex-tui`/CLI user agent and originator
// (this module never sends any upstream request itself — the gateway that
// does, in a later batch, identifies itself honestly as `browzy`), account
// pooling/failover, and uTLS fingerprinting. See design.md decision 6.
//
// Every network endpoint, the callback host/port, the clock, the random byte
// source and `fetch` are constructor options of `createChatgptAuth()` so
// tests run entirely against local mock servers and an ephemeral callback
// port — see host/test/chatgpt-auth.test.mjs. `createChatgptAuth()` with no
// options (the module's default export functions, below) wires the real
// OpenAI endpoints, port 1455, and host/agent/settings/profile.js's
// credential-lifecycle helpers, for production use.
//
// Exported contract:
//   createChatgptAuth(options?) -> {
//     startBrowserSignIn({profileId, memoryOnly?}) -> Promise<{signInId, authUrl}>
//     startDeviceSignIn({profileId, memoryOnly?}) -> Promise<{signInId, userCode, verificationUrl, expiresAt}>
//     getSignInStatus(signInId) -> {state:"pending"} | {state:"signed_in", account:{email,planType}} | {state:"failed", code, message}
//     cancelSignIn(signInId) -> Promise<void>
//     getAccessToken(profileId, {forceRefresh?}) -> Promise<{accessToken, accountId}>
//     signOut(profileId) -> Promise<void>
//     _dispose() -> void   (test-only: closes any open callback listeners/timers)
//   }
// Plus the default (real-endpoint, profile.js-wired) instance's methods
// re-exported at module scope: startBrowserSignIn, startDeviceSignIn,
// getSignInStatus, cancelSignIn, getAccessToken, signOut.

import crypto from "node:crypto";
import http from "node:http";
import { ProviderError } from "../settings/errors.js";
import { storeSecret, readSecret, deleteSecret } from "../secrets/secret-store.js";
import { recordChatgptSignIn, recordChatgptSessionExpired, recordChatgptSignOut, loadProfile } from "../settings/profile.js";

// --- Codex OAuth constants (production defaults; every one is an
// overridable constructor option) ---
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const CODEX_OAUTH_SCOPE = "openid email profile offline_access";
export const CODEX_CALLBACK_HOST = "127.0.0.1";
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";

const BROWSER_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_DEVICE_POLL_INTERVAL_MS = 5 * 1000;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
// Windows Credential Manager's CRED_MAX_CREDENTIAL_BLOB_SIZE — 5 * 512 bytes
// (host/agent/secrets/windows-credential-manager.js). Applied to every
// backend, not only Windows: a fixed, backend-agnostic ceiling gives
// consistent, testable behaviour instead of a per-OS special case, and the
// stored secret (a refresh token plus an account id) is normally far below
// it — the spec's "never truncate" requirement means an oversize secret must
// fail loudly no matter which OS is running.
const DEFAULT_MAX_SECRET_BYTES = 2560;

/**
 * @param {string} profileId
 * @returns {string} the secret-store target for a ChatGPT profile's
 *   refresh-token credential — distinct from profile.js's own
 *   `browzy-in-chrome/settings/<profileId>` target (the anthropic API key),
 *   because a chatgpt profile never has an API key at all.
 */
export function chatgptSecretTarget(profileId) {
  return `browzy-in-chrome/chatgpt/${profileId}`;
}

function toBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * RFC 7636 S256 PKCE pair: a 96-byte random verifier (128 base64url
 * characters) and its SHA-256 challenge, both base64url without padding —
 * matching CLIProxyAPI's `pkce.go` exactly.
 * @param {(size: number) => Buffer | Uint8Array} randomBytesFn
 */
function generatePkce(randomBytesFn) {
  const verifier = toBase64Url(randomBytesFn(96));
  const challenge = toBase64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Decode a JWT's claims WITHOUT verifying its signature. This is safe here,
 * and only here, because the token was received directly over TLS from the
 * OAuth token endpoint in this same exchange — never supplied by, or routed
 * through, anything the user's browser or another party controls. The result
 * is used only for display (email, plan) and routing (account id) claims,
 * never as an authorization decision.
 * @param {string} idToken
 */
function decodeIdTokenClaims(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) {
    throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT sign-in response did not include a usable ID token");
  }
  let payloadJson;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    payloadJson = Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT sign-in response's ID token could not be decoded");
  }
  try {
    return JSON.parse(payloadJson);
  } catch {
    throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT sign-in response's ID token was not valid JSON");
  }
}

function parseDevicePollIntervalMs(raw, fallbackMs) {
  if (raw === undefined || raw === null || raw === "") return fallbackMs;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  return fallbackMs;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (handle.unref) handle.unref();
  });
}

function toProviderError(err, fallbackCode) {
  if (err instanceof ProviderError) return err;
  // Deliberately carry over only `err.message` (never a raw response body —
  // see the module doc comment's no-token-leakage requirement) — a network
  // error's message is a short, generic libuv/undici string, never anything
  // an upstream response body could have echoed back.
  return new ProviderError(fallbackCode, err && err.message ? err.message : String(err));
}

/**
 * Build a fully independent ChatGPT auth service. Every option has a
 * production-real default; tests override the network endpoints, the
 * callback host/port, `now`/`randomBytes`/`fetchImpl`, and the
 * secret-store/profile-lifecycle hooks so nothing here ever reaches a real
 * OpenAI endpoint, a real loopback port collision, or a real OS credential
 * store during a test run.
 *
 * @param {object} [options]
 * @param {string} [options.authorizeUrl]
 * @param {string} [options.tokenUrl]
 * @param {string} [options.clientId]
 * @param {string} [options.browserRedirectUri]
 * @param {string} [options.deviceUserCodeUrl]
 * @param {string} [options.deviceTokenUrl]
 * @param {string} [options.deviceVerificationUrl]
 * @param {string} [options.deviceRedirectUri]
 * @param {string} [options.scope]
 * @param {string} [options.callbackHost]
 * @param {number} [options.callbackPort]
 * @param {string} [options.callbackPath]
 * @param {number} [options.browserSignInTimeoutMs]
 * @param {number} [options.deviceSignInTimeoutMs]
 * @param {number} [options.defaultDevicePollIntervalMs]
 * @param {number} [options.refreshWindowMs]
 * @param {number} [options.maxSecretBytes]
 * @param {() => number} [options.now]
 * @param {(size: number) => Buffer | Uint8Array} [options.randomBytes]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(profileId: string) => string} [options.secretTarget]
 * @param {typeof storeSecret} [options.storeSecretImpl]
 * @param {typeof readSecret} [options.readSecretImpl]
 * @param {typeof deleteSecret} [options.deleteSecretImpl]
 * @param {(profileId: string) => Promise<{memoryOnly?: boolean, backend?: string} | null>} [options.loadCredentialInfo]
 * @param {(event: {profileId: string, email: string, planType: string, backend: string}) => Promise<void>} [options.onSignedIn]
 * @param {(event: {profileId: string}) => Promise<void>} [options.onSessionExpired]
 * @param {(event: {profileId: string}) => Promise<void>} [options.onSignedOut]
 * @param {number} [options.statusRetentionMs]
 */
export function createChatgptAuth(options = {}) {
  const authorizeUrl = options.authorizeUrl || CODEX_AUTHORIZE_URL;
  const tokenUrl = options.tokenUrl || CODEX_TOKEN_URL;
  const clientId = options.clientId || CODEX_OAUTH_CLIENT_ID;
  // Not defaulted eagerly: when `callbackPort` is `0` (an OS-assigned
  // ephemeral port — tests use this so no fixed port can collide), the real
  // redirect URI can only be known once the listener is actually bound, so
  // `resolveBrowserRedirectUri()` below builds it from the bound port
  // instead. An explicit `browserRedirectUri` always wins either way.
  const explicitBrowserRedirectUri = options.browserRedirectUri || null;
  const deviceUserCodeUrl = options.deviceUserCodeUrl || CODEX_DEVICE_USERCODE_URL;
  const deviceTokenUrl = options.deviceTokenUrl || CODEX_DEVICE_TOKEN_URL;
  const deviceVerificationUrl = options.deviceVerificationUrl || CODEX_DEVICE_VERIFICATION_URL;
  const deviceRedirectUri = options.deviceRedirectUri || CODEX_DEVICE_REDIRECT_URI;
  const scope = options.scope || CODEX_OAUTH_SCOPE;
  const callbackHost = options.callbackHost || CODEX_CALLBACK_HOST;
  const callbackPort = options.callbackPort === undefined ? CODEX_CALLBACK_PORT : options.callbackPort;
  const callbackPath = options.callbackPath || CODEX_CALLBACK_PATH;
  const browserSignInTimeoutMs = options.browserSignInTimeoutMs || BROWSER_SIGN_IN_TIMEOUT_MS;
  const deviceSignInTimeoutMs = options.deviceSignInTimeoutMs || DEVICE_SIGN_IN_TIMEOUT_MS;
  const defaultDevicePollIntervalMs = options.defaultDevicePollIntervalMs || DEFAULT_DEVICE_POLL_INTERVAL_MS;
  const refreshWindowMs = options.refreshWindowMs === undefined ? REFRESH_WINDOW_MS : options.refreshWindowMs;
  const maxSecretBytes = options.maxSecretBytes || DEFAULT_MAX_SECRET_BYTES;
  const now = options.now || (() => Date.now());
  const randomBytesFn = options.randomBytes || ((size) => crypto.randomBytes(size));
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const secretTarget = options.secretTarget || chatgptSecretTarget;
  const storeSecretImpl = options.storeSecretImpl || storeSecret;
  const readSecretImpl = options.readSecretImpl || readSecret;
  const deleteSecretImpl = options.deleteSecretImpl || deleteSecret;
  const loadCredentialInfo = options.loadCredentialInfo || defaultLoadCredentialInfo;
  const onSignedIn = options.onSignedIn || (async () => {});
  const onSessionExpired = options.onSessionExpired || (async () => {});
  const onSignedOut = options.onSignedOut || (async () => {});
  const statusRetentionMs = options.statusRetentionMs === undefined ? 10 * 60 * 1000 : options.statusRetentionMs;

  async function defaultLoadCredentialInfo(profileId) {
    const profile = await loadProfile();
    if (!profile || profile.profileId !== profileId) return null;
    return { memoryOnly: profile.memoryOnlyCredential, backend: profile.secretBackend };
  }

  /** signInId -> sign-in record (see startBrowserSignIn/startDeviceSignIn). */
  const signIns = new Map();
  /** profileId -> the signInId currently in progress for it, if any. */
  const activeSignInByProfile = new Map();
  /** profileId -> in-memory access token {accessToken, accountId, exp}. */
  const tokens = new Map();
  /** profileId -> in-flight refresh Promise, for single-flight refresh. */
  const refreshInFlight = new Map();

  function pruneExpiredStatuses() {
    const cutoff = now() - statusRetentionMs;
    for (const [id, record] of signIns) {
      if (record.completedAt !== null && record.completedAt < cutoff) {
        signIns.delete(id);
      }
    }
  }

  function safeClose(server) {
    if (!server) return;
    try {
      server.close();
    } catch {
      // Already closed or never fully listening — nothing to clean up.
    }
  }

  function finalizeFailed(record, err) {
    if (record.state !== "pending") return;
    record.state = "failed";
    record.errorCode = err && err.code ? err.code : "SIGN_IN_FAILED";
    record.message = err && err.message ? err.message : "ChatGPT sign-in failed";
    record.completedAt = now();
    if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
  }

  async function persistCredential(profileId, { refreshToken, accountId, memoryOnly }) {
    const secretJson = JSON.stringify({ v: 1, refresh_token: refreshToken, account_id: accountId });
    const sizeBytes = Buffer.byteLength(secretJson, "utf-8");
    if (sizeBytes > maxSecretBytes) {
      throw new ProviderError(
        "SECRET_TOO_LARGE",
        `the ChatGPT credential (${sizeBytes} bytes) exceeds the secret store's ${maxSecretBytes}-byte limit and was not stored`
      );
    }
    const { backend } = await storeSecretImpl(secretTarget(profileId), secretJson, { memoryOnly: Boolean(memoryOnly) });
    return backend;
  }

  async function finalizeSignIn(record, exchanged, memoryOnly) {
    const backend = await persistCredential(record.profileId, {
      refreshToken: exchanged.refreshToken,
      accountId: exchanged.accountId,
      memoryOnly
    });
    tokens.set(record.profileId, {
      accessToken: exchanged.accessToken,
      accountId: exchanged.accountId,
      exp: now() + exchanged.expiresInMs
    });
    await onSignedIn({ profileId: record.profileId, email: exchanged.email, planType: exchanged.planType, backend });
    record.state = "signed_in";
    record.account = { email: exchanged.email, planType: exchanged.planType };
    record.completedAt = now();
    if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
    safeClose(record.server);
  }

  function cancelSignInRecord(record) {
    finalizeFailed(record, new ProviderError("SIGN_IN_CANCELLED", "the ChatGPT sign-in was cancelled"));
    safeClose(record.server);
  }

  function cancelActiveSignInForProfile(profileId) {
    const priorId = activeSignInByProfile.get(profileId);
    if (!priorId) return;
    const prior = signIns.get(priorId);
    if (prior && prior.state === "pending") {
      cancelSignInRecord(prior);
    }
  }

  async function exchangeCode({ code, redirectUri, verifier }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    });
    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString()
      });
    } catch (err) {
      throw toProviderError(err, "SIGN_IN_FAILED");
    }
    if (!res.ok) {
      throw new ProviderError("SIGN_IN_FAILED", `the ChatGPT code exchange failed (status ${res.status})`);
    }
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT token endpoint returned a response that was not valid JSON");
    }
    const claims = decodeIdTokenClaims(json.id_token);
    const authInfo = (claims && claims["https://api.openai.com/auth"]) || {};
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresInMs: (Number(json.expires_in) || 0) * 1000,
      accountId: authInfo.chatgpt_account_id || "",
      planType: authInfo.chatgpt_plan_type || "free",
      email: (claims && claims.email) || ""
    };
  }

  // --- Browser sign-in: single-shot loopback callback listener ---

  function startCallbackServer({ expectedState, handleValidCallback }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let handled = false;
      const server = http.createServer((req, res) => {
        let url;
        try {
          // Only `pathname`/`searchParams` are read below — the base's own
          // host/port are irrelevant (and, with an ephemeral `callbackPort:
          // 0`, not even a valid port to put in a URL string), so a
          // portless base is used purely to make a relative `req.url`
          // parseable.
          url = new URL(req.url, `http://${callbackHost}`);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (state !== expectedState) {
          // Spec: "no token exchange happens, the callback page shows an
          // error, and the sign-in stays pending until a matching callback
          // or the timeout" — the listener stays open.
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(STATE_MISMATCH_HTML);
          return;
        }
        // Exactly one valid-state callback is ever processed — a second one
        // arriving before the response finishes is silently ignored rather
        // than exchanging the code twice.
        if (handled) return;
        handled = true;
        handleValidCallback(code)
          .then((ok) => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(ok ? SUCCESS_HTML : FAILED_HTML);
          })
          .catch(() => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(FAILED_HTML);
          });
      });
      server.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      server.listen(callbackPort, callbackHost, () => {
        settled = true;
        resolve(server);
      });
    });
  }

  function generateId() {
    return toBase64Url(randomBytesFn(16));
  }

  /** @param {import("node:http").Server} server the already-listening callback server */
  function resolveBrowserRedirectUri(server) {
    if (explicitBrowserRedirectUri) return explicitBrowserRedirectUri;
    if (callbackPort === 0) {
      const boundPort = server.address().port;
      return `http://${callbackHost}:${boundPort}${callbackPath}`;
    }
    return CODEX_BROWSER_REDIRECT_URI;
  }

  function buildAuthorizeUrl({ state, challenge, redirectUri }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true"
    });
    return `${authorizeUrl}?${params.toString()}`;
  }

  /**
   * @param {{ profileId: string, memoryOnly?: boolean }} args
   * @returns {Promise<{ signInId: string, authUrl: string }>}
   */
  async function startBrowserSignIn({ profileId, memoryOnly = false }) {
    if (!profileId) throw new Error("profileId is required");
    pruneExpiredStatuses();
    cancelActiveSignInForProfile(profileId);

    const signInId = generateId();
    const state = generateId();
    const { verifier, challenge } = generatePkce(randomBytesFn);
    const record = {
      signInId,
      profileId,
      kind: "browser",
      state: "pending",
      account: null,
      errorCode: null,
      message: null,
      server: null,
      timeoutHandle: null,
      completedAt: null
    };
    signIns.set(signInId, record);
    activeSignInByProfile.set(profileId, signInId);

    // Set by resolveBrowserRedirectUri() right after the listener binds, and
    // read by `handleValidCallback` below at call time (a closure sees the
    // variable's later value, not a snapshot) — the value is only knowable
    // once the actual port is bound, for an ephemeral (`callbackPort: 0`)
    // listener.
    let redirectUri;
    let server;
    try {
      server = await startCallbackServer({
        expectedState: state,
        handleValidCallback: async (code) => {
          try {
            const exchanged = await exchangeCode({ code, redirectUri, verifier });
            await finalizeSignIn(record, exchanged, memoryOnly);
            return true;
          } catch (err) {
            finalizeFailed(record, err);
            safeClose(record.server);
            return false;
          }
        }
      });
    } catch (err) {
      signIns.delete(signInId);
      activeSignInByProfile.delete(profileId);
      if (err && err.code === "EADDRINUSE") {
        throw new ProviderError(
          "CALLBACK_PORT_IN_USE",
          `could not bind the ChatGPT sign-in callback listener on ${callbackHost}:${callbackPort}`
        );
      }
      throw err;
    }
    redirectUri = resolveBrowserRedirectUri(server);
    record.server = server;
    record.timeoutHandle = setTimeout(() => {
      if (record.state === "pending") {
        finalizeFailed(record, new ProviderError("SIGN_IN_TIMEOUT", "ChatGPT sign-in timed out waiting for the browser callback"));
        safeClose(server);
      }
    }, browserSignInTimeoutMs);
    if (record.timeoutHandle.unref) record.timeoutHandle.unref();

    return { signInId, authUrl: buildAuthorizeUrl({ state, challenge, redirectUri }) };
  }

  // --- Device-code sign-in: background polling ---

  async function requestDeviceUserCode() {
    let res;
    try {
      res = await fetchImpl(deviceUserCodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId })
      });
    } catch (err) {
      throw toProviderError(err, "SIGN_IN_FAILED");
    }
    if (!res.ok) {
      throw new ProviderError("SIGN_IN_FAILED", `the ChatGPT device-code request failed (status ${res.status})`);
    }
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT device-code response was not valid JSON");
    }
    const userCode = json.user_code || json.usercode;
    const deviceAuthId = json.device_auth_id;
    if (!userCode || !deviceAuthId) {
      throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT device-code response was missing required fields");
    }
    return { userCode, deviceAuthId, pollIntervalMs: parseDevicePollIntervalMs(json.interval, defaultDevicePollIntervalMs) };
  }

  /** @returns {Promise<{pending:true}|{ok:false,status:number}|{ok:true,authorizationCode:string,codeVerifier:string}>} */
  async function pollDeviceToken(deviceAuthId, userCode) {
    let res;
    try {
      res = await fetchImpl(deviceTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
      });
    } catch (err) {
      throw toProviderError(err, "SIGN_IN_FAILED");
    }
    if (res.status === 403 || res.status === 404) {
      return { pending: true };
    }
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT device-token response was not valid JSON");
    }
    return { ok: true, authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
  }

  async function pollDeviceLoop(record, memoryOnly) {
    for (;;) {
      if (record.state !== "pending") return;
      if (now() >= record.deadline) {
        finalizeFailed(record, new ProviderError("SIGN_IN_TIMEOUT", "ChatGPT device sign-in timed out"));
        return;
      }
      let result;
      try {
        result = await pollDeviceToken(record.deviceAuthId, record.userCode);
      } catch (err) {
        finalizeFailed(record, err);
        return;
      }
      if (record.state !== "pending") return; // cancelled while the poll was in flight
      if (result.pending) {
        await sleep(record.pollIntervalMs);
        continue;
      }
      if (!result.ok) {
        finalizeFailed(record, new ProviderError("SIGN_IN_FAILED", `the ChatGPT device sign-in was rejected (status ${result.status})`));
        return;
      }
      try {
        const exchanged = await exchangeCode({
          code: result.authorizationCode,
          redirectUri: deviceRedirectUri,
          verifier: result.codeVerifier
        });
        await finalizeSignIn(record, exchanged, memoryOnly);
      } catch (err) {
        finalizeFailed(record, err);
      }
      return;
    }
  }

  /**
   * @param {{ profileId: string, memoryOnly?: boolean }} args
   * @returns {Promise<{ signInId: string, userCode: string, verificationUrl: string, expiresAt: number }>}
   */
  async function startDeviceSignIn({ profileId, memoryOnly = false }) {
    if (!profileId) throw new Error("profileId is required");
    pruneExpiredStatuses();
    cancelActiveSignInForProfile(profileId);

    const signInId = generateId();
    const record = {
      signInId,
      profileId,
      kind: "device",
      state: "pending",
      account: null,
      errorCode: null,
      message: null,
      completedAt: null,
      deadline: now() + deviceSignInTimeoutMs
    };
    signIns.set(signInId, record);
    activeSignInByProfile.set(profileId, signInId);

    let userCodeResp;
    try {
      userCodeResp = await requestDeviceUserCode();
    } catch (err) {
      signIns.delete(signInId);
      activeSignInByProfile.delete(profileId);
      throw err;
    }
    record.deviceAuthId = userCodeResp.deviceAuthId;
    record.userCode = userCodeResp.userCode;
    record.pollIntervalMs = userCodeResp.pollIntervalMs;

    // Fire-and-forget: the caller gets the user code immediately and polls
    // getSignInStatus() for the outcome (spec: "the settings page ... polls
    // status every 1 s while pending").
    pollDeviceLoop(record, memoryOnly);

    return {
      signInId,
      userCode: record.userCode,
      verificationUrl: deviceVerificationUrl,
      expiresAt: record.deadline
    };
  }

  // --- Status / cancel ---

  function getSignInStatus(signInId) {
    pruneExpiredStatuses();
    const record = signIns.get(signInId);
    if (!record) throw new Error(`unknown ChatGPT sign-in id: ${signInId}`);
    if (record.state === "pending") return { state: "pending" };
    if (record.state === "signed_in") return { state: "signed_in", account: record.account };
    return { state: "failed", code: record.errorCode, message: record.message };
  }

  async function cancelSignIn(signInId) {
    const record = signIns.get(signInId);
    if (!record) throw new Error(`unknown ChatGPT sign-in id: ${signInId}`);
    if (record.state !== "pending") return; // already terminal — idempotent
    cancelSignInRecord(record);
  }

  // --- Access-token refresh (single-flight per profile) ---

  async function doRefresh(profileId) {
    const info = (await loadCredentialInfo(profileId)) || {};
    const secretRaw = await readSecretImpl(secretTarget(profileId), info);
    if (!secretRaw) {
      throw new ProviderError("NO_CREDENTIAL", `no ChatGPT credential is stored for profile "${profileId}"`);
    }
    let parsed;
    try {
      parsed = JSON.parse(secretRaw);
    } catch {
      throw new ProviderError("SESSION_EXPIRED", "the stored ChatGPT credential could not be read");
    }
    const refreshToken = parsed.refresh_token;
    const accountId = parsed.account_id;

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email"
    });
    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString()
      });
    } catch (err) {
      throw toProviderError(err, "SIGN_IN_FAILED");
    }
    if (!res.ok) {
      // A body that names the specific rejection is read, but never
      // echoed verbatim into the thrown message — only classified.
      const text = await res.text().catch(() => "");
      if (/invalid_grant|refresh_token_reused/i.test(text)) {
        await deleteSecretImpl(secretTarget(profileId), info);
        tokens.delete(profileId);
        await onSessionExpired({ profileId });
        throw new ProviderError("SESSION_EXPIRED", "the ChatGPT session was rejected and requires signing in again");
      }
      throw new ProviderError("SIGN_IN_FAILED", `the ChatGPT token refresh failed (status ${res.status})`);
    }
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new ProviderError("SIGN_IN_FAILED", "the ChatGPT token refresh response was not valid JSON");
    }

    const rotatedRefreshToken = json.refresh_token || refreshToken;
    const newSecretJson = JSON.stringify({ v: 1, refresh_token: rotatedRefreshToken, account_id: accountId });
    if (Buffer.byteLength(newSecretJson, "utf-8") > maxSecretBytes) {
      throw new ProviderError(
        "SECRET_TOO_LARGE",
        `the refreshed ChatGPT credential exceeds the secret store's ${maxSecretBytes}-byte limit and was not stored`
      );
    }
    // Persist the rotated refresh token BEFORE the new access token is used
    // for anything (spec: "Refresh token rotation" scenario) — a crash right
    // here leaves the OLD refresh token consumed server-side but a fresh one
    // already on disk, never the reverse.
    await storeSecretImpl(secretTarget(profileId), newSecretJson, info);

    const record = { accessToken: json.access_token, accountId, exp: now() + (Number(json.expires_in) || 0) * 1000 };
    tokens.set(profileId, record);
    return { accessToken: record.accessToken, accountId: record.accountId };
  }

  function refreshForProfile(profileId) {
    if (refreshInFlight.has(profileId)) return refreshInFlight.get(profileId);
    const promise = doRefresh(profileId).finally(() => refreshInFlight.delete(profileId));
    refreshInFlight.set(profileId, promise);
    return promise;
  }

  /**
   * @param {string} profileId
   * @param {{ forceRefresh?: boolean }} [opts]
   * @returns {Promise<{ accessToken: string, accountId: string }>}
   */
  async function getAccessToken(profileId, opts = {}) {
    const forceRefresh = Boolean(opts.forceRefresh);
    const cached = tokens.get(profileId);
    const stale = !cached || !cached.accessToken || cached.exp - now() <= refreshWindowMs;
    if (!forceRefresh && !stale) {
      return { accessToken: cached.accessToken, accountId: cached.accountId };
    }
    return refreshForProfile(profileId);
  }

  /** @param {string} profileId */
  async function signOut(profileId) {
    tokens.delete(profileId);
    cancelActiveSignInForProfile(profileId);
    const info = (await loadCredentialInfo(profileId)) || {};
    await deleteSecretImpl(secretTarget(profileId), info);
    await onSignedOut({ profileId });
  }

  /** Test-only: close any open callback listeners and timers. */
  function _dispose() {
    for (const record of signIns.values()) {
      if (record.state === "pending") {
        if (record.timeoutHandle) clearTimeout(record.timeoutHandle);
        record.state = "failed";
        record.errorCode = "SIGN_IN_CANCELLED";
        record.message = "disposed";
        record.completedAt = now();
      }
      safeClose(record.server);
    }
  }

  return { startBrowserSignIn, startDeviceSignIn, getSignInStatus, cancelSignIn, getAccessToken, signOut, _dispose };
}

const SUCCESS_HTML = `<!doctype html><html><head><title>ChatGPT sign-in</title></head><body><p>Signed in to ChatGPT. You can close this tab.</p></body></html>`;
const STATE_MISMATCH_HTML = `<!doctype html><html><head><title>ChatGPT sign-in</title></head><body><p>This sign-in link could not be verified. You can close this tab and try again.</p></body></html>`;
const FAILED_HTML = `<!doctype html><html><head><title>ChatGPT sign-in</title></head><body><p>ChatGPT sign-in failed. You can close this tab and try again.</p></body></html>`;

// Production instance: real OpenAI endpoints, real loopback port 1455, wired
// to host/agent/settings/profile.js's credential-lifecycle helpers.
const defaultAuth = createChatgptAuth({
  onSignedIn: ({ profileId, email, planType, backend }) => recordChatgptSignIn(profileId, { email, planType, backend }),
  onSessionExpired: ({ profileId }) => recordChatgptSessionExpired(profileId),
  onSignedOut: ({ profileId }) => recordChatgptSignOut(profileId)
});

export const startBrowserSignIn = defaultAuth.startBrowserSignIn;
export const startDeviceSignIn = defaultAuth.startDeviceSignIn;
export const getSignInStatus = defaultAuth.getSignInStatus;
export const cancelSignIn = defaultAuth.cancelSignIn;
export const getAccessToken = defaultAuth.getAccessToken;
export const signOut = defaultAuth.signOut;

// ChatGPT account usage read (spec: "ChatGPT account usage read").
//
// One `GET` against the ChatGPT backend's usage endpoint, authenticated with
// exactly the credential pair the gateway's request path uses, mapped onto
// the small display-shaped result the settings page renders. Deliberately NOT
// a method on gateway.js (that module owns the run path and an open loopback
// server) or auth.js (auth owns credentials, not account state): this is the
// only place that knows the usage endpoint, and it holds no credential of its
// own — every call goes through the injected `getAccessToken`.
//
// Eligibility is decided before any network call. A profile that is not
// signed in, has no credential, or is already `session_expired` answers a
// structured failure without issuing a request; the same goes for a
// `getAccessToken` that throws (no credential stored, or a credential that
// auth.js already rejected).
//
// The 401 rule is upstream-client.js's exact rule: refresh the access token
// once (`forceRefresh: true`) and retry once. A refresh that SUCCEEDS and a
// retry that is still answered 401 is the one case this module records
// through `onSessionExpired` (default: settings/profile.js's
// `recordChatgptSessionExpired` — the same profile transition gateway.js
// performs for `sessionExpiredAfterRefresh`), and it is awaited before the
// caller gets its `SESSION_EXPIRED` result. A refresh that FAILS was already
// recorded inside auth.js's own onSessionExpired hook before it threw, so
// this module only translates that throw and never records twice.
//
// `readUsage()` never throws for an ordinary failure: every outcome is
// `{ ok: true, result }` or `{ ok: false, error: { code, message } }`,
// so the caller's op answers in one expression and the companion's outer
// catch stays a safety net rather than the error path.
//
// Endpoint and response-shape knowledge ported from
// router-for-me/CLIProxyAPI @ ac02da6 (MIT) — see NOTICE. Deliberately not
// ported: any client/originator cloaking (the request carries the two
// credential headers and nothing else).

import { classifyNetworkError, ProviderError } from "../settings/errors.js";
import { getAccessToken as defaultGetAccessToken } from "./auth.js";
import { loadProfile as defaultLoadProfile, recordChatgptSessionExpired as defaultOnSessionExpired } from "../settings/profile.js";

export const DEFAULT_CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;

// Epoch-scale floors used to tell an epoch-seconds `reset_at` from an
// epoch-milliseconds one (1e9 s / 1e12 ms = 2001-09-09), and the window
// around `now` within which an epoch value is considered a plausible reset
// moment. Anything else normalizes to `null`, and the page then renders the
// countdown from `resetAfterSeconds` alone rather than a wrong clock time.
const EPOCH_MS_FLOOR = 1e12;
const EPOCH_SEC_FLOOR = 1e9;
const RESET_AT_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/** Translate anything thrown by an injected collaborator into the module's
 * structured error shape. A ProviderError keeps its taxonomy code (auth.js
 * throws NO_CREDENTIAL / SESSION_EXPIRED / SIGN_IN_FAILED); anything else is
 * classified as a network-layer failure. */
function errorFromThrow(err) {
  if (err instanceof ProviderError) return { code: err.code, message: err.message };
  const classified = classifyNetworkError(err);
  return { code: classified.code, message: classified.message };
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalize a backend `reset_at` — an epoch-seconds number, an epoch-ms
 * number, or an ISO-8601 string — to epoch milliseconds, or `null` when the
 * value is missing, unparseable, or not plausibly near `nowMs`. */
function normalizeResetAt(value, nowMs) {
  let ms = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= EPOCH_MS_FLOOR) ms = value;
    else if (value >= EPOCH_SEC_FLOOR) ms = value * 1000;
  } else if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === null) return null;
  if (ms < nowMs - RESET_AT_WINDOW_MS || ms > nowMs + RESET_AT_WINDOW_MS) return null;
  return Math.trunc(ms);
}

/** Map one backend window (`{ used_percent, limit_window_seconds,
 * reset_after_seconds, reset_at }`) to the reply's slot shape; a missing or
 * non-object window is `null`. */
function mapWindow(raw, nowMs) {
  if (!raw || typeof raw !== "object") return null;
  return {
    usedPercent: finiteNumberOrNull(raw.used_percent),
    limitWindowSeconds: finiteNumberOrNull(raw.limit_window_seconds),
    resetAfterSeconds: finiteNumberOrNull(raw.reset_after_seconds),
    resetAt: normalizeResetAt(raw.reset_at, nowMs)
  };
}

/** `{ hasCredits, unlimited, balance }` only for an account that actually has
 * credits, else `null` — the page renders the credits line only when there is
 * one. Any other backend credits field is dropped. */
function mapCredits(raw) {
  if (!raw || typeof raw !== "object" || raw.has_credits !== true) return null;
  const balance = raw.balance;
  return {
    hasCredits: true,
    unlimited: raw.unlimited === true,
    balance: typeof balance === "number" || typeof balance === "string" ? balance : null
  };
}

/**
 * Build a usage reader over the ChatGPT backend. Every collaborator is
 * injectable (the same "defaults are the real modules" pattern as
 * createChatgptAuth/createChatgptGateway) so tests drive every branch with a
 * mocked upstream and a mocked auth module and never touch the network.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] defaults to globalThis.fetch
 * @param {(profileId: string, opts?: { forceRefresh?: boolean }) => Promise<{ accessToken: string, accountId: string }>} [options.getAccessToken]
 * @param {() => Promise<object|null>} [options.loadProfile]
 * @param {(profileId: string) => Promise<void>} [options.onSessionExpired]
 * @param {() => number} [options.now]
 * @param {string} [options.upstreamUrl]
 * @param {number} [options.timeoutMs]
 */
export function createUsageReader(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getAccessTokenImpl = options.getAccessToken || defaultGetAccessToken;
  const loadProfileImpl = options.loadProfile || defaultLoadProfile;
  const onSessionExpiredImpl = options.onSessionExpired || defaultOnSessionExpired;
  const nowImpl = options.now || Date.now;
  const upstreamUrl = options.upstreamUrl || DEFAULT_CHATGPT_USAGE_URL;
  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  function send({ accessToken, accountId }) {
    return fetchImpl(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId || ""
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  }

  async function readUsageInner(profileId) {
    // --- Eligibility first: never a network call for a profile that cannot
    // have a usable credential -------------------------------------------
    let profile;
    try {
      profile = await loadProfileImpl();
    } catch (err) {
      const translated = errorFromThrow(err);
      return failure(translated.code, translated.message);
    }
    if (!profile || profile.profileId !== profileId) {
      return failure("NO_CREDENTIAL", `no ChatGPT profile is stored for profile "${profileId}"`);
    }
    if (profile.chatgptSessionState === "session_expired") {
      return failure("SESSION_EXPIRED", "the ChatGPT session expired — sign in with ChatGPT again");
    }
    if (profile.chatgptSessionState !== "signed_in" || !profile.hasCredential) {
      return failure("NO_CREDENTIAL", "ChatGPT sign-in is required before usage can be read");
    }

    // --- Credentials (still no request when this throws) ------------------
    let tokenInfo;
    try {
      tokenInfo = await getAccessTokenImpl(profileId);
    } catch (err) {
      const translated = errorFromThrow(err);
      return failure(translated.code, translated.message);
    }

    // --- The one request, plus the shared refresh-once-and-retry-once rule -
    let res;
    try {
      res = await send(tokenInfo);
    } catch (err) {
      const translated = errorFromThrow(err);
      return failure(translated.code, translated.message);
    }

    if (res.status === 401) {
      let refreshed;
      try {
        refreshed = await getAccessTokenImpl(profileId, { forceRefresh: true });
      } catch (err) {
        // The refresh itself failed — auth.js has already recorded the
        // transition it owns (invalid_grant / refresh_token_reused), so this
        // only translates the throw; no second transition here.
        const translated = errorFromThrow(err);
        return failure(translated.code, translated.message);
      }
      try {
        res = await send(refreshed);
      } catch (err) {
        const translated = errorFromThrow(err);
        return failure(translated.code, translated.message);
      }
      if (res.status === 401) {
        // The refresh SUCCEEDED and the retry is still 401: record the same
        // profile transition the gateway records, then answer the caller.
        // Best-effort — a recorder failure must not turn this into a throw.
        try {
          await onSessionExpiredImpl(profileId);
        } catch {}
        return failure("SESSION_EXPIRED", "the ChatGPT session expired — sign in with ChatGPT again");
      }
    }

    if (!res.ok) {
      if (res.status === 429) {
        return failure("RATE_LIMIT_ERROR", `the ChatGPT usage endpoint rate-limited the request (status ${res.status})`);
      }
      if (res.status === 403) {
        return failure("AUTH_ERROR", `the ChatGPT usage endpoint refused the credential (status ${res.status})`);
      }
      return failure("NETWORK_ERROR", `the ChatGPT usage endpoint answered status ${res.status}`);
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      const translated = errorFromThrow(err);
      return failure(translated.code, translated.message);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return failure("USAGE_UNAVAILABLE", "the ChatGPT usage endpoint answered a body that is not JSON");
    }
    const rateLimit = body && typeof body === "object" ? body.rate_limit : null;
    if (!rateLimit || typeof rateLimit !== "object") {
      return failure("USAGE_UNAVAILABLE", "the ChatGPT usage endpoint answered a body without a rate_limit object");
    }
    if (typeof rateLimit.allowed !== "boolean" || typeof rateLimit.limit_reached !== "boolean") {
      return failure("USAGE_UNAVAILABLE", "the ChatGPT usage endpoint answered a rate_limit without its allowed/limit_reached flags");
    }

    const nowMs = nowImpl();
    // Exactly the display-shaped result: every backend field the settings
    // page does not render (user_id, account_id, email, spend_control, promo,
    // model_usage, additional_rate_limits, ...) is dropped here, not upstream.
    const result = {
      planType: typeof body.plan_type === "string" ? body.plan_type : null,
      allowed: rateLimit.allowed,
      limitReached: rateLimit.limit_reached,
      primary: mapWindow(rateLimit.primary_window, nowMs),
      secondary: mapWindow(rateLimit.secondary_window, nowMs),
      credits: mapCredits(body.credits)
    };
    return { ok: true, result };
  }

  return {
    /** @param {string} profileId @returns {Promise<{ ok: true, result: object } | { ok: false, error: { code: string, message: string } }>} */
    async readUsage(profileId) {
      try {
        return await readUsageInner(profileId);
      } catch (err) {
        // Safety net: the contract is that readUsage never throws, so an
        // unexpected exception is reported as the structured failure the
        // caller already knows how to answer.
        const translated = errorFromThrow(err);
        return failure(translated.code, translated.message);
      }
    }
  };
}

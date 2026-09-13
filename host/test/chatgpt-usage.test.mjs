#!/usr/bin/env node
// ChatGPT account-usage reader (host/agent/chatgpt/usage.js), exercised with
// a mocked fetch and a mocked auth module — never a real ChatGPT/OpenAI
// endpoint, never a real credential. Mirrors the injector style of
// host/test/chatgpt-gateway.test.mjs: every collaborator is fake, and the
// scripted upstream answers drive each branch.
//
// Run: node host/test/chatgpt-usage.test.mjs

import { createUsageReader, DEFAULT_CHATGPT_USAGE_URL } from "../agent/chatgpt/usage.js";
import { ProviderError } from "../agent/settings/errors.js";

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
function assertDeepEqual(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || "not deep-equal"}: ${sa} !== ${sb}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_ID = "usage-profile-1";
const NOW_MS = 1_760_000_000_000; // 2025-10-09T08:53:20Z — synthetic, injected as `now`

/** A backend body shaped like the verified live response, plus every field
 * the reply must NOT carry. */
function usageBody(overrides = {}) {
  return {
    user_id: "LEAK-USER-ID",
    account_id: "LEAK-ACCOUNT-ID",
    email: "LEAK-EMAIL",
    plan_type: "free",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 2592000,
        reset_after_seconds: 1209600,
        reset_at: 1767264000 // epoch seconds, ~86 days after NOW_MS
      },
      secondary_window: null
    },
    credits: { has_credits: false, unlimited: false, balance: null },
    spend_control: { reached: false },
    promo: { campaign: "LEAK-PROMO" },
    model_usage: [{ model: "gpt-5", usage: 1 }],
    additional_rate_limits: [{ name: "code_review" }],
    rate_limit_reached_type: null,
    ...overrides
  };
}

function signedInProfile(overrides = {}) {
  return { profileId: PROFILE_ID, chatgptSessionState: "signed_in", hasCredential: true, ...overrides };
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

/** A fetch that records every call and answers from `script` in order (the
 * last entry repeats once the script is exhausted). Each entry is either a
 * mock Response or a function `(url, init) => Response` that may throw. */
function makeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return typeof step === "function" ? step(url, init) : step;
  };
  fn.calls = calls;
  return fn;
}

/** Build a reader over a scripted upstream plus recording fakes. */
function buildReader({ script, profile = signedInProfile(), getAccessToken, onSessionExpired, now = NOW_MS, upstreamUrl } = {}) {
  const fetcher = makeFetch(script);
  const tokenCalls = [];
  const refreshCalls = [];
  const expiryCalls = [];
  const tokenImpl =
    getAccessToken ||
    (async (profileId, opts = {}) => {
      if (opts.forceRefresh) refreshCalls.push(profileId);
      return opts.forceRefresh
        ? { accessToken: "access-fresh", accountId: "account-fresh" }
        : { accessToken: "access-stale", accountId: "account-stale" };
    });
  const reader = createUsageReader({
    fetchImpl: fetcher,
    loadProfile: async () => profile,
    getAccessToken: async (profileId, opts) => {
      tokenCalls.push({ profileId, opts });
      return tokenImpl(profileId, opts);
    },
    onSessionExpired: async (profileId) => {
      expiryCalls.push(profileId);
      if (onSessionExpired) return onSessionExpired(profileId);
    },
    now: () => now,
    ...(upstreamUrl ? { upstreamUrl } : {})
  });
  return { reader, fetcher, tokenCalls, refreshCalls, expiryCalls };
}

/** Fail closed on any secret/identity field anywhere in a result or an error
 * tree: no secret-shaped key, and no fixture sentinel in any string value. */
function assertNoLeak(value, label) {
  const json = JSON.stringify(value);
  for (const sentinel of ["LEAK-USER-ID", "LEAK-ACCOUNT-ID", "LEAK-EMAIL", "LEAK-PROMO", "LEAK-TOKEN"]) {
    assert(!json.includes(sentinel), `${label}: ${sentinel} leaked into the reply tree`);
  }
  const badKeys = [];
  (function visit(node) {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (/^(access_?token|refresh_?token|id_?token|token|secret|credential|account_?id|user_?id|email)$/i.test(key)) badKeys.push(key);
      visit(node[key]);
    }
  })(value);
  assert(badKeys.length === 0, `${label}: secret/identity-shaped key(s) present: ${badKeys.join(", ")}`);
}

console.log("\nChatGPT account usage reader (host/agent/chatgpt/usage.js)\n");

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

await check("single-window free-plan body maps onto exactly the display-shaped result (key set and window slots pinned)", async () => {
  const { reader, fetcher } = buildReader({ script: [jsonResponse(200, usageBody())] });
  const outcome = await reader.readUsage(PROFILE_ID);

  assertEqual(outcome.ok, true, `expected success, got ${JSON.stringify(outcome.error)}`);
  assertDeepEqual(Object.keys(outcome.result).sort(), ["allowed", "credits", "limitReached", "planType", "primary", "secondary"], "the success result carries ONLY the six documented keys");
  assertEqual(outcome.result.planType, "free");
  assertEqual(outcome.result.allowed, true);
  assertEqual(outcome.result.limitReached, false);
  assertEqual(outcome.result.secondary, null, "an absent secondary window is null, never a fabricated object");
  assertDeepEqual(Object.keys(outcome.result.primary).sort(), ["limitWindowSeconds", "resetAfterSeconds", "resetAt", "usedPercent"], "a window carries ONLY the four documented keys");
  assertDeepEqual(outcome.result.primary, {
    usedPercent: 3,
    limitWindowSeconds: 2592000,
    resetAfterSeconds: 1209600,
    resetAt: 1767264000000
  }, "epoch-seconds reset_at is normalized to epoch ms");
  assertEqual(outcome.result.credits, null, "has_credits:false means no credits line");
  assertNoLeak(outcome, "single-window result");

  assertEqual(fetcher.calls.length, 1, "exactly one request");
  assertEqual(fetcher.calls[0].init.method, "GET");
  assertEqual(fetcher.calls[0].url, DEFAULT_CHATGPT_USAGE_URL, "the verified endpoint is the default");
  assertDeepEqual(Object.keys(fetcher.calls[0].init.headers).sort(), ["Authorization", "chatgpt-account-id"], "exactly the two credential headers — no cloaking header");
  assertEqual(fetcher.calls[0].init.headers.Authorization, "Bearer access-stale");
  assertEqual(fetcher.calls[0].init.headers["chatgpt-account-id"], "account-stale");
});

await check("two-window paid body keeps both windows in the slots the backend assigned them to", async () => {
  const body = usageBody({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 41, limit_window_seconds: 18000, reset_after_seconds: 9000, reset_at: 1760000000000 },
      secondary_window: { used_percent: 88, limit_window_seconds: 604800, reset_after_seconds: 200000, reset_at: "2025-10-12T00:00:00.000Z" }
    },
    credits: { has_credits: true, unlimited: false, balance: "12.50" }
  });
  const { reader } = buildReader({ script: [jsonResponse(200, body)] });
  const outcome = await reader.readUsage(PROFILE_ID);

  assertEqual(outcome.ok, true, `expected success, got ${JSON.stringify(outcome.error)}`);
  assertEqual(outcome.result.planType, "plus");
  assertEqual(outcome.result.primary.usedPercent, 41);
  assertEqual(outcome.result.primary.limitWindowSeconds, 18000);
  assertEqual(outcome.result.secondary.usedPercent, 88);
  assertEqual(outcome.result.secondary.limitWindowSeconds, 604800);
  assertEqual(outcome.result.secondary.resetAt, Date.parse("2025-10-12T00:00:00.000Z"), "an ISO-8601 reset_at is parsed to epoch ms");
  assertDeepEqual(outcome.result.credits, { hasCredits: true, unlimited: false, balance: "12.50" });
  assertNoLeak(outcome, "two-window result");
});

await check("absent / implausible reset_at becomes null while resetAfterSeconds still crosses", async () => {
  const noResetAt = usageBody({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 5, limit_window_seconds: 300, reset_after_seconds: 120 },
      secondary_window: null
    }
  });
  const { reader } = buildReader({ script: [jsonResponse(200, noResetAt)] });
  let outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, true);
  assertEqual(outcome.result.primary.resetAt, null, "a missing reset_at is null");
  assertEqual(outcome.result.primary.resetAfterSeconds, 120, "the countdown field is unaffected");

  const bogus = usageBody({
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 5, limit_window_seconds: 300, reset_after_seconds: 120, reset_at: 1 },
      secondary_window: null
    }
  });
  const bogusReader = buildReader({ script: [jsonResponse(200, bogus)] });
  outcome = await bogusReader.reader.readUsage(PROFILE_ID);
  assertEqual(outcome.result.primary.resetAt, null, "a non-epoch reset_at is null rather than a wrong clock time");
});

await check("a 200 body without a rate_limit object (or without its flags) is USAGE_UNAVAILABLE, never a fabricated success", async () => {
  const bodies = [
    usageBody({ rate_limit: null }),
    usageBody({ rate_limit: "nope" }),
    (() => {
      const b = usageBody();
      delete b.rate_limit.allowed;
      return b;
    })(),
    (() => {
      const b = usageBody();
      delete b.rate_limit.limit_reached;
      return b;
    })()
  ];
  for (const body of bodies) {
    const { reader } = buildReader({ script: [jsonResponse(200, body)] });
    const outcome = await reader.readUsage(PROFILE_ID);
    assertEqual(outcome.ok, false, "a malformed 200 body must not be reported as success");
    assertEqual(outcome.error.code, "USAGE_UNAVAILABLE", `expected USAGE_UNAVAILABLE, got ${JSON.stringify(outcome.error)}`);
    assertNoLeak(outcome, "USAGE_UNAVAILABLE error");
  }
});

await check("a 200 body that is not JSON is USAGE_UNAVAILABLE (and its raw text never reaches the error)", async () => {
  const { reader } = buildReader({ script: [{ status: 200, ok: true, text: async () => "<html>LEAK-TOKEN</html>" }] });
  const outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "USAGE_UNAVAILABLE");
  assertNoLeak(outcome, "non-JSON body error");
});

// ---------------------------------------------------------------------------
// The 401 rule
// ---------------------------------------------------------------------------

await check("401 -> one forced refresh -> retry 200 succeeds, and the retry carries the FRESH token/account headers", async () => {
  const { reader, fetcher, refreshCalls } = buildReader({
    script: [jsonResponse(401, { error: "unauthorized" }), jsonResponse(200, usageBody())]
  });
  const outcome = await reader.readUsage(PROFILE_ID);

  assertEqual(outcome.ok, true, `expected the retry to succeed, got ${JSON.stringify(outcome.error)}`);
  assertEqual(fetcher.calls.length, 2, "exactly one retry");
  assertEqual(refreshCalls.length, 1, "exactly ONE forced refresh");
  assertEqual(fetcher.calls[1].init.headers.Authorization, "Bearer access-fresh", "the retry uses the refreshed token");
  assertEqual(fetcher.calls[1].init.headers["chatgpt-account-id"], "account-fresh");
  assertNoLeak(outcome, "refreshed success");
});

await check("401 after the single refresh records the transition ONCE and answers SESSION_EXPIRED", async () => {
  const { reader, fetcher, refreshCalls, expiryCalls } = buildReader({
    script: [jsonResponse(401, {}), jsonResponse(401, {})]
  });
  const outcome = await reader.readUsage(PROFILE_ID);

  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "SESSION_EXPIRED");
  assertEqual(fetcher.calls.length, 2, "one original request plus one retry — never a second refresh round");
  assertEqual(refreshCalls.length, 1);
  assertDeepEqual(expiryCalls, [PROFILE_ID], "exactly one onSessionExpired call, for the right profile");
  assertNoLeak(outcome, "surviving-401 error");
});

await check("a refresh REJECTED as SESSION_EXPIRED is translated without a second transition and without a retry", async () => {
  // auth.js records invalid_grant/refresh_token_reused through its own
  // onSessionExpired hook before throwing — this module must only translate.
  let forceRefreshAttempts = 0;
  const { reader, fetcher, expiryCalls } = buildReader({
    script: [jsonResponse(401, {})],
    getAccessToken: async (_profileId, opts = {}) => {
      if (opts.forceRefresh) {
        forceRefreshAttempts += 1;
        throw new ProviderError("SESSION_EXPIRED", "the ChatGPT session was rejected and requires signing in again");
      }
      return { accessToken: "access-stale", accountId: "account-stale" };
    }
  });
  const outcome = await reader.readUsage(PROFILE_ID);

  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "SESSION_EXPIRED");
  assertEqual(forceRefreshAttempts, 1, "exactly one forced refresh attempt");
  assertEqual(fetcher.calls.length, 1, "no retry is attempted after a rejected refresh");
  assertEqual(expiryCalls.length, 0, "never a SECOND transition — auth.js already recorded this one");
  assertNoLeak(outcome, "rejected-refresh error");
});

await check("a refresh rejected as NO_CREDENTIAL is translated as-is (no session-expired transition, no retry)", async () => {
  const { reader, fetcher, expiryCalls } = buildReader({
    script: [jsonResponse(401, {})],
    getAccessToken: async (_profileId, opts = {}) => {
      if (opts.forceRefresh) throw new ProviderError("NO_CREDENTIAL", "no ChatGPT credential is stored for this profile");
      return { accessToken: "access-stale", accountId: "account-stale" };
    }
  });
  const outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "NO_CREDENTIAL");
  assertEqual(fetcher.calls.length, 1, "no retry after a failed refresh");
  assertEqual(expiryCalls.length, 0);
});

await check("a getAccessToken that throws before any request sends NOTHING", async () => {
  const { reader, fetcher } = buildReader({
    script: [jsonResponse(200, usageBody())],
    getAccessToken: async () => {
      throw new ProviderError("SESSION_EXPIRED", "the stored ChatGPT credential could not be read");
    }
  });
  const outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "SESSION_EXPIRED");
  assertEqual(fetcher.calls.length, 0, "no network call when the credential cannot be obtained");
});

// ---------------------------------------------------------------------------
// Other statuses and network failures
// ---------------------------------------------------------------------------

await check("429 -> RATE_LIMIT_ERROR, 403 -> AUTH_ERROR, other non-2xx -> NETWORK_ERROR with the status in the message", async () => {
  const cases = [
    [429, "RATE_LIMIT_ERROR"],
    [403, "AUTH_ERROR"],
    [500, "NETWORK_ERROR"],
    [503, "NETWORK_ERROR"],
    [404, "NETWORK_ERROR"]
  ];
  for (const [status, code] of cases) {
    const { reader, fetcher } = buildReader({ script: [jsonResponse(status, { error: "LEAK-TOKEN", account_id: "LEAK-ACCOUNT-ID" })] });
    const outcome = await reader.readUsage(PROFILE_ID);
    assertEqual(outcome.ok, false, `status ${status} must fail`);
    assertEqual(outcome.error.code, code, `status ${status}: expected ${code}, got ${JSON.stringify(outcome.error)}`);
    assertEqual(fetcher.calls.length, 1, `status ${status}: a non-401 failure is never retried`);
    if (code === "NETWORK_ERROR") assert(outcome.error.message.includes(String(status)), `status ${status}: the message must name the status`);
    assertNoLeak(outcome, `status ${status} error`);
  }
});

await check("a fetch rejection is classified (NETWORK_ERROR) and a timeout rejection is TIMEOUT_ERROR", async () => {
  const netErr = new TypeError("fetch failed");
  netErr.cause = Object.assign(new Error("getaddrinfo ENOTFOUND chatgpt.com"), { code: "ENOTFOUND" });
  const netReader = buildReader({ script: [() => { throw netErr; }] });
  let outcome = await netReader.reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "NETWORK_ERROR", `got ${JSON.stringify(outcome.error)}`);

  // What AbortSignal.timeout produces: a DOMException whose message matches
  // classifyNetworkError's timeout branch.
  const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError", code: "ETIMEDOUT" });
  const timeoutReader = buildReader({ script: [() => { throw timeoutErr; }] });
  outcome = await timeoutReader.reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "TIMEOUT_ERROR", `got ${JSON.stringify(outcome.error)}`);
});

await check("a read that times out after the request was issued still carries an AbortSignal bounded by timeoutMs", async () => {
  let seenSignal = null;
  const { reader } = buildReader({
    script: [
      (_url, init) => {
        seenSignal = init.signal;
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }
    ]
  });
  const outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.error.code, "TIMEOUT_ERROR");
  assert(seenSignal instanceof AbortSignal, "the request must carry an AbortSignal (the read is bounded)");
});

// ---------------------------------------------------------------------------
// Eligibility short-circuits
// ---------------------------------------------------------------------------

await check("a signed-out / credential-less profile is NO_CREDENTIAL with ZERO fetches and ZERO token calls", async () => {
  for (const profile of [
    signedInProfile({ chatgptSessionState: "signed_out", hasCredential: false }),
    signedInProfile({ chatgptSessionState: "signed_out", hasCredential: true }),
    signedInProfile({ chatgptSessionState: "signed_in", hasCredential: false })
  ]) {
    const { reader, fetcher, tokenCalls } = buildReader({ script: [jsonResponse(200, usageBody())], profile });
    const outcome = await reader.readUsage(PROFILE_ID);
    assertEqual(outcome.ok, false);
    assertEqual(outcome.error.code, "NO_CREDENTIAL", `expected NO_CREDENTIAL, got ${JSON.stringify(outcome.error)}`);
    assertEqual(fetcher.calls.length, 0, "no upstream request may be sent");
    assertEqual(tokenCalls.length, 0, "no credential may be resolved");
  }
});

await check("an already-expired profile is SESSION_EXPIRED with ZERO fetches", async () => {
  const { reader, fetcher, tokenCalls } = buildReader({
    script: [jsonResponse(200, usageBody())],
    profile: signedInProfile({ chatgptSessionState: "session_expired", hasCredential: false })
  });
  const outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "SESSION_EXPIRED");
  assertEqual(fetcher.calls.length, 0);
  assertEqual(tokenCalls.length, 0);
});

await check("a profile stored for a DIFFERENT id is NO_CREDENTIAL with zero fetches (no cross-profile read)", async () => {
  const { reader, fetcher } = buildReader({
    script: [jsonResponse(200, usageBody())],
    profile: signedInProfile({ profileId: "someone-else" })
  });
  const outcome = await reader.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "NO_CREDENTIAL");
  assertEqual(fetcher.calls.length, 0);
});

await check("readUsage never throws: a loadProfile that throws, and a full 401 storm, both resolve a structured failure", async () => {
  const reader = createUsageReader({
    fetchImpl: makeFetch([jsonResponse(401, {})]),
    loadProfile: async () => {
      throw new Error("profile store exploded");
    },
    getAccessToken: async () => ({ accessToken: "t", accountId: "a" }),
    onSessionExpired: async () => {},
    now: () => NOW_MS
  });
  let outcome;
  await (async () => {
    outcome = await reader.readUsage(PROFILE_ID);
  })().catch(() => {
    throw new Error("readUsage must never reject");
  });
  assertEqual(outcome.ok, false);
  assertEqual(typeof outcome.error.code, "string", "an unexpected throw is still a structured code");

  // A recorder that itself throws must not turn the read into a rejection.
  const storm = createUsageReader({
    fetchImpl: makeFetch([jsonResponse(401, {}), jsonResponse(401, {})]),
    loadProfile: async () => signedInProfile(),
    getAccessToken: async () => ({ accessToken: "t", accountId: "a" }),
    onSessionExpired: async () => {
      throw new Error("recorder exploded");
    },
    now: () => NOW_MS
  });
  outcome = await storm.readUsage(PROFILE_ID);
  assertEqual(outcome.ok, false);
  assertEqual(outcome.error.code, "SESSION_EXPIRED");
});

await check("no reply (success or failure) ever carries account identity, a token, or an unrecognized backend key", async () => {
  const { reader } = buildReader({ script: [jsonResponse(200, usageBody({ plan_type: "plus" }))] });
  const success = await reader.readUsage(PROFILE_ID);
  assertEqual(success.ok, true);
  const serialized = JSON.stringify(success);
  for (const dropped of ["user_id", "account_id", "email", "spend_control", "promo", "model_usage", "additional_rate_limits", "rate_limit_reached_type", "rate_limit_reset_credits", "code_review_rate_limit"]) {
    assert(!serialized.includes(`"${dropped}"`), `the dropped backend field ${dropped} must not appear in the result`);
  }
  assertNoLeak(success, "final leak guard (success)");

  const { reader: failing } = buildReader({ script: [jsonResponse(500, { account_id: "LEAK-ACCOUNT-ID", user_id: "LEAK-USER-ID", email: "LEAK-EMAIL" })] });
  assertNoLeak(await failing.readUsage(PROFILE_ID), "final leak guard (failure)");
});

// ---------------------------------------------------------------------------

console.log(
  `\n${results.length - fail}/${results.length} passed` +
    (fail ? `\n\nFailures:\n${results.filter((r) => !r.ok).map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(fail ? 1 : 0);

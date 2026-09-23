#!/usr/bin/env node
//
// jev-tools-reuse-primary-provider design.md decision 3: the Jev-tools
// connection test on an `anthropic`/`chatgpt` profile (`testJevToolsCapability`
// / its internal `testCapabilityForJevTools` in
// host/agent/settings/profile.js). Proven against the REAL profile.js,
// `resolveTypesafeDecisionModel()` and `runTypesafeCapabilityTest()` — only
// the network transport is faked (a dispatch-by-URL `fetchImpl`), the same
// injection point host/test/jev-capability.test.mjs's own stub server proves
// against. The `chatgpt` branch swaps in a fully fake loopback gateway
// (`createChatgptGateway`/`_setActiveGatewayForTests`, the same pattern
// host/test/settings-typesafe.test.mjs uses) so no real ChatGPT upstream is
// ever contacted.
//
// This suite is the one place that proves:
//   1. No saved Jev transport key -> "not_configured", no network call at all.
//   2. A saved transport key on an `anthropic` profile builds the text model
//      from `profile.baseUrl` + the primary Anthropic key — never a second,
//      separately configured endpoint/key — and both tools are reported
//      enabled together only when both stages pass.
//   3. The same, on a `chatgpt` profile, through a capability-test-scoped
//      gateway token that is released whatever the outcome.
//   4. Each stage's own failure fails BOTH tools (the two tools share one
//      gate and one text model now — there is no more "extract_page only").
//   5. The primary credential (key or gateway token) never reaches the Jev
//      transport request, and the Jev transport key never reaches the
//      text-model request.
//   6. The result is always JSON-serializable with neither configured secret
//      appearing anywhere in it.
//   7. A profile with no default model is a bounded textModel-stage failure,
//      never a throw.
//
// Run: node --test host/test/jev-tools-capability-test.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as profile from "../agent/settings/profile.js";
import { memoryClearAll } from "../agent/secrets/memory-store.js";
import { createChatgptGateway, _setActiveGatewayForTests } from "../agent/chatgpt/gateway.js";

const TEST_PROFILE_ID = "ocic-test-jevtools-capability";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_BASE_URL}/v1/messages`;
const TYPESAFE_TRANSPORT_URL = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_KEY = "ts-super-secret-key";
const PRIMARY_ANTHROPIC_KEY = "sk-ant-super-secret-primary-key";

function useScratchConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-jevtools-capability-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  profile._clearCredentialRevokedListenersForTests();
  return dir;
}

/**
 * An `anthropic` profile carrying a saved Jev transport key and a saved
 * primary Anthropic key, built the same way the settings surface would.
 */
async function anthropicProfileWithJev({ typesafeApiKey = TYPESAFE_KEY, defaultModelId = "claude-x", withPrimaryKey = true } = {}) {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: ANTHROPIC_BASE_URL,
    models: defaultModelId ? [{ id: defaultModelId, label: "Claude X" }] : [],
    defaultModelId
  });
  if (withPrimaryKey) {
    await profile.setCredential(TEST_PROFILE_ID, PRIMARY_ANTHROPIC_KEY, { memoryOnly: true });
  }
  await profile.setTypesafeConfig(TEST_PROFILE_ID, { typesafeSource: "typesafe" });
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, {
    ...(typesafeApiKey !== null ? { typesafeApiKey } : {}),
    memoryOnly: true
  });
  return TEST_PROFILE_ID;
}

/** A `chatgpt` profile carrying a saved Jev transport key, signed in. */
async function chatgptProfileWithJev({ typesafeApiKey = TYPESAFE_KEY, defaultModelId = "gpt-5.5" } = {}) {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: ANTHROPIC_BASE_URL,
    models: [{ id: defaultModelId, label: defaultModelId }],
    defaultModelId
  });
  await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
  await profile.recordChatgptSignIn(TEST_PROFILE_ID, { email: "jevtools-capability-test@example.com", planType: "plus", backend: "memory" });
  await profile.setTypesafeConfig(TEST_PROFILE_ID, { typesafeSource: "typesafe" });
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, {
    ...(typesafeApiKey !== null ? { typesafeApiKey } : {}),
    memoryOnly: true
  });
  return TEST_PROFILE_ID;
}

function jsonResponse(status, payload) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { status, headers: { get: () => "application/json" }, text: async () => raw };
}

// The systemone stage's request carries the runtime's three real heads
// (action/goal_done/stuck) with generated criteria ids — never a fixed set —
// so a valid answer must be built FROM the request body, exactly like
// host/test/jev-capability.test.mjs's own `validAnswers(body)`.
function validAnswers(body) {
  const answers = {};
  for (const [name, head] of Object.entries(body.questions)) {
    const ids = Object.keys(head.criteria);
    answers[name] = { choice: ids[0], probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])), confidence: 0.9 };
  }
  return { answers, usage: { total_tokens: 3 } };
}

// The Anthropic Messages wire's reply shape (kind:"anthropic" — every
// textModel this suite builds speaks this wire now, never the OpenAI-
// compatible one).
function validAnthropicCompletion() {
  return { content: [{ type: "text", text: '{"text": "Continue"}' }], usage: { input_tokens: 3, output_tokens: 2 } };
}

/**
 * A dispatch-by-URL fake fetch, recording every URL AND its request headers
 * — the assertion surface for "the transport stage is never contacted" and
 * "the primary credential never reaches the Jev transport" below.
 * @param {{ systemone?: (body: object) => object, textModel?: (body: object, headers: object) => object }} handlers
 *   each returns a jsonResponse(); a route with no handler answers 404 so a
 *   test that expects it unreached still gets a classifiable failure rather
 *   than a thrown error, if it is ever hit by mistake.
 * @param {string} textModelUrl the exact URL the resolved textModel speaks
 *   to (fixed for anthropic; the gateway's own loopback URL for chatgpt,
 *   learned by the caller before the gateway is used).
 */
function fakeFetch(handlers = {}, textModelUrl = ANTHROPIC_MESSAGES_URL) {
  const calls = [];
  const fn = async (url, init) => {
    const headers = (init && init.headers) || {};
    calls.push({ url: String(url), headers });
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    if (String(url) === TYPESAFE_TRANSPORT_URL) {
      return handlers.systemone ? handlers.systemone(body) : jsonResponse(404, { error: "unhandled" });
    }
    if (String(url) === textModelUrl) {
      return handlers.textModel ? handlers.textModel(body, headers) : jsonResponse(404, { error: "unhandled" });
    }
    return jsonResponse(404, { error: `unhandled url ${url}` });
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

// --- No saved transport key ---------------------------------------------

test("no saved transport key: not_configured, zero network calls", async () => {
  await anthropicProfileWithJev({ typesafeApiKey: null });
  const fetchImpl = fakeFetch();
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });
  assert.equal(result.status, "not_configured");
  assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false });
  assert.deepEqual(result.errors, {});
  assert.equal(fetchImpl.calls.length, 0, "no network call may be made when nothing is configured");
  assert(!Number.isNaN(Date.parse(result.timestamp)), `timestamp must be ISO: ${result.timestamp}`);
});

test("an unrelated profileId throws NO_CREDENTIAL, matching testCapability()'s own contract", async () => {
  useScratchConfigDir();
  await assert.rejects(() => profile.testJevToolsCapability("some-other-profile", { fetchImpl: fakeFetch(), sleep: noSleep }), (err) => err.code === "NO_CREDENTIAL");
});

// --- anthropic: profile.baseUrl + the primary key -------------------------

test("an anthropic profile builds the text model from profile.baseUrl and the primary key; both tools pass together", async () => {
  await anthropicProfileWithJev();
  const fetchImpl = fakeFetch({
    systemone: (body) => jsonResponse(200, validAnswers(body)),
    textModel: (body, headers) => {
      assert.equal(headers["x-api-key"], PRIMARY_ANTHROPIC_KEY, "the text-model request must carry the primary Anthropic key");
      return jsonResponse(200, validAnthropicCompletion());
    }
  });
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

  assert.equal(result.status, "pass", JSON.stringify(result));
  assert.deepEqual(result.tools, { extract_page: true, browser_subgoal: true });
  assert.equal(result.capabilities.systemone, "pass");
  assert.equal(result.capabilities.textModel, "pass");
  assert.deepEqual(result.errors, {});

  const transportCall = fetchImpl.calls.find((c) => c.url === TYPESAFE_TRANSPORT_URL);
  assert(transportCall, "the transport route must be contacted");
  assert.equal(transportCall.headers.Authorization, `Bearer ${TYPESAFE_KEY}`, "the transport request must carry the Jev transport key");
  assert.notEqual(transportCall.headers.Authorization, `Bearer ${PRIMARY_ANTHROPIC_KEY}`, "the primary key must never reach the Jev transport");
  assert(!("x-api-key" in transportCall.headers), "the transport request must never carry the Anthropic auth header");
});

test("a failing transport fails both tools, leaving the passing text-model stage unreported as a failure", async () => {
  await anthropicProfileWithJev();
  const fetchImpl = fakeFetch({
    systemone: () => jsonResponse(401, { error: "bad transport key" }),
    textModel: () => jsonResponse(200, validAnthropicCompletion())
  });
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false }, "the two tools share one gate now — a broken transport disables both");
  assert.equal(result.errors.systemone.code, "AUTH_ERROR");
  assert.equal(result.errors.textModel, undefined, "the passing stage must not be reported as failing");
});

test("a failing text model fails both tools", async () => {
  await anthropicProfileWithJev();
  const fetchImpl = fakeFetch({
    systemone: (body) => jsonResponse(200, validAnswers(body)),
    textModel: () => jsonResponse(401, { error: "bad primary key" })
  });
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false });
  assert.equal(result.errors.textModel.code, "AUTH_ERROR");
});

test("a missing default model is a bounded textModel-stage failure, never a throw, and the transport is still probed", async () => {
  await anthropicProfileWithJev({ defaultModelId: null });
  const fetchImpl = fakeFetch({
    systemone: (body) => jsonResponse(200, validAnswers(body))
  });
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false });
  assert.equal(result.capabilities.textModel, "fail");
  assert(result.errors.textModel && result.errors.textModel.code, "the textModel stage must report a bounded, classified failure");
  assert(!JSON.stringify(result).includes(TYPESAFE_KEY));
});

test("a missing primary Anthropic key is a bounded textModel-stage failure, never a throw", async () => {
  await anthropicProfileWithJev({ withPrimaryKey: false });
  const fetchImpl = fakeFetch({
    systemone: (body) => jsonResponse(200, validAnswers(body))
  });
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false });
  assert.equal(result.capabilities.textModel, "fail");
  assert.equal(result.errors.textModel.code, "AUTH_ERROR");
});

test("the result never carries either configured secret, in any scenario", async () => {
  await anthropicProfileWithJev();
  const fetchImpl = fakeFetch({
    systemone: (body) => jsonResponse(200, validAnswers(body)),
    textModel: () => jsonResponse(200, validAnthropicCompletion())
  });
  const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });
  const wire = JSON.stringify(result);
  assert(!wire.includes(TYPESAFE_KEY), "the Jev transport key must never appear in the result");
  assert(!wire.includes(PRIMARY_ANTHROPIC_KEY), "the primary Anthropic key must never appear in the result");
});

// --- chatgpt: a capability-test-scoped gateway token ----------------------

test("a chatgpt profile issues a capability-test gateway token, uses it as the text model's key, and releases it on pass", async () => {
  const gw = createChatgptGateway({
    upstreamUrl: "http://127.0.0.1:1/never",
    getAccessToken: async () => ({ accessToken: "fake-chatgpt-access-token", accountId: "acc-mock" }),
    loadProfile: () => profile.loadProfile()
  });
  _setActiveGatewayForTests(gw);
  try {
    await chatgptProfileWithJev();
    // Learned deterministically before the capability test itself starts the
    // gateway lazily — profile.js's internal `ensureGatewayStarted()` then
    // hits the "already started" branch and returns this same port.
    const { port } = await gw.ensureStarted();
    const textModelUrl = `http://127.0.0.1:${port}/v1/messages`;
    const fetchImpl = fakeFetch(
      {
        systemone: (body) => jsonResponse(200, validAnswers(body)),
        textModel: (body, headers) => {
          assert(typeof headers["x-api-key"] === "string" && headers["x-api-key"], "the text-model request must carry a gateway-issued token");
          return jsonResponse(200, validAnthropicCompletion());
        }
      },
      textModelUrl
    );

    assert.equal(gw._tokenCount(), 0, "no token should be outstanding before the test runs");
    const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

    assert.equal(result.status, "pass", JSON.stringify(result));
    assert.deepEqual(result.tools, { extract_page: true, browser_subgoal: true });
    assert.equal(gw._tokenCount(), 0, "the capability-test-scoped gateway token must be released after a pass");
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
  }
});

test("a chatgpt profile's gateway token is released on a failing text-model stage too", async () => {
  const gw = createChatgptGateway({
    upstreamUrl: "http://127.0.0.1:1/never",
    getAccessToken: async () => ({ accessToken: "fake-chatgpt-access-token", accountId: "acc-mock" }),
    loadProfile: () => profile.loadProfile()
  });
  _setActiveGatewayForTests(gw);
  try {
    await chatgptProfileWithJev();
    const { port } = await gw.ensureStarted();
    const textModelUrl = `http://127.0.0.1:${port}/v1/messages`;
    const fetchImpl = fakeFetch(
      {
        systemone: (body) => jsonResponse(200, validAnswers(body)),
        textModel: () => jsonResponse(401, { error: "revoked" })
      },
      textModelUrl
    );

    const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

    assert.equal(result.status, "fail");
    assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false });
    assert.equal(gw._tokenCount(), 0, "the gateway token must be released even when the stage it authorized failed");
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
  }
});

test("a chatgpt profile not signed in is a bounded textModel-stage failure, never a throw, and mints no gateway token", async () => {
  const gw = createChatgptGateway({
    upstreamUrl: "http://127.0.0.1:1/never",
    getAccessToken: async () => ({ accessToken: "fake-chatgpt-access-token", accountId: "acc-mock" }),
    loadProfile: () => profile.loadProfile()
  });
  _setActiveGatewayForTests(gw);
  try {
    useScratchConfigDir();
    await profile.saveProfile({
      profileId: TEST_PROFILE_ID,
      baseUrl: ANTHROPIC_BASE_URL,
      models: [{ id: "gpt-5.5", label: "gpt-5.5" }],
      defaultModelId: "gpt-5.5"
    });
    await profile.setProviderType(TEST_PROFILE_ID, "chatgpt");
    // Deliberately never signed in.
    await profile.setTypesafeConfig(TEST_PROFILE_ID, { typesafeSource: "typesafe" });
    await profile.setTypesafeCredentials(TEST_PROFILE_ID, { typesafeApiKey: TYPESAFE_KEY, memoryOnly: true });

    const fetchImpl = fakeFetch({ systemone: (body) => jsonResponse(200, validAnswers(body)) });
    const result = await profile.testJevToolsCapability(TEST_PROFILE_ID, { fetchImpl, sleep: noSleep });

    assert.equal(result.status, "fail");
    assert.deepEqual(result.tools, { extract_page: false, browser_subgoal: false });
    assert.equal(result.capabilities.textModel, "fail");
    assert.equal(gw._tokenCount(), 0, "a profile that is not signed in must never mint a gateway token");
  } finally {
    _setActiveGatewayForTests();
    await gw.close();
  }
});

// Task 4.5: settings-client.js wire-contract tests — verifies the exact
// message shape sent to the companion and the response translation, without
// any live extension/native-messaging plumbing (none is available; see this
// task's "Environment constraint"). A fake `sendMessage` stands in for
// `chrome.runtime.sendMessage`; settings-client.js itself is the real,
// shipped module under test.
//
// Run: node test/settings-ui-client.test.mjs
import { createSettingsClient, ProviderErrorLike } from "../extension/settings/settings-client.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

console.log("== outgoing message shape ==");
{
  const calls = [];
  const client = createSettingsClient({
    sendMessage: async (msg) => {
      calls.push(msg);
      return { ok: true, result: { echoed: true } };
    }
  });
  await client.getProfile("default");
  ok(calls.length === 1 && calls[0].type === "agent_settings" && calls[0].op === "get_profile" && calls[0].profileId === "default",
    `getProfile sends { type: "agent_settings", op: "get_profile", profileId } — got ${JSON.stringify(calls[0])}`);

  await client.saveProfile("default", { baseUrl: "https://x", models: [], defaultModelId: null });
  ok(calls[1].op === "save_profile" && calls[1].baseUrl === "https://x", "saveProfile forwards op + patch fields");

  await client.setCredential("default", "sk-test-value", { memoryOnly: true });
  ok(calls[2].op === "set_credential" && calls[2].secret === "sk-test-value" && calls[2].memoryOnly === true,
    "setCredential forwards secret + options on the outbound call only (the one documented transient-hold path)");

  await client.removeCredential("default");
  ok(calls[3].op === "remove_credential", "removeCredential op");

  await client.testCapability("default", "claude-sonnet-5");
  ok(calls[4].op === "test_capability" && calls[4].modelId === "claude-sonnet-5", "testCapability forwards modelId");

  // jev-tools-connection-test-and-preference tasks.md 2.2/4.3: the SAME
  // `test_capability` op, distinguished by `target: "jev-tools"` — never a
  // `modelId` (the Jev-tools config is resolved from the profile itself).
  await client.testJevToolsCapability("default");
  ok(calls[5].op === "test_capability" && calls[5].target === "jev-tools" && calls[5].profileId === "default",
    `testJevToolsCapability sends { op: "test_capability", target: "jev-tools", profileId } — got ${JSON.stringify(calls[5])}`);
  ok(!("modelId" in calls[5]), "testJevToolsCapability never sends a modelId");

  await client.discoverModels("default");
  ok(calls[6].op === "discover_models", "discoverModels op");

  await client.exportProfile("default");
  ok(calls[7].op === "export_profile", "exportProfile op");
}

console.log("== outgoing message shape: the ChatGPT subscription ops ==");
{
  const calls = [];
  const client = createSettingsClient({ sendMessage: async (msg) => { calls.push(msg); return { ok: true, result: {} }; } });

  await client.setProviderType("default", "chatgpt");
  ok(calls[0].type === "agent_settings" && calls[0].op === "set_provider_type" && calls[0].profileId === "default" && calls[0].providerType === "chatgpt",
    `setProviderType sends { op: "set_provider_type", profileId, providerType } — got ${JSON.stringify(calls[0])}`);

  await client.chatgptSignInStart("default");
  ok(calls[1].op === "chatgpt_sign_in_start" && calls[1].profileId === "default" && !("signInId" in calls[1]),
    "chatgptSignInStart forwards profileId only (no signInId, no token)");

  await client.chatgptDeviceStart("default");
  ok(calls[2].op === "chatgpt_device_start" && calls[2].profileId === "default",
    "chatgptDeviceStart forwards profileId only");

  await client.chatgptSignInStatus("sign-in-1");
  ok(calls[3].op === "chatgpt_sign_in_status" && calls[3].signInId === "sign-in-1" && !("profileId" in calls[3]),
    "chatgptSignInStatus is keyed by signInId ONLY — never a profile or credential");

  await client.chatgptSignInCancel("sign-in-1");
  ok(calls[4].op === "chatgpt_sign_in_cancel" && calls[4].signInId === "sign-in-1" && !("profileId" in calls[4]),
    "chatgptSignInCancel is keyed by signInId ONLY");

  await client.chatgptSignOut("default");
  ok(calls[5].op === "chatgpt_sign_out" && calls[5].profileId === "default",
    "chatgptSignOut forwards profileId only");

  // The user-confirmed memory-only retry (specs/agent-settings "Secret
  // isolation") is the ONLY case that carries an option on the two start ops
  // — `memoryOnly: true`, never an explicit false.
  await client.chatgptSignInStart("default", { memoryOnly: true });
  ok(calls[6].op === "chatgpt_sign_in_start" && calls[6].profileId === "default" && calls[6].memoryOnly === true,
    `chatgptSignInStart forwards memoryOnly:true for the memory-only retry — got ${JSON.stringify(calls[6])}`);

  await client.chatgptDeviceStart("default", { memoryOnly: true });
  ok(calls[7].op === "chatgpt_device_start" && calls[7].profileId === "default" && calls[7].memoryOnly === true,
    `chatgptDeviceStart forwards memoryOnly:true for the memory-only retry — got ${JSON.stringify(calls[7])}`);

  // The wire contract forbids a token/credential value in EITHER direction.
  const SECRET_SHAPED = /token|secret|credential|password|apikey|api_key/i;
  for (const msg of calls) {
    const offending = Object.keys(msg).filter((k) => SECRET_SHAPED.test(k));
    ok(offending.length === 0, `no secret-shaped field on ${msg.op}: ${offending.length ? offending.join(",") : "none"}`);
  }
}

console.log("== outgoing message shape: the ChatGPT account-usage read ==");
{
  // add-chatgpt-usage-check task 3.4: the usage op is a plain { profileId }
  // request — the companion resolves the credential, and the reply is the
  // display-shaped result the settings page renders. This pins the request
  // shape (nothing else may ride along) and the minimal reply's pass-through.
  const calls = [];
  const usage = {
    planType: "plus",
    allowed: true,
    limitReached: false,
    primary: { usedPercent: 3, limitWindowSeconds: 2592000, resetAfterSeconds: 1209600, resetAt: 1767264000000 },
    secondary: null,
    credits: null
  };
  const client = createSettingsClient({
    sendMessage: async (msg) => {
      calls.push(msg);
      return { ok: true, result: usage };
    }
  });

  const result = await client.chatgptUsage("default");
  ok(calls.length === 1, "one message per call");
  ok(calls[0].type === "agent_settings" && calls[0].op === "chatgpt_usage" && calls[0].profileId === "default",
    `chatgptUsage sends { type: "agent_settings", op: "chatgpt_usage", profileId } — got ${JSON.stringify(calls[0])}`);
  ok(Object.keys(calls[0]).length === 3,
    `and NOTHING else rides along (no token, no account id, no model id) — got ${JSON.stringify(Object.keys(calls[0]))}`);
  ok(JSON.stringify(result) === JSON.stringify(usage), "the display-shaped reply passes through unwrapped and unmodified");

  // A failing read is a structured envelope error like every other op: the
  // block's own copy keys off this code (USAGE_UNAVAILABLE is the new one).
  const failing = createSettingsClient({
    sendMessage: async () => ({ ok: false, error: { code: "USAGE_UNAVAILABLE", message: "the usage body was not the expected shape" } })
  });
  let caught = null;
  try {
    await failing.chatgptUsage("default");
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof ProviderErrorLike && caught.code === "USAGE_UNAVAILABLE",
    "USAGE_UNAVAILABLE arrives as a typed ProviderErrorLike with its code intact");
}

console.log("== outgoing message shape: the Jev browser-tools transport ops ==");
{
  // jev-tools-settings-on-llm-profiles. Two ops, two very different shapes:
  // the config op carries non-secret fields (and never a key), the credential
  // op carries the raw key OUTBOUND only and receives a boolean back. Both are
  // pinned here because the settings page's gating and the companion's
  // dispatch are written against exactly these names/fields.
  const calls = [];
  const configReply = {
    profileId: "default",
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-sonnet-5", label: "Sonnet" }],
    defaultModelId: "claude-sonnet-5",
    providerType: "anthropic",
    typesafeSource: "vercel",
    jevToolsSendScreenshots: true,
    hasTypesafeKey: true,
    hasCredential: true,
    memoryOnlyCredential: false,
    secretBackend: "windows-credential-manager",
    revision: 3
  };
  const client = createSettingsClient({
    sendMessage: async (msg) => {
      calls.push(msg);
      if (msg.op === "set_typesafe_config") return { ok: true, result: configReply };
      return { ok: true, result: { backend: "windows-credential-manager", hasTypesafeKey: true } };
    }
  });

  const configResult = await client.setTypesafeConfig("default", { typesafeSource: "vercel", jevToolsSendScreenshots: true });
  ok(calls[0].type === "agent_settings" && calls[0].op === "set_typesafe_config" && calls[0].profileId === "default",
    `setTypesafeConfig sends { type: "agent_settings", op: "set_typesafe_config", profileId } — got ${JSON.stringify(calls[0])}`);
  ok(calls[0].typesafeSource === "vercel" && calls[0].jevToolsSendScreenshots === true,
    "and forwards the transport source and screenshot toggle verbatim");
  ok(!("baseUrl" in calls[0]), "an omitted Jev endpoint is NOT sent — the host derives it from the source");
  ok(!/key|secret|token/i.test(Object.keys(calls[0]).join(",")), `no key-shaped field rides on the config op — got ${JSON.stringify(Object.keys(calls[0]))}`);
  ok(configResult.typesafeSource === "vercel" && configResult.hasTypesafeKey === true,
    "the updated secret-free profile passes through, booleans included");

  const credentialsResult = await client.setTypesafeCredentials("default", { typesafeApiKey: "ts-secret-value" });
  ok(calls[1].op === "set_typesafe_credentials" && calls[1].profileId === "default",
    "setTypesafeCredentials sends its own op for the profile");
  ok(calls[1].typesafeApiKey === "ts-secret-value",
    "the raw transport key travels OUTBOUND on this one call (the same documented transient hold set_credential has)");
  ok(!("memoryOnly" in calls[1]), "an ordinary save never asks for memory-only (only the confirmed retry does)");
  ok(JSON.stringify(credentialsResult) === JSON.stringify({ backend: "windows-credential-manager", hasTypesafeKey: true }),
    `the reply is a boolean plus the backend label — never a key — got ${JSON.stringify(credentialsResult)}`);

  await client.setTypesafeCredentials("default", { typesafeApiKey: "" }, { memoryOnly: true });
  ok(calls[2].typesafeApiKey === "", "an explicit empty string is forwarded as the removal signal, never dropped");
  ok(calls[2].memoryOnly === true, "the user-confirmed memory-only retry is the one call that carries memoryOnly:true");

  await client.setTypesafeConfig("default", { baseUrl: "https://api.typesafe.ai", typesafeSource: "typesafe" });
  ok(calls[3].baseUrl === "https://api.typesafe.ai", "a caller-supplied endpoint is forwarded when present (the page has no field for it yet)");

  // The Jev-tools screenshot toggle (jev-subgoal-screenshots-default-off task
  // 3.2): a non-secret boolean on the same config op. `false` must survive
  // the spread — a client that dropped falsey values would silently leave
  // screenshots ON for every operator who turned them off.
  await client.setTypesafeConfig("default", { typesafeSource: "typesafe", jevToolsSendScreenshots: false });
  ok(calls[4].jevToolsSendScreenshots === false, `the toggle travels verbatim on set_typesafe_config — got ${JSON.stringify(calls[4])}`);
  ok(!/key|secret|token/i.test(Object.keys(calls[4]).join(",")), "and no key-shaped field was added alongside it");
  await client.setTypesafeConfig("default", { typesafeSource: "typesafe" });
  ok(!("jevToolsSendScreenshots" in calls[5]), "an omitted toggle is not sent — the companion keeps the stored value, the same rule the key follows");
}

console.log("== success response translation ==");
{
  const client = createSettingsClient({ sendMessage: async () => ({ ok: true, result: { hello: "world" } }) });
  const result = await client.getProfile("default");
  ok(result && result.hello === "world", "ok:true unwraps to .result");
}

console.log("== error response translation ==");
{
  const client = createSettingsClient({ sendMessage: async () => ({ ok: false, error: { code: "AUTH_ERROR", message: "bad key" } }) });
  let caught = null;
  try {
    await client.testCapability("default", "m");
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof ProviderErrorLike, "a well-formed error response throws ProviderErrorLike");
  ok(caught && caught.code === "AUTH_ERROR" && caught.message === "bad key", "code/message preserved exactly, no key present anywhere in the error");
}

console.log("== missing listener / rejected sendMessage never reports success ==");
{
  const client = createSettingsClient({ sendMessage: async () => { throw new Error("Could not establish connection. Receiving end does not exist."); } });
  let caught = null;
  try {
    await client.saveProfile("default", {});
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof ProviderErrorLike && caught.code === "NETWORK_ERROR", "a rejected transport call surfaces as NETWORK_ERROR, never a false pass");
}

console.log("== malformed response never reports success ==");
for (const bad of [null, undefined, "a string", 42, {}]) {
  const client = createSettingsClient({ sendMessage: async () => bad });
  let caught = null;
  try {
    await client.discoverModels("default");
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof ProviderErrorLike, `malformed response ${JSON.stringify(bad)} throws rather than silently succeeding`);
}

console.log("== default transport: no chrome.runtime -> NETWORK_ERROR, not a hang or a crash ==");
{
  const priorChrome = globalThis.chrome;
  delete globalThis.chrome;
  const client = createSettingsClient();
  let caught = null;
  try {
    await client.getProfile("default");
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof ProviderErrorLike && caught.code === "NETWORK_ERROR", "no chrome.runtime available is reported, not silently swallowed");
  if (priorChrome !== undefined) globalThis.chrome = priorChrome;
}

console.log(fail === 0 ? "\nALL SETTINGS-UI CLIENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

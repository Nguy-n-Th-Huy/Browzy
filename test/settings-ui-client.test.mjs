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

  await client.discoverModels("default");
  ok(calls[5].op === "discover_models", "discoverModels op");

  await client.exportProfile("default");
  ok(calls[6].op === "export_profile", "exportProfile op");
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

// The Jev browser-tools section on an `anthropic`/`chatgpt` profile —
// settings-controller.js's saveJevTools()/setJevToolsTransportSource()/
// removeTypesafeKey()/confirmMemoryOnlyCredential(), all of which must never
// misreport the profile's PRIMARY Anthropic/ChatGPT credential. The section
// collects no text-model fields at all — the tools' text/decision model is
// the profile's OWN primary provider and current model, resolved host-side
// from the run snapshot — so saveJevTools() sends only the Jev transport
// source and the screenshot toggle, and never requires anything before it
// succeeds.
//
// Driven against the same deterministic scripted fake companion
// test/settings-ui-controller.test.mjs uses (test/settings-ui-scripted-
// companion.mjs) — see that file's own header for why: fast, fully
// deterministic, and the exact duck-typed interface settings-client.js's
// createSettingsClient() returns.
//
// settings-app.js (the DOM binding layer) is untested by design here, same
// as every other controller suite in this tree (see settings-controller.js's
// file header) — visual/DOM correctness is out of this file's scope.
//
// Run: node test/settings-ui-jevtools-llm-profiles.test.mjs
import { SettingsController, typesafeSourceCopy } from "../extension/settings/settings-controller.js";
import { createScriptedCompanion } from "./settings-ui-scripted-companion.mjs";
import { ProviderErrorLike } from "../extension/settings/settings-client.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

// An `anthropic` profile that has never touched the Jev browser-tools
// section: every field host/agent/settings/profile.js's loadProfile() adds
// is present but empty/false, with a real Anthropic credential already saved
// (the thing this whole change must never disturb).
function anthropicProfile(overrides = {}) {
  return {
    profileId: "default",
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-sonnet-5", label: "Sonnet" }],
    defaultModelId: "claude-sonnet-5",
    hasCredential: true,
    memoryOnlyCredential: false,
    secretBackend: "windows-credential-manager",
    revision: 5,
    credentialRevision: 1,
    providerType: "anthropic",
    chatgptAccount: null,
    chatgptSessionState: "signed_out",
    hasTypesafeKey: false,
    typesafeSource: "typesafe",
    ...overrides
  };
}

console.log("== Jev tools on an anthropic profile: saveJevTools() succeeds with nothing entered — there is no text model to require ==");
{
  // jev-tools-reuse-primary-provider: the section collects no text-model
  // fields at all — the tools' text/decision model is the profile's OWN
  // primary provider, resolved host-side. There is nothing left to validate
  // before this call, so it must succeed even with a completely untouched
  // section (the documented transport source/screenshot defaults ride the
  // wire regardless).
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();

  const result = await c.saveJevTools({});
  ok(result.ok === true, "a profile with nothing entered still saves successfully");
  ok(!c.getState().fieldErrors.textModelBaseUrl && !c.getState().fieldErrors.textModelId, "there is no text-model field to carry an error");
  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(
    configCall && configCall.typesafeSource === "typesafe" && configCall.jevToolsSendScreenshots === false,
    `the config op still sends the documented transport-source/screenshot defaults — got ${JSON.stringify(configCall)}`
  );
  ok(!("textModelBaseUrl" in (configCall || {})) && !("textModelId" in (configCall || {})) && !("decisionSource" in (configCall || {})),
    "no text-model or decision-source field is ever sent — this section collects none");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_credentials"), "no key was typed, so no credential op fires");
}

console.log("== Jev tools on an anthropic profile: saveJevTools() persists the transport source and screenshot toggle, and never sends baseUrl, text-model or decision fields ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();

  c.setJevToolsTransportSource("vercel");
  c.setJevToolsSendScreenshots(true);
  const result = await c.saveJevTools({});
  ok(result.ok === true, "the transport-only save succeeds");

  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && configCall.typesafeSource === "vercel" && configCall.jevToolsSendScreenshots === true,
    `the transport source and screenshot toggle ride the config op — got ${JSON.stringify(configCall)}`);
  ok(!("textModelBaseUrl" in configCall) && !("textModelId" in configCall) && !("decisionSource" in configCall) && !("decisionBaseUrl" in configCall) && !("decisionModelId" in configCall),
    "no legacy text-model or decision-model field is ever sent by this section's save");
  ok(!("baseUrl" in configCall), "no baseUrl is ever sent — the host derives the Jev endpoint from the source on this profile type, and baseUrl IS the Anthropic endpoint");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_credentials"), "no key was typed, so no credential op fires");

  const s = c.getState();
  ok(s.baseUrl === "https://api.anthropic.com" && s.baseUrlDraft === "https://api.anthropic.com",
    "the profile's primary Anthropic Base URL is completely untouched");
  ok(s.hasCredential === true && s.memoryOnlyCredential === false && s.secretBackend === "windows-credential-manager",
    "the primary Anthropic credential's stored-ness is completely untouched");
}

console.log("== Jev tools on an anthropic profile: saving the transport key persists it and never mirrors a raw value, without touching the Anthropic credential fields ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  const snapshots = [];
  c.onChange = (snapshot) => snapshots.push(snapshot);
  await c.init();

  const result = await c.saveJevTools({ typesafeApiKey: "ts-RAW-SENTINEL-1" });
  ok(result.ok === true, "the save (config + key) succeeds");

  const credCall = companion.calls.find((x) => x.op === "set_typesafe_credentials");
  ok(credCall && credCall.typesafeKeyLength === "ts-RAW-SENTINEL-1".length,
    `the RAW key length travelled, never the value itself — got ${JSON.stringify(credCall)}`);
  ok(!("textModelApiKey" in (credCall || {})), "no text-model key field is ever sent — this section collects none");
  ok(!snapshots.map((snap) => JSON.stringify(snap)).join("\n").includes("RAW-SENTINEL"),
    "no key VALUE is ever mirrored into an emitted state snapshot");

  const s = c.getState();
  ok(s.hasTypesafeKey === true, "the Jev has-key boolean reflects the save");
  ok(s.hasCredential === true, "the profile's hasCredential (the Anthropic key, saved before this test began) is untouched — still true");
  ok(s.memoryOnlyCredential === false && s.secretBackend === "windows-credential-manager",
    "the Anthropic credential's own memory-only/backend fields are untouched — NOT overwritten from the Jev key's own (different) storage record");
}

console.log("== Jev tools on an anthropic profile: removeTypesafeKey() never falsifies the Anthropic credential state ==");
{
  // Regression coverage for the guard on the SHARED removeTypesafeKey()
  // method: it is also the Jev-tools section's own "Xóa key" action, and it
  // must never recompute hasCredential/memoryOnlyCredential/secretBackend
  // from the Jev transport key — those three fields describe the real
  // Anthropic key, a separate, untouched secret.
  const companion = createScriptedCompanion(anthropicProfile({ hasTypesafeKey: true }));
  const c = new SettingsController(companion.client);
  await c.init();

  const result = await c.removeTypesafeKey();
  ok(result.ok === true, "removing the transport key succeeds");
  const s = c.getState();
  ok(s.hasTypesafeKey === false, "the Jev transport key is cleared");
  ok(s.hasCredential === true, "the Anthropic credential is still reported as saved");
  ok(s.memoryOnlyCredential === false && s.secretBackend === "windows-credential-manager", "the Anthropic credential's backend fields are untouched");
}

console.log("== Jev tools transport source: setJevToolsTransportSource() never moves the primary Anthropic Base URL draft ==");
{
  // Regression coverage for the bug this task's own implementation avoided:
  // setTypesafeSource() (the standalone typesafe block's setter) ALSO moves
  // state.baseUrlDraft to the new source's documented default whenever the
  // draft still equals a KNOWN Jev default endpoint — correct for a
  // `typesafe` profile (that draft IS its Jev endpoint), but on an
  // anthropic/chatgpt profile baseUrlDraft is the Anthropic endpoint, which
  // must never be rewritten by a Jev-tools control. Constructed so the
  // (unlikely but possible) trap condition — the operator's Anthropic Base
  // URL happening to equal a documented Jev default — is exercised directly.
  const companion = createScriptedCompanion(anthropicProfile({ baseUrl: "https://api.typesafe.ai" }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().baseUrlDraft === "https://api.typesafe.ai", "sanity: the primary draft starts equal to a known Jev default");

  const result = c.setJevToolsTransportSource("vercel");
  ok(result.ok === true, "the transport source select accepts a known source");
  const s = c.getState();
  ok(s.typesafeSource === "vercel", "the transport source itself updates");
  ok(s.baseUrlDraft === "https://api.typesafe.ai", "the primary Anthropic Base URL draft is completely untouched — unlike setTypesafeSource()");

  const refused = c.setJevToolsTransportSource("not-a-real-source");
  ok(refused.ok === false && c.getState().typesafeSource === "vercel", "an unknown source is refused and state is untouched");
}

console.log("== Jev tools on an anthropic profile: confirmMemoryOnlyCredential() never overwrites the primary Anthropic credential state ==");
{
  // Regression coverage for the guard on the SHARED confirmMemoryOnlyCredential()
  // method (settings-controller.js, the explicit user-confirmed retry after a
  // SECURE_STORAGE_UNAVAILABLE offer): a retried Jev transport key must never
  // touch hasCredential/memoryOnlyCredential/secretBackend, which describe
  // the PRIMARY Anthropic/ChatGPT credential, a separate, untouched secret.
  const { ProviderErrorLike: Err } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(anthropicProfile());
  companion.scripts.setTypesafeCredentials = () => {
    throw new Err("SECURE_STORAGE_UNAVAILABLE", "no OS credential store is available");
  };
  const c = new SettingsController(companion.client);
  await c.init();

  const result = await c.saveJevTools({ typesafeApiKey: "ts-MEM-SENTINEL" });
  ok(result.ok === true, "the non-secret config half still succeeds even though the key could not be persisted");

  const offered = c.getState();
  ok(offered.hasTypesafeKey === false, "the Jev key is never faked into a success");
  ok(offered.pendingMemoryOnlyOffer === true && offered.memoryOnlyOfferKind === "typesafe_credentials",
    `the memory-only offer is surfaced and labeled for this credential kind — got ${offered.memoryOnlyOfferKind}`);
  ok(offered.hasCredential === true && offered.memoryOnlyCredential === false && offered.secretBackend === "windows-credential-manager",
    "the primary Anthropic credential's stored-ness is untouched by the FAILED Jev-key save");

  companion.scripts.setTypesafeCredentials = null; // the confirmed retry uses the fake's default (memory-backed) success path
  const confirmed = await c.confirmMemoryOnlyCredential();
  ok(confirmed.ok === true, "the explicit memory-only confirmation completes the Jev-key save");

  const s = c.getState();
  ok(s.hasTypesafeKey === true, "the Jev key is now reported as saved (memory-only)");
  ok(s.hasCredential === true && s.memoryOnlyCredential === false && s.secretBackend === "windows-credential-manager",
    "the PRIMARY Anthropic credential's hasCredential/memoryOnlyCredential/secretBackend are completely untouched — a retried Jev transport key must never misreport this profile's real Anthropic key as memory-only");
}

console.log("== Jev tools on an anthropic profile: primary Anthropic key/credential ops are still the only writers of hasCredential (sanity) ==");
{
  const companion = createScriptedCompanion(anthropicProfile({ hasCredential: false, secretBackend: null }));
  const c = new SettingsController(companion.client);
  await c.init();
  await c.saveJevTools({ typesafeApiKey: "ts-key" });
  ok(c.getState().hasCredential === false, "a profile with no Anthropic key saved still reports none, even after a full Jev-tools save — the two credentials are independent");
}

// --- save() (the page's own bottom Save button) also persists the Jev
// browser-tools section's key ------------------------------------------------
//
// Regression coverage for the bug this originally fixed: #btn-save used to
// only read/clear #key-input — a key typed into the Jev-tools section's own
// transport key input and "saved" via the page's main bottom Save button was
// silently dropped (never sent, never cleared from the input). save()'s
// second parameter (settings-controller.js) closes that gap by routing
// through the SAME #saveJevToolsCredentials() helper saveJevTools() itself
// uses.

console.log("== save() on an anthropic profile: a Jev key typed there is sent, and never touches the primary credential ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  const snapshots = [];
  c.onChange = (snapshot) => snapshots.push(snapshot);
  await c.init();

  const result = await c.save("", { typesafeApiKey: "ts-MAIN-SAVE-SENTINEL" });
  ok(result.ok === true, "the primary save succeeds");

  const credCall = companion.calls.find((x) => x.op === "set_typesafe_credentials");
  ok(credCall && credCall.typesafeKeyLength === "ts-MAIN-SAVE-SENTINEL".length,
    `the typed key rides the op — got ${JSON.stringify(credCall)}`);
  ok(!snapshots.map((snap) => JSON.stringify(snap)).join("\n").includes("MAIN-SAVE-SENTINEL"),
    "no key VALUE is ever mirrored into an emitted state snapshot");

  const s = c.getState();
  ok(s.hasTypesafeKey === true, "the typed Jev transport key is reported as saved");
  ok(s.hasCredential === true && s.memoryOnlyCredential === false && s.secretBackend === "windows-credential-manager",
    "the primary Anthropic credential's own hasCredential/memoryOnlyCredential/secretBackend are completely untouched by this Jev-key save");
}

console.log("== save() on an anthropic profile: no Jev key op fires when nothing was typed in that section ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();

  const result = await c.save("", { typesafeApiKey: "" });
  ok(result.ok === true, "the primary save succeeds");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_credentials"), "an empty jevToolsSecrets sends nothing — no op fires just because Save was clicked");

  const resultOmitted = await c.save("");
  ok(resultOmitted.ok === true, "the primary save succeeds when jevToolsSecrets is omitted entirely (its default)");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_credentials"), "omitting the argument behaves exactly like passing an empty string");
}

console.log("== save() on an anthropic profile: a Jev-key write failure shows its own error banner, not the generic \"Đã lưu\" success ==");
{
  const { ProviderErrorLike: Err } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(anthropicProfile());
  companion.scripts.setTypesafeCredentials = () => {
    throw new Err("AUTH_ERROR", "the companion rejected the write");
  };
  const c = new SettingsController(companion.client);
  await c.init();

  const result = await c.save("", { typesafeApiKey: "ts-WILL-FAIL" });
  ok(result.ok === true, "save() itself still reports ok — the primary profile half succeeded; only the Jev-key half failed");

  const s = c.getState();
  ok(s.banner && s.banner.kind === "error", `a failed Jev-key write must surface its own error banner instead of the generic "Đã lưu" success — got ${JSON.stringify(s.banner)}`);
  ok(s.banner.code === "AUTH_ERROR", "the banner carries the code the companion actually threw");
  ok(s.hasTypesafeKey === false, "the key is never faked into a success");
  ok(s.hasCredential === true && s.memoryOnlyCredential === false && s.secretBackend === "windows-credential-manager",
    "the primary Anthropic credential is untouched by the FAILED Jev-key write");
}

// --- The Jev-tools connection test (jev-tools-connection-test-and-preference
// tasks.md 2.2/4.3): controller.testJevToolsConnection() sends the SAME
// `test_capability` op with `target: "jev-tools"` and never touches
// `connectionStatus`/`banner` (the PRIMARY provider test's own state) —
// mirrored here at the scripted-companion boundary the same way every other
// section of this file drives saveJevTools()/removeTypesafeKey(). Real DOM
// rendering (settings-app.js's renderJevToolsTestResult) is out of scope, per
// this file's own header.

console.log("== Jev-tools connection test: sends target: \"jev-tools\", never a modelId, and never touches the primary connectionStatus ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  c.state.connectionStatus = { status: "pass", capabilities: { text: "pass", tool: "pass", vision: "pass" }, errors: {}, timestamp: "t" };

  companion.scripts.testJevToolsCapability = () => ({
    status: "pass",
    tools: { extract_page: true, browser_subgoal: true },
    capabilities: { textModel: "pass", systemone: "pass" },
    errors: {},
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  const result = await c.testJevToolsConnection();
  ok(result.ok === true, "a pass status is reported ok");

  const call = companion.calls.find((x) => x.op === "test_capability" && x.target === "jev-tools");
  ok(Boolean(call), `the target: "jev-tools" envelope must be sent — got ${JSON.stringify(companion.calls)}`);
  ok(call.modelId === undefined, "the Jev-tools test never sends a modelId — the config is resolved from the profile, not a chosen conversation model");

  const s = c.getState();
  ok(s.jevToolsTest.status === "pass" && s.jevToolsTest.tools.extract_page === true && s.jevToolsTest.tools.browser_subgoal === true,
    `the result lands in state.jevToolsTest — got ${JSON.stringify(s.jevToolsTest)}`);
  ok(s.testingJevTools === false, "the in-flight flag clears on completion");
  ok(s.connectionStatus.status === "pass" && s.connectionStatus.timestamp === "t",
    "the PRIMARY provider's own connectionStatus must be completely untouched by the Jev-tools test");
  ok(s.banner === null, "the Jev-tools test must never set the page's own top banner — its result renders inside #jevtools-fields only");
}

console.log("== Jev-tools connection test: distinguishes extract_page-only from browser_subgoal-capable ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  companion.scripts.testJevToolsCapability = () => ({
    status: "pass",
    tools: { extract_page: true, browser_subgoal: false },
    capabilities: { textModel: "pass", systemone: "not_run" },
    errors: {},
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  await c.testJevToolsConnection();
  const s = c.getState();
  ok(s.jevToolsTest.tools.extract_page === true && s.jevToolsTest.tools.browser_subgoal === false,
    "extract_page-only must be distinguishable from browser_subgoal-capable in the rendered result");
  ok(s.jevToolsTest.capabilities.systemone === "not_run", "the untested transport stage must read as not_run, never a failure");
}

console.log("== Jev-tools connection test: a classified stage failure is reported, and the result carries no secret ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  companion.scripts.testJevToolsCapability = () => ({
    status: "fail",
    tools: { extract_page: false, browser_subgoal: false },
    capabilities: { textModel: "fail", systemone: "not_run" },
    errors: { textModel: { code: "AUTH_ERROR", message: "authentication rejected" } },
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  const result = await c.testJevToolsConnection();
  ok(result.ok === false, "a fail status is reported not-ok");
  const s = c.getState();
  ok(s.jevToolsTest.status === "fail" && s.jevToolsTest.errors.textModel.code === "AUTH_ERROR",
    "the classified failure must be named");
  const wire = JSON.stringify(s.jevToolsTest);
  ok(!/secret|apiKey|api_key|credential/i.test(wire), `the rendered result must never carry a secret-shaped field — got ${wire}`);
}

console.log("== Jev-tools connection test: a companion-level failure (thrown error) is reported without crashing and without a secret ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  companion.scripts.testJevToolsCapability = () => {
    throw new ProviderErrorLike("NETWORK_ERROR", "companion unreachable");
  };
  const result = await c.testJevToolsConnection();
  ok(result.ok === false, "a thrown error is reported not-ok, never left pending");
  ok(c.getState().jevToolsTest.status === "fail" && c.getState().jevToolsTest.errors.connection.code === "NETWORK_ERROR",
    "the transient failure still lands in state.jevToolsTest as fail, classified");
  ok(c.getState().testingJevTools === false, "the in-flight flag clears even on failure");
}

console.log("== Jev-tools connection test: a saved config change invalidates the prior result ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  companion.scripts.testJevToolsCapability = () => ({
    status: "pass",
    tools: { extract_page: true, browser_subgoal: false },
    capabilities: { textModel: "pass", systemone: "not_run" },
    errors: {},
    timestamp: "2026-01-01T00:00:00.000Z"
  });
  await c.testJevToolsConnection();
  ok(c.getState().jevToolsTest !== null, "sanity: a result is recorded");

  await c.saveJevTools({});
  ok(c.getState().jevToolsTest === null, "saving a new Jev-tools config must invalidate the previous test result — a stale pass must not linger");
}

// --- jev-subgoal-screenshots-default-off: the Jev-tools screenshot toggle --
//
// #jevtools-send-screenshots. This section's toggle controls only whether a
// browser_subgoal sub-run captures a screenshot, is OFF by default, and
// persists through the saveJevTools()/set_typesafe_config path as every
// other field in this file.

console.log("== Jev-tools screenshot toggle: defaults to false (unchecked) when the profile never touched it ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().jevToolsSendScreenshots === false, "a profile stored before the toggle existed loads with it disabled — the documented default");
}

console.log("== Jev-tools screenshot toggle: an explicitly stored true loads as on ==");
{
  const companion = createScriptedCompanion(anthropicProfile({ jevToolsSendScreenshots: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().jevToolsSendScreenshots === true, "an explicitly stored true loads as on — the stored value is never overridden by the default");
}

console.log("== Jev-tools screenshot toggle: setJevToolsSendScreenshots() flips local state without touching the wire ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  const result = c.setJevToolsSendScreenshots(true);
  ok(result.ok === true, "the setter reports ok");
  ok(c.getState().jevToolsSendScreenshots === true, "the toggle flips in local state immediately");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "flipping the local toggle alone never reaches the wire — only saveJevTools() persists it");
}

console.log("== Jev-tools screenshot toggle: saveJevTools() persists it via the existing set_typesafe_config envelope ==");
{
  const companion = createScriptedCompanion(anthropicProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  c.setJevToolsSendScreenshots(true);

  const result = await c.saveJevTools({});
  ok(result.ok === true, "the save succeeds");

  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && configCall.jevToolsSendScreenshots === true,
    `jevToolsSendScreenshots rides the existing set_typesafe_config op — got ${JSON.stringify(configCall)}`);
  ok(!("sendScreenshots" in configCall), "the removed standalone provider's own sendScreenshots field is never sent by this section's own save");

  const s = c.getState();
  ok(s.jevToolsSendScreenshots === true, "the companion's echoed profile reflects the saved toggle");
  ok(s.baseUrl === "https://api.anthropic.com" && s.baseUrlDraft === "https://api.anthropic.com",
    "the profile's primary Anthropic Base URL config is completely untouched by this section's save");
}

console.log("== Jev-tools screenshot toggle: unchecking and saving persists false, and a fresh load reads it back ==");
{
  const companion = createScriptedCompanion(anthropicProfile({ jevToolsSendScreenshots: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().jevToolsSendScreenshots === true, "sanity: starts on");

  c.setJevToolsSendScreenshots(false);
  await c.saveJevTools({});

  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall.jevToolsSendScreenshots === false, "unchecking sends an explicit false, not an omission");
  ok(c.getState().jevToolsSendScreenshots === false, "state reflects off after the save");

  const reloaded = new SettingsController(companion.client);
  await reloaded.init();
  ok(reloaded.getState().jevToolsSendScreenshots === false, "a fresh load of the same profile reads the persisted off value back");
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}`);
if (fail > 0) process.exit(1);

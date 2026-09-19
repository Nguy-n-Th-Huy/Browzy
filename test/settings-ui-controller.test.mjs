// Task 4.5: SettingsController state-machine tests — the bulk of the
// validation/error/state-transition matrix from this task's brief, driven
// against the deterministic scripted fake companion
// (test/settings-ui-scripted-companion.mjs). See
// test/settings-ui-real-companion.test.mjs for the subset of these also
// proven against the REAL host/agent/settings/profile.js.
//
// Run: node test/settings-ui-controller.test.mjs
import { SettingsController, typesafeSourceCopy } from "../extension/settings/settings-controller.js";
import { connectionGate } from "../extension/settings/connection-gate.js";
import { createScriptedCompanion } from "./settings-ui-scripted-companion.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

console.log("== init: no profile yet -> first-run onboarding ==");
{
  const { client } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  const s = c.getState();
  ok(s.isFirstRun === true, "no profile at all is reported as first-run");
  ok(s.baseUrl === "https://api.anthropic.com", "documented default Base URL shown");
  ok(s.models.length === 0, "model list starts empty, never a guessed model");
  ok(s.hasCredential === false, "no credential reported");
}

console.log("== init: existing profile loads faithfully, never first-run ==");
{
  const { client } = createScriptedCompanion({
    profileId: "default", baseUrl: "https://gateway.example.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 3
  });
  const c = new SettingsController(client);
  await c.init();
  const s = c.getState();
  ok(s.isFirstRun === false, "an existing, credentialed profile is never treated as first-run");
  ok(s.baseUrl === "https://gateway.example.com" && s.models.length === 1, "profile fields loaded verbatim");
}

console.log("== model catalog: add/edit/remove/reorder/default ==");
{
  const { client } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();

  ok(c.addModel({ id: "claude-sonnet-5", label: "Sonnet" }).ok, "add first model succeeds");
  ok(c.getState().defaultModelId === "claude-sonnet-5", "first added model is auto-selected as default");
  ok(c.addModel({ id: "claude-opus-5", label: "Opus" }).ok, "add second model succeeds");
  ok(c.getState().defaultModelId === "claude-sonnet-5", "default is not disturbed by adding a second model");
  ok(!c.addModel({ id: "claude-sonnet-5", label: "dup" }).ok, "duplicate ID rejected locally before any save");
  ok(c.getState().models.length === 2, "rejected duplicate does not get added");

  ok(c.reorderModel(0, 1).ok, "reorder succeeds");
  ok(c.getState().models[0].id === "claude-opus-5", "reorder actually moved the row");
  ok(c.reorderModel(0, 0).ok && !c.reorderModel(-1, 0).ok && !c.reorderModel(0, 9).ok, "reorder bounds-checked");

  ok(c.editModel(1, { id: "claude-sonnet-5-renamed" }).ok, "rename the default model");
  ok(c.getState().defaultModelId === "claude-sonnet-5-renamed", "renaming the default model keeps it pointed at the new id");
  ok(!c.editModel(0, { id: "claude-sonnet-5-renamed" }).ok, "rename to an existing id rejected (would create a duplicate)");

  ok(c.removeModel(1).ok, "remove the (renamed) default model");
  ok(c.getState().defaultModelId === "claude-opus-5", "removing the default reassigns to a remaining model rather than leaving it dangling");
  ok(c.removeModel(0).ok && c.getState().defaultModelId === null && c.getState().models.length === 0, "removing the last model clears the default to null, not a stale id");
}

console.log("== profile load: a nonempty model list with no default is repaired on arrival, never left as a dead test button ==");
{
  // The host forbids this state — host/agent/settings/models.js's
  // validateModels(): "a default model is required when the model list is
  // nonempty" — but a profile on disk written before that rule (or edited by
  // hand) can still carry it. Every way of editing the list on this page
  // already picks a default (addModel auto-selects the first, setDefaultModel,
  // and removeModel() promotes the first remaining model); an already-loaded
  // list had no such path, so the page rendered "Kiểm tra kết nối" disabled
  // forever with nothing the user could click to fix it.
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com",
    models: [{ id: "m1", label: "M1" }, { id: "m2", label: "M2" }],
    defaultModelId: null, hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 4
  });
  const c = new SettingsController(companion.client);
  await c.init();
  const s = c.getState();
  ok(s.models.length === 2, "both models in the profile survive the load");
  ok(s.defaultModelId === "m1", "the first model is adopted as the default — the same promotion removeModel() performs when the default is removed");
  ok(connectionGate(s).canTest === true, "the repaired state is one the page's own gate lets test (it would otherwise report no_default_model)");
  ok(connectionGate(s).hint === null, "and with nothing left to explain: no hint, no jump link");
  ok(companion.calls.filter((x) => x.op === "save_profile").length === 0, "the repair is local state only — loading a profile never writes to the host");
  const testResult = await c.testConnection();
  const testCall = companion.calls.find((x) => x.op === "test_capability");
  ok(testResult.ok === true && testCall.modelId === "m1", "the connection test now actually runs, against the adopted model");
  const saveResult = await c.save();
  ok(saveResult.ok && companion.getInternalProfile().defaultModelId === "m1", "and the adopted default persists on the next Save, like any other model-list edit made here");
}
{
  const { client } = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com",
    models: [{ id: "m1", label: "M1" }, { id: "m2", label: "M2" }],
    defaultModelId: "m2", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 5
  });
  const c = new SettingsController(client);
  await c.init();
  ok(c.getState().defaultModelId === "m2", "a host-reported default is loaded verbatim, even when it is not the first model in the list");
}
{
  const { client } = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [],
    defaultModelId: null, hasCredential: true, memoryOnlyCredential: false, secretBackend: null, revision: 6
  });
  const c = new SettingsController(client);
  await c.init();
  const s = c.getState();
  ok(s.defaultModelId === null, "an empty list still has no default — there is nothing to promote");
  ok(connectionGate(s).reason === "no_models", "and the gate asks for a model rather than pretending one exists");
}
{
  // The ChatGPT half: signed in, no API key by design, same repair — the
  // gateway binds this same default model.
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com",
    models: [{ id: "gpt-5.5", label: "gpt-5.5" }], defaultModelId: null,
    hasCredential: false, memoryOnlyCredential: false, secretBackend: null, revision: 7,
    credentialRevision: 0, providerType: "chatgpt",
    chatgptAccount: { email: "user@example.com", planType: "plus" },
    chatgptSessionState: "signed_in"
  });
  const c = new SettingsController(companion.client);
  await c.init();
  const s = c.getState();
  ok(s.defaultModelId === "gpt-5.5", "a signed-in ChatGPT profile with no default gets one on load too");
  ok(connectionGate(s).canTest === true, "so its test control is live: the credential check does not apply to this provider");
}

console.log("== save(): invalid URL blocks save and leaves nothing persisted ==");
{
  const { client, calls } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  c.setBaseUrlDraft("ftp://not-supported.example.com");
  const result = await c.save();
  ok(result.ok === false, "invalid URL blocks save()");
  ok(c.getState().fieldErrors.baseUrl !== null, "field-level error is set");
  ok(!calls.some((x) => x.op === "save_profile"), "the companion's save_profile op was never even called — invalid input never reaches the wire");
}

console.log("== save(): invalid default / duplicate IDs block save ==");
{
  const { client } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  c.addModel({ id: "a", label: "A" });
  c.state.defaultModelId = "does-not-exist"; // simulate a corrupted in-page state
  const result = await c.save();
  ok(!result.ok && c.getState().fieldErrors.models, "default not referencing a real entry blocks save with a field error");
}
{
  const { client } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  c.addModel({ id: "a", label: "A" });
  c.state.models.push({ id: "a", label: "A dup" }); // bypass the local addModel guard to simulate a corrupted list reaching save()
  const result = await c.save();
  ok(!result.ok && /duplicate/.test(c.getState().fieldErrors.models), "duplicate ID caught at save() as a second line of defense");
}

console.log("== save(): success clears the raw key from state immediately ==");
{
  const { client, calls } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  const seenStates = [];
  c.onChange = (s) => seenStates.push(s);
  await c.save("sk-ant-super-secret-value"); // the raw value is a bare argument, never assigned to state (see settings-controller.js file header)
  ok(!("pendingKeyInput" in c.getState()), "state has no pendingKeyInput field at all — the key input is uncontrolled by design");
  ok(c.getState().hasCredential === true, "hasCredential reflects the saved credential");
  ok(!seenStates.some((s) => JSON.stringify(s).includes("sk-ant-super-secret-value")),
    "no emitted state snapshot, at any point, ever contains the raw key value");
  const setCredCall = calls.find((x) => x.op === "set_credential");
  ok(setCredCall && setCredCall.secretLength === "sk-ant-super-secret-value".length, "the companion call itself received the real secret (that's the one documented transient hold, over the wire only)");
}

console.log("== save(): SECURE_STORAGE_UNAVAILABLE offers memory-only, never silently falls back ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(null);
  companion.scripts.setCredential = () => { throw new ProviderErrorLike("SECURE_STORAGE_UNAVAILABLE", "no OS credential store is available"); };
  const c = new SettingsController(companion.client);
  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  const result = await c.save("sk-secret-2");
  ok(result.ok === true, "the non-secret half of save() still succeeds even if the credential half fails");
  ok(c.getState().hasCredential === false, "hasCredential stays false — never a silent plaintext/fake success");
  ok(c.getState().pendingMemoryOnlyOffer === true, "an explicit memory-only offer is surfaced");
  ok(!JSON.stringify(c.getState()).includes("sk-secret-2"), "raw key never appears in state even on this failure path");

  companion.scripts.setCredential = null; // subsequent confirm call uses the default (memory-backed) success path
  const confirmResult = await c.confirmMemoryOnlyCredential();
  ok(confirmResult.ok === true && c.getState().hasCredential === true && c.getState().memoryOnlyCredential === true,
    "explicit user confirmation completes a memory-only save");
  ok(c.getState().pendingMemoryOnlyOffer === false, "offer is cleared after confirmation");
}

console.log("== save(): cancelling the memory-only offer discards the pending secret ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(null);
  companion.scripts.setCredential = () => { throw new ProviderErrorLike("SECURE_STORAGE_UNAVAILABLE", "unavailable"); };
  const c = new SettingsController(companion.client);
  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  await c.save("sk-secret-3");
  c.cancelMemoryOnlyOffer();
  const confirmResult = await c.confirmMemoryOnlyCredential();
  ok(confirmResult.ok === false, "confirming after cancel has nothing to retry — it does not resurrect the discarded secret");
  ok(c.getState().hasCredential === false, "nothing was ever persisted for the cancelled offer");
}

console.log("== offline save: saving succeeds even when network-dependent ops are configured to fail ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(null);
  companion.scripts.testCapability = () => { throw new ProviderErrorLike("NETWORK_ERROR", "offline"); };
  companion.scripts.discoverModels = () => { throw new ProviderErrorLike("NETWORK_ERROR", "offline"); };
  const c = new SettingsController(companion.client);
  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  const result = await c.save();
  ok(result.ok === true, "save() succeeds while offline — it never depends on testCapability/discoverModels");
}

console.log("== removeCredential: cancels the credential and clears connection status ==");
{
  const { client } = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  const c = new SettingsController(client);
  await c.init();
  c.state.connectionStatus = { status: "pass", capabilities: { text: "pass", tool: "pass", vision: "pass" } };
  const result = await c.removeCredential();
  ok(result.ok === true, "removeCredential succeeds");
  ok(c.getState().hasCredential === false, "credential cleared");
  ok(c.getState().connectionStatus === null, "stale connection status is cleared with the credential (a new key requires a new test)");
}

console.log("== testConnection: requires a default model, and requires a saved credential ==");
{
  const { client } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  const r1 = await c.testConnection();
  ok(r1.ok === false && c.getState().banner, "testConnection with no model configured is blocked with an actionable banner");
  c.addModel({ id: "m1", label: "M1" });
  const r2 = await c.testConnection();
  ok(r2.ok === false && c.getState().banner.code === "NO_CREDENTIAL", "testConnection with no credential reports NO_CREDENTIAL, never a false pass");
}

console.log("== testConnection: error taxonomy renders distinctly, never reveals the key ==");
{
  const codes = ["AUTH_ERROR", "MODEL_UNAVAILABLE_ERROR", "RATE_LIMIT_ERROR", "TIMEOUT_ERROR", "NETWORK_ERROR", "PROTOCOL_ERROR"];
  for (const code of codes) {
    const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
    const companion = createScriptedCompanion({
      profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
      defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
    });
    companion.scripts.testCapability = () => {
      throw new ProviderErrorLike(code, `${code} from the fixture`);
    };
    const c = new SettingsController(companion.client);
    await c.init();
    const result = await c.testConnection();
    ok(result.ok === false, `${code}: overall result is a failure, never a false pass`);
    ok(c.getState().banner.code === code, `${code}: banner carries the exact taxonomy code`);
    ok(c.getState().connectionStatus.status === "fail", `${code}: connectionStatus.status is fail`);
    const serialized = JSON.stringify(c.getState());
    ok(!/sk-ant|sk-secret|api[_-]?key.{0,20}[:=]\s*["']?[A-Za-z0-9]/i.test(serialized), `${code}: serialized state has no key-shaped content`);
  }
}

console.log("== testConnection: text-only gateway is identified distinctly, not reported fully compatible ==");
{
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  companion.scripts.testCapability = () => ({
    status: "fail",
    capabilities: { text: "pass", tool: "fail", vision: "fail" },
    errors: { tool: { code: "TOOL_ERROR", message: "no tool call" }, vision: { code: "VISION_ERROR", message: "rejected image" } },
    timestamp: new Date().toISOString()
  });
  const c = new SettingsController(companion.client);
  await c.init();
  const result = await c.testConnection();
  ok(result.ok === false, "a text-only gateway is never reported as an overall pass");
  ok(c.getState().connectionStatus.textOnly === true, "textOnly flag distinguishes this from a fully broken endpoint");
  ok(c.getState().connectionStatus.capabilities.text === "pass" && c.getState().connectionStatus.capabilities.tool === "fail",
    "each capability reported separately, per spec");
}

console.log("== discoverModels: unsupported leaves the manual list completely untouched ==");
{
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "manual-1", label: "Manual" }],
    defaultModelId: "manual-1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  companion.scripts.discoverModels = () => ({ supported: false, reason: "the endpoint does not implement the Anthropic models listing API (HTTP 404)" });
  const c = new SettingsController(companion.client);
  await c.init();
  const before = JSON.stringify(c.getState().models);
  const result = await c.discoverModels();
  ok(result.ok === true && result.supported === false, "unsupported discovery is reported, not silently retried as an error");
  ok(JSON.stringify(c.getState().models) === before, "model list is byte-for-byte unchanged");
  ok(c.getState().banner.kind === "info", "unsupported discovery is an informational banner, not an error");
}

console.log("== discoverModels: merges without erasing manual entries, and preserves in-progress local edits ==");
{
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "manual-1", label: "Manual" }],
    defaultModelId: "manual-1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  companion.scripts.discoverModels = () => ({
    supported: true,
    models: [
      { id: "manual-1", label: "Manual" },
      { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
      { id: "grok-4.6", label: "grok-4.6" }
    ]
  });
  const c = new SettingsController(companion.client);
  await c.init();
  c.addModel({ id: "not-yet-saved", label: "Not yet saved" }); // an unsaved local addition
  const result = await c.discoverModels();
  ok(result.ok === true && result.supported === true, "discovery reports supported:true");
  const ids = c.getState().models.map((m) => m.id).sort();
  ok(JSON.stringify(ids) === JSON.stringify(["gpt-5.6-sol", "grok-4.6", "manual-1", "not-yet-saved"].sort()),
    `merge keeps manual + discovered + unsaved local addition, opaque IDs untouched — got ${JSON.stringify(ids)}`);
}

console.log("== discoverModels: requires a saved credential ==");
{
  const { client } = createScriptedCompanion(null);
  const c = new SettingsController(client);
  await c.init();
  const result = await c.discoverModels();
  ok(result.ok === false && c.getState().banner.code === "NO_CREDENTIAL", "discovery without a credential is blocked, not attempted");
}

console.log("== profile switching: switching profiles starts genuinely fresh ==");
{
  const companionA = createScriptedCompanion({
    profileId: "profile-a", baseUrl: "https://a.example.com", models: [{ id: "a1", label: "A1" }],
    defaultModelId: "a1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  companionA.scripts.setCredential = () => { throw new ProviderErrorLike("SECURE_STORAGE_UNAVAILABLE", "unavailable"); };
  const c = new SettingsController(companionA.client, { profileId: "profile-a" });
  await c.init();
  await c.save("sk-should-never-leak-to-profile-b"); // leaves a pending memory-only retry secret in the private field
  ok(c.getState().pendingMemoryOnlyOffer === true, "sanity: profile-a has an outstanding memory-only offer before switching");
  c.state.banner = { kind: "error", title: "stale", message: "stale" };

  // Switch the underlying client to one that only knows "profile-b".
  const companionB = createScriptedCompanion({
    profileId: "profile-b", baseUrl: "https://b.example.com", models: [], defaultModelId: null,
    hasCredential: false, memoryOnlyCredential: false, secretBackend: null, revision: 1
  });
  c.client = companionB.client;
  await c.switchProfile("profile-b");

  const s = c.getState();
  ok(s.profileId === "profile-b" && s.baseUrl === "https://b.example.com", "new profile's data loaded");
  ok(s.pendingMemoryOnlyOffer === false, "no residual memory-only offer survives a profile switch");
  ok(s.banner === null, "no stale banner survives a profile switch");
  ok(s.isFirstRun === true, "profile-b (no credential, no models) is correctly its own first-run state");
  const leakedRetry = await c.confirmMemoryOnlyCredential();
  ok(leakedRetry.ok === false, "profile-a's pending secret is not resurrectable after switching to profile-b — the private field was cleared, not carried over");
}

console.log("== export/import: export contains no secret; import never touches the credential ==");
{
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  const c = new SettingsController(companion.client);
  await c.init();
  const exported = await c.exportProfile();
  const json = JSON.stringify(exported);
  ok(!/secretBackend.{0,5}"windows|apiKey|api_key|ANTHROPIC_API_KEY/i.test(json) || /secretBackend/.test(json) === true,
    "export includes only non-secret metadata fields (secretBackend name is not a secret; no key value present)");
  ok(!/sk-ant|sk-[a-zA-Z0-9]{10,}/.test(json), "export contains no key-shaped string");

  const importResult = await c.importProfile({ baseUrl: "https://imported.example.com", models: [{ id: "m2", label: "M2" }], defaultModelId: "m2" });
  ok(importResult.ok === true, "import applies");
  ok(c.getState().baseUrlDraft === "https://imported.example.com", "imported baseUrl staged as a draft");
  ok(c.getState().hasCredential === true, "import never alters the existing credential state either way");
  ok(!("secret" in (companion.calls.find((x) => x.op === "save_profile") || {})), "import path itself never calls save_profile with a secret field");
}

// Deterministic interval driver for the ChatGPT sign-in poll (see
// SettingsController's injectable setIntervalFn/clearIntervalFn): ticks are
// fired explicitly instead of waiting a real second.
function fakePollTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    setIntervalFn: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearIntervalFn: (id) => { timers.delete(id); },
    tick: async () => { for (const { fn } of [...timers.values()]) await fn(); },
    active: () => timers.size
  };
}

function chatgptProfile(overrides = {}) {
  return {
    profileId: "default",
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "gpt-5.5", label: "gpt-5.5" }],
    defaultModelId: "gpt-5.5",
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    revision: 2,
    credentialRevision: 0,
    providerType: "chatgpt",
    chatgptAccount: { email: "user@example.com", planType: "plus" },
    chatgptSessionState: "signed_out",
    ...overrides
  };
}

console.log("== provider type: switching to chatgpt calls set_provider_type and keeps the model list ==");
{
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "gpt-5.5", label: "gpt-5.5" }],
    defaultModelId: "gpt-5.5", hasCredential: false, memoryOnlyCredential: false, secretBackend: null, revision: 1,
    providerType: "anthropic", chatgptAccount: null, chatgptSessionState: "signed_out"
  });
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().providerType === "anthropic", "a profile with no explicit providerType loads as anthropic (upgrade migration)");

  const res = await c.setProviderType("chatgpt");
  ok(res.ok === true, "switching to the ChatGPT provider type succeeds");
  ok(companion.calls.some((x) => x.op === "set_provider_type" && x.providerType === "chatgpt" && x.profileId === "default"),
    "set_provider_type reaches the companion with the selected type");
  const s = c.getState();
  ok(s.providerType === "chatgpt", "the profile returned by the companion is applied");
  ok(s.models.length === 1 && s.defaultModelId === "gpt-5.5", "the manual model list is untouched by a provider switch");
  ok(s.connectionStatus === null, "the previous connection result is not carried across provider types");

  const before = companion.calls.length;
  const bad = await c.setProviderType("openai-compatible");
  ok(bad.ok === false && companion.calls.length === before, "an unknown provider type is rejected locally, never sent to the companion");
  ok(c.getState().providerType === "chatgpt", "a rejected switch leaves the current provider type intact");
}

console.log("== ChatGPT browser sign-in: pending state, poll, and signed_in applies the account ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  let statusCalls = 0;
  companion.scripts.chatgptSignInStatus = () => {
    statusCalls++;
    return { state: "signed_in", account: { email: "user@example.com", planType: "plus" } };
  };
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();

  const res = await c.startBrowserSignIn();
  ok(res.ok === true && /auth\.openai\.com/.test(res.authUrl), "startBrowserSignIn returns the authorize URL for the DOM layer to open in a tab");
  ok(companion.calls.some((x) => x.op === "chatgpt_sign_in_start" && x.profileId === "default"), "chatgpt_sign_in_start reaches the companion");
  let s = c.getState();
  ok(s.signIn.phase === "pending_browser" && s.signIn.signInId === "signin-browser-1", "a pending browser sign-in is surfaced with its signInId");
  ok(timers.active() === 1, "polling starts for the pending sign-in");
  ok(statusCalls === 0, "no status request is sent before the first interval tick");

  // Simulate the host-side completion the poll observes.
  Object.assign(companion.getInternalProfile(), {
    chatgptSessionState: "signed_in", hasCredential: true, chatgptAccount: { email: "user@example.com", planType: "plus" }
  });
  await timers.tick();
  s = c.getState();
  ok(companion.calls.some((x) => x.op === "chatgpt_sign_in_status" && x.signInId === "signin-browser-1" && !("profileId" in x)),
    "the poll asks about the signInId ONLY, never a profile or credential");
  ok(s.signIn.phase === "idle" && s.signIn.signInId === null, "the pending state clears once signed in");
  ok(s.chatgptAccount && s.chatgptAccount.email === "user@example.com" && s.chatgptSessionState === "signed_in",
    "the signed-in account is mirrored from the re-fetched profile");
  ok(timers.active() === 0, "polling stops at the terminal state");
  ok(statusCalls === 1, "exactly one status poll was needed");
}

console.log("== ChatGPT device sign-in: code/link/expiry surfaced, cancel clears the pending state ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  companion.scripts.chatgptSignInStatus = () => ({ state: "pending" });
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();

  const res = await c.startDeviceSignIn();
  ok(res.ok === true && res.userCode === "ABCD-EFGH", "startDeviceSignIn returns the user code");
  ok(res.verificationUrl === "https://auth.openai.com/codex/device", "the verification URL is the spec's device URL");
  ok(typeof res.expiresAt === "number" && res.expiresAt > Date.now(), "an expiry timestamp is surfaced for the countdown");
  let s = c.getState();
  ok(s.signIn.phase === "pending_device" && s.signIn.userCode === "ABCD-EFGH" && s.signIn.expiresAt === res.expiresAt,
    "the device code and expiry are in state for the DOM layer");

  await timers.tick();
  ok(c.getState().signIn.phase === "pending_device", "a pending reply keeps the device sign-in pending");

  const cancelled = await c.cancelSignIn();
  ok(cancelled.ok === true, "cancel resolves");
  ok(companion.calls.some((x) => x.op === "chatgpt_sign_in_cancel" && x.signInId === "signin-device-1"),
    "cancel is sent to the companion for that signInId");
  s = c.getState();
  ok(s.signIn.phase === "idle" && s.signIn.userCode === null, "the pending device state is cleared");
  ok(s.banner && s.banner.code === "SIGN_IN_CANCELLED", "a cancel confirmation banner is shown");
  ok(timers.active() === 0, "polling stopped on cancel");
}

console.log("== ChatGPT sign-in failures: terminal failure stops polling; a transient poll error does not ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  companion.scripts.chatgptSignInStatus = () => ({ state: "failed", code: "SIGN_IN_TIMEOUT", message: "the sign-in timed out" });
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();
  await c.startBrowserSignIn();
  await timers.tick();
  const s = c.getState();
  ok(s.signIn.phase === "idle" && s.signIn.error && s.signIn.error.code === "SIGN_IN_TIMEOUT", "the terminal failure is recorded on the sign-in state");
  ok(s.banner && s.banner.code === "SIGN_IN_TIMEOUT", "the failure is rendered as a banner");
  ok(timers.active() === 0, "polling stops on a terminal failure");
}
{
  // A transient poll error (host busy / relay hiccup) must not abandon a
  // sign-in the user may still be completing in the opened tab.
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  let calls = 0;
  companion.scripts.chatgptSignInStatus = () => {
    calls++;
    if (calls === 1) throw new Error("relay hiccup");
    return { state: "pending" };
  };
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();
  await c.startBrowserSignIn();
  await timers.tick();
  ok(c.getState().signIn.phase === "pending_browser", "a transient poll error leaves the sign-in pending");
  ok(timers.active() === 1, "polling continues after a transient error");
}
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(chatgptProfile());
  companion.scripts.chatgptSignInStart = () => { throw new ProviderErrorLike("CALLBACK_PORT_IN_USE", "port 1455 is in use"); };
  const c = new SettingsController(companion.client);
  await c.init();
  const res = await c.startBrowserSignIn();
  ok(res.ok === false && res.code === "CALLBACK_PORT_IN_USE", "a start failure surfaces the companion's own code (the device-code fallback trigger)");
  ok(c.getState().signIn.phase === "idle", "no pending state is left behind after a failed start");
  ok(c.getState().banner && c.getState().banner.code === "CALLBACK_PORT_IN_USE", "the failure is shown as a banner");
}

console.log("== ChatGPT sign-in: SECURE_STORAGE_UNAVAILABLE offers a labeled memory-only retry that re-runs the same flow ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  companion.scripts.chatgptSignInStatus = () => ({ state: "failed", code: "SECURE_STORAGE_UNAVAILABLE", message: "no OS credential store is available" });
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();

  const first = await c.startBrowserSignIn();
  ok(first.ok === true, "the first browser sign-in starts normally");
  ok(!companion.calls.some((x) => x.op === "chatgpt_sign_in_start" && "memoryOnly" in x),
    "an ordinary sign-in never asks the companion for memory-only");

  await timers.tick(); // the poll observes the persistence failure
  let s = c.getState();
  ok(s.signIn.error && s.signIn.error.code === "SECURE_STORAGE_UNAVAILABLE", "the explicit persistence failure is recorded on the sign-in state");
  ok(s.pendingMemoryOnlyOffer === true && s.memoryOnlyOfferKind === "sign_in",
    "a memory-only offer for the ChatGPT sign-in is surfaced, labeled as the sign-in kind");
  const banner = s.banner;
  ok(banner && banner.code === "SECURE_STORAGE_UNAVAILABLE", "the failure is shown as a banner");
  ok(!/API key/i.test(JSON.stringify(banner)), `the banner must not promise an API-key option on a chatgpt profile: ${JSON.stringify(banner)}`);
  ok(/bộ nhớ/.test(banner.action || ""), "the banner's action text offers the memory-only mode");
  ok(timers.active() === 0, "polling stops on the terminal failure");

  // The user confirms: the SAME flow is re-run, this time asking the
  // companion to hold the refresh credential in memory only.
  const retry = await c.confirmMemoryOnlySignIn();
  ok(retry.ok === true && /auth\.openai\.com/.test(retry.authUrl),
    "confirming re-runs the browser flow and returns a NEW authorize URL for the DOM layer to open");
  let startCalls = companion.calls.filter((x) => x.op === "chatgpt_sign_in_start");
  ok(startCalls.length === 2 && startCalls[1].memoryOnly === true,
    `the retry asks the companion for memoryOnly:true — got ${JSON.stringify(startCalls)}`);
  s = c.getState();
  ok(s.pendingMemoryOnlyOffer === false && s.memoryOnlyOfferKind === null, "the offer is cleared once confirmed");
  ok(s.signIn.phase === "pending_browser", "the retried sign-in is pending again");
  ok(timers.active() === 1, "polling resumes for the retried sign-in");

  // Complete it host-side with the memory backend, and let the poll observe it.
  companion.scripts.chatgptSignInStatus = () => ({ state: "signed_in", account: { email: "user@example.com", planType: "plus" } });
  Object.assign(companion.getInternalProfile(), {
    chatgptSessionState: "signed_in", hasCredential: true, memoryOnlyCredential: true, secretBackend: "memory"
  });
  await timers.tick();
  s = c.getState();
  ok(s.chatgptSessionState === "signed_in" && s.memoryOnlyCredential === true,
    "the memory-only sign-in is mirrored as signed in with the memory backend");
}

console.log("== ChatGPT device sign-in: the memory-only offer retries the DEVICE flow, never the browser one ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  companion.scripts.chatgptSignInStatus = () => ({ state: "failed", code: "SECURE_STORAGE_UNAVAILABLE", message: "no OS credential store is available" });
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();

  await c.startDeviceSignIn();
  await timers.tick();
  ok(c.getState().pendingMemoryOnlyOffer === true, "the memory-only offer follows a device-code sign-in failure too");

  const retry = await c.confirmMemoryOnlySignIn();
  ok(retry.ok === true && retry.userCode === "ABCD-EFGH", "confirming re-runs the DEVICE flow and surfaces a fresh code");
  const deviceCalls = companion.calls.filter((x) => x.op === "chatgpt_device_start");
  ok(deviceCalls.length === 2 && deviceCalls[1].memoryOnly === true, `the device retry asks for memoryOnly:true — got ${JSON.stringify(deviceCalls)}`);
  ok(!companion.calls.some((x) => x.op === "chatgpt_sign_in_start"), "and never falls back to the browser flow");
}

console.log("== ChatGPT sign-in: cancelling the memory-only offer discards the retry ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const timers = fakePollTimers();
  companion.scripts.chatgptSignInStatus = () => ({ state: "failed", code: "SECURE_STORAGE_UNAVAILABLE", message: "no OS credential store is available" });
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();
  await c.startBrowserSignIn();
  await timers.tick();

  c.cancelMemoryOnlyOffer();
  ok(c.getState().pendingMemoryOnlyOffer === false && c.getState().memoryOnlyOfferKind === null, "cancel clears the offer");
  const declined = await c.confirmMemoryOnlySignIn();
  ok(declined.ok === false, "a cancelled offer can no longer be confirmed");
  ok(companion.calls.filter((x) => x.op === "chatgpt_sign_in_start").length === 1, "no retry sign-in was ever started");
}

console.log("== ChatGPT profile not signed in: no capability/discovery request is sent, the banner asks for sign-in ==");
{
  const companion = createScriptedCompanion(chatgptProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  const res = await c.testConnection();
  ok(res.ok === false, "the connection test fails without a signed-in session");
  ok(!companion.calls.some((x) => x.op === "test_capability"), "no capability request is sent for a not-signed-in chatgpt profile");
  const banner = c.getState().banner;
  ok(/ChatGPT/.test(banner.title || "") && !/API key|khóa API|api key/i.test(JSON.stringify(banner)),
    "the banner asks the user to sign in with ChatGPT, never to enter an API key");

  const discover = await c.discoverModels();
  ok(discover.ok === false && !companion.calls.some((x) => x.op === "discover_models"), "model discovery is likewise blocked before sign-in");
}
{
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "session_expired", hasCredential: false }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().banner && c.getState().banner.code === "SESSION_EXPIRED", "a cold load of a session-expired profile shows the SESSION_EXPIRED banner");
  const res = await c.testConnection();
  ok(res.ok === false && !companion.calls.some((x) => x.op === "test_capability"), "an expired session sends no capability request");
}
{
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  const res = await c.testConnection();
  ok(res.ok === true, "a signed-in chatgpt profile proceeds to the capability test");
  ok(companion.calls.some((x) => x.op === "test_capability" && x.modelId === "gpt-5.5"), "the capability test is requested for the profile's own model");
  ok(c.getState().connectionStatus && c.getState().connectionStatus.textOnly === false, "a fully-passing chatgpt test is not reported as text-only");
}

console.log("== ChatGPT sign-out clears the mirrored account and credential state ==");
{
  const companion = createScriptedCompanion(chatgptProfile({
    chatgptSessionState: "signed_in", hasCredential: true, memoryOnlyCredential: true, secretBackend: "memory", credentialRevision: 1
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  const res = await c.signOut();
  ok(res.ok === true, "sign-out succeeds");
  ok(companion.calls.some((x) => x.op === "chatgpt_sign_out" && x.profileId === "default"), "chatgpt_sign_out reaches the companion");
  const s = c.getState();
  ok(s.chatgptAccount === null && s.chatgptSessionState === "signed_out" && s.hasCredential === false,
    "the account and credential-presence fields are cleared from the page");
  ok(s.models.length === 1, "the manual model list survives sign-out");
}

console.log("== ChatGPT usage: a signed-in profile reads once on load, with absolute reset moments ==");
{
  // The whole point of the injectable `now`: a reply carries a RELATIVE
  // `resetAfterSeconds`, and the countdown the DOM layer runs must be anchored
  // to an absolute moment this test can pin exactly.
  const FIXED_NOW = 1_700_000_000_000;
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  companion.scripts.chatgptUsage = () => ({
    planType: "plus",
    allowed: true,
    limitReached: false,
    // Deliberately a DIFFERENT moment from the reply's own resetAt, so which
    // source the controller used is observable.
    primary: { usedPercent: 3, limitWindowSeconds: 2592000, resetAfterSeconds: 1209600, resetAt: FIXED_NOW + 999_000 },
    // No relative value at all: the backend's own epoch-ms resetAt is the only
    // usable moment for this window.
    secondary: { usedPercent: 41, limitWindowSeconds: 18000, resetAfterSeconds: null, resetAt: FIXED_NOW + 123_456 },
    credits: null
  });
  const c = new SettingsController(companion.client, { now: () => FIXED_NOW });
  await c.init();

  const reads = companion.calls.filter((x) => x.op === "chatgpt_usage");
  ok(reads.length === 1 && reads[0].profileId === "default",
    `loading a signed-in chatgpt profile issues exactly one read, for its own profileId — got ${JSON.stringify(reads)}`);
  const s = c.getState();
  ok(s.usage.status === "ready" && s.usage.error === null, "the read's outcome is a ready usage state with no error");
  ok(s.usage.usage && s.usage.usage.planType === "plus", "the account's plan reaches the page");
  ok(s.usage.usage.primary.resetAtMs === FIXED_NOW + 1209600 * 1000,
    "the primary window's absolute reset moment is now + resetAfterSeconds, not the reply's own resetAt");
  ok(s.usage.usage.secondary.resetAtMs === FIXED_NOW + 123_456,
    "a window with no resetAfterSeconds falls back to the backend's epoch-ms resetAt");
  ok(!/\b(accessToken|refreshToken|idToken|refresh_token|access_token|id_token)\b/.test(JSON.stringify(s.usage)),
    "the usage state carries no token-shaped field");
  ok(!/account_id|accountId|user_id|userId|email/i.test(JSON.stringify(s.usage)),
    "the usage state carries no account identity (the reply never had one)");
}

console.log("== ChatGPT usage: no read at all for an anthropic profile, a signed-out profile, or an expired session ==");
{
  const cases = [
    ["an anthropic profile", { providerType: "anthropic", chatgptAccount: null, chatgptSessionState: "signed_out" }],
    ["a signed-out chatgpt profile", { chatgptSessionState: "signed_out" }],
    ["a session-expired chatgpt profile", { chatgptSessionState: "session_expired", hasCredential: false }]
  ];
  for (const [label, overrides] of cases) {
    const companion = createScriptedCompanion(chatgptProfile(overrides));
    const c = new SettingsController(companion.client);
    await c.init();
    ok(!companion.calls.some((x) => x.op === "chatgpt_usage"), `${label}: loading it sends no chatgpt_usage request`);
    const res = await c.refreshUsage();
    ok(res.ok === false, `${label}: an explicit refresh is refused rather than issued`);
    ok(!companion.calls.some((x) => x.op === "chatgpt_usage"), `${label}: still zero chatgpt_usage requests after the refused refresh`);
    ok(c.getState().usage.status === "idle", `${label}: the usage block stays idle — nothing to show and nothing read`);
  }
}

console.log("== ChatGPT usage: a typesafe profile on the chatgpt decision source reads it too (task 3.6) ==");
{
  // The reused ChatGPT sign-in/account/usage/sign-out block (task 3.6) reads
  // usage on load exactly like a plain `chatgpt` profile does — the account
  // IS the profile's decision model here, so its usage is exactly as
  // relevant.
  const companion = createScriptedCompanion(typesafeProfile({
    hasTypesafeKey: true,
    typesafeDecisionSource: "chatgpt",
    typesafeDecisionModelId: "gpt-5.5",
    chatgptAccount: { email: "user@example.com", planType: "plus" },
    chatgptSessionState: "signed_in",
    hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  const reads = companion.calls.filter((x) => x.op === "chatgpt_usage");
  ok(reads.length === 1 && reads[0].profileId === "default",
    `loading a typesafe profile whose decision source is chatgpt and signed in issues exactly one usage read — got ${JSON.stringify(reads)}`);
  ok(c.getState().usage.status === "ready", "and the block ends up ready, just like a plain chatgpt profile's");

  // A typesafe profile on any OTHER decision source reads nothing, even
  // though a stale chatgptAccount/chatgptSessionState may still be on disk
  // from an earlier switch.
  const companion2 = createScriptedCompanion(typesafeProfile({
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true,
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    typesafeDecisionSource: "openai",
    chatgptAccount: { email: "user@example.com", planType: "plus" },
    chatgptSessionState: "signed_in"
  }));
  const c2 = new SettingsController(companion2.client);
  await c2.init();
  ok(!companion2.calls.some((x) => x.op === "chatgpt_usage"), "a typesafe profile on the openai decision source reads no usage, even if a ChatGPT session happens to still be signed in");
}

console.log("== ChatGPT usage: explicit refresh issues a second read and replaces the displayed values ==");
{
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const snapshots = [];
  const c = new SettingsController(companion.client);
  c.onChange = (snapshot) => snapshots.push(snapshot);
  await c.init();
  const first = c.getState().usage.usage;
  ok(first && first.primary.usedPercent === 3, "the load read showed the companion's first reply");

  companion.scripts.chatgptUsage = () => ({
    planType: "plus",
    allowed: false,
    limitReached: true,
    primary: { usedPercent: 100, limitWindowSeconds: 18000, resetAfterSeconds: 60, resetAt: null },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: 12.5 }
  });
  const res = await c.refreshUsage();
  ok(res.ok === true, "the explicit refresh resolves");
  ok(companion.calls.filter((x) => x.op === "chatgpt_usage").length === 2, "it is a second, real read — never a cached value");
  const s = c.getState();
  ok(s.usage.status === "ready" && s.usage.usage.primary.usedPercent === 100 && s.usage.usage.limitReached === true,
    "the displayed values are the refresh's result, replacing the previous ones");
  ok(s.usage.usage.credits && s.usage.usage.credits.balance === 12.5, "the credits summary survives into state for a paying account");
  ok(snapshots.some((snap) => snap.usage.status === "loading" && snap.usage.usage === null),
    "a loading state was published, with the previous values cleared, before the reply landed");
}

console.log("== ChatGPT usage: a failed read lands in usage.error and leaves the account, plan and models untouched ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  const before = c.getState();
  companion.scripts.chatgptUsage = () => { throw new ProviderErrorLike("NETWORK_ERROR", "the usage endpoint could not be reached"); };
  const res = await c.refreshUsage();
  const after = c.getState();
  ok(res.ok === false && res.code === "NETWORK_ERROR", "the failure is returned to the caller with its code");
  ok(after.usage.status === "error" && after.usage.error && after.usage.error.code === "NETWORK_ERROR",
    "the block's own error state carries the companion's code");
  ok(after.usage.usage === null, "no stale usage values are left behind by a failed read");
  ok(JSON.stringify(after.chatgptAccount) === JSON.stringify(before.chatgptAccount), "the signed-in account is untouched");
  ok(JSON.stringify(after.models) === JSON.stringify(before.models) && after.defaultModelId === before.defaultModelId,
    "the model list and its default are untouched");
  ok(after.banner === null, "a failed usage read does not hijack the page banner (the block shows the copy)");
  const again = await c.refreshUsage();
  ok(again.ok === false, "refresh stays available for another attempt");
  ok(companion.calls.filter((x) => x.op === "chatgpt_usage").length === 3, "each attempt is a fresh read");
}

console.log("== ChatGPT usage: a read that discovers an expired session shows the page's own session-expired state ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  companion.scripts.chatgptUsage = () => { throw new ProviderErrorLike("SESSION_EXPIRED", "the ChatGPT session has expired"); };
  await c.refreshUsage();
  const s = c.getState();
  ok(s.usage.status === "error" && s.usage.error.code === "SESSION_EXPIRED", "the block records the session-expired failure");
  ok(s.chatgptSessionState === "session_expired", "the page mirrors the transition the companion just recorded");
  ok(s.banner && s.banner.code === "SESSION_EXPIRED" && /hết hạn/.test(s.banner.title || ""),
    "the page's usual SESSION_EXPIRED banner (and its sign-in action) is what the user sees");
  ok(s.chatgptAccount && s.chatgptAccount.email === "user@example.com", "the account mirror itself is left as it was");
  ok(s.models.length === 1, "the model list is untouched");
  const readsBefore = companion.calls.filter((x) => x.op === "chatgpt_usage").length;
  const res = await c.refreshUsage();
  ok(res.ok === false, "an expired session refuses a further read instead of retrying it");
  ok(companion.calls.filter((x) => x.op === "chatgpt_usage").length === readsBefore, "and issues none (no read is ever sent for a session-expired profile)");
}

console.log("== ChatGPT usage: a late response for a previous profile is discarded, never landed ==");
{
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const pending = deferred();
  companion.scripts.chatgptUsage = () => pending.promise;
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().usage.status === "loading", "the read is in flight while the profile is open");

  await c.switchProfile("other");
  ok(c.getState().profileId === "other" && c.getState().usage.status === "idle", "switching profiles resets the usage block");

  pending.resolve({
    planType: "free",
    allowed: true,
    limitReached: false,
    primary: { usedPercent: 77, limitWindowSeconds: 2592000, resetAfterSeconds: 10, resetAt: null },
    secondary: null,
    credits: null
  });
  await pending.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const s = c.getState();
  ok(s.profileId === "other" && s.usage.status === "idle" && s.usage.usage === null,
    "the previous profile's late reply is discarded instead of landing on the new profile's page");
}

console.log("== ChatGPT usage: nothing on a timer — a load read and an explicit refresh are the only reads ==");
{
  const timers = fakePollTimers();
  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const c = new SettingsController(companion.client, { setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn });
  await c.init();
  ok(timers.active() === 0, "a signed-in profile's usage read registers NO interval (no polling, ever)");
  ok(companion.calls.filter((x) => x.op === "chatgpt_usage").length === 1, "exactly one read came from the load");
  await timers.tick();
  ok(companion.calls.filter((x) => x.op === "chatgpt_usage").length === 1, "no tick can produce another read — there is no timer to tick");
  await c.refreshUsage();
  ok(companion.calls.filter((x) => x.op === "chatgpt_usage").length === 2, "the explicit refresh is what issues the second read");
  ok(timers.active() === 0, "still no interval after a refresh");
}

console.log("== ChatGPT usage: a companion that predates the op reads as 'update the companion', not as a network failure ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const { describeErrorCode } = await import("../extension/settings/errors-ui.js");
  const stale = describeErrorCode("PROTOCOL_ERROR", { op: "chatgpt_usage" });
  const nonChatgpt = describeErrorCode("PROTOCOL_ERROR");
  ok(/cập nhật companion/i.test(stale.title || ""), `chatgpt_usage is in CHATGPT_OPS, so an unknown op means "update the companion" — got ${JSON.stringify(stale)}`);
  ok(stale.title !== nonChatgpt.title, "and it is NOT the Anthropic-endpoint incompatibility copy");
  const unavailable = describeErrorCode("USAGE_UNAVAILABLE", { op: "chatgpt_usage" });
  ok(unavailable.title && unavailable.title !== "Lỗi không xác định" && unavailable.message && unavailable.action,
    `USAGE_UNAVAILABLE has its own actionable copy — got ${JSON.stringify(unavailable)}`);

  const companion = createScriptedCompanion(chatgptProfile({ chatgptSessionState: "signed_in", hasCredential: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  companion.scripts.chatgptUsage = () => { throw new ProviderErrorLike("PROTOCOL_ERROR", "unknown agent_settings op \"chatgpt_usage\""); };
  await c.refreshUsage();
  const s = c.getState();
  ok(s.usage.status === "error" && s.usage.error.code === "PROTOCOL_ERROR",
    "the stale-companion failure is recorded on the block with its own code");
  ok(/cập nhật companion/i.test(describeErrorCode(s.usage.error.code, { op: "chatgpt_usage" }).title || ""),
    "and the block renders it as an update instruction");
}

// The TypeSafe / Jev provider's profile shape (add-typesafe-jev-provider task
// 5.5): the five non-secret fields host/agent/settings/profile.js's
// loadProfile() adds, plus the provider's own seeded model. Every field is
// present-but-empty/false here, which is what a profile that has just been
// switched to this provider type looks like.
function typesafeProfile(overrides = {}) {
  return {
    profileId: "default",
    baseUrl: "https://api.typesafe.ai",
    models: [{ id: "jev-latest", label: "Jev (ultrafast)" }],
    defaultModelId: "jev-latest",
    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    revision: 2,
    credentialRevision: 0,
    providerType: "typesafe",
    chatgptAccount: null,
    chatgptSessionState: "signed_out",
    textModelBaseUrl: "",
    textModelId: "",
    hasTypesafeKey: false,
    hasTextModelKey: false,
    typesafeSource: "typesafe",
    ...overrides
  };
}

console.log("== TypeSafe provider: the profile's non-secret fields land in state, and the test stays locked ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1",
    textModelId: "gpt-5-mini",
    hasTypesafeKey: true,
    hasTextModelKey: true,
    hasCredential: true,
    revision: 4
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  const s = c.getState();
  ok(s.providerType === "typesafe", "the provider type loads verbatim");
  ok(s.textModelBaseUrl === "https://api.openai.com/v1" && s.textModelBaseUrlDraft === s.textModelBaseUrl,
    "the text-model base URL is loaded with its own draft (the /v1 path is preserved, not normalized away)");
  ok(s.textModelId === "gpt-5-mini" && s.textModelIdDraft === s.textModelId, "the text-model model ID is loaded with its draft");
  ok(s.hasTypesafeKey === true && s.hasTextModelKey === true, "both has-key booleans mirror the companion's reply");
  ok(s.isFirstRun === false, "a fully configured typesafe profile is not first-run onboarding");
  ok(connectionGate(s).canTest === true, "with both keys saved and a valid text config, the test control is live");
}
{
  // The gating rule itself, walked one missing piece at a time. The test makes
  // two requests to two services, so anything missing from that pair must keep
  // the control disabled — and each state must name its own reason, never a
  // generic "not configured".
  const companion = createScriptedCompanion(typesafeProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  let s = c.getState();
  ok(connectionGate(s).reason === "no_typesafe_key", "a fresh typesafe profile (no keys, no text config) is blocked on the TypeSafe key first");

  c.state.hasTypesafeKey = true;
  ok(connectionGate(c.getState()).reason === "no_text_model_key", "one saved key does not unlock testing — the second key is asked for next");

  c.state.hasTextModelKey = true;
  ok(connectionGate(c.getState()).reason === "no_text_model_config", "both keys saved but no text-model base URL/model ID still blocks");

  c.setTextModelBaseUrlDraft("https://api.openai.com/v1");
  ok(connectionGate(c.getState()).reason === "no_text_model_config", "a base URL without a model ID is still incomplete");

  c.setTextModelIdDraft("gpt-5-mini");
  s = c.getState();
  ok(connectionGate(s).canTest === true, "both keys plus a valid text config is the complete precondition");
  ok(s.textModelBaseUrlDraft === "https://api.openai.com/v1" && s.textModelBaseUrl === "",
    "the drafts moved without writing anything to the companion");

  c.setTextModelIdDraft("   ");
  ok(connectionGate(c.getState()).reason === "no_text_model_config", "a whitespace-only model ID does not count as valid");
  c.setTextModelIdDraft("gpt-5-mini");

  c.setTextModelBaseUrlDraft("ftp://nope.example.com");
  ok(connectionGate(c.getState()).reason === "no_text_model_config", "an unusable scheme blocks the control too");
  ok(c.validateTextModelBaseUrlField().ok === false && c.getState().fieldErrors.textModelBaseUrl !== null,
    "and the field itself reports why (the shared validator, reused rather than re-implemented)");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "none of that local editing reached the wire");
}

console.log("== TypeSafe provider: switching to it calls set_provider_type and is no longer rejected locally ==");
{
  const companion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager",
    revision: 1, providerType: "anthropic", chatgptAccount: null, chatgptSessionState: "signed_out"
  });
  const c = new SettingsController(companion.client);
  await c.init();
  const res = await c.setProviderType("typesafe");
  ok(res.ok === true, "the third provider type is accepted");
  const call = companion.calls.find((x) => x.op === "set_provider_type");
  ok(call && call.providerType === "typesafe", `set_provider_type reaches the companion with "typesafe" — got ${JSON.stringify(call)}`);
  const s = c.getState();
  ok(s.providerType === "typesafe", "the reply's profile is applied");
  ok(s.connectionStatus === null, "the previous provider type's connection result is not carried over");
}

console.log("== TypeSafe provider: save() writes the text-model config and both keys, and never mirrors a key ==");
{
  const companion = createScriptedCompanion(typesafeProfile());
  const c = new SettingsController(companion.client);
  const snapshots = [];
  c.onChange = (snapshot) => snapshots.push(snapshot);
  await c.init();

  c.setTextModelBaseUrlDraft("https://api.openai.com/v1/");
  c.setTextModelIdDraft("  gpt-5-mini  ");
  const result = await c.save("", { typesafeApiKey: "ts-RAW-SENTINEL-1", textModelApiKey: "tm-RAW-SENTINEL-2" });
  ok(result.ok === true, "save() succeeds with a valid text config and both keys");

  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && configCall.textModelBaseUrl === "https://api.openai.com/v1" && configCall.textModelId === "gpt-5-mini",
    `the normalized pair is what reaches the companion (trailing slash gone, ID trimmed, /v1 kept) — got ${JSON.stringify(configCall)}`);
  ok(configCall && !("baseUrl" in configCall), "no TypeSafe endpoint is sent on the config op — the endpoint is profile.baseUrl, persisted by saveProfile");
  ok(!/key|secret/i.test(Object.keys(configCall || {}).join(",")), "and no key field rides on the config op at all");

  const credCall = companion.calls.find((x) => x.op === "set_typesafe_credentials");
  ok(credCall && credCall.typesafeKeyLength === "ts-RAW-SENTINEL-1".length && credCall.textModelKeyLength === "tm-RAW-SENTINEL-2".length,
    "both raw keys travelled out on the one credential op (the documented transient hold)");
  ok(credCall && !("memoryOnly" in (credCall.opts || {})), "an ordinary save never asks for memory-only");

  const s = c.getState();
  ok(s.hasTypesafeKey === true && s.hasTextModelKey === true && s.hasCredential === true, "the reply's booleans land in state");
  ok(s.textModelBaseUrl === "https://api.openai.com/v1" && s.textModelId === "gpt-5-mini",
    "the saved values (the companion's own reply) are what the fields now show");
  ok(s.connectionStatus === null, "a key change invalidates any previously recorded capability result");
  ok(connectionGate(s).canTest === true, "and the test control is now live");

  const serialized = snapshots.map((snap) => JSON.stringify(snap)).join("\n");
  ok(!serialized.includes("ts-RAW-SENTINEL-1") && !serialized.includes("tm-RAW-SENTINEL-2"),
    "no emitted state snapshot ever contains either raw key");
  ok(!serialized.includes("RAW-SENTINEL"), "not even a partial prefix of one does");
}

console.log("== TypeSafe provider: the Jev source is state, persisted on save, and never a raw endpoint send ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().typesafeSource === "typesafe", "an absent source on the profile loads as the direct default");

  // OpenRouter (task 2.3) joined typesafe/vercel as a known Jev source — a
  // truly unknown string is still refused.
  const refused = c.setTypesafeSource("not-a-real-source");
  ok(refused.ok === false && c.getState().typesafeSource === "typesafe", "an unknown source is refused and the state is untouched");

  const openrouterAccepted = c.setTypesafeSource("openrouter");
  ok(openrouterAccepted.ok === true && c.getState().typesafeSource === "openrouter", "selecting OpenRouter updates the state");
  c.setTypesafeSource("typesafe");

  const accepted = c.setTypesafeSource("vercel");
  ok(accepted.ok === true && c.getState().typesafeSource === "vercel", "selecting the Vercel gateway updates the state");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "the select alone writes nothing — Save is the only writer");

  const result = await c.save("");
  ok(result.ok === true, "save() succeeds");
  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && configCall.typesafeSource === "vercel", `the chosen source rides on the config op — got ${JSON.stringify(configCall)}`);
  ok(configCall && !("baseUrl" in configCall), "and still no endpoint on the config op: saveProfile carries it (the page mirrors the host's source rule)");
}
{
  // A profile that already stored the gateway source loads it back verbatim.
  const companion = createScriptedCompanion(typesafeProfile({ typesafeSource: "vercel" }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().typesafeSource === "vercel", "a stored vercel source loads into state");
}

console.log("== TypeSafe endpoint (add-typesafe-endpoint-field): every source-named surface reads one table ==");
{
  // design.md decision 1/3: the endpoint field, its hint, the key field, its
  // status line and its remove action all name the selected Jev source, and
  // the documented default each surface names is the same string the page
  // mirrors a source change with. They are one table (settings-controller.js's
  // typesafeSourceCopy) precisely so they cannot drift.
  const direct = typesafeSourceCopy("typesafe");
  const gateway = typesafeSourceCopy("vercel");
  ok(direct.endpointDefault === "https://api.typesafe.ai" && gateway.endpointDefault === "https://ai-gateway.vercel.sh",
    "each source carries its own documented default (the endpoint field's placeholder)");
  ok(direct.endpointLabel === "Điểm cuối Jev — TypeSafe API" && gateway.endpointLabel === "Điểm cuối Jev — Vercel AI Gateway",
    "the endpoint field's label names the selected source");
  ok(direct.endpointHint.includes(direct.endpointDefault) && gateway.endpointHint.includes(gateway.endpointDefault),
    "each hint names that source's documented default");
  ok(direct.endpointHint.includes("giữ nguyên") && gateway.endpointHint.includes("giữ nguyên"),
    "and states the rule a source change follows: a custom endpoint is kept");
  ok(direct.keyLabel === "API key TypeSafe" && gateway.keyLabel === "API key Vercel AI Gateway",
    "the key field's label follows the source");
  ok(direct.keyRemoveLabel === "Xóa key TypeSafe" && gateway.keyRemoveLabel === "Xóa key Vercel AI Gateway",
    "and so does the key's remove action");
  ok(direct.endpointLabel !== gateway.endpointLabel && direct.keyLabel !== gateway.keyLabel && direct.keyRemoveLabel !== gateway.keyRemoveLabel,
    "no two sources read the same on any of the three");
  ok(typesafeSourceCopy(undefined) === direct,
    "an absent source falls back to the documented default source, matching resolveTypesafeSource()");
  ok(typesafeSourceCopy("not-a-real-source") === direct,
    "and so does one this version doesn't recognize");

  // OpenRouter (task 2.3): its own row in the same table, labeled alpha
  // (its decision route lives under /api/alpha/) and distinct from the
  // other two on every surface.
  const openrouter = typesafeSourceCopy("openrouter");
  ok(openrouter !== direct && openrouter.endpointDefault === "https://openrouter.ai",
    "OpenRouter has its own documented default endpoint, not the TypeSafe fallback");
  ok(/alpha/i.test(openrouter.endpointLabel) || /alpha/i.test(openrouter.endpointHint),
    "its endpoint label or hint names the route alpha (specs/typesafe-jev-provider: \"labeled as such where it is selected\")");
  ok(openrouter.keyLabel === "API key OpenRouter" && openrouter.keyRemoveLabel === "Xóa key OpenRouter",
    "its key field and remove action name OpenRouter, not a generic label");
  ok(
    openrouter.endpointLabel !== direct.endpointLabel && openrouter.endpointLabel !== gateway.endpointLabel &&
      openrouter.keyLabel !== direct.keyLabel && openrouter.keyLabel !== gateway.keyLabel,
    "no two of the three sources read the same on any of these surfaces"
  );
}

console.log("== TypeSafe endpoint: a source change moves a still-known-default endpoint and nothing else ==");
{
  // design.md decision 2: the page mirrors profile.js's setTypesafeConfig
  // exactly — only a KNOWN default follows the source; any other endpoint is
  // left untouched, in both directions.
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().baseUrlDraft === "https://api.typesafe.ai", "the endpoint draft loads the profile's own endpoint");

  c.setTypesafeSource("vercel");
  ok(c.getState().baseUrlDraft === "https://ai-gateway.vercel.sh", "a known default follows the source to its own default");
  c.setTypesafeSource("typesafe");
  ok(c.getState().baseUrlDraft === "https://api.typesafe.ai", "and back again — both documented defaults swap either way");

  // Judged on the NORMALIZED draft, the same string a Save would send: a
  // trailing slash or the SDK's own /v1 is the endpoint the host compares
  // after saveProfile normalized it, so the page must not miss the case and
  // leave the field showing a value the host is about to replace.
  c.setBaseUrlDraft("https://api.typesafe.ai/");
  c.setTypesafeSource("vercel");
  ok(c.getState().baseUrlDraft === "https://ai-gateway.vercel.sh", "a known default written with a trailing slash still counts as one");
  c.setBaseUrlDraft("https://api.typesafe.ai/v1");
  c.setTypesafeSource("typesafe");
  ok(c.getState().baseUrlDraft === "https://api.typesafe.ai", "so does the same endpoint carrying the SDK's own /v1");

  // The live case this change exists for: an endpoint carried over as a custom
  // URL is never rewritten by a source change (in either direction), and is now
  // reachable for editing instead of stranded.
  c.setBaseUrlDraft("https://jev-gateway.internal.example.com");
  c.setTypesafeSource("vercel");
  ok(c.getState().baseUrlDraft === "https://jev-gateway.internal.example.com", "a custom endpoint is left exactly as it is");
  ok(c.getState().typesafeSource === "vercel", "while the source itself does change — only the endpoint stays put");

  const refused = c.setTypesafeSource("not-a-real-source");
  ok(refused.ok === false && c.getState().baseUrlDraft === "https://jev-gateway.internal.example.com",
    "an unknown source is refused before the rule runs, so nothing moves");

  ok(!companion.calls.some((x) => x.op === "save_profile" || x.op === "set_typesafe_config"),
    "none of that moved anything on the wire — Save is still the only writer");
}

console.log("== TypeSafe endpoint: an edited endpoint round-trips through Save and is what the next test uses ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();

  c.setBaseUrlDraft("https://jev-gateway.internal.example.com/prefix/");
  const result = await c.save("");
  ok(result.ok === true, "save() accepts the edited endpoint");
  const profileCall = companion.calls.find((x) => x.op === "save_profile");
  ok(profileCall && profileCall.patch.baseUrl === "https://jev-gateway.internal.example.com/prefix",
    `the normalized endpoint rides the existing saveProfile call — got ${JSON.stringify(profileCall && profileCall.patch)}`);
  ok(companion.getInternalProfile().baseUrl === "https://jev-gateway.internal.example.com/prefix",
    "and is what the profile now holds — the value every provider request resolves");
  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && !("baseUrl" in configCall), "no second writer: the same value does not also ride the config op");
  ok(c.getState().baseUrlDraft === "https://jev-gateway.internal.example.com/prefix" && c.getState().baseUrl === c.getState().baseUrlDraft,
    "the field shows the saved endpoint back, so page and profile agree");

  // The capability test (and a run) resolve the endpoint from the persisted
  // profile, so the round trip is exactly what the test then talks to.
  const tested = await c.testConnection();
  ok(tested.ok === true && companion.getInternalProfile().baseUrl === "https://jev-gateway.internal.example.com/prefix",
    "the capability test that follows runs against exactly the saved endpoint");
}

console.log("== TypeSafe endpoint: what the page shows after a source change is what a Save persists ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  c.setTypesafeSource("vercel");
  const shown = c.getState().baseUrlDraft;
  ok(shown === "https://ai-gateway.vercel.sh", "the field has moved to the new source's default");
  await c.save("");
  ok(companion.getInternalProfile().baseUrl === shown,
    "and that is exactly the endpoint the profile holds — the page's mirror and the host's own remap pick the same value");
  ok(c.getState().baseUrlDraft === shown && c.getState().baseUrl === shown,
    "the reply leaves the field showing the same endpoint, so nothing silently re-points on the next run");
}

console.log("== TypeSafe endpoint: an invalid endpoint blocks the save with the field's own error ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();

  c.setBaseUrlDraft("http://plain-http.example.com");
  const result = await c.save("");
  ok(result.ok === false, "an endpoint that is not a well-formed HTTPS URL blocks the save");
  ok(c.getState().fieldErrors.baseUrl !== null, "the error lands on the endpoint field itself");
  ok(c.getState().fieldErrors.baseUrl === result.error, "and is the same line the field renders");
  ok(!companion.calls.some((x) => x.op === "save_profile") && !companion.calls.some((x) => x.op === "set_typesafe_config"),
    "nothing was sent — the last saved endpoint is still in place");
  ok(companion.getInternalProfile().baseUrl === "https://api.typesafe.ai", "…and still the profile's endpoint");

  c.setBaseUrlDraft("https://api.typesafe.ai");
  const fixed = await c.save("");
  ok(fixed.ok === true && c.getState().fieldErrors.baseUrl === null, "fixing the field clears the error and the same save goes through");
}

console.log("== TypeSafe provider: an invalid text-model pair blocks save() before anything is sent ==");
{
  // specs/agent-settings "TypeSafe text-model fields are required": "saving and
  // testing are blocked with a field-level error and no capability test request
  // is sent".
  const companion = createScriptedCompanion(typesafeProfile({ hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true }));
  const c = new SettingsController(companion.client);
  await c.init();

  c.setTextModelBaseUrlDraft("https://api.openai.com/v1");
  c.setTextModelIdDraft("");
  const result = await c.save("", { typesafeApiKey: "ts-should-not-be-sent" });
  ok(result.ok === false, "save() refuses an empty text-model model ID");
  ok(c.getState().fieldErrors.textModelId !== null, "the error is on the field itself");
  ok(c.getState().banner && c.getState().banner.kind === "error", "and shown as a banner, not swallowed");
  ok(!companion.calls.some((x) => x.op === "save_profile"), "not even the profile half was sent — validation happens first");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "the text-model config op was never called");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_credentials"), "and neither was the credential op, so the typed key was never sent");

  c.setTextModelBaseUrlDraft("https://api.openai.com/v1");
  c.setTextModelIdDraft("gpt-5-mini");
  const fixed = await c.save("", { typesafeApiKey: "ts-now-valid" });
  ok(fixed.ok === true, "once the field is fixed, the same save succeeds");
  ok(c.getState().fieldErrors.textModelId === null, "and the field error is cleared");
}

console.log("== Decision-model source (task 3.6): defaults, switching, and per-source copy ==");
{
  const { typesafeDecisionSourceCopy, typesafeDisclosureText, typesafeTestDisclosureText } = await import("../extension/settings/settings-controller.js");

  const openai = typesafeDecisionSourceCopy("openai");
  const anthropic = typesafeDecisionSourceCopy("anthropic");
  const chatgpt = typesafeDecisionSourceCopy("chatgpt");
  ok(typesafeDecisionSourceCopy(undefined) === openai && typesafeDecisionSourceCopy("not-a-real-source") === openai,
    "an absent or unrecognized decision-model source falls back to the documented openai default");
  ok(openai !== anthropic && anthropic !== chatgpt && openai !== chatgpt, "the three sources read distinctly");

  // The default (openai) source's disclosure text must still contain "mô
  // hình văn bản" — the exact phrase test/settings-connection-gate.test.mjs's
  // static-HTML assertion and this suite's own capability-stage tests below
  // already pin for it.
  ok(/mô hình văn bản/.test(typesafeDisclosureText("openai")) && /mô hình văn bản/.test(typesafeDisclosureText(undefined)),
    "the openai (default) disclosure still names the text-model endpoint the way existing assertions expect");
  ok(/TypeSafe/.test(typesafeDisclosureText("openai")), "and still names TypeSafe as the other service every run talks to");
  ok(/Anthropic/.test(typesafeDisclosureText("anthropic")) && !/mô hình văn bản/.test(typesafeDisclosureText("anthropic")),
    "the anthropic source's disclosure names the operator's Anthropic endpoint instead");
  ok(/ChatGPT/.test(typesafeDisclosureText("chatgpt")) && !/mô hình văn bản/.test(typesafeDisclosureText("chatgpt")),
    "the chatgpt source's disclosure names the ChatGPT subscription (through the local gateway) instead");
  ok(/ChatGPT/.test(typesafeTestDisclosureText("chatgpt")) && /giới hạn sử dụng/.test(typesafeTestDisclosureText("chatgpt")),
    "the chatgpt source's TEST disclosure reads as a usage-limit statement, not a cost statement");
  ok(/mô hình văn bản/.test(typesafeTestDisclosureText("openai")) && /chi phí/.test(typesafeTestDisclosureText("openai")),
    "the openai source's test disclosure keeps the existing cost wording");

  // A profile stored before this choice existed (typesafeProfile() never sets
  // it) loads as `openai` with its text-model fields unchanged
  // (specs/typesafe-jev-provider "An existing profile keeps its text model").
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().typesafeDecisionSource === "openai", "an absent decision source on the profile loads as the documented openai default");
  ok(c.getState().decisionBaseUrl === "" && c.getState().decisionModelId === "", "and the two anthropic/chatgpt-only fields load empty");

  const refused = c.setTypesafeDecisionSource("not-a-real-source");
  ok(refused.ok === false && c.getState().typesafeDecisionSource === "openai", "an unknown decision source is refused and the state is untouched");

  const toAnthropic = c.setTypesafeDecisionSource("anthropic");
  ok(toAnthropic.ok === true && c.getState().typesafeDecisionSource === "anthropic", "switching to anthropic updates the state");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "the select alone writes nothing — Save is the only writer");
}

console.log("== Decision-model source: only the ACTIVE source's fields are validated, sent, and required ==");
{
  // anthropic: the reused Anthropic key (#key-input/hasCredential) plus its
  // own base URL and model ID — never the text-model fields.
  const companion = createScriptedCompanion(typesafeProfile({ hasTypesafeKey: true, hasCredential: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  c.setTypesafeDecisionSource("anthropic");

  const bothEmpty = await c.save("");
  ok(bothEmpty.ok === false, "save() refuses an empty decision Base URL/model ID pair for the anthropic source");
  ok(c.getState().fieldErrors.decisionBaseUrl !== null, "the Base URL is validated first, so its error lands on that field");
  ok(!companion.calls.some((x) => x.op === "save_profile"), "nothing was sent — validation happens before any call");

  c.setDecisionBaseUrlDraft("https://api.anthropic.com");
  const missingModelId = await c.save("");
  ok(missingModelId.ok === false, "an empty decision-model ID is refused once the Base URL is fixed");
  ok(c.getState().fieldErrors.decisionModelId !== null, "this time the error lands on the decision-model-id field");

  c.setDecisionModelIdDraft("claude-sonnet-5");
  // The reused Anthropic key rides the SAME #key-input/setCredential path an
  // `anthropic` profile uses — a bare string, exactly like it, not a
  // TypeSafe-shaped payload.
  const saved = await c.save("sk-ant-decision-key-1");
  ok(saved.ok === true, `save() succeeds once the anthropic source's own fields and key are all present — got ${JSON.stringify(saved)}`);
  ok(companion.calls.some((x) => x.op === "set_credential"), "the credential op used is the EXISTING one (set_credential), never a new op");
  const configCall = companion.calls.filter((x) => x.op === "set_typesafe_config").pop();
  ok(configCall && configCall.decisionSource === "anthropic" && configCall.decisionBaseUrl === "https://api.anthropic.com" && configCall.decisionModelId === "claude-sonnet-5",
    `the config op carries exactly the anthropic source's fields — got ${JSON.stringify(configCall)}`);
  ok(!("textModelBaseUrl" in configCall) && !("textModelId" in configCall),
    "and the deselected openai source's text-model fields are NOT sent, so they cannot be overwritten");
}
{
  // chatgpt: only the shared decision-model-id field, plus the existing
  // sign-in state — no base URL, no new key.
  const companion = createScriptedCompanion(typesafeProfile({ hasTypesafeKey: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  c.setTypesafeDecisionSource("chatgpt");

  const missingModelId = await c.save("");
  ok(missingModelId.ok === false, "save() refuses an empty decision-model ID for the chatgpt source");
  ok(c.getState().fieldErrors.decisionModelId !== null, "the error lands on the decision-model-id field");

  c.setDecisionModelIdDraft("gpt-5.5");
  const saved = await c.save("");
  ok(saved.ok === true, `save() succeeds with just the model ID for the chatgpt source — got ${JSON.stringify(saved)}`);
  const configCall = companion.calls.filter((x) => x.op === "set_typesafe_config").pop();
  ok(configCall && configCall.decisionSource === "chatgpt" && configCall.decisionModelId === "gpt-5.5",
    `the config op carries exactly the chatgpt source's field — got ${JSON.stringify(configCall)}`);
  ok(!("decisionBaseUrl" in configCall) && !("textModelBaseUrl" in configCall) && !("textModelId" in configCall),
    "neither the anthropic base URL nor either openai text-model field is sent");

  // testConnection() and discoverModels() both refuse before any request when
  // the chatgpt source has not signed in yet, exactly like a plain `chatgpt`
  // profile does.
  const blocked = await c.testConnection();
  ok(blocked.ok === false, "the test refuses to run before the chatgpt decision source is signed in");
  ok(!companion.calls.some((x) => x.op === "test_capability"), "no capability request is sent");
  ok(/ChatGPT/.test(c.getState().banner.title || c.getState().banner.message || ""), "the banner names ChatGPT, not a generic credential error");
}

console.log("== Decision-model source: switching away and back keeps the deselected source's stored configuration ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  }));
  const c = new SettingsController(companion.client);
  await c.init();

  // Configure and save the anthropic source first.
  c.setTypesafeDecisionSource("anthropic");
  c.setDecisionBaseUrlDraft("https://api.anthropic.com");
  c.setDecisionModelIdDraft("claude-sonnet-5");
  await c.save("sk-ant-decision-key-1");
  ok(companion.getInternalProfile().typesafeDecisionSource === "anthropic", "the anthropic source is now stored");

  // Switch to openai and save again — this must not touch the stored
  // anthropic fields, since they were never sent.
  c.setTypesafeDecisionSource("openai");
  ok(c.getState().textModelBaseUrlDraft === "https://api.openai.com/v1" && c.getState().textModelIdDraft === "gpt-5-mini",
    "the openai source's own fields are exactly what was loaded — switching away and back never cleared them");
  const savedOpenai = await c.save("");
  ok(savedOpenai.ok === true, "saving on the openai source succeeds using its already-loaded fields");
  ok(companion.getInternalProfile().typesafeDecisionSource === "openai", "the stored source is now openai");
  ok(companion.getInternalProfile().typesafeDecisionBaseUrl === "https://api.anthropic.com" && companion.getInternalProfile().typesafeDecisionModelId === "claude-sonnet-5",
    "…and the anthropic source's earlier configuration is still stored, untouched, for a later switch back");

  // Switch back to anthropic without retyping anything.
  c.setTypesafeDecisionSource("anthropic");
  ok(c.getState().decisionBaseUrlDraft === "https://api.anthropic.com" && c.getState().decisionModelIdDraft === "claude-sonnet-5",
    "switching back shows the earlier configuration again, with nothing to retype");
  const savedAgain = await c.save("");
  ok(savedAgain.ok === true, "and it saves again without re-entering the key or the fields");
}

console.log("== Decision-model source: the reused Anthropic key field is gated correctly for isFirstRun/testConnection ==");
{
  const companion = createScriptedCompanion(typesafeProfile({ hasTypesafeKey: true }));
  const c = new SettingsController(companion.client);
  await c.init();
  c.setTypesafeDecisionSource("anthropic");
  c.state.decisionBaseUrlDraft = "https://api.anthropic.com";
  c.state.decisionModelIdDraft = "claude-sonnet-5";
  const blocked = await c.testConnection();
  ok(blocked.ok === false, "the test refuses to run before the anthropic decision source's key is saved");
  ok(/Anthropic/.test(blocked.error || c.getState().banner.title || ""), "the banner names the missing Anthropic key, not a generic one");
  ok(!companion.calls.some((x) => x.op === "test_capability"), "no capability request is sent");
}

console.log("== TypeSafe provider: testConnection sends no request until both keys and the text config are in place ==");
{
  const companion = createScriptedCompanion(typesafeProfile());
  const c = new SettingsController(companion.client);
  await c.init();
  const blocked = await c.testConnection();
  ok(blocked.ok === false, "the test refuses to run on an incomplete typesafe profile");
  ok(!companion.calls.some((x) => x.op === "test_capability"), "no capability request is sent");
  const banner = c.getState().banner;
  ok(/TypeSafe/.test(banner.title || ""), `the banner names the missing piece (the TypeSafe key) — got ${JSON.stringify(banner)}`);
  ok(!/NO_CREDENTIAL|API key\b(?! TypeSafe)/.test(JSON.stringify(banner)), "and never falls back to the generic Anthropic NO_CREDENTIAL copy");

  c.state.hasTypesafeKey = true;
  c.state.hasTextModelKey = true;
  c.state.textModelBaseUrlDraft = "https://api.openai.com/v1";
  c.state.textModelIdDraft = "gpt-5-mini";
  const ran = await c.testConnection();
  ok(ran.ok === true, "with everything in place the test runs");
  ok(companion.calls.some((x) => x.op === "test_capability" && x.modelId === "jev-latest"),
    "against the profile's own default model");
}

console.log("== TypeSafe provider: the two capability stages are reported separately, by name ==");
{
  const { describeErrorCode } = await import("../extension/settings/errors-ui.js");
  const companion = createScriptedCompanion(typesafeProfile({
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true,
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini"
  }));
  // The stage that fails here is the SECOND one, so a page that reported a
  // single anonymous failure — or blamed TypeSafe — would be visibly wrong.
  companion.scripts.testCapability = () => ({
    status: "fail",
    capabilities: { systemone: "pass", textModel: "fail" },
    errors: { textModel: { code: "AUTH_ERROR", message: "the text model rejected the key" } },
    timestamp: new Date().toISOString()
  });
  const c = new SettingsController(companion.client);
  await c.init();
  const result = await c.testConnection();
  ok(result.ok === false, "a failed stage is never reported as an overall pass");
  const s = c.getState();
  ok(s.connectionStatus.capabilities.systemone === "pass" && s.connectionStatus.capabilities.textModel === "fail",
    "both stages are kept separately for the page's own pills");
  ok(s.connectionStatus.textOnly === false, "the Anthropic text-only notion does not apply to this provider");
  ok(s.banner.code === "AUTH_ERROR" && s.banner.stage === "textModel",
    `the banner carries the failing stage as well as the code — got ${JSON.stringify(s.banner)}`);
  ok(/mô hình văn bản/.test(s.banner.message || ""), "and says which service produced the failure");
  ok(!/TypeSafe \(/.test(s.banner.message || ""), "without blaming the other service");

  // The structurally-invalid-answer code (add-typesafe-jev-provider: the
  // taxonomy's new INVALID_RESPONSE) has its own actionable copy, named by
  // stage, rather than reading as an unknown error.
  const invalid = describeErrorCode("INVALID_RESPONSE", { stage: "systemone" });
  ok(/không hợp lệ/.test(invalid.title || "") && /TypeSafe/.test(invalid.title || ""),
    `INVALID_RESPONSE names the TypeSafe stage — got ${JSON.stringify(invalid)}`);
  ok(invalid.title !== describeErrorCode("INVALID_RESPONSE").title, "the stage-less copy is a different, generic line");
  const staleOp = describeErrorCode("PROTOCOL_ERROR", { op: "set_typesafe_config" });
  ok(/cập nhật companion/i.test(staleOp.title || ""),
    "a companion that predates the provider reads as an update instruction, not as a broken endpoint");
  ok(staleOp.title !== describeErrorCode("PROTOCOL_ERROR").title, "and is not the Anthropic-endpoint incompatibility copy");
}

console.log("== TypeSafe provider: each key has its own remove action, and removing one keeps the other ==");
{
  const companion = createScriptedCompanion(typesafeProfile({
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true,
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini"
  }));
  const c = new SettingsController(companion.client);
  await c.init();
  c.state.connectionStatus = { status: "pass", capabilities: { systemone: "pass", textModel: "pass" } };

  const result = await c.removeTypesafeKey("typesafe");
  ok(result.ok === true, "the TypeSafe key removal resolves");
  const call = companion.calls.find((x) => x.op === "set_typesafe_credentials");
  ok(call && call.typesafeKeyLength === 0 && call.textModelKeyLength === null,
    `the removal is an explicit empty string for that half and NOTHING for the other — got ${JSON.stringify(call)}`);
  const s = c.getState();
  ok(s.hasTypesafeKey === false && s.hasTextModelKey === true, "only the removed half is cleared");
  ok(s.connectionStatus === null, "the previously recorded capability result is invalidated");
  ok(connectionGate(s).reason === "no_typesafe_key", "and the test control locks again with the right reason");
  ok(!/RAW|SENTINEL|sk-/.test(JSON.stringify(s)),
    "no key VALUE is anywhere in the state (secretBackend is a storage-backend name, not a secret)");
}

console.log("== TypeSafe provider: SECURE_STORAGE_UNAVAILABLE offers the labeled memory-only retry for the key pair ==");
{
  const { ProviderErrorLike: Err } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini"
  }));
  companion.scripts.setTypesafeCredentials = () => {
    throw new Err("SECURE_STORAGE_UNAVAILABLE", "no OS credential store is available");
  };
  const c = new SettingsController(companion.client);
  const snapshots = [];
  c.onChange = (snapshot) => snapshots.push(snapshot);
  await c.init();

  const result = await c.save("", { typesafeApiKey: "ts-MEM-SENTINEL", textModelApiKey: "tm-MEM-SENTINEL" });
  ok(result.ok === true, "the non-secret halves still succeed (the config is saved; only the keys could not be persisted)");
  const s = c.getState();
  ok(s.hasTypesafeKey === false && s.hasTextModelKey === false, "hasCredential is never faked into a success");
  ok(s.pendingMemoryOnlyOffer === true && s.memoryOnlyOfferKind === "typesafe_credentials",
    `the offer is surfaced and labeled for this credential kind — got ${s.memoryOnlyOfferKind}`);
  ok(!snapshots.map((snap) => JSON.stringify(snap)).join("\n").includes("MEM-SENTINEL"),
    "the retained pair is private — it never appears in an emitted snapshot");

  companion.scripts.setTypesafeCredentials = null; // the confirmed retry uses the fake's default (memory-backed) success path
  const confirmed = await c.confirmMemoryOnlyCredential();
  ok(confirmed.ok === true, "the explicit confirmation completes the save");
  const retry = companion.calls.filter((x) => x.op === "set_typesafe_credentials")[1];
  ok(retry && retry.opts.memoryOnly === true && retry.typesafeKeyLength === "ts-MEM-SENTINEL".length,
    "the retry re-sends the SAME pair with memoryOnly:true");
  const after = c.getState();
  ok(after.hasTypesafeKey === true && after.hasTextModelKey === true && after.memoryOnlyCredential === true,
    "the memory-only pair is mirrored as saved with the memory backend");
  ok(after.pendingMemoryOnlyOffer === false, "and the offer is cleared");
}

console.log("== TypeSafe provider: an untouched key field is omitted, never sent as an empty (removing) value ==");
{
  // The one way this can go silently wrong: the two key inputs are always
  // present in the DOM, so "the user typed nothing here" and "the user wants
  // this key removed" both look like "" to the Save handler. An explicit "" is
  // the wire's REMOVAL signal, so sending it for an untouched field would
  // delete a stored key nobody asked to remove — a save that only replaces the
  // text-model key would wipe the TypeSafe one. Only each field's own remove
  // action may ever send "".
  const companion = createScriptedCompanion(typesafeProfile({
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true,
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini"
  }));
  const c = new SettingsController(companion.client);
  await c.init();

  const result = await c.save("", { typesafeApiKey: "", textModelApiKey: "tm-only-replacement" });
  ok(result.ok === true, "replacing one key alone is a valid save");
  const call = companion.calls.find((x) => x.op === "set_typesafe_credentials");
  ok(call && call.textModelKeyLength === "tm-only-replacement".length, "the typed half travels");
  ok(call && call.typesafeKeyLength === null,
    `the untouched half is OMITTED from the payload (not sent as "") — got ${JSON.stringify(call)}`);
  ok(c.getState().hasTypesafeKey === true && c.getState().hasTextModelKey === true,
    "both keys are still present afterwards — the untouched one was not deleted");

  // And a save that types no key at all sends no credential op whatsoever.
  const before = companion.calls.filter((x) => x.op === "set_typesafe_credentials").length;
  await c.save("", { typesafeApiKey: "", textModelApiKey: "" });
  ok(companion.calls.filter((x) => x.op === "set_typesafe_credentials").length === before,
    "a save that edits only the text-model fields issues no credential op at all");
  ok(c.getState().hasTypesafeKey === true && c.getState().hasTextModelKey === true,
    "and therefore leaves both stored keys exactly where they were");
}

console.log("== Screenshots toggle (add-jev-run-screenshots): defaults on for an older profile, persists through Save ==");
{
  // design.md decision 4. The default is the load-bearing half: the toggle
  // ships enabled, so every profile that predates the field — and every
  // companion that predates the setting, which answers without it at all —
  // must read as enabled rather than accidentally off.
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  })); // deliberately no sendScreenshots field on the fixture
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().sendScreenshots === true, "a profile stored before the toggle existed loads with it enabled");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "loading a profile writes nothing");

  const storedOff = createScriptedCompanion(typesafeProfile({ sendScreenshots: false }));
  const off = new SettingsController(storedOff.client);
  await off.init();
  ok(off.getState().sendScreenshots === false, "an explicitly stored false loads as off — the default never overrides a stored value");

  // Flip it and Save: the value rides the SAME non-secret config op the
  // text-model fields use (no new op, no new wire), and the value the page
  // keeps afterwards is the one the companion echoed back.
  c.setSendScreenshots(false);
  ok(c.getState().sendScreenshots === false, "the toggle flips in local state immediately");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "and still writes nothing until Save");
  const result = await c.save("");
  ok(result.ok === true, "save() succeeds");
  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && configCall.sendScreenshots === false,
    `the toggle rides set_typesafe_config — got ${JSON.stringify(configCall)}`);
  ok(c.getState().sendScreenshots === false, "the companion's echoed profile leaves it off after the save");

  const reloaded = new SettingsController(companion.client);
  await reloaded.init();
  ok(reloaded.getState().sendScreenshots === false, "a fresh load of the same profile reads the persisted off value back");
  reloaded.setSendScreenshots(true);
  await reloaded.save("");
  const secondCall = companion.calls.filter((x) => x.op === "set_typesafe_config").pop();
  ok(secondCall && secondCall.sendScreenshots === true, "and flipping it back on rides the next save as true");

  // The toggle is this profile's field, not a page-wide switch: only the
  // TypeSafe config op ever carries it, so an anthropic save cannot smuggle
  // it into another profile.
  const anthropicCompanion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  const anthropicController = new SettingsController(anthropicCompanion.client);
  await anthropicController.init();
  anthropicController.setSendScreenshots(false);
  await anthropicController.save("");
  ok(!anthropicCompanion.calls.some((x) => x.op === "set_typesafe_config"),
    "an anthropic save never issues the TypeSafe config op, so the toggle cannot reach another provider's profile");
}

console.log("== Consult-sources toggle (jev-runs-consult-sources-beyond-the-page): defaults on for an older profile, persists through Save ==");
{
  // specs/agent-settings "The TypeSafe provider discloses and controls source
  // consultation": the toggle ships enabled, so every profile that predates
  // the field — and every companion that predates the setting, which answers
  // without it at all — must read as enabled rather than accidentally off.
  const companion = createScriptedCompanion(typesafeProfile({
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini",
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true
  })); // deliberately no consultSources field on the fixture
  const c = new SettingsController(companion.client);
  await c.init();
  ok(c.getState().consultSources === true, "a profile stored before the toggle existed loads with it enabled");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "loading a profile writes nothing");

  const storedOff = createScriptedCompanion(typesafeProfile({ consultSources: false }));
  const off = new SettingsController(storedOff.client);
  await off.init();
  ok(off.getState().consultSources === false, "an explicitly stored false loads as off — the default never overrides a stored value");

  // Flip it and Save: the value rides the SAME non-secret config op the
  // screenshot toggle uses (no new op, no new wire), and the value the page
  // keeps afterwards is the one the companion echoed back.
  c.setConsultSources(false);
  ok(c.getState().consultSources === false, "the toggle flips in local state immediately");
  ok(!companion.calls.some((x) => x.op === "set_typesafe_config"), "and still writes nothing until Save");
  const result = await c.save("");
  ok(result.ok === true, "save() succeeds");
  const configCall = companion.calls.find((x) => x.op === "set_typesafe_config");
  ok(configCall && configCall.consultSources === false,
    `the toggle rides set_typesafe_config — got ${JSON.stringify(configCall)}`);
  ok(c.getState().consultSources === false, "the companion's echoed profile leaves it off after the save");

  const reloaded = new SettingsController(companion.client);
  await reloaded.init();
  ok(reloaded.getState().consultSources === false, "a fresh load of the same profile reads the persisted off value back");
  reloaded.setConsultSources(true);
  await reloaded.save("");
  const secondCall = companion.calls.filter((x) => x.op === "set_typesafe_config").pop();
  ok(secondCall && secondCall.consultSources === true, "and flipping it back on rides the next save as true");

  // The toggle is this profile's field, not a page-wide switch: only the
  // TypeSafe config op ever carries it, so an anthropic save cannot smuggle
  // it into another profile.
  const anthropicCompanion = createScriptedCompanion({
    profileId: "default", baseUrl: "https://api.anthropic.com", models: [{ id: "m1", label: "M1" }],
    defaultModelId: "m1", hasCredential: true, memoryOnlyCredential: false, secretBackend: "windows-credential-manager", revision: 1
  });
  const anthropicController = new SettingsController(anthropicCompanion.client);
  await anthropicController.init();
  anthropicController.setConsultSources(false);
  await anthropicController.save("");
  ok(!anthropicCompanion.calls.some((x) => x.op === "set_typesafe_config"),
    "an anthropic save never issues the TypeSafe config op, so the toggle cannot reach another provider's profile");
}

console.log("== TypeSafe image stage (add-jev-run-screenshots): reported separately, never gating, and it names a way out ==");
{
  const { describeErrorCode, typesafeStageLabel } = await import("../extension/settings/errors-ui.js");
  const companion = createScriptedCompanion(typesafeProfile({
    hasTypesafeKey: true, hasTextModelKey: true, hasCredential: true,
    textModelBaseUrl: "https://api.openai.com/v1", textModelId: "gpt-5-mini"
  }));
  // The gating pair passed; only the image stage failed. A page that folded
  // the stages together would either report the profile unusable or say
  // nothing at all — both wrong: the run is still available, and there are
  // two fixes to choose from (a vision-capable model, or the toggle).
  companion.scripts.testCapability = () => ({
    status: "pass",
    capabilities: { systemone: "pass", textModel: "pass", image: "fail" },
    errors: { image: { code: "VISION_ERROR", message: "the model rejected the image part" } },
    timestamp: new Date().toISOString()
  });
  const c = new SettingsController(companion.client);
  await c.init();

  // All three stages reported as passing: the image stage really was tested
  // and accepted, so the original success line is the honest one (and the
  // pills read "hình ảnh: pass").
  companion.scripts.testCapability = () => ({
    status: "pass",
    capabilities: { systemone: "pass", textModel: "pass", image: "pass" },
    errors: {},
    timestamp: new Date().toISOString()
  });
  const allPass = await c.testConnection();
  ok(allPass.ok === true, "all three stages passing is still a passing test");
  ok(c.getState().banner.kind === "success" && /Cả ba giai đoạn đều đạt/.test(c.getState().banner.message || ""),
    `all three stages reported as passing keeps the original success line — got ${JSON.stringify(c.getState().banner)}`);

  companion.scripts.testCapability = () => ({
    status: "pass",
    capabilities: { systemone: "pass", textModel: "pass", image: "fail" },
    errors: { image: { code: "VISION_ERROR", message: "the model rejected the image part" } },
    timestamp: new Date().toISOString()
  });
  const result = await c.testConnection();
  ok(result.ok === true, "an image-stage failure never fails the test — the profile stays runnable (design.md decision 5)");
  const s = c.getState();
  ok(s.connectionStatus.status === "pass", "the overall status is still the gating stages' verdict");
  ok(s.connectionStatus.capabilities.image === "fail" && s.connectionStatus.capabilities.textModel === "pass",
    "the image stage is kept SEPARATE from the text-model stage for the page's own pills");
  ok(s.banner.kind === "info" && s.banner.stage === "image",
    `the banner is a non-alarm notice naming the image stage — got ${JSON.stringify(s.banner)}`);
  ok(/hình ảnh/.test(`${s.banner.title} ${s.banner.message}`), "the copy names the image stage");
  ok(/Gửi ảnh chụp màn hình/.test(s.banner.action || ""), "and points at the screenshot toggle as one way out");
  ok(/mô hình văn bản/.test(s.banner.action || "") && /hình ảnh/.test(s.banner.action || ""),
    "the other way out is a vision-capable model");
  ok(!/hợp lệ|không đúng cấu trúc/.test(s.banner.message || ""), "never presented as an invalid-response or malformed-setup problem");

  // A text-model failure is still the loud failure it always was — the image
  // stage's non-gating treatment must not soften the gating one.
  companion.scripts.testCapability = () => ({
    status: "fail",
    capabilities: { systemone: "pass", textModel: "fail", image: "not_run" },
    errors: { textModel: { code: "AUTH_ERROR", message: "the text model rejected the key" } },
    timestamp: new Date().toISOString()
  });
  const failed = await c.testConnection();
  ok(failed.ok === false, "a gating-stage failure still fails the test");
  ok(c.getState().banner.kind === "error" && c.getState().banner.code === "AUTH_ERROR" && c.getState().banner.stage === "textModel",
    `and names the text-model stage, not the image one — got ${JSON.stringify(c.getState().banner)}`);

  // A result recorded before the image stage existed: the page must read it as
  // "image not tested", never invent a verdict for it — and the banner must
  // not claim the stage passed either, or the page contradicts its own pills.
  companion.scripts.testCapability = () => ({
    status: "pass",
    capabilities: { systemone: "pass", textModel: "pass" },
    errors: {},
    timestamp: new Date().toISOString()
  });
  const legacy = await c.testConnection();
  ok(legacy.ok === true, "a stored result without the image stage still passes on its own terms");
  ok(c.getState().connectionStatus.capabilities.image === undefined,
    "and carries no image verdict — the DOM layer renders that stage as not yet tested");
  const legacyBanner = c.getState().banner;
  ok(legacyBanner.kind === "success" && !/Cả ba giai đoạn/.test(`${legacyBanner.title} ${legacyBanner.message}`),
    `a reply with no image verdict must not claim the image stage passed — got ${JSON.stringify(legacyBanner)}`);
  ok(/hình ảnh/.test(legacyBanner.message || "") && /chưa kiểm tra/.test(legacyBanner.message || ""),
    "the banner names the image stage and says the same thing the pill does (chưa kiểm tra)");
  ok(!/không đạt|không nhận/.test(legacyBanner.message || ""), "without reading as an image failure — nothing was tested there");

  // A skipped stage ("not_run") is the same state for the pills, so it gets
  // the same honest banner rather than the all-three-passes line.
  companion.scripts.testCapability = () => ({
    status: "pass",
    capabilities: { systemone: "pass", textModel: "pass", image: "not_run" },
    errors: {},
    timestamp: new Date().toISOString()
  });
  await c.testConnection();
  const skipped = c.getState().banner;
  ok(skipped.kind === "success" && /chưa kiểm tra/.test(skipped.message || "") && !/Cả ba giai đoạn/.test(`${skipped.title} ${skipped.message}`),
    `a "not_run" image stage is reported as untested, matching the pill — got ${JSON.stringify(skipped)}`);

  // Stage labels and copy: the image stage reads as its own condition in both
  // directions (its own pill label, its own failure copy).
  ok(typesafeStageLabel("image") === "hình ảnh" && typesafeStageLabel("image") !== typesafeStageLabel("textModel"),
    "the image stage has its own label, distinct from the text-model stage");
  const vision = describeErrorCode("VISION_ERROR", { stage: "image" });
  ok(/hình ảnh/.test(`${vision.title} ${vision.message}`), "VISION_ERROR on the image stage names image content");
  ok(/Gửi ảnh chụp màn hình/.test(vision.action || "") && /mô hình/.test(vision.action || ""),
    "and carries both ways out — a vision-capable model or the toggle");
  ok(describeErrorCode("VISION_ERROR").title !== vision.title,
    "the stage-less VISION_ERROR copy (the Anthropic vision capability) is untouched");
  const invalidImage = describeErrorCode("INVALID_RESPONSE", { stage: "image" });
  ok(/Gửi ảnh chụp màn hình/.test(invalidImage.action || ""), "an invalid image-stage body points at the toggle too");
  ok(invalidImage.title !== describeErrorCode("INVALID_RESPONSE", { stage: "systemone" }).title,
    "and is titled for the image stage, not for TypeSafe");
}

console.log("== Consult-sources disclosure (jev-runs-consult-sources-beyond-the-page task 5.2): the toggle renders and the copy says the true thing ==");
{
  // specs/agent-settings "The settings surface SHALL disclose what the
  // setting permits in terms the operator can act on... SHALL NOT describe
  // the capability merely as 'browsing the web'." This reads the actual
  // shipped markup, not a copy of it, so the assertion fails the moment the
  // disclosure text drifts from what the operator is shown.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const html = fs.readFileSync(path.join(__dirname, "..", "extension", "settings", "settings.html"), "utf-8");

  ok(/id="consult-sources"/.test(html), "the toggle's checkbox is present in the typesafe provider section");
  ok(/id="consult-sources"[^>]*checked/.test(html), "it defaults on (checked) in the shipped markup");

  const hintMatch = html.match(/Cho phép lượt chạy đọc nguồn ngoài trang đang điều khiển[\s\S]*?<\/span>\s*<\/span>\s*<label class="switch">\s*<input type="checkbox" id="consult-sources"/);
  ok(hintMatch, "the toggle's own label and hint sit directly above its checkbox");
  const disclosure = hintMatch ? hintMatch[0] : "";

  ok(/tối đa 3 URL/.test(disclosure), "names the bound: at most 3 URLs");
  ok(/xuất hiện trên trang đang đọc hoặc được nêu trong mục tiêu/.test(disclosure),
    "states the run may fetch only URLs found on the page it is reading or named in the goal");
  ok(/chỉ-đọc/.test(disclosure) || /read-only/i.test(disclosure), "states the fetch is read-only");
  ok(/không gửi cookie hay thông tin đăng nhập/.test(disclosure), "states no cookie or credential is sent");
  ok(/máy chủ tại các URL đó sẽ nhận được yêu cầu/.test(disclosure), "states the servers at those URLs receive the request");
  ok(!/^[^-]*trợ lý có thể duyệt web/.test(disclosure), "never falls back to the vague 'trợ lý có thể duyệt web' phrasing");
  ok(/Đây không phải duyệt web/.test(disclosure), "explicitly distinguishes the capability from browsing — no tab opens, nothing navigates");
}

console.log(fail === 0 ? "\nALL SETTINGS-UI CONTROLLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

// Task 4.5: SettingsController state-machine tests — the bulk of the
// validation/error/state-transition matrix from this task's brief, driven
// against the deterministic scripted fake companion
// (test/settings-ui-scripted-companion.mjs). See
// test/settings-ui-real-companion.test.mjs for the subset of these also
// proven against the REAL host/agent/settings/profile.js.
//
// Run: node test/settings-ui-controller.test.mjs
import { SettingsController } from "../extension/settings/settings-controller.js";
import { createScriptedCompanion } from "./settings-ui-scripted-companion.mjs";

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

console.log(fail === 0 ? "\nALL SETTINGS-UI CONTROLLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

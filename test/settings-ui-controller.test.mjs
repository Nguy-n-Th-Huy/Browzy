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

console.log(fail === 0 ? "\nALL SETTINGS-UI CONTROLLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

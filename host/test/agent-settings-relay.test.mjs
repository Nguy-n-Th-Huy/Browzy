#!/usr/bin/env node
//
// Closes reports/05-panel-evidence.md's "Known gaps" #2 and
// reports/03-companion-evidence.md's protocol-message-catalogue gap:
// extension/settings/settings-client.js and extension/background.js's
// createAgentSettingsRelay() already speak the exact
// `{v, type:"agent_settings", requestId, op, ...payload}` ->
// `{v, type:"agent_settings", requestId, ok, result|error}` wire contract
// (settings-client.js's own file header documents it), but
// host/agent/companion.js had no case for "agent_settings" in its envelope
// switch — every real request dead-ended on the generic
// unknown_message_type fallback. This file proves CompanionCore's new
// _handleAgentSettings() answers EVERY op the client sends, delegating to
// the REAL, already-independently-tested host/agent/settings/profile.js
// (and, transitively, host/agent/secrets/secret-store.js) — not a scripted
// double — with a scratch OCIC_AGENT_CONFIG_DIR/OCIC_AGENT_HOME so nothing
// here ever touches a developer's or this machine's real profile or real OS
// credential store. Every credential set here is memoryOnly:true.
//
// Run: node host/test/agent-settings-relay.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";
import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";

// Isolate every test run's storage under scratch directories — separate
// roots for conversation storage (OCIC_AGENT_HOME) and the settings profile
// (OCIC_AGENT_CONFIG_DIR), matching each module's own env var. Set BEFORE
// anything below dynamically imports host/agent/settings/profile.js (its own
// paths.js reads these lazily on every call, never caches at import time —
// see test/settings-ui-real-companion-harness.mjs's file header for the
// same reasoning).
const scratchAgentHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-settings-relay-agent-"));
const scratchConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-settings-relay-config-"));
process.env.OCIC_AGENT_HOME = scratchAgentHome;
process.env.OCIC_AGENT_CONFIG_DIR = scratchConfigDir;

// Never "default" — host/agent/secrets/secret-store.js's assertSafeCredentialTarget()
// guard refuses to touch a real OS store for the exact target a genuine
// "default" install would use while OCIC_AGENT_CONFIG_DIR is set; every
// credential below is also memoryOnly:true regardless, so this is defense
// in depth, not the only safeguard.
const PROFILE_ID = `agent-settings-relay-test-${process.pid}-${Date.now()}`;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let _reqId = 0;
function nextRequestId() {
  _reqId += 1;
  return `req_${_reqId}`;
}

function agentSettingsEnvelope(op, payload = {}, { v = PROTOCOL_VERSION, requestId = nextRequestId() } = {}) {
  return { v, type: AGENT_MESSAGE_TYPES.AGENT_SETTINGS, requestId, op, ...payload };
}

/** A CompanionCore wired to the REAL settings/profile.js (default lazy
 * import — no settingsProvider override) so the agent_settings handler is
 * exercised end-to-end. `sdk` stays fake/injectable so run-lifecycle tests
 * (credential revocation cancelling an active run) never spawn a real
 * Claude Code CLI process. */
function buildRealSettingsCore({ sdk, chatgptAuthProvider } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || { async *query() {} },
    // Deliberately no profileProvider/settingsProvider override: both
    // default to the REAL host/agent/settings/profile.js module, scoped to
    // the scratch OCIC_AGENT_CONFIG_DIR above. `chatgptAuthProvider` is left
    // undefined for every test above (they never send a ChatGPT op, so the
    // auth module is never imported); only the ChatGPT op tests below inject
    // a fake, so no test here ever binds port 1455 or touches a real OS store.
    ...(chatgptAuthProvider ? { chatgptAuthProvider } : {})
  });
}

console.log("\nagent_settings companion handler (real host/agent/settings/profile.js)\n");

await test("get_profile works with NO prior hello and no active conversation (first-run setup happens before any run exists)", async () => {
  const core = buildRealSettingsCore();
  // No HELLO sent at all — proves _handleAgentSettings is not gated on the
  // session handshake, unlike NEW/START/STOP/LIST_CONVERSATIONS/etc.
  const reply = await core.handleEnvelope(agentSettingsEnvelope("get_profile", { profileId: PROFILE_ID }));
  assert(reply.type === AGENT_MESSAGE_TYPES.AGENT_SETTINGS, "reply must be agent_settings-shaped, not version_mismatch or a generic error");
  assert(reply.ok === true, "a fresh scratch profile is a valid first-run outcome, not a failure");
  assert(reply.result === null, "no profile has been saved yet for this profileId — first-run");
});

await test("save_profile persists atomically (offline, no network) and is reflected in the next get_profile", async () => {
  const core = buildRealSettingsCore();
  const saveReply = await core.handleEnvelope(
    agentSettingsEnvelope("save_profile", {
      profileId: PROFILE_ID,
      baseUrl: "https://api.example-provider.invalid",
      models: [{ id: "model-a", label: "Model A" }],
      defaultModelId: "model-a"
    })
  );
  assert(saveReply.ok === true, `save_profile must succeed: ${JSON.stringify(saveReply.error)}`);
  assert(saveReply.result.baseUrl === "https://api.example-provider.invalid", "the normalized base URL must be persisted");
  assert(saveReply.result.defaultModelId === "model-a");

  const getReply = await core.handleEnvelope(agentSettingsEnvelope("get_profile", { profileId: PROFILE_ID }));
  assert(getReply.ok === true);
  assert(getReply.result.models.length === 1 && getReply.result.models[0].id === "model-a", "save must be reflected on the next load");
});

await test("set_credential (memoryOnly) then get_profile shows hasCredential, and NO reply anywhere ever contains the raw key", async () => {
  const core = buildRealSettingsCore();
  const sentinel = `sk-sentinel-${crypto_randomHex()}`;

  // Self-contained: save this test's own profile first rather than relying
  // on a preceding test's leftover state (the on-disk profile store is a
  // single file regardless of profileId — see profile-store.js — so
  // ordering between test() blocks must never be load-bearing).
  const saved = await core.handleEnvelope(
    agentSettingsEnvelope("save_profile", { profileId: PROFILE_ID, baseUrl: "https://api.example-provider.invalid", models: [{ id: "model-a", label: "A" }], defaultModelId: "model-a" })
  );
  assert(saved.ok === true, `setup save_profile failed: ${JSON.stringify(saved.error)}`);

  const setReply = await core.handleEnvelope(
    agentSettingsEnvelope("set_credential", { profileId: PROFILE_ID, secret: sentinel, memoryOnly: true })
  );
  assert(setReply.ok === true, `set_credential must succeed: ${JSON.stringify(setReply.error)}`);
  assert(setReply.result.backend === "memory", "memoryOnly:true must use the memory backend");
  assert(JSON.stringify(setReply).indexOf(sentinel) === -1, "the set_credential reply must never echo the key back");

  const getReply = await core.handleEnvelope(agentSettingsEnvelope("get_profile", { profileId: PROFILE_ID }));
  assert(getReply.result.hasCredential === true, "a saved credential must be reflected as hasCredential:true");
  assert(getReply.result.memoryOnlyCredential === true);
  assert(JSON.stringify(getReply).indexOf(sentinel) === -1, "get_profile must never contain the raw key — only whether one is saved");
});

await test("export_profile is redacted — never contains the secret", async () => {
  const core = buildRealSettingsCore();
  const sentinel = `sk-sentinel-export-${crypto_randomHex()}`;
  await core.handleEnvelope(agentSettingsEnvelope("save_profile", { profileId: PROFILE_ID, baseUrl: "https://api.example-provider.invalid", models: [], defaultModelId: null }));
  await core.handleEnvelope(agentSettingsEnvelope("set_credential", { profileId: PROFILE_ID, secret: sentinel, memoryOnly: true }));

  const exportReply = await core.handleEnvelope(agentSettingsEnvelope("export_profile", { profileId: PROFILE_ID }));
  assert(exportReply.ok === true);
  assert(JSON.stringify(exportReply).indexOf(sentinel) === -1, "export_profile must never leak the raw secret");
});

await test("remove_credential clears hasCredential and cancels an active run using that profile (onCredentialRevoked wiring)", async () => {
  const core = buildRealSettingsCore({
    sdk: {
      async *query() {
        // Deliberately NOT abort-aware and long enough to outlast this
        // test's own assertions and process.exit() — matches the existing
        // convention in agent-companion-core.test.mjs's own "queued"/"stop"
        // tests (a fake sdk.query() here only needs to still be "running"
        // when the assertions run, not to ever actually settle).
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  });

  // Save a profile + memory-only credential for THIS run to use.
  await core.handleEnvelope(
    agentSettingsEnvelope("save_profile", { profileId: PROFILE_ID, baseUrl: "https://api.example-provider.invalid", models: [{ id: "model-a", label: "A" }], defaultModelId: "model-a" })
  );
  await core.handleEnvelope(agentSettingsEnvelope("set_credential", { profileId: PROFILE_ID, secret: "sk-revoke-me", memoryOnly: true }));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const startReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: PROFILE_ID, modelId: "model-a", prompt: "hi" })
  );
  assert(startReply.accepted, "the run must start (real credential resolved through the real profile.js snapshotForRun)");

  // Let the run actually reach RUNNING (lease is uncontended, resolves fast).
  await new Promise((r) => setTimeout(r, 30));
  assert(core.sessionManager.hasActiveRun(conversationId), "the run must be active before revocation for this test to be meaningful");

  const removeReply = await core.handleEnvelope(agentSettingsEnvelope("remove_credential", { profileId: PROFILE_ID }));
  assert(removeReply.ok === true, `remove_credential must succeed: ${JSON.stringify(removeReply.error)}`);
  assert(removeReply.result.removed === true);
  assert(JSON.stringify(removeReply).indexOf("sk-revoke-me") === -1, "remove_credential's reply must never contain the removed key");

  assert(!core.sessionManager.hasActiveRun(conversationId), "the active run using the revoked profile must be cancelled synchronously");
  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  const errorEvent = snap.events.find((e) => e.type === "run_error" && e.reason === "credential_revoked");
  assert(errorEvent, "a credential_revoked run_error event must be recorded (never a silent cancellation)");
  assert(snap.events.some((e) => e.type === "run_stopped" && e.reason === "credential_revoked"), "the run must be reported stopped, with the specific reason");

  const getReply = await core.handleEnvelope(agentSettingsEnvelope("get_profile", { profileId: PROFILE_ID }));
  assert(getReply.result.hasCredential === false, "the profile must reflect the credential is gone");

  core.dispose();
});

await test("discover_models (real fixture HTTP server, real pagination) preserves a manual entry and merges discovered ones", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    const discoverProfileId = `${PROFILE_ID}-discovery`;
    await core_save_and_credential(discoverProfileId, fixture.url, [{ id: "manual-model", label: "Manual Model" }], "manual-model");
    const core = buildRealSettingsCore();
    const reply = await core.handleEnvelope(agentSettingsEnvelope("discover_models", { profileId: discoverProfileId }));
    assert(reply.ok === true, `discover_models must succeed: ${JSON.stringify(reply.error)}`);
    assert(reply.result.supported === true, "the fixture server implements /v1/models");
    const ids = reply.result.models.map((m) => m.id).sort();
    assert(ids.includes("manual-model"), "a manual entry discovery didn't return must be preserved");
    assert(ids.includes("fixture-model-a") && ids.includes("fixture-model-b"), "both fixture pages must be merged in");
  } finally {
    await fixture.close();
  }
});

await test("test_capability (real fixture HTTP server, real SDK wire protocol) reports a full pass", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    const capProfileId = `${PROFILE_ID}-capability`;
    await core_save_and_credential(capProfileId, fixture.url, [{ id: "fixture-model", label: "Fixture Model" }], "fixture-model");
    const core = buildRealSettingsCore();
    const reply = await core.handleEnvelope(agentSettingsEnvelope("test_capability", { profileId: capProfileId, modelId: "fixture-model" }));
    assert(reply.ok === true, `test_capability must succeed: ${JSON.stringify(reply.error)}`);
    assert(reply.result.status === "pass", `expected a full pass against the well-behaved fixture, got ${JSON.stringify(reply.result)}`);
    assert(reply.result.capabilities.text === "pass" && reply.result.capabilities.tool === "pass" && reply.result.capabilities.vision === "pass");
  } finally {
    await fixture.close();
  }
});

await test("an unknown agent_settings op is a structured PROTOCOL_ERROR, not a crash or a fabricated success", async () => {
  const core = buildRealSettingsCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("totally_made_up_op", { profileId: PROFILE_ID }));
  assert(reply.ok === false);
  assert(reply.error.code === "PROTOCOL_ERROR");
});

await test("an unsupported protocol version on agent_settings fails closed WITHOUT hanging the relay (settled in the same agent_settings-shaped envelope, requestId echoed)", async () => {
  const core = buildRealSettingsCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("get_profile", { profileId: PROFILE_ID }, { v: 999999, requestId: "req_version_test" }));
  assert(reply.type === AGENT_MESSAGE_TYPES.AGENT_SETTINGS, "the failure must be recognizable by background.js's relay (agent_settings-shaped), never a generic version_mismatch envelope it cannot settle");
  assert(reply.requestId === "req_version_test", "requestId must be echoed so the relay settles the exact pending request");
  assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR");
});

await test("a missing protocol version on agent_settings also fails closed", async () => {
  const core = buildRealSettingsCore();
  const envelope = agentSettingsEnvelope("get_profile", { profileId: PROFILE_ID });
  delete envelope.v;
  const reply = await core.handleEnvelope(envelope);
  assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR", "a missing version must never be assumed to be the current one");
});

// --- ChatGPT subscription provider ops (Batch E1 host protocol) -----------
//
// These drive the six new agent_settings ops through CompanionCore's real
// _handleAgentSettings() dispatcher, with the REAL settings/profile.js (so
// set_provider_type/chatgpt_sign_out persist and reload for real) and an
// INJECTED chatgptAuthProvider double (so no op here ever binds port 1455 or
// touches a real OS credential store). The double stands in for
// host/agent/chatgpt/auth.js — whose own behaviour is independently covered by
// chatgpt-auth.test.mjs — leaving these checks about the PROTOCOL layer only:
// the exact reply shapes the Batch E2 wire contract promises the extension,
// the input validation, the error-code mapping, and that no token ever crosses
// the wire.

// A configurable fake of auth.js's default-instance surface. Each ChatGPT op's
// companion case calls exactly one of these; the returned values are shaped to
// the auth contract so the dispatcher's field-projection is observable.
function makeFakeAuth(overrides = {}) {
  const calls = [];
  const base = {
    _calls: calls,
    startBrowserSignIn: async ({ profileId, memoryOnly }) => {
      calls.push(["startBrowserSignIn", profileId, memoryOnly]);
      return { signInId: "sign-in-1", authUrl: "https://auth.openai.com/oauth/authorize?x=1" };
    },
    startDeviceSignIn: async ({ profileId, memoryOnly }) => {
      calls.push(["startDeviceSignIn", profileId, memoryOnly]);
      return { signInId: "sign-in-2", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device", expiresAt: 1_800_000_000_000 };
    },
    getSignInStatus: (signInId) => {
      calls.push(["getSignInStatus", signInId]);
      return { state: "pending" };
    },
    cancelSignIn: async (signInId) => {
      calls.push(["cancelSignIn", signInId]);
    },
    signOut: async (profileId) => {
      calls.push(["signOut", profileId]);
    }
  };
  return { ...base, ...overrides };
}

await test("set_provider_type persists the switch through the real profile.js and replies the updated secret-free profile", async () => {
  const core = buildRealSettingsCore();
  await core.handleEnvelope(
    agentSettingsEnvelope("save_profile", { profileId: PROFILE_ID, baseUrl: "https://api.example-provider.invalid", models: [{ id: "m", label: "M" }], defaultModelId: "m" })
  );
  const reply = await core.handleEnvelope(agentSettingsEnvelope("set_provider_type", { profileId: PROFILE_ID, providerType: "chatgpt" }));
  assert(reply.ok === true, `set_provider_type must succeed: ${JSON.stringify(reply.error)}`);
  assert(reply.result.providerType === "chatgpt", "the reply is the updated profile (its providerType field flipped)");
  // The non-secret baseUrl must survive the switch untouched (rollback safety —
  // a chatgpt profile keeps a valid baseUrl so old code reports NO_CREDENTIAL).
  assert(reply.result.baseUrl === "https://api.example-provider.invalid", "set_provider_type never disturbs the other profile fields");
  assert(!("secret" in reply.result) && !("apiKey" in reply.result), "the profile reply carries no credential field");
});

await test("set_provider_type with an unknown providerType is INVALID_PROFILE, never persisted", async () => {
  const core = buildRealSettingsCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("set_provider_type", { profileId: PROFILE_ID, providerType: "openai" }));
  assert(reply.ok === false && reply.error.code === "INVALID_PROFILE", `expected INVALID_PROFILE, got ${JSON.stringify(reply.error)}`);
});

await test("set_provider_type without a profileId is a PROTOCOL_ERROR", async () => {
  const core = buildRealSettingsCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("set_provider_type", { providerType: "chatgpt" }));
  assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR");
});

await test("chatgpt_sign_in_start replies {signInId, authUrl} ONLY (no profile, no token) and forwards the profileId to auth", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_start", { profileId: PROFILE_ID }));
  assert(reply.ok === true, `chatgpt_sign_in_start must succeed: ${JSON.stringify(reply.error)}`);
  assert(reply.result.signInId === "sign-in-1" && reply.result.authUrl.startsWith("https://auth.openai.com/"), "reply is exactly {signInId, authUrl}");
  assert(!("profile" in reply.result) && !("models" in reply.result), "the start reply never includes the profile object (E2 hard rule)");
  assert(auth._calls.some((c) => c[0] === "startBrowserSignIn" && c[1] === PROFILE_ID), "auth.startBrowserSignIn got the profileId");
});

await test("chatgpt_sign_in_start / chatgpt_device_start forward the memory-only choice and default it to false", async () => {
  // The user-confirmed memory-only retry after SECURE_STORAGE_UNAVAILABLE
  // (specs/agent-settings "Secret isolation") must reach auth.js, which
  // already supports it end to end (never writes the refresh credential to
  // the OS store, records the backend as "memory").
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });

  await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_start", { profileId: PROFILE_ID, memoryOnly: true }));
  let call = auth._calls.find((c) => c[0] === "startBrowserSignIn");
  assert(call && call[2] === true, `auth.startBrowserSignIn must receive memoryOnly:true — got ${JSON.stringify(call)}`);

  await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_start", { profileId: PROFILE_ID }));
  call = auth._calls.filter((c) => c[0] === "startBrowserSignIn")[1];
  assert(call && call[2] === false, `an ordinary sign-in must carry memoryOnly:false, never undefined — got ${JSON.stringify(call)}`);

  await core.handleEnvelope(agentSettingsEnvelope("chatgpt_device_start", { profileId: PROFILE_ID, memoryOnly: true }));
  call = auth._calls.find((c) => c[0] === "startDeviceSignIn");
  assert(call && call[2] === true, `auth.startDeviceSignIn must receive memoryOnly:true — got ${JSON.stringify(call)}`);

  await core.handleEnvelope(agentSettingsEnvelope("chatgpt_device_start", { profileId: PROFILE_ID }));
  call = auth._calls.filter((c) => c[0] === "startDeviceSignIn")[1];
  assert(call && call[2] === false, `an ordinary device sign-in must carry memoryOnly:false — got ${JSON.stringify(call)}`);

  // The reply shapes are unchanged by the flag — still no profile, no token.
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_start", { profileId: PROFILE_ID, memoryOnly: true }));
  assert(reply.ok === true && reply.result.signInId === "sign-in-1" && !("memoryOnly" in reply.result), "the start reply stays exactly {signInId, authUrl}");
});

await test("chatgpt_sign_in_start / chatgpt_device_start reject a non-boolean memoryOnly before auth is ever called", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  for (const [op, badValue] of [
    ["chatgpt_sign_in_start", "true"],
    ["chatgpt_device_start", 1]
  ]) {
    const reply = await core.handleEnvelope(agentSettingsEnvelope(op, { profileId: PROFILE_ID, memoryOnly: badValue }));
    assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR", `${op} with memoryOnly ${JSON.stringify(badValue)} must be PROTOCOL_ERROR, got ${JSON.stringify(reply.error)}`);
  }
  assert(auth._calls.length === 0, `auth must not be invoked for a malformed memoryOnly — got ${JSON.stringify(auth._calls)}`);
});

await test("chatgpt_device_start replies {signInId, userCode, verificationUrl, expiresAt} with expiresAt an epoch-ms number", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_device_start", { profileId: PROFILE_ID }));
  assert(reply.ok === true, `chatgpt_device_start must succeed: ${JSON.stringify(reply.error)}`);
  assert(reply.result.userCode === "ABCD-EFGH", "the user code is returned for display");
  assert(typeof reply.result.expiresAt === "number", "expiresAt crosses as an epoch-ms number, not a Date/ISO string");
});

await test("chatgpt_sign_in_status forwards each auth state verbatim: pending / signed_in(account) / failed(code)", async () => {
  const cases = [
    [{ state: "pending" }, (r) => r.state === "pending"],
    [{ state: "signed_in", account: { email: "u@example.com", planType: "plus" } }, (r) => r.state === "signed_in" && r.account.email === "u@example.com" && r.account.planType === "plus"],
    [{ state: "failed", code: "SIGN_IN_TIMEOUT", message: "timed out" }, (r) => r.state === "failed" && r.code === "SIGN_IN_TIMEOUT"]
  ];
  for (const [status, check] of cases) {
    const auth = makeFakeAuth({ getSignInStatus: () => status });
    const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
    const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_status", { signInId: "sign-in-x" }));
    assert(reply.ok === true, `status must succeed: ${JSON.stringify(reply.error)}`);
    assert(check(reply.result), `the ${status.state} status is passed through unchanged`);
  }
});

await test("chatgpt_sign_in_status keyed by signInId ONLY — a request with no profileId still works", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_status", { signInId: "only-signin" }));
  assert(reply.ok === true && reply.result.state === "pending");
  assert(auth._calls.some((c) => c[0] === "getSignInStatus" && c[1] === "only-signin"), "auth got the signInId, not a profileId");
});

await test("chatgpt_sign_in_status for an unknown signInId (auth throws a codeless Error) is PROTOCOL_ERROR, not NETWORK_ERROR", async () => {
  // Mirrors auth.js: getSignInStatus throws a plain Error for an
  // unknown/pruned sign-in id. Without the dispatcher's explicit mapping the
  // outer catch would label it NETWORK_ERROR (a misleading "network failed").
  const auth = makeFakeAuth({
    getSignInStatus: () => {
      throw new Error("unknown ChatGPT sign-in id: nope");
    }
  });
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_status", { signInId: "nope" }));
  assert(reply.ok === false, "an unknown sign-in id is a failure, not a fabricated pending");
  assert(reply.error.code === "PROTOCOL_ERROR", `expected PROTOCOL_ERROR, got ${JSON.stringify(reply.error)}`);
});

await test("chatgpt_sign_in_status WITHOUT a signInId is a PROTOCOL_ERROR before auth is ever called", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_status", {}));
  assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR");
  assert(!auth._calls.some((c) => c[0] === "getSignInStatus"), "auth must not be invoked for a malformed request");
});

await test("chatgpt_sign_in_cancel replies {cancelled:true}", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_cancel", { signInId: "sign-in-1" }));
  assert(reply.ok === true && reply.result.cancelled === true);
  assert(auth._calls.some((c) => c[0] === "cancelSignIn" && c[1] === "sign-in-1"));
});

await test("chatgpt_sign_out calls auth.signOut and replies the fresh secret-free profile", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const saved = await core.handleEnvelope(
    agentSettingsEnvelope("save_profile", { profileId: PROFILE_ID, baseUrl: "https://api.example-provider.invalid", models: [{ id: "m", label: "M" }], defaultModelId: "m" })
  );
  assert(saved.ok === true, `setup save_profile failed: ${JSON.stringify(saved.error)}`);
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_out", { profileId: PROFILE_ID }));
  assert(reply.ok === true, `chatgpt_sign_out must succeed: ${JSON.stringify(reply.error)}`);
  assert(reply.result && reply.result.profileId === PROFILE_ID, "sign-out replies the reloaded profile so background.js can mirror it");
  assert(!("accessToken" in reply.result) && !("refresh_token" in reply.result), "no token field on the sign-out profile reply");
  assert(!/access_token|refresh_token|id_token/i.test(JSON.stringify(reply)), "no serialized token appears anywhere in the sign-out reply");
  assert(auth._calls.some((c) => c[0] === "signOut" && c[1] === PROFILE_ID));
});

await test("chatgpt_sign_out without a profileId is a PROTOCOL_ERROR and never calls auth", async () => {
  const auth = makeFakeAuth();
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_out", {}));
  assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR");
  assert(!auth._calls.some((c) => c[0] === "signOut"));
});

await test("a start reply that DID carry a token field fails closed (secret-free scan) rather than emit it", async () => {
  // The dispatcher destructures known fields only, so a well-behaved auth.js
  // never leaks — but a future auth that returned MORE must still be blocked.
  // Here the injected double returns the known fields PLUS an accessToken, and
  // the reply is built by field projection, so the token is dropped even before
  // the scan. Assert the scan + projection jointly keep it off the wire.
  const auth = makeFakeAuth({
    startBrowserSignIn: async () => ({ signInId: "s", authUrl: "https://x", accessToken: "SECRET-TOKEN-XYZ", refreshToken: "SECRET-REF-XYZ" })
  });
  const core = buildRealSettingsCore({ chatgptAuthProvider: auth });
  const reply = await core.handleEnvelope(agentSettingsEnvelope("chatgpt_sign_in_start", { profileId: PROFILE_ID }));
  assert(JSON.stringify(reply).indexOf("SECRET-TOKEN-XYZ") === -1, "an accessToken must never appear in the reply");
  assert(JSON.stringify(reply).indexOf("SECRET-REF-XYZ") === -1, "a refreshToken must never appear in the reply");
});

// --- test helpers ----------------------------------------------------------

function crypto_randomHex() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function core_save_and_credential(profileId, baseUrl, models, defaultModelId) {
  const core = buildRealSettingsCore();
  const saveReply = await core.handleEnvelope(agentSettingsEnvelope("save_profile", { profileId, baseUrl, models, defaultModelId }));
  if (!saveReply.ok) throw new Error(`setup save_profile failed: ${JSON.stringify(saveReply.error)}`);
  const credReply = await core.handleEnvelope(agentSettingsEnvelope("set_credential", { profileId, secret: "sk-fixture", memoryOnly: true }));
  if (!credReply.ok) throw new Error(`setup set_credential failed: ${JSON.stringify(credReply.error)}`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);

try {
  fs.rmSync(scratchAgentHome, { recursive: true, force: true });
  fs.rmSync(scratchConfigDir, { recursive: true, force: true });
} catch {}
delete process.env.OCIC_AGENT_HOME;
delete process.env.OCIC_AGENT_CONFIG_DIR;

process.exit(failed.length ? 1 : 0);

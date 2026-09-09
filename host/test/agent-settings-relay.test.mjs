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
function buildRealSettingsCore({ sdk } = {}) {
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
    sdk: sdk || { async *query() {} }
    // Deliberately no profileProvider/settingsProvider override: both
    // default to the REAL host/agent/settings/profile.js module, scoped to
    // the scratch OCIC_AGENT_CONFIG_DIR above.
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

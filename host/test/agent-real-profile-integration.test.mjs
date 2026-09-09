#!/usr/bin/env node
//
// Integration test against the REAL host/agent/settings/profile.js (group
// 4's module, which landed in this working tree during this session — see
// reports/03-companion-evidence.md for the documented contract this was
// coded against before it existed). Proves the "consume, don't implement"
// interface actually works end to end: host/agent/tools/query-options.js's
// resolveProfileSnapshot(), with NO profileProvider override, genuinely
// resolves through the real module — both the failure path (no credential
// configured — the realistic state in this sandboxed session) and the
// success path (a memory-only credential, entirely offline, no OS keychain
// dependency and no live network call).
//
// Run: node host/test/agent-real-profile-integration.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate this test's profile from a developer's real ~/.config profile.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-real-profile-"));
process.env.OCIC_AGENT_CONFIG_DIR = scratchDir;

const { resolveProfileSnapshot, ProfileUnavailableError } = await import("../agent/tools/query-options.js");
const profileModule = await import("../agent/settings/profile.js");

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

console.log("\nReal host/agent/settings/profile.js integration\n");

await test("with no profile configured, resolveProfileSnapshot() throws the documented typed error (real module, no double)", async () => {
  let threw = null;
  try {
    await resolveProfileSnapshot({ profileId: "default", modelId: "whatever" });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof ProfileUnavailableError, "must be the documented typed error, not a raw crash");
  assert(/no credential/i.test(threw.message) || /no profile/i.test(threw.message), `unexpected message: ${threw.message}`);
});

await test("with a real profile + memory-only credential, resolveProfileSnapshot() returns the exact documented shape", async () => {
  await profileModule.saveProfile({
    profileId: "default",
    baseUrl: "https://example.invalid",
    models: [{ id: "claude-test-model", label: "Test model" }],
    defaultModelId: "claude-test-model"
  });
  await profileModule.setCredential("default", "sk-test-fake-key-not-real", { memoryOnly: true });

  const snapshot = await resolveProfileSnapshot({ profileId: "default", modelId: "claude-test-model" });
  assert(snapshot.model === "claude-test-model", "model must round-trip");
  assert(snapshot.env.ANTHROPIC_BASE_URL === "https://example.invalid", "base URL must round-trip");
  assert(snapshot.env.ANTHROPIC_API_KEY === "sk-test-fake-key-not-real", "credential must round-trip");
  assert(typeof snapshot.revision === "number", "revision must be present");
  assert(snapshot.profileId === "default", "profileId must round-trip");

  // Clean up so this test does not leak a lingering credential into any
  // later test process sharing this OS user's memory-backed store.
  await profileModule.removeCredential("default");
});

await test("CompanionCore's default profileProvider (no override) resolves through the real module end to end", async () => {
  const { CompanionCore } = await import("../agent/companion.js");
  const { TranscriptStore } = await import("../agent/storage/transcript-store.js");
  const { BrowserLease } = await import("../agent/broker/browser-lease.js");
  const { ApprovalRegistry } = await import("../agent/policy/approvals.js");
  const { SessionManager } = await import("../agent/session/manager.js");
  const { ToolBridge } = await import("../agent/broker/tool-bridge.js");
  const { AGENT_MESSAGE_TYPES, makeEnvelope } = await import("../agent/protocol.js");

  const agentScratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-real-profile-agent-"));
  process.env.OCIC_AGENT_HOME = agentScratch;

  await profileModule.saveProfile({
    profileId: "default",
    baseUrl: "https://example.invalid",
    models: [{ id: "claude-test-model", label: "Test model" }],
    defaultModelId: "claude-test-model"
  });
  await profileModule.setCredential("default", "sk-another-fake-key", { memoryOnly: true });

  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async () => ({ content: [] }), shutdown: () => {} });
  let sawModel = null;
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: {
      async *query({ options }) {
        sawModel = options.model;
        assert(options.env.ANTHROPIC_API_KEY === "sk-another-fake-key", "the real snapshot's key must reach query() options");
      }
    }
    // profileProvider intentionally omitted: this is the production default path.
  });

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "default", modelId: "claude-test-model", prompt: "hi" })
  );
  await new Promise((r) => setTimeout(r, 80));
  assert(sawModel === "claude-test-model", "the real profile's model must reach the SDK query() options with zero code change on this side");

  await profileModule.removeCredential("default");
  fs.rmSync(agentScratch, { recursive: true, force: true });
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);

try {
  fs.rmSync(scratchDir, { recursive: true, force: true });
} catch {}

process.exit(failed.length ? 1 : 0);

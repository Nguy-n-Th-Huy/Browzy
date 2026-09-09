#!/usr/bin/env node
//
// Closes the last functional gap reports/07-skills-ui-evidence.md documented:
// extension/settings/skills-client.js and extension/sidepanel/skills-client.js
// already speak a documented `{type:"agent_settings", op:"skills_*", ...}`
// wire contract (see each file's own header for the exact op names and
// payload/result shapes), but host/agent/companion.js's `_handleAgentSettings()`
// had no `skills_*` case — every real call dead-ended on the
// `unknown agent_settings op` fallback. This suite proves the new case
// branches answer every op the two clients actually send, delegating
// straight to the REAL, already-independently-tested
// host/agent/skills/{manage,import}.js — not a scripted double — against
// real temp-directory fixtures on disk (valid, malformed, duplicate-named,
// traversal-attempting, symlink-escaping, script-requiring). No live SDK,
// browser, or credential is used anywhere: `sdk` stays a fake/injectable
// recorder (same pattern as host/test/agent-skills-wiring.test.mjs), and a
// scratch OCIC_AGENT_HOME/OCIC_AGENT_CONFIG_DIR isolates every case from a
// developer's or this machine's real catalog/profile store.
//
// Run: node host/test/agent-skills-ops.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
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

// Mirrors extension/settings/skills-client.js's / extension/sidepanel/
// skills-client.js's outgoing message shape exactly:
// `{ type: "agent_settings", op, ...payload }` — wrapped here with the
// envelope fields makeEnvelope()/handleEnvelope() require, matching
// host/test/agent-settings-relay.test.mjs's own helper.
function agentSettingsEnvelope(op, payload = {}, { v = PROTOCOL_VERSION, requestId = nextRequestId() } = {}) {
  return { v, type: AGENT_MESSAGE_TYPES.AGENT_SETTINGS, requestId, op, ...payload };
}

function freshHome() {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-ops-agent-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-ops-config-"));
  process.env.OCIC_AGENT_HOME = agentHome;
  process.env.OCIC_AGENT_CONFIG_DIR = configDir;
  return agentHome;
}

function writeFixture(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function defaultFrontmatter(name, description = "A demo skill for op tests.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function makeSkillDir(frontmatter, extra = {}, bodyTag = "ops") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ocic-skills-ops-src-${bodyTag}-`));
  writeFixture(root, { "SKILL.md": `${frontmatter}\n# Body\n`, ...extra });
  return root;
}

// Same NTFS-junction technique host/test/skills-catalog.test.mjs uses to
// exercise a symlink escape with no elevation needed on Windows.
function createEscapingDirLink(linkPath, targetDir) {
  fs.symlinkSync(path.resolve(targetDir), linkPath, "junction");
}

// Records every query() call's options/prompt; yields immediately unless
// blockUntilReleased is set (used to keep a run "active" while a
// skills_refresh op is issued mid-run).
function recordingSdk({ blockUntilReleased = false } = {}) {
  const calls = [];
  let release = () => {};
  const gate = blockUntilReleased ? new Promise((res) => (release = res)) : Promise.resolve();
  const sdk = {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      await gate;
      yield { type: "assistant", text: "ok" };
    }
  };
  return { sdk, calls, release };
}

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

function buildCore({ sdk, profileProvider } = {}) {
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
    sdk: sdk || recordingSdk().sdk,
    profileProvider: profileProvider || fakeProfileProvider()
  });
}

async function waitForEvent(core, conversationId, predicate, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = core.sessionManager.snapshotSince(conversationId, 0);
    const found = snap.events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for expected event");
}

console.log("\nagent_settings companion handler — skills_* ops (closes the Settings > Skills UI wiring gap)\n");

// --- No active conversation: skills management happens outside runs -------

await test("every skills_* op works with NO prior hello and no active conversation", async () => {
  freshHome();
  const core = buildCore();
  // No HELLO, no NEW, no START anywhere in this test — proves skill
  // management is independent of the session/run lifecycle, exactly like
  // the existing profile ops already are.
  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.type === AGENT_MESSAGE_TYPES.AGENT_SETTINGS, "reply must be agent_settings-shaped");
  assert(listReply.ok === true, `skills_list must succeed with no conversation: ${JSON.stringify(listReply.error)}`);
  assert(Array.isArray(listReply.result) && listReply.result.length === 0, "a fresh scratch catalog starts empty");
});

// --- skills_list --------------------------------------------------------

await test("skills_list reflects the real catalog after a real import", async () => {
  freshHome();
  const core = buildCore();
  const src = makeSkillDir(defaultFrontmatter("ops-list-skill"), {}, "list");
  const importReply = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  assert(importReply.ok === true, `skills_import must succeed: ${JSON.stringify(importReply.error)}`);

  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.ok === true);
  assert(listReply.result.length === 1 && listReply.result[0].name === "ops-list-skill", "the imported skill must appear in skills_list");
  assert(listReply.result[0].enabled === false, "a freshly imported skill starts disabled");
});

// --- skills_import: rejections stay specific and actionable ---------------

await test("skills_import rejects malformed metadata with a distinct INVALID_METADATA error", async () => {
  freshHome();
  const core = buildCore();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-ops-src-badmeta-"));
  // No SKILL.md at all.
  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  assert(reply.ok === false, "malformed metadata must not succeed");
  assert(reply.error.code === "INVALID_METADATA", `expected INVALID_METADATA, got ${reply.error.code}`);
  assert(reply.error.message && reply.error.message.length > 0, "error must carry an actionable message");
});

await test("skills_import rejects a duplicate name with a distinct DUPLICATE_NAME error", async () => {
  freshHome();
  const core = buildCore();
  const src1 = makeSkillDir(defaultFrontmatter("ops-dup-skill", "First one."), {}, "dup1");
  const first = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src1 }));
  assert(first.ok === true, `first import must succeed: ${JSON.stringify(first.error)}`);

  const src2 = makeSkillDir(defaultFrontmatter("ops-dup-skill", "Second, different, folder."), {}, "dup2");
  const second = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src2 }));
  assert(second.ok === false, "a duplicate-named import must not succeed");
  assert(second.error.code === "DUPLICATE_NAME", `expected DUPLICATE_NAME, got ${second.error.code}`);
});

await test("skills_import rejects path traversal via the frontmatter name with a distinct PATH_TRAVERSAL error", async () => {
  const home = freshHome();
  const core = buildCore();
  const src = makeSkillDir(defaultFrontmatter("../../evil", "Traversal attempt."), {}, "traversal");

  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  assert(reply.ok === false, "a traversal attempt must not succeed");
  assert(reply.error.code === "PATH_TRAVERSAL", `expected PATH_TRAVERSAL, got ${reply.error.code}`);

  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.result.length === 0, "the catalog must remain unchanged after a rejected traversal import");
  const escapeTarget = path.resolve(home, "skills", "..", "..", "evil");
  assert(!fs.existsSync(escapeTarget), "path traversal must never write outside the skills root");
});

await test("skills_import rejects a symlink escaping the package root with a distinct SYMLINK_ESCAPE error (Windows junction)", async () => {
  freshHome();
  const core = buildCore();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-ops-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET_OUTSIDE_CONTENT");

  const src = makeSkillDir(defaultFrontmatter("ops-escape-skill", "Contains an escaping link."), {}, "escape");
  createEscapingDirLink(path.join(src, "escape"), outside);

  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  assert(reply.ok === false, "a symlink-escape import must not succeed");
  assert(reply.error.code === "SYMLINK_ESCAPE", `expected SYMLINK_ESCAPE, got ${reply.error.code}`);

  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.result.length === 0, "the catalog must remain unchanged after a rejected symlink-escape import");
});

await test("skills_import never executes a script shipped in the package, and a script-requiring skill is rejected only at enable time (never silent shell access)", async () => {
  freshHome();
  const core = buildCore();
  const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-ops-canary-"));
  const canaryFile = path.join(canaryDir, "executed.txt");
  const scriptContent =
    process.platform === "win32"
      ? `@echo off\r\necho executed> "${canaryFile.replace(/\\/g, "\\\\")}"\r\n`
      : `#!/bin/sh\necho executed > "${canaryFile}"\n`;

  const src = makeSkillDir(defaultFrontmatter("ops-script-skill", "Ships a script that must never run."), {
    "hooks/setup.sh": scriptContent
  }, "script");

  const importReply = await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  assert(importReply.ok === true, `import of a script-bearing but otherwise valid package must succeed: ${JSON.stringify(importReply.error)}`);
  assert(!fs.existsSync(canaryFile), "skills_import must never execute a script found in the package");
  assert(importReply.result.unsupportedCapabilities.length > 0, "content-based capability detection must flag the shipped script");

  const enableReply = await core.handleEnvelope(agentSettingsEnvelope("skills_enable", { name: "ops-script-skill" }));
  assert(enableReply.ok === false, "a script-requiring skill must never silently enable");
  assert(enableReply.error.code === "UNSUPPORTED_CAPABILITY", `expected UNSUPPORTED_CAPABILITY, got ${enableReply.error.code}`);

  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.result[0].enabled === false, "the rejected enable must never flip the catalog's enabled flag");
});

// --- skills_enable / skills_disable / skills_set_invocation_flags ---------

await test("skills_enable and skills_disable round-trip through the real catalog", async () => {
  freshHome();
  const core = buildCore();
  const src = makeSkillDir(defaultFrontmatter("ops-toggle-skill"), {}, "toggle");
  await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));

  const enableReply = await core.handleEnvelope(agentSettingsEnvelope("skills_enable", { name: "ops-toggle-skill" }));
  assert(enableReply.ok === true, `skills_enable must succeed: ${JSON.stringify(enableReply.error)}`);
  assert(enableReply.result.enabled === true, "skills_enable's result must reflect enabled:true");

  const disableReply = await core.handleEnvelope(agentSettingsEnvelope("skills_disable", { name: "ops-toggle-skill" }));
  assert(disableReply.ok === true, `skills_disable must succeed: ${JSON.stringify(disableReply.error)}`);
  assert(disableReply.result.enabled === false, "skills_disable's result must reflect enabled:false");
});

await test("skills_enable on an unknown name returns a distinct NOT_FOUND error", async () => {
  freshHome();
  const core = buildCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_enable", { name: "does-not-exist" }));
  assert(reply.ok === false);
  assert(reply.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${reply.error.code}`);
});

await test("skills_set_invocation_flags updates userInvocable/modelInvocable via the real catalog", async () => {
  freshHome();
  const core = buildCore();
  const src = makeSkillDir(defaultFrontmatter("ops-flags-skill"), {}, "flags");
  await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));

  const reply = await core.handleEnvelope(
    agentSettingsEnvelope("skills_set_invocation_flags", { name: "ops-flags-skill", userInvocable: false, modelInvocable: true })
  );
  assert(reply.ok === true, `skills_set_invocation_flags must succeed: ${JSON.stringify(reply.error)}`);
  assert(reply.result.userInvocable === false && reply.result.modelInvocable === true, "flags must be updated exactly as requested");

  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.result[0].userInvocable === false, "the flag change must persist and be visible to skills_list");
});

// --- skills_refresh / skills_remove ---------------------------------------

await test("skills_refresh re-reads the source folder and updates the catalog, never touching enabled state", async () => {
  freshHome();
  const core = buildCore();
  const src = makeSkillDir(defaultFrontmatter("ops-refresh-skill", "v1 description."), { "resource.txt": "v1" }, "refresh");
  await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  await core.handleEnvelope(agentSettingsEnvelope("skills_enable", { name: "ops-refresh-skill" }));

  writeFixture(src, { "SKILL.md": defaultFrontmatter("ops-refresh-skill", "v2 description.") + "\n# Body\n", "resource.txt": "v2" });
  const refreshReply = await core.handleEnvelope(agentSettingsEnvelope("skills_refresh", { name: "ops-refresh-skill" }));
  assert(refreshReply.ok === true, `skills_refresh must succeed: ${JSON.stringify(refreshReply.error)}`);
  assert(refreshReply.result.description === "v2 description.", "refresh must pick up the updated description");
  assert(refreshReply.result.enabled === true, "refresh must never flip enabled state on its own");
});

await test("skills_remove leaves the original source directory completely intact and untouched", async () => {
  freshHome();
  const core = buildCore();
  const src = makeSkillDir(defaultFrontmatter("ops-remove-skill"), { "resource.txt": "keep-me" }, "remove");
  await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));

  const removeReply = await core.handleEnvelope(agentSettingsEnvelope("skills_remove", { name: "ops-remove-skill" }));
  assert(removeReply.ok === true, `skills_remove must succeed: ${JSON.stringify(removeReply.error)}`);
  assert(removeReply.result && removeReply.result.removed === true, "skills_remove's result must report removed:true");

  assert(fs.existsSync(src), "the original source directory must still exist after remove");
  assert(fs.existsSync(path.join(src, "SKILL.md")), "the original SKILL.md must still exist after remove");
  assert(fs.readFileSync(path.join(src, "resource.txt"), "utf-8") === "keep-me", "the original source file content must be byte-identical after remove");

  const listReply = await core.handleEnvelope(agentSettingsEnvelope("skills_list"));
  assert(listReply.result.length === 0, "the removed skill must no longer appear in the catalog");
});

await test("skills_remove on an unknown name returns a distinct NOT_FOUND error", async () => {
  freshHome();
  const core = buildCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_remove", { name: "does-not-exist" }));
  assert(reply.ok === false);
  assert(reply.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${reply.error.code}`);
});

// --- Disabling takes effect immediately for slash dispatch ----------------

await test("disabling a skill via skills_disable makes the SAME conversation's next slash dispatch fail before the SDK, without needing a new conversation", async () => {
  freshHome();
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });

  const src = makeSkillDir(defaultFrontmatter("ops-disable-effect-skill"), {}, "disable-effect");
  await core.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  await core.handleEnvelope(agentSettingsEnvelope("skills_enable", { name: "ops-disable-effect-skill" }));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "/ops-disable-effect-skill go" }));
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");
  assert(calls.length === 1, "the first, authorized dispatch must reach the SDK exactly once");

  // Disable it through the exact same companion op the Settings > Skills UI
  // sends — this is the wire path being proven, not a direct library call.
  const disableReply = await core.handleEnvelope(agentSettingsEnvelope("skills_disable", { name: "ops-disable-effect-skill" }));
  assert(disableReply.ok === true, `skills_disable must succeed: ${JSON.stringify(disableReply.error)}`);

  // The SAME conversation, typing the exact same slash text again, must now
  // be rejected before the SDK is ever called again — "immediately", not
  // after a new conversation or a restart.
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "/ops-disable-effect-skill go" }));
  const errorEvent = await waitForEvent(core, conversationId, (e) => e.type === "run_error");
  assert(
    errorEvent.reason === "skills_snapshot_unavailable" || errorEvent.reason === "slash_dispatch_rejected",
    `expected a skills-rejection reason, got ${errorEvent.reason}`
  );
  await waitForEvent(core, conversationId, (e) => e.type === "run_stopped");
  assert(calls.length === 1, "the second, disabled dispatch must never reach the SDK a second time");
});

// --- A running conversation's bound snapshot is unaffected by refresh ----

await test("skills_refresh issued mid-run does not change that run's already-materialized snapshot; the same conversation's next run is refused; a new conversation gets the refresh", async () => {
  freshHome();
  const src = makeSkillDir(defaultFrontmatter("ops-midrun-skill", "v1."), { "resource.txt": "v1" }, "midrun");
  const setupCore = buildCore();
  await setupCore.handleEnvelope(agentSettingsEnvelope("skills_import", { sourceDir: src }));
  await setupCore.handleEnvelope(agentSettingsEnvelope("skills_enable", { name: "ops-midrun-skill" }));

  const { sdk, calls, release } = recordingSdk({ blockUntilReleased: true });
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "start reading" }));

  const deadline = Date.now() + 3000;
  while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  assert(calls.length === 1, "the first run must have reached query() before the refresh happens");
  const run1Options = calls[0].options;
  const materializedResource = path.join(run1Options.plugins[0].path, "skills", "ops-midrun-skill", "resource.txt");
  assert(fs.readFileSync(materializedResource, "utf-8") === "v1", "the active run's materialized snapshot must start at v1");

  // Refresh through the exact same companion op the Settings > Skills UI
  // sends, WHILE the run above is still active (blocked on the gate).
  writeFixture(src, { "resource.txt": "v2" });
  const refreshReply = await core.handleEnvelope(agentSettingsEnvelope("skills_refresh", { name: "ops-midrun-skill" }));
  assert(refreshReply.ok === true, `skills_refresh must succeed: ${JSON.stringify(refreshReply.error)}`);

  assert(
    fs.readFileSync(materializedResource, "utf-8") === "v1",
    "a mid-run skills_refresh must NOT change that run's already-materialized snapshot"
  );

  release();
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "continue reading" }));
  const mismatchEvent = await waitForEvent(core, conversationId, (e) => e.type === "run_error");
  assert(
    mismatchEvent.reason === "skills_snapshot_unavailable",
    `expected skills_snapshot_unavailable for the same conversation's next run, got ${mismatchEvent.reason}`
  );
  await waitForEvent(core, conversationId, (e) => e.type === "run_stopped");
  assert(calls.length === 1, "the refused resume must never call query() a second time");

  const { conversationId: conversationId2 } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: conversationId2, prompt: "fresh conversation" }));
  await waitForEvent(core, conversationId2, (e) => e.type === "run_done");
  assert(calls.length === 2, "the new conversation's run must reach query()");
  const run2Options = calls[1].options;
  const newMaterialized = path.join(run2Options.plugins[0].path, "skills", "ops-midrun-skill", "resource.txt");
  assert(fs.readFileSync(newMaterialized, "utf-8") === "v2", "a new conversation must materialize the REFRESHED content");
});

// --- Unsupported protocol version fails closed, same as other ops --------

await test("a skills_* op with an unsupported protocol version fails closed in the same agent_settings-shaped envelope", async () => {
  freshHome();
  const core = buildCore();
  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_list", {}, { v: 999999 }));
  assert(reply.type === AGENT_MESSAGE_TYPES.AGENT_SETTINGS, "must still be agent_settings-shaped, not a generic error");
  assert(reply.ok === false && reply.error.code === "PROTOCOL_ERROR", "an unsupported version must fail closed with PROTOCOL_ERROR");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

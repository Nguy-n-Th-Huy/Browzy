#!/usr/bin/env node
//
// Regression test for Part A of upgrade-agent-reliability-and-workflows: a
// real, reproduced isolation leak. Before this fix, host/agent/tools/
// query-options.js's buildIsolatedOptions() set no CLAUDE_CONFIG_DIR in the
// isolated `env` it builds for query() — the exact same env shape
// (PATH/SystemRoot/ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY only) the wave-1 SDK
// continuity gate (host/agent/spike/gates/gate-0.2-sdk-continuity.mjs) found
// causes the installed SDK's bundled CLI subprocess to fall back to
// `path.join(os.homedir(), ".claude")` and write real session `.jsonl`
// files into the OPERATOR's own `~/.claude/projects/`, interleaved with
// their real Claude Code CLI history. Confirmed independently in this
// change's own evidence report using this exact production code path
// (buildSessionSkills + buildIsolatedOptions, not hand-assembled options).
//
// This is a HARD GATE, not a skip-on-unavailable check (same convention as
// host/test/skills-plugin-scope-verification.test.mjs): if the real query()
// never completes, this FAILS the process rather than silently passing.
//
// Run: node host/test/agent-config-dir-isolation.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";
import { buildSessionSkills } from "../agent/skills/session-workspace.js";
import { buildIsolatedOptions } from "../agent/tools/query-options.js";
import { createBrowserMcpServer, SDK_MCP_SERVER_NAME } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { SessionManager } from "../agent/session/manager.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}
function hardFail(msg) {
  console.log(`  FAIL  ${msg}`);
  fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-config-dir-isolation-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

async function makeRealMcpServer() {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_config_dir_isolation_gate", lease, approvals, tabScope: "any" });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  return createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
}

function listMatchingDirs(root, needle) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.includes(needle));
}

console.log("\nCLAUDE_CONFIG_DIR isolation (Part A: real-home session-write leak) — real product path, real SDK, real fixture server\n");

// --- Gate 1: buildSessionSkills() + buildIsolatedOptions() must never let a
// real query() write into the operator's actual ~/.claude/projects/. -------
async function gateNoRealHomeLeak() {
  const token = "cfgiso" + crypto.randomBytes(6).toString("hex");
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-config-dir-isolation-ws-"));
  const workspaceDir = path.join(scratchRoot, "conversations", token);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const realHomeProjects = path.join(os.homedir(), ".claude", "projects");
  const beforeReal = listMatchingDirs(realHomeProjects, token);
  ok(beforeReal.length === 0, `sanity: no pre-existing entry under the real ~/.claude/projects/ contains this run's fresh token (${token})`);

  const built = await buildSessionSkills(workspaceDir);
  ok(Boolean(built.configDir), "buildSessionSkills() must return a configDir");
  ok(built.configDir.startsWith(workspaceDir), `configDir must live inside the session workspace, not elsewhere — got ${built.configDir}`);
  ok(fs.existsSync(built.configDir), "configDir must actually exist on disk");

  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  let result = null;
  let options = null;
  try {
    const mcpServer = await makeRealMcpServer();
    options = buildIsolatedOptions({
      mcpServer,
      serverName: SDK_MCP_SERVER_NAME,
      snapshot: { model: "fixture-model", env: { ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: "sk-ant-fixture-config-dir-gate-not-a-real-key" } },
      abortController: new AbortController(),
      skills: { cwd: workspaceDir, pluginDir: built.pluginDir, configDir: built.configDir, allowedSkillNames: built.allowedSkillNames, skillOverrides: built.skillOverrides }
    });

    ok(
      options.env.CLAUDE_CONFIG_DIR === built.configDir,
      `options.env.CLAUDE_CONFIG_DIR must be this session's own isolated configDir — got ${options.env.CLAUDE_CONFIG_DIR}`
    );
    ok(
      path.resolve(options.env.CLAUDE_CONFIG_DIR) !== path.resolve(path.join(os.homedir(), ".claude")),
      "options.env.CLAUDE_CONFIG_DIR must never resolve to the operator's real ~/.claude"
    );

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    for await (const msg of sdk.query({ prompt: "hello", options })) {
      if (msg.type === "result") {
        result = msg;
        break;
      }
    }
  } finally {
    await fixture.close();
  }

  // --- The hard gate: a real run must actually have happened -------------
  if (!result) {
    hardFail("the real query() never produced a result message — this is a HARD FAILURE, not a skip");
  } else {
    ok(!result.is_error, `the real run must complete successfully — got is_error=${result.is_error}, subtype=${result.subtype}`);
  }

  const afterReal = listMatchingDirs(realHomeProjects, token);
  if (afterReal.length > beforeReal.length) {
    hardFail(
      `STOP-SHIP: a real query() run wrote a NEW entry under the operator's real ~/.claude/projects/ containing this run's token (${token}): ` +
        JSON.stringify(afterReal)
    );
  } else {
    ok(true, `no new entry appeared under the real ~/.claude/projects/ for this run's token (${token})`);
  }

  const isolatedProjectsDir = path.join(built.configDir, "projects");
  const isolatedEntries = fs.existsSync(isolatedProjectsDir) ? fs.readdirSync(isolatedProjectsDir) : [];
  ok(
    isolatedEntries.length > 0,
    `the session's real SDK session file must land under its OWN isolated configDir/projects/ instead — got entries: ${JSON.stringify(isolatedEntries)} under ${isolatedProjectsDir}`
  );

  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

// --- Gate 2: a legacy conversation binding persisted before configDir
// existed must be backfilled in place, not left permanently broken. -------
async function gateLegacyBindingBackfill() {
  freshHome();
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  const calls = [];
  const sdk = {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      yield { type: "assistant", text: "ok" };
    }
  };
  const profileProvider = {
    async snapshotForRun(profileId, modelId) {
      return { model: modelId || "claude-fake-model", env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" }, revision: 1, profileId: profileId || "default" };
    }
  };
  const core = new CompanionCore({ toolBridge, sessionManager, lease, coerceArgs: (a) => a, sdk, profileProvider });

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  // Seed a LEGACY binding — the exact shape a real, already-persisted
  // conversation on disk had before this fix (pluginDir present, configDir
  // absent — see this change's evidence report for a real example read
  // directly off this machine's own conversations/ tree).
  const legacyCwd = path.join(process.env.OCIC_AGENT_HOME, "conversations", conversationId);
  fs.mkdirSync(legacyCwd, { recursive: true });
  const legacyPluginDir = path.join(legacyCwd, "skills-plugin");
  fs.mkdirSync(path.join(legacyPluginDir, "skills"), { recursive: true });
  sessionManager.setSkillsBinding(conversationId, {
    cwd: legacyCwd,
    skillsDir: path.join(legacyPluginDir, "skills"),
    pluginDir: legacyPluginDir,
    allowedSkillNames: [],
    catalogSnapshot: [],
    skillOverrides: {}
    // deliberately NO configDir — this is the pre-fix persisted shape
  });

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "hello after upgrade" }));

  const deadline = Date.now() + 3000;
  while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  ok(calls.length === 1, "the legacy-bound conversation's run must still reach query() (not be permanently broken by the new required field)");

  if (calls.length === 1) {
    const opts = calls[0].options;
    ok(Boolean(opts.env.CLAUDE_CONFIG_DIR), "the backfilled run must have a CLAUDE_CONFIG_DIR in its isolated env");
    ok(
      opts.env.CLAUDE_CONFIG_DIR.startsWith(legacyCwd),
      `the backfilled configDir must live under the conversation's own existing cwd — got ${opts.env.CLAUDE_CONFIG_DIR}`
    );
  }

  const persisted = sessionManager.getSkillsBinding(conversationId);
  ok(Boolean(persisted && persisted.configDir), "the backfilled configDir must be persisted back onto the conversation's binding");
  ok(
    persisted && persisted.pluginDir === legacyPluginDir,
    "backfilling configDir must NOT re-materialize/change the already-bound pluginDir (only adds the missing field)"
  );
}

async function main() {
  await gateNoRealHomeLeak();
  await gateLegacyBindingBackfill();
}

await main();

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILURE(S)`}\n`);
process.exit(fail ? 1 : 0);

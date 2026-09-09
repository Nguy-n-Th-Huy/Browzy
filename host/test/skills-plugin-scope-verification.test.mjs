#!/usr/bin/env node
//
// SHIPPED GATE (converted from a spike — see git history / the design doc's
// decision 9 for the earlier spike form). Proves, against a REAL
// `@anthropic-ai/claude-agent-sdk` `query()` (the real bundled CLI, spawned
// as a child process, pointed at a local in-process fixture Anthropic
// server — never a mocked SDK), that this product's REAL code path —
// `host/agent/skills/index.js`'s `buildSessionSkills()` +
// `host/agent/tools/query-options.js`'s `buildIsolatedOptions()`, not
// hand-assembled options — makes a session's approved skill discoverable
// and `Skill`-tool-resolvable via the local-plugin mechanism (design.md
// decision 9), while a sentinel skill planted in a directory ABOVE the
// session workspace never leaks in.
//
// History this test settles: design.md decision 7 (settingSources:
// ['project']) was implemented, then disproven by
// host/test/skills-scope-verification.test.mjs's own sentinel test — see
// plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md.
// `'project'` walks the ENTIRE ancestor directory tree with no repo-root
// gating, so it could not be used to make a session workspace's
// materialized skill discoverable without also exposing every `.claude`
// tree above it (a real installation's operator's global skill collection,
// independently verified at 189 skills). Decision 9 replaced it with a
// LOCAL PLUGIN loaded by absolute, explicit path via the SDK's `plugins`
// option, `settingSources` staying `[]` throughout. This file is the
// executable proof that replacement mechanism actually works AND does not
// reopen the leak.
//
// This test is a HARD GATE, not a skip-on-unavailable check: if the real
// query() never produces a system/init message with a `skills` array, this
// FAILS the process. If the parent sentinel appears anywhere it should not,
// this FAILS LOUDLY — the assertion is never weakened to tolerate that
// outcome. Sentinel names are freshly random per run (crypto.randomBytes),
// so no real installed skill anywhere on this machine could accidentally
// satisfy an assertion.
//
// Beyond scope, this test also closes the previously-open "does the `Skill`
// tool actually RESOLVE a plugin-qualified name" question (necessary, not
// merely discoverable — the original production failure was `Unknown
// skill: marketing-research` in a tool_result, not an init omission). It
// does so using host/agent/settings/testing/fixture-anthropic-server.mjs's
// two additive, opt-in scripting hooks (`scriptToolUseInput`/`scriptToolUse`
// — both no-ops for every pre-existing consumer of that shared fixture),
// which let this test script a real `Skill` tool_use naming the exact
// qualified skill and read back the real tool_result. The `Skill` tool's
// input shape (`{ skill: "<name>" }`) is UNDOCUMENTED in the pinned SDK's
// own `.d.ts` files (verified: no `SkillInput` type is exported anywhere in
// `sdk.d.ts`/`sdk-tools.d.ts`) — it was determined empirically, the same
// way this file determines everything else it asserts.
//
// Run: node host/test/skills-plugin-scope-verification.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";
import { importSkill, enableSkill, buildSessionSkills, SESSION_SKILLS_PLUGIN_NAME } from "../agent/skills/index.js";
import { createBrowserMcpServer, SDK_MCP_SERVER_NAME } from "../agent/tools/adapter.js";
import { buildIsolatedOptions } from "../agent/tools/query-options.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-plugin-scope-home-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function uniqueName(label) {
  return `zz-sentinel-${label}-${crypto.randomBytes(6).toString("hex")}`;
}

function makeRawSkillDir(skillsRoot, name) {
  const dir = path.join(skillsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Scope-verification sentinel skill, never a real product skill.\n---\n\nSentinel body.\n`
  );
  return dir;
}

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}
function hardFail(msg) {
  console.log(`  FAIL  ${msg}`);
  fail++;
}

console.log("\nSkill-plugin discovery + resolution, real product path (buildSessionSkills + buildIsolatedOptions), real SDK, real fixture server\n");

async function makeRealMcpServer() {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_plugin_scope_gate", lease, approvals, tabScope: "any" });
  await run.begin();
  // Never actually dispatched: the fixture model in this test only ever
  // calls the "Skill" tool (scripted below), never a browser tool. This is
  // the SAME construction host/agent/companion.js uses in production with a
  // real bundled query() — a genuine in-process MCP server
  // (createSdkMcpServer() under the hood), not a non-functional stand-in.
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  return createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
}

async function runRealQuery({ options, baseUrl }) {
  const deadlineAt = Date.now() + 20_000;
  let initMessage = null;
  const toolUses = [];
  const toolResults = [];
  for await (const msg of sdk.query({ prompt: "hello", options })) {
    if (msg.type === "system" && msg.subtype === "init") initMessage = msg;
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) if (block?.type === "tool_use") toolUses.push(block);
    }
    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) if (block?.type === "tool_result") toolResults.push(block);
    }
    if (msg.type === "result") break;
    if (Date.now() > deadlineAt) break;
  }
  return { initMessage, toolUses, toolResults };
}

async function main() {
  freshHome();

  // The workspace's own approved skill, imported through the REAL catalog
  // (never a hand-planted directory) — exactly the production path
  // buildSessionSkills() expects: import -> enable -> materialize.
  const workspaceSkillName = uniqueName("workspace");
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-plugin-scope-src-"));
  fs.writeFileSync(
    path.join(src, "SKILL.md"),
    `---\nname: ${workspaceSkillName}\ndescription: Scope-verification sentinel skill, never a real product skill.\n---\n\nSentinel body.\n`
  );
  await importSkill(src);
  enableSkill(workspaceSkillName);

  // Parent-leak shapes, mirroring host/test/skills-scope-verification.test.mjs
  // exactly: a bare `.claude/skills/` sentinel one level above the workspace,
  // AND a `.git` marker making the parent look like a real repository root —
  // the realistic shape of an actual production leak (a session workspace
  // nested inside a real dev checkout).
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-plugin-scope-parent-"));
  const workspaceDir = path.join(parentDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const parentSentinelName = uniqueName("parent");
  makeRawSkillDir(path.join(parentDir, ".claude", "skills"), parentSentinelName);
  fs.mkdirSync(path.join(parentDir, ".git"), { recursive: true });

  // --- The real product path -----------------------------------------
  const built = await buildSessionSkills(workspaceDir);
  ok(
    built.pluginDir && built.pluginDir.startsWith(workspaceDir),
    `buildSessionSkills() must materialize the plugin INSIDE the session workspace, not elsewhere — got pluginDir=${built.pluginDir}`
  );
  ok(
    fs.existsSync(path.join(built.pluginDir, ".claude-plugin", "plugin.json")),
    "the materialized plugin must carry a .claude-plugin/plugin.json manifest"
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(built.pluginDir, ".claude-plugin", "plugin.json"), "utf-8"));
  ok(
    manifest.name === SESSION_SKILLS_PLUGIN_NAME,
    `the plugin manifest's name must be the fixed exported constant — got ${JSON.stringify(manifest.name)}`
  );

  const qualifiedWorkspaceSkill = `${SESSION_SKILLS_PLUGIN_NAME}:${workspaceSkillName}`;
  ok(
    built.allowedSkillNames.includes(qualifiedWorkspaceSkill),
    `buildSessionSkills()'s allowedSkillNames must carry the plugin-qualified form — got ${JSON.stringify(built.allowedSkillNames)}`
  );

  const mcpServer = await makeRealMcpServer();

  // Scripts a real "Skill" tool_use, empirically known input shape
  // ({ skill: "<name>" }) — see this file's header. Targets "Skill"
  // specifically because the real CLI's wire-level tool ordering does not
  // necessarily match `options.tools`' own order (empirically observed:
  // "Task" surfaces on the wire as a tool literally named "Agent", ahead of
  // "Skill").
  const fixture = await startFixtureAnthropicServer({
    scenario: "success",
    scriptToolUse: (parsedTools) => {
      const skillTool = parsedTools.find((t) => t.name === "Skill");
      return skillTool ? { name: "Skill", input: { skill: qualifiedWorkspaceSkill } } : null;
    }
  });

  let run1;
  try {
    const options = buildIsolatedOptions({
      mcpServer,
      serverName: SDK_MCP_SERVER_NAME,
      snapshot: { model: "fixture-model", env: { ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: "sk-fixture" } },
      abortController: new AbortController(),
      skills: {
        cwd: workspaceDir,
        pluginDir: built.pluginDir,
        configDir: built.configDir,
        allowedSkillNames: [...built.allowedSkillNames, `${SESSION_SKILLS_PLUGIN_NAME}:${parentSentinelName}`],
        skillOverrides: built.skillOverrides
      }
    });

    ok(options.settingSources.length === 0, "settingSources must stay [] under the plugin redesign — untouched");
    ok(Array.isArray(options.plugins) && options.plugins.length === 1, "buildIsolatedOptions() must add exactly one plugins entry");
    ok(options.plugins[0].path === built.pluginDir, "the plugins entry's path must be THIS session's own materialized plugin directory");
    ok(options.plugins[0].skipMcpDiscovery === true, "the plugins entry must set skipMcpDiscovery: true");

    run1 = await runRealQuery({ options, baseUrl: fixture.url });
  } finally {
    await fixture.close();
  }

  // --- The hard gate: a real run must actually have happened -------------
  if (!run1.initMessage || !Array.isArray(run1.initMessage.skills)) {
    hardFail(
      "the real query() never produced a system/init message with a `skills` array — this is a HARD FAILURE, not a skip: " +
        JSON.stringify(run1.initMessage)
    );
  } else {
    console.log(`  init message skills array: ${JSON.stringify(run1.initMessage.skills)}`);

    ok(
      run1.initMessage.skills.includes(qualifiedWorkspaceSkill),
      `the session workspace's own approved skill ("${qualifiedWorkspaceSkill}") must be discovered via the real product path`
    );

    const parentQualified = `${SESSION_SKILLS_PLUGIN_NAME}:${parentSentinelName}`;
    const parentLeaked =
      run1.initMessage.skills.includes(parentSentinelName) || run1.initMessage.skills.includes(parentQualified);
    if (parentLeaked) {
      hardFail(
        `STOP-SHIP: the parent sentinel ("${parentSentinelName}") appeared in the real init message's skills array — ` +
          "a directory ABOVE the session workspace leaked in via the plugin mechanism. Full skills array: " +
          JSON.stringify(run1.initMessage.skills)
      );
    } else {
      ok(true, `the parent sentinel ("${parentSentinelName}") is correctly absent — no leak above the session workspace`);
    }
  }

  // --- Skill-tool resolution: necessary, not merely discoverable ---------
  const skillToolUse = run1.toolUses.find((b) => b.name === "Skill");
  ok(Boolean(skillToolUse), "a real Skill tool_use must have been triggered by the real CLI");
  if (skillToolUse) {
    const matchingResult = run1.toolResults.find((r) => r.tool_use_id === skillToolUse.id);
    console.log(`  Skill tool_use: ${JSON.stringify(skillToolUse)}`);
    console.log(`  Skill tool_result: ${JSON.stringify(matchingResult)}`);
    ok(Boolean(matchingResult), "a matching tool_result must have come back for the Skill tool_use");
    const resultText =
      matchingResult && (typeof matchingResult.content === "string" ? matchingResult.content : JSON.stringify(matchingResult.content));
    ok(
      Boolean(resultText) && !matchingResult.is_error && /Launching skill/i.test(resultText),
      `the plugin-qualified skill name must actually RESOLVE (not merely be discoverable) — expected a "Launching skill" ` +
        `success result, got: ${resultText}`
    );
  }
}

await main();

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILURE(S)`}\n`);
process.exit(fail ? 1 : 0);

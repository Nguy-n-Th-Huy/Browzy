#!/usr/bin/env node
//
// REGRESSION GUARD for the restored isolation posture (`settingSources: []`
// in host/agent/tools/query-options.js's buildIsolatedOptions()) — proves,
// against a REAL `@anthropic-ai/claude-agent-sdk` query() run (the real
// bundled CLI, spawned as a child process — same transport as
// host/test/settings-capability-test.test.mjs — pointed at a local, in-
// process fixture Anthropic server, never a mocked SDK), that a skill
// planted in a directory ABOVE the session workspace never leaks into a
// real run's advertised skills, no matter what.
//
// History: design.md decision 7 originally proposed adding `'project'` to
// `settingSources` so the SDK would discover a session workspace's own
// materialized skill snapshot. THIS TEST, in its original form, is what
// disproved that decision: it proved `settingSources: ["project"]` walks up
// the ancestor directory tree with no repo-root gating at all, so a real
// installation's session workspace (nested under the operator's home
// directory) leaks the operator's entire global skill collection into every
// run. See plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md
// for the full evidence. Decision 7 was reverted; `settingSources` is back to
// `[]` everywhere. This file is kept — not deleted — as the executable proof
// that `'project'` leaks, repurposed as the guard that stops anyone from
// re-enabling it without this test failing first.
//
// Why an executable test and not just a code review of the settingSources
// line: sdk.d.ts documents `'project'` only as "Project settings
// (`.claude/settings.json`)" — it does not document whether skill/command
// DISCOVERY under that source resolves strictly relative to `cwd` or walks
// up toward a repository/project root. The CLI that actually implements this
// (host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs and the bundled
// CLI binary it shells out to) is a built/bundled artifact with no readable
// implementation source in this tree, so the question is settled empirically
// here, not by argument — and stays settled by re-running this test, not by
// trusting that nobody touches the settingSources line again.
//
// Two parent-leak shapes are planted for exactly that reason — a bare
// `.claude/skills/` sentinel one level up might not exercise a real walk-up
// path if the SDK instead requires a project-root marker to decide to walk
// up at all:
//   1. `<tmp>/parent/.claude/skills/<sentinel>/` — a plain parent
//      `.claude/skills/` directory, no project-root marker.
//   2. `<tmp>/parent/.git/` — makes `<tmp>/parent` itself look like a real
//      repository root, the realistic shape of an actual leak (a session
//      workspace nested inside a real dev checkout).
// The workspace (`<tmp>/parent/workspace/`) sits one level below both, with
// its OWN materialized sentinel skill under
// `<tmp>/parent/workspace/.claude/skills/<sentinel>/` — exactly mirroring
// what host/agent/skills/session-workspace.js's buildSessionSkills() does in
// production. With `settingSources: []`, NEITHER sentinel is expected to be
// discovered — discovery of `.claude` trees (workspace's own included) is
// exactly what `settingSources: []` turns off. That is the documented,
// honest cost of the reverted decision: the imported-skill feature is not
// wired through settingSources any more, and this file only guards the
// boundary (no parent leak), not the workspace's own discoverability, which
// is now understood to require a different mechanism entirely (see
// host/test/skills-plugin-scope-verification.test.mjs, a separate spike).
//
// This test is a HARD GATE, not a skip-on-unavailable check. If the real
// query() never produces a system/init message with a `skills` array at all
// (spawn failure, startup timeout, malformed message), this test FAILS the
// process — it never silently reports success or gets skipped. If EITHER
// sentinel appears in the real init message's `skills` array, this test
// FAILS LOUDLY — the assertion is never weakened to tolerate that outcome.
//
// Sentinel names are freshly random per run (crypto.randomBytes) so no real
// installed skill anywhere on this machine (e.g. the operator's own
// ~/.claude/skills/) could accidentally satisfy either assertion.
//
// Deliberately builds the `query()` options by hand (mirroring exactly the
// settingSources/cwd/skills/tools fields host/agent/tools/query-options.js's
// buildIsolatedOptions() sets) rather than by calling buildIsolatedOptions()
// itself: that function requires a real `mcpServer` argument wired into
// `mcpServers`, and handing the real SDK child process a non-functional
// stand-in server risks a hang unrelated to the property this test proves.
// The `mcpServers` value here is a real empty object, exactly like
// host/agent/settings/capability-test.js's own `runSubTest()` uses when no
// tool round-trip is needed for a given check.
//
// Run: node host/test/skills-scope-verification.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-scope-home-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function uniqueName(label) {
  return `zz-sentinel-${label}-${crypto.randomBytes(6).toString("hex")}`;
}

function makeSkillDir(skillsRoot, name) {
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

console.log("\nSkill-discovery scope regression guard (settingSources: []) — real SDK, real fixture server\n");

async function runRealQueryAndCollectInit({ cwd, allowedSkillNames, baseUrl }) {
  const abortController = new AbortController();
  const options = {
    abortController,
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    // The actual, restored posture host/agent/tools/query-options.js's
    // buildIsolatedOptions() sets: no setting source is read at all. This is
    // the product's real isolation baseline — the reverted decision-7
    // addition of 'project' is exactly what this file used to prove leaks,
    // and now guards against reintroducing.
    settingSources: [],
    cwd,
    tools: ["Skill"],
    // Deliberately includes BOTH sentinel names so a discovered-but-
    // unlisted parent skill can never be mistaken for "filtered out" rather
    // than "never discovered" — the `skills` option is a context filter over
    // what the SDK discovers (sdk.d.ts: "a context filter, not a sandbox"),
    // not the discovery mechanism this test is proving.
    skills: allowedSkillNames,
    permissionMode: "bypassPermissions", // safe: no tool besides Skill is ever offered, and the fixture model never requests one
    maxTurns: 1,
    env: {
      PATH: process.env.PATH || process.env.Path || "",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: "sk-fixture"
    }
  };

  const deadlineAt = Date.now() + 20_000;
  const timer = setTimeout(() => abortController.abort(), Math.max(0, deadlineAt - Date.now()));

  let initMessage = null;
  try {
    for await (const msg of sdk.query({ prompt: "hello", options })) {
      if (msg.type === "system" && msg.subtype === "init") {
        initMessage = msg;
      }
      if (msg.type === "result") break; // drain to the run's natural end, same as capability-test.js's runSubTest
      if (Date.now() > deadlineAt) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return initMessage;
}

async function main() {
  freshHome();

  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-scope-parent-"));
  const workspaceDir = path.join(parentDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Parent-leak shape 1: a plain .claude/skills/ one level above the workspace.
  const parentSkillsDir = path.join(parentDir, ".claude", "skills");
  const parentSentinelName = uniqueName("parent");
  makeSkillDir(parentSkillsDir, parentSentinelName);

  // Parent-leak shape 2: make the parent directory look like a real
  // repository root (a `.git` directory) — the realistic shape 'project'
  // settings resolution might specifically walk up toward, and the
  // realistic shape of an actual production leak (a session workspace that
  // happens to be nested inside a real dev checkout).
  fs.mkdirSync(path.join(parentDir, ".git"), { recursive: true });

  // The workspace's own materialized skill — exactly what
  // buildSessionSkills() does in production: copy an approved snapshot
  // under `${cwd}/.claude/skills/<name>/`.
  const workspaceSkillsDir = path.join(workspaceDir, ".claude", "skills");
  const workspaceSentinelName = uniqueName("workspace");
  makeSkillDir(workspaceSkillsDir, workspaceSentinelName);

  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  let initMessage;
  try {
    initMessage = await runRealQueryAndCollectInit({
      cwd: workspaceDir,
      allowedSkillNames: [parentSentinelName, workspaceSentinelName],
      baseUrl: fixture.url
    });
  } finally {
    await fixture.close();
  }

  // --- The hard gate: a real run must actually have happened -------------
  if (!initMessage || !Array.isArray(initMessage.skills)) {
    hardFail(
      "the real query() never produced a system/init message with a `skills` array — this is a HARD FAILURE, not a skip: " +
        JSON.stringify(initMessage)
    );
  } else {
    console.log(`  init message skills array: ${JSON.stringify(initMessage.skills)}`);

    // With settingSources: [], no `.claude` tree is scanned at all — not the
    // parent's, and not even the workspace's own. This is the honest,
    // documented cost of reverting decision 7: the workspace sentinel is
    // NOT expected to be discovered by this mechanism any more. Asserting
    // its absence here (rather than ignoring it) keeps this test from
    // silently passing if some other change quietly re-wires discovery
    // through settingSources without anyone updating this guard.
    ok(
      !initMessage.skills.includes(workspaceSentinelName),
      `the session workspace's own materialized skill ("${workspaceSentinelName}") is correctly NOT discovered — ` +
        "settingSources: [] does not scan any `.claude` tree, including the workspace's own"
    );

    const parentLeaked = initMessage.skills.includes(parentSentinelName);
    if (parentLeaked) {
      hardFail(
        `STOP-SHIP: the parent sentinel ("${parentSentinelName}") appeared in the real init message's skills array — ` +
          "a directory ABOVE the session workspace leaked in even with settingSources: []. Full skills array: " +
          JSON.stringify(initMessage.skills)
      );
    } else {
      ok(true, `the parent sentinel ("${parentSentinelName}") is correctly absent — no leak above the session workspace`);
    }
  }
}

await main();

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILURE(S)`}\n`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// Regression test for a live shipped bug: buildSessionSkills() changed to
// materialize approved skills as a LOCAL PLUGIN directory and return
// `pluginDir` (host/agent/skills/session-workspace.js), and
// buildIsolatedOptions() consumes it at the SDK's `plugins` option
// (host/agent/tools/query-options.js) — but host/agent/companion.js's
// `_bindSkillsForRun()` persists a conversation's skills binding ONCE and
// reuses it on every later run, and its reuse branch used to backfill only
// a missing `configDir`, never a missing `pluginDir`.
//
// A real conversation-metadata census (see
// plans/reports/osf-apply-260909-1833-conversation-metadata-schema-and-snapshot-boundary.md)
// found hundreds of real, already-persisted conversations on this machine
// with NO `pluginDir` field at all — the pre-plugin-materialization binding
// shape. Reproduced (see this fix's own evidence): driving such a binding
// through the real `_bindSkillsForRun()` -> `buildIsolatedOptions()` -> a
// real, unmocked `query()` used to reach the SDK with
// `plugins: [{ type: "local", path: undefined, ... }]`. The SDK does NOT
// throw on that — it silently fails to load the plugin (`plugin_errors:
// [{type:"path-not-found", ...}]` in its own system/init message) and the
// run completes normally with every approved skill for this conversation
// invisible to the model. A silent capability loss, not a crash — worse,
// because nothing surfaces it.
//
// This is a HARD GATE, not a skip-on-unavailable check (same convention as
// host/test/agent-config-dir-isolation.test.mjs, whose Gate 2 this test's
// structure mirrors): if the real query() never completes, this FAILS the
// process rather than silently passing.
//
// Run: node host/test/agent-plugin-dir-backfill.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-plugin-dir-backfill-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function makeSkillSourceDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: A demo skill for the plugin-dir backfill regression test.\n---\n\n# ${name}\n\nInstructions go here.\n`
  );
  return dir;
}

console.log("\npluginDir backfill for a pre-plugin legacy skills binding — real product path, real SDK, real fixture server\n");

async function main() {
  const agentHome = freshHome();

  // --- Seed a real, enabled, approved skill in the catalog, exactly like a
  // real installation would have before this conversation's binding was
  // first created. ---------------------------------------------------------
  const skillSrcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-plugin-dir-backfill-src-"));
  const skillSrc = makeSkillSourceDir(skillSrcRoot, "legacy-demo-skill");

  const { importSkill, enableSkill, listCatalog } = await import("../agent/skills/index.js");
  await importSkill(skillSrc);
  enableSkill("legacy-demo-skill");
  const catalog = await listCatalog();
  const approvedEntry = catalog.find((s) => s.name === "legacy-demo-skill");
  if (!approvedEntry) hardFail("setup: the seeded skill did not appear enabled in listCatalog()");

  const fixture = await startFixtureAnthropicServer({ scenario: "success" });

  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });

  // REAL sdk import (not a fake) — the point of this gate is to see the
  // actual SDK's handling of the backfilled `plugins` option end to end.
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  const profileProvider = {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "fixture-model",
        env: { ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: "sk-ant-fixture-plugin-dir-backfill-not-a-real-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };

  const core = new CompanionCore({ toolBridge, sessionManager, lease, coerceArgs: (a) => a, sdk, profileProvider });

  try {
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
    const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

    // Seed a PRE-PLUGIN legacy binding — the exact shape a real,
    // already-persisted conversation on disk had before plugin
    // materialization existed at all: no pluginDir, no configDir, an
    // old-style bare (non-plugin-qualified) allowedSkillNames/skillOverrides,
    // and a catalogSnapshot recording the skill this conversation was
    // actually bound to (the ONLY thing the backfill is allowed to read from
    // — never the live catalog).
    const legacyCwd = path.join(agentHome, "conversations", conversationId);
    fs.mkdirSync(legacyCwd, { recursive: true });
    const pinnedCatalogSnapshot = [JSON.parse(JSON.stringify(approvedEntry))];
    sessionManager.setSkillsBinding(conversationId, {
      cwd: legacyCwd,
      skillsDir: path.join(legacyCwd, ".claude", "skills"), // old pre-plugin on-disk shape
      allowedSkillNames: ["legacy-demo-skill"], // old bare (unqualified) form
      catalogSnapshot: pinnedCatalogSnapshot,
      skillOverrides: { "legacy-demo-skill": "on" }
      // deliberately NO pluginDir, NO configDir
    });

    ok(
      !sessionManager.getSkillsBinding(conversationId).pluginDir,
      "sanity: the seeded legacy binding has no pluginDir before the run"
    );

    let terminalSystemInit = null;
    let sawRunError = null;

    const startResult = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "hello from the legacy-binding regression test" })
    );
    ok(startResult && startResult.accepted === true, "START must be accepted for the legacy-bound conversation");

    const deadline = Date.now() + 20000;
    let events = [];
    while (Date.now() < deadline) {
      const snap = sessionManager.snapshotSince(conversationId, 0);
      events = snap.events || [];
      const errorEvent = events.find((e) => e.type === "run_error");
      if (errorEvent) {
        sawRunError = errorEvent;
        break;
      }
      const init = events.find((e) => e.type === "stream_message" && e.message?.type === "system" && e.message?.subtype === "init");
      const done = events.find((e) => e.type === "run_done" || e.type === "run_stopped");
      if (init && done) {
        terminalSystemInit = init.message;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // --- The hard gate: the run must actually have completed, not errored. -
    if (sawRunError) {
      hardFail(`the legacy-bound conversation's run ended in run_error instead of completing — ${JSON.stringify(sawRunError)}`);
    } else if (!terminalSystemInit) {
      hardFail("the real query() never produced a system/init message and a terminal event — this is a HARD FAILURE, not a skip");
    } else {
      ok(true, "the legacy-bound conversation's run reached a real query() and completed");

      // The whole point of this fix: the skill must actually be DISCOVERABLE
      // by the SDK now, not merely "the run didn't crash". Before the fix,
      // the run also completed (see this fix's evidence) but with
      // `plugin_errors: [{type:"path-not-found", ...}]` and the approved
      // skill silently absent from `skills`.
      ok(
        !terminalSystemInit.plugin_errors || terminalSystemInit.plugin_errors.length === 0,
        `the real SDK must report zero plugin_errors after the backfill — got ${JSON.stringify(terminalSystemInit.plugin_errors)}`
      );
      const reportedSkills = Array.isArray(terminalSystemInit.skills) ? terminalSystemInit.skills : [];
      ok(
        reportedSkills.some((s) => s.endsWith(":legacy-demo-skill") || s === "legacy-demo-skill"),
        `the previously-approved skill must be visible to the SDK after the backfill — got skills=${JSON.stringify(reportedSkills)}`
      );
    }

    // --- The binding must be durably repaired on disk, not just patched for
    // this one in-memory run. --------------------------------------------
    const persisted = sessionManager.getSkillsBinding(conversationId);
    ok(Boolean(persisted && persisted.pluginDir), "the backfilled pluginDir must be persisted back onto the conversation's binding");
    ok(Boolean(persisted && persisted.configDir), "the backfilled configDir must be persisted back onto the conversation's binding");
    if (persisted && persisted.pluginDir) {
      ok(persisted.pluginDir.startsWith(legacyCwd), `the backfilled pluginDir must live under the conversation's own cwd — got ${persisted.pluginDir}`);
      ok(fs.existsSync(persisted.pluginDir), "the backfilled pluginDir must actually exist on disk");
      ok(
        fs.existsSync(path.join(persisted.pluginDir, ".claude-plugin", "plugin.json")),
        "the backfilled pluginDir must carry a real plugin manifest"
      );
      const materializedSkillFile = path.join(persisted.pluginDir, "skills", "legacy-demo-skill", "SKILL.md");
      ok(fs.existsSync(materializedSkillFile), `the previously-approved skill's own files must be materialized under the backfilled plugin — expected ${materializedSkillFile}`);
    }
    ok(
      Array.isArray(persisted?.allowedSkillNames) && persisted.allowedSkillNames.some((n) => n.includes("legacy-demo-skill")),
      `the backfilled allowedSkillNames must be re-derived in the PLUGIN-QUALIFIED form, not left as the old bare name — got ${JSON.stringify(persisted?.allowedSkillNames)}`
    );

    // --- The backfill must not silently invent a DIFFERENT approved-skill
    // selection than the one this conversation was actually bound to: the
    // conversation's own pinned catalogSnapshot must be untouched. ---------
    ok(
      Array.isArray(persisted?.catalogSnapshot) &&
        persisted.catalogSnapshot.length === 1 &&
        persisted.catalogSnapshot[0].name === "legacy-demo-skill",
      "the backfill must never change catalogSnapshot — the already-pinned approved-skill list stays exactly what this conversation was bound to"
    );
  } finally {
    await fixture.close();
  }
}

await main();

console.log(`\n${fail === 0 ? "ALL PASSED" : `${fail} FAILURE(S)`}\n`);
process.exit(fail ? 1 : 0);

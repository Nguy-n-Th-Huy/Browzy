#!/usr/bin/env node
//
// Task 7.2's closed gap (reports/10-task-reconciliation.md): the application-
// owned skills catalog (host/agent/skills/**, task 7.1/7.2's application
// half — see reports/07-skills-evidence.md) was fully built and tested, but
// nothing threaded its output into a real `query()` call. This suite proves
// the wiring itself: host/agent/tools/query-options.js's buildIsolatedOptions()
// now requires and composes a `skills` session, and host/agent/companion.js's
// `_bindSkillsForRun()` + slash-dispatch gate actually call the real catalog
// modules at run start — not a synthetic stand-in for either half.
//
// No live SDK, browser, or credential is used anywhere here: `sdk` and
// `profileProvider` are injected fakes (same pattern as
// host/test/agent-companion-core.test.mjs), and every skills-catalog call
// is the REAL host/agent/skills/** module against a scratch OCIC_AGENT_HOME.
//
// Run: node host/test/agent-skills-wiring.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";
import { buildIsolatedOptions, HIGH_RISK_BUILTINS } from "../agent/tools/query-options.js";
import { SESSION_SKILLS_PLUGIN_NAME } from "../agent/skills/index.js";

// design.md decision 9: the SDK's `skills` allowlist and `skillOverrides`
// keys now carry the plugin-qualified canonical name.
const Q = (name) => `${SESSION_SKILLS_PLUGIN_NAME}:${name}`;

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
function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} — expected ${e}, got ${a}`);
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-wiring-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function writeFixture(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function makeSkillDir(frontmatter, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-wiring-src-"));
  writeFixture(root, { "SKILL.md": `${frontmatter}\n# Body\n`, ...extra });
  return root;
}

// Same real catalog module, imported fresh (its own internal state is just
// the on-disk catalog.json under OCIC_AGENT_HOME, so no module-level caching
// to worry about between tests).
async function skillsModule() {
  return import("../agent/skills/index.js");
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

// Records every query() call's options; yields immediately by default.
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

console.log("\nSkills wiring into query() options (task 7.2's closed gap)\n");

// --- Unit tests: buildIsolatedOptions itself -------------------------------

await test("buildIsolatedOptions throws when no skills session is provided — a run can never silently reach query() without one", async () => {
  let threw = null;
  try {
    buildIsolatedOptions({
      mcpServer: {},
      serverName: "srv",
      snapshot: { model: "m", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } }
    });
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected buildIsolatedOptions to throw without a skills session");
  assert(/skills/i.test(threw.message), `error should mention the missing skills session: ${threw.message}`);
});

await test("buildIsolatedOptions throws when skills.configDir is missing — a run can never silently reach query() without an isolated CLAUDE_CONFIG_DIR", async () => {
  let threw = null;
  try {
    buildIsolatedOptions({
      mcpServer: {},
      serverName: "srv",
      snapshot: { model: "m", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
      skills: { cwd: "/scratch/conv-1", allowedSkillNames: [], skillOverrides: {} }
    });
  } catch (err) {
    threw = err;
  }
  assert(threw, "expected buildIsolatedOptions to throw without skills.configDir");
  assert(/configDir/.test(threw.message), `error should mention the missing configDir: ${threw.message}`);
});

await test("buildIsolatedOptions composes cwd/skills/skillOverrides and adds the Skill tool, without weakening the isolated baseline", async () => {
  const options = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    abortController: new AbortController(),
    skills: {
      cwd: "/scratch/conv-1",
      configDir: "/scratch/conv-1/claude-config",
      pluginDir: "/scratch/conv-1/skills-plugin",
      allowedSkillNames: ["alpha", "beta"],
      skillOverrides: { alpha: "on", beta: "user-invocable-only" }
    }
  });

  assert(
    options.env.CLAUDE_CONFIG_DIR === "/scratch/conv-1/claude-config",
    `options.env.CLAUDE_CONFIG_DIR must be this session's own isolated config dir, not the operator's real ~/.claude — got ${options.env.CLAUDE_CONFIG_DIR}`
  );

  assert(options.cwd === "/scratch/conv-1", "cwd must be the session workspace directory");
  assertDeepEqual(options.skills, ["alpha", "beta"], "options.skills must be the exact allowedSkillNames allowlist");
  assertDeepEqual(
    options.skillOverrides,
    { alpha: "on", beta: "user-invocable-only" },
    "options.skillOverrides must be the exact per-skill override map"
  );
  // Full registry-vs-allowlist coverage (all 26 browser tools + Skill, no
  // drift) is asserted in host/test/agent-tool-permission-preapproval.test.mjs;
  // this test only needs to confirm skills wiring didn't change what belongs
  // here: Skill plus this run's own mcp server's tools, and nothing risky.
  assert(options.tools.includes("Skill"), "the Skill tool must remain in the explicit tools list");
  const nonBrowserAllowed = new Set(["Skill", "WebSearch", "WebFetch", "Task"]);
  assert(
    options.tools.every((name) => nonBrowserAllowed.has(name) || name.startsWith("mcp__srv__")),
    "the tools allowlist must contain only Skill, WebSearch, WebFetch, Task, and this run's own mcp server's tools"
  );
  for (const risky of HIGH_RISK_BUILTINS) {
    assert(options.disallowedTools.includes(risky), `${risky} must remain disallowed by default`);
    assert(!options.tools.includes(risky), `${risky} must never appear in the preapproved tools list`);
  }
  assert(options.settingSources.length === 0, "settingSources isolation must be untouched by skills wiring");
  assert(options.strictMcpConfig === true, "strictMcpConfig isolation must be untouched by skills wiring");
});

// --- Integration: real catalog -> real materialization -> real options ----

await test("only enabled, capability-approved snapshots are materialized on disk and reach query()'s skills allowlist", async () => {
  freshHome();
  const { importSkill, enableSkill } = await skillsModule();

  await importSkill(makeSkillDir("---\nname: wiring-enabled-skill\ndescription: Enabled skill for wiring test.\n---\n"));
  enableSkill("wiring-enabled-skill");
  await importSkill(makeSkillDir("---\nname: wiring-disabled-skill\ndescription: Left disabled.\n---\n"));
  // deliberately never enabled

  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "summarize this page" }));
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  assert(calls.length === 1, "query() must have been called exactly once");
  const options = calls[0].options;
  assertDeepEqual(options.skills, [Q("wiring-enabled-skill")], "only the enabled skill may appear in the SDK allowlist, plugin-qualified");
  assert(options.skillOverrides[Q("wiring-enabled-skill")] === "on", "the enabled, fully-invocable skill must map to \"on\"");
  assert(options.skillOverrides[Q("wiring-disabled-skill")] === undefined, "a disabled skill must not appear in skillOverrides at all");
  assert(options.tools.includes("Skill"), "the Skill tool must be present so an invocable skill can actually be invoked");
  assert(Array.isArray(options.plugins) && options.plugins.length === 1, "buildIsolatedOptions() must add exactly one plugins entry");
  assert(options.plugins[0].skipMcpDiscovery === true, "the plugins entry must set skipMcpDiscovery: true");

  // The PHYSICAL directory name stays bare — qualification is an SDK-facing
  // naming concept, never a filesystem one (see session-workspace.js).
  const skillsRootOnDisk = path.join(options.plugins[0].path, "skills");
  assert(fs.existsSync(path.join(skillsRootOnDisk, "wiring-enabled-skill")), "the enabled skill must be materialized under the plugin's skills/");
  assert(!fs.existsSync(path.join(skillsRootOnDisk, "wiring-disabled-skill")), "a disabled skill must NEVER be materialized on disk for this session");
});

// --- Application-side slash dispatch, enforced before the SDK -------------

await test("an unknown slash command is rejected application-side and never reaches the SDK", async () => {
  freshHome();
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "/not-a-real-skill do the thing" }));

  const errorEvent = await waitForEvent(core, conversationId, (e) => e.type === "run_error");
  assert(errorEvent.reason === "slash_dispatch_rejected", `expected slash_dispatch_rejected, got ${errorEvent.reason}`);
  await waitForEvent(core, conversationId, (e) => e.type === "run_stopped");
  assert(calls.length === 0, "the SDK's query() must never have been called for a rejected slash command");
});

await test("a disabled skill's explicit slash dispatch is rejected application-side and never reaches the SDK", async () => {
  freshHome();
  const { importSkill } = await skillsModule();
  await importSkill(makeSkillDir("---\nname: wiring-off-skill\ndescription: Never enabled.\n---\n"));
  // left disabled deliberately

  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "/wiring-off-skill go" }));

  const errorEvent = await waitForEvent(core, conversationId, (e) => e.type === "run_error");
  assert(errorEvent.reason === "slash_dispatch_rejected", `expected slash_dispatch_rejected, got ${errorEvent.reason}`);
  assert(calls.length === 0, "a disabled skill's manually typed slash command must never reach query()");
});

await test("an enabled, user-invocable skill's slash dispatch is authorized and its name reaches the SDK", async () => {
  freshHome();
  const { importSkill, enableSkill } = await skillsModule();
  await importSkill(makeSkillDir("---\nname: wiring-runnable-skill\ndescription: Enabled and user-invocable.\n---\n"));
  enableSkill("wiring-runnable-skill");

  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "/wiring-runnable-skill go" }));
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  assert(calls.length === 1, "the authorized dispatch must reach the SDK exactly once");
  assert(
    calls[0].options.skills.includes(Q("wiring-runnable-skill")),
    "the authorized skill must be in the SDK's skills allowlist, plugin-qualified"
  );
  // An authorized SKILL dispatch is NOT forwarded to the SDK as the raw typed
  // text. companion.js replaces it with buildSkillDispatchPrompt()'s output —
  // a fixed "Use the <name> skill." instruction (plugin-qualified name)
  // followed by the operator's own post-command text verbatim — before
  // calling query() (see host/agent/skills/dispatch.js).
  assert(
    calls[0].prompt === `Use the "${Q("wiring-runnable-skill")}" skill.\n\ngo`,
    "the conveyed skill-dispatch prompt must reach the SDK, not the raw typed text"
  );
});

// --- Lifecycle: binding survives a mid-run refresh; resume rechecks it ----

await test("mid-run refresh does not affect an already-bound conversation; the same conversation's next run is refused; a new conversation gets the refresh", async () => {
  freshHome();
  const { importSkill, enableSkill, refreshSkill } = await skillsModule();
  const src = makeSkillDir("---\nname: midrun-skill\ndescription: v1.\n---\n", { "resource.txt": "v1" });
  await importSkill(src);
  enableSkill("midrun-skill");

  const { sdk, calls, release } = recordingSdk({ blockUntilReleased: true });
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "start reading" }));

  // Wait until the run has actually reached query() (it is now blocked on
  // the gate, i.e. "active" in the sense that matters here: options are
  // already built and handed to the SDK).
  const deadline = Date.now() + 3000;
  while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  assert(calls.length === 1, "the first run must have reached query() before the refresh happens");
  const run1Options = calls[0].options;
  const materializedResource = path.join(run1Options.plugins[0].path, "skills", "midrun-skill", "resource.txt");
  assert(fs.readFileSync(materializedResource, "utf-8") === "v1", "the active run's materialized snapshot must start at v1");

  // Refresh while run 1 is still active (blocked on the gate, not yet done).
  writeFixture(src, { "resource.txt": "v2" });
  await refreshSkill("midrun-skill");

  assert(
    fs.readFileSync(materializedResource, "utf-8") === "v1",
    "a refresh while a run is active must NOT change that run's already-materialized snapshot"
  );

  release();
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  // The SAME conversation's next run must be refused — its bound snapshot no
  // longer matches the live catalog (hash changed by the refresh above) —
  // rather than silently loading the refreshed instructions.
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "continue reading" }));
  const mismatchEvent = await waitForEvent(core, conversationId, (e) => e.type === "run_error");
  assert(
    mismatchEvent.reason === "skills_snapshot_unavailable",
    `expected skills_snapshot_unavailable, got ${mismatchEvent.reason}`
  );
  await waitForEvent(core, conversationId, (e) => e.type === "run_stopped");
  assert(calls.length === 1, "the refused resume must never call query() a second time");

  // A brand-new conversation is free to pick up the refreshed snapshot.
  const { conversationId: conversationId2 } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: conversationId2, prompt: "fresh conversation" }));
  await waitForEvent(core, conversationId2, (e) => e.type === "run_done");
  assert(calls.length === 2, "the new conversation's run must reach query()");
  const run2Options = calls[1].options;
  assert(run2Options.skills.includes(Q("midrun-skill")), "the new conversation must still see the (now refreshed) skill enabled");
  const newMaterialized = path.join(run2Options.plugins[0].path, "skills", "midrun-skill", "resource.txt");
  assert(fs.readFileSync(newMaterialized, "utf-8") === "v2", "a new conversation must materialize the REFRESHED content");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

// Task 7.4: end-to-end proof that skills operate through the SDK dispatch
// path THIS PRODUCT'S PANEL actually drives, and that a disabled skill typed
// manually in the composer is rejected BEFORE the SDK is ever called.
//
// This is the panel-facing complement to host/test/agent-skills-wiring.test.mjs
// (which already proves the same rejection at the raw CompanionCore envelope
// level — see that file's own tests) and host/test/skills-catalog.test.mjs /
// skills-dispatch.test.mjs (which prove the catalog-layer matrix: duplicate
// names, traversal, symlinks, unsupported-capability detection). What is
// NEW here is driving it through extension/sidepanel/{protocol-client,
// panel-controller,conversation-model}.js — this task's own owned files —
// against a REAL host/agent/companion.js CompanionCore (never modified,
// only imported) and a REAL host/agent/skills/** catalog with real temp-
// directory fixtures, exactly mirroring test/sidepanel-fake-companion.test.mjs's
// established harness (see that file's own header for why this is the "fake
// companion harness" this task's environment constraint calls for — only
// the SDK's query() generator and the settings profile module are fakes).
//
// Run: node test/sidepanel-slash-picker-dispatch.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../host/agent/companion.js";
import { TranscriptStore } from "../host/agent/storage/transcript-store.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { SessionManager } from "../host/agent/session/manager.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";
import { TokenBatcher } from "../host/agent/session/token-batcher.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../host/agent/protocol.js";
import * as skillsLib from "../host/agent/skills/index.js";

import { ProtocolClient } from "../extension/sidepanel/protocol-client.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";
import { HistoryStore } from "../extension/sidepanel/history-store.js";
import { ProfileCache } from "../extension/sidepanel/profile-cache.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";
import { buildPickerItems } from "../extension/sidepanel/skills-model.js";
import { recordAdvertisedCommands } from "../host/agent/settings/advertised-commands.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-slash-picker-dispatch-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

// design.md decision 9: the conveyed Skill-tool prompt and the SDK's own
// `skills` allowlist now carry the plugin-qualified canonical name.
const Q = (name) => `${skillsLib.SESSION_SKILLS_PLUGIN_NAME}:${name}`;

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}
async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function freshSkillsHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-slash-picker-skills-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function makeSkillFixture(root, folderName, name, description = "A demo skill for dispatch tests.") {
  const dir = path.join(root, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions.\n`);
  return dir;
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

function recordingSdk(messages = [{ type: "result", subtype: "success", result: "ok" }]) {
  const calls = [];
  return {
    sdk: {
      async *query({ prompt, options }) {
        calls.push({ prompt, options });
        for (const m of messages) yield m;
      }
    },
    calls
  };
}

// Reproduces companion.js's runAsForkedChild() live-forwarding wiring — see
// test/sidepanel-fake-companion.test.mjs's identical helper for the full
// rationale (a real cross-process stream_event/token_batch shape, just via
// direct function calls instead of process IPC).
function wireLiveForwarding(core, deliver) {
  const originalStartRun = core.sessionManager.startRun.bind(core.sessionManager);
  core.sessionManager.startRun = (conversationId, opts) => {
    const run = originalStartRun(conversationId, opts);
    const originalEmit = run.emit.bind(run);
    const sendImmediate = (payload) => {
      const isBatch = payload.type === "token_batch";
      deliver(
        makeEnvelope(isBatch ? AGENT_MESSAGE_TYPES.TOKEN_BATCH : AGENT_MESSAGE_TYPES.STREAM_EVENT, {
          conversationId,
          runId: run.runId,
          ...(isBatch ? { events: payload.events } : { event: payload })
        })
      );
    };
    const batcher = new TokenBatcher({ sendImmediate, windowMs: 5 });
    run.emit = (event) => {
      originalEmit(event);
      batcher.push(event);
      if (event.type === "run_done" || event.type === "run_stopped") batcher.dispose();
    };
    return run;
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

function makeBridgeTransport(core) {
  const msgListeners = [];
  const disconnectListeners = [];
  function deliver(envelope) {
    setTimeout(() => {
      for (const fn of msgListeners) fn({ type: "agent_msg", envelope });
    }, 0);
  }
  wireLiveForwarding(core, deliver);
  return {
    postMessage: (msg) => {
      if (!msg || msg.type !== "agent_msg" || !msg.envelope) return;
      Promise.resolve(core.handleEnvelope(msg.envelope)).then((reply) => {
        if (reply) deliver(reply);
      });
    },
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    disconnect: () => {
      for (const fn of disconnectListeners) fn();
    }
  };
}

function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    }
  };
}

function completeProfile() {
  return {
    profileId: "default",
    baseUrl: "https://example.invalid",
    models: [{ id: "claude-fake-model", label: "Fake" }],
    defaultModelId: "claude-fake-model",
    revision: 1,
    capabilityTest: { ok: true, at: Date.now(), credentialRevision: 1 }
  };
}

function buildPanel(core) {
  const protocolClient = new ProtocolClient({ createTransport: () => makeBridgeTransport(core) });
  return new PanelController({
    protocolClient,
    historyStore: new HistoryStore({ storage: memStorage() }),
    profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
    identity: async () => ({ installationId: "test-install", connectionId: "test-conn" })
  });
}

async function main() {
  console.log("== explicit invocation: an enabled, user-invocable skill typed as /name reaches the real SDK, panel shows a completed turn ==");
  {
    const skillsHome = freshSkillsHome();
    const srcDir = makeSkillFixture(skillsHome, "src-runnable", "chay-thu", "Chạy thử một skill hợp lệ.");
    await skillsLib.importSkill(srcDir);
    skillsLib.enableSkill("chay-thu");

    const { sdk, calls } = recordingSdk([
      { type: "assistant", message: { content: [{ type: "text", text: "Đã chạy skill." }] } },
      { type: "result", subtype: "success", result: "Đã chạy skill." }
    ]);
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    await panel.sendMessage("/chay-thu làm việc này giúp mình");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);

    ok(calls.length === 1, "the SDK's query() was called exactly once for an authorized explicit skill dispatch");
    // repair-slash-dispatch-and-builtin-commands: the raw "/name args" text
    // is exactly what the SDK previously rejected with its own "Unknown
    // command" error (proposal.md's "Why") — settingSources: [] means the
    // SDK never scans this app's materialized skills directory as a
    // command source, so a leading "/" always lands in the SDK's own
    // slash-command namespace, not this app's. The gate-authorized dispatch
    // is now conveyed as an explicit Skill-tool instruction instead
    // (dispatch.js's buildSkillDispatchPrompt) — the operator's own
    // composer text/transcript are unaffected (panel-controller.js's
    // addLocalUserMessage already ran on the literal text before this).
    ok(
      calls[0].prompt === `Use the "${Q("chay-thu")}" skill.\n\nlàm việc này giúp mình`,
      `the skill dispatch is conveyed as an explicit Skill-tool instruction (plugin-qualified name), arguments verbatim — got ${JSON.stringify(calls[0].prompt)}`
    );
    ok(calls[0].options.skills.includes(Q("chay-thu")), "the dispatched skill is present in the SDK's own skills allowlist for this run, plugin-qualified");
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.complete === true && turn.text === "Đã chạy skill.", "the panel renders a real completed turn — never a fabricated success");

    // specs/agent-skills/spec.md "Isolation posture is unchanged": the
    // translation touches ONLY the `prompt` string handed to query() (see
    // companion.js's `queryPrompt` above dispatch.js's builder) — it never
    // touches `buildIsolatedOptions()`'s own construction, so the isolation
    // baseline for a run carrying an authorized skill dispatch must be
    // identical to any other run's: `settingSources` stays a real empty
    // array (never widened to read `.claude/settings.json`, project, or
    // local config), and exactly one MCP server is registered (the
    // application's own browser-tool server) — no additional server or
    // setting source was granted just because this run happened to be a
    // slash dispatch.
    ok(
      Array.isArray(calls[0].options.settingSources) && calls[0].options.settingSources.length === 0,
      `settingSources stays exactly [] for an authorized skill dispatch — got ${JSON.stringify(calls[0].options.settingSources)}`
    );
    ok(calls[0].options.strictMcpConfig === true, "strictMcpConfig stays true, unrelaxed by the dispatch");
    ok(
      Object.keys(calls[0].options.mcpServers || {}).length === 1,
      `exactly one MCP server is registered, the same as any other run — got ${JSON.stringify(Object.keys(calls[0].options.mcpServers || {}))}`
    );
  }

  console.log("== a DISABLED (never-enabled) skill typed manually in the composer is rejected BEFORE the SDK is ever called ==");
  {
    // Real, verified behavior worth documenting precisely (see
    // reports/07-skills-ui-evidence.md): host/agent/skills/session-workspace.js's
    // buildSessionSkills() only ever materializes ENABLED+approved catalog
    // entries into a conversation's bound catalogSnapshot — a skill that was
    // never enabled simply never gets an entry in that snapshot at all. So
    // host/agent/skills/dispatch.js's assertSlashDispatchAllowed() reports
    // this exact case as UNKNOWN_COMMAND (no such entry in the bound
    // snapshot), not its own separate DISABLED branch — that branch instead
    // fires for the "was enabled at bind time, disabled since" case, which
    // this file's later "resume with an unavailable skill" test exercises
    // through the (functionally equivalent, still pre-SDK) skills_snapshot_
    // unavailable path. Both are "rejected before SDK dispatch, actionable
    // message, zero query() calls" — the acceptance property this test
    // proves — just via two different, both-correct host code paths
    // depending on when the skill became unavailable relative to binding.
    const skillsHome = freshSkillsHome();
    const srcDir = makeSkillFixture(skillsHome, "src-disabled", "tat-di", "Một skill bị để tắt.");
    await skillsLib.importSkill(srcDir);
    // deliberately never enabled

    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    await panel.sendMessage("/tat-di hãy làm việc này");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);

    ok(calls.length === 0, "the disabled skill's manually typed slash command NEVER reached the SDK's query()");
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.lifecycle === "error", "the panel's data model marks this turn as an error, never a silent success");
    ok(turn.errorInfo.reason === "slash_dispatch_rejected", `expected slash_dispatch_rejected, got ${turn.errorInfo.reason}`);
    ok(/tat-di/.test(turn.errorInfo.detail || ""), `errorInfo.detail names the exact rejected command — got: ${turn.errorInfo.detail}`);
  }

  console.log("== an UNKNOWN slash command (no such imported skill) is also rejected before the SDK, even though no catalog entry exists at all ==");
  {
    freshSkillsHome();
    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    await panel.sendMessage("/khong-ton-tai làm gì đó");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);
    ok(calls.length === 0, "an unknown command never reaches the SDK");
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.errorInfo.reason === "slash_dispatch_rejected", "unknown command also reported as slash_dispatch_rejected");
  }

  console.log("== a hidden automatic-only skill (userInvocable:false, modelInvocable:true) is excluded from the picker but still reaches the SDK's allowlist for automatic invocation ==");
  {
    const skillsHome = freshSkillsHome();
    const srcDir = makeSkillFixture(skillsHome, "src-auto", "tu-dong-goi", "Skill chỉ được gọi tự động.");
    await skillsLib.importSkill(srcDir);
    skillsLib.enableSkill("tu-dong-goi");
    skillsLib.setInvocationFlags("tu-dong-goi", { userInvocable: false, modelInvocable: true });

    const catalog = await skillsLib.listCatalog();
    const pickerItems = buildPickerItems(catalog);
    ok(!pickerItems.some((i) => i.name === "tu-dong-goi"), "the automatic-only skill does NOT appear in the picker's own item list");

    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    // An ordinary (non-slash) message — the model, not the user, would be
    // the one to invoke this skill automatically.
    await panel.sendMessage("hãy giúp mình một việc bất kỳ");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);
    ok(calls.length === 1, "the ordinary prompt reaches the SDK");
    ok(calls[0].options.skills.includes(Q("tu-dong-goi")), "the automatic-only skill is STILL present in the SDK's skills allowlist — it can be enabled without appearing in the picker");
  }

  console.log("== a non-user-invocable skill (userInvocable:false) is rejected on explicit manual dispatch, even though it is enabled and modelInvocable ==");
  {
    const skillsHome = freshSkillsHome();
    const srcDir = makeSkillFixture(skillsHome, "src-not-user-invocable", "chi-tu-dong", "Chỉ được gọi tự động, không cho gõ lệnh.");
    await skillsLib.importSkill(srcDir);
    skillsLib.enableSkill("chi-tu-dong");
    skillsLib.setInvocationFlags("chi-tu-dong", { userInvocable: false, modelInvocable: true });

    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    // The user bypasses the picker entirely and types the command by hand —
    // exactly the "even if the SDK itself could discover that command"
    // scenario specs/agent-skills.md's "Searchable slash picker" requirement
    // names, since this skill IS present in the SDK's own skills allowlist
    // (see the automatic-invocation test above) yet must still be refused
    // for explicit dispatch.
    await panel.sendMessage("/chi-tu-dong hãy làm việc này");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);

    ok(calls.length === 0, "a non-user-invocable skill's manually typed command never reaches the SDK");
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.errorInfo.reason === "slash_dispatch_rejected", "rejected as slash_dispatch_rejected");
    ok(/user.invocable|direct slash invocation/i.test(turn.errorInfo.detail || ""), `errorInfo.detail explains the NOT_USER_INVOCABLE rejection — got: ${turn.errorInfo.detail}`);
  }

  console.log("== resume with an unavailable skill: disabling a skill this conversation already depends on rejects its NEXT run rather than silently swapping instructions ==");
  {
    const skillsHome = freshSkillsHome();
    const srcDir = makeSkillFixture(skillsHome, "src-changed", "se-bi-tat", "Sẽ bị tắt giữa chừng.");
    await skillsLib.importSkill(srcDir);
    skillsLib.enableSkill("se-bi-tat");

    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    await panel.sendMessage("/se-bi-tat lần đầu");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);
    ok(calls.length === 1, "first run binds the snapshot and reaches the SDK normally");

    // Settings > Skills disables it mid-conversation (a separate flow — the
    // catalog mutation itself, not this panel).
    skillsLib.disableSkill("se-bi-tat");

    await panel.sendMessage("/se-bi-tat lần hai");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);
    ok(calls.length === 1, "the second run's SDK call count did not increase — it was rejected before reaching query() again");
    const turns = panel.currentModel().items.filter((i) => i.kind === "assistant_turn");
    const lastTurn = turns[turns.length - 1];
    ok(lastTurn.errorInfo.reason === "skills_snapshot_unavailable", `expected skills_snapshot_unavailable, got ${lastTurn.errorInfo.reason}`);
  }

  console.log("== an advertised, non-terminal-bound command (/cost) is rejected end to end — design.md decision 8: the shipped allowlist is empty ==");
  {
    // design.md decision 8 / tasks.md 5.6-5.7: `cost` was the one candidate
    // considered for APPROVED_BUILTIN_COMMANDS, but a real advertised record
    // for this operator's configuration never contained it — so both
    // allowlist constants (host and panel) were emptied rather than
    // substituted, and the whole mechanism (this record, the gate's
    // built-in branch, deriveApprovedBuiltinCommands()) stays wired but
    // currently approves nothing. This proves that end to end through the
    // real companion + panel stack: even a command the SDK genuinely
    // advertised as real and non-terminal-bound is rejected exactly like an
    // unknown command, because "advertised" is not "approved" — the
    // allowlist intersection still governs, and it is empty.
    freshSkillsHome();
    // Seed this run's advertised-command record as if an earlier session
    // (or the Settings connection test) had already observed the SDK
    // advertise "cost" as a real, non-terminal-bound slash command —
    // design.md decision 3/5: the gate's approved built-in set is derived
    // from this persisted record intersected with the application
    // allowlist, read fresh on every dispatch (companion.js's
    // _runAfterLeaseGranted). recordAdvertisedCommands() targets the same
    // OCIC_AGENT_HOME freshSkillsHome() just set.
    recordAdvertisedCommands({ commands: ["cost", "compact"], terminalCommands: ["compact"] });

    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    await panel.sendMessage("/cost");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);

    ok(calls.length === 0, "an advertised-but-unapproved command never reaches the SDK's query()");
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(
      turn.errorInfo.reason === "slash_dispatch_rejected",
      `rejected the same way an unknown command is, even though the SDK genuinely advertised it — specs/agent-skills/spec.md "Advertisement is not authorization"; got ${turn.errorInfo?.reason}`
    );
  }

  console.log("== a command the SDK never advertised (or advertised but not on the allowlist) is rejected exactly like an unknown command, even with no matching skill ==");
  {
    freshSkillsHome(); // no advertised-command record at all in this fresh home
    const { sdk, calls } = recordingSdk();
    const core = buildCore({ sdk });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    await panel.sendMessage("/cost");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);

    ok(calls.length === 0, "with no advertised-command record at all, \"cost\" is not treated as an approved built-in — never reaches the SDK");
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.errorInfo.reason === "slash_dispatch_rejected", "rejected the same way an unknown command is — specs/agent-skills/spec.md \"Advertisement is not authorization\"");
  }

  console.log(fail === 0 ? "\nALL SLASH PICKER DISPATCH TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();

#!/usr/bin/env node
//
// tasks.md 2.1/2.2 (upgrade-agent-reliability-and-workflows, design.md
// decision 2): the versioned conversation metadata schema, its migration
// against REAL on-disk pre-existing conversation shapes, and the app/SDK
// snapshot boundary (`systemPrompt.snapshot` must stay explicit `false`).
//
// The two legacy fixture shapes below (LEGACY_NO_SKILLS_BINDING,
// LEGACY_PRE_PLUGIN_SKILLS_BINDING) are not invented: they are the exact
// shapes read directly off this machine's own
// ~/.config/browzy-in-chrome/agent/conversations/ tree during this task's
// investigation — a conversation created before any run ever started, and a
// conversation bound before the skills-plugin mechanism existed (bare
// `.claude/skills` layout, no `pluginDir`/`configDir`). The current-shape
// fixture (PLUGIN_ERA_SKILLS_BINDING) mirrors a real freshly-bound
// conversation the same way. No secret value appears in any fixture.
//
// Run: node host/test/agent-conversation-metadata.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATION_METADATA_SCHEMA_VERSION,
  LIFECYCLE,
  DEFAULT_BUDGET_POLICY,
  initConversationMetadataEnvelope,
  buildAppProfileIdentity,
  buildSessionSchemaIdentity,
  buildPermissionPolicyIdentity,
  migrateConversationMetadata
} from "../agent/storage/conversation-metadata.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { conversationMetaFile } from "../agent/storage/paths.js";
import { SessionManager } from "../agent/session/manager.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { CompanionCore } from "../agent/companion.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";
import { buildIsolatedOptions } from "../agent/tools/query-options.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-conv-metadata-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

// Real shape, read directly off this machine's own on-disk tree: a
// conversation created but never run (no skillsBinding key at all).
const LEGACY_NO_SKILLS_BINDING_META = {
  conversationId: "conv_legacy_no_binding",
  createdAt: 1788883101029,
  updatedAt: 1788883101029,
  lastSeq: 0,
  interrupted: false
};

// Real shape, read directly off this machine's own on-disk tree: a
// conversation bound before the skills-plugin mechanism existed.
const LEGACY_PRE_PLUGIN_SKILLS_BINDING_META = {
  conversationId: "conv_legacy_pre_plugin",
  createdAt: 1788684888257,
  updatedAt: 1788684888303,
  lastSeq: 5,
  interrupted: false,
  activeRunId: null,
  skillsBinding: {
    cwd: "C:\\scratch\\agent\\conversations\\conv_legacy_pre_plugin",
    skillsDir: "C:\\scratch\\agent\\conversations\\conv_legacy_pre_plugin\\.claude\\skills",
    allowedSkillNames: [],
    catalogSnapshot: [],
    skillOverrides: {}
  }
};

// Real shape, read directly off this machine's own on-disk tree: a
// conversation bound under the current skills-plugin mechanism.
const PLUGIN_ERA_SKILLS_BINDING_META = {
  conversationId: "conv_plugin_era",
  createdAt: 1788953270609,
  updatedAt: 1788953270630,
  lastSeq: 5,
  interrupted: false,
  activeRunId: null,
  skillsBinding: {
    cwd: "C:\\scratch\\agent\\conversations\\conv_plugin_era",
    skillsDir: "C:\\scratch\\agent\\conversations\\conv_plugin_era\\skills-plugin\\skills",
    pluginDir: "C:\\scratch\\agent\\conversations\\conv_plugin_era\\skills-plugin",
    configDir: "C:\\scratch\\agent\\conversations\\conv_plugin_era\\claude-config",
    allowedSkillNames: ["ocic-session-skills:marketing-research"],
    catalogSnapshot: [{ name: "marketing-research" }],
    skillOverrides: { "ocic-session-skills:marketing-research": "on" }
  }
};

console.log("\nConversation metadata schema, migration, and app/SDK snapshot boundary (tasks.md 2.1/2.2)\n");

// ---------------------------------------------------------------------------
// 2.1a — schema shape
// ---------------------------------------------------------------------------

{
  const envelope = initConversationMetadataEnvelope();
  ok(envelope.schemaVersion === CONVERSATION_METADATA_SCHEMA_VERSION, "fresh envelope carries the current schema version");
  ok(envelope.appProfile === null, "fresh envelope has no app profile identity yet (bound on first run)");
  ok(envelope.sessionSchemaIdentity === null, "fresh envelope has no session schema identity yet");
  ok(envelope.permissionPolicy === null, "fresh envelope has no permission policy yet");
  ok(envelope.sdkSessionRef === null, "fresh envelope has no SDK session reference — reserved for a later group, never guessed");
  ok(JSON.stringify(envelope.budgetPolicy) === JSON.stringify(DEFAULT_BUDGET_POLICY), "fresh envelope's budget policy is the unset default, not a fabricated limit");
  ok(envelope.lifecycle === LIFECYCLE.ACTIVE, "fresh envelope's lifecycle is active");
  ok(envelope.usageEpoch === 0, "fresh envelope's usage epoch starts at 0");
  ok(envelope.migrationState.legacy === false, "fresh envelope is not marked legacy");
  ok(envelope.migrationState.backfilled === false, "fresh envelope was not backfilled");
  ok(envelope.migrationState.backfilledAt === null, "fresh envelope has no backfill timestamp");
}

// ---------------------------------------------------------------------------
// 2.1b — secret-free app profile identity
// ---------------------------------------------------------------------------

{
  const identity = buildAppProfileIdentity({
    profileId: "default",
    baseUrl: "https://api.anthropic.com",
    modelId: "claude-opus-5",
    credentialRevision: 3
  });
  ok(identity.profileId === "default", "profileId carried through");
  ok(identity.endpoint === "https://api.anthropic.com", "endpoint (non-secret baseUrl) carried through");
  ok(identity.modelId === "claude-opus-5", "modelId carried through");
  ok(identity.credentialRevision === 3, "credentialRevision carried through");
  const keys = Object.keys(identity).sort();
  ok(
    keys.join(",") === "credentialRevision,endpoint,modelId,profileId",
    `app profile identity must carry EXACTLY these four fields, nothing else — got ${keys.join(",")}`
  );
  ok(!("env" in identity) && !("apiKey" in identity) && !JSON.stringify(identity).includes("ANTHROPIC_API_KEY"), "app profile identity structurally cannot carry a credential value");

  const missing = buildAppProfileIdentity({});
  ok(missing.credentialRevision === null, "an unresolved credentialRevision is null, never fabricated as 0");
}

// ---------------------------------------------------------------------------
// 2.1c — session schema identity (the exact input list gate-0.2's own
// evidence report names as load-bearing for a future resume-compatibility
// check, reproduced against REAL captured skillsBinding shapes)
// ---------------------------------------------------------------------------

{
  ok(buildSessionSchemaIdentity(null) === null, "no skillsBinding -> no session schema identity");
  ok(buildSessionSchemaIdentity(undefined) === null, "undefined skillsBinding -> no session schema identity");

  const legacy = buildSessionSchemaIdentity(LEGACY_PRE_PLUGIN_SKILLS_BINDING_META.skillsBinding);
  ok(legacy.cwd === LEGACY_PRE_PLUGIN_SKILLS_BINDING_META.skillsBinding.cwd, "legacy identity carries the real cwd");
  ok(legacy.pluginDir === null, "a pre-plugin binding has no pluginDir");
  ok(legacy.pluginName === null, "a pre-plugin binding must NOT be attributed today's fixed plugin name — it never went through the plugin mechanism");
  ok(legacy.configDir === null, "a pre-plugin binding has no configDir");
  ok(Array.isArray(legacy.allowedSkillNames) && legacy.allowedSkillNames.length === 0, "the real pre-plugin fixture had zero allowed skills");
  ok(Array.isArray(legacy.settingSources) && legacy.settingSources.length === 0, "settingSources is always the fixed empty array");

  const pluginEra = buildSessionSchemaIdentity(PLUGIN_ERA_SKILLS_BINDING_META.skillsBinding);
  ok(pluginEra.cwd === PLUGIN_ERA_SKILLS_BINDING_META.skillsBinding.cwd, "plugin-era identity carries the real cwd");
  ok(pluginEra.pluginDir === PLUGIN_ERA_SKILLS_BINDING_META.skillsBinding.pluginDir, "plugin-era identity carries the real pluginDir");
  ok(pluginEra.pluginName === "ocic-session-skills", "plugin-era identity attributes the fixed application-owned plugin name");
  ok(pluginEra.configDir === PLUGIN_ERA_SKILLS_BINDING_META.skillsBinding.configDir, "plugin-era identity carries the real configDir");
  ok(
    JSON.stringify(pluginEra.allowedSkillNames) === JSON.stringify(["ocic-session-skills:marketing-research"]),
    "plugin-era identity carries the real plugin-qualified allowed skill names"
  );

  // Sorted, so two runs bound to the same effective skill set compare equal
  // regardless of catalog iteration order.
  const unsorted = buildSessionSchemaIdentity({ cwd: "/c", allowedSkillNames: ["z:two", "a:one"], skillOverrides: {} });
  ok(JSON.stringify(unsorted.allowedSkillNames) === JSON.stringify(["a:one", "z:two"]), "allowedSkillNames is sorted for stable comparison");
}

// ---------------------------------------------------------------------------
// 2.1d — permission policy identity self-maintains from real options
// ---------------------------------------------------------------------------

{
  ok(buildPermissionPolicyIdentity(null) === null, "no options -> no permission policy identity");

  const options = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    skills: { cwd: "/scratch/conv-1", configDir: "/scratch/conv-1/claude-config", pluginDir: "/scratch/conv-1/skills-plugin", allowedSkillNames: [], skillOverrides: {} }
  });
  const policy = buildPermissionPolicyIdentity(options);
  ok(Array.isArray(policy.tools) && policy.tools.includes("Skill"), "permission policy identity derives `tools` from the real built options");
  ok(Array.isArray(policy.allowedTools) && policy.allowedTools.includes("WebSearch"), "permission policy identity derives `allowedTools` from the real built options");
  ok(Array.isArray(policy.disallowedTools) && policy.disallowedTools.includes("Bash"), "permission policy identity derives `disallowedTools` from the real built options");
  ok(
    JSON.stringify(policy.tools) === JSON.stringify([...options.tools].sort()),
    "tools is sorted for stable comparison across construction-order differences"
  );
}

// ---------------------------------------------------------------------------
// 2.1e — migration against REAL pre-existing on-disk conversation shapes
// ---------------------------------------------------------------------------

{
  const currentEnvelope = { ...initConversationMetadataEnvelope(), appProfile: { profileId: "p" } };
  const alreadyCurrentMeta = { conversationId: "c", conversationMetadata: currentEnvelope };
  const migratedNoop = migrateConversationMetadata(alreadyCurrentMeta);
  ok(migratedNoop === currentEnvelope, "an already-current envelope is returned BY REFERENCE, unchanged — migration is idempotent and never mutates a bound record");

  const migratedNoBinding = migrateConversationMetadata(LEGACY_NO_SKILLS_BINDING_META);
  ok(migratedNoBinding.schemaVersion === CONVERSATION_METADATA_SCHEMA_VERSION, "the truly-ancient real fixture (no skillsBinding at all) migrates to the current schema version");
  ok(migratedNoBinding.appProfile === null, "a legacy record's appProfile is NEVER reconstructed — no historical-identity replay");
  ok(migratedNoBinding.sessionSchemaIdentity === null, "no skillsBinding to derive from -> null, not fabricated");
  ok(migratedNoBinding.sdkSessionRef === null, "a legacy record's sdkSessionRef stays null — 2.3+'s territory, never guessed here");
  ok(migratedNoBinding.migrationState.legacy === true, "the truly-ancient fixture is flagged legacy");
  ok(migratedNoBinding.migrationState.backfilled === true, "the truly-ancient fixture is flagged backfilled");
  ok(typeof migratedNoBinding.migrationState.backfilledAt === "number", "a backfilled record carries a real backfill timestamp");

  const migratedPrePlugin = migrateConversationMetadata(LEGACY_PRE_PLUGIN_SKILLS_BINDING_META);
  ok(migratedPrePlugin.appProfile === null, "the real pre-plugin fixture's appProfile is NEVER reconstructed");
  ok(migratedPrePlugin.sessionSchemaIdentity && migratedPrePlugin.sessionSchemaIdentity.cwd === LEGACY_PRE_PLUGIN_SKILLS_BINDING_META.skillsBinding.cwd, "the real pre-plugin fixture's sessionSchemaIdentity IS derived from its real, already-recorded skillsBinding — that is recorded state, not a guess");
  ok(migratedPrePlugin.sessionSchemaIdentity.pluginDir === null, "the real pre-plugin fixture never had a pluginDir");
  ok(migratedPrePlugin.migrationState.legacy === true, "the real pre-plugin fixture is flagged legacy");

  const migratedPluginEra = migrateConversationMetadata(PLUGIN_ERA_SKILLS_BINDING_META);
  ok(migratedPluginEra.appProfile === null, "even a plugin-era record's appProfile is NEVER reconstructed by migration alone (only a real run's own bind does that)");
  ok(
    migratedPluginEra.sessionSchemaIdentity.pluginDir === PLUGIN_ERA_SKILLS_BINDING_META.skillsBinding.pluginDir,
    "the real plugin-era fixture's sessionSchemaIdentity carries its real pluginDir"
  );
  ok(migratedPluginEra.migrationState.legacy === true, "a record migrated from BEFORE this schema existed is flagged legacy even if its skillsBinding was already plugin-era");
}

// ---------------------------------------------------------------------------
// 2.1f — SessionManager: migration persists on first read, is idempotent,
// and newConversation() seeds a NON-legacy envelope
// ---------------------------------------------------------------------------

async function sessionManagerTests() {
  freshHome();
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });

  const conversationId = sessionManager.newConversation({});
  const fresh = sessionManager.getConversationMetadata(conversationId);
  ok(fresh.migrationState.legacy === false, "a brand-new conversation's metadata is NOT flagged legacy");
  ok(fresh.appProfile === null, "a brand-new conversation has no bound app profile yet");

  // Simulate a REAL pre-existing on-disk conversation predating this schema
  // (no conversationMetadata key at all) by writing the raw file directly —
  // the same shape this task's own investigation read off this machine's
  // real conversations/ tree (LEGACY_PRE_PLUGIN_SKILLS_BINDING_META above).
  const legacyId = "conv_real_legacy_on_disk";
  fs.mkdirSync(path.dirname(conversationMetaFile(legacyId)), { recursive: true });
  fs.writeFileSync(conversationMetaFile(legacyId), JSON.stringify({ ...LEGACY_PRE_PLUGIN_SKILLS_BINDING_META, conversationId: legacyId }));

  const firstRead = sessionManager.getConversationMetadata(legacyId);
  ok(firstRead.migrationState.legacy === true, "reading a real pre-existing on-disk record without conversationMetadata migrates it and flags legacy");
  ok(firstRead.appProfile === null, "the migrated legacy record's appProfile is null, never reconstructed");

  const onDiskAfterFirstRead = JSON.parse(fs.readFileSync(conversationMetaFile(legacyId), "utf-8"));
  ok(
    onDiskAfterFirstRead.conversationMetadata && onDiskAfterFirstRead.conversationMetadata.schemaVersion === CONVERSATION_METADATA_SCHEMA_VERSION,
    "the migrated envelope is PERSISTED back to disk on first read, not just returned in memory"
  );

  // getConversationMetadata() re-reads from disk on every call (loadMeta has
  // no in-process cache), so object identity across two calls is not the
  // right proof of "no re-migration" — the right proof is that the on-disk
  // record's own `updatedAt` (bumped by every real TranscriptStore write)
  // does not advance again on a second read, and the returned content is
  // byte-identical.
  const updatedAtAfterFirstRead = onDiskAfterFirstRead.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const secondRead = sessionManager.getConversationMetadata(legacyId);
  ok(JSON.stringify(secondRead) === JSON.stringify(firstRead), "a second read returns byte-identical content to the first migrated read");
  const onDiskAfterSecondRead = JSON.parse(fs.readFileSync(conversationMetaFile(legacyId), "utf-8"));
  ok(onDiskAfterSecondRead.updatedAt === updatedAtAfterFirstRead, "a second read never triggers a redundant disk write — updatedAt does not advance again");

  // bindConversationAppSnapshot: binds once, never overwritten by a later call.
  const boundOnce = sessionManager.bindConversationAppSnapshot(conversationId, {
    appProfile: { profileId: "p1", endpoint: "https://a.example", modelId: "m1", credentialRevision: 1 },
    sessionSchemaIdentity: null,
    permissionPolicy: null
  });
  ok(boundOnce.appProfile.profileId === "p1", "first bind persists the given app profile identity");

  const boundTwice = sessionManager.bindConversationAppSnapshot(conversationId, {
    appProfile: { profileId: "p2-should-never-appear", endpoint: "https://b.example", modelId: "m2", credentialRevision: 99 },
    sessionSchemaIdentity: null,
    permissionPolicy: null
  });
  ok(boundTwice.appProfile.profileId === "p1", "a SECOND bind call with different values never overwrites the already-bound app profile identity");

  const persisted = sessionManager.getConversationMetadata(conversationId);
  ok(persisted.appProfile.profileId === "p1", "the once-bound app profile identity is durable across a fresh read");

  // Deletion guard: bindConversationAppSnapshot must never resurrect a
  // deleted conversation's directory.
  const toDelete = sessionManager.newConversation({});
  sessionManager.deleteConversation(toDelete);
  const afterDelete = sessionManager.bindConversationAppSnapshot(toDelete, {
    appProfile: { profileId: "x" },
    sessionSchemaIdentity: null,
    permissionPolicy: null
  });
  ok(afterDelete === null, "binding an app snapshot for a deleted conversation is a no-op, not a resurrection");
  ok(!fs.existsSync(path.dirname(conversationMetaFile(toDelete))), "the deleted conversation's directory stays deleted — no resurrection on disk");
}
await sessionManagerTests();

// ---------------------------------------------------------------------------
// 2.2a — the app/SDK snapshot boundary: systemPrompt.snapshot must stay
// explicit `false` — never freezing a prior custom system prompt across a
// future resume, per sdk.d.ts's own `systemPrompt.snapshot` semantics.
// ---------------------------------------------------------------------------

{
  const optionsA = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    skills: { cwd: "/scratch/conv-1", configDir: "/scratch/conv-1/claude-config", pluginDir: "/scratch/conv-1/skills-plugin", allowedSkillNames: [], skillOverrides: {} },
    pageContext: { tabId: 1, url: "https://a.example/", title: "A", hostname: "a.example", revision: 1, boundAt: Date.now(), restricted: false, pinned: false, mustRead: false }
  });
  ok(optionsA.systemPrompt.snapshot === false, "systemPrompt.snapshot must be the STRICT boolean `false` (not merely `!== true`) — an explicit declaration, not an incidental omission");

  const optionsB = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    skills: { cwd: "/scratch/conv-1", configDir: "/scratch/conv-1/claude-config", pluginDir: "/scratch/conv-1/skills-plugin", allowedSkillNames: [], skillOverrides: {} },
    pageContext: { tabId: 2, url: "https://b.example/", title: "B", hostname: "b.example", revision: 1, boundAt: Date.now(), restricted: false, pinned: false, mustRead: false }
  });
  ok(optionsB.systemPrompt.snapshot === false, "snapshot:false holds on a second, independently-bound run too");
  ok(
    optionsA.systemPrompt.prompt !== optionsB.systemPrompt.prompt,
    "two runs with different bound page context get two DIFFERENT rendered system prompts — the app never caches/freezes a prior turn's prompt text"
  );
}

// ---------------------------------------------------------------------------
// 2.2b — end-to-end: a real run through CompanionCore binds a secret-free
// app snapshot that structurally cannot leak the credential, the SDK
// system-prompt text, or page-context content (fake sdk/profileProvider,
// same pattern as agent-context-channel.test.mjs — no live SDK/network).
// ---------------------------------------------------------------------------

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "super-secret-fake-key" },
        revision: 1,
        profileId: profileId || "default"
        // deliberately NO credentialRevision — proves the wiring tolerates
        // a provider double that predates that additive field.
      };
    }
  };
}

function recordingSdk() {
  const calls = [];
  const sdk = {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      yield { type: "assistant", text: "ok" };
    }
  };
  return { sdk, calls };
}

async function companionWiringTest() {
  freshHome();
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }), shutdown: () => {} });
  const { sdk, calls } = recordingSdk();
  const core = new CompanionCore({ toolBridge, sessionManager, lease, coerceArgs: (a) => a, sdk, profileProvider: fakeProfileProvider() });

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId,
      profileId: "my-profile",
      modelId: "claude-fake-model",
      prompt: "hello",
      context: { tabId: 7, url: "https://secret-looking-page.example/", title: "T", hostname: "secret-looking-page.example", revision: 1, boundAt: Date.now(), restricted: false, pinned: false, mustRead: false }
    })
  );

  const deadline = Date.now() + 3000;
  while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
  ok(calls.length === 1, "the run reached query() exactly once");

  const meta = sessionManager.getConversationMetadata(conversationId);
  ok(Boolean(meta && meta.appProfile), "a real run binds an app profile identity onto the conversation");
  if (meta && meta.appProfile) {
    ok(meta.appProfile.profileId === "my-profile", "the bound appProfile carries the real profileId used for the run");
    ok(meta.appProfile.endpoint === "https://example.invalid", "the bound appProfile carries the real non-secret endpoint");
    ok(meta.appProfile.modelId === "claude-fake-model", "the bound appProfile carries the real modelId");
    ok(meta.appProfile.credentialRevision === null, "a provider double with no credentialRevision field yields null, never a fabricated 0");
  }
  ok(Boolean(meta && meta.sessionSchemaIdentity), "a real run binds a session schema identity onto the conversation");
  ok(Boolean(meta && meta.permissionPolicy && Array.isArray(meta.permissionPolicy.tools)), "a real run binds a permission policy identity onto the conversation");

  const serialized = JSON.stringify(meta);
  ok(!serialized.includes("super-secret-fake-key"), "the bound conversation metadata structurally cannot contain the run's credential value");
  ok(!serialized.includes("ANTHROPIC_API_KEY"), "the bound conversation metadata never even names the credential env key");
  ok(!serialized.includes("secret-looking-page.example"), "the bound conversation metadata (the APP snapshot) never carries this turn's page/document URL — that lives only in the SDK-facing systemPrompt, not in app-owned metadata");
  ok(!serialized.includes("bound_page_context"), "the bound conversation metadata never carries any rendered system-prompt text");

  // A second START on the SAME conversation with a DIFFERENT profile/model
  // must not silently rewrite the already-bound identity. Superseded by
  // tasks 2.3-2.5 (osf-apply, same change): a genuinely different endpoint/
  // model is now the concrete case task 2.4's compatibility gate exists to
  // catch — see host/test/agent-session-continuity.test.mjs for the full
  // 2.3/2.4/2.5 evidence. This assertion is updated in place (not weakened)
  // to match the now-implemented behavior: the mismatched turn is rejected
  // BEFORE query() is ever called, and the bound identity still never
  // changes.
  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId,
      profileId: "a-different-profile",
      modelId: "a-different-model",
      prompt: "second turn"
    })
  );
  const deadline2 = Date.now() + 500;
  while (Date.now() < deadline2) await new Promise((r) => setTimeout(r, 15));
  ok(calls.length === 1, "a run whose resolved model disagrees with the conversation's already-bound identity is rejected before query() (task 2.4), not silently run");
  const snapAfterSecondRun = sessionManager.snapshotSince(conversationId, 0);
  const rejectionEvent = snapAfterSecondRun.events.find((e) => e.type === "run_error" && e.reason === "conversation_identity_incompatible");
  ok(Boolean(rejectionEvent), "the rejection is a structured, explicit run_error, not a silent no-op");
  const metaAfterSecondRun = sessionManager.getConversationMetadata(conversationId);
  ok(metaAfterSecondRun.appProfile.profileId === "my-profile", "a second run with a different profileId never overwrites the conversation's already-bound app profile identity");
  ok(metaAfterSecondRun.appProfile.modelId === "claude-fake-model", "...nor its modelId");
}
await companionWiringTest();

console.log(`\n${fail === 0 ? "ALL CONVERSATION METADATA TESTS PASSED" : `${fail} FAILURE(S)`}\n`);
process.exit(fail ? 1 : 0);

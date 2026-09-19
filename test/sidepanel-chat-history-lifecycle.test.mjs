#!/usr/bin/env node
// Panel <-> companion integration for openspec/changes/optimize-chat-history
// tasks 1.1-1.3 and 3.2: the panel's history list mirrors the host's
// AUTHORITATIVE summaries, deletion goes through the host first (and a
// failure is never presented as a success), and older transcript pages load
// lazily without duplicating what is already rendered.
//
// Real modules throughout: CompanionCore, SessionManager, TranscriptStore,
// BrowserLease, ApprovalRegistry, ProtocolClient, PanelController,
// HistoryStore. Only the SDK query() generator and the settings profile
// provider are fakes (no live API key or browser in this environment), the
// same convention test/sidepanel-fake-companion.test.mjs and
// host/test/agent-companion-core.test.mjs already document.
//
// Run: node test/sidepanel-chat-history-lifecycle.test.mjs

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

import { ProtocolClient } from "../extension/sidepanel/protocol-client.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";
import { HistoryStore } from "../extension/sidepanel/history-store.js";
import { ProfileCache } from "../extension/sidepanel/profile-cache.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-chat-history-panel-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

async function waitUntil(fn, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function fakeProfileProvider() {
  return {
    async snapshotForRun() {
      return { profileId: "default", baseUrl: "https://example.invalid", modelId: "fake-model", credential: "fake-key", skills: null };
    }
  };
}

function fakeSdk(messages) {
  return {
    async *query() {
      for (const message of messages) yield message;
    }
  };
}

function completeProfile() {
  return {
    profileId: "default",
    baseUrl: "https://example.invalid",
    models: [{ id: "fake-model", label: "Fake" }],
    defaultModelId: "fake-model",
    revision: 1,
    capabilityTest: { ok: true, at: Date.now(), credentialRevision: 1 }
  };
}

function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      if (key == null) return { ...data };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in data) out[k] = data[k];
        return out;
      }
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

/** Reproduces companion.js's runAsForkedChild() live-forwarding wiring over
 * an in-memory delivery callback (see test/sidepanel-fake-companion.test.mjs
 * for the full rationale). */
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

function buildCore({ sdk } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => ({ content: [{ type: "text", text: "fake" }] }),
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || fakeSdk([{ type: "result", subtype: "success", result: "ok" }]),
    profileProvider: fakeProfileProvider()
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
        if (!reply) return;
        if (Array.isArray(reply.multi)) {
          for (const part of reply.multi) deliver(part);
          return;
        }
        deliver(reply);
      });
    },
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    disconnect: () => {
      for (const fn of disconnectListeners) fn();
    }
  };
}

/** A transport that accepts the request and never answers — the "companion
 * is gone / wedged" case a delete must survive without claiming success. */
function deadTransport() {
  return {
    postMessage: () => {},
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {}
  };
}

/**
 * A bridge transport whose `list_conversations` requests are HELD until
 * `releaseProbe()` — so a snapshot/resume reply can be made to land first,
 * which is the boot race the model cap has to survive (tasks.md 3.3). Every
 * other message (hello, new_conversation, …) is delivered immediately, and
 * the held requests are sent for real on release so the probe still answers.
 */
function gatedProbeTransport(core) {
  const inner = makeBridgeTransport(core);
  const held = [];
  return {
    postMessage: (msg) => {
      const type = msg && msg.envelope && msg.envelope.type;
      if (type === "list_conversations") {
        held.push(msg);
        return;
      }
      inner.postMessage(msg);
    },
    onMessage: inner.onMessage,
    onDisconnect: inner.onDisconnect,
    disconnect: () => inner.disconnect(),
    heldCount: () => held.length,
    releaseProbe: () => {
      for (const msg of held.splice(0)) inner.postMessage(msg);
    }
  };
}

function buildPanel(core, { storage = memStorage(), scope = "panel-scope-lifecycle", requestTimeoutMs = 2000, transport } = {}) {
  const protocolClient = new ProtocolClient({ createTransport: transport || (() => makeBridgeTransport(core)) });
  const historyStore = new HistoryStore({ storage });
  const panel = new PanelController({
    protocolClient,
    historyStore,
    profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
    identity: async () => ({ installationId: "test-install", connectionId: `conn-${Math.random()}` }),
    scope,
    requestTimeoutMs
  });
  return { panel, historyStore, protocolClient };
}

async function main() {
  console.log("== 1.2 reconcile: the panel list mirrors the host's authoritative summaries ==");
  {
    const core = buildCore();
    const { panel } = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const first = panel.currentConversationId;
    await panel.sendMessage("đọc bài báo này", { pageContext: { hostname: "vnexpress.net", url: "https://vnexpress.net/a", title: "A", tabId: 3 } });
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null && panel.currentConversationId !== first);
    const second = panel.currentConversationId;

    const reconciled = await panel.reconcileHistory();
    ok(reconciled && reconciled.reconciled === 2, `both conversations came back from the host (reconciled ${reconciled && reconciled.reconciled})`);
    ok(panel.hostHistorySupport() === true, "the panel proved the host speaks its history protocol and switched to the host-authoritative path");
    const list = await panel.historyStore.list();
    const firstEntry = list.find((c) => c.conversationId === first);
    ok(firstEntry && firstEntry.revision >= 1, "the panel pushed a presentation revision for the conversation it ran");
    ok(firstEntry.title === "đọc bài báo này", "the host summary carries the title the panel derived from the first user message");
    ok(firstEntry.hostname === "vnexpress.net", "and the hostname of the page the run was bound to");
    ok(firstEntry.stale === false, "a conversation the host still reports is not stale");
  }

  console.log("== empty conversations: the host grades them, and the first question brings the row back ==");
  {
    const core = buildCore();
    const { panel, historyStore } = buildPanel(core, { storage: memStorage(), scope: "tab-empty-data" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const conversationId = panel.currentConversationId;

    const reconciled = await panel.reconcileHistory();
    ok(reconciled && reconciled.reconciled >= 1, "the fresh conversation is reconciled against the host's authoritative list");
    let entry = await historyStore.get(conversationId);
    ok(entry && entry.hasData === false, "the panel's own model has no item yet, so the row is cached as KNOWN-empty (the list will not render it)");
    const summaryBefore = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summaryBefore.hasData === false, "…and the host's authoritative summary agrees, so a second, freshly booted panel hides it too");

    // The first question: the panel's model gains its user item at once, and
    // the run's own events reach the host — either half is enough to bring
    // the row back.
    await panel.sendMessage("câu hỏi đầu tiên");
    const flipped = await waitUntil(async () => (await historyStore.get(conversationId)).hasData === true);
    ok(flipped, "the conversation's first question flips the cached entry to hasData:true, so its row appears");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);
    ok(panel.models.get(conversationId).items.length > 0, "the model really holds the run's items (the panel half of the signal)");

    await panel.reconcileHistory();
    entry = await historyStore.get(conversationId);
    ok(entry.hasData === true, "and the reconcile agrees with the panel rather than resetting it");
    const summaryAfter = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summaryAfter.hasData === true, "the host grades the conversation as having data from now on");
  }

  console.log("== 1.2 reconcile: an orphaned local entry is marked stale and is never auto-resumed ==");
  {
    const core = buildCore();
    const storage = memStorage();
    const { panel, historyStore } = buildPanel(core, { storage, scope: "tab-orphan" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    // A conversation that exists ONLY in this browser profile's cache.
    await historyStore.upsert({ conversationId: "conv_orphan", title: "chỉ cục bộ" });
    await historyStore.setLastActive("tab-orphan", "conv_orphan");

    const result = await panel.reconcileHistory();
    ok(result && result.orphans.includes("conv_orphan"), "the reconcile reports the orphan");
    const entry = await historyStore.get("conv_orphan");
    ok(entry && entry.stale === true, "the orphan is marked stale");
    ok(entry.title === "chỉ cục bộ", "...and keeps its last-known local preview (the host record is exactly what is unavailable)");

    // A boot restore must not try to resume it.
    const { panel: freshPanel, protocolClient } = buildPanel(core, { storage, scope: "tab-orphan" });
    let resumeCalls = 0;
    const realResume = protocolClient.resumeConversation.bind(protocolClient);
    protocolClient.resumeConversation = (...args) => {
      resumeCalls++;
      return realResume(...args);
    };
    await freshPanel.init();
    await waitUntil(() => freshPanel.protocol.handshakeState() === "ok");
    await freshPanel.restoreOrStartConversation();
    await waitUntil(() => freshPanel.currentConversationId != null);
    ok(freshPanel.currentConversationId !== "conv_orphan", "the remembered-but-orphaned conversation is not restored");
    ok(resumeCalls === 0, "it is never even sent as a resume");
  }

  console.log("== 1.3 delete: the host is asked first, and only its confirmation drops the local row ==");
  {
    const core = buildCore();
    const storage = memStorage();
    const { panel, historyStore } = buildPanel(core, { storage, scope: "tab-delete" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const conversationId = panel.currentConversationId;

    const result = await panel.deleteConversation(conversationId);
    ok(result.ok === true && result.onDiskRemoved === true, "a confirmed delete reports ok with the on-disk outcome");
    ok((await historyStore.get(conversationId)) === null, "the local row is dropped only after that confirmation");
    ok(panel.currentConversationId === null, "and the deleted conversation is no longer the active one");
    ok(!core.sessionManager.hasConversation(conversationId), "the host genuinely no longer has it");
  }

  console.log("== 1.3 delete FAILURE never reports success: an unknown conversation leaves the local row alone ==");
  {
    const core = buildCore();
    const storage = memStorage();
    const { panel, historyStore } = buildPanel(core, { storage, scope: "tab-delete-unknown" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    // A local-only row the host has never heard of.
    await historyStore.upsert({ conversationId: "conv_local_only", title: "chỉ cục bộ" });

    const result = await panel.deleteConversation("conv_local_only");
    ok(result.ok === false && result.reason === "unknown_conversation", `the host's refusal is surfaced as a failure (${result.reason})`);
    ok((await historyStore.get("conv_local_only")) !== null, "the local row is NOT removed — the UI must not claim a local-only removal");
  }

  console.log("== 1.3 delete FAILURE never reports success: a dead companion leaves the local row alone ==");
  {
    const core = buildCore();
    const storage = memStorage();
    const { panel, historyStore } = buildPanel(core, { storage, scope: "tab-delete-dead", transport: () => deadTransport(), requestTimeoutMs: 40 });
    await panel.init();
    await historyStore.upsert({ conversationId: "conv_dead", title: "vẫn còn" });

    const result = await panel.deleteConversation("conv_dead");
    ok(result.ok === false && result.reason === "host_unavailable", `an unacknowledged delete resolves to a failure, not a hang (${result.reason})`);
    ok((await historyStore.get("conv_dead")) !== null, "and the local row survives so the operator can retry");
  }

  console.log("== 1.3 delete-all: a partial host sweep keeps the whole local cache ==");
  {
    const core = buildCore();
    const storage = memStorage();
    const { panel, historyStore } = buildPanel(core, { storage, scope: "tab-delete-all" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const a = panel.currentConversationId;
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null && panel.currentConversationId !== a);
    const b = panel.currentConversationId;
    await panel.reconcileHistory();
    const beforeCount = (await historyStore.list()).length;
    ok(beforeCount >= 2, `both conversations are cached locally before the sweep (${beforeCount})`);

    // Inject a partial failure on the HOST side.
    const store = core.sessionManager.store;
    const originalDelete = store.deleteConversation.bind(store);
    store.deleteConversation = (id) => (id === b ? { removed: false } : originalDelete(id));
    const partial = await panel.deleteAllConversations();
    store.deleteConversation = originalDelete;
    ok(partial.ok === false && partial.reason === "partial_failure", "a partial sweep is reported as failure");
    ok(partial.failed.some((f) => f.conversationId === b), "with the conversation that could not be removed named");
    ok((await historyStore.list()).length === beforeCount, "the local cache is KEPT in full — clearing it would misrepresent the host state");

    // Now a clean sweep clears everything.
    const clean = await panel.deleteAllConversations();
    ok(clean.ok === true && clean.count >= 1, "a complete sweep is reported as success");
    ok((await historyStore.list()).length === 0, "and only then is the local cache cleared");
  }

  console.log("== 1.3 delete/delete-all are idempotent: the same key replays the same answer ==");
  {
    const core = buildCore();
    const { panel } = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const conversationId = panel.currentConversationId;

    const first = await panel.deleteConversation(conversationId, { idempotencyKey: "fixed-key" });
    ok(first.ok === true, "the first delete succeeds");
    const retry = await panel.deleteConversation(conversationId, { idempotencyKey: "fixed-key" });
    ok(retry.ok === true, "retrying the SAME key replays a success rather than reporting a spurious failure");
    ok(retry.onDiskRemoved === first.onDiskRemoved, "...replaying the original reply's outcome verbatim (not a second, differently-shaped answer)");
  }

  console.log("== 3.2 lazy older events load through the real panel<->companion round trip ==");
  {
    const core = buildCore();
    const { panel } = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const conversationId = panel.currentConversationId;

    // Give the conversation a real, long transcript on the host, then open it
    // through a bounded snapshot (the panel's model cap is what limits the
    // window here).
    for (let i = 0; i < 40; i++) {
      core.sessionManager.store.appendEvent(conversationId, {
        type: "stream_message",
        runId: "run_history",
        message: { type: "assistant", message: { content: [{ type: "text", text: `mảnh ${i} ` }] } }
      });
    }
    panel.models.set(conversationId, new (panel.currentModel().constructor)(conversationId, { maxWindowEvents: 12 }));
    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel.models.get(conversationId).windowSize() > 0);
    const model = panel.models.get(conversationId);
    ok(model.windowSize() <= 12, "the reopened transcript is capped to the model's window");
    ok(model.hasOlderEvents() === true, "and the panel knows more history exists below");
    const firstSeqBefore = model.oldestLoadedSeq();

    const applied = await panel.loadOlderEvents(conversationId, { limit: 5 });
    ok(applied && applied.added > 0, `an older page was retrieved and merged (added ${applied && applied.added})`);
    ok(model.oldestLoadedSeq() < firstSeqBefore, "the window now reaches further back");
    ok(model.windowSize() <= 12, "and it is still bounded by the cap");
    const seqs = model._windowEvents.map((e) => e.seq);
    ok(new Set(seqs).size === seqs.length, "no duplicate event entered the window through the round trip");
  }

  console.log("== 2.1 the streaming persist path coalesces instead of rewriting the index per event ==");
  {
    const core = buildCore({
      sdk: fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "một " }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "hai " }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "ba" }] } },
        { type: "result", subtype: "success", result: "ba" }
      ])
    });
    const storage = memStorage();
    const { panel } = buildPanel(core, { storage, scope: "tab-coalesce" });
    const historyStore = panel.historyStore;
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);

    let writes = 0;
    const originalSet = storage.set.bind(storage);
    // Count only the HISTORY writes (per-conversation keys), not the policy.
    storage.set = async (obj) => {
      if (Object.keys(obj).some((k) => k.startsWith("ocic_conversation_history_v2:"))) writes++;
      return originalSet(obj);
    };
    await panel.sendMessage("một câu hỏi dài");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);
    await new Promise((r) => setTimeout(r, 50));
    ok(writes >= 1, "the run's history was persisted at least once");
    ok(writes <= 4, `the streaming run did not rewrite the index per event (${writes} writes for a 4-message run)`);
    const entry = await historyStore.get(panel.currentConversationId);
    ok(entry && entry.title === "một câu hỏi dài", "and the final metadata is durable");
  }

  console.log("== derived titles: an untitled conversation is named from its FIRST question, however it was opened ==");
  {
    const core = buildCore();
    const { panel, historyStore } = buildPanel(core, { storage: memStorage(), scope: "tab-derived-resume" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    // The resumed/reloaded/older shape: a conversation the host carries with
    // NO title, whose questions this profile recorded in an earlier panel
    // instance. It used to keep the generic fallback row forever, because the
    // derived title was only ever offered to conversations THIS instance had
    // created.
    const conversationId = core.sessionManager.newConversation();
    const firstQuestion = `câu hỏi đầu tiên ${"rất dài ".repeat(10)}`;
    await historyStore.upsert({ conversationId });
    await historyStore.recordPrompt(conversationId, "run_rec_1", firstQuestion);
    await historyStore.recordPrompt(conversationId, "run_rec_2", "câu hỏi thứ hai");

    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel._pendingResumes.length === 0);
    const titled = await waitUntil(() => {
      const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
      return !!summary && summary.title === firstQuestion.slice(0, 60);
    });
    ok(titled, "the resumed, untitled conversation is titled on the host from its FIRST question (clamped to 60)");
    const row = await historyStore.get(conversationId);
    ok(row && row.title === firstQuestion.slice(0, 60), "…and the local row carries the same derived title");
  }

  console.log("== derived titles: a host title is never touched, and nothing is invented without a real first question ==");
  {
    // (b) An operator rename already on the host, mirrored in the local cache
    // as a reconcile would have left it. A panel instance that never listed
    // the host resumes and must derive nothing at all.
    const core = buildCore();
    const storage = memStorage();
    const conversationId = core.sessionManager.newConversation();
    core.sessionManager.updateConversationPresentation(conversationId, { title: "Tên do người dùng đặt" });
    const { panel, historyStore } = buildPanel(core, { storage, scope: "tab-derived-rename" });
    await historyStore.upsert({ conversationId, title: "Tên do người dùng đặt" });
    await historyStore.recordPrompt(conversationId, "run_rec_1", "câu hỏi đầu tiên");
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel._pendingResumes.length === 0);
    await new Promise((r) => setTimeout(r, 60)); // the debounce + flush window an incorrect derived push would ride

    let summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summary.title === "Tên do người dùng đặt", `a resuming panel never overwrites the host's title ("${summary.title}")`);
    ok(panel._hostMetadataSent.has(conversationId) === false, "…and it derives nothing to push at all");
    ok((await historyStore.get(conversationId)).title === "Tên do người dùng đặt", "…nor does it touch the local row");
  }
  {
    // (c) The host transcript holds a run whose prompt this profile never
    // cached, so the rebuilt conversation's only user message is an explicit
    // placeholder. That must never become a title.
    const core = buildCore();
    const { panel, historyStore } = buildPanel(core, { storage: memStorage(), scope: "tab-derived-placeholder" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    const conversationId = core.sessionManager.newConversation();
    core.sessionManager.store.appendEvent(conversationId, { type: "run_created", runId: "run_no_echo" });
    core.sessionManager.store.appendEvent(conversationId, { type: "run_done", runId: "run_no_echo" });
    await historyStore.upsert({ conversationId });

    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel._pendingResumes.length === 0);
    const firstUser = panel.models.get(conversationId).items.find((i) => i.kind === "user");
    ok(firstUser && firstUser.isPlaceholder === true, "the rebuilt transcript's only user message is an explicit placeholder");
    await new Promise((r) => setTimeout(r, 60));
    const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summary.title == null, "a placeholder is never pushed as a title");
    ok((await historyStore.get(conversationId)).title == null, "…and the local row stays untitled (the generic fallback)");
  }
  {
    // (d) Same placeholder model, but the store DOES hold a recorded prompt
    // (keyed to a run the host's transcript cannot echo, because the host
    // never persists prompt text). The store's earliest entry is the only
    // source that can name this conversation, and it must be used.
    const core = buildCore();
    const { panel, historyStore } = buildPanel(core, { storage: memStorage(), scope: "tab-derived-store" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    const conversationId = core.sessionManager.newConversation();
    core.sessionManager.store.appendEvent(conversationId, { type: "run_created", runId: "run_without_echo" });
    core.sessionManager.store.appendEvent(conversationId, { type: "run_done", runId: "run_without_echo" });
    await historyStore.upsert({ conversationId });
    await historyStore.recordPrompt(conversationId, "run_recorded_locally", "câu hỏi chỉ có trong kho cục bộ");

    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel._pendingResumes.length === 0);
    const firstUser = panel.models.get(conversationId).items.find((i) => i.kind === "user");
    ok(firstUser && firstUser.isPlaceholder === true, "the model's leading user item is still a placeholder");
    const titled = await waitUntil(() => {
      const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
      return !!summary && summary.title === "câu hỏi chỉ có trong kho cục bộ";
    });
    ok(titled, "the store's earliest recorded prompt titles the conversation anyway");
    ok((await historyStore.get(conversationId)).title === "câu hỏi chỉ có trong kho cục bộ", "…and lands on the local row");
  }
  {
    // (e) No question at all yet: the conversation keeps the row's generic
    // fallback and nothing is invented.
    const core = buildCore();
    const { panel, historyStore } = buildPanel(core, { storage: memStorage(), scope: "tab-derived-empty" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    const conversationId = core.sessionManager.newConversation();
    await historyStore.upsert({ conversationId });

    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel._pendingResumes.length === 0);
    ok(panel.models.get(conversationId).items.every((i) => i.kind !== "user"), "the empty conversation has no user message at all");
    await new Promise((r) => setTimeout(r, 60));
    const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summary.title == null, "an empty conversation stays untitled, so the row keeps its generic fallback");
    ok((await historyStore.get(conversationId)).title == null, "…and nothing is invented locally either");
  }

  console.log("== reopening an OLD conversation shows what was asked, not a placeholder ==");
  {
    // The reported symptom, end to end: a conversation whose question this
    // panel document never sent — the shape a browser restart, a fresh panel
    // or a cleared local cache produces. The transcript is the ONLY source of
    // the question (nothing is seeded into the local prompt cache here on
    // purpose: that cache is bounded, local and provably empty for most real
    // profiles).
    const core = buildCore();
    const first = buildPanel(core, { storage: memStorage(), scope: "tab-reopen-original" });
    await first.panel.init();
    await waitUntil(() => first.panel.protocol.handshakeState() === "ok");
    await first.panel.startNewConversation();
    await waitUntil(() => first.panel.currentConversationId != null);
    const conversationId = first.panel.currentConversationId;
    const prompt = "vì sao mở lại hội thoại cũ thì không thấy câu hỏi?";
    await first.panel.sendMessage(prompt, { pageContext: { hostname: "vinades.org", url: "https://vinades.org/x", title: "X", tabId: 42 } });
    await waitUntil(() => first.panel.currentPhase() === RUN_PHASE.COMPLETED);
    ok(
      core.sessionManager.store.allEvents(conversationId).some((e) => e.type === "message_submitted"),
      "the host recorded the operator's message durably (not only in this panel's local cache)"
    );

    // A DIFFERENT panel document with an EMPTY local cache — no prompt echo,
    // no reconciling list, nothing but the host.
    const second = buildPanel(core, { storage: memStorage(), scope: "tab-reopen-fresh" });
    await second.panel.init();
    await waitUntil(() => second.panel.protocol.handshakeState() === "ok");
    await second.panel.reopenConversation(conversationId);
    await waitUntil(() => second.panel._pendingResumes.length === 0);

    const rebuilt = second.panel.models.get(conversationId);
    const firstUser = rebuilt.items.find((i) => i.kind === "user");
    ok(!!firstUser, "the reopened conversation renders the operator's message");
    ok(firstUser && firstUser.text === prompt, `...with the exact text that was sent ("${firstUser && firstUser.text}")`);
    ok(firstUser && firstUser.isPlaceholder !== true, "...as a real bubble, never the \"[Nội dung tin nhắn trước đó không có sẵn]\" placeholder");
    ok(rebuilt.items.filter((i) => i.kind === "user").length === 1, "...exactly once — the replay never doubles the bubble");

    // The local prompt cache and the derived title are fed from that same
    // durable record, so the row is titled from the question instead of
    // staying the generic fallback.
    ok(
      (await second.historyStore.promptsFor(conversationId)).size === 1,
      "the local prompt cache is seeded from the durable transcript"
    );
    const titled = await waitUntil(() => {
      const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
      return !!summary && summary.title === prompt.slice(0, 60);
    });
    ok(titled, "and the conversation is titled from its first question");
  }
  {
    // A conversation recorded BEFORE this change has no durable user message
    // at all: the placeholder is then the honest answer, and it must still be
    // exactly what renders (the fix must not invent text on its behalf).
    const core = buildCore();
    const { panel } = buildPanel(core, { storage: memStorage(), scope: "tab-reopen-legacy" });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    const conversationId = core.sessionManager.newConversation();
    core.sessionManager.store.appendEvent(conversationId, { type: "run_created", runId: "run_legacy" });
    core.sessionManager.store.appendEvent(conversationId, { type: "run_done", runId: "run_legacy" });

    await panel.reopenConversation(conversationId);
    await waitUntil(() => panel._pendingResumes.length === 0);
    const firstUser = panel.models.get(conversationId).items.find((i) => i.kind === "user");
    ok(firstUser && firstUser.isPlaceholder === true, "a legacy run with no recorded message still says so honestly");
  }

  console.log("== migration-plan gate: an OLDER companion that refuses the history protocol gets the pre-change behaviour ==");
  {
    // Exactly the shape an older companion answers an unknown message type
    // with: no requestId, just `inReplyTo` (protocol-client.js's own comment
    // documents this fallback path).
    const refusedTypes = [];
    const oldCompanionTransport = () => ({
      postMessage: (msg) => {
        const type = msg && msg.envelope && msg.envelope.type;
        if (!type || type === "hello") return; // an old host simply has no history messages
        refusedTypes.push(type);
        const reply = makeEnvelope(AGENT_MESSAGE_TYPES.ERROR, { reason: "unknown_message_type", inReplyTo: type });
        setTimeout(() => listeners.forEach((fn) => fn({ type: "agent_msg", envelope: reply })), 0);
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      disconnect: () => {}
    });
    const listeners = [];
    const { panel, historyStore } = buildPanel(buildCore(), { transport: oldCompanionTransport, requestTimeoutMs: 1000 });
    await panel.init();
    await waitUntil(() => panel.hostHistorySupport() === false);
    ok(panel.hostHistorySupport() === false, "the panel learns the host cannot answer the history protocol");

    const started = Date.now();
    const reconciled = await panel.reconcileHistory();
    ok(reconciled === null && Date.now() - started < 500, "reconcile falls back to the local cache immediately instead of waiting out a timeout");
    ok(refusedTypes.includes("list_conversations"), "the panel did ask, and the refusal is what set the gate");

    await historyStore.upsert({ conversationId: "conv_old_host", title: "vẫn giữ" });
    ok((await historyStore.get("conv_old_host")).hasData !== false, "an old companion's summaries never mark anything as empty, so its history list keeps showing every row");
    const deleted = await panel.deleteConversation("conv_old_host");
    ok(deleted.ok === false && deleted.reason === "host_protocol_unsupported", "a delete against an old host fails explicitly rather than pretending a local-only removal worked");
    ok((await historyStore.get("conv_old_host")) !== null, "and the local row is untouched");
    ok((await panel.loadOlderEvents("conv_old_host")) === null, "older-page loading is disabled for a host that cannot serve pages");

    // Windowed rendering is disabled too: the whole (host-bounded) snapshot is
    // rendered, exactly as the pre-change panel did.
    const model = panel._getOrCreateModel("conv_old_host");
    ok(model.maxWindowEvents === Infinity, "models created while the host is unsupported render the whole transcript, not a window");
    const events = [];
    for (let seq = 1; seq <= 50; seq++) {
      events.push({ seq, type: seq === 1 ? "run_created" : "stream_message", runId: "ro", ...(seq > 1 ? { message: { type: "assistant", message: { content: [{ type: "text", text: "x" }] } } } : {}) });
    }
    model.applySnapshot({ conversationId: "conv_old_host", meta: {}, lastSeq: 50, firstSeq: 1, hasOlder: false, events });
    ok(model.windowSize() === 50, "every event stays in the model (no hidden history)");
  }

  console.log("== boot race: a conversation whose snapshot beats the history probe stays CAPPED (tasks.md 3.3) ==");
  {
    // The probe is fire-and-forget (panel-controller.js's init()), so the
    // first conversation's snapshot can arrive while `hostHistorySupport()`
    // is still `null`. A model built in that window keeps its cap for the
    // panel's whole lifetime, so "not proven yet" must NOT be read as "the
    // host refused" — that reading left the conversation on an unbounded
    // event window, the exact hole this test pins.
    const core = buildCore();
    const transport = gatedProbeTransport(core);
    const { panel } = buildPanel(core, { transport: () => transport, requestTimeoutMs: 2000 });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await waitUntil(() => transport.heldCount() > 0);
    ok(transport.heldCount() === 1, "exactly one history probe is outstanding while the reply is held");
    ok(panel.hostHistorySupport() === null, "the probe has not answered, so support is still unproven (null, not false)");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const conversationId = panel.currentConversationId;
    const model = panel.models.get(conversationId);
    ok(!!model, "the snapshot reply built the conversation's model while the probe was still in flight");
    ok(Number.isFinite(model.maxWindowEvents), `…and that model is capped, not unbounded (maxWindowEvents=${model.maxWindowEvents})`);

    // The cap is the real property, not a field: a snapshot longer than the
    // window is trimmed instead of being retained whole.
    const events = [];
    for (let seq = 1; seq <= 1500; seq++) {
      events.push({
        seq,
        type: seq === 1 ? "run_created" : "stream_message",
        runId: "run_race",
        ...(seq > 1 ? { message: { type: "assistant", message: { content: [{ type: "text", text: "x" }] } } } : {})
      });
    }
    model.applySnapshot({ conversationId, meta: {}, lastSeq: 1500, firstSeq: 1, hasOlder: false, events });
    ok(model.windowSize() <= model.maxWindowEvents && model.windowSize() < 1500, `a 1500-event snapshot is trimmed to the window (${model.windowSize()} retained)`);

    // The probe's answer arrives LATE and proves the host does speak the
    // protocol: the raced conversation must keep the bounded model it was
    // built with, never be handed an unbounded window retroactively.
    transport.releaseProbe();
    await waitUntil(() => panel.hostHistorySupport() === true);
    ok(panel.hostHistorySupport() === true, "the held probe reply lands and proves the host speaks the history protocol");
    ok(panel.models.get(conversationId) === model && Number.isFinite(panel.models.get(conversationId).maxWindowEvents), "the raced conversation keeps its capped model after the proof arrives");
  }

  fs.rmSync(scratchRoot, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL SIDEPANEL CHAT-HISTORY LIFECYCLE TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

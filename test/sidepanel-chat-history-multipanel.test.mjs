#!/usr/bin/env node
// Multi-panel integration for openspec/changes/optimize-chat-history tasks 4.3
// and 5.1: two side-panel documents sharing one chrome.storage backend and one
// real companion, plus the export round trip.
//
// Real modules throughout: CompanionCore, SessionManager, TranscriptStore,
// BrowserLease, ApprovalRegistry, ProtocolClient, PanelController, HistoryStore,
// HistoryListView. Only the SDK query() generator and the settings profile
// provider are fakes (no live API key or browser in this environment), the same
// convention test/sidepanel-chat-history-lifecycle.test.mjs documents.
//
// The acceptance-critical claims:
//   * chat-history-browsing "Live synchronization": a rename, pin, archive or
//     delete performed in panel A reaches panel B without a page reload — and
//     reaches it INCREMENTALLY: B's live history view re-renders the affected
//     row in place and keeps its DOM node (tasks.md 4.2's "incremental DOM
//     updates", asserted here through the real view, not a mock).
//   * chat-history-lifecycle "Organization and export": rename/pin/archive go
//     through the host with a revision guard, a stale edit from the second
//     panel is refused instead of clobbering the first, and the exported
//     artifact contains the WHOLE host transcript (multi-page), not the
//     panel's bounded window.
//   * chat-history-storage "Privacy control": turning raw-prompt caching off in
//     one panel takes effect in the other panel's cache too.
//   * chat-history-lifecycle "Complete deletion": two panels deleting the same
//     conversation both end up honest — the host removed it once and neither
//     cache keeps a row that no longer exists.
//
// Run: node test/sidepanel-chat-history-multipanel.test.mjs

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
import { HistoryListView } from "../extension/sidepanel/history-view.js";
import { ConversationModel as PanelControllerModel } from "../extension/sidepanel/conversation-model.js";
import { ProfileCache } from "../extension/sidepanel/profile-cache.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";
import { createDocument } from "./_fake-dom.mjs";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-chat-history-multipanel-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

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

/**
 * One chrome.storage.local backend shared by both panels, including the
 * `chrome.storage.onChanged` fan-out a real browser performs. Without the
 * fan-out the "second panel converges" claims would be asserted against a
 * backend that never tells anyone anything.
 */
function sharedStorage(seed = {}) {
  const data = { ...seed };
  const listeners = [];
  const notify = (changes) => {
    for (const fn of [...listeners]) fn(changes, "local");
  };
  const storage = {
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
      const changes = {};
      for (const [k, v] of Object.entries(obj)) changes[k] = { newValue: v };
      notify(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
        changes[key] = { newValue: undefined };
      }
      notify(changes);
    },
    inspect: () => ({ ...data }),
    addListener: (fn) => listeners.push(fn)
  };
  globalThis.chrome = { storage: { onChanged: { addListener: (fn) => listeners.push(fn) } } };
  return storage;
}

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

function buildCore({ sdk, store } = {}) {
  const transcriptStore = store || new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store: transcriptStore, lease, approvals });
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

/** A panel document: its own controller, its own history store over the SHARED
 * backend, and (optionally) a live history view — the same wiring
 * sidepanel.js performs, minus the chrome.* page plumbing. */
function buildPanel(core, { storage, scope, withView = true } = {}) {
  const doc = withView ? createDocument() : null;
  const protocolClient = new ProtocolClient({ createTransport: () => makeBridgeTransport(core) });
  const historyStore = new HistoryStore({ storage });
  const panel = new PanelController({
    protocolClient,
    historyStore,
    profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
    identity: async () => ({ installationId: "test-install", connectionId: `conn-${scope}` }),
    scope,
    requestTimeoutMs: 2000
  });
  let view = null;
  let container = null;
  let refreshes = Promise.resolve();
  if (withView) {
    container = doc.createElement("div");
    view = new HistoryListView({ container, document: doc, pageSize: 10, actions: {} });
    // Exactly sidepanel.js's live-sync subscription: an external change
    // re-renders the view from the cache it already has (no host round trip).
    historyStore.onChange((event) => {
      if (!view || !event) return;
      if (event.type === "external_change" || event.type === "removed" || event.type === "cleared") {
        refreshes = refreshes.then(async () => {
          view.setEntries(await historyStore.list());
          view.render();
        });
      }
    });
  }
  const renderView = async () => {
    view.setEntries(await historyStore.list());
    view.render();
  };
  const settle = async () => {
    await refreshes;
    await new Promise((r) => setTimeout(r, 5));
  };
  return { panel, historyStore, protocolClient, view, container, renderView, settle, doc };
}

function rowNodeOf(container, conversationId) {
  return container.children.find((child) => child.getAttribute("data-conversation-id") === conversationId) || null;
}

function firstTitleNode(node) {
  return node.children[1].children[0].children[0];
}

async function main() {
  console.log("== concurrent panels: a rename in one panel updates the other's row in place, host-authoritative ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a" });
    const b = buildPanel(core, { storage, scope: "tab-b" });
    await a.panel.init();
    await b.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok" && b.panel.protocol.handshakeState() === "ok");

    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;
    await a.panel.sendMessage("đọc bài báo này", { pageContext: { hostname: "vnexpress.net", url: "https://vnexpress.net/a", title: "A", tabId: 3 } });
    await waitUntil(() => a.panel.currentPhase() === RUN_PHASE.COMPLETED);

    await a.panel.reconcileHistory();
    await b.panel.reconcileHistory();
    await a.renderView();
    await b.renderView();
    const aRow = rowNodeOf(a.container, conversationId);
    const bRow = rowNodeOf(b.container, conversationId);
    ok(!!aRow && !!bRow, "both panels list the conversation");
    ok(firstTitleNode(bRow).textContent === "đọc bài báo này", "the derived title (first user message) reached the host and back into the second panel");

    // Panel A renames it. B has never asked the host again.
    const renamed = await a.panel.updateConversationPresentation(conversationId, { title: "Báo cáo quý 3" });
    ok(renamed.ok === true, "the host accepted the rename");
    await waitUntil(() => firstTitleNode(rowNodeOf(b.container, conversationId) || bRow).textContent === "Báo cáo quý 3");
    ok(rowNodeOf(b.container, conversationId) === bRow, "panel B updated the SAME row node — no reload, no rebuild");
    ok(firstTitleNode(bRow).textContent === "Báo cáo quý 3", "…and shows the host's new title");

    const summaries = core.sessionManager.conversationSummaries().conversations;
    ok(summaries.find((s) => s.conversationId === conversationId).title === "Báo cáo quý 3", "the host's authoritative summary carries the rename");

    // A pin, then an archive toggle, both from B this time.
    const pinned = await b.panel.updateConversationPresentation(conversationId, { pinned: true });
    ok(pinned.ok === true, "panel B pinned the conversation through the host");
    await waitUntil(() => {
      const row = rowNodeOf(a.container, conversationId);
      return !!row && row.children[1].children[0].children[1].children.some((pill) => pill.textContent === "Đã ghim");
    });
    const rowA = rowNodeOf(a.container, conversationId);
    ok(rowA.children[1].children[0].children[1].children.some((pill) => pill.textContent === "Đã ghim"), "panel A shows the pin panel B made");
    const controls = rowA.children[1].children[2].children;
    const pinControl = controls.find((button) => button.getAttribute("data-act") === "pin");
    ok(pinControl.getAttribute("aria-pressed") === "true", "…including on its pin control's own state");

    const archived = await b.panel.updateConversationPresentation(conversationId, { archived: true });
    ok(archived.ok === true, "archiving works through the same host operation");
    await waitUntil(() => {
      const row = rowNodeOf(a.container, conversationId);
      return !!row && row.children[1].children[0].children[1].children.some((pill) => pill.textContent === "Đã lưu trữ");
    });
    ok(
      rowNodeOf(a.container, conversationId).children[1].children[0].children[1].children.some((pill) => pill.textContent === "Đã lưu trữ"),
      "panel A adopts the archive too"
    );
    ok(rowNodeOf(a.container, conversationId) === rowA, "…still on the same row node it has had all along");
  }

  console.log("== concurrent panels: a stale edit is refused rather than clobbering the newer one (revision guard) ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a", withView: false });
    const b = buildPanel(core, { storage, scope: "tab-b", withView: false });
    await a.panel.init();
    await b.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok" && b.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;
    await a.panel.reconcileHistory();
    await b.panel.reconcileHistory();

    // Panel B goes stale on purpose: a local write it has not flushed makes its
    // cache the newer one for ITSELF, which is exactly when chrome.storage's
    // change notification is skipped (history-store.js's documented rule) — so
    // B keeps editing against the revision it last saw.
    await b.historyStore.upsert({ conversationId, title: "bản nháp cục bộ" });
    const beforeRename = (await b.historyStore.get(conversationId)).revision;

    const renamed = await a.panel.updateConversationPresentation(conversationId, { title: "Bản của A" });
    ok(renamed.ok === true, "panel A's rename succeeds");

    const staleEdit = await b.panel.updateConversationPresentation(conversationId, { title: "Bản của B" });
    ok(staleEdit.ok === false && staleEdit.reason === "revision_conflict", `panel B's edit against the revision it held is refused (${staleEdit.reason})`);
    const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summary.title === "Bản của A", "the host kept the newer title instead of letting the stale panel overwrite it");
    ok(summary.revision > beforeRename, `the revision advanced (${beforeRename} -> ${summary.revision}), which is what the next panel edit will be based on`);

    // The panel that was refused can retry against the fresh revision and win.
    await b.panel.reconcileHistory();
    const retry = await b.panel.updateConversationPresentation(conversationId, { title: "Bản của B" });
    ok(retry.ok === true, "after re-reading the host, the same panel's edit is accepted");
    ok(
      core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId).title === "Bản của B",
      "and it is now the authoritative title"
    );
  }

  console.log("== a rename is never reverted by the panel's derived title (same panel, later turns) ==");
  {
    const storage = sharedStorage();
    const core = buildCore({
      sdk: fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
        { type: "result", subtype: "success", result: "ok" }
      ])
    });
    const a = buildPanel(core, { storage, scope: "tab-a", withView: false });
    await a.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;
    await a.panel.sendMessage("câu hỏi đầu tiên");
    await waitUntil(() => a.panel.currentPhase() === RUN_PHASE.COMPLETED);
    await a.panel.reconcileHistory();

    const rename = await a.panel.updateConversationPresentation(conversationId, { title: "Tên do người dùng đặt" });
    ok(rename.ok === true, "the operator's rename lands on the host");
    await a.panel.sendMessage("câu hỏi thứ hai");
    await waitUntil(() => a.panel.currentPhase() === RUN_PHASE.COMPLETED);
    await new Promise((r) => setTimeout(r, 40));

    const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summary.title === "Tên do người dùng đặt", `a later turn's metadata push does not revert the rename (host title "${summary.title}")`);
    const cached = await a.historyStore.get(conversationId);
    ok(cached.title === "Tên do người dùng đặt", "and the local row keeps it too");
  }

  console.log("== a panel that only RESUMES a conversation never overwrites a title it did not author ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a", withView: false });
    const b = buildPanel(core, { storage, scope: "tab-b", withView: false });
    await a.panel.init();
    await b.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok" && b.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;
    await a.panel.sendMessage("nội dung gốc");
    await waitUntil(() => a.panel.currentPhase() === RUN_PHASE.COMPLETED);
    await a.panel.reconcileHistory();
    await a.panel.updateConversationPresentation(conversationId, { title: "Tên đã đặt" });

    // B resumes the same conversation and runs another turn on it.
    await b.panel.reopenConversation(conversationId);
    await waitUntil(() => b.panel.currentConversationId === conversationId);
    await b.panel.sendMessage("câu hỏi từ bảng điều khiển khác");
    await waitUntil(() => b.panel.currentPhase() === RUN_PHASE.COMPLETED);
    await new Promise((r) => setTimeout(r, 40));
    const summary = core.sessionManager.conversationSummaries().conversations.find((s) => s.conversationId === conversationId);
    ok(summary.title === "Tên đã đặt", `the resuming panel left the title alone (host title "${summary.title}")`);
  }

  console.log("== export: the artifact carries the WHOLE host transcript, not the panel's bounded window ==");
  {
    const storage = sharedStorage();
    // A host that pages 5 events at a time, so a 20-event conversation is
    // genuinely multi-page (the panel's own model window is capped far below
    // that, and the point is that export does not go through it).
    const core = buildCore({ store: new TranscriptStore({ maxSnapshotEvents: 5 }) });
    const a = buildPanel(core, { storage, scope: "tab-a", withView: false });
    await a.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;

    const store = core.sessionManager.store;
    for (let seq = 0; seq < 20; seq += 1) {
      store.appendEvent(conversationId, {
        type: "stream_message",
        runId: "run_export",
        message: { type: "assistant", message: { content: [{ type: "text", text: `mảnh ${seq}. ` }] } }
      });
    }
    await a.historyStore.recordPrompt(conversationId, "run_export", "xuất toàn bộ hội thoại này");
    await a.panel.reconcileHistory();

    const collected = await a.panel.collectTranscript(conversationId, { limit: 5 });
    ok(collected.ok === true && collected.pages > 1, `the transcript was read from the host in ${collected.pages} pages`);
    ok(collected.events.length === 20, `every stored event came back (${collected.events.length})`);
    const seqs = collected.events.map((e) => e.seq).sort((x, y) => x - y);
    ok(seqs[0] === 1 && seqs[seqs.length - 1] === 20, "…across the whole sequence range, oldest page included");

    const exported = await a.panel.exportConversation(conversationId, { format: "md", exportedAt: Date.UTC(2026, 8, 13, 10, 0, 0) });
    ok(exported.ok === true, "the export completed");
    ok(exported.messageCount === 2, `the artifact holds the user turn and the assistant turn (${exported.messageCount})`);
    ok(exported.content.includes("mảnh 0.") && exported.content.includes("mảnh 19."), "…with the oldest AND the newest text in it (the panel's own window holds only the newest)");
    ok(exported.content.includes("xuất toàn bộ hội thoại này"), "…and the operator's own prompt from the local echo cache");
    ok(exported.filename.endsWith(".md") && exported.content.includes("**Mã hội thoại:** " + conversationId), "the artifact is named and self-identifying");

    const asJson = await a.panel.exportConversation(conversationId, { format: "json" });
    const parsed = JSON.parse(asJson.content);
    ok(parsed.conversation.conversationId === conversationId && parsed.messages.length === 2, "the JSON artifact describes the same conversation");

    const unknown = await a.panel.exportConversation("conv_khong_ton_tai", { format: "md" });
    ok(unknown.ok === false && unknown.reason === "unknown_conversation", `exporting a conversation the host does not have fails honestly (${unknown.reason})`);

    const badFormat = await a.panel.exportConversation(conversationId, { format: "pdf" });
    ok(badFormat.ok === false && badFormat.reason === "unknown_format", "an unsupported format is refused before any host traffic");
  }

  console.log("== export/privacy: an older companion that refuses the history protocol is reported, never guessed at ==");
  {
    const listeners = [];
    const oldCompanion = () => ({
      postMessage: (msg) => {
        const type = msg && msg.envelope && msg.envelope.type;
        if (!type || type === "hello") return;
        const reply = makeEnvelope(AGENT_MESSAGE_TYPES.ERROR, { reason: "unknown_message_type", inReplyTo: type });
        setTimeout(() => listeners.forEach((fn) => fn({ type: "agent_msg", envelope: reply })), 0);
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      disconnect: () => {}
    });
    const storage = sharedStorage();
    const protocolClient = new ProtocolClient({ createTransport: oldCompanion });
    const historyStore = new HistoryStore({ storage });
    const panel = new PanelController({
      protocolClient,
      historyStore,
      profileCache: new ProfileCache({ storage }),
      identity: async () => ({}),
      scope: "tab-old",
      requestTimeoutMs: 1000
    });
    await panel.init();
    await waitUntil(() => panel.hostHistorySupport() === false);
    ok(panel.hostHistorySupport() === false, "the panel learned the companion cannot serve history at all");
    await historyStore.upsert({ conversationId: "conv_old", title: "cũ" });
    const exported = await panel.exportConversation("conv_old", { format: "md" });
    ok(exported.ok === false && exported.reason === "host_protocol_unsupported", `export against a companion that cannot serve transcripts fails explicitly (${JSON.stringify(exported).slice(0, 120)})`);
    const pinned = await panel.updateConversationPresentation("conv_old", { pinned: true });
    ok(pinned.ok === false && pinned.reason === "host_protocol_unsupported", "…as does a pin, instead of a local-only pretend success");
  }

  console.log("== privacy: disabling raw-prompt caching in one panel takes effect in the other ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a", withView: false });
    const b = buildPanel(core, { storage, scope: "tab-b", withView: false });
    await a.panel.init();
    await b.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok" && b.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;
    await a.panel.reconcileHistory();
    await b.panel.reconcileHistory();

    await a.historyStore.setRawPromptCachingEnabled(false);
    await b.historyStore.recordPrompt(conversationId, "run_x", "nội dung riêng tư");
    const entry = await b.historyStore.get(conversationId);
    ok((await b.historyStore.promptsFor(conversationId)).size === 0, "the second panel's prompt write is suppressed — the setting is shared, not per panel");
    ok(entry.previewSuppressed === true, "…and the row records that its preview was suppressed rather than looking like a conversation with no prompt");
    ok(b.historyStore.policy().rawPromptCaching === false, "the second panel adopted the privacy policy itself");
  }

  console.log("== concurrent deletes: the host removes it once and both panels end up honest ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a" });
    const b = buildPanel(core, { storage, scope: "tab-b" });
    await a.panel.init();
    await b.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok" && b.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;
    await a.panel.sendMessage("một câu hỏi");
    await waitUntil(() => a.panel.currentPhase() === RUN_PHASE.COMPLETED);
    await a.panel.reconcileHistory();
    await b.panel.reconcileHistory();
    await a.renderView();
    await b.renderView();
    const bRow = rowNodeOf(b.container, conversationId);
    ok(!!bRow, "panel B is showing the conversation");

    const [deletedA, deletedB] = await Promise.all([
      a.panel.deleteConversation(conversationId),
      b.panel.deleteConversation(conversationId)
    ]);
    ok(deletedA.ok === true && deletedB.ok === true, "both panels' deletes report success (the second is an idempotent replay, not a false failure)");
    ok(core.sessionManager.hasConversation(conversationId) === false, "the host no longer has the conversation");
    await waitUntil(() => rowNodeOf(b.container, conversationId) === null);
    ok(rowNodeOf(b.container, conversationId) === null, "panel B's row is gone from the DOM without a reload");
    ok((await a.historyStore.get(conversationId)) === null && (await b.historyStore.get(conversationId)) === null, "neither panel keeps a cache row for a conversation that no longer exists");

    // Reopening it is answered by the host as unknown, and that failure is
    // surfaced on that conversation rather than silently opening a different
    // one (spec browser-assistant-panel's explicit-reopen rule).
    await b.panel.reopenConversation(conversationId).catch(() => {});
    await waitUntil(() => {
      const model = b.panel.models.get(conversationId);
      return !!model && !!model.connectionError;
    });
    const model = b.panel.models.get(conversationId);
    ok(!!model && !!model.connectionError, `reopening the deleted conversation surfaces the host's refusal (${model && model.connectionError && model.connectionError.reason})`);
    ok(model.items.length === 0, "and shows no invented transcript for it");
  }

  console.log("== transcript window: older pages load through the real companion, and the cap is reported honestly ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a", withView: false });
    await a.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const conversationId = a.panel.currentConversationId;

    const store = core.sessionManager.store;
    for (let i = 0; i < 30; i += 1) {
      store.appendEvent(conversationId, {
        type: "stream_message",
        runId: "run_window",
        message: { type: "assistant", message: { content: [{ type: "text", text: `phần ${i}. ` }] } }
      });
    }
    // A deliberately tiny window, so "at capacity" is reachable in a test.
    a.panel.models.set(conversationId, new PanelControllerModel(conversationId, { maxWindowEvents: 10 }));
    await a.panel.reopenConversation(conversationId);
    const model = a.panel.models.get(conversationId);
    await waitUntil(() => model.windowSize() > 0);
    ok(model.windowSize() <= 10, `the reopened transcript is capped (${model.windowSize()} events retained)`);
    ok(model.hasOlderEvents() === true, "the panel knows more history exists below the window");
    const startSeq = model.oldestLoadedSeq();

    const firstPage = await a.panel.loadOlderEvents(conversationId, { limit: 5 });
    ok(firstPage && firstPage.added > 0, `an older page was loaded from the host (added ${firstPage && firstPage.added})`);
    ok(model.oldestLoadedSeq() < startSeq, "the window now reaches further back");
    ok(model.windowSize() <= 10, "…and is still bounded by its cap");

    // Load until the cap reports itself. Nothing may be silently dropped, so
    // the honest outcome at capacity is `limitReached` with nothing added.
    let sawLimit = false;
    for (let i = 0; i < 6 && !sawLimit; i += 1) {
      const applied = await a.panel.loadOlderEvents(conversationId, { limit: 5 });
      if (!applied) break;
      if (applied.limitReached) sawLimit = true;
    }
    ok(sawLimit, "loading past the cap reports limitReached instead of pretending it worked");
    const seqs = model._windowEvents.map((e) => e.seq);
    ok(new Set(seqs).size === seqs.length, "no duplicate event entered the window through any of those pages");
    ok(model.windowSize() <= 10, "…and the cap held throughout");
  }

  console.log("== a still-open panel's own delete does not leave a phantom row in the other ==");
  {
    const storage = sharedStorage();
    const core = buildCore();
    const a = buildPanel(core, { storage, scope: "tab-a" });
    await a.panel.init();
    await waitUntil(() => a.panel.protocol.handshakeState() === "ok");
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null);
    const kept = a.panel.currentConversationId;
    await a.panel.startNewConversation();
    await waitUntil(() => a.panel.currentConversationId != null && a.panel.currentConversationId !== kept);
    const doomed = a.panel.currentConversationId;
    await a.panel.reconcileHistory();
    await a.renderView();
    const keptRow = rowNodeOf(a.container, kept);
    ok(rowNodeOf(a.container, kept) && rowNodeOf(a.container, doomed), "both rows are rendered");
    const doomedRow = rowNodeOf(a.container, doomed);
    const result = await a.panel.deleteConversation(doomed);
    ok(result.ok === true, "the active conversation was deleted");
    await waitUntil(() => rowNodeOf(a.container, doomed) === null);
    ok(rowNodeOf(a.container, doomed) === null, "the deleted row is gone");
    ok(rowNodeOf(a.container, kept) === keptRow, "the surviving row kept its exact DOM node — the delete was incremental");
    ok(doomedRow.parentNode === null, "the removed node was detached, not merely hidden");
  }

  delete globalThis.chrome;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL SIDEPANEL CHAT-HISTORY MULTIPANEL TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

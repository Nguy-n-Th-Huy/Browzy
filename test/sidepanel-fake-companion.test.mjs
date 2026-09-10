#!/usr/bin/env node
// End-to-end panel state-machine test against a REAL host/agent/companion.js
// CompanionCore — the "fake companion harness" this task's environment
// constraint calls for ("speaks the real protocol message shapes... test
// state transitions, dedup-on-reconnect and error rendering for real
// against it. Anything needing a real installed extension is recorded
// BLOCKED"). Only the SDK's `query()` generator and the settings profile
// module are fakes (exactly as host/test/agent-companion-core.test.mjs
// already does for the same, documented reason: no live API key or browser
// is available in this environment) — CompanionCore, SessionManager,
// TranscriptStore, BrowserLease, ApprovalRegistry, TokenBatcher and the
// wire protocol constants are all the REAL modules under host/agent/,
// imported read-only (never modified — this task does not own host/**).
//
// The bridge below reproduces companion.js's OWN
// runAsForkedChild()'s live-forwarding wiring (the TokenBatcher override on
// sessionManager.startRun) so this test exercises the exact same
// stream_event/token_batch shapes a real forked companion process would
// send over IPC — just via direct function calls instead of child-process
// IPC, since no process boundary is needed to prove the panel's client-side
// logic is correct.
//
// Run: node test/sidepanel-fake-companion.test.mjs

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

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-sidepanel-fake-companion-"));
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

function fakeProfileProvider({ shouldFail = false } = {}) {
  return {
    async snapshotForRun(profileId, modelId) {
      if (shouldFail) throw new Error("no credential configured for this profile");
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

function fakeSdk(messages, { delayMsBetween = 0, throwError = null } = {}) {
  return {
    async *query() {
      if (throwError) throw throwError;
      for (const m of messages) {
        if (delayMsBetween) await new Promise((r) => setTimeout(r, delayMsBetween));
        yield m;
      }
    }
  };
}

/** Reproduces companion.js's runAsForkedChild() live-forwarding wiring
 * (see that file's own header comment) against an in-memory `deliver`
 * callback instead of process.send/IPC. */
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
    sdk: sdk || fakeSdk([]),
    profileProvider: profileProvider || fakeProfileProvider()
  });
}

/** An in-memory chrome.runtime.Port-shaped transport wired directly to a
 * CompanionCore instance's handleEnvelope() + live-forwarding, exactly the
 * shape background.js's real "ocic-agent" port relay preserves end to end
 * (background.js does not interpret agent_msg payloads, it only relays). */
function makeBridgeTransport(core) {
  const msgListeners = [];
  const disconnectListeners = [];
  // Deliver on a fresh macrotask, never synchronously within the caller's
  // own call stack: real native messaging is a genuine cross-process async
  // round trip (background.js <-> native host <-> forked companion), so a
  // synchronous in-memory shortcut here would let this harness observe
  // state transitions in an order (e.g. a Stop's ack landing before the
  // caller's own next line runs) that could never happen for real, and
  // would hide the client's own "stopping" optimistic sub-phase entirely.
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
        // A `{ multi: [...] }` reply is not one envelope but an ORDERED
        // SEQUENCE of them (the chunked byte replies — a screenshot artifact,
        // an agent-created document). The real IPC glue sends each part as its
        // own native message (see companion.js's runAsForkedChild), which is
        // what keeps a large payload under Chrome's message ceiling; a harness
        // that handed the panel one object with a `multi` key would model a
        // wire that does not exist and would never exercise reassembly.
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

function buildPanel(core) {
  const protocolClient = new ProtocolClient({ createTransport: () => makeBridgeTransport(core) });
  const panel = new PanelController({
    protocolClient,
    historyStore: new HistoryStore({ storage: memStorage() }),
    profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
    identity: async () => ({ installationId: "test-install", connectionId: "test-conn" })
  });
  return panel;
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

async function main() {
  console.log("== full happy path: empty -> queued/streaming -> completed, real transcript content ==");
  {
    const core = buildCore({
      sdk: fakeSdk([
        { type: "system", subtype: "init" },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "get_page_text", input: {} }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "nội dung trang" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Đây là tóm tắt trang." }] } },
        { type: "result", subtype: "success", result: "Đây là tóm tắt trang." }
      ])
    });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    ok(panel.protocol.handshakeState() === "ok", "hello handshake completes against the real CompanionCore");
    ok(panel.currentPhase() === RUN_PHASE.CONNECTING || panel.currentPhase() === RUN_PHASE.EMPTY, "phase before any conversation is connecting/empty");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    ok(panel.currentConversationId, "NEW produced a real conversationId");
    ok(panel.currentPhase() === RUN_PHASE.EMPTY, "a fresh conversation is empty");

    await panel.sendMessage("đọc trang này và tóm tắt");
    ok(panel.currentModel().items[0].kind === "user", "the user message is shown immediately, before any reply");

    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);
    const model = panel.currentModel();
    ok(model.derivePhase({ connectionStatus: "ok" }) === RUN_PHASE.COMPLETED, "the run reaches completed");
    const turn = model.items.find((i) => i.kind === "assistant_turn");
    ok(turn.complete === true, "the completed turn is marked complete");
    ok(turn.text === "Đây là tóm tắt trang.", "streamed assistant text is captured exactly");
    ok(turn.toolRows.length === 1 && turn.toolRows[0].status === "succeeded", "the tool call round-trip is captured with a succeeded status");
    ok(model.items[0].runId === turn.runId, "the local user-message echo is bound to the real runId from the START reply");
  }

  console.log("== the panel's own \"+\" switches to the new conversation, even with one already open ==");
  {
    // The bug this covers: the snapshot answering NEW was adopted only when
    // `currentConversationId == null`, i.e. only on the very first NEW after
    // the panel opened. Every later press created a conversation on the host
    // and then threw its id away, so the panel sat on the old transcript and
    // the button read as dead.
    const core = buildCore({
      sdk: fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "xong" }] } },
        { type: "result", subtype: "success", result: "xong" }
      ])
    });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const first = panel.currentConversationId;

    // Put real content in it, so "did the panel switch?" is answerable by the
    // transcript and not only by an id comparison.
    await panel.sendMessage("câu hỏi đầu tiên");
    await waitUntil(() => panel.currentPhase() === RUN_PHASE.COMPLETED);
    ok(panel.currentModel().items.length > 0, "the first conversation has content before the second is started");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId !== first);
    const second = panel.currentConversationId;
    ok(second && second !== first, "pressing new with a conversation already open switches to a different conversationId");
    ok(panel.currentPhase() === RUN_PHASE.EMPTY, "the panel now shows the NEW conversation, which is empty");
    ok(panel.currentModel().items.length === 0, "the previous conversation's transcript is no longer what the panel displays");
    ok(panel.models.get(first), "the earlier conversation is kept in memory, not destroyed, so history can reopen it");

    // A resume must NOT be hijacked by a stale claim: reopenConversation sets
    // the id itself and never sets the flag.
    await panel.reopenConversation(first);
    await waitUntil(() => panel.currentConversationId === first);
    ok(panel.currentConversationId === first, "reopening an earlier conversation still lands on that exact conversation");
  }

  console.log("== a NEW that never reaches the wire leaves no claim behind ==");
  {
    // If the port is gone, ProtocolClient throws and the request never left.
    // A claim left set would hijack the next unrelated snapshot.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const opened = panel.currentConversationId;

    const realNewConversation = panel.protocol.newConversation.bind(panel.protocol);
    panel.protocol.newConversation = () => {
      throw new Error("ProtocolClient: not connected");
    };
    let threw = false;
    try {
      await panel.startNewConversation();
    } catch {
      threw = true;
    }
    ok(threw, "a NEW that cannot be sent still surfaces the failure to the caller");
    ok(panel._awaitingNewConversation === false, "a NEW that never left the panel leaves no outstanding claim");
    panel.protocol.newConversation = realNewConversation;

    // Prove it by the observable consequence, not only the flag: a resume of
    // the conversation already open must not be mistaken for the failed NEW.
    await panel.reopenConversation(opened);
    await waitUntil(() => panel.currentConversationId === opened);
    ok(panel.currentConversationId === opened, "the next snapshot after a failed NEW is not hijacked");
  }

  console.log("== stop mid-stream: partial response is preserved but NEVER marked complete ==");
  {
    const core = buildCore({
      // First chunk arrives quickly (so the test can wait for real partial
      // content before stopping); the second is delayed long enough that a
      // prompt Stop is guaranteed to land first — proving the abort
      // genuinely prevents it from ever being applied, not just that it
      // arrives too late to matter.
      sdk: {
        async *query() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "Đang viết câu trả lời dài..." }] } };
          await new Promise((r) => setTimeout(r, 300));
          yield { type: "assistant", message: { content: [{ type: "text", text: " phần này sẽ không bao giờ tới nơi" }] } };
        }
      }
    });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    await panel.sendMessage("viết một đoạn dài");

    await waitUntil(() => panel.currentPhase() === RUN_PHASE.STREAMING);
    ok(panel.currentPhase() === RUN_PHASE.STREAMING, "run is streaming before Stop");
    // Wait for the first (fast) chunk to actually land before stopping, so
    // "the partial text is preserved" is a meaningful assertion rather than
    // stopping before anything ever arrived.
    await waitUntil(() => {
      const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
      return !!turn && turn.text.length > 0;
    });

    panel.stop("user_stop");
    ok(panel.currentPhase() === RUN_PHASE.STOPPING, "stop() immediately reflects the stopping sub-phase, before the ack arrives");

    await waitUntil(() => panel.currentPhase() === RUN_PHASE.STOPPED);
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.complete === false, "a stopped run is never marked complete");
    ok(turn.text.includes("Đang viết câu trả lời"), "the partial text that DID arrive is preserved, not discarded");
    ok(!turn.text.includes("phần này sẽ không bao giờ tới nơi"), "text queued after the stop never appears (the abort actually took effect)");
  }

  console.log("== run_error (e.g. an unavailable profile) reports the error phase honestly ==");
  {
    const core = buildCore({ profileProvider: fakeProfileProvider({ shouldFail: true }) });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    await panel.sendMessage("chào");

    await waitUntil(() => panel.currentPhase() === RUN_PHASE.ERROR);
    const turn = panel.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.lifecycle === "error" && turn.complete === false, "a profile failure surfaces as a real error, not a silent hang or a false completion");
    ok(turn.errorInfo && turn.errorInfo.reason === "profile_unavailable", "the specific reason is preserved for the UI to show");
  }

  console.log("== reconnect resync: RESUME rebuild produces no duplicate transcript or activity entries ==");
  {
    const core1 = buildCore({
      sdk: fakeSdk([
        { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_a", name: "navigate", input: { url: "https://a.example" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_a", content: "ok" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Đã mở trang A." }] } }
      ])
    });
    const panel1 = buildPanel(core1);
    await panel1.init();
    await waitUntil(() => panel1.protocol.handshakeState() === "ok");
    await panel1.startNewConversation();
    await waitUntil(() => panel1.currentConversationId != null);
    const conversationId = panel1.currentConversationId;
    await panel1.sendMessage("mở trang A giúp mình");
    await waitUntil(() => panel1.currentPhase() === RUN_PHASE.COMPLETED);

    const beforeItems = JSON.parse(JSON.stringify(panel1.currentModel().items));
    const beforeToolCount = beforeItems.find((i) => i.kind === "assistant_turn").toolRows.length;

    // A second panel instance (simulating a reopened/reconnected sidepanel,
    // sharing the SAME on-disk conversation store — a real companion
    // restart or a panel reopen both look like this from the wire's
    // perspective) resumes the exact same conversation.
    const core2 = buildCore(); // fresh CompanionCore, same OCIC_AGENT_HOME -> same on-disk transcript
    const sharedHistory = new HistoryStore({ storage: memStorage() });
    await sharedHistory.upsert({ conversationId });
    // The prompt text itself is this browser profile's own local echo cache
    // (see conversation-model.js's design note 4) — simulate it having
    // survived across the "reconnect" the same way chrome.storage.local
    // would.
    await sharedHistory.recordPrompt(conversationId, panel1.currentModel().items[0].runId, "mở trang A giúp mình");

    const protocolClient2 = new ProtocolClient({ createTransport: () => makeBridgeTransport(core2) });
    const panel2 = new PanelController({
      protocolClient: protocolClient2,
      historyStore: sharedHistory,
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-2" })
    });
    await panel2.init();
    await waitUntil(() => panel2.protocol.handshakeState() === "ok");
    await panel2.reopenConversation(conversationId);
    await waitUntil(() => !!panel2.currentModel() && panel2.currentModel().items.length > 0);

    const afterItems = panel2.currentModel().items;
    ok(afterItems.length === beforeItems.length, `resume produced the same item count (${afterItems.length} vs ${beforeItems.length}), no duplicates`);
    const afterTurn = afterItems.find((i) => i.kind === "assistant_turn");
    ok(afterTurn.toolRows.length === beforeToolCount, "resume produced the same tool-row count, no duplicated activity");
    ok(afterTurn.text === "Đã mở trang A.", "resumed text is exact, not doubled");
    ok(afterItems[0].kind === "user" && afterItems[0].text === "mở trang A giúp mình", "the original user message is recovered via the local prompt cache");

    // Resuming a SECOND time (another reconnect) must still not duplicate.
    await panel2.reopenConversation(conversationId);
    await waitUntil(() => panel2.currentModel().items.length > 0);
    ok(panel2.currentModel().items.length === beforeItems.length, "a second resume is still idempotent");
  }

  console.log("== interrupted: a companion restart with an unresolved active run is discovered on resume, never silently resumed ==");
  {
    // First "process": start a run and never let it finish (simulating a
    // companion crash — finishRun()/markDone() never ran).
    const core1 = buildCore({
      sdk: {
        async *query() {
          yield { type: "assistant", message: { content: [{ type: "text", text: "đang xử lý" }] } };
          await new Promise(() => {}); // never resolves — the "process" dies here
        }
      }
    });
    const panel1 = buildPanel(core1);
    await panel1.init();
    await waitUntil(() => panel1.protocol.handshakeState() === "ok");
    await panel1.startNewConversation();
    await waitUntil(() => panel1.currentConversationId != null);
    const conversationId = panel1.currentConversationId;
    await panel1.sendMessage("việc gì đó lâu dài");
    await waitUntil(() => panel1.currentPhase() === RUN_PHASE.STREAMING);

    // A fresh CompanionCore (the "restarted process") shares the same
    // on-disk store; its very first hello triggers recoverAfterRestart().
    const core2 = buildCore();
    const panel2 = buildPanel(core2);
    await panel2.init();
    await waitUntil(() => panel2.protocol.handshakeState() === "ok");
    await panel2.reopenConversation(conversationId);
    await waitUntil(() => panel2.currentPhase() === RUN_PHASE.INTERRUPTED);

    ok(panel2.currentPhase() === RUN_PHASE.INTERRUPTED, "the resumed conversation reports interrupted, not completed or streaming");
    const turn = panel2.currentModel().items.find((i) => i.kind === "assistant_turn");
    ok(turn.complete === false, "an interrupted run's partial content is never marked complete");
    ok(turn.text === "đang xử lý", "the partial text from before the restart is preserved");
  }

  console.log("== an agent-created document's bytes cross the whole panel<->companion path ==");
  {
    // This is the seam nothing else covers: DocumentsClient's own tests feed it
    // envelopes by hand, and the host's wire test stops at the native message.
    // Here the request leaves the real ProtocolClient, the real CompanionCore
    // answers with its chunked `{ multi: [...] }` reply, and the real
    // PanelController reassembles it — the assembled path, minus only the DOM.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const conversationId = panel.currentConversationId;

    const { DocumentStore } = await import("../host/agent/documents/store.js");
    // Comfortably over one chunk (700_000 bytes), so the reply really is a
    // sequence rather than a single envelope that would prove nothing.
    const body = `# Báo cáo\n\n${"nội dung dài ".repeat(70_000)}`;
    const record = await new DocumentStore().write({ conversationId, title: "Báo cáo dài", format: "md", content: body });

    const result = await panel.fetchDocument(record.documentId, conversationId);
    ok(result.found === true, `the document fetch resolves found (${result.reason || ""})`);
    ok(result.bytes.length === record.byteLength, "the reassembled length matches what the host stored");
    ok(new TextDecoder().decode(result.bytes).startsWith("# Báo cáo"), "the reassembled bytes are the document");
    ok(result.meta.fileName === record.fileName, "the card's filename came back with the bytes");

    const missing = await panel.fetchDocument("never-created", conversationId);
    ok(missing.found === false && missing.reason === "not_found", `an unknown document reports not_found (${missing.reason})`);
  }

  console.log("== restoreOrStartConversation() resumes the remembered conversation on a fresh controller ==");
  {
    // Controller A creates/adopts conversation X and puts real content in it,
    // then unmounts (nothing here deletes it — mirrors closing the side
    // panel). A second controller sharing the SAME HistoryStore storage
    // (chrome.storage.local survives a panel unmount, which is exactly what
    // makes this restorable) calls restoreOrStartConversation() and must land
    // on X via a real RESUME, not a NEW.
    const core = buildCore({
      sdk: fakeSdk([
        { type: "assistant", message: { content: [{ type: "text", text: "xong việc A" }] } },
        { type: "result", subtype: "success", result: "xong việc A" }
      ])
    });
    const sharedStorage = memStorage();
    const panelA = new PanelController({
      protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
      historyStore: new HistoryStore({ storage: sharedStorage }),
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-a" })
    });
    await panelA.init();
    await waitUntil(() => panelA.protocol.handshakeState() === "ok");
    await panelA.startNewConversation();
    await waitUntil(() => panelA.currentConversationId != null);
    const conversationId = panelA.currentConversationId;
    await panelA.sendMessage("việc A");
    await waitUntil(() => panelA.currentPhase() === RUN_PHASE.COMPLETED);

    // Prove the wire call is really RESUME, not NEW: count NEW envelopes the
    // fresh controller's ProtocolClient sends before/after the restore call.
    let newCalls = 0;
    let resumeCalls = 0;
    const protocolClientB = new ProtocolClient({ createTransport: () => makeBridgeTransport(core) });
    const realNewConversation = protocolClientB.newConversation.bind(protocolClientB);
    const realResumeConversation = protocolClientB.resumeConversation.bind(protocolClientB);
    protocolClientB.newConversation = (...args) => {
      newCalls++;
      return realNewConversation(...args);
    };
    protocolClientB.resumeConversation = (...args) => {
      resumeCalls++;
      return realResumeConversation(...args);
    };
    const panelB = new PanelController({
      protocolClient: protocolClientB,
      historyStore: new HistoryStore({ storage: sharedStorage }), // same underlying storage as panelA
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-b" })
    });
    await panelB.init();
    await waitUntil(() => panelB.protocol.handshakeState() === "ok");

    await panelB.restoreOrStartConversation();
    await waitUntil(() => panelB.currentConversationId === conversationId);

    ok(panelB.currentConversationId === conversationId, "restoreOrStartConversation() lands on the remembered conversation");
    ok(resumeCalls === 1, "the wire carried exactly one resume for the remembered conversation");
    ok(newCalls === 0, "restoreOrStartConversation() never sends a new for a restorable conversation");
    await waitUntil(() => panelB.currentModel() && panelB.currentModel().items.length > 0);
    ok(panelB.currentModel().items.some((i) => i.kind === "assistant_turn" && i.text === "xong việc A"), "the restored transcript content is the real one from before the unmount");
  }

  console.log("== restoreOrStartConversation() starts new when the remembered conversation was deleted locally ==");
  {
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const sharedStorage = memStorage();
    const panelA = new PanelController({
      protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
      historyStore: new HistoryStore({ storage: sharedStorage }),
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-a2" })
    });
    await panelA.init();
    await waitUntil(() => panelA.protocol.handshakeState() === "ok");
    await panelA.startNewConversation();
    await waitUntil(() => panelA.currentConversationId != null);
    const conversationId = panelA.currentConversationId;
    await panelA.deleteConversationLocally(conversationId);

    let resumeCalls = 0;
    const protocolClientB = new ProtocolClient({ createTransport: () => makeBridgeTransport(core) });
    const realResumeConversation = protocolClientB.resumeConversation.bind(protocolClientB);
    protocolClientB.resumeConversation = (...args) => {
      resumeCalls++;
      return realResumeConversation(...args);
    };
    const panelB = new PanelController({
      protocolClient: protocolClientB,
      historyStore: new HistoryStore({ storage: sharedStorage }),
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-b2" })
    });
    await panelB.init();
    await waitUntil(() => panelB.protocol.handshakeState() === "ok");
    await panelB.restoreOrStartConversation();
    await waitUntil(() => panelB.currentConversationId != null);

    ok(panelB.currentConversationId !== conversationId, "a fresh controller never restores a conversation deleted locally");
    ok(resumeCalls === 0, "the deleted conversation is never sent as a resume at all");
  }

  console.log("== restoreOrStartConversation() falls back to a usable new conversation when the companion reports unknown_conversation ==");
  {
    // Seed the remembered id with a conversation the companion has never
    // heard of (no matching on-disk transcript meta), so
    // SessionManager#resumeConversation() throws and companion.js's real
    // _handleResume() answers with the real `unknown_conversation` error
    // envelope shape -- no conversationId, exactly as host/agent/companion.js
    // actually sends it. Driven through the real CompanionCore rather than a
    // hand-written stub so this proves the real envelope shape triggers the
    // fallback.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const staleConversationId = "conv_never_existed_on_this_companion";
    const sharedStorage = memStorage();
    const history = new HistoryStore({ storage: sharedStorage });
    // Seed the local index (so `list()` reports it as present, not filtered
    // out for absence) AND the remembered last-active id, matching what a
    // real "the companion's data was wiped but this browser profile's local
    // index survived" scenario looks like.
    await history.upsert({ conversationId: staleConversationId, title: "cuộc trò chuyện cũ" });
    await history.setLastActive(staleConversationId);

    const panel = new PanelController({
      protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
      historyStore: history,
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-stale" })
    });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.restoreOrStartConversation();
    await waitUntil(() => panel.currentConversationId != null && panel.currentConversationId !== staleConversationId);

    ok(panel.currentConversationId && panel.currentConversationId !== staleConversationId, "the panel ends up on a new, different conversation after the unknown_conversation reply");
    ok(panel.currentPhase() === RUN_PHASE.EMPTY, "the fallback conversation is a normal, usable empty conversation");
    ok(panel._pendingResumes.length === 0, "the pending-resume entry is cleared once the fallback completes");
    ok((await history.getLastActive()) !== staleConversationId, "the stale remembered id is forgotten, not retried on the next open");
  }

  console.log("== explicit reopen of an unknown conversation surfaces the failure on that conversation, not a silent switch ==");
  {
    // CRITICAL: the pre-fix `_onEnvelope` error case only ever acted on a
    // startup-restore flag. `reopenConversation()` never set that flag, so
    // an operator who clicked an unknown conversation in the history list
    // saw NOTHING: no error, no switch, just an empty conversation. Driven
    // through the real CompanionCore so the envelope shape (`unknown_conversation`,
    // no conversationId) is the real one.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const panel = buildPanel(core);
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    await panel.startNewConversation();
    await waitUntil(() => panel.currentConversationId != null);
    const opened = panel.currentConversationId;

    let newCalls = 0;
    const realNewConversation = panel.protocol.newConversation.bind(panel.protocol);
    panel.protocol.newConversation = (...args) => {
      newCalls++;
      return realNewConversation(...args);
    };

    const unknownId = "conv_explicit_reopen_unknown";
    await panel.reopenConversation(unknownId);
    ok(panel.currentConversationId === unknownId, "reopenConversation() sets the id itself, even before any reply arrives");

    await waitUntil(() => panel.models.get(unknownId) && panel.models.get(unknownId).connectionError != null);

    ok(panel.currentConversationId === unknownId, "the panel is still on the conversation the operator asked for, not silently swapped");
    ok(
      panel.models.get(unknownId).connectionError && panel.models.get(unknownId).connectionError.reason === "unknown_conversation",
      "the unknown_conversation failure is surfaced on that conversation's own model"
    );
    // Give any (incorrect) fallback a moment to fire before asserting none did.
    await new Promise((r) => setTimeout(r, 30));
    ok(newCalls === 0, "no `new` was ever sent for an explicit reopen's failure");
    ok(panel.currentConversationId === unknownId, "still on the requested conversation after settling");
    panel.protocol.newConversation = realNewConversation;
  }

  console.log("== concurrent boot-restore + explicit reopen, both unknown: no hijack, each failure attributed correctly ==");
  {
    // Two independent RESUMEs in flight at once, both destined to fail with
    // the SAME conversationId-less unknown_conversation envelope. The old
    // single-flag design could only ever correlate one of them; whichever
    // error landed first fired the fallback unconditionally and the second
    // was dropped. `_pendingResumes` must attribute each correctly and must
    // never hijack the operator onto a conversation neither one asked for.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const staleBootId = "conv_boot_restore_unknown";
    const staleReopenId = "conv_explicit_reopen_unknown_2";
    const sharedStorage = memStorage();
    const history = new HistoryStore({ storage: sharedStorage });
    await history.upsert({ conversationId: staleBootId, title: "cuộc trò chuyện cũ" });
    await history.setLastActive(staleBootId);

    const panel = new PanelController({
      protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
      historyStore: history,
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-race-1" })
    });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");

    let newCalls = 0;
    const realNewConversation = panel.protocol.newConversation.bind(panel.protocol);
    panel.protocol.newConversation = (...args) => {
      newCalls++;
      return realNewConversation(...args);
    };

    // Fire both RESUMEs concurrently, mirroring boot()'s restore racing the
    // history list's independently-wired "open" handler. Deliberately NOT
    // awaited individually before the other starts, so both are genuinely
    // in flight at once (restoreOrStartConversation() needs three awaits
    // before its own RESUME goes out; reopenConversation() needs only one —
    // see `_explicitReopenSinceBoot`'s field comment for why that asymmetry
    // matters here).
    const restorePromise = panel.restoreOrStartConversation();
    const reopenPromise = panel.reopenConversation(staleReopenId);
    await Promise.all([restorePromise, reopenPromise]);

    // Both fail; let both error replies land and any (correct or incorrect)
    // fallback settle.
    await waitUntil(() => panel.models.get(staleBootId)?.connectionError != null && panel.models.get(staleReopenId)?.connectionError != null);
    await new Promise((r) => setTimeout(r, 30));

    ok(newCalls === 0, "the boot restore's fallback never fires once an explicit reopen has happened, so no third/unrequested conversation is ever created");
    // Deterministic, not merely "one of the two": reopenConversation() never
    // lets a startup restore's send overwrite `currentConversationId` once
    // an explicit reopen has already claimed it (see that method's own
    // comment) — so the operator's own click always wins the display,
    // regardless of which RESUME's reply happens to land first.
    ok(
      panel.currentConversationId === staleReopenId,
      "the operator's own explicit reopen keeps the display, even though the startup restore's RESUME reaches the wire later"
    );
    panel.protocol.newConversation = realNewConversation;
    ok(
      panel.models.get(staleBootId).connectionError.reason === "unknown_conversation",
      "the boot restore's own failure is attributed to the boot restore's conversation"
    );
    ok(
      panel.models.get(staleReopenId).connectionError.reason === "unknown_conversation",
      "the explicit reopen's own failure is attributed to the explicit reopen's conversation"
    );
    ok(panel._pendingResumes.length === 0, "both pending resumes are resolved, none left dangling");
  }

  console.log("== concurrent boot-restore (unknown) + explicit reopen (valid): operator stays on the valid conversation, no phantom history row ==");
  {
    // The other proven ordering: the startup restore fails, but the
    // operator's own explicit reopen of a REAL conversation succeeds. The
    // pre-fix fallback fired unconditionally and could create a brand-new
    // conversation that was never displayed but still persisted into
    // HistoryStore as a phantom row, while nulling the remembered id even
    // though the valid conversation is what's actually showing.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });
    const staleBootId = "conv_boot_restore_unknown_3";
    const sharedStorage = memStorage();
    const history = new HistoryStore({ storage: sharedStorage });
    await history.upsert({ conversationId: staleBootId, title: "cuộc trò chuyện cũ" });
    await history.setLastActive(staleBootId);

    // Seed a REAL, valid conversation on the companion for the explicit
    // reopen to resume successfully.
    const seedPanel = new PanelController({
      protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
      historyStore: new HistoryStore({ storage: memStorage() }),
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-seed" })
    });
    await seedPanel.init();
    await waitUntil(() => seedPanel.protocol.handshakeState() === "ok");
    await seedPanel.startNewConversation();
    await waitUntil(() => seedPanel.currentConversationId != null);
    const validId = seedPanel.currentConversationId;
    // Also index the valid conversation into the SAME storage this test's
    // panel reads history from, so it is a real, known-to-the-panel entry
    // (mirroring how it would already be in the operator's history list).
    await history.upsert({ conversationId: validId, title: "cuộc trò chuyện hợp lệ" });

    let newCalls = 0;
    const panel = new PanelController({
      protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
      historyStore: history,
      profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
      identity: async () => ({ installationId: "test-install", connectionId: "test-conn-race-2" })
    });
    await panel.init();
    await waitUntil(() => panel.protocol.handshakeState() === "ok");
    const realNewConversation = panel.protocol.newConversation.bind(panel.protocol);
    panel.protocol.newConversation = (...args) => {
      newCalls++;
      return realNewConversation(...args);
    };

    const restorePromise = panel.restoreOrStartConversation();
    const reopenPromise = panel.reopenConversation(validId);
    await Promise.all([restorePromise, reopenPromise]);

    await waitUntil(() => panel.currentModel() && panel.currentModel().items != null);
    await waitUntil(() => panel.models.get(staleBootId)?.connectionError != null);
    // Give an incorrect fallback a moment to fire before asserting none did.
    await new Promise((r) => setTimeout(r, 30));

    ok(panel.currentConversationId === validId, "the operator stays on the conversation they explicitly (and validly) reopened");
    ok(newCalls === 0, "the boot restore's failure never triggers a fallback once the operator has moved to a different, still-current conversation");
    const listAfter = await history.list();
    ok(
      !listAfter.some((c) => c.conversationId !== staleBootId && c.conversationId !== validId),
      "no phantom conversation row was created in HistoryStore"
    );
    ok((await history.getLastActive()) === validId, "the remembered last-active id reflects what is actually showing, not the failed boot restore");
    panel.protocol.newConversation = realNewConversation;
  }

  console.log("== restoreOrStartConversation() never rejects when the port is dead, even for the two unguarded startNewConversation() call sites ==");
  {
    // WARNING: the pre-fix version only wrapped the resume attempt in
    // try/catch. Both the `!restorable` branch and the catch block's own
    // startNewConversation() call could still reject on a dead port, and
    // boot() awaits this method with no catch of its own.
    const core = buildCore({ sdk: fakeSdk([{ type: "result", subtype: "success", result: "" }]) });

    // Case 1: the `!restorable` path (nothing remembered — the common
    // "first ever open").
    {
      const panel = buildPanel(core);
      await panel.init();
      await waitUntil(() => panel.protocol.handshakeState() === "ok");
      panel.protocol.newConversation = () => {
        throw new Error("ProtocolClient: not connected");
      };
      let threw = false;
      try {
        await panel.restoreOrStartConversation();
      } catch {
        threw = true;
      }
      ok(!threw, "restoreOrStartConversation() does not reject on the !restorable path even when the port is dead");
      ok(panel.currentConversationId == null, "no conversation ends up active when the port never accepted the new conversation");
    }

    // Case 2: the resume attempt fails AND the fallback new-conversation
    // attempt also fails (same dead port for both).
    {
      const staleId = "conv_dead_port_restore";
      const sharedStorage = memStorage();
      const history = new HistoryStore({ storage: sharedStorage });
      await history.upsert({ conversationId: staleId, title: "cuộc trò chuyện cũ" });
      await history.setLastActive(staleId);
      const panel = new PanelController({
        protocolClient: new ProtocolClient({ createTransport: () => makeBridgeTransport(core) }),
        historyStore: history,
        profileCache: new ProfileCache({ storage: memStorage({ ocic_profile_cache_v1: completeProfile() }) }),
        identity: async () => ({ installationId: "test-install", connectionId: "test-conn-dead-port" })
      });
      await panel.init();
      await waitUntil(() => panel.protocol.handshakeState() === "ok");
      panel.protocol.resumeConversation = () => {
        throw new Error("ProtocolClient: not connected");
      };
      panel.protocol.newConversation = () => {
        throw new Error("ProtocolClient: not connected");
      };
      let threw = false;
      try {
        await panel.restoreOrStartConversation();
      } catch {
        threw = true;
      }
      ok(!threw, "restoreOrStartConversation() does not reject even when BOTH the resume and the fallback new-conversation attempts fail");
      // `currentConversationId` is left pointing at the stale remembered id
      // here, not cleared to null: `reopenConversation()` optimistically
      // assigns it before attempting the send (by design, for a normal
      // explicit reopen's UI responsiveness — see that method's own
      // comment), and a dead port means that assignment happens but the
      // send that would have confirmed or replaced it never completes
      // either way. Because an id is active, `currentModel()` returns the
      // (empty, unseeded-beyond-local-prompts) model `reopenConversation()`
      // created for it rather than null, so `currentPhase()` does NOT fall
      // into panel-controller.js's "no model" CONNECTING/ERROR branch — the
      // handshake in this test is still "ok", there is no turn, and the
      // model has no items, so `ConversationModel.derivePhase()` resolves
      // to EMPTY. The requirement this test exists to prove is narrower and
      // already covered above: the method itself must not reject and abort
      // `render()`. This assertion proves `currentPhase()` actually reaches
      // that real EMPTY state from here rather than merely not throwing.
      ok(panel.currentPhase() === RUN_PHASE.EMPTY, "currentPhase() resolves to EMPTY from the unconfirmed-active-id, dead-port state");
    }
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL FAKE-COMPANION TESTS PASSED" : `\n${fail} FAILED`);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

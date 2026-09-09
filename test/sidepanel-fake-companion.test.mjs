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

  console.log(fail === 0 ? "\nALL SIDEPANEL FAKE-COMPANION TESTS PASSED" : `\n${fail} FAILED`);
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

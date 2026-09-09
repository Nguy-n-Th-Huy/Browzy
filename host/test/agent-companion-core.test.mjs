#!/usr/bin/env node
//
// CompanionCore: the full versioned-envelope protocol handling (hello,
// new/resume/start/stop, approvals, snapshots) against fakes for the SDK,
// the settings profile module (host/agent/settings/profile.js — owned by the
// parallel task-group-4 session and not present in this working tree yet;
// see host/agent/tools/query-options.js's file header for why a local test
// double is the documented way to exercise this path today), and the
// tool-runtime bridge. No live API key or browser is used anywhere here.
//
// Run: node host/test/agent-companion-core.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../agent/protocol.js";
import { conversationDir } from "../agent/storage/paths.js";

// Isolate every test run's storage under a scratch directory.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-companion-core-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// A local double matching host/agent/settings/profile.js's DOCUMENTED
// contract exactly (see the delegation's "Interface contract with the
// parallel settings agent"): snapshotForRun(profileId, modelId) -> { model,
// env, revision, profileId }, or throws.
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

function fakeSdk({ messages = [], throwError = null } = {}) {
  return {
    async *query({ prompt, options }) {
      if (throwError) throw throwError;
      for (const m of messages) yield m;
    }
  };
}

function buildCore({ sdk, profileProvider, callTool } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: callTool || (async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] })),
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || fakeSdk(),
    profileProvider: profileProvider || fakeProfileProvider()
  });
}

console.log("\nCompanionCore\n");

await test("an unsupported hello version is rejected before any session state exists", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope({ v: 999, type: AGENT_MESSAGE_TYPES.HELLO });
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "must fail closed");
  assert(reply.reason === "unsupported_version");
});

await test("every message before a successful hello is rejected (fail closed, not just hello)", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "pre-handshake messages must be rejected");
  assert(reply.reason === "hello_required");
});

await test("a supported hello is accepted and acked with the current version", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  assert(reply.type === AGENT_MESSAGE_TYPES.HELLO_ACK);
  assert(reply.v === PROTOCOL_VERSION);
});

await test("hello's installationId/connectionId become the lease's browser identity (never a model-provided name)", async () => {
  const core = buildCore();
  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, { installationId: "install-123", connectionId: "conn-abc" })
  );
  assert(core.lease.browserIdentity.installationId === "install-123", "lease identity must come from the hello envelope");
  assert(core.lease.browserIdentity.connectionId === "conn-abc");
});

await test("a hello with a NEW installationId (browser switch) drops any queued waiter on the old identity", async () => {
  const core = buildCore({
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, { installationId: "install-A" }));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a" }));
  assert(core.sessionManager.activeRun(conversationId).leaseHeldByThisRun(), "first run should hold the lease");

  // A second browser (different installationId) connects — this must not
  // silently inherit the first browser's lease/context.
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, { installationId: "install-B" }));
  assert(core.lease.browserIdentity.installationId === "install-B", "identity must update to the new browser");
  assert(!core.lease.isHeld(), "switching browsers must release whatever the previous browser held");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("an unknown message type after hello gets a structured error, not a crash", async () => {
  const core = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope({ v: PROTOCOL_VERSION, type: "totally_made_up" });
  assert(reply.type === AGENT_MESSAGE_TYPES.ERROR);
  assert(reply.reason === "unknown_message_type");
});

await test("new -> start -> stop: full happy-path lifecycle with a fake SDK", async () => {
  const core = buildCore({ sdk: fakeSdk({ messages: [{ type: "assistant", text: "hi" }] }) });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const newReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  assert(newReply.type === AGENT_MESSAGE_TYPES.SNAPSHOT);
  const conversationId = newReply.conversationId;
  assert(conversationId, "new conversation should return an id");

  const startReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "hello" })
  );
  assert(startReply.type === AGENT_MESSAGE_TYPES.START && startReply.accepted, "start should be accepted");
  assert(startReply.runId, "start should return a runId");

  // Let the fire-and-forget query loop settle.
  await new Promise((r) => setTimeout(r, 50));

  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  assert(snap.type === AGENT_MESSAGE_TYPES.SNAPSHOT);
  assert(snap.events.some((e) => e.type === "run_created"), "transcript should record run_created");
  assert(snap.events.some((e) => e.type === "run_done"), "transcript should record run completion");
});

await test("a second start on the same conversation while one is active is rejected (one active run per conversation)", async () => {
  const core = buildCore({
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 200)); // stay "running" long enough to overlap
        yield { type: "assistant", text: "slow" };
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const first = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a" }));
  assert(first.accepted, "first start should be accepted");
  const second = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "b" }));
  assert(second.type === AGENT_MESSAGE_TYPES.ERROR && second.reason === "run_start_rejected", "a second concurrent start on the same conversation must be rejected");
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("stop reports success and subsequent stop is a harmless no-op report", async () => {
  const core = buildCore({
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 200));
        yield { type: "assistant", text: "slow" };
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a" }));
  const stopReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
  assert(stopReply.stopped === true, "stop should report it actually stopped something");
  const stopAgain = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
  assert(stopAgain.stopped === false, "stopping an already-finished run should not claim success again");
});

await test("an unavailable profile (group-4 module not configured/reachable) surfaces a typed, specific error", async () => {
  // start() now replies immediately (so a queued run's acceptance is never
  // stuck behind an unrelated lease wait — see _handleStart) and reports
  // profile resolution failures asynchronously as a run_error transcript
  // event instead, since resolving the profile can only happen after the
  // lease is actually granted.
  const core = buildCore({ profileProvider: fakeProfileProvider({ shouldFail: true }) });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "hi" }));
  assert(reply.type === AGENT_MESSAGE_TYPES.START && reply.accepted, "start must be accepted immediately regardless of profile resolution");

  await new Promise((r) => setTimeout(r, 50));
  const snap = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.SNAPSHOT_REQUEST, { conversationId, afterSeq: 0 }));
  const errorEvent = snap.events.find((e) => e.type === "run_error");
  assert(errorEvent, "a profile failure must surface as a structured run_error event, never a crash or silent fake success");
  assert(errorEvent.reason === "profile_unavailable", `expected profile_unavailable, got ${errorEvent.reason}`);
  assert(snap.events.some((e) => e.type === "run_stopped"), "the run must be stopped, not left dangling");
});

await test("a run queued behind another conversation's lease is accepted immediately (queued:true), not held until granted", async () => {
  const core = buildCore({
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const first = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const second = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  const startFirst = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: first.conversationId, prompt: "a" })
  );
  assert(startFirst.accepted && startFirst.queued === false, "the first, uncontested run should not report queued");

  const startedAt = Date.now();
  const startSecond = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: second.conversationId, prompt: "b" })
  );
  const replyLatencyMs = Date.now() - startedAt;
  assert(startSecond.accepted && startSecond.queued === true, "a second conversation contending for the lease must be accepted as queued");
  assert(replyLatencyMs < 100, `the start reply must return immediately, not block for the ~250ms lease wait (took ${replyLatencyMs}ms)`);
  assert(!core.sessionManager.activeRun(second.conversationId).leaseHeldByThisRun(), "the queued run must not hold the lease yet");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId: first.conversationId }));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId: second.conversationId }));
});

await test("approval decision acknowledges a pending requestId (canUseTool flow), an unknown requestId is rejected, denial resolves pending too", async () => {
  // Task 9.2 (design.md section 8): the new flow inverts the old one — the
  // companion mints a token inside `canUseTool` and emits an
  // `approval_request` event carrying a `requestId`; the panel's reply with
  // the matching `requestId` resolves the canUseTool promise. The panel no
  // longer mints the token here. This test exercises the wire-side
  // acknowledgement: a reply with a pending requestId is acknowledged; an
  // unknown/missing requestId is rejected (not silently applied); and a
  // denial resolves without issuing a token (no token appears in the ack —
  // the token lives inside canUseTool, never on the wire).
  const core = buildCore({
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a" }));

  // Inject a synthetic pending approval to simulate canUseTool having
  // suspended a call awaiting this requestId.
  let resolverCalled = false;
  let lastDecision = null;
  const requestId = "rq_test_1";
  core._pendingApprovals.set(requestId, (decision) => { resolverCalled = true; lastDecision = decision; }, "fake_token");

  const approved = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.APPROVAL_DECISION, {
      conversationId,
      requestId,
      decision: "approve",
      action: "file_upload",
      target: { tabId: 1 }
    })
  );
  assert(approved.acknowledged === true && approved.requestId === requestId, "an approval with a known requestId is acknowledged");
  assert(resolverCalled, "the pending canUseTool resolver must have been called");
  assert(lastDecision && lastDecision.decision === "approve", "the resolver received the approve decision");
  assert(approved.token === undefined, "no token is sent on the wire — design.md section 8 says the token never leaves the companion");

  // An unknown requestId is rejected, not silently applied
  const unknownReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.APPROVAL_DECISION, { conversationId, requestId: "rq_nonexistent", decision: "approve" })
  );
  assert(unknownReply.type === AGENT_MESSAGE_TYPES.ERROR && unknownReply.reason === "unknown_approval_request",
    "an approval_decision with an unknown requestId must be rejected, not silently applied");

  // Reset for denial path
  resolverCalled = false; lastDecision = null;
  const requestId2 = "rq_test_2";
  core._pendingApprovals.set(requestId2, (decision) => { resolverCalled = true; lastDecision = decision; }, "fake_token_2");
  const denied = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.APPROVAL_DECISION, { conversationId, requestId: requestId2, decision: "deny" })
  );
  assert(denied.acknowledged === true, "a denial with a known requestId is acknowledged");
  assert(resolverCalled && lastDecision && lastDecision.decision === "deny", "the resolver received the deny decision");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
});

await test("resuming an unknown conversation is a structured error, not a crash", async () => {
  const core = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.RESUME, { conversationId: "conv_nope" }));
  assert(reply.type === AGENT_MESSAGE_TYPES.ERROR && reply.reason === "unknown_conversation");
});

await test("companion restart recovery: a run interrupted mid-flight is marked interrupted on next hello, never silently resumed", async () => {
  // Simulate a companion process that died mid-run by writing the on-disk
  // state directly (activeRunId set, no run_done ever appended) — exactly
  // what a real crash leaves behind — then bring up a FRESH core over the
  // same storage and confirm recovery marks it interrupted rather than
  // trying to continue it.
  const store = new TranscriptStore();
  const conversationId = store.createConversation("conv_crash_test").conversationId;
  store.updateMeta(conversationId, { activeRunId: "run_ghost" });

  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async () => ({ content: [] }), shutdown: () => {} });
  const core = new CompanionCore({ toolBridge, sessionManager, lease, coerceArgs: (a) => a, sdk: fakeSdk(), profileProvider: fakeProfileProvider() });

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const meta = store.loadMeta(conversationId);
  assert(meta.interrupted === true, "a run active at last-known state must be marked interrupted after restart");
  assert(meta.activeRunId === null, "the ghost run id must be cleared, never treated as still running");
  const snapshot = store.snapshot(conversationId, 0);
  assert(snapshot.events.some((e) => e.type === "run_interrupted_by_restart"), "an explicit interruption event must be recorded");
});

// --- LIST_CONVERSATIONS / DELETE_CONVERSATION -----------------------------
//
// Closes reports/05-panel-evidence.md's "Known gaps" #1: the panel's
// history-store.js/conversation-model.js already implement listing, reopen
// and explicit local deletion but had no companion-side operation to call
// (host/agent/session/manager.js's listConversations()/deleteConversation()
// existed but host/agent/companion.js's handleEnvelope() had no case for
// either). See protocol.js's LIST_CONVERSATIONS/DELETE_CONVERSATION and
// companion.js's _handleListConversations()/_handleDeleteConversation().

console.log("\nLIST_CONVERSATIONS / DELETE_CONVERSATION\n");

await test("LIST_CONVERSATIONS before hello fails closed (consistent with NEW/START/STOP's sequencing)", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, {}));
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "must fail closed like every other pre-hello message");
  assert(reply.reason === "hello_required");
});

await test("DELETE_CONVERSATION before hello fails closed (consistent with NEW/START/STOP's sequencing)", async () => {
  const core = buildCore();
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId: "conv_x" }));
  assert(reply.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "must fail closed like every other pre-hello message");
  assert(reply.reason === "hello_required");
});

await test("LIST_CONVERSATIONS returns metadata including interrupted state and live hasActiveRun", async () => {
  // Conversation A: simulate a companion crash by writing an unresolved
  // activeRunId directly to disk (exactly what a real crash leaves behind),
  // then bring up a fresh core over the SAME storage so hello's
  // recoverAfterRestart() marks it interrupted.
  const store = new TranscriptStore();
  const conversationIdA = store.createConversation("conv_list_interrupted").conversationId;
  store.updateMeta(conversationIdA, { activeRunId: "run_ghost" });

  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async () => ({ content: [] }), shutdown: () => {} });
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    profileProvider: fakeProfileProvider()
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));

  // Conversation B: actively running right now (queued/running in THIS process).
  const newReplyB = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const conversationIdB = newReplyB.conversationId;
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: conversationIdB, prompt: "a" }));

  const listReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, {}));
  assert(listReply.type === AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, "must reply with the same message type (STOP-style convention)");
  assert(Array.isArray(listReply.conversations), "conversations must be an array");

  const entryA = listReply.conversations.find((c) => c.conversationId === conversationIdA);
  assert(entryA, "the recovered conversation must be listed");
  assert(entryA.interrupted === true, "a crash-recovered conversation must report interrupted:true");
  assert(entryA.hasActiveRun === false, "an interrupted conversation has no live active run in this process");

  const entryB = listReply.conversations.find((c) => c.conversationId === conversationIdB);
  assert(entryB, "the actively-running conversation must be listed");
  assert(entryB.interrupted === false, "an actively-running conversation must not report interrupted");
  assert(entryB.hasActiveRun === true, "an actively queued/running conversation must report hasActiveRun:true");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId: conversationIdB }));
});

await test("DELETE_CONVERSATION removes this app's own data but leaves a recording's actual file on disk untouched", async () => {
  const core = buildCore({
    sdk: {
      async *query() {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a" }));

  // A recording's ACTUAL file lives in a completely separate tree
  // (extension/background.js writes it under .config/browzy-in-chrome/
  // recordings/<id>/ before ever notifying anyone) — simulate that with a
  // real scratch file OUTSIDE this conversation's own directory, and attach
  // only the REFERENCE to this conversation the same way a real
  // recording_complete envelope would (host/agent/companion.js's
  // _handleRecordingComplete -> sessionManager.recordRecordingComplete()).
  const recordingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-recording-file-"));
  const recordingFile = path.join(recordingsRoot, "rec_keep_me", "trace.json");
  fs.mkdirSync(path.dirname(recordingFile), { recursive: true });
  fs.writeFileSync(recordingFile, JSON.stringify({ ok: true }));

  const attachedTo = core.sessionManager.recordRecordingComplete({
    recordingId: "rec_keep_me",
    path: recordingFile,
    schema: "v0",
    summary: "a demonstration",
    transcriptStatus: "ok"
  });
  assert(attachedTo === conversationId, "the recording should attach to the one active conversation");

  assert(fs.existsSync(conversationDir(conversationId)), "conversation directory must exist before delete");
  const deleteReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId }));
  assert(deleteReply.type === AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, "must reply with the same message type (STOP-style convention)");
  assert(deleteReply.deleted === true, "delete must report success");
  assert(deleteReply.hadActiveRun === true, "the reply must be explicit about an active run having been stopped as part of this delete");

  assert(!fs.existsSync(conversationDir(conversationId)), "this app's own conversation directory (including SDK artifacts) must be removed");
  assert(fs.existsSync(recordingFile), "design.md section 5: recorded demonstrations have separate retention — deleting history must NOT delete recordings");

  const listAfter = core.sessionManager.listConversations();
  assert(!listAfter.some((c) => c.conversationId === conversationId), "a deleted conversation must not be listed any more");

  fs.rmSync(recordingsRoot, { recursive: true, force: true });
});

await test("DELETE_CONVERSATION on an unknown conversation id is a structured error, not a false success", async () => {
  const core = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId: "conv_never_existed" }));
  assert(reply.type === AGENT_MESSAGE_TYPES.ERROR && reply.reason === "unknown_conversation");
});

await test("deleting a conversation with an active run is handled explicitly, not racy: the run is stopped synchronously and the directory is never resurrected by the run's own asynchronous unwind", async () => {
  // The fake SDK keeps "running" for 250ms after Start, well past when this
  // test calls DELETE_CONVERSATION — reproducing the exact race this task
  // was asked to close: SessionManager.deleteConversation() removes the
  // on-disk directory synchronously, but the query() generator's OWN
  // `finally` (host/agent/companion.js's _runQuery) still calls
  // sessionManager.finishRun() well after that, asynchronously. Without the
  // tombstone guards in session/manager.js (startRun's onEvent sink,
  // finishRun), that later finishRun()/appendEvent() call would silently
  // recreate a half-formed conversation directory the panel was already
  // told was deleted.
  const core = buildCore({
    sdk: {
      async *query({ options }) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 250);
          options.abortController.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
        yield { type: "assistant", text: "too late" };
      }
    }
  });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const startReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a" }));
  assert(startReply.accepted, "run must have actually started (queued:false, uncontested lease) for this race to be meaningful");

  const dir = conversationDir(conversationId);
  assert(fs.existsSync(dir), "conversation directory must exist while the run is active");

  const deleteReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId }));
  assert(deleteReply.deleted === true && deleteReply.hadActiveRun === true, "delete must succeed and report the active run it stopped");
  assert(!fs.existsSync(dir), "the directory must be gone immediately after delete replies");
  assert(!core.sessionManager.hasActiveRun(conversationId), "the run must no longer be considered active immediately after delete");

  // Give the aborted query()'s generator time to actually unwind and call
  // its finally block (well past the 250ms it would otherwise still be
  // "running" for, and past the abort rejection above).
  await new Promise((r) => setTimeout(r, 400));

  assert(!fs.existsSync(dir), "the directory must STILL be gone — the run's asynchronous unwind (finishRun/appendEvent) must never resurrect it");
  assert(
    !core.sessionManager.listConversations().some((c) => c.conversationId === conversationId),
    "the deleted conversation must never reappear in listConversations() after the run's async unwind"
  );

  // A NEW conversation must still be creatable normally afterward (the
  // tombstone must not leak into unrelated future conversation ids).
  const another = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  assert(another.conversationId && another.conversationId !== conversationId, "creating another conversation afterward must work normally");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {}

process.exit(failed.length ? 1 : 0);

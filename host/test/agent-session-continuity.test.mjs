#!/usr/bin/env node
//
// tasks.md 2.3/2.4/2.5 (upgrade-agent-reliability-and-workflows, design.md
// decisions 1/2): atomic SDK-reference ownership, one-active-run-per-
// conversation, browser/native lease release, deletion tombstones (2.3);
// resume-compatibility rejection with no historical-secret reconstruction
// (2.4); stop/restart/cancellation/partial-turn/concurrent-start/missing-
// session/legacy-conversation/unknown-in-flight-effect handling without
// replaying browser mutations or synthesizing memory from transcript events
// (2.5). Builds directly on 2.1/2.2's conversation-metadata schema
// (host/test/agent-conversation-metadata.test.mjs) — no live SDK/network.
//
// Run: node host/test/agent-session-continuity.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSdkSessionRef,
  SDK_SESSION_REF_STATUS,
  assessResumeCompatibility,
  buildAppProfileIdentity,
  buildSessionSchemaIdentity
} from "../agent/storage/conversation-metadata.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { conversationDir } from "../agent/storage/paths.js";
import { SessionManager } from "../agent/session/manager.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { CompanionCore } from "../agent/companion.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-session-continuity-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "super-secret-fake-key" },
        revision: 1,
        credentialRevision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

/**
 * A scripted fake `sdk.query()`: each call consumes the next descriptor in
 * `scripts` (the last one repeats if more calls happen than scripts were
 * given). Every call is recorded (prompt + options) so tests can assert
 * exactly what companion.js actually sent — in particular `options.resume`
 * and the literal `prompt` text (task 2.5's "no memory synthesis" proof).
 *
 * Descriptor shape: { initSessionId, messages: [...], throwError }.
 */
function scriptedSdk(scripts) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async *query({ prompt, options }) {
      const script = scripts[Math.min(i, scripts.length - 1)];
      i++;
      calls.push({ prompt, options });
      if (script.initSessionId) {
        yield { type: "system", subtype: "init", session_id: script.initSessionId, slash_commands: [] };
      }
      for (const m of script.messages || []) yield m;
      if (script.throwError) throw script.throwError;
    }
  };
}

function buildCore({ sdk, profileProvider } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  // toolCalls: every name this run's ToolBridge was actually asked to
  // dispatch. Every failure-path test in this file asserts this stays
  // empty — direct, empirical proof that THIS LAYER's own failure handling
  // (companion.js's catch blocks, the compatibility gate, the profile-
  // resolution failure path) contains no code that calls the tool bridge
  // itself to replay a browser action. Scope note: this does NOT prove the
  // SDK itself never replays a tool call on resume — that is gate-0.2's G1
  // (in-process tool-handler invocation-count delta of 0 across a resumed
  // turn) plus the still-open "live browser tool call replay end to end"
  // gap neither gate has closed (no live Chrome/extension attached). The
  // two claims are complementary, not the same proof.
  const toolCalls = [];
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => {
      toolCalls.push(name);
      return { content: [{ type: "text", text: `fake:${name}` }] };
    },
    shutdown: () => {}
  });
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || scriptedSdk([{ messages: [{ type: "assistant", text: "ok" }] }]),
    profileProvider: profileProvider || fakeProfileProvider()
  });
  return { core, sessionManager, store, lease, approvals, toolCalls };
}

async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, intervalMs));
  return fn();
}

console.log("\n2.3 — atomic SDK-reference ownership (pure CAS unit tests)\n");

{
  freshHome();
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sm = new SessionManager({ store, lease, approvals });
  const conversationId = sm.newConversation();

  const first = sm.claimSdkSessionRef(conversationId, { sessionId: "sess-A" });
  ok(first.claimed === true, "first claim (no existing ref) succeeds");
  ok(sm.getConversationMetadata(conversationId).sdkSessionRef.sessionId === "sess-A", "sessionId is persisted");
  ok(sm.getConversationMetadata(conversationId).sdkSessionRef.status === SDK_SESSION_REF_STATUS.ACTIVE, "status is ACTIVE");

  const sameIdAgain = sm.claimSdkSessionRef(conversationId, { sessionId: "sess-A" });
  ok(sameIdAgain.claimed === true, "re-claiming the SAME id (normal resume confirmation) succeeds");

  const conflicting = sm.claimSdkSessionRef(conversationId, { sessionId: "sess-B-unexpected" });
  ok(conflicting.claimed === false && conflicting.conflict === true, "claiming a DIFFERENT id while the existing ref is still ACTIVE is rejected, not silently overwritten");
  ok(sm.getConversationMetadata(conversationId).sdkSessionRef.sessionId === "sess-A", "the stored ref is untouched after a rejected conflicting claim");

  sm.markSdkSessionRefStatus(conversationId, SDK_SESSION_REF_STATUS.MISSING);
  const afterMissing = sm.getConversationMetadata(conversationId).sdkSessionRef;
  ok(afterMissing.status === SDK_SESSION_REF_STATUS.MISSING, "markSdkSessionRefStatus updates status");
  ok(afterMissing.sessionId === "sess-A", "marking a ref MISSING never clears the captured sessionId (no auto-clear on failure)");
  ok(sm.getResumeSessionId(conversationId) === null, "a MISSING ref is never offered for resume");

  const claimAfterMissing = sm.claimSdkSessionRef(conversationId, { sessionId: "sess-C-fresh" });
  ok(claimAfterMissing.claimed === true, "a DIFFERENT id may be claimed once the old ref is no longer ACTIVE (stale ref, not a surprise)");
  ok(sm.getResumeSessionId(conversationId) === "sess-C-fresh", "the fresh id becomes resumable going forward");

  const unknownConv = sm.claimSdkSessionRef("conv_does_not_exist", { sessionId: "x" });
  ok(unknownConv.claimed === false, "claiming for an unknown conversation id is a safe no-op");
}

console.log("\n2.4 — resume-compatibility assessment (pure function)\n");

{
  const noBindYet = assessResumeCompatibility({ bound: { appProfile: null, sessionSchemaIdentity: null }, current: { appProfile: {}, sessionSchemaIdentity: {} } });
  ok(noBindYet.compatible === true, "nothing bound yet (first run / legacy conversation) is always reported compatible");

  const bound = {
    appProfile: buildAppProfileIdentity({ profileId: "p1", baseUrl: "https://a.example", modelId: "m1", credentialRevision: 5 }),
    sessionSchemaIdentity: buildSessionSchemaIdentity({ cwd: "/c", pluginDir: "/c/skills-plugin", allowedSkillNames: ["p:skill-a"], skillOverrides: {} })
  };

  const identicalCurrent = {
    appProfile: buildAppProfileIdentity({ profileId: "p1", baseUrl: "https://a.example", modelId: "m1", credentialRevision: 5 }),
    sessionSchemaIdentity: buildSessionSchemaIdentity({ cwd: "/c", pluginDir: "/c/skills-plugin", allowedSkillNames: ["p:skill-a"], skillOverrides: {} })
  };
  ok(assessResumeCompatibility({ bound, current: identicalCurrent }).compatible === true, "an identical identity is compatible");

  const differentProfileIdOnly = {
    appProfile: buildAppProfileIdentity({ profileId: "p1-alias", baseUrl: "https://a.example", modelId: "m1", credentialRevision: 5 }),
    sessionSchemaIdentity: identicalCurrent.sessionSchemaIdentity
  };
  ok(assessResumeCompatibility({ bound, current: differentProfileIdOnly }).compatible === true, "a different profileId ALONE (same endpoint+model) is compatible — profileId is deliberately excluded");

  const rotatedCredential = {
    appProfile: buildAppProfileIdentity({ profileId: "p1", baseUrl: "https://a.example", modelId: "m1", credentialRevision: 999 }),
    sessionSchemaIdentity: identicalCurrent.sessionSchemaIdentity
  };
  ok(assessResumeCompatibility({ bound, current: rotatedCredential }).compatible === true, "a rotated credentialRevision on the SAME endpoint+model is compatible — no forced incompatibility on ordinary key rotation");

  const differentEndpoint = {
    appProfile: buildAppProfileIdentity({ profileId: "p1", baseUrl: "https://different.example", modelId: "m1", credentialRevision: 5 }),
    sessionSchemaIdentity: identicalCurrent.sessionSchemaIdentity
  };
  const endpointResult = assessResumeCompatibility({ bound, current: differentEndpoint });
  ok(endpointResult.compatible === false, "a different endpoint is incompatible");
  ok(endpointResult.mismatches.some((m) => m.field === "endpoint"), "the mismatch is reported with field:'endpoint'");

  const differentModel = {
    appProfile: buildAppProfileIdentity({ profileId: "p1", baseUrl: "https://a.example", modelId: "m2-different", credentialRevision: 5 }),
    sessionSchemaIdentity: identicalCurrent.sessionSchemaIdentity
  };
  ok(assessResumeCompatibility({ bound, current: differentModel }).compatible === false, "a different modelId is incompatible");

  const differentSkills = {
    appProfile: bound.appProfile,
    sessionSchemaIdentity: buildSessionSchemaIdentity({ cwd: "/c", pluginDir: "/c/skills-plugin", allowedSkillNames: ["p:skill-b"], skillOverrides: {} })
  };
  ok(assessResumeCompatibility({ bound, current: differentSkills }).compatible === false, "a different allowedSkillNames set is incompatible");
}

console.log("\n2.3/2.4 — end-to-end via CompanionCore: capture, resume, reject, no-memory-synthesis\n");

await (async function firstTurnCapturesAndSecondTurnResumes() {
  freshHome();
  const sdk = scriptedSdk([
    { initSessionId: "sdk-sess-1", messages: [{ type: "assistant", text: "first" }] },
    { initSessionId: "sdk-sess-1", messages: [{ type: "assistant", text: "second" }] }
  ]);
  const { core, sessionManager } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "remember the number 42" }));
  await waitUntil(() => sdk.calls.length === 1);
  ok(sdk.calls[0].options.resume === undefined, "the conversation's very first turn never passes options.resume");
  ok(sessionManager.getConversationMetadata(conversationId).sdkSessionRef?.sessionId === "sdk-sess-1", "the SDK's own session_id is captured after turn 1");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "what number did I say?" }));
  await waitUntil(() => sdk.calls.length === 2);
  ok(sdk.calls[1].options.resume === "sdk-sess-1", "a compatible second turn passes options.resume with the captured session id");
  ok(sdk.calls[1].options.persistSession === true, "persistSession is always explicit true");

  // Task 2.5's own verify clause, made concrete: the SECOND turn's prompt
  // must be exactly this turn's own text — never the first turn's text, and
  // never any transcript-derived reconstruction.
  ok(sdk.calls[1].prompt === "what number did I say?", "the resumed turn's prompt is EXACTLY this turn's own text");
  ok(!String(sdk.calls[1].prompt).includes("remember the number 42"), "the resumed turn's prompt never contains prior-turn text — no memory synthesized from the transcript");
})();

await (async function incompatibleModelIsRejectedWithStructuredMismatches() {
  freshHome();
  const sdk = scriptedSdk([{ initSessionId: "sdk-sess-1", messages: [{ type: "assistant", text: "first" }] }]);
  const { core, sessionManager, toolCalls } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await waitUntil(() => sdk.calls.length === 1);

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p2", modelId: "m2-different", prompt: "b" }));
  await new Promise((r) => setTimeout(r, 300));
  ok(sdk.calls.length === 1, "an incompatible-model turn never reaches sdk.query() at all");
  const snap = sessionManager.snapshotSince(conversationId, 0);
  const rejection = snap.events.find((e) => e.type === "run_error" && e.reason === "conversation_identity_incompatible");
  ok(Boolean(rejection), "a structured run_error with reason conversation_identity_incompatible is emitted");
  ok(Array.isArray(rejection.mismatches) && rejection.mismatches.some((m) => m.field === "modelId"), "the mismatch payload names the exact field that disagreed");
  ok(snap.events.some((e) => e.type === "run_stopped" && e.reason === "conversation_identity_incompatible"), "the run is stopped explicitly (lease released), never left dangling");
  ok(toolCalls.length === 0, "rejecting an incompatible-selection turn dispatches zero browser tool calls (no mutation replay)");
})();

await (async function newSdkSessionExplicitlyBypassesRejectionAndResume() {
  freshHome();
  const sdk = scriptedSdk([
    { initSessionId: "sdk-sess-1", messages: [{ type: "assistant", text: "first" }] },
    { initSessionId: "sdk-sess-2-fresh", messages: [{ type: "assistant", text: "recovered" }] }
  ]);
  const { core, sessionManager } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await waitUntil(() => sdk.calls.length === 1);

  // The explicit recovery/new-conversation-choice signal (tasks.md 2.4/2.5):
  // proceeds despite the mismatch, and never attempts resume.
  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p2", modelId: "m2-different", prompt: "b", newSdkSession: true })
  );
  await waitUntil(() => sdk.calls.length === 2);
  ok(sdk.calls[1].options.resume === undefined, "newSdkSession:true never passes options.resume, even though a ref exists");
  const snap = sessionManager.snapshotSince(conversationId, 0);
  ok(!snap.events.some((e) => e.type === "run_error" && e.reason === "conversation_identity_incompatible"), "newSdkSession:true suppresses the incompatibility rejection");
  ok(sessionManager.getConversationMetadata(conversationId).appProfile.modelId === "m1", "the conversation's originally bound identity is STILL never overwritten — recovery is per-turn, not a silent permanent switch");
})();

await (async function malformedNewSdkSessionFieldIsRejected() {
  freshHome();
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "a", newSdkSession: "yes" }));
  ok(reply.type === AGENT_MESSAGE_TYPES.ERROR && reply.reason === "malformed_new_sdk_session", "a non-boolean newSdkSession is rejected before any run exists, not coerced");
})();

console.log("\n2.5 — missing/failed resume, no automatic retry, recovery on the following turn\n");

await (async function missingSessionIsClassifiedAndNeverAutoRetried() {
  freshHome();
  const missingErr = new Error("Claude Code returned an error result: No conversation found with session ID: sdk-sess-1");
  const sdk = scriptedSdk([
    { initSessionId: "sdk-sess-1", messages: [{ type: "assistant", text: "first" }] },
    { throwError: missingErr }, // turn 2 attempts resume of sdk-sess-1 and fails
    { initSessionId: "sdk-sess-3-fresh", messages: [{ type: "assistant", text: "third, fresh" }] } // turn 3 must NOT retry resume
  ]);
  const { core, sessionManager, toolCalls } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await waitUntil(() => sdk.calls.length === 1);

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "b" }));
  await waitUntil(() => sdk.calls.length === 2);
  ok(sdk.calls[1].options.resume === "sdk-sess-1", "turn 2 correctly attempted resume of the captured session");
  const afterFailure = sessionManager.getConversationMetadata(conversationId).sdkSessionRef;
  ok(afterFailure.status === SDK_SESSION_REF_STATUS.MISSING, "an explicit 'No conversation found' failure is classified as MISSING, not a generic error");
  ok(afterFailure.sessionId === "sdk-sess-1", "the sessionId is preserved (never auto-cleared) even after a classified failure");
  const snap2 = sessionManager.snapshotSince(conversationId, 0);
  ok(snap2.events.some((e) => e.type === "run_error" && e.reason === "session_missing"), "the failure surfaces as an explicit session_missing run_error");

  // Turn 3: a plain retry (no newSdkSession) must NOT attempt resume again —
  // getResumeSessionId() only offers an ACTIVE ref.
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "c" }));
  await waitUntil(() => sdk.calls.length === 3);
  ok(sdk.calls[2].options.resume === undefined, "the very next turn does not automatically retry the failed resume");
  ok(sdk.calls[2].prompt === "c", "the fresh turn's prompt is exactly its own text, no reconstruction from the missing session's prior turns");
  ok(sessionManager.getConversationMetadata(conversationId).sdkSessionRef.sessionId === "sdk-sess-3-fresh", "the fresh session captured on recovery replaces the known-stale ref (not a conflict, since the old one was MISSING)");
  ok(toolCalls.length === 0, "the missing-session failure and its recovery turn dispatch zero browser tool calls (no mutation replay)");
})();

await (async function abortedPartialTurnStillPreservesTheCapturedRefForTheNextTurn() {
  freshHome();
  // Turn 1: the init message (session_id) arrives, then the stream throws
  // BEFORE a result — simulates a partial/aborted turn. resumeAttempted is
  // false (nothing was resumed yet), so this must be classified as a plain
  // run_error, not a resume failure — but the id already captured before
  // the throw must still be usable for the NEXT turn.
  const sdk = scriptedSdk([
    { initSessionId: "sdk-sess-partial", throwError: new Error("stream interrupted") },
    { initSessionId: "sdk-sess-partial", messages: [{ type: "assistant", text: "continued" }] }
  ]);
  const { core, sessionManager, toolCalls } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await waitUntil(() => sdk.calls.length === 1);
  const snap1 = sessionManager.snapshotSince(conversationId, 0);
  const firstError = snap1.events.find((e) => e.type === "run_error");
  ok(firstError && firstError.reason === "run_error", "a partial-turn failure with no resume attempted is a generic run_error, never mislabeled session_missing");
  ok(sessionManager.getConversationMetadata(conversationId).sdkSessionRef?.sessionId === "sdk-sess-partial", "the session_id captured BEFORE the mid-stream failure is preserved");
  ok(sessionManager.getConversationMetadata(conversationId).sdkSessionRef.status === SDK_SESSION_REF_STATUS.ACTIVE, "it stays ACTIVE — only a classified resume failure ever marks it MISSING/RESUME_FAILED");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "b" }));
  await waitUntil(() => sdk.calls.length === 2);
  ok(sdk.calls[1].options.resume === "sdk-sess-partial", "the next turn successfully resumes using the ref preserved across the partial turn");
  ok(sdk.calls[1].prompt === "b", "the turn following a partial failure sends only its own text");
  ok(toolCalls.length === 0, "a partial-turn failure and its follow-up dispatch zero browser tool calls (no mutation replay)");
})();

await (async function deliberateStopIsNeverReclassifiedAsAResumeFailure() {
  freshHome();
  const sdk = {
    calls: [],
    async *query({ prompt, options }) {
      sdk.calls.push({ prompt, options });
      yield { type: "system", subtype: "init", session_id: "sdk-sess-slow", slash_commands: [] };
      await new Promise((r) => setTimeout(r, 200));
      yield { type: "assistant", text: "slow" };
    }
  };
  const { core, sessionManager, toolCalls } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await waitUntil(() => sdk.calls.length === 1);
  const stopReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId }));
  ok(stopReply.stopped === true, "the run is actually stopped");
  await new Promise((r) => setTimeout(r, 50));
  const snap = sessionManager.snapshotSince(conversationId, 0);
  ok(snap.events.some((e) => e.type === "run_stopped"), "a deliberate stop emits run_stopped");
  ok(!snap.events.some((e) => e.type === "run_error" && (e.reason === "session_missing" || e.reason === "session_resume_failed")), "a deliberate stop is never reclassified as a resume/session failure");
  ok(sessionManager.getConversationMetadata(conversationId).sdkSessionRef?.status === SDK_SESSION_REF_STATUS.ACTIVE, "the ref captured before the stop stays ACTIVE — a user stop does not poison it");
  ok(toolCalls.length === 0, "a cancellation (stop) dispatches zero browser tool calls (no mutation replay)");
})();

console.log("\n2.3/2.5 — companion restart survives via durable sdkSessionRef, deletion tombstone + late-unwind sweep\n");

await (async function sdkSessionRefSurvivesASimulatedCompanionRestart() {
  const scratch = freshHome();
  const store1 = new TranscriptStore();
  const lease1 = new BrowserLease();
  const approvals1 = new ApprovalRegistry();
  const sm1 = new SessionManager({ store: store1, lease: lease1, approvals: approvals1 });
  const conversationId = sm1.newConversation();
  sm1.bindConversationAppSnapshot(conversationId, {
    appProfile: buildAppProfileIdentity({ profileId: "p1", baseUrl: "https://a.example", modelId: "m1", credentialRevision: 1 }),
    sessionSchemaIdentity: null,
    permissionPolicy: null
  });
  sm1.claimSdkSessionRef(conversationId, { sessionId: "sess-restart-survives" });

  // Simulate a companion process restart: brand-new in-memory objects, same
  // on-disk OCIC_AGENT_HOME (never re-call freshHome()).
  const store2 = new TranscriptStore();
  const lease2 = new BrowserLease();
  const approvals2 = new ApprovalRegistry();
  const sm2 = new SessionManager({ store: store2, lease: lease2, approvals: approvals2 });
  sm2.recoverAfterRestart();

  ok(sm2.getResumeSessionId(conversationId) === "sess-restart-survives", "a captured SDK session reference survives a companion restart (it is durable on-disk metadata, not in-memory state)");
  ok(fs.existsSync(scratch), "sanity: the same scratch OCIC_AGENT_HOME was reused across the simulated restart");
})();

await (async function deletionTombstonesFirstAndLateUnwindSweepRetries() {
  freshHome();
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sm = new SessionManager({ store, lease, approvals });
  const conversationId = sm.newConversation();

  // Simulate the first on-disk removal attempt failing (e.g. a still-open
  // file handle on Windows) by making deleteConversation throw exactly
  // once.
  let calls = 0;
  const realDelete = store.deleteConversation.bind(store);
  store.deleteConversation = (id) => {
    calls++;
    if (calls === 1) throw new Error("EBUSY: simulated open handle");
    return realDelete(id);
  };

  const { hadActiveRun } = sm.deleteConversation(conversationId);
  ok(hadActiveRun === false, "no active run existed for this conversation");
  ok(sm.hasConversation(conversationId) === false, "the conversation is unreachable through the tombstone immediately, even though the underlying rmSync attempt failed");
  ok(fs.existsSync(conversationDir(conversationId)), "the directory genuinely still exists on disk after the simulated failed first attempt (proves the tombstone, not the rmSync, is what commits the deletion)");

  // finishRun's late-unwind sweep: a run "finishing" for this now-tombstoned
  // conversation must retry the on-disk removal.
  sm.finishRun(conversationId);
  ok(calls === 2, "finishRun's late-unwind sweep retried the on-disk removal exactly once");
  ok(!fs.existsSync(conversationDir(conversationId)), "the directory is actually gone once the retry succeeds");
})();

await (async function deletionTombstoneOrderingPreventsLateResurrectionDuringAnActiveRun() {
  freshHome();
  const sdk = {
    async *query() {
      await new Promise((r) => setTimeout(r, 150));
      yield { type: "assistant", text: "slow" };
    }
  };
  const { core, sessionManager, toolCalls } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await new Promise((r) => setTimeout(r, 30));

  const del = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId }));
  ok(del.deleted === true && del.hadActiveRun === true, "deleting a conversation with an active run reports both facts honestly");
  ok(sessionManager.hasConversation(conversationId) === false, "the conversation is gone immediately");

  // Let the aborted run's async unwind (finally -> finishRun) actually
  // settle before asserting nothing came back.
  await new Promise((r) => setTimeout(r, 300));
  ok(sessionManager.hasConversation(conversationId) === false, "the conversation is STILL gone after the aborted run's asynchronous unwind completes — no late resurrection");
  ok(sessionManager.getConversationMetadata(conversationId) === null, "no metadata (including any sdkSessionRef) resurrects either");
  ok(toolCalls.length === 0, "deleting an active run dispatches zero browser tool calls (no mutation replay)");
})();

console.log("\n2.6 — credential-unavailable: a resume-eligible turn whose credential is gone never attempts resume\n");

await (async function credentialUnavailableNeverAttemptsResumeAndLeavesTheRefUntouched() {
  // Task 2.4/2.6: "reject ... unavailable current credentials with explicit
  // recovery/new-conversation UI" — this is distinct from
  // incompatibleModelIsRejectedWithStructuredMismatches above (a mismatched
  // endpoint/model, known before any credential lookup) and distinct from
  // missingSessionIsClassifiedAndNeverAutoRetried (an SDK-level resume
  // failure). Here turn 1 succeeds and captures an ACTIVE, resume-eligible
  // ref; turn 2 requests the SAME compatible identity, but this run's own
  // credential resolution (host/agent/companion.js's
  // resolveProfileSnapshot(), called BEFORE assessResumeCompatibility()/
  // getResumeSessionId() in _runAfterLeaseGranted) fails — proving the SDK
  // is never even reached, so no resume is attempted, and the captured ref
  // is left completely untouched (not marked MISSING/RESUME_FAILED — that
  // classification is reserved for an actual attempted-and-failed SDK
  // resume, never for a credential that never got far enough to try).
  freshHome();
  const sdk = scriptedSdk([{ initSessionId: "sdk-sess-cred", messages: [{ type: "assistant", text: "first" }] }]);
  let profileCalls = 0;
  const profileProvider = {
    async snapshotForRun(profileId, modelId) {
      profileCalls++;
      if (profileCalls === 2) {
        throw new Error("credential revoked"); // resolveProfileSnapshot() wraps this into ProfileUnavailableError
      }
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "super-secret-fake-key" },
        revision: 1,
        credentialRevision: 1,
        profileId: profileId || "default"
      };
    }
  };
  const { core, sessionManager, toolCalls } = buildCore({ sdk, profileProvider });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  await waitUntil(() => sdk.calls.length === 1);
  const refBefore = sessionManager.getConversationMetadata(conversationId).sdkSessionRef;
  ok(refBefore.sessionId === "sdk-sess-cred" && refBefore.status === SDK_SESSION_REF_STATUS.ACTIVE, "turn 1 captured an ACTIVE, resume-eligible ref");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "what did I say?" }));
  await waitUntil(() => profileCalls === 2);
  await new Promise((r) => setTimeout(r, 200));

  ok(sdk.calls.length === 1, "a credential-unavailable turn never reaches sdk.query() — no resume is attempted");
  const snap = sessionManager.snapshotSince(conversationId, 0);
  ok(snap.events.some((e) => e.type === "run_error" && e.reason === "profile_unavailable"), "the failure surfaces as an explicit profile_unavailable run_error");
  ok(snap.events.some((e) => e.type === "run_stopped" && e.reason === "profile_unavailable"), "the run is stopped explicitly with the same reason (lease released), symmetric with the incompatible-selection rejection above");
  const refAfter = sessionManager.getConversationMetadata(conversationId).sdkSessionRef;
  ok(refAfter.status === SDK_SESSION_REF_STATUS.ACTIVE, "the ref's status is left ACTIVE — credential unavailability is never misclassified as a resume failure");
  ok(refAfter.sessionId === "sdk-sess-cred", "the captured sessionId is untouched");
  ok(toolCalls.length === 0, "a credential-unavailable turn dispatches zero browser tool calls (no mutation replay)");
})();

console.log("\n2.6 — race: DELETE_CONVERSATION arrives while a turn is mid-flight, strictly before its init/session_id message\n");

await (async function deleteRacesAheadOfAnInFlightSessionIdCapture() {
  // The precise race companion.js's own _runQuery comment names ("this
  // conversation was deleted the instant this message arrived") and
  // session/manager.js's claimSdkSessionRef()/markSdkSessionRefStatus()
  // guard against (both check the tombstone set FIRST, before writing any
  // metadata). deletionTombstoneOrderingPreventsLateResurrectionDuringAnActiveRun
  // above proves general no-resurrection for a run that never captures a
  // session_id at all; this test is the one that actually exercises a
  // session_id/init message arriving from the SDK strictly AFTER the
  // tombstone is already set, proving claimSdkSessionRef's own guard
  // end-to-end rather than only by source inspection.
  freshHome();
  let releaseInit;
  const gate = new Promise((resolve) => { releaseInit = resolve; });
  const sdk = {
    calls: [],
    async *query({ prompt, options }) {
      sdk.calls.push({ prompt, options });
      await gate; // held open by the test until AFTER delete has run
      yield { type: "system", subtype: "init", session_id: "sdk-sess-late-race", slash_commands: [] };
      yield { type: "assistant", text: "too late" };
    }
  };
  const { core, sessionManager, toolCalls } = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  const startReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, profileId: "p1", modelId: "m1", prompt: "a" }));
  ok(startReply.accepted, "the run actually started (uncontested lease) before the race begins");
  await waitUntil(() => sdk.calls.length === 1);

  const del = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId }));
  ok(del.deleted === true, "delete succeeds while the query is mid-flight, strictly before any init/session_id was ever yielded");
  ok(sessionManager.hasConversation(conversationId) === false, "the conversation is gone immediately, before the SDK has said anything");

  // Now let the in-flight query's init message (carrying a session_id)
  // arrive — deliberately AFTER the tombstone was already set.
  releaseInit();
  await new Promise((r) => setTimeout(r, 200));

  ok(sessionManager.hasConversation(conversationId) === false, "still gone — a session_id captured strictly after deletion did not resurrect the conversation");
  ok(sessionManager.getConversationMetadata(conversationId) === null, "no sdkSessionRef (or any other metadata) was written by the late-arriving claim racing the tombstone");
  ok(toolCalls.length === 0, "the raced-out turn dispatches zero browser tool calls (no mutation replay)");
})();

console.log(`\n${fail === 0 ? "ALL SESSION CONTINUITY TESTS PASSED" : `${fail} FAILURE(S)`}\n`);
process.exit(fail ? 1 : 0);

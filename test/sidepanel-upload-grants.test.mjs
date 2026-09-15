#!/usr/bin/env node
// Upload grants, panel half: extension/sidepanel/upload-grants.js's state
// machine, protocol-client.js's uploadGrant() envelope, and one REAL round
// trip — panel client -> in-memory transport -> the actual
// host/agent/companion.js CompanionCore -> reply -> the state machine.
// (Same "fake companion harness" pattern test/sidepanel-fake-companion.test.mjs
// established: only the SDK's query() and the settings profile module are
// fakes.)
//
// What this pins:
//   - a path counts as shared ONLY after the companion confirmed it;
//   - a reply to a request this panel does not have outstanding is inert;
//   - a dropped connection clears every claim (in-memory grants on both ends);
//   - the grant that comes back from the real companion is exactly the file
//     that exists on disk, and a missing one comes back as skipped.
//
// Run: node test/sidepanel-upload-grants.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../host/agent/companion.js";
import { TranscriptStore } from "../host/agent/storage/transcript-store.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { SessionManager } from "../host/agent/session/manager.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";

import { ProtocolClient, MSG, HANDSHAKE, AGENT_PROTOCOL_VERSION } from "../extension/sidepanel/protocol-client.js";
import { createUploadGrantState } from "../extension/sidepanel/upload-grants.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-sidepanel-upload-grants-"));
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

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-panel-grant-fixtures-"));
const sharedFile = path.join(fixtureDir, "report.pdf");
const missingFile = path.join(fixtureDir, "not-there.bin");
fs.writeFileSync(sharedFile, "bytes");

// --- a real companion behind an in-memory chrome.runtime.Port-shaped transport

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

function buildCore() {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  const sdk = {
    async *query() {
      yield { type: "assistant", text: "ok" };
    }
  };
  return new CompanionCore({ toolBridge, sessionManager, lease, coerceArgs: (a) => a, sdk, profileProvider: fakeProfileProvider() });
}

function makeBridgeTransport(core) {
  const msgListeners = [];
  const deliver = (envelope) => {
    setTimeout(() => {
      for (const fn of msgListeners) fn({ type: "agent_msg", envelope });
    }, 0);
  };
  return {
    postMessage: (msg) => {
      if (!msg || msg.type !== "agent_msg" || !msg.envelope) return;
      Promise.resolve(core.handleEnvelope(msg.envelope)).then((reply) => {
        if (reply) deliver(reply);
      });
    },
    onMessage: { addListener: (fn) => msgListeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {
      for (const fn of msgListeners) void fn;
    }
  };
}

/** A client wired to a real companion, plus every envelope it receives. */
async function connectedClient() {
  const core = buildCore();
  const seen = [];
  const client = new ProtocolClient({ createTransport: () => makeBridgeTransport(core) });
  client.onEnvelope((env) => seen.push(env));
  client.connect();
  client.sendHello({ installationId: "test-install", connectionId: "test-conn" });
  await waitUntil(() => client.handshakeState() === HANDSHAKE.OK);
  return { core, client, seen };
}

console.log("== state machine: a claim exists only after the companion confirms it ==");
{
  const state = createUploadGrantState();
  ok(state.pathsFor("conv1").length === 0, "nothing is shared before any reply");

  state.beginPick();
  ok(state.isPickPending() === true, "the pick is marked in flight");
  state.endPick();
  ok(state.isPickPending() === false, "and settles when the dialog closes");

  state.noteRequest("req1", { conversationId: "conv1", op: "grant" });
  const outcome = state.applyReply({
    type: "upload_grant",
    requestId: "req1",
    conversationId: "conv1",
    ok: true,
    result: { granted: ["/tmp/a.pdf"], revoked: [], skipped: [{ path: "/tmp/b.bin", reason: "not_found" }] }
  });
  ok(outcome && outcome.granted.length === 1 && outcome.granted[0] === "/tmp/a.pdf", "the confirmed grant is applied");
  ok(outcome.skipped.length === 1 && outcome.skipped[0].reason === "not_found", "the skipped path is reported, not hidden");
  ok(state.pathsFor("conv1").join(",") === "/tmp/a.pdf", "and the path is now claimable for that conversation");
  ok(state.pathsFor("conv2").length === 0, "grants are per conversation");

  ok(
    state.applyReply({ type: "upload_grant", requestId: "req1", ok: true, result: { granted: ["/tmp/a.pdf"] } }) === null,
    "a re-delivered reply (no outstanding request) changes nothing"
  );
  ok(
    state.applyReply({ type: "upload_grant", requestId: "never-sent", ok: true, result: { granted: ["/x"] } }) === null,
    "a reply this panel never asked for is inert"
  );

  state.noteRequest("req2", { conversationId: "conv1", op: "revoke" });
  const revoked = state.applyReply({ type: "upload_grant", requestId: "req2", conversationId: "conv1", ok: true, result: { granted: [], revoked: ["/tmp/a.pdf"], skipped: [] } });
  ok(revoked && revoked.revoked.length === 1, "the revoke is applied");
  ok(state.pathsFor("conv1").length === 0, "and the chip's claim is gone");

  state.noteRequest("req3", { conversationId: "conv1", op: "grant" });
  const failed = state.applyReply({ type: "upload_grant", requestId: "req3", conversationId: "conv1", ok: false, error: { code: "NOT_FOUND", message: "unknown conversation" } });
  ok(failed && failed.error === "unknown conversation", "a refusal surfaces its reason");
  ok(state.pathsFor("conv1").length === 0, "and grants nothing");

  state.noteRequest("req4", { conversationId: "conv1", op: "grant" });
  state.applyReply({ type: "upload_grant", requestId: "req4", conversationId: "conv1", ok: true, result: { granted: ["/tmp/a.pdf"], revoked: [], skipped: [] } });
  state.clearAll();
  ok(state.pathsFor("conv1").length === 0 && state.hasAny() === false, "a dropped connection clears every claim (the companion's grants were in-memory too)");
}

console.log("== protocol client: envelope shape ==");
{
  const sent = [];
  const port = {
    postMessage: (m) => sent.push(m),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {}
  };
  const client = new ProtocolClient({ createTransport: () => port });
  client.connect();
  client.uploadGrant({ requestId: "req-1", conversationId: "conv1", op: "grant", paths: ["/tmp/a.pdf"] });
  const env = sent[0].envelope;
  ok(sent[0].type === "agent_msg", "wrapped as the agent port expects");
  ok(env.type === MSG.UPLOAD_GRANT && env.v === AGENT_PROTOCOL_VERSION, "typed upload_grant, versioned");
  ok(env.op === "grant" && env.conversationId === "conv1" && env.paths[0] === "/tmp/a.pdf" && env.requestId === "req-1", "carries op, conversation, paths and requestId");
  ok(typeof env.ts === "number", "and a timestamp like every other envelope");
}

console.log("== round trip: panel client <-> real companion ==");
await (async () => {
  const { core, client, seen } = await connectedClient();
  const state = createUploadGrantState();

  client.newConversation({});
  ok(await waitUntil(() => seen.some((e) => e.type === "snapshot")), "the companion answered NEW with a snapshot");
  const conversationId = seen.find((e) => e.type === "snapshot").conversationId;

  const grants = [];
  client.onEnvelope((env) => {
    const outcome = state.applyReply(env);
    if (outcome) grants.push(outcome);
  });

  state.noteRequest("req-grant", { conversationId, op: "grant" });
  client.uploadGrant({ requestId: "req-grant", conversationId, op: "grant", paths: [sharedFile, missingFile] });
  ok(await waitUntil(() => grants.length === 1), "the companion replied to the grant");

  const outcome = grants[0];
  ok(outcome.granted.length === 1 && outcome.granted[0] === sharedFile, "the real file is granted");
  ok(outcome.skipped.length === 1 && outcome.skipped[0].path === missingFile, "the path that does not exist is skipped");
  ok(state.pathsFor(conversationId).join(",") === sharedFile, "and the panel's state holds exactly what the companion confirmed");

  // And the companion really is holding it, not just saying so.
  ok(core._uploadGrantsByConversation.get(conversationId).has(sharedFile), "the companion's own grant store agrees");

  state.noteRequest("req-revoke", { conversationId, op: "revoke" });
  client.uploadGrant({ requestId: "req-revoke", conversationId, op: "revoke", paths: [sharedFile] });
  ok(await waitUntil(() => grants.length === 2), "the companion replied to the revoke");
  ok(grants[1].revoked.length === 1, "the revoke is confirmed");
  ok(state.pathsFor(conversationId).length === 0, "and the panel states nothing was shared any more");
  ok(core._uploadGrantsByConversation.get(conversationId).size === 0, "as does the companion");
})();

fs.rmSync(scratchRoot, { recursive: true, force: true });
fs.rmSync(fixtureDir, { recursive: true, force: true });

console.log(fail === 0 ? "\nALL UPLOAD-GRANT PANEL TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// CRITICAL fix (add-permission-modes-and-threat-signals verification): a
// download-pause decision (extension/background.js's chrome.downloads gate,
// task 2.4) is deliberately LOCAL-only — it never routes through
// host/agent/policy/can-use-tool.js's approval-token machinery, because
// chrome.downloads.DownloadItem carries no tabId for that machinery's
// per-call binding to verify against. But unlike every OTHER protected
// decision (whose outcome is an ordinary tool_result/tool_rejected the host
// already persists), this decision's OUTCOME used to be invisible to the
// durable conversation record entirely once the panel session ended.
//
// This proves, against the REAL CompanionCore (no SDK/network/credential):
//   1. A `download_decision_recorded` envelope (background.js's
//      fire-and-forget report, sent AFTER it already resumed/cancelled the
//      download locally) is appended to the named conversation's durable
//      transcript via SessionManager.recordDownloadDecision(), replayable
//      from a snapshot exactly like any other durable fact.
//   2. It is idempotent on requestId — a retried/duplicate send never
//      double-records the same decision.
//   3. An unknown conversationId is reported, never silently accepted.
//   4. A malformed envelope (missing conversationId/requestId, or a
//      decision that is neither "allow" nor "deny") is rejected.
//   5. This message is NOT gated on a fresh hello on this connection (the
//      conversationId is already known and explicit) — the same class as
//      ACTION_EVENT/RECORDING_COMPLETE.
//
// Run: node host/test/download-decision-durable-record.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-download-decision-record-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

let fail = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function buildCore() {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async (name) => ({ content: [{ type: "text", text: `ok:${name}` }] }), shutdown: () => {} });
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: { async *query() {} },
    profileProvider: { async snapshotForRun() { throw new Error("not used by this suite"); } }
  });
  return { core, store };
}

async function newConversation(core) {
  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }));
  assert(reply && reply.conversationId, `expected a conversationId from NEW, got ${JSON.stringify(reply)}`);
  return reply.conversationId;
}

console.log("\nDownload decision durable-record wiring (CompanionCore)\n");

await test("a download decision is appended to the conversation's durable transcript and survives a snapshot replay", async () => {
  const { core, store } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await newConversation(core);

  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, {
      conversationId,
      requestId: "req_1",
      decision: "allow",
      category: "download",
      filename: "invoice.pdf",
      url: "https://evil.example/invoice.pdf"
    })
  );
  assert(reply && reply.recorded === true, `expected recorded:true, got ${JSON.stringify(reply)}`);

  const events = store.eventsAfter(conversationId, 0);
  const recorded = events.find((e) => e.type === "download_decision_recorded");
  assert(recorded, "the download_decision_recorded event must be durably appended to this conversation's transcript");
  assert(recorded.requestId === "req_1" && recorded.decision === "allow", "the durable record carries the exact requestId/decision");
  assert(recorded.filename === "invoice.pdf" && recorded.url === "https://evil.example/invoice.pdf", "the durable record carries the filename/url for display");

  // A fresh RESUME (a new companion process reopening the conversation)
  // must see it too — not just the same in-memory session.
  const resumeReply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.RESUME, { conversationId, afterSeq: 0 }));
  const replayed = resumeReply.events.find((e) => e.type === "download_decision_recorded");
  assert(replayed && replayed.requestId === "req_1", "the durable record is included in a RESUME snapshot's replayed events");
});

await test("idempotent on requestId: a retried/duplicate send never double-records the same decision", async () => {
  const { core, store } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await newConversation(core);
  const payload = { conversationId, requestId: "req_dup", decision: "deny", category: "download", filename: "x.zip", url: "https://x/x.zip" };

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, payload));
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, payload));

  const matches = store.eventsAfter(conversationId, 0).filter((e) => e.type === "download_decision_recorded" && e.requestId === "req_dup");
  assert(matches.length === 1, `a duplicate send must not double-record — got ${matches.length} entries`);
});

await test("an unknown conversationId is reported, never silently accepted", async () => {
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, { conversationId: "conv_never_existed", requestId: "req_x", decision: "allow" })
  );
  assert(reply.type === "error" && reply.reason === "unknown_conversation", `expected an unknown_conversation error, got ${JSON.stringify(reply)}`);
});

await test("a malformed envelope is rejected: missing fields, or a decision that is neither allow nor deny", async () => {
  const { core } = buildCore();
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await newConversation(core);

  const missingRequestId = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, { conversationId, decision: "allow" }));
  assert(missingRequestId.type === "error" && missingRequestId.reason === "malformed_download_decision_recorded", `missing requestId must be rejected — got ${JSON.stringify(missingRequestId)}`);

  const missingConversationId = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, { requestId: "req_y", decision: "allow" }));
  assert(missingConversationId.type === "error" && missingConversationId.reason === "malformed_download_decision_recorded", `missing conversationId must be rejected — got ${JSON.stringify(missingConversationId)}`);

  const badDecision = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, { conversationId, requestId: "req_z", decision: "maybe" }));
  assert(badDecision.type === "error" && badDecision.reason === "malformed_download_decision_recorded", `a decision that is neither allow nor deny must be rejected — got ${JSON.stringify(badDecision)}`);
});

await test("not gated on a fresh hello on this connection — the conversationId is already known and explicit", async () => {
  const { core, store } = buildCore();
  // A conversation must already exist on disk for this to record against
  // (created here via a hello'd core, mirroring how a real conversation
  // would already exist before background.js ever sends this) — but the
  // assertion under test is that DOWNLOAD_DECISION_RECORDED itself does not
  // require _requireHello() to have succeeded on THIS handleEnvelope call.
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const conversationId = await newConversation(core);

  const freshCore = buildCore().core; // never said hello
  freshCore.sessionManager = core.sessionManager; // share the same on-disk conversation
  const reply = await freshCore.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.DOWNLOAD_DECISION_RECORDED, { conversationId, requestId: "req_no_hello", decision: "allow" })
  );
  assert(reply && reply.recorded === true, `expected recorded:true with no prior hello on this connection, got ${JSON.stringify(reply)}`);
  const recorded = store.eventsAfter(conversationId, 0).find((e) => e.type === "download_decision_recorded" && e.requestId === "req_no_hello");
  assert(recorded, "the record must still be appended with no prior hello on this connection");
});

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.name}\n    ${f.err}`);
}
console.log(failed.length === 0 ? "ALL DOWNLOAD-DECISION DURABLE-RECORD TESTS PASSED" : `${failed.length} FAILED`);
process.exit(failed.length ? 1 : 0);

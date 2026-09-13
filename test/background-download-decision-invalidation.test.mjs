#!/usr/bin/env node
// extension/background.js's download-decision lifecycle fix (task 2.4
// follow-up, add-permission-modes-and-threat-signals verification): an
// outstanding download-pause decision used to be cleared ONLY when the user
// answered it — nothing invalidated it on Stop, on a permission-mode change,
// or on the run it belonged to ending any other way, so a late Allow after
// the user had already walked away still called chrome.downloads.resume().
//
// This proves, extracted from the SHIPPED background.js (test/_extract.mjs's
// brace-matching technique):
//   1. handleDownloadCreated() now stamps the ACTIVE run's runId onto both
//      the tracked pending entry and the broadcast envelope.
//   2. invalidateDownloadDecisionsForRun() deletes only the entries that
//      belong to the given run, broadcasts download_decision_invalidated for
//      each, and NEVER calls chrome.downloads.resume()/cancel() — an
//      invalidated decision is left exactly as paused as it already was.
//   3. invalidateAllDownloadDecisions() does the same for every pending
//      entry regardless of runId (the permission-mode-change trigger, which
//      has no run boundary of its own).
//   4. A late handleDownloadDecision() reply for an already-invalidated
//      requestId is a silent no-op — proving the actual bug this fix closes.
//   5. handleDownloadDecision() reports the outcome to the native host via a
//      fire-and-forget download_decision_recorded envelope (the durable-
//      record half of the same fix), and never throws when there is no
//      native connection or no conversationId to attribute it to.
//   6. handleAgentMessage()'s existing run-teardown hook (the SAME one that
//      already tears down the overlay and clears activeAgentRuns) now also
//      invalidates that run's download decisions — for run_stopped,
//      run_done, run_error, and run_interrupted_by_restart, but never for an
//      unrelated event like run_started.
//   7. Structural: the "ocic-agent" port.onMessage handler intercepts a
//      download_decisions_invalidate reply LOCALLY, exactly like
//      download_decision, and never forwards either to nativePort.
//
// Run: node test/background-download-decision-invalidation.test.mjs

import { extractFunction, compile, BACKGROUND } from "./_extract.mjs";
import fs from "node:fs";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function makeFakeChrome({ pauseError, lastErrorOnResumeCancel } = {}) {
  const calls = { paused: [], resumed: [], cancelled: [] };
  let currentLastError = null;
  const chrome = {
    downloads: {
      pause: (id, cb) => {
        calls.paused.push(id);
        currentLastError = pauseError ? { message: String(pauseError.message || pauseError) } : null;
        cb();
      },
      resume: (id, cb) => {
        calls.resumed.push(id);
        currentLastError = lastErrorOnResumeCancel ? { message: String(lastErrorOnResumeCancel) } : null;
        cb();
      },
      cancel: (id, cb) => {
        calls.cancelled.push(id);
        currentLastError = lastErrorOnResumeCancel ? { message: String(lastErrorOnResumeCancel) } : null;
        cb();
      }
    },
    runtime: {
      get lastError() {
        return currentLastError;
      }
    }
  };
  return { chrome, calls };
}

console.log("== handleDownloadCreated(): the pending entry and the broadcast envelope both carry the active run's runId ==");
{
  const source = [
    extractFunction("isAgentRunActive"),
    extractFunction("mostRecentActiveRun"),
    extractFunction("broadcastToAgentPorts"),
    extractFunction("reportDownloadNotice"),
    extractFunction("handleDownloadCreated")
  ].join("\n\n");
  const { chrome } = makeFakeChrome({});
  const activeAgentRuns = new Map([["run1", "conv1"]]);
  const pendingDownloadDecisions = new Map();
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const handleDownloadCreated = compile(source, { chrome, activeAgentRuns, pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadCreated");
  handleDownloadCreated({ id: 42, state: "in_progress", filename: "invoice.pdf", url: "https://evil.example/invoice.pdf" });

  const [requestId, pending] = [...pendingDownloadDecisions.entries()][0];
  ok(pending.runId === "run1" && pending.conversationId === "conv1", "the pending entry records which run/conversation was active when the download was paused");
  ok(posted[0].envelope.runId === "run1", "the broadcast download_protected_decision envelope also carries the runId, so the panel can correlate it against a later run-teardown event");
  void requestId;
}

console.log("\n== invalidateDownloadDecisionsForRun(): deletes only this run's entries, never resumes/cancels, and tells connected panels ==");
{
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const pendingDownloadDecisions = new Map([
    ["req_a", { downloadId: 1, runId: "run_a", conversationId: "conv_a", filename: "a.zip", url: "https://x/a.zip" }],
    ["req_b", { downloadId: 2, runId: "run_b", conversationId: "conv_b", filename: "b.zip", url: "https://x/b.zip" }]
  ]);
  const { chrome, calls } = makeFakeChrome({});
  const invalidateDownloadDecisionsForRun = compile(
    [extractFunction("broadcastToAgentPorts"), extractFunction("invalidateDownloadDecisionsForRun")].join("\n\n"),
    { pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 },
    "invalidateDownloadDecisionsForRun"
  );
  invalidateDownloadDecisionsForRun("run_a", "run run_stopped");

  ok(!pendingDownloadDecisions.has("req_a"), "the invalidated run's entry is deleted");
  ok(pendingDownloadDecisions.has("req_b"), "an unrelated run's entry is left untouched");
  ok(posted.length === 1 && posted[0].envelope.type === "download_decision_invalidated", "a download_decision_invalidated envelope is broadcast for the invalidated entry");
  ok(posted[0].envelope.requestId === "req_a" && posted[0].envelope.conversationId === "conv_a", "the envelope names the exact requestId/conversationId invalidated");
  ok(posted[0].envelope.reason === "run run_stopped", "the reason is carried through for diagnosability");
  ok(calls.paused.length === 0 && calls.resumed.length === 0 && calls.cancelled.length === 0, "invalidation never calls pause/resume/cancel — the underlying download is left exactly as paused as it already was");
}

console.log("\n== invalidateAllDownloadDecisions(): deletes every pending entry regardless of runId (the mode-change trigger) ==");
{
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const pendingDownloadDecisions = new Map([
    ["req_a", { downloadId: 1, runId: "run_a", conversationId: "conv_a", filename: "a.zip", url: "https://x/a.zip" }],
    ["req_b", { downloadId: 2, runId: "run_b", conversationId: "conv_b", filename: "b.zip", url: "https://x/b.zip" }]
  ]);
  const invalidateAllDownloadDecisions = compile(
    [extractFunction("broadcastToAgentPorts"), extractFunction("invalidateAllDownloadDecisions")].join("\n\n"),
    { pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 },
    "invalidateAllDownloadDecisions"
  );
  invalidateAllDownloadDecisions("the permission mode changed; this decision was invalidated");

  ok(pendingDownloadDecisions.size === 0, "every pending entry is deleted, regardless of which run it belonged to");
  ok(posted.length === 2, "a download_decision_invalidated envelope is broadcast for each");
  ok(posted.every((m) => m.envelope.type === "download_decision_invalidated"), "every broadcast is the invalidation type");
  ok(posted.every((m) => m.envelope.reason === "the permission mode changed; this decision was invalidated"), "the reason is carried through on every entry");
}

console.log("\n== the actual bug this fix closes: a late Allow for an INVALIDATED decision is a no-op, never resumes ==");
{
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const pendingDownloadDecisions = new Map([["req_late", { downloadId: 99, runId: "run_late", conversationId: "conv_late", filename: "late.zip", url: "https://x/late.zip" }]]);
  const invalidateDownloadDecisionsForRun = compile(
    [extractFunction("broadcastToAgentPorts"), extractFunction("invalidateDownloadDecisionsForRun")].join("\n\n"),
    { pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 },
    "invalidateDownloadDecisionsForRun"
  );
  // The run ends (Stop, or the turn finishing) WHILE the card is still outstanding.
  invalidateDownloadDecisionsForRun("run_late", "run run_stopped");
  ok(!pendingDownloadDecisions.has("req_late"), "sanity: the decision is gone from the map after invalidation");

  // The user walks away and clicks Allow much later.
  const { chrome, calls } = makeFakeChrome({});
  const handleDownloadDecision = compile(extractFunction("handleDownloadDecision"), { chrome, pendingDownloadDecisions, nativePort: null }, "handleDownloadDecision");
  handleDownloadDecision({ requestId: "req_late", decision: "allow" });
  ok(calls.resumed.length === 0 && calls.cancelled.length === 0, "a late Allow for an invalidated requestId never resumes (or cancels) the download — this is the exact failure the fix closes");
}

console.log("\n== handleDownloadDecision(): reports the outcome to the native host as a fire-and-forget durable record ==");
{
  const { chrome, calls } = makeFakeChrome({});
  const pendingDownloadDecisions = new Map([["req1", { downloadId: 5, runId: "run1", conversationId: "conv1", filename: "invoice.pdf", url: "https://x/invoice.pdf" }]]);
  const posted = [];
  const nativePort = { postMessage: (m) => posted.push(m) };
  const handleDownloadDecision = compile(extractFunction("handleDownloadDecision"), { chrome, pendingDownloadDecisions, nativePort, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadDecision");
  handleDownloadDecision({ requestId: "req1", decision: "allow" });

  ok(calls.resumed[0] === 5, "the download is still resumed exactly as before this fix");
  ok(posted.length === 1 && posted[0].type === "agent_msg" && posted[0].envelope.type === "download_decision_recorded", "a durable-record envelope is sent to the native host");
  ok(posted[0].envelope.conversationId === "conv1" && posted[0].envelope.requestId === "req1", "it names the exact conversation/requestId this decision belongs to");
  ok(posted[0].envelope.decision === "allow" && posted[0].envelope.filename === "invoice.pdf", "it carries the actual decision and filename");
}
{
  // No native connection: the resume/cancel above must still happen; only
  // the durable record is missed (the same honesty rule this file already
  // follows elsewhere — never claim a fact was recorded that was not).
  const { chrome, calls } = makeFakeChrome({});
  const pendingDownloadDecisions = new Map([["req2", { downloadId: 6, runId: "run1", conversationId: "conv1", filename: "x.pdf", url: "https://x/x.pdf" }]]);
  const handleDownloadDecision = compile(extractFunction("handleDownloadDecision"), { chrome, pendingDownloadDecisions, nativePort: null, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadDecision");
  handleDownloadDecision({ requestId: "req2", decision: "deny" });
  ok(calls.cancelled[0] === 6, "the download is still cancelled even with no native connection to report the record to");
}
{
  // No conversationId ever attributed (no run was active when the download
  // was paused): nothing to record against, so nothing is sent — never a
  // record with a fabricated/null conversationId.
  const { chrome, calls } = makeFakeChrome({});
  const pendingDownloadDecisions = new Map([["req3", { downloadId: 7, runId: null, conversationId: null, filename: "y.pdf", url: "https://x/y.pdf" }]]);
  const posted = [];
  const nativePort = { postMessage: (m) => posted.push(m) };
  const handleDownloadDecision = compile(extractFunction("handleDownloadDecision"), { chrome, pendingDownloadDecisions, nativePort, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadDecision");
  handleDownloadDecision({ requestId: "req3", decision: "allow" });
  ok(calls.resumed[0] === 7, "the resume still happens");
  ok(posted.length === 0, "no durable-record message is sent when there is no conversationId to attribute it to");
}

console.log("\n== handleAgentMessage(): the existing run-teardown hook now also invalidates that run's download decisions ==");
{
  const invalidateCalls = [];
  const agentPorts = new Set();
  const relayed = [];
  agentPorts.add({ postMessage: (m) => relayed.push(m) });
  const agentSettingsRelay = { handleReply: () => false };
  const deps = {
    agentSettingsRelay,
    agentPorts,
    pendingAttachmentAcks: new Map(),
    dbg: () => {},
    teardownOverlayForRun: () => {},
    startOverlayForRun: () => Promise.resolve(),
    forwardApprovalToOverlay: () => {},
    forwardRiskUpdateToOverlay: () => {},
    activeAgentRuns: new Map([
      ["run_x", "conv_x"],
      ["run_y", "conv_y"],
      ["run_z", "conv_z"],
      ["run_w", "conv_w"]
    ]),
    invalidateDownloadDecisionsForRun: (runId, reason) => invalidateCalls.push({ runId, reason }),
    OVERLAY_TEARDOWN_RUN_EVENTS: new Set(["run_stopped", "run_error", "run_interrupted_by_restart", "run_done"])
  };
  const src = "let agentHandshakeState = \"pending\";\nlet agentHandshakeDetail = null;\n" + extractFunction("handleAgentMessage");
  const handleAgentMessage = compile(src, deps, "handleAgentMessage");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_x", event: { type: "run_stopped", reason: "user_stop" } });
  ok(invalidateCalls.length === 1 && invalidateCalls[0].runId === "run_x", "run_stopped invalidates that run's download decisions");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_y", event: { type: "run_done" } });
  ok(invalidateCalls.length === 2 && invalidateCalls[1].runId === "run_y", "run_done also invalidates");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_z", event: { type: "run_error" } });
  ok(invalidateCalls.length === 3 && invalidateCalls[2].runId === "run_z", "run_error also invalidates");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_w", event: { type: "run_interrupted_by_restart" } });
  ok(invalidateCalls.length === 4 && invalidateCalls[3].runId === "run_w", "run_interrupted_by_restart also invalidates");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_new", event: { type: "run_started", tabScope: "any" } });
  ok(invalidateCalls.length === 4, "an UNRELATED lifecycle event (run_started) never invalidates anything");

  ok(relayed.length === 5, "every envelope is still relayed verbatim to agentPorts, exactly as before this fix");
}

console.log("\n== structural: the ocic-agent port listener handles download_decisions_invalidate LOCALLY, exactly like download_decision ==");
{
  const src = fs.readFileSync(BACKGROUND, "utf8");
  const listenerStart = src.indexOf('port.onMessage.addListener((msg) => {');
  const nativeSendIdx = src.indexOf("nativePort.postMessage({ ...msg, id });", listenerStart);
  const invalidateCheckIdx = src.indexOf('msg.envelope.type === "download_decisions_invalidate"', listenerStart);
  const downloadCheckIdx = src.indexOf('msg.envelope.type === "download_decision"', listenerStart);
  ok(invalidateCheckIdx > listenerStart, "the port listener checks for download_decisions_invalidate");
  ok(downloadCheckIdx > listenerStart && invalidateCheckIdx > downloadCheckIdx, "the check sits alongside (after) the existing download_decision interception");
  ok(nativeSendIdx > invalidateCheckIdx, "the LOCAL interception happens BEFORE the generic path that would otherwise forward the message to nativePort");
  ok(src.includes("invalidateAllDownloadDecisions(msg.envelope.reason)"), "it calls invalidateAllDownloadDecisions with the caller's reason");
}

console.log(fail === 0 ? "\nAll assertions passed." : `\n${fail} assertion(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);

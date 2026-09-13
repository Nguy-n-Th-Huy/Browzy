#!/usr/bin/env node
// extension/background.js's managed-policy relay (group 4's extension half:
// "the extension owns pushing managed_policy_snapshot on connect and on
// every chrome.storage.onChanged for the managed area") and its download
// protection gate (task 2.4). Extracted from the SHIPPED background.js
// source (test/_extract.mjs's brace-matching technique) so this exercises
// the real code, not a copy that can drift.
//
// Run: node test/background-managed-policy-and-downloads.test.mjs

import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function makeFakeChrome({ managedResult, managedError, pauseError, lastErrorOnResumeCancel } = {}) {
  const calls = { paused: [], resumed: [], cancelled: [] };
  return {
    chrome: {
      storage: {
        managed: {
          get: async (_keys) => {
            if (managedError) throw managedError;
            return managedResult === undefined ? {} : managedResult;
          }
        }
      },
      downloads: {
        pause: (id, cb) => {
          calls.paused.push(id);
          if (pauseError) chrome_runtime_lastError_set(pauseError);
          else chrome_runtime_lastError_set(null);
          cb();
        },
        resume: (id, cb) => {
          calls.resumed.push(id);
          chrome_runtime_lastError_set(lastErrorOnResumeCancel || null);
          cb();
        },
        cancel: (id, cb) => {
          calls.cancelled.push(id);
          chrome_runtime_lastError_set(lastErrorOnResumeCancel || null);
          cb();
        }
      },
      runtime: {
        get lastError() {
          return currentLastError;
        }
      }
    },
    calls
  };
  function chrome_runtime_lastError_set(v) {
    currentLastError = v ? { message: String(v.message || v) } : null;
  }
}
let currentLastError = null;

console.log("== readManagedPolicyForPush() ==");
{
  const source = extractFunction("readManagedPolicyForPush");
  const readManagedPolicyForPush = compile(source, { chrome: makeFakeChrome({ managedResult: {} }).chrome }, "readManagedPolicyForPush");
  const result = await readManagedPolicyForPush();
  ok(result.policy === null && !result.readError, "an empty chrome.storage.managed result is reported as an absent policy, not an empty-but-present one");
}
{
  const source = extractFunction("readManagedPolicyForPush");
  const policy = { mode: "manual", sites: [] };
  const readManagedPolicyForPush = compile(source, { chrome: makeFakeChrome({ managedResult: policy }).chrome }, "readManagedPolicyForPush");
  const result = await readManagedPolicyForPush();
  ok(result.policy === policy && !result.readError, "a non-empty managed result is passed through verbatim as the policy");
}
{
  const source = extractFunction("readManagedPolicyForPush");
  const readManagedPolicyForPush = compile(
    source,
    { chrome: makeFakeChrome({ managedError: new Error("managed storage schema not found") }).chrome },
    "readManagedPolicyForPush"
  );
  const result = await readManagedPolicyForPush();
  ok(result.policy === null && typeof result.readError === "string" && result.readError.length > 0, "a thrown read is reported as readError, never silently treated as absent");
}

console.log("== pushManagedPolicySnapshot() gating and envelope shape ==");
{
  const source = [extractFunction("readManagedPolicyForPush"), extractFunction("pushManagedPolicySnapshot")].join("\n\n");
  const posted = [];
  const pushManagedPolicySnapshot = compile(
    source,
    {
      chrome: makeFakeChrome({ managedResult: { mode: "skip" } }).chrome,
      nativePort: null,
      agentHandshakeState: "ok",
      AGENT_PROTOCOL_VERSION: 1
    },
    "pushManagedPolicySnapshot"
  );
  await pushManagedPolicySnapshot();
  ok(posted.length === 0, "never attempts a push with no native connection");
}
{
  const source = [extractFunction("readManagedPolicyForPush"), extractFunction("pushManagedPolicySnapshot")].join("\n\n");
  const posted = [];
  const fakePort = { postMessage: (m) => posted.push(m) };
  const pushManagedPolicySnapshot = compile(
    source,
    {
      chrome: makeFakeChrome({ managedResult: { mode: "skip" } }).chrome,
      nativePort: fakePort,
      agentHandshakeState: "pending",
      AGENT_PROTOCOL_VERSION: 1
    },
    "pushManagedPolicySnapshot"
  );
  await pushManagedPolicySnapshot();
  ok(posted.length === 0, "never pushes before the hello handshake has completed (gated behind a completed hello)");
}
{
  const source = [extractFunction("readManagedPolicyForPush"), extractFunction("pushManagedPolicySnapshot")].join("\n\n");
  const posted = [];
  const fakePort = { postMessage: (m) => posted.push(m) };
  const pushManagedPolicySnapshot = compile(
    source,
    {
      chrome: makeFakeChrome({ managedResult: { mode: "skip" } }).chrome,
      nativePort: fakePort,
      agentHandshakeState: "ok",
      AGENT_PROTOCOL_VERSION: 1
    },
    "pushManagedPolicySnapshot"
  );
  await pushManagedPolicySnapshot();
  ok(posted.length === 1, "pushes exactly once when connected and handshaken");
  const msg = posted[0];
  ok(msg.type === "agent_msg" && msg.envelope.type === "managed_policy_snapshot", "wrapped exactly like every other agent envelope, own top-level type");
  ok(msg.envelope.v === 1, "carries the protocol version");
  ok(JSON.stringify(msg.envelope.policy) === JSON.stringify({ mode: "skip" }), "carries the policy verbatim");
  ok(!("readError" in msg.envelope), "no readError field on a clean read");
}
{
  const source = [extractFunction("readManagedPolicyForPush"), extractFunction("pushManagedPolicySnapshot")].join("\n\n");
  const posted = [];
  const fakePort = { postMessage: (m) => posted.push(m) };
  const pushManagedPolicySnapshot = compile(
    source,
    {
      chrome: makeFakeChrome({ managedError: new Error("boom") }).chrome,
      nativePort: fakePort,
      agentHandshakeState: "ok",
      AGENT_PROTOCOL_VERSION: 1
    },
    "pushManagedPolicySnapshot"
  );
  await pushManagedPolicySnapshot();
  ok(posted[0].envelope.policy === null && typeof posted[0].envelope.readError === "string", "an unreadable managed store still pushes, with policy:null and a readError string");
}

console.log("== download gate: isAgentRunActive / mostRecentActiveRun ==");
{
  const source = [extractFunction("isAgentRunActive"), extractFunction("mostRecentActiveRun")].join("\n\n");
  const activeAgentRuns = new Map();
  const isAgentRunActive = compile(source, { activeAgentRuns }, "isAgentRunActive");
  ok(isAgentRunActive() === false, "no active runs when the map is empty");
  activeAgentRuns.set("run1", "conv1");
  activeAgentRuns.set("run2", "conv2");
  const mostRecentActiveRun = compile(source, { activeAgentRuns }, "mostRecentActiveRun");
  ok(isAgentRunActive() === true, "active once a run is tracked");
  const [runId, conversationId] = mostRecentActiveRun();
  ok(runId === "run2" && conversationId === "conv2", "the most recently inserted run is treated as the one to attribute a gated download to");
}

console.log("== handleDownloadCreated(): a user's own download is never gated ==");
{
  const source = [
    extractFunction("isAgentRunActive"),
    extractFunction("mostRecentActiveRun"),
    extractFunction("broadcastToAgentPorts"),
    extractFunction("reportDownloadNotice"),
    extractFunction("handleDownloadCreated")
  ].join("\n\n");
  const { chrome, calls } = makeFakeChrome({});
  const activeAgentRuns = new Map();
  const pendingDownloadDecisions = new Map();
  const agentPorts = new Set();
  const handleDownloadCreated = compile(source, { chrome, activeAgentRuns, pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadCreated");
  handleDownloadCreated({ id: 1, state: "in_progress", filename: "a.zip", url: "https://x/a.zip" });
  ok(calls.paused.length === 0, "no run active: pause() is never called, a manual download proceeds untouched");
  ok(pendingDownloadDecisions.size === 0, "no pending decision is created either");
}

console.log("== handleDownloadCreated(): an agent-caused download is paused and a decision is raised ==");
{
  const source = [
    extractFunction("isAgentRunActive"),
    extractFunction("mostRecentActiveRun"),
    extractFunction("broadcastToAgentPorts"),
    extractFunction("reportDownloadNotice"),
    extractFunction("handleDownloadCreated")
  ].join("\n\n");
  const { chrome, calls } = makeFakeChrome({});
  const activeAgentRuns = new Map([["run1", "conv1"]]);
  const pendingDownloadDecisions = new Map();
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const handleDownloadCreated = compile(source, { chrome, activeAgentRuns, pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadCreated");
  handleDownloadCreated({ id: 42, state: "in_progress", filename: "invoice.pdf", url: "https://evil.example/invoice.pdf" });
  ok(calls.paused[0] === 42, "the download is paused immediately");
  ok(pendingDownloadDecisions.size === 1, "a pending decision is tracked, keyed by a fresh requestId");
  ok(posted.length === 1 && posted[0].envelope.type === "download_protected_decision", "a LOCAL download_protected_decision envelope is broadcast to connected panels");
  const env = posted[0].envelope;
  ok(env.category === "download" && env.rememberable === false, "always the download protected category, never rememberable");
  ok(env.conversationId === "conv1", "attributed to the currently active run's conversation");
  ok(env.filename === "invoice.pdf" && env.url === "https://evil.example/invoice.pdf", "carries the download's own filename/url for display");
  ok(typeof env.requestId === "string" && env.requestId.length > 0, "carries a requestId for the panel's reply to correlate against");
}

console.log("== handleDownloadCreated(): a download that finished before it could be paused is reported, not blocked ==");
{
  const source = [
    extractFunction("isAgentRunActive"),
    extractFunction("mostRecentActiveRun"),
    extractFunction("broadcastToAgentPorts"),
    extractFunction("reportDownloadNotice"),
    extractFunction("handleDownloadCreated")
  ].join("\n\n");
  const { chrome, calls } = makeFakeChrome({});
  const activeAgentRuns = new Map([["run1", "conv1"]]);
  const pendingDownloadDecisions = new Map();
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const handleDownloadCreated = compile(source, { chrome, activeAgentRuns, pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadCreated");
  handleDownloadCreated({ id: 7, state: "complete", filename: "fast.txt", url: "https://x/fast.txt" });
  ok(calls.paused.length === 0, "an already-complete download is never paused");
  ok(pendingDownloadDecisions.size === 0, "no decision is raised for it — there is nothing left to decide");
  ok(posted.length === 1 && posted[0].envelope.type === "download_notice", "an honest download_notice is reported instead");
  ok(posted[0].envelope.outcome === "completed_before_pause", "the outcome says it completed before it could be paused, never pretending it was gated");
}

console.log("== handleDownloadCreated(): pause() itself reports lastError (download finished mid-call) ==");
{
  const source = [
    extractFunction("isAgentRunActive"),
    extractFunction("mostRecentActiveRun"),
    extractFunction("broadcastToAgentPorts"),
    extractFunction("reportDownloadNotice"),
    extractFunction("handleDownloadCreated")
  ].join("\n\n");
  const { chrome } = makeFakeChrome({ pauseError: { message: "download already complete" } });
  const activeAgentRuns = new Map([["run1", "conv1"]]);
  const pendingDownloadDecisions = new Map();
  const posted = [];
  const agentPorts = new Set([{ postMessage: (m) => posted.push(m) }]);
  const handleDownloadCreated = compile(source, { chrome, activeAgentRuns, pendingDownloadDecisions, agentPorts, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadCreated");
  handleDownloadCreated({ id: 9, state: "in_progress", filename: "race.bin", url: "https://x/race.bin" });
  ok(pendingDownloadDecisions.size === 0, "no decision is raised when pause() itself failed");
  ok(posted.length === 1 && posted[0].envelope.type === "download_notice", "reported honestly instead");
}

console.log("== handleDownloadDecision(): allow resumes, deny cancels, unknown requestId is a no-op ==");
// `nativePort`/`AGENT_PROTOCOL_VERSION` are required deps as of the CRITICAL
// invalidation/durable-record fix (test/background-download-decision-
// invalidation.test.mjs owns proving THAT behavior in detail) — `nativePort:
// null` here keeps this suite scoped to the pre-existing resume/cancel/no-op
// contract, which must stay unaffected by that fix.
{
  const source = extractFunction("handleDownloadDecision");
  {
    const { chrome, calls } = makeFakeChrome({});
    const pendingDownloadDecisions = new Map([["req1", { downloadId: 5 }]]);
    const handleDownloadDecision = compile(source, { chrome, pendingDownloadDecisions, nativePort: null, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadDecision");
    handleDownloadDecision({ requestId: "req1", decision: "allow" });
    ok(calls.resumed[0] === 5 && calls.cancelled.length === 0, "an allow decision resumes the paused download");
    ok(pendingDownloadDecisions.size === 0, "the pending entry is consumed, never reusable for a second reply");
  }
  {
    const { chrome, calls } = makeFakeChrome({});
    const pendingDownloadDecisions = new Map([["req2", { downloadId: 6 }]]);
    const handleDownloadDecision = compile(source, { chrome, pendingDownloadDecisions, nativePort: null, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadDecision");
    handleDownloadDecision({ requestId: "req2", decision: "deny" });
    ok(calls.cancelled[0] === 6 && calls.resumed.length === 0, "a deny decision cancels the paused download");
  }
  {
    const { chrome, calls } = makeFakeChrome({});
    const pendingDownloadDecisions = new Map();
    const handleDownloadDecision = compile(source, { chrome, pendingDownloadDecisions, nativePort: null, AGENT_PROTOCOL_VERSION: 1 }, "handleDownloadDecision");
    handleDownloadDecision({ requestId: "unknown", decision: "allow" });
    ok(calls.resumed.length === 0 && calls.cancelled.length === 0, "an unknown/already-settled requestId never resumes or cancels anything");
  }
}

console.log(fail === 0 ? "\nAll assertions passed." : `\n${fail} assertion(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);

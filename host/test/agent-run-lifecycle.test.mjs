#!/usr/bin/env node
//
// Run lifecycle: stop blocks dispatch, lost responses are reported as
// "result unknown" and never auto-replayed, approval tokens bind to exact
// action/target/run and expire, and queued runs cannot cross scopes.
//
// Run: node host/test/agent-run-lifecycle.test.mjs

import { Run, RUN_STATES } from "../agent/session/run.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { authorizeToolCall, AuthorizationError, RunUploadAllowlist } from "../agent/policy/authorization.js";
import { ToolBridge, isResultUnknown } from "../agent/broker/tool-bridge.js";
import { TokenBatcher } from "../agent/session/token-batcher.js";
import { HOST_DROPPED_ERROR, NO_BRIDGE_ERROR } from "../tool-runtime.js";

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

const KNOWN = new Set(["navigate", "computer", "get_config", "file_upload", "upload_image"]);

console.log("\nRun lifecycle\n");

await test("stop blocks subsequent dispatch (authorizeToolCall rejects a stopped run)", async () => {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const events = [];
  const run = new Run({ conversationId: "c1", lease, approvals, onEvent: (e) => events.push(e) });
  await run.begin();
  assert(run.state === RUN_STATES.RUNNING, "run should be running once granted the lease");

  run.stop("user_stop");
  assert(run.state === RUN_STATES.STOPPED, "run should be stopped");

  let rejected = false;
  try {
    authorizeToolCall({
      toolName: "navigate",
      args: { tabId: 1 },
      runState: run.state,
      leaseHeldByThisRun: run.leaseHeldByThisRun(),
      tabScope: run.tabScope,
      knownToolNames: KNOWN
    });
  } catch (err) {
    rejected = err instanceof AuthorizationError && err.reason === "run_not_active";
  }
  assert(rejected, "a call after stop must be rejected with run_not_active");
  assert(events.some((e) => e.type === "run_stopped"), "a run_stopped event should be recorded");
});

await test("stop invalidates the lease so a second run is not blocked by a ghost holder", async () => {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run1 = new Run({ conversationId: "c1", lease, approvals });
  await run1.begin();
  run1.stop();
  const run2 = new Run({ conversationId: "c2", lease, approvals });
  const granted = await run2.begin();
  assert(granted, "a second run should acquire the lease promptly after the first stops");
  run2.markDone();
});

await test("a run stopped while still queued never actually starts", async () => {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const holder = new Run({ conversationId: "c0", lease, approvals });
  await holder.begin();

  const queued = new Run({ conversationId: "c1", lease, approvals });
  const beginPromise = queued.begin();
  queued.stop("cancelled_while_queued");
  holder.markDone(); // free the lease so begin() can resolve
  const granted = await beginPromise;
  assert(granted === false, "a run stopped while queued must report it never actually started");
  assert(queued.state === RUN_STATES.STOPPED, "state must remain stopped, not flip to running");
});

await test("lost response after dispatch is reported as result-unknown, and is NEVER auto-replayed", async () => {
  let dispatchCount = 0;
  const fakeCallTool = async () => {
    dispatchCount++;
    // Mirrors host/tool-runtime.js's real callTool(): a dropped connection
    // after dispatch collapses to a text content block containing the exact
    // HOST_DROPPED_ERROR wording, never a thrown exception.
    return { content: [{ type: "text", text: `Error: ${HOST_DROPPED_ERROR}` }] };
  };
  const bridge = new ToolBridge({ init: async () => {}, callTool: fakeCallTool, shutdown: () => {} });

  const { result, resultUnknown } = await bridge.call("navigate", { url: "https://example.com" }, { runId: "r1" });
  assert(resultUnknown === true, "a dropped-after-dispatch result must be flagged resultUnknown");
  assert(result.content[0].text.includes("result is unknown"), "the surfaced text must say the result is unknown");
  assert(dispatchCount === 1, "the bridge itself must never retry a dispatched call automatically");
});

await test("a call that never reached the extension (NO_BRIDGE_ERROR) is NOT flagged result-unknown", async () => {
  const fakeCallTool = async () => ({ content: [{ type: "text", text: `Error: ${NO_BRIDGE_ERROR}` }] });
  const bridge = new ToolBridge({ init: async () => {}, callTool: fakeCallTool, shutdown: () => {} });
  const { resultUnknown } = await bridge.call("navigate", {}, { runId: "r1" });
  assert(resultUnknown === false, "a call that never dispatched at all is a known failure, not an unknown outcome");
});

await test("Run.recordResultUnknown surfaces the unknown outcome on the run itself (no silent success)", async () => {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const events = [];
  const run = new Run({ conversationId: "c1", lease, approvals, onEvent: (e) => events.push(e) });
  await run.begin();
  run.recordResultUnknown("navigate", {}, { requestId: "req_1" });
  assert(run.unknownResults().length === 1, "the run should track its own unknown-result actions");
  assert(events.some((e) => e.type === "tool_result_unknown"), "an event should be emitted for the transcript/UI");
});

await test("isResultUnknown is a precise text match, not a loose substring guess", () => {
  assert(isResultUnknown(`Error: ${HOST_DROPPED_ERROR}`));
  assert(!isResultUnknown("Error: something unrelated failed"));
  assert(!isResultUnknown(undefined));
});

// --- Approval token binding/expiry ---------------------------------------

await test("an approval token binds to the exact run/action/target and rejects any deviation", () => {
  const approvals = new ApprovalRegistry();
  const token = approvals.issue({ runId: "r1", action: "file_upload", target: { tabId: 5, ref: "ref_1" } });

  assert(!approvals.consume(token, { runId: "r2", action: "file_upload", target: { tabId: 5, ref: "ref_1" } }).ok, "a different run must not reuse this token");
  assert(!approvals.consume(token, { runId: "r1", action: "navigate", target: { tabId: 5, ref: "ref_1" } }).ok, "a different action must not reuse this token");
  assert(!approvals.consume(token, { runId: "r1", action: "file_upload", target: { tabId: 6, ref: "ref_1" } }).ok, "a different target must not reuse this token");

  const ok = approvals.consume(token, { runId: "r1", action: "file_upload", target: { tabId: 5, ref: "ref_1" } });
  assert(ok.ok, "the exact matching action/target/run must succeed");
});

await test("an approval token is single-use — it cannot be replayed even within its TTL", () => {
  const approvals = new ApprovalRegistry();
  const target = { tabId: 1 };
  const token = approvals.issue({ runId: "r1", action: "navigate", target });
  const first = approvals.consume(token, { runId: "r1", action: "navigate", target });
  assert(first.ok, "first use should succeed");
  const second = approvals.consume(token, { runId: "r1", action: "navigate", target });
  assert(!second.ok && second.reason === "already_used", "a second use of the same token must be rejected");
});

await test("an approval token expires and cannot be used after its TTL", async () => {
  const approvals = new ApprovalRegistry();
  const token = approvals.issue({ runId: "r1", action: "navigate", target: {}, ttlMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  const result = approvals.consume(token, { runId: "r1", action: "navigate", target: {} });
  assert(!result.ok && result.reason === "expired", "an expired token must be rejected");
});

await test("stop invalidates every outstanding approval for that run", () => {
  const approvals = new ApprovalRegistry();
  const token = approvals.issue({ runId: "r1", action: "navigate", target: {} });
  approvals.invalidateForRun("r1");
  const result = approvals.consume(token, { runId: "r1", action: "navigate", target: {} });
  assert(!result.ok && result.reason === "unknown_token", "stop must invalidate outstanding approvals immediately");
});

await test("a scope change (invalidateAll) clears every run's outstanding approvals", () => {
  const approvals = new ApprovalRegistry();
  const t1 = approvals.issue({ runId: "r1", action: "navigate", target: {} });
  const t2 = approvals.issue({ runId: "r2", action: "navigate", target: {} });
  approvals.invalidateAll();
  assert(!approvals.isValid(t1) && !approvals.isValid(t2), "a scope change must invalidate every outstanding token");
});

// --- Tab scope / upload allowlist enforcement (unconditional, handler-side) ---

await test("a tool call outside the run's tab scope is rejected even if SDK preapproved the tool", () => {
  let rejected = false;
  try {
    authorizeToolCall({
      toolName: "navigate",
      args: { tabId: 999 },
      runState: RUN_STATES.RUNNING,
      leaseHeldByThisRun: true,
      tabScope: [1, 2, 3],
      knownToolNames: KNOWN
    });
  } catch (err) {
    rejected = err instanceof AuthorizationError && err.reason === "tab_out_of_scope";
  }
  assert(rejected, "an out-of-scope tab must be rejected regardless of prior approval");
});

await test("file_upload is rejected unless the exact path was explicitly allowlisted for this run", () => {
  const allowlist = new RunUploadAllowlist();
  allowlist.allow("/home/user/report.pdf");

  let rejected = false;
  try {
    authorizeToolCall({
      toolName: "file_upload",
      args: { paths: ["/etc/passwd"], ref: "ref_1", tabId: 1 },
      runState: RUN_STATES.RUNNING,
      leaseHeldByThisRun: true,
      tabScope: "any",
      uploadAllowlist: allowlist,
      knownToolNames: KNOWN
    });
  } catch (err) {
    rejected = err instanceof AuthorizationError && err.reason === "path_not_allowlisted";
  }
  assert(rejected, "an arbitrary filesystem path must never be usable via file_upload without explicit user selection");

  // The allowlisted path succeeds.
  const ok = authorizeToolCall({
    toolName: "file_upload",
    args: { paths: ["/home/user/report.pdf"], ref: "ref_1", tabId: 1 },
    runState: RUN_STATES.RUNNING,
    leaseHeldByThisRun: true,
    tabScope: "any",
    uploadAllowlist: allowlist,
    knownToolNames: KNOWN
  });
  assert(ok.ok, "an explicitly allowlisted path must be authorized");
});

await test("an unknown tool name is rejected before any dispatch is attempted", () => {
  let rejected = false;
  try {
    authorizeToolCall({
      toolName: "shell_exec_totally_fake",
      args: {},
      runState: RUN_STATES.RUNNING,
      leaseHeldByThisRun: true,
      tabScope: "any",
      knownToolNames: KNOWN
    });
  } catch (err) {
    rejected = err instanceof AuthorizationError && err.reason === "unknown_tool";
  }
  assert(rejected, "an unrecognized tool name must be rejected");
});

await test("a call while the lease is not held by this run is rejected (queued run cannot act)", () => {
  let rejected = false;
  try {
    authorizeToolCall({
      toolName: "get_config",
      args: {},
      runState: RUN_STATES.QUEUED,
      leaseHeldByThisRun: false,
      tabScope: "any",
      knownToolNames: KNOWN
    });
  } catch (err) {
    rejected = err instanceof AuthorizationError && err.reason === "lease_not_held";
  }
  assert(rejected, "a queued run without the lease must never be able to dispatch");
});

// --- Token batching (design.md: "Batch token updates to avoid flooding
// native messaging.") ---

await test("TokenBatcher coalesces many stream_message events into one batch", async () => {
  const sent = [];
  const batcher = new TokenBatcher({ sendImmediate: (p) => sent.push(p), windowMs: 20 });
  for (let i = 0; i < 50; i++) batcher.push({ type: "stream_message", message: { delta: `t${i}` } });
  assert(sent.length === 0, "nothing should be sent before the window elapses");
  await new Promise((r) => setTimeout(r, 40));
  assert(sent.length === 1, `expected exactly one flushed batch, got ${sent.length}`);
  assert(sent[0].type === "token_batch" && sent[0].events.length === 50, "the batch must contain every coalesced event, in order");
  assert(sent[0].events[0].message.delta === "t0" && sent[0].events[49].message.delta === "t49", "order must be preserved");
});

await test("TokenBatcher sends non-batchable events immediately, flushing any pending batch first (ordering preserved)", async () => {
  const sent = [];
  const batcher = new TokenBatcher({ sendImmediate: (p) => sent.push(p), windowMs: 1000 });
  batcher.push({ type: "stream_message", message: "a" });
  batcher.push({ type: "stream_message", message: "b" });
  batcher.push({ type: "run_stopped", reason: "user_stop" }); // not batchable
  assert(sent.length === 2, "the run_stopped event must force an immediate flush of the pending batch, plus itself");
  assert(sent[0].type === "token_batch" && sent[0].events.length === 2, "the two stream_message events must flush first, in order");
  assert(sent[1].type === "run_stopped", "the non-batchable event must be sent immediately after, not delayed");
});

await test("TokenBatcher.dispose flushes whatever is pending (run completion must not strand buffered tokens)", () => {
  const sent = [];
  const batcher = new TokenBatcher({ sendImmediate: (p) => sent.push(p), windowMs: 10_000 });
  batcher.push({ type: "stream_message", message: "final chunk" });
  batcher.dispose();
  assert(sent.length === 1 && sent[0].events.length === 1, "dispose must flush pending tokens instead of dropping them");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

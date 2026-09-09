#!/usr/bin/env node
//
// Finishing a run must hand the SHARED browser bridge back, not just the
// companion-internal lease.
//
// host/agent/broker/browser-lease.js serializes runs inside one companion.
// host/native-host.js keeps a second, cross-process NativeLeaseGuard so
// legacy MCP clients and the companion cannot dispatch over each other. Its
// claim is created by the first runId-bearing tool_request and otherwise
// only clears on a 5-minute TTL or socket close — so with nothing telling it
// a run ended, an operator starting a NEW conversation right after one
// finished was refused for up to five minutes with:
//
//   "Browser is busy: another conversation currently owns the browser lease."
//
// tool-runtime.js's releaseLease() was written for exactly this and had no
// caller anywhere in the tree.
//
// Run: node host/test/agent-native-lease-release.test.mjs

import { BrowserLease } from "../agent/broker/browser-lease.js";
import { NativeLeaseGuard } from "../agent/broker/native-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ ok: false });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function startedRun({ releaseNativeLease, conversationId = "conv_a" } = {}) {
  const run = new Run({
    conversationId,
    lease: new BrowserLease(),
    approvals: new ApprovalRegistry(),
    releaseNativeLease
  });
  await run.begin();
  return run;
}

console.log("\nNative browser-lease release on run end\n");

await test("markDone releases the cross-process lease with this run's id", async () => {
  const released = [];
  const run = await startedRun({ releaseNativeLease: (id) => released.push(id) });
  run.markDone();
  assert(released.length === 1, `expected exactly one release, got ${released.length}`);
  assert(released[0] === run.runId, "must release THIS run's id, not another");
});

await test("stop releases it too — a cancelled run must not hold the bridge", async () => {
  const released = [];
  const run = await startedRun({ releaseNativeLease: (id) => released.push(id) });
  run.stop("user_stop");
  assert(released.includes(run.runId), "stopping a run must hand the bridge back");
});

await test("the next conversation is admitted immediately, not after the TTL", async () => {
  const guard = new NativeLeaseGuard();
  const first = await startedRun({ releaseNativeLease: (id) => guard.release(id) });
  // First run's opening dispatch claims the shared bridge.
  assert(guard.check({ clientId: "c1", runId: first.runId, conversationId: "conv_a" }).allow, "first run must be admitted");
  const blocked = guard.check({ clientId: "c1", runId: "run_other", conversationId: "conv_b" });
  assert(!blocked.allow && blocked.reason === "browser_busy", "a second conversation is correctly excluded while the first holds it");

  first.markDone();

  const after = guard.check({ clientId: "c1", runId: "run_other", conversationId: "conv_b" });
  assert(after.allow, "once the first run finishes, the next conversation must dispatch at once — this is the bug the operator hit");
});

await test("a failing release never breaks run teardown", async () => {
  const run = await startedRun({
    releaseNativeLease: () => {
      throw new Error("pipe is down");
    }
  });
  run.markDone(); // must not throw
  assert(run.state === "done", "the run must still reach done when the courtesy release fails");
});

await test("a Run built without the hook still works (tests, restored runs)", async () => {
  const run = await startedRun({ releaseNativeLease: undefined });
  run.markDone();
  assert(run.state === "done", "the hook is optional");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

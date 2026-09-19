#!/usr/bin/env node
//
// Unit coverage for host/agent/tools/dispatch-checks.js — the unconditional
// host-side checks EVERY browser dispatch passes, extracted from
// host/agent/tools/adapter.js so a second decision engine (the Jev runtime,
// openspec/changes/add-typesafe-jev-provider design.md decision 7) calls the
// exact same gate instead of a copy. The adapter's own suites
// (host/test/agent-tool-adapter.test.mjs,
// host/test/protected-action-gate-hook.test.mjs, ...) remain the
// behavior-preservation proof for the move — they run unmodified; this suite
// covers the module directly, at the seam the Jev runtime calls:
//   1. run-state, lease, tab-scope and unknown-tool rejections;
//   2. the protected-action backstop for a NON-send-class protected call:
//      no artifact refuses and records the rejection, one recorded
//      single-use grant authorizes exactly one dispatch (the backstop SPENDS
//      it), a recorded gate verdict likewise;
//   3. the SAME backstop under sendClassTool=true only PEEKS — the artifact
//      survives to verifyPreDispatchApproval, which is what spends it;
//   4. the send-class pre-dispatch grant: absent ⇒ refuse, present ⇒
//      dispatch once and report `granted`, swapped arguments ⇒ refuse;
//   5. checkBrowserBatchHostSide refusing a whole batch whose item fails;
//   6. single-sourcing: the adapter's re-exported verifyPreDispatchApproval
//      IS this module's function (not a copy that could silently drift).
//
// Runs fully offline: constructed Run/ApprovalRegistry objects, no SDK, no
// browser, no credential. Run: node host/test/dispatch-checks.test.mjs

import {
  runHostSideChecks,
  verifyPreDispatchApproval,
  checkBrowserBatchHostSide
} from "../agent/tools/dispatch-checks.js";
import { verifyPreDispatchApproval as adapterVerify } from "../agent/tools/adapter.js";
import { normalizeApprovalArgs, fingerprintNormalizedArgs, authorizeBorrowedTabMutation } from "../agent/tools/mapping.js";
import { Run } from "../agent/session/run.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fp(toolName, args) {
  return fingerprintNormalizedArgs(normalizeApprovalArgs(toolName, args));
}

function textOf(result) {
  return Array.isArray(result?.content) ? result.content.map((b) => b.text || "").join("\n") : "";
}

// A protected-shaped computer call: typing into a field whose resolved target
// hint says it is a password input (permission-modes.js's credential branch).
const SECRET_FIELD_HINT = { tagName: "input", attributes: { type: "password" } };
const SECRET_TYPE_ARGS = { action: "type", ref: "ref_1", text: "hunter2", tabId: 1, targetHint: SECRET_FIELD_HINT };

/** A begun run holding the shared lease, plus the events it emitted. */
async function makeRun({ tabScope = "any", conversationId = "conv_dispatch_checks" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const events = [];
  const run = new Run({ conversationId, lease, approvals, tabScope, onEvent: (e) => events.push(e) });
  await run.begin();
  return { lease, approvals, run, events };
}

console.log("dispatch-checks (openspec/changes/add-typesafe-jev-provider task 3.2)");

await test("an unknown tool name is rejected before anything else", async () => {
  const { run } = await makeRun();
  const res = runHostSideChecks({ run, legacyToolName: "not_a_tool", args: {}, sendClassTool: false });
  assert(res.ok === false, "unknown tools must not dispatch");
  assert(/unknown_tool/.test(textOf(res.result)), `expected the unknown_tool reason, got: ${textOf(res.result)}`);
});

await test("a stopped run rejects every dispatch (run-state check)", async () => {
  const { run } = await makeRun();
  run.stop();
  const res = runHostSideChecks({ run, legacyToolName: "read_page", args: { tabId: 1 }, sendClassTool: false });
  assert(res.ok === false, "a stopped run must not dispatch");
  assert(/run_not_active/.test(textOf(res.result)), `expected run_not_active, got: ${textOf(res.result)}`);
});

await test("a run that does not hold the lease rejects every dispatch", async () => {
  const { lease, approvals } = await makeRun();
  const other = new Run({ conversationId: "conv_other", lease, approvals });
  // Deliberately NOT begun: its state is queued and it holds no lease.
  const res = runHostSideChecks({ run: other, legacyToolName: "read_page", args: { tabId: 1 }, sendClassTool: false });
  assert(res.ok === false, "a run without the lease must not dispatch");
  assert(/lease_not_held/.test(textOf(res.result)), `expected lease_not_held, got: ${textOf(res.result)}`);
});

await test("tab scope is enforced per dispatch: in-scope passes, out-of-scope refuses", async () => {
  const { run } = await makeRun({ tabScope: [5] });
  const ok = runHostSideChecks({ run, legacyToolName: "read_page", args: { tabId: 5 }, sendClassTool: false });
  assert(ok.ok === true, `an in-scope tab must dispatch, got: ${textOf(ok.result)}`);
  const bad = runHostSideChecks({ run, legacyToolName: "read_page", args: { tabId: 9 }, sendClassTool: false });
  assert(bad.ok === false, "an out-of-scope tab must not dispatch");
  assert(/tab_out_of_scope/.test(textOf(bad.result)), `expected tab_out_of_scope, got: ${textOf(bad.result)}`);
});

await test("protected (non-send) backstop: no artifact refuses and records the rejection", async () => {
  const { run, events } = await makeRun();
  const args = { action: "export", tabId: 1, download: true };
  // gif_creator is not in the automatic action set, so its borrowed-tab
  // read-only default needs the explicit authorization hook first — otherwise
  // the borrowed-tab rule (not the protected backstop) would be the refusal
  // under test here.
  authorizeBorrowedTabMutation(run, 1);
  const refused = runHostSideChecks({ run, legacyToolName: "gif_creator", args, sendClassTool: false });
  assert(refused.ok === false, "a protected call without any decision must not dispatch");
  assert(/protected:file-write/.test(textOf(refused.result)), `expected the protected reason, got: ${textOf(refused.result)}`);
  assert(
    events.some((e) => e.type === "tool_rejected" && e.reason === "protected_requires_decision"),
    "the refusal must be recorded on the run's own event stream"
  );
});

await test("protected (non-send) backstop: a grant authorizes exactly one dispatch — the backstop spends it", async () => {
  const { run } = await makeRun();
  const args = { action: "export", tabId: 1, download: true };
  authorizeBorrowedTabMutation(run, 1);
  run.recordApprovalGrant(fp("gif_creator", args));
  const first = runHostSideChecks({ run, legacyToolName: "gif_creator", args, sendClassTool: false });
  assert(first.ok === true, `a single-use grant must authorize the protected dispatch, got: ${textOf(first.result)}`);
  const replay = runHostSideChecks({ run, legacyToolName: "gif_creator", args, sendClassTool: false });
  assert(replay.ok === false, "the same grant must not authorize a second dispatch");
});

await test("protected (non-send) backstop: a gate verdict authorizes and is spent by the backstop itself", async () => {
  const { run } = await makeRun();
  run.recordGateVerdict(fp("computer", SECRET_TYPE_ARGS), "allow");
  const first = runHostSideChecks({ run, legacyToolName: "computer", args: SECRET_TYPE_ARGS, sendClassTool: false });
  assert(first.ok === true, `a gate verdict must authorize a protected call, got: ${textOf(first.result)}`);
  assert(run.hasGateVerdict(fp("computer", SECRET_TYPE_ARGS)) === false, "the non-send path consumes the verdict it dispatched under");
  const replay = runHostSideChecks({ run, legacyToolName: "computer", args: SECRET_TYPE_ARGS, sendClassTool: false });
  assert(replay.ok === false, "a spent verdict must not authorize a replay");
});

await test("the send-class backstop only PEEKS at the covering artifact; the non-send path spends it", async () => {
  const { run } = await makeRun();
  const key = fp("computer", SECRET_TYPE_ARGS);

  // sendClassTool=true: the protected backstop must leave the artifact for
  // verifyPreDispatchApproval (the check that owns spending on this path).
  run.recordApprovalGrant(key);
  const sendPath = runHostSideChecks({ run, legacyToolName: "computer", args: SECRET_TYPE_ARGS, sendClassTool: true });
  assert(sendPath.ok === true, `a covered protected send-class call must dispatch, got: ${textOf(sendPath.result)}`);
  assert(run.hasApprovalGrant(key) === true, "the send-class backstop must PEEK — never spend the artifact verify owns");

  // sendClassTool=false: nothing later will spend it, so the backstop itself
  // consumes it — one decision, one dispatch.
  const nonSendPath = runHostSideChecks({ run, legacyToolName: "computer", args: SECRET_TYPE_ARGS, sendClassTool: false });
  assert(nonSendPath.ok === true, `the same call on the non-send path must dispatch, got: ${textOf(nonSendPath.result)}`);
  assert(run.hasApprovalGrant(key) === false, "the non-send path spends the artifact it dispatched under");
});

await test("send-class dispatch requires a grant: absent refuses, present dispatches once, swapped args refuse", async () => {
  const { run } = await makeRun();
  const args = { action: "key", text: "Enter", tabId: 1 };
  const noArtifact = runHostSideChecks({ run, legacyToolName: "computer", args, sendClassTool: true });
  assert(noArtifact.ok === false, "a send-class call with no recorded decision must not dispatch");
  assert(
    /no approval grant for these exact arguments/.test(textOf(noArtifact.result)),
    `expected the stale-approval reason, got: ${textOf(noArtifact.result)}`
  );

  run.recordApprovalGrant(fp("computer", args));
  const swapped = verifyPreDispatchApproval({ run, legacyToolName: "computer", args: { action: "key", text: "Enter", tabId: 2 } });
  assert(swapped.ok === false, "arguments swapped after Allow must not dispatch");
  const original = verifyPreDispatchApproval({ run, legacyToolName: "computer", args });
  assert(original.ok === true && original.granted === true, `the original must verify and report granted, got ${JSON.stringify(original)}`);
  const replay = verifyPreDispatchApproval({ run, legacyToolName: "computer", args });
  assert(replay.ok === false, "a second dispatch under the same single-use grant must be refused");
});

await test("a non-send call that needs no decision verifies without any artifact", async () => {
  const { run } = await makeRun();
  const pre = verifyPreDispatchApproval({ run, legacyToolName: "computer", args: { action: "left_click", coordinate: [10, 20], tabId: 1 } });
  assert(pre.ok === true && pre.granted === false, `a plain coordinate click needs no grant, got ${JSON.stringify(pre)}`);
});

await test("checkBrowserBatchHostSide refuses the WHOLE batch when one item is out of scope", async () => {
  const { run } = await makeRun({ tabScope: [5] });
  const clean = checkBrowserBatchHostSide({
    run,
    args: { actions: [{ name: "read_page", input: { tabId: 5 } }] }
  });
  assert(clean.ok === true, `an all-in-scope batch must pass, got: ${textOf(clean.result)}`);
  const bad = checkBrowserBatchHostSide({
    run,
    args: { actions: [{ name: "read_page", input: { tabId: 5 } }, { name: "read_page", input: { tabId: 9 } }] }
  });
  assert(bad.ok === false, "a batch containing a refused item must be refused entirely");
  assert(/item 2 \(read_page\)/.test(textOf(bad.result)), `the refusal must name the offending item, got: ${textOf(bad.result)}`);
});

await test("single-sourcing: adapter.js re-exports THIS module's verifyPreDispatchApproval", () => {
  assert(adapterVerify === verifyPreDispatchApproval, "the adapter's export must be the same function object, never a copy");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.error(`FAILED: ${f.name}\n${f.err}`);
  process.exit(1);
}

#!/usr/bin/env node
//
// Missing coverage closed (add-permission-modes-and-threat-signals
// verification): every existing protected-action test proves the REFUSAL
// side (no grant -> dispatch refused — host/agent/tools/adapter.js's
// protected-action backstop; host/test/protected-action-gate-hook.test.mjs's
// PreToolUse hook forcing "ask"). Nothing proves the SUCCESS path: a
// protected, non-send-class call the user actually Allowed dispatches for
// real once `run.recordApprovalGrant()`/`consumeApprovalGrant()` do their
// job. This is precisely the mechanism an earlier regression broke (a
// bare-allowedTools tool silently denied forever, see
// protected-action-gate-hook.test.mjs's own file header) — it had zero
// permanent coverage for the case where the mechanism works correctly.
//
// This proves, using the REAL registered SDK tool handler
// (host/agent/tools/adapter.js's buildSdkTools(), no SDK/network/credential):
//   1. `gif_creator` export with `download:true` (FILE_WRITE-protected, no
//      target hint needed) — once `run.recordApprovalGrant()` records a
//      grant for its exact normalized-args fingerprint (the panel's Allow),
//      the REAL dispatch succeeds: the tool bridge is actually called and a
//      real, non-error result comes back.
//   2. The SAME grant is single-use: a second call with the IDENTICAL args
//      is refused (replay protection) rather than dispatching a second time
//      off one Allow.
//   3. `form_input` into a resolved credential field (CREDENTIALS-protected,
//      needs a target hint) — the same approve-then-dispatch success path,
//      proving the mechanism generalizes beyond a hintless case.
//   4. Without ever recording a grant, the identical protected call is
//      refused (the sanity control proving the ONLY thing making case 1/3
//      succeed is the recorded grant, not some other relaxation).
//
// Run: node host/test/protected-action-approve-then-dispatch.test.mjs

import { buildSdkTools } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import { normalizeApprovalArgs, fingerprintNormalizedArgs, recordAgentCreatedTab } from "../agent/tools/mapping.js";
import { detectProtectedCategory } from "../agent/policy/permission-modes.js";

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

async function makeRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_protected_approve_dispatch", lease, approvals, tabScope });
  await run.begin();
  const dispatched = [];
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name, args) => {
      dispatched.push({ name, args });
      return { content: [{ type: "text", text: `dispatched:${name}` }] };
    },
    shutdown: () => {}
  });
  return { run, toolBridge, dispatched };
}

console.log("\nProtected action approve-then-dispatch — the success path a decision actually authorizes\n");

await test("gif_creator export+download: an Allow recorded for this exact call lets the REAL dispatch succeed", async () => {
  const { run, toolBridge, dispatched } = await makeRun();
  const args = { action: "export", tabId: 1, download: true };
  assert(detectProtectedCategory("gif_creator", args, null) === "file-write", "sanity: this call must actually classify as FILE_WRITE-protected, or this test proves nothing");
  // Mark tab 1 as agent-created (not borrowed) so the call exercises the
  // protected-action grant machinery under test, not the unrelated
  // borrowed-tab authorization gate.
  recordAgentCreatedTab(run, 1);

  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const gifCreator = sdkTools.find((t) => t.name === "gif_creator");
  assert(gifCreator, "gif_creator must be registered on the SDK server");

  // The panel's Allow: the companion records a single-use grant for this
  // exact normalized-args fingerprint (host/agent/policy/can-use-tool.js's
  // real approve branch does the same thing this line does directly).
  const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs("gif_creator", args));
  run.recordApprovalGrant(fingerprint, { action: "gif_creator", target: { tabId: 1 } });

  const result = await gifCreator.handler(args);
  assert(result.isError !== true, `an approved protected call must actually dispatch — got ${JSON.stringify(result)}`);
  assert(dispatched.length === 1 && dispatched[0].name === "gif_creator", "the REAL tool bridge must have been called, not merely a well-formed reply constructed");
  assert(/dispatched:gif_creator/.test(result.content[0].text), "the dispatched result reaches the caller");
});

await test("that SAME grant is single-use: a second identical call is refused, not dispatched again off one Allow", async () => {
  const { run, toolBridge, dispatched } = await makeRun();
  const args = { action: "export", tabId: 1, download: true };
  recordAgentCreatedTab(run, 1);
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const gifCreator = sdkTools.find((t) => t.name === "gif_creator");

  const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs("gif_creator", args));
  run.recordApprovalGrant(fingerprint, { action: "gif_creator", target: { tabId: 1 } });

  const first = await gifCreator.handler(args);
  assert(first.isError !== true, "sanity: the first call must succeed, or this test proves nothing about replay");

  const second = await gifCreator.handler(args);
  assert(second.isError === true, `a replayed call against an already-consumed single-use grant must be refused — got ${JSON.stringify(second)}`);
  assert(dispatched.length === 1, "the tool bridge must NOT have been called a second time — one Allow authorizes exactly one dispatch");
});

await test("form_input into a resolved credential field: the same approve-then-dispatch success path, with a target hint", async () => {
  const { run, toolBridge, dispatched } = await makeRun();
  const args = { ref: "ref_7", tabId: 1, value: "hunter2" };
  const hint = { tagName: "input", attributes: { type: "password" } };
  assert(detectProtectedCategory("form_input", args, hint) === "credentials", "sanity: this call must actually classify as CREDENTIALS-protected, or this test proves nothing");

  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const formInput = sdkTools.find((t) => t.name === "form_input");
  assert(formInput, "form_input must be registered on the SDK server");

  const fingerprint = fingerprintNormalizedArgs(normalizeApprovalArgs("form_input", args));
  run.recordApprovalGrant(fingerprint, { action: "form_input", target: { tabId: 1, ref: "ref_7" } });

  // form_input's own handler resolves its target hint the same way real
  // production wiring does (companion.js's describe_ref resolver) — the
  // adapter's authorization check reads args.targetHint when present, so it
  // is supplied here directly, matching this suite's own fixture args shape.
  const result = await formInput.handler({ ...args, targetHint: hint });
  assert(result.isError !== true, `an approved credential-field form_input must actually dispatch — got ${JSON.stringify(result)}`);
  assert(dispatched.length === 1 && dispatched[0].name === "form_input", "the REAL tool bridge must have been called");
});

await test("control: the identical protected call is refused with NO grant ever recorded — proving the grant is what made the above succeed", async () => {
  const { run, toolBridge, dispatched } = await makeRun();
  const args = { action: "export", tabId: 1, download: true };
  recordAgentCreatedTab(run, 1);
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const gifCreator = sdkTools.find((t) => t.name === "gif_creator");

  const result = await gifCreator.handler(args);
  assert(result.isError === true, "with no recorded grant, the identical protected call must be refused");
  assert(dispatched.length === 0, "the tool bridge must never be reached without a grant");
  assert(/protected/.test(result.content[0].text), "the refusal reason must identify it as the protected-action backstop");
});

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.name}\n    ${f.err}`);
}
console.log(failed.length === 0 ? "ALL PROTECTED-ACTION APPROVE-THEN-DISPATCH TESTS PASSED" : `${failed.length} FAILED`);
process.exit(failed.length ? 1 : 0);

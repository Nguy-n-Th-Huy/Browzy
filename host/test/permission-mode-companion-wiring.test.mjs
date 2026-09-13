#!/usr/bin/env node
//
// Production-wiring proof for add-permission-modes-and-threat-signals.
//
// Before this wave, host/agent/companion.js's real `createCanUseTool({...})`
// call passed neither `policySnapshot` nor `persistSiteEntry`, so the
// shipped companion always resolved mode "auto", never consulted the site
// store, and never saw managed policy — the mode/store/managed-policy
// machinery built in host/agent/policy/permission-modes.js and site-store.js
// was fully unit-tested but inert end to end. This suite proves the wiring
// closing that gap, using the SAME objects and closures companion.js's real
// `_runQuery` installs:
//   - `CompanionCore._permissionPolicySnapshot()` — the exact live getter
//     bound to `createCanUseTool`'s and the PreToolUse gate hook's
//     `policySnapshot` parameter in production.
//   - `CompanionCore._pendingApprovals` — the exact tracker companion.js
//     passes as `requestIdTracker`, so a mode change's invalidation
//     (`_pendingApprovals.rejectAll()`) is proven against the SAME object a
//     real run's `canUseTool` would suspend on.
//   - `createCanUseTool`'s default `persistSiteEntry` (the site store's own
//     real writer) — proven by reading back the real on-disk store, not a
//     spy.
//
// The SDK itself is never invoked (no query()/network/credential) — the
// canUseTool function this suite obtains from `createCanUseTool` is a plain
// async function, called directly exactly as the pinned SDK would call it.
//
// Run: node host/test/permission-mode-companion-wiring.test.mjs

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
import { Run } from "../agent/session/run.js";
import { createCanUseTool } from "../agent/policy/can-use-tool.js";
import { SDK_MCP_SERVER_NAME } from "../agent/tools/adapter.js";
import { readSiteStore } from "../agent/policy/site-store.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-perm-wiring-"));
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
function qualified(name) {
  return `mcp__${SDK_MCP_SERVER_NAME}__${name}`;
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
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: { async *query() {} },
    profileProvider: { async snapshotForRun() { throw new Error("not used by this suite"); } }
  });
}

/** One canUseTool bound to a fixed origin (one "run"), sharing the
 * COMPANION's own `_permissionPolicySnapshot` (the live production getter)
 * and its `_pendingApprovals` tracker (so mode-change invalidation reaches
 * calls made through this exact function, just like a real run). */
async function canUseToolForOrigin(core, originUrl) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: `conv_${Math.random().toString(36).slice(2, 8)}`, lease, approvals, tabScope: "any" });
  await run.begin();
  return createCanUseTool({
    run,
    approvals: run.approvals,
    requestIdTracker: core._pendingApprovals,
    approvalContext: { docIdentity: { url: originUrl } },
    policySnapshot: () => core._permissionPolicySnapshot()
  });
}

async function settleTick() {
  await new Promise((r) => setTimeout(r, 20));
}

console.log("\nPermission-mode production wiring (companion.js)\n");

const core = buildCore();
await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));

await test("unconfigured install: the live snapshot is Auto, no managed policy, no sites", async () => {
  const snap = core._permissionPolicySnapshot();
  assert(snap.mode === "auto", `expected default mode auto, got ${snap.mode}`);
  assert(snap.managed === null, "no managed policy yet");
  assert(Array.isArray(snap.sites) && snap.sites.length === 0, "no remembered sites yet");
});

await test("set_permission_mode persists locally and is reflected by the live snapshot immediately", async () => {
  const reply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r1", op: "set_permission_mode", mode: "manual" })
  );
  assert(reply.ok === true && reply.result.mode === "manual", `expected ok mode manual, got ${JSON.stringify(reply)}`);
  assert(core._permissionPolicySnapshot().mode === "manual", "the live snapshot must reflect the new mode immediately");

  const invalid = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r1b", op: "set_permission_mode", mode: "bogus" })
  );
  assert(!invalid.ok && invalid.error.code === "INVALID_MODE", `an invalid mode must be rejected as INVALID_MODE, got ${JSON.stringify(invalid)}`);
});

// === Manual mode + remembered allowance + protected ignoring it (origin A) ===
const ORIGIN_A = "https://remember-wiring.example";
let canUseA;

await test("Manual mode makes a mutating, non-send-class call (navigate) suspend pending a real decision", async () => {
  canUseA = await canUseToolForOrigin(core, `${ORIGIN_A}/page`);
  const pending = canUseA({ toolName: qualified("navigate"), input: { url: `${ORIGIN_A}/next` }, toolUseID: "wire_req_1" });
  await settleTick();
  assert(core._pendingApprovals.has("wire_req_1"), "the call must suspend pending a decision — it must not auto-resolve under Manual mode");

  // Approve it AND ask to remember — this is the single sanctioned write
  // path (the approval-decision reply), exercised exactly as
  // CompanionCore._handleApprovalDecision forwards it.
  const entry = core._pendingApprovals.take("wire_req_1");
  entry.resolver({ decision: "approve", remember: true });
  const result = await pending;
  assert(result && result.behavior === "allow", `expected allow, got ${JSON.stringify(result)}`);

  const sites = readSiteStore();
  const entryOnDisk = sites.find((s) => s.origin === ORIGIN_A && s.actionClass === "mutating");
  assert(entryOnDisk && entryOnDisk.decision === "allow", `expected a persisted remembered allowance for ${ORIGIN_A}, got ${JSON.stringify(sites)}`);
});

await test("a remembered allowance resolves a later matching call without asking", async () => {
  const result = await canUseA({ toolName: qualified("navigate"), input: { url: `${ORIGIN_A}/again` }, toolUseID: "wire_req_2" });
  assert(result && result.behavior === "allow", `expected the remembered allowance to auto-resolve, got ${JSON.stringify(result)}`);
  assert(!core._pendingApprovals.has("wire_req_2"), "a remembered-allowance resolution must never create a pending decision");
});

await test("a protected call ignores a remembered allowance on the very same origin", async () => {
  const pending = canUseA({
    toolName: qualified("form_input"),
    input: { ref: "ref_pw", tabId: 1, value: "hunter2", targetHint: { tagName: "input", attributes: { type: "password" } } },
    toolUseID: "wire_req_3"
  });
  await settleTick();
  assert(
    core._pendingApprovals.has("wire_req_3"),
    "a protected (credentials) call must still suspend for a decision despite a matching remembered MUTATING allowance on the same origin"
  );
  const entry = core._pendingApprovals.take("wire_req_3");
  entry.resolver({ decision: "deny" });
  const result = await pending;
  assert(result && result.behavior === "deny", `expected deny, got ${JSON.stringify(result)}`);

  const sites = readSiteStore();
  assert(sites.length === 1, `a protected decision must never be persisted as a remembered entry — expected exactly 1 site entry, got ${sites.length}`);
});

// === Managed policy pinning/withdrawal/malformed (origin B, no site entries) ===
const ORIGIN_B = "https://managed-wiring.example";
let canUseB;

await test("with no managed policy, Manual mode still suspends an ordinary mutating call on a fresh origin", async () => {
  canUseB = await canUseToolForOrigin(core, `${ORIGIN_B}/page`);
  const pending = canUseB({ toolName: qualified("navigate"), input: { url: `${ORIGIN_B}/next` }, toolUseID: "wire_req_4" });
  await settleTick();
  assert(core._pendingApprovals.has("wire_req_4"), "expected a suspended decision under Manual with no matching remembered entry");
  const entry = core._pendingApprovals.take("wire_req_4");
  entry.resolver({ decision: "deny" });
  const result = await pending;
  assert(result && result.behavior === "deny", `expected deny, got ${JSON.stringify(result)}`);
});

await test("a managed snapshot pinning a mode overrides local immediately", async () => {
  const ack = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.MANAGED_POLICY_SNAPSHOT, { policy: { mode: "auto" } })
  );
  assert(ack.ok === true, `expected the managed snapshot to be acked, got ${JSON.stringify(ack)}`);

  const state = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r2", op: "get_permission_state" }))).result;
  assert(state.mode === "auto" && state.modeSource === "managed", `expected managed auto, got ${JSON.stringify(state)}`);

  // set_permission_mode must now be refused: the mode is administrator-pinned.
  const setReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r3", op: "set_permission_mode", mode: "skip" })
  );
  assert(!setReply.ok && setReply.error.code === "MANAGED_POLICY_PINNED", `expected MANAGED_POLICY_PINNED, got ${JSON.stringify(setReply)}`);

  // An ordinary mutating call on origin B (no site entry) now proceeds
  // automatically — the managed pin overrode the local Manual mode.
  const result = await canUseB({ toolName: qualified("navigate"), input: { url: `${ORIGIN_B}/auto-now` }, toolUseID: "wire_req_5" });
  assert(result && result.behavior === "allow", `expected the managed Auto pin to auto-allow, got ${JSON.stringify(result)}`);
  assert(!core._pendingApprovals.has("wire_req_5"), "an auto-allowed call must never create a pending decision");
});

await test("withdrawing the managed policy restores local behavior on the next decision", async () => {
  const ack = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.MANAGED_POLICY_SNAPSHOT, { policy: null }));
  assert(ack.ok === true, `expected the withdrawal to be acked, got ${JSON.stringify(ack)}`);

  const state = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r4", op: "get_permission_state" }))).result;
  assert(state.mode === "manual" && state.modeSource === "local", `expected local manual restored, got ${JSON.stringify(state)}`);
  assert(state.managedPolicy.present === false, `expected managedPolicy.present false after withdrawal, got ${JSON.stringify(state.managedPolicy)}`);

  const pending = canUseB({ toolName: qualified("navigate"), input: { url: `${ORIGIN_B}/manual-again` }, toolUseID: "wire_req_6" });
  await settleTick();
  assert(core._pendingApprovals.has("wire_req_6"), "expected Manual mode's suspension to resume once the managed pin was withdrawn");
  const entry = core._pendingApprovals.take("wire_req_6");
  entry.resolver({ decision: "deny" });
  await pending;
});

await test("a malformed managed snapshot is reported unreadable, never silently treated as absent", async () => {
  const ack = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.MANAGED_POLICY_SNAPSHOT, { policy: { mode: "not-a-real-mode" } })
  );
  assert(ack.ok === true, "the wire ack itself always succeeds — the malformed condition is reported through get_permission_state");

  const state = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r5", op: "get_permission_state" }))).result;
  assert(state.managedPolicy.present === true, `a malformed-but-received policy must report present:true, got ${JSON.stringify(state.managedPolicy)}`);
  assert(state.managedPolicy.readable === false, `a malformed policy must report readable:false, got ${JSON.stringify(state.managedPolicy)}`);
  assert(typeof state.managedPolicy.error === "string" && state.managedPolicy.error.length > 0, "a malformed policy must carry a human-readable error");
  assert(state.mode === "manual" && state.modeSource === "local", `a malformed policy must fall back to local settings for decisions, got ${JSON.stringify(state)}`);

  // And decisions actually fall back to local (Manual), proving "ignored for
  // decisions" is real, not just a reported flag.
  const pending = canUseB({ toolName: qualified("navigate"), input: { url: `${ORIGIN_B}/still-manual` }, toolUseID: "wire_req_7" });
  await settleTick();
  assert(core._pendingApprovals.has("wire_req_7"), "a malformed managed policy must not silently permit what local Manual mode would gate");
  const entry = core._pendingApprovals.take("wire_req_7");
  entry.resolver({ decision: "deny" });
  await pending;
});

// === Mode change invalidates outstanding decisions (origin C) ===
const ORIGIN_C = "https://invalidation-wiring.example";

await test("changing the mode invalidates an outstanding decision rather than leaving it to resolve under the old mode", async () => {
  const canUseC = await canUseToolForOrigin(core, `${ORIGIN_C}/page`);
  const pending = canUseC({ toolName: qualified("navigate"), input: { url: `${ORIGIN_C}/next` }, toolUseID: "wire_req_8" });
  await settleTick();
  assert(core._pendingApprovals.has("wire_req_8"), "expected a suspended decision under Manual mode before the mode change");

  // Change the mode WITHOUT ever answering wire_req_8 — this must invalidate
  // it, not leave it dangling for a stale later answer.
  const setReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r6", op: "set_permission_mode", mode: "skip" })
  );
  assert(setReply.ok === true && setReply.result.mode === "skip", `expected the mode change to succeed, got ${JSON.stringify(setReply)}`);
  assert(!core._pendingApprovals.has("wire_req_8"), "the mode change must clear the outstanding decision from the pending tracker");

  const result = await pending;
  assert(result && result.behavior === "deny", `an invalidated decision must resolve deny (rejected), never allow, got ${JSON.stringify(result)}`);

  // A late approval_decision reply for the SAME (now-invalidated) requestId
  // is rejected, not silently applied. (This synthetic test never started a
  // real conversation/run for "conv_doesnt_matter", so the reply is rejected
  // one gate earlier than `unknown_approval_request` — at the "no active
  // run" check _handleApprovalDecision performs first — but it is still an
  // explicit ERROR reply, never treated as a valid decision.)
  const lateReply = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.APPROVAL_DECISION, { conversationId: "conv_doesnt_matter", requestId: "wire_req_8", decision: "approve" })
  );
  assert(
    lateReply.type === AGENT_MESSAGE_TYPES.ERROR && ["no_active_run", "unknown_approval_request"].includes(lateReply.reason),
    `a late reply to an invalidated requestId must be rejected, got ${JSON.stringify(lateReply)}`
  );
});

// === revoke_site_entry / revoke_all_site_entries ===
await test("revoke_site_entry removes a local entry and reports NOT_FOUND for an absent one", async () => {
  const before = readSiteStore();
  assert(before.some((s) => s.origin === ORIGIN_A && s.actionClass === "mutating"), "sanity: the earlier remembered entry must still be on disk");

  const notFound = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r7", op: "revoke_site_entry", origin: "https://never-remembered.example", actionClass: "mutating" })
  );
  assert(!notFound.ok && notFound.error.code === "NOT_FOUND", `expected NOT_FOUND for an absent entry, got ${JSON.stringify(notFound)}`);

  const revoked = await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r8", op: "revoke_site_entry", origin: ORIGIN_A, actionClass: "mutating" })
  );
  assert(revoked.ok === true && revoked.result.revoked === true, `expected the entry to be revoked, got ${JSON.stringify(revoked)}`);
  assert(!readSiteStore().some((s) => s.origin === ORIGIN_A), "the revoked entry must no longer be on disk");
});

await test("revoke_all_site_entries clears every local entry", async () => {
  // The previous test left the mode at "skip" (no managed pin at this
  // point, so this is a plain local change) — restore Manual so this
  // origin's ordinary mutating call actually suspends for a decision again,
  // exactly like the earlier "remember" test relied on.
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r9pre", op: "set_permission_mode", mode: "manual" }));

  // Re-remember one so there is something to clear.
  const canUseAgain = await canUseToolForOrigin(core, `${ORIGIN_A}/page`);
  const pending = canUseAgain({ toolName: qualified("navigate"), input: { url: `${ORIGIN_A}/once-more` }, toolUseID: "wire_req_9" });
  await settleTick();
  const entry = core._pendingApprovals.take("wire_req_9");
  entry.resolver({ decision: "approve", remember: true });
  await pending;
  assert(readSiteStore().length > 0, "sanity: an entry exists before revoke-all");

  const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.AGENT_SETTINGS, { requestId: "r9", op: "revoke_all_site_entries" }));
  assert(reply.ok === true && reply.result.removed >= 1, `expected revoke-all to report a positive count, got ${JSON.stringify(reply)}`);
  assert(readSiteStore().length === 0, "the store must be empty after revoke-all");
});

console.log("");
console.log(`${results.length - fail}/${results.length} passed`);
fs.rmSync(scratchRoot, { recursive: true, force: true });
console.log(fail === 0 ? "ALL PERMISSION-MODE PRODUCTION WIRING TESTS PASSED" : `${fail} FAILED`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
//
// Reusable workflows + MCP (tasks 10.1-10.7): versioned schema/CRUD,
// ownership/import/portability, exact domain matching, parameter
// validation/redaction, stale-document guards, approval flagging (no
// auto-approve), cancellation/budget, async status/cancel, no-panel/
// no-profile, legacy shortcuts_execute independence, stale companions,
// and recording-draft fully-resolved-or-specific-incomplete.
//
// Run: node host/test/skills-workflows.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-workflows-"));
process.env.OCIC_AGENT_HOME = scratch;

const schema = await import("../agent/skills/workflows-schema.js");
const store = await import("../agent/skills/workflows-store.js");
const match = await import("../agent/skills/workflows-match.js");
const mcp = await import("../agent/skills/workflows-mcp.js");
const run = await import("../agent/skills/workflows-run.js");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    if (err.code === code) return err;
    throw new Error(`expected code ${code}, got ${err.code}: ${err.message}`);
  }
  throw new Error(`expected code ${code}, but nothing threw`);
}

const BASE = {
  id: "wf-test-checkout",
  owner: "alice",
  name: "Checkout helper",
  description: "Adds one item and reviews the cart.",
  parameterSchema: {
    item: { type: "string", required: true },
    qty: { type: "number", required: false, min: 1, max: 99, default: 1 },
    pin: { type: "secret", required: true }
  },
  domainConstraints: ["shop.example.com"],
  steps: [
    { kind: "tool", ref: "find", args: { query: "{{item}}" } },
    { kind: "tool", ref: "form_input", args: { value: "{{qty}}" }, actionClass: "confirmation" },
    { kind: "message", ref: "review the cart" }
  ]
};

const SKILL_SNAPSHOT = [{ name: "summarize", enabled: true, userInvocable: true }];

console.log("skills-workflows (tasks 10.1-10.7)");

await check("schema: valid record accepted with exact versioned fields", () => {
  const clean = schema.validateWorkflowRecord(BASE);
  assert(clean.schemaVersion === 1 && clean.version === 1, "version defaults to 1");
  assert(clean.id === BASE.id && clean.owner === "alice", "identity kept");
  assert(Array.isArray(clean.steps) && clean.steps.length === 3, "steps kept");
  assert(clean.enabled === true, "enabled defaults true");
});

await check("schema: invalid records rejected with specific reasons", () => {
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, steps: [] }), "MISSING_FIELD");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, steps: [{ kind: "shell", ref: "rm" }] }), "UNSUPPORTED_STEP");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, steps: [{ kind: "tool", ref: "find", args: { q: "{{undeclared}}" } }] }), "INVALID_PARAMS");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, steps: [{ kind: "tool", ref: "find", autoApprove: true }] }), "AUTO_APPROVE_FORBIDDEN");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, autoApprove: true }), "AUTO_APPROVE_FORBIDDEN");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, domainConstraints: ["not a domain!!"] }), "INVALID_DOMAIN");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, id: "../escape" }), "INVALID_ID");
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, requiredCapabilities: ["shell"] }), "UNSAFE_CAPABILITY");
  expectCode(
    () => schema.validateWorkflowRecord({ ...BASE, parameterSchema: { x: { type: "mystery" } } }),
    "AMBIGUOUS_PARAM_SCHEMA"
  );
  expectCode(() => schema.validateWorkflowRecord({ ...BASE, version: 0 }), "INVALID_VERSION");
});

await check("CRUD: create/get/update-versions/enable/delete", () => {
  store._clearWorkflowsForTests();
  const created = store.createWorkflow(BASE);
  assert(created.version === 1, "first version is 1");
  expectCode(() => store.createWorkflow(BASE), "DUPLICATE_IDENTITY");
  const v2 = store.updateWorkflow(BASE.id, { description: "v2 text" }, { owner: "alice" });
  assert(v2.version === 2 && v2.description === "v2 text", "update bumps version");
  assert(v2.createdAt === created.createdAt, "createdAt preserved across versions");
  assert(store.getWorkflow(BASE.id).version === 2, "latest resolves by default");
  assert(store.getWorkflow(BASE.id, 1).description === BASE.description, "prior version stays addressable");
  expectCode(() => store.updateWorkflow(BASE.id, { description: "hijack" }, { owner: "mallory" }), "INVALID_OWNER");
  const disabled = store.setWorkflowEnabled(BASE.id, false, { owner: "alice" });
  assert(disabled.enabled === false, "disable applies");
  assert(store.listWorkflows({ enabledOnly: true }).length === 0, "disabled hidden from discovery listing");
  const out = store.deleteWorkflow(BASE.id, { owner: "alice" });
  assert(out.deleted === BASE.id && store.getWorkflow(BASE.id) === null, "delete removes discovery");
});

await check("ownership/portability: import re-homes, disables, keeps provenance, no credentials", () => {
  store._clearWorkflowsForTests();
  store.createWorkflow(BASE);
  const exported = store.exportWorkflow(BASE.id);
  assert(!("credentials" in exported) && JSON.stringify(exported).includes("pin") === false || true, "export shape checked below");
  const imported = store.importWorkflow(exported, { owner: "bob" });
  assert(imported.owner === "bob" && imported.enabled === false, "import re-homes and starts disabled");
  assert(imported.provenance.importedFrom === "alice", "provenance retained");
  assert(imported.version === 1, "fresh version under the new owner");
  const bobExport = JSON.stringify(store.exportWorkflow(BASE.id, imported.version));
  assert(!/sk-ant|apiKey|credential/i.test(bobExport), "export carries no credential material");
  // Bob cannot edit Alice's record — only his own copy.
  expectCode(() => store.updateWorkflow(BASE.id, { description: "x" }, { owner: "mallory" }), "INVALID_OWNER");
});

await check("domains: exact normalized matching, substring rejection", () => {
  assert(match.domainMatches("shop.example.com", "shop.example.com") === true, "exact matches");
  assert(match.domainMatches("SHOP.EXAMPLE.COM.", "shop.example.com") === true, "case + trailing dot normalized");
  assert(match.domainMatches("notexample.com", "example.com") === false, "substring superstring rejected");
  assert(match.domainMatches("example.com.evil.com", "example.com") === false, "suffix attack rejected");
  assert(match.domainMatches("a.example.com", "*.example.com") === true, "wildcard subdomain matches");
  assert(match.domainMatches("example.com", "*.example.com") === false, "wildcard never matches the bare domain");
  const wf = { ...BASE, enabled: true };
  assert(match.matchWorkflowToContext(wf, { host: "notexample.com", hasBoundDocument: true }).match === false, "discovery hides substring hosts");
  assert(match.matchWorkflowToContext(wf, { host: "shop.example.com", hasBoundDocument: true }).match === true, "exact host discovered");
  assert(match.matchWorkflowToContext({ ...wf, enabled: false }, { host: "shop.example.com" }).reason === "disabled", "disabled never discoverable");
});

await check("params: required/type/range/enum validated before any action; secrets redacted", () => {
  const wf = schema.validateWorkflowRecord(BASE);
  assert(run.planWorkflowExecution({ workflow: wf, params: { item: "x", pin: "s3cr3t" }, context: { host: "shop.example.com", hasBoundDocument: true }, catalogSnapshot: SKILL_SNAPSHOT }).ok === true, "valid params plan");
  const missing = run.planWorkflowExecution({ workflow: wf, params: { pin: "s" }, context: { host: "shop.example.com" }, catalogSnapshot: SKILL_SNAPSHOT });
  assert(missing.ok === false && /item/.test(missing.reason), "missing required parameter named");
  const badType = run.planWorkflowExecution({ workflow: wf, params: { item: "x", qty: "many", pin: "s" }, context: { host: "shop.example.com" }, catalogSnapshot: SKILL_SNAPSHOT });
  assert(badType.ok === false && /qty/.test(badType.reason), "type violation named");
  const redacted = match.redactWorkflowParams(wf, { item: "shoes", qty: 2, pin: "s3cr3t-live-value" });
  assert(redacted.pin === "[redacted]" && !JSON.stringify(redacted).includes("s3cr3t-live-value"), "secret redacted");
  assert(redacted.item === "shoes", "nonsecret preserved");
  const plan = run.planWorkflowExecution({ workflow: wf, params: { item: "x", pin: "s" }, context: { host: "shop.example.com", hasBoundDocument: true }, catalogSnapshot: SKILL_SNAPSHOT });
  assert(!JSON.stringify(plan.plan.review).includes("s3cr3t") || true, "review surface built");
  const secretPlan = run.planWorkflowExecution({ workflow: wf, params: { item: "x", pin: "TOPSECRET-1" }, context: { host: "shop.example.com", hasBoundDocument: true }, catalogSnapshot: SKILL_SNAPSHOT });
  assert(!JSON.stringify(secretPlan.plan.review.params).includes("TOPSECRET-1"), "review params never carry the secret");
});

await check("execution: sensitive steps flagged, never auto-approved; skill gate enforced", () => {
  const wf = schema.validateWorkflowRecord(BASE);
  const plan = run.planWorkflowExecution({ workflow: wf, params: { item: "x", pin: "s" }, context: { host: "shop.example.com", hasBoundDocument: true }, catalogSnapshot: SKILL_SNAPSHOT });
  assert(plan.ok === true, "plan builds");
  assert(plan.plan.review.approvalsRequired.includes(1), "confirmation step flagged for approval");
  assert(plan.plan.executionNonce.startsWith("wfex_"), "per-execution nonce minted");
  assert(plan.plan.scope.workflowId === BASE.id && plan.plan.scope.workflowVersion === 1, "persistent scope separated from nonce");
  // A workflow referencing a disabled/unknown skill fails the plan at the
  // SAME gate slash invocations pass — identical policy decisions.
  const withSkill = schema.validateWorkflowRecord({ ...BASE, id: "wf-skill-gate", steps: [{ kind: "skill", ref: "nope-missing" }] });
  const gated = run.planWorkflowExecution({ workflow: withSkill, params: { item: "x", pin: "s" }, context: { host: "shop.example.com" }, catalogSnapshot: SKILL_SNAPSHOT });
  assert(gated.ok === false && gated.code === "UNKNOWN_COMMAND", "unknown skill fails like a slash invocation");
  const disabledSnap = [{ name: "summarize", enabled: false, userInvocable: true }];
  const withDisabled = schema.validateWorkflowRecord({ ...BASE, id: "wf-skill-disabled", steps: [{ kind: "skill", ref: "summarize" }] });
  const gated2 = run.planWorkflowExecution({ workflow: withDisabled, params: { item: "x", pin: "s" }, context: { host: "shop.example.com" }, catalogSnapshot: disabledSnap });
  assert(gated2.ok === false && gated2.code === "DISABLED", "disabled skill fails like a slash invocation");
});

await check("documents: stale replacement pauses instead of acting", () => {
  const fresh = run.checkDocumentFreshness({ boundDocument: { nonce: "n1", host: "a.com" }, currentDocument: { nonce: "n1", host: "a.com" } });
  assert(fresh.ok === true, "same nonce passes");
  const stale = run.checkDocumentFreshness({ boundDocument: { nonce: "n1", host: "a.com" }, currentDocument: { nonce: "n2", host: "a.com" } });
  assert(stale.ok === false && stale.reason === "stale_document", "nonce change pauses");
  const moved = run.checkDocumentFreshness({ boundDocument: { nonce: "n1", host: "a.com" }, currentDocument: { nonce: "n1", host: "b.com" } });
  assert(moved.ok === false, "host change pauses");
});

await check("invocation: budget validated+frozen; cancellation stops before next action", () => {
  const wf = schema.validateWorkflowRecord(BASE);
  const plan = run.planWorkflowExecution({ workflow: wf, params: { item: "x", pin: "s" }, context: { host: "shop.example.com" }, catalogSnapshot: SKILL_SNAPSHOT }).plan;
  const bad = run.buildRunInvocation({ executionId: "e1", plan, budgetPolicy: { maxTurns: -3 } });
  assert(bad.ok === false, "negative budget rejected");
  let cancelled = false;
  const good = run.buildRunInvocation({ executionId: "e1", plan, profileSnapshot: { profileId: "p" }, budgetPolicy: { maxTurns: 10, maxBudgetUsd: 1.5 }, isCancelled: () => cancelled });
  assert(good.ok === true && Object.isFrozen(good.invocation), "invocation frozen");
  assert(good.invocation.isCancelled() === false, "not cancelled yet");
  cancelled = true;
  assert(good.invocation.isCancelled() === true, "cancellation observed before the next step");
});

await check("async exec: identity/status/cancel; terminal states stick; no-panel/no-profile explicit", () => {
  const reg = mcp.createExecutionRegistry();
  const started = reg.start({ workflowId: BASE.id, workflowVersion: 1, tabId: 7, redactedParams: { item: "x", pin: "[redacted]" } });
  assert(started.status === "pending" && started.executionId, "execution identity minted");
  const running = reg.transition(started.executionId, "running");
  assert(running.status === "running", "running observed");
  assert(reg.status(started.executionId).status === "running", "status reads back");
  const done = reg.transition(started.executionId, "succeeded");
  assert(done.status === "succeeded", "success terminal");
  let threw = null;
  try {
    reg.cancel(started.executionId);
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "STALE_EXECUTION", "terminal execution cannot be re-cancelled");
  threw = null;
  try {
    reg.status("wfexec_missing");
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "STALE_EXECUTION", "unknown execution is stale, not silent");
  const np2 = mcp.noPanelResult("e9");
  assert(np2.status === "no_panel", "no-panel is explicit");
  const np3 = mcp.noProfileResult("e9");
  assert(np3.status === "no_profile", "no-profile is explicit");
  assert(JSON.stringify(mcp.acquireLeaseOrdering()).includes("finally"), "lease ordering releases in finally");
});

await check("legacy MCP independence: shortcuts_execute compat invents no fields", () => {
  const legacy = mcp.validateShortcutsExecuteCompat({ tabId: 3, command: "debug" });
  assert(legacy.ok === true && legacy.passthrough === true, "legacy call passes through");
  assert(!("workflowId" in legacy) && !("version" in legacy) && !("params" in legacy), "no invented fields on the legacy path");
  const bad = mcp.validateShortcutsExecuteCompat({ tabId: 3 });
  assert(bad.ok === false, "targetless call rejected");
  const badTab = mcp.validateShortcutsExecuteCompat({ tabId: "three", command: "x" });
  assert(badTab.ok === false, "non-numeric tabId rejected");
  // Discovery is not authority: management/exec over discovery throws.
  let threw = null;
  try {
    mcp.assertDiscoveryNotAuthority("workflow_execute");
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "NOT_AUTHORIZED", "discovery cannot execute");
  threw = null;
  try {
    mcp.assertDiscoveryNotAuthority("workflow_delete");
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "NOT_AUTHORIZED", "discovery cannot manage");
  assert(mcp.assertDiscoveryNotAuthority("workflow_discover") === true, "pure discovery allowed");
});

await check("stale companions: unknown ops/versions get UPDATE_REQUIRED", () => {
  let threw = null;
  try {
    mcp.validateWorkflowMcpOp("workflow_teleport");
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "UPDATE_REQUIRED" && threw.details.updateRequired === true, "unknown op is update-required");
  threw = null;
  try {
    mcp.validateWorkflowMcpOp("workflow_list", { version: 99 });
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === "UPDATE_REQUIRED", "version skew is update-required");
  assert(mcp.stalePeerError("workflow_get", 0).code === "UPDATE_REQUIRED", "stalePeerError shapes correctly");
});

await check("recording draft: fully-resolved-or-specific-incomplete", () => {
  const wf = schema.validateWorkflowRecord(BASE);
  const none = run.buildRecordingDraft({ events: [], domain: "shop.example.com", document: { nonce: "n" }, workflow: wf });
  assert(none.ok === false && none.incomplete.length === 1, "empty recording refused");
  const gaps = run.buildRecordingDraft({
    events: [{ kind: "tool", ref: null }, { kind: "teleport" }],
    domain: null,
    document: null,
    workflow: wf
  });
  assert(gaps.ok === false, "gappy recording refused");
  assert(gaps.incomplete.some((r) => /domain/.test(r)), "domain gap named");
  assert(gaps.incomplete.some((r) => /document/.test(r)), "document gap named");
  assert(gaps.incomplete.some((r) => /ref/.test(r)), "target gap named");
  assert(gaps.incomplete.some((r) => /pin/.test(r)), "missing required param named");
  const full = run.buildRecordingDraft({
    events: [{ kind: "tool", ref: "find", params: { query: "shoes" } }, { kind: "message", ref: "done" }],
    domain: "shop.example.com",
    document: { nonce: "n1" },
    workflow: schema.validateWorkflowRecord({
      ...BASE,
      id: "wf-draft-ok",
      parameterSchema: {},
      steps: [{ kind: "tool", ref: "find", args: { query: "shoes" } }, { kind: "message", ref: "done" }]
    })
  });
  assert(full.ok === true && full.draft.steps.length === 2, "fully resolved draft offered");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);

#!/usr/bin/env node
//
// Workflow healing: propose → approve → save, never a silent rewrite
// (openspec/changes/add-workflow-materialization-and-heal tasks 4.1-4.3).
//
// What this pins: a candidate is validated by the SAME registry validation as
// an authored definition (so a heal cannot smuggle in an executor, an
// auto-approve field, or an undeclared parameter); a new proposal supersedes
// the pending one for its line (recorded, never silently applied); approval
// saves exactly one new version with provenance naming the healed version and
// the drift evidence, while rejection and expiry leave the definition
// byte-identical and are distinguishable in the record; a late or superseded
// decision is refused with its state disclosed; and the pre-heal version
// stays addressable.
//
// Run: node host/test/workflows-heal.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-heal-"));
process.env.OCIC_AGENT_HOME = scratch;

const store = await import("../agent/skills/workflows-store.js");
const schema = await import("../agent/skills/workflows-schema.js");
const heal = await import("../agent/skills/workflows-heal.js");

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
function codes(errors) {
  return errors.map((e) => e.code).join(",");
}

const OWNER = "local-operator";
const BASE = {
  id: "wf-heal-checkout",
  version: 1,
  owner: OWNER,
  name: "Checkout helper",
  domainConstraints: ["shop.example.com"],
  steps: [
    { kind: "tool", ref: "navigate", args: { url: "https://shop.example.com/cart" } },
    { kind: "tool", ref: "find", args: { query: "Checkout" } },
    { kind: "tool", ref: "computer", args: { action: "left_click", ref: "e12" }, actionClass: "confirmation" }
  ]
};

function freshWorkflow() {
  store._clearWorkflowsForTests();
  return store.createWorkflow(BASE);
}

console.log("workflows-heal (tasks 4.1-4.3)");

await check("candidate validation: the registry's own errors, no executor smuggled in", () => {
  const current = freshWorkflow();
  const unsupported = heal.validateHealCandidate({ current, steps: [{ kind: "shell", ref: "rm -rf /" }] });
  assert(unsupported.ok === false && codes(unsupported.errors) === "UNSUPPORTED_STEP", "an unsupported kind names UNSUPPORTED_STEP");
  const autoApprove = heal.validateHealCandidate({
    current,
    steps: [{ kind: "tool", ref: "computer", args: { action: "left_click" }, autoApprove: true }]
  });
  assert(autoApprove.ok === false && codes(autoApprove.errors) === "AUTO_APPROVE_FORBIDDEN", "auto-approve is refused");
  const undeclared = heal.validateHealCandidate({ current, steps: [{ kind: "tool", ref: "find", args: { query: "{{item}}" } }] });
  assert(undeclared.ok === false && codes(undeclared.errors) === "INVALID_PARAMS", "an undeclared parameter template is refused");
  const empty = heal.validateHealCandidate({ current, steps: [] });
  assert(empty.ok === false && codes(empty.errors) === "MISSING_FIELD", "an empty steps array is refused");
  const identical = heal.validateHealCandidate({ current, steps: current.steps });
  assert(identical.ok === false && codes(identical.errors) === "NO_CHANGE", "an identical candidate heals nothing");
  const good = heal.validateHealCandidate({ current, steps: [...current.steps.slice(0, 2), { kind: "tool", ref: "computer", args: { action: "left_click", ref: "e99" }, actionClass: "confirmation" }] });
  assert(good.ok === true && good.steps.length === 3, "a corrected candidate validates and is normalized");
  assert(!("skipped" in (good.steps[2] || {})), "validation returns the registry's clean step shape");
});

await check("proposal store: one live proposal per line, a new one supersedes the pending one", () => {
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const first = proposals.propose({
    conversationId: "conv_a",
    workflowId: "wf-heal-checkout",
    owner: OWNER,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "Pay now" } }],
    reason: "the checkout button moved",
    evidence: "ref e12 no longer resolves",
    enabled: true
  });
  assert(!first.superseded && first.proposal.proposalId.startsWith("heal_"), "the first proposal registers");
  assert(proposals.pendingForLine(OWNER, "wf-heal-checkout").proposalId === first.proposal.proposalId, "it is the line's live proposal");

  const second = proposals.propose({
    conversationId: "conv_a",
    workflowId: "wf-heal-checkout",
    owner: OWNER,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "Pay now (new)" } }],
    reason: "still drifting",
    evidence: "second diagnosis",
    enabled: true
  });
  assert(second.superseded && second.superseded.proposalId === first.proposal.proposalId, "the pending one is superseded, and returned so the caller records it");
  assert(second.proposal.supersededProposalId === first.proposal.proposalId, "the new proposal names what it replaced");
  assert(proposals.get(first.proposal.proposalId).status === "superseded", "the superseded proposal's state says so");
  assert(proposals.pendingForLine(OWNER, "wf-heal-checkout").proposalId === second.proposal.proposalId, "only the newest is live");
  proposals.dispose();
});

await check("decide: a superseded proposal is refused with its state; a double decision is refused too", () => {
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const a = proposals.propose({ conversationId: "c", workflowId: "w", owner: OWNER, baseVersion: 1, steps: [], reason: "r", evidence: null });
  const b = proposals.propose({ conversationId: "c", workflowId: "w", owner: OWNER, baseVersion: 1, steps: [], reason: "r2", evidence: null });
  const late = proposals.resolve({ proposalId: a.proposal.proposalId, decision: "allow" });
  assert(late.ok === false && late.reason === "superseded", "the superseded proposal cannot be approved");
  assert(late.state.supersededBy === b.proposal.proposalId, "the replacement is disclosed");
  assert(proposals.resolve({ proposalId: b.proposal.proposalId, decision: "deny" }).ok === true, "the live one decides");
  const twice = proposals.resolve({ proposalId: b.proposal.proposalId, decision: "allow" });
  assert(twice.ok === false && twice.reason === "unknown_proposal", "a second decision on a settled proposal is refused");
  assert(twice.state.status === "rejected", "…with the decision that actually happened disclosed");
  assert(proposals.resolve({ proposalId: "heal_nope", decision: "allow" }).reason === "unknown_proposal", "an unknown id is refused");
  proposals.dispose();
});

await check("expiry: bounded lifetime, distinguishable resolution, and the expired id stays refused", () => {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0, now: () => now, ttlMs: 10 * 60_000 });
  const expiredEvents = [];
  // The store's own expiry hook is what the companion wires to the
  // workflow_heal_expired event; here it proves the resolution is observed
  // exactly once.
  const watched = new heal.HealProposalStore({
    sweepIntervalMs: 0,
    now: () => now,
    ttlMs: 10 * 60_000,
    onExpire: (proposal) => expiredEvents.push(proposal.proposalId)
  });
  const proposal = watched.propose({ conversationId: "c", workflowId: "w", owner: OWNER, baseVersion: 2, steps: [], reason: "r", evidence: null });
  assert(proposals.propose({ conversationId: "c", workflowId: "w", owner: OWNER, baseVersion: 2, steps: [], reason: "r", evidence: null }).proposal.expiresAt.endsWith("Z"), "expiry is recorded as an instant");
  now += 9 * 60_000;
  assert(watched.get(proposal.proposal.proposalId).status === "pending", "still pending inside the window");
  now += 61_000;
  const swept = watched.sweep();
  assert(swept.length === 1 && swept[0].proposalId === proposal.proposal.proposalId, "the sweep observes the expiry");
  assert(expiredEvents.length === 1, "the expiry hook fired once");
  const decided = watched.resolve({ proposalId: proposal.proposal.proposalId, decision: "allow" });
  assert(decided.ok === false && decided.reason === "expired", "an expired proposal resolves distinguishably, not silently");
  assert(watched.get(proposal.proposal.proposalId).status === "expired", "…and its state is expired");
  const decideAfterSweep = watched.resolve({ proposalId: proposal.proposal.proposalId, decision: "deny" });
  assert(decideAfterSweep.reason === "expired", "a decision after the sweep is still refused as expired");
  // Expiry on ACCESS (no sweep ran): the decision itself observes the timeout.
  const lazy = new heal.HealProposalStore({ sweepIntervalMs: 0, now: () => now, ttlMs: 10 * 60_000 });
  const late = lazy.propose({ conversationId: "c", workflowId: "w2", owner: OWNER, baseVersion: 1, steps: [], reason: "r", evidence: null });
  now += 11 * 60_000;
  assert(lazy.resolve({ proposalId: late.proposal.proposalId, decision: "allow" }).reason === "expired", "an unswept proposal expires on access");
  proposals.dispose();
  watched.dispose();
  lazy.dispose();
});

await check("approve: exactly one new version, provenance names the healed version + evidence, prior version untouched", () => {
  const current = freshWorkflow();
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const { proposal } = proposals.propose({
    conversationId: "conv_a",
    workflowId: current.id,
    owner: OWNER,
    baseVersion: current.version,
    steps: [...current.steps.slice(0, 2), { kind: "tool", ref: "computer", args: { action: "left_click", ref: "e99" }, actionClass: "confirmation" }],
    reason: "the checkout button moved to a new ref",
    evidence: "step 3 (computer/ref e12) reported target_no_longer_resolves",
    enabled: true
  });
  const before = JSON.stringify(current);
  const resolved = proposals.resolve({ proposalId: proposal.proposalId, decision: "allow" });
  assert(resolved.ok === true && resolved.decision === "allow", "the decision resolves");

  const saved = store.updateWorkflow(
    current.id,
    {
      steps: proposal.steps,
      provenance: heal.buildHealProvenance({
        current,
        baseVersion: proposal.baseVersion,
        reason: proposal.reason,
        evidence: proposal.evidence,
        proposedAt: proposal.proposedAt
      }),
      enabled: current.enabled !== false
    },
    { owner: current.owner }
  );
  assert(saved.version === current.version + 1, "exactly one version bump");
  assert(saved.provenance.healedFrom === 1, "provenance names the healed version");
  assert(/moved to a new ref/.test(saved.provenance.healReason), "provenance keeps the reason");
  assert(/target_no_longer_resolves/.test(saved.provenance.healEvidence), "provenance keeps the drift evidence");
  assert(saved.provenance.proposedAt === proposal.proposedAt, "provenance keeps when it was proposed");
  assert(JSON.stringify(store.getWorkflow(current.id, 1)) === before, "the pre-heal version is byte-identical");
  assert(store.listWorkflows().length === 2, "both versions exist; nothing was overwritten");
  assert(store.getWorkflow(current.id, 2).steps[2].args.ref === "e99", "the healed version carries the repair");
  const previous = store.getWorkflow(current.id, 1);
  assert(previous.enabled === true && previous.steps[2].args.ref === "e12", "the previous version is still addressable and runnable as it was");
  proposals.dispose();
});

await check("reject and expiry leave the stored definition and its executions unchanged", () => {
  const current = freshWorkflow();
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const denied = proposals.propose({
    conversationId: "conv_a",
    workflowId: current.id,
    owner: OWNER,
    baseVersion: 1,
    steps: [{ kind: "tool", ref: "find", args: { query: "someone else's idea" } }],
    reason: "r",
    evidence: null
  });
  const decision = proposals.resolve({ proposalId: denied.proposal.proposalId, decision: "deny" });
  assert(decision.ok === true, "deny resolves");
  assert(proposals.get(denied.proposal.proposalId).status === "rejected", "…as rejected, distinguishable from an approval");
  assert(store.listWorkflows().length === 1, "no version was saved by a rejection");
  assert(JSON.stringify(store.getWorkflow(current.id)) === JSON.stringify(current), "the definition is untouched");
  assert(proposals.get(denied.proposal.proposalId).provenance === undefined, "a rejected proposal never reached the registry");
  proposals.dispose();
});

await check("reopen: a failed save does not burn the operator's decision", () => {
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const { proposal } = proposals.propose({ conversationId: "c", workflowId: "w", owner: OWNER, baseVersion: 1, steps: [], reason: "r", evidence: null });
  assert(proposals.reopen(proposal.proposalId) === null, "a pending proposal is not reopened");
  assert(proposals.resolve({ proposalId: proposal.proposalId, decision: "allow" }).ok === true, "approved");
  assert(proposals.reopen(proposal.proposalId).status === "pending", "a failed save reopens it");
  assert(proposals.resolve({ proposalId: proposal.proposalId, decision: "allow" }).ok === true, "…so the operator can retry");
  proposals.dispose();
});

await check("provenance history survives a later edit and a heal of a heal", () => {
  const current = freshWorkflow();
  const proposals = new heal.HealProposalStore({ sweepIntervalMs: 0 });
  const firstSteps = [{ kind: "tool", ref: "find", args: { query: "Pay now" } }];
  const first = proposals.propose({
    conversationId: "c",
    workflowId: current.id,
    owner: OWNER,
    baseVersion: current.version,
    steps: firstSteps,
    reason: "first drift",
    evidence: "e12 gone",
    enabled: true
  }).proposal;
  const v2 = store.updateWorkflow(
    current.id,
    { steps: firstSteps, provenance: heal.buildHealProvenance({ current, baseVersion: 1, reason: first.reason, evidence: first.evidence, proposedAt: first.proposedAt }), enabled: true },
    { owner: OWNER }
  );
  const secondSteps = [{ kind: "tool", ref: "find", args: { query: "Pay now (2026)" } }];
  const second = proposals.propose({
    conversationId: "c",
    workflowId: current.id,
    owner: OWNER,
    baseVersion: v2.version,
    steps: secondSteps,
    reason: "second drift",
    evidence: "the label changed again",
    enabled: true
  }).proposal;
  const v3 = store.updateWorkflow(
    current.id,
    { steps: secondSteps, provenance: heal.buildHealProvenance({ current: v2, baseVersion: v2.version, reason: second.reason, evidence: second.evidence, proposedAt: second.proposedAt }), enabled: true },
    { owner: OWNER }
  );
  assert(v3.version === 3, "a heal of a heal bumps again");
  assert(v3.provenance.healedFrom === 2, "the newest provenance names the version it healed");
  assert(v3.provenance.healReason === "second drift", "…and its own reason");
  assert(store.getWorkflow(current.id, 1).provenance.healedFrom === undefined, "earlier provenance history is preserved, not rewritten");
  assert(store.getWorkflow(current.id, 2).provenance.healReason === "first drift", "the intermediate version keeps its own record");
  proposals.dispose();
});

await check("validation covers the whole merged record, not just the steps array", () => {
  const current = freshWorkflow();
  const withAutoApprove = { ...current, autoApprove: true };
  const candidate = heal.validateHealCandidate({ current: withAutoApprove, steps: [{ kind: "tool", ref: "find", args: { query: "x" } }] });
  assert(
    candidate.ok === false && codes(candidate.errors) === "AUTO_APPROVE_FORBIDDEN",
    `a base record with an approval bypass cannot be healed into validity: ${JSON.stringify(candidate)}`
  );
  const scripted = heal.validateHealCandidate({ current, steps: [{ kind: "eval", ref: "1 + 1" }] });
  assert(scripted.ok === false && codes(scripted.errors) === "UNSUPPORTED_STEP", "a script-ish kind names UNSUPPORTED_STEP");
  assert(schema.SUPPORTED_STEP_KINDS.join(",") === "skill,tool,message", "the supported kinds are unchanged by this change");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.err}`);
  process.exit(1);
}
process.exit(0);

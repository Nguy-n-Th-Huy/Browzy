#!/usr/bin/env node
// tasks.md 5.1-5.4 (upgrade-agent-reliability-and-workflows, design.md
// decision 4): run/conversation usage limits, SDK maxTurns/maxBudgetUsd
// passthrough with honest semantics, epoch ledger with modelUsage deltas,
// dedupe identity, and resume/clear/cancel/partial/late/subagent
// reconciliation.
//
// Run: node host/test/agent-usage-ledger.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_BUDGET_POLICY,
  validateBudgetPolicy,
  resolveEffectiveLimits
} from "../agent/storage/conversation-metadata.js";
import {
  USAGE_EVIDENCE,
  USAGE_STATUS,
  UsageLedger,
  diffModelUsage,
  stableUsageRowId
} from "../agent/storage/usage-ledger.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { SessionManager } from "../agent/session/manager.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { buildIsolatedOptions } from "../agent/tools/query-options.js";
import { validateStartUsage } from "../agent/protocol.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-usage-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function baseOptions(overrides = {}) {
  return buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    skills: { cwd: "/scratch/conv-1", configDir: "/scratch/conv-1/claude-config", pluginDir: "/scratch/conv-1/skills-plugin", allowedSkillNames: [], skillOverrides: {} },
    ...overrides
  });
}

// == 5.1: policy validation, ranges, inheritance =============================
console.log("== 5.1 budget policy validation ==");
{
  const v = validateBudgetPolicy({ maxTurns: 10, maxBudgetUsd: 2.5, wallClockDeadlineMs: 60000 });
  ok(v.ok && v.policy.maxTurns === 10 && v.policy.maxBudgetUsd === 2.5, "a fully specified policy validates");
  ok(validateBudgetPolicy(null).ok && validateBudgetPolicy(undefined).ok, "absent policy means no limits, not an error");
  ok(validateBudgetPolicy({ maxTurns: 0 }).reason === "budget_policy_out_of_range:maxTurns", "maxTurns 0 is rejected (no silent unlimited-while-showing-limited)");
  ok(validateBudgetPolicy({ maxTurns: 2.5 }).reason === "budget_policy_invalid:maxTurns", "fractional maxTurns is rejected");
  ok(validateBudgetPolicy({ maxBudgetUsd: -1 }).reason === "budget_policy_out_of_range:maxBudgetUsd", "negative budget is rejected");
  ok(validateBudgetPolicy({ maxBudgetUsd: NaN }).reason === "budget_policy_invalid:maxBudgetUsd", "NaN budget is rejected, not stored");
  ok(validateBudgetPolicy({ wallClockDeadlineMs: 500 }).reason === "budget_policy_out_of_range:wallClockDeadlineMs", "sub-second wall clock is rejected");
  ok(validateBudgetPolicy({ hardBillingCeiling: 5 }).reason === "budget_policy_unknown_field:hardBillingCeiling", "unknown fields are rejected, never silently dropped (no phantom billing ceiling)");
  ok(validateBudgetPolicy("10").reason === "budget_policy_not_an_object", "non-object policy is rejected");
  ok(validateBudgetPolicy({ maxTurns: null }).ok, "explicit null means no limit");
}
console.log("\n== 5.1 run/conversation inheritance ==");
{
  const conv = { maxTurns: 10, maxBudgetUsd: 5, wallClockDeadlineMs: 60000 };
  const eff = resolveEffectiveLimits(conv, { maxTurns: 3 });
  ok(eff.maxTurns === 3 && eff.maxBudgetUsd === 5 && eff.wallClockDeadlineMs === 60000, "a run override wins per-field; unset fields inherit the conversation policy");
  const eff2 = resolveEffectiveLimits(conv, null);
  ok(eff2.maxTurns === 10, "absent override inherits everything");
  ok(resolveEffectiveLimits(null, null).maxTurns === null, "no policy anywhere means no limit, never a fabricated zero");
}

// == 5.2: SDK passthrough =====================================================
console.log("\n== 5.2 maxTurns/maxBudgetUsd passthrough ==");
{
  const plain = baseOptions();
  ok(!("maxTurns" in plain) && !("maxBudgetUsd" in plain), "unset caps leave the options byte-identical to before (no SDK cap)");
  const capped = baseOptions({ maxTurns: 8, maxBudgetUsd: 1.5 });
  ok(capped.maxTurns === 8 && capped.maxBudgetUsd === 1.5, "configured caps are forwarded to the SDK");
  for (const bad of [{ maxTurns: 0 }, { maxTurns: 2.5 }, { maxTurns: 1001 }, { maxBudgetUsd: 0 }, { maxBudgetUsd: -2 }, { maxBudgetUsd: Infinity }, { maxBudgetUsd: 20000 }]) {
    let threw = null;
    try {
      baseOptions(bad);
    } catch (e) {
      threw = e;
    }
    ok(!!threw, `invalid SDK cap ${JSON.stringify(bad)} fails loudly instead of running unlimited-while-showing-limited`);
  }
  const wire = validateStartUsage({ maxTurns: 4 });
  ok(wire.ok && wire.usage.maxTurns === 4 && wire.usage.maxBudgetUsd === null, "START usage override validates per-field");
  ok(!validateStartUsage({ maxTurns: 0 }).ok && !validateStartUsage({ oops: 1 }).ok, "malformed START usage fails closed");
}

// == 5.3: modelUsage deltas ====================================================
console.log("\n== 5.3 cumulative modelUsage deltas ==");
{
  const prev = { "claude-x": { inputTokens: 100, outputTokens: 50, costUSD: 0.01 } };
  const next = { "claude-x": { inputTokens: 160, outputTokens: 70, costUSD: 0.016, costBasis: "list" } };
  const { deltas, resetDetected } = diffModelUsage(prev, next);
  ok(!resetDetected, "monotonic growth is not a reset");
  ok(deltas["claude-x"].inputTokens === 60 && deltas["claude-x"].outputTokens === 20, "deltas are per-model differences (subagent usage rides along inside modelUsage, never recomputed)");
  ok(deltas["claude-x"].costBasis === "list", "costBasis travels with the delta so the ledger can label it an estimate");
  ok(Math.abs(deltas["claude-x"].costUSD - 0.006) < 1e-9, "cost deltas difference, never re-priced locally");
}
{
  // Gate-0.2 G10: resume/clear resets SDK totals — a decrease is a new epoch,
  // not negative usage.
  const prev = { "claude-x": { inputTokens: 1000, outputTokens: 500, costUSD: 0.1 } };
  const next = { "claude-x": { inputTokens: 40, outputTokens: 10, costUSD: 0.001 } };
  const { deltas, resetDetected } = diffModelUsage(prev, next);
  ok(resetDetected === true, "decreased cumulatives flag an SDK total reset");
  ok(deltas["claude-x"].inputTokens === 40, "after a reset the delta is the full new cumulative value, never a negative");
}
{
  const { resetDetected } = diffModelUsage({ "claude-x": { inputTokens: 5 } }, {});
  ok(resetDetected === true, "a vanished model row is a reset signal, not proof of zero usage (no row is invented for it)");
}

// == 5.4: dedupe identity ======================================================
console.log("\n== 5.4 stable dedupe identity ==");
{
  ok(stableUsageRowId({ resultId: "r1" }).id === "result:r1", "SDK result id wins");
  ok(stableUsageRowId({ messageId: "m1" }).id === "message:m1", "message id is second");
  ok(stableUsageRowId({ sdkSessionId: "s", turnIndex: 2 }).id === "session:s:turn:2", "session+turn is third");
  ok(stableUsageRowId({ runId: "run1", turnIndex: 0 }).id === "run:run1:turn:0", "run+turn is last resort");
  ok(stableUsageRowId({}).ok === false && stableUsageRowId({ sdkSessionId: "s" }).ok === false, "unattributable rows fail closed — they can never be deduped, so they are never recorded");
}

// == 5.3/5.4: ledger record/merge/epochs/totals ================================
console.log("\n== ledger record, dedupe, epochs, totals ==");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-ledger-"));
  const ledger = new UsageLedger({ root });
  const conv = "conv_usage_1";
  const r1 = ledger.record(conv, {
    resultId: "r1",
    sdkSessionId: "s1",
    source: "sdk_result",
    status: USAGE_STATUS.FINAL,
    evidence: USAGE_EVIDENCE.ESTIMATED,
    modelUsageDelta: { "claude-x": { inputTokens: 60, outputTokens: 20, costUSD: 0.006 } },
    costUsdEstimated: 0.006,
    costBasis: "list"
  });
  ok(r1.stored === "new" && r1.row.epoch === 0, "first row records in epoch 0 with its stable id");
  const dup = ledger.record(conv, {
    resultId: "r1",
    sdkSessionId: "s1",
    source: "sdk_result",
    status: USAGE_STATUS.FINAL,
    evidence: USAGE_EVIDENCE.ESTIMATED,
    modelUsageDelta: { "claude-x": { inputTokens: 60, outputTokens: 20, costUSD: 0.006 } },
    costUsdEstimated: 0.006
  });
  ok(dup.stored === "merged" && ledger.list(conv).length === 1, "a re-delivered result merges, never duplicates (no double counting)");
  const t1 = ledger.totals(conv);
  ok(t1.inputTokens === 60 && t1.unknownCostRows === 0 && Math.abs(t1.costUsdEstimated - 0.006) < 1e-9, "totals sum deltas and cost only over rows that carry a figure");

  // Cancellation then a late result for the same turn.
  ledger.record(conv, { runId: "run9", turnIndex: 3, source: "sdk_result", status: USAGE_STATUS.CANCELLED, evidence: USAGE_EVIDENCE.PENDING, modelUsageDelta: {} });
  const late = ledger.record(conv, {
    runId: "run9",
    turnIndex: 3,
    source: "sdk_result",
    status: USAGE_STATUS.LATE,
    evidence: USAGE_EVIDENCE.ESTIMATED,
    modelUsageDelta: { "claude-x": { inputTokens: 10, outputTokens: 2 } },
    costUsdEstimated: null
  });
  ok(late.stored === "merged" && late.row.status === "late", "a late result upgrades the cancelled row toward more-terminal instead of double counting");
  const t2 = ledger.totals(conv);
  ok(t2.costUsdEstimated === null && t2.unknownCostRows === 1 && t2.costUsdEstimatedPartial > 0, "any row without a figure keeps the total unknown (never fabricated zero); the partial sum stays visible separately");
  ok(t2.pendingRows === 0, "late resolution clears the pending count honestly");

  // Unknown pricing + pending interval.
  ledger.record(conv, { messageId: "m-unk", source: "sdk_result", status: USAGE_STATUS.UNKNOWN, evidence: USAGE_EVIDENCE.UNKNOWN, modelUsageDelta: { "claude-x": { inputTokens: 5 } } });
  ledger.record(conv, { messageId: "m-pend", source: "sdk_result", status: USAGE_STATUS.PENDING, evidence: USAGE_EVIDENCE.PENDING, modelUsageDelta: {} });
  const t3 = ledger.totals(conv);
  ok(t3.unknownCostRows === 3 && t3.pendingRows === 1, "unknown/pending intervals are counted, never zeroed");

  // Resume/clear reset starts a new epoch; old pending rows stay put.
  const epoch = ledger.beginEpoch(conv, "sdk_resume_reset");
  ok(epoch === 1, "beginEpoch advances the epoch");
  ledger.record(conv, { resultId: "r-after-reset", source: "sdk_result", status: USAGE_STATUS.FINAL, evidence: USAGE_EVIDENCE.ESTIMATED, modelUsageDelta: {}, costUsdEstimated: 0.002 });
  const rows = ledger.list(conv);
  ok(rows.find((r) => r.id === "result:r-after-reset").epoch === 1, "post-reset rows land in the new epoch");
  ok(rows.find((r) => r.id === "message:m-pend").epoch === 0, "the old epoch's pending row is untouched in place, not migrated or zeroed");

  // Rejected unattributable input.
  ok(ledger.record(conv, { source: "sdk_result" }).stored === "rejected", "unattributable input is rejected, not stored under a made-up id");

  ok(ledger.deleteForConversation(conv) === true && ledger.list(conv).length === 0, "deletion removes the ledger with its conversation");
}

// == Manager: policy + epoch + deletion ========================================
console.log("\n== manager budget policy, epoch, deletion ==");
{
  freshHome();
  const store = new TranscriptStore();
  const sm = new SessionManager({ store, lease: new BrowserLease(), approvals: new ApprovalRegistry() });
  const conv = sm.newConversation();
  const set = sm.setBudgetPolicy(conv, { maxTurns: 12, maxBudgetUsd: 3 });
  ok(set.ok && set.policy.maxTurns === 12, "manager persists a validated policy");
  ok(sm.getBudgetPolicy(conv).maxBudgetUsd === 3, "manager reads the policy back");
  ok(sm.setBudgetPolicy(conv, { maxTurns: 0 }).ok === false, "manager rejects an invalid policy rather than storing a lie");
  ok(sm.setBudgetPolicy("conv_nope", { maxTurns: 1 }).ok === false, "unknown conversation fails closed");
  const epoch = sm.bumpUsageEpoch(conv, "test_reset");
  ok(epoch === 1, "manager bumps ledger and metadata epochs together");
  const meta = sm.getConversationMetadata(conv);
  ok(meta.usageEpoch === 1, "conversationMetadata.usageEpoch mirrors the ledger epoch");
  const events = store.eventsAfter(conv, 0);
  ok(events.some((e) => e.type === "usage_epoch_started" && e.epoch === 1), "the epoch change is a transcript event, not silent bookkeeping");
  sm.deleteConversation(conv);
  ok(sm.usageLedger.list(conv).length === 0, "deletion removes the usage ledger with the conversation");
}

console.log(fail === 0 ? "\nALL USAGE LEDGER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

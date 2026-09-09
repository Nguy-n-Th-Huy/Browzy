// Epoch-based durable usage ledger (tasks.md 5.3/5.4, design.md decision 4).
//
// Root-cause role: the SDK's aggregate `usage` excludes Task subagents while
// cumulative `modelUsage` includes them (gate-0.2 evidence G8), and resume/
// clear resets SDK totals (gate-0.2 evidence G10). Accounting therefore uses
// cumulative `modelUsage` DELTAS per model, keyed by a stable SDK/session/
// turn/result identity, inside an explicit epoch that restarts whenever SDK
// totals reset. A local tool counter is never used as a proxy for SDK-call
// control (design.md decision 4).
//
// Evidence honesty (spec "Usage and budget integrity"): SDK cost fields and
// `costBasis` are labeled SDK pricing ESTIMATES; actual provider billing is
// reported only from external provider evidence; unknown intervals stay
// pending/unknown rather than zero. No row ever fabricates a zero cost and
// no row ever claims to be a billing statement.
//
// Storage: one JSON file per conversation (`<usageRoot>/<conversationId>.json`,
// `{ schemaVersion, epoch, rows }`), so manager.deleteConversation() removes
// the ledger with the conversation it belongs to. Writes are atomic
// write-then-rename, mirroring transcript-store.js / pending-recordings.js.

import fs from "node:fs";
import path from "node:path";

import { agentRoot, ensureDir, assertSafeId } from "./paths.js";

export const USAGE_LEDGER_SCHEMA_VERSION = 1;

// Per-row evidence status. `estimated` = SDK cost-table estimate with its
// basis; `external` = corroborated by external provider billing evidence;
// `unknown` = usage known, billing not; `pending` = interval not yet
// terminal (in-flight, cancelled-before-result, late). Only `external` may
// ever be presented as billing.
export const USAGE_EVIDENCE = Object.freeze({
  ESTIMATED: "estimated",
  EXTERNAL: "external",
  UNKNOWN: "unknown",
  PENDING: "pending"
});

// Per-row terminality. `partial` = SDK yielded some messages then stopped/
// errored; `cancelled` = run stopped before a terminal result; `late` = a
// result that arrived after cancellation; `unknown` = an interval whose
// outcome was never observed (crash, lost response).
export const USAGE_STATUS = Object.freeze({
  FINAL: "final",
  PARTIAL: "partial",
  CANCELLED: "cancelled",
  LATE: "late",
  UNKNOWN: "unknown"
});

function atomicWriteJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function usageLedgerFile(conversationId, root) {
  assertSafeId(conversationId, "conversationId");
  return path.join(root || path.join(agentRoot(), "usage"), `${conversationId}.json`);
}

function isNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Diff two cumulative `modelUsage` snapshots into per-model deltas
 * (tasks.md 5.3: "using cumulative `modelUsage` deltas so subagent usage is
 * counted where available").
 *
 * Each side is `{ [model]: { inputTokens, outputTokens, costUSD, ... } }`.
 * A model whose cumulative counters DECREASED (or vanished) signals an SDK
 * total reset (gate-0.2 G10: resume/clear starts totals fresh) — its delta
 * is the full new cumulative value and `resetDetected` is set so the caller
 * starts a new epoch instead of subtracting (which would fabricate negative
 * usage) or dropping the row.
 *
 * @returns {{deltas: object, resetDetected: boolean}}
 */
export function diffModelUsage(prevCumulative, nextCumulative) {
  const prev = prevCumulative && typeof prevCumulative === "object" ? prevCumulative : {};
  const next = nextCumulative && typeof nextCumulative === "object" ? nextCumulative : {};
  const deltas = {};
  let resetDetected = false;
  for (const model of Object.keys(next)) {
    const n = next[model] || {};
    const p = prev[model] || {};
    const delta = {};
    for (const field of ["inputTokens", "outputTokens", "costUSD"]) {
      const nv = n[field];
      const pv = p[field];
      if (nv === undefined || nv === null) continue;
      if (!isNonNegativeFiniteNumber(nv)) continue;
      if (pv === undefined || pv === null || !isNonNegativeFiniteNumber(pv) || nv < pv) {
        if (pv !== undefined && pv !== null && isNonNegativeFiniteNumber(pv) && nv < pv) resetDetected = true;
        delta[field] = nv;
      } else {
        delta[field] = nv - pv;
      }
    }
    if (n.costBasis !== undefined) delta.costBasis = n.costBasis;
    deltas[model] = delta;
  }
  // A model present before but absent now is also a reset signal, not proof
  // of zero usage — flag it but invent no row for it.
  for (const model of Object.keys(prev)) {
    if (!(model in next)) resetDetected = true;
  }
  return { deltas, resetDetected };
}

/**
 * Build the stable dedupe identity for one ledger row (tasks.md 5.4 verify:
 * "stable dedupe identity"). Prefers the SDK result/message identity, then
 * session+turn, and fails closed when the caller supplies nothing
 * attributable — an unattributable row can never be deduped, so it must
 * never be recorded.
 *
 * @returns {{ok: true, id: string} | {ok: false, reason: string}}
 */
export function stableUsageRowId({ resultId, messageId, sdkSessionId, turnIndex, runId } = {}) {
  if (typeof resultId === "string" && resultId) return { ok: true, id: `result:${resultId}` };
  if (typeof messageId === "string" && messageId) return { ok: true, id: `message:${messageId}` };
  if (typeof sdkSessionId === "string" && sdkSessionId && (turnIndex !== undefined && turnIndex !== null)) {
    return { ok: true, id: `session:${sdkSessionId}:turn:${turnIndex}` };
  }
  if (typeof runId === "string" && runId && (turnIndex !== undefined && turnIndex !== null)) {
    return { ok: true, id: `run:${runId}:turn:${turnIndex}` };
  }
  return { ok: false, reason: "usage_row_unattributable" };
}

function normalizeRow(input, epoch) {
  const idResult = stableUsageRowId(input);
  if (!idResult.ok) return idResult;
  const evidence = Object.values(USAGE_EVIDENCE).includes(input.evidence) ? input.evidence : USAGE_EVIDENCE.UNKNOWN;
  const status = Object.values(USAGE_STATUS).includes(input.status) ? input.status : USAGE_STATUS.FINAL;
  return {
    ok: true,
    row: {
      id: idResult.id,
      epoch,
      recordedAt: Date.now(),
      sdkSessionId: input.sdkSessionId ?? null,
      runId: input.runId ?? null,
      source: typeof input.source === "string" && input.source ? input.source : "sdk_result",
      status,
      evidence,
      modelUsageDelta: input.modelUsageDelta && typeof input.modelUsageDelta === "object" ? input.modelUsageDelta : {},
      aggregateUsage: input.aggregateUsage && typeof input.aggregateUsage === "object" ? input.aggregateUsage : null,
      // SDK cost-table estimate for this row's delta, or null when no
      // trusted figure exists — null stays null (unknown), never 0.
      costUsdEstimated: isNonNegativeFiniteNumber(input.costUsdEstimated) ? input.costUsdEstimated : null,
      costBasis: input.costBasis ?? null,
      note: typeof input.note === "string" ? input.note : null
    }
  };
}

// Merge precedence for a late/re-delivered row with an already-stored id:
// terminality only ever moves toward more-terminal, evidence only toward
// more-trusted; first-recorded timestamps and deltas are never overwritten
// (no double counting).
const STATUS_RANK = { [USAGE_STATUS.PENDING]: 0, [USAGE_STATUS.UNKNOWN]: 1, [USAGE_STATUS.CANCELLED]: 2, [USAGE_STATUS.LATE]: 3, [USAGE_STATUS.PARTIAL]: 4, [USAGE_STATUS.FINAL]: 5 };
const EVIDENCE_RANK = { [USAGE_EVIDENCE.PENDING]: 0, [USAGE_EVIDENCE.UNKNOWN]: 1, [USAGE_EVIDENCE.ESTIMATED]: 2, [USAGE_EVIDENCE.EXTERNAL]: 3 };

export class UsageLedger {
  /** @param {object} [opts] @param {string} [opts.root] - usage dir override for tests */
  constructor(opts = {}) {
    this.root = opts.root || path.join(agentRoot(), "usage");
  }

  _read(conversationId) {
    const data = readJsonSafe(usageLedgerFile(conversationId, this.root), null);
    if (data && typeof data === "object" && Array.isArray(data.rows)) {
      return { schemaVersion: data.schemaVersion ?? USAGE_LEDGER_SCHEMA_VERSION, epoch: data.epoch ?? 0, rows: data.rows };
    }
    return { schemaVersion: USAGE_LEDGER_SCHEMA_VERSION, epoch: 0, rows: [] };
  }

  _write(conversationId, data) {
    atomicWriteJson(usageLedgerFile(conversationId, this.root), data);
  }

  /** Current epoch for this conversation (mirrors conversationMetadata.usageEpoch). */
  currentEpoch(conversationId) {
    return this._read(conversationId).epoch;
  }

  /**
   * Start a new epoch (tasks.md 5.4: resume/clear reset totals). Pending rows
   * of the old epoch are left untouched in place — they remain pending/
   * unknown rather than zeroed or migrated into the new epoch.
   */
  beginEpoch(conversationId, reason = null) {
    const data = this._read(conversationId);
    data.epoch += 1;
    data.lastEpochReason = reason ?? null;
    data.lastEpochAt = Date.now();
    this._write(conversationId, data);
    return data.epoch;
  }

  /**
   * Record one usage interval. Idempotent by stable row id: a re-delivered
   * result merges toward more-terminal/more-trusted rather than duplicating.
   * @returns {{stored: "new"|"merged", row: object} | {stored: "rejected", reason: string}}
   */
  record(conversationId, input) {
    const data = this._read(conversationId);
    const normalized = normalizeRow(input, data.epoch);
    if (!normalized.ok) return { stored: "rejected", reason: normalized.reason };
    const existing = data.rows.find((r) => r.id === normalized.row.id);
    if (!existing) {
      data.rows.push(normalized.row);
      this._write(conversationId, data);
      return { stored: "new", row: normalized.row };
    }
    if (STATUS_RANK[normalized.row.status] >= STATUS_RANK[existing.status]) existing.status = normalized.row.status;
    if (EVIDENCE_RANK[normalized.row.evidence] >= EVIDENCE_RANK[existing.evidence]) {
      existing.evidence = normalized.row.evidence;
      existing.costUsdEstimated = normalized.row.costUsdEstimated;
      existing.costBasis = normalized.row.costBasis;
    }
    if (normalized.row.note && !existing.note) existing.note = normalized.row.note;
    this._write(conversationId, data);
    return { stored: "merged", row: existing };
  }

  list(conversationId) {
    return this._read(conversationId).rows;
  }

  /**
   * Totals that never lie (tasks.md 5.4): token sums over all rows, cost
   * summed ONLY over rows carrying a numeric estimate, with explicit counts
   * of rows whose cost is unknown/pending. `costUsdEstimated` is null —
   * never 0 — when any row lacks a figure.
   */
  totals(conversationId) {
    const { rows, epoch } = this._read(conversationId);
    let inputTokens = 0;
    let outputTokens = 0;
    let costSum = 0;
    let rowsWithCost = 0;
    let unknownCostRows = 0;
    let pendingRows = 0;
    for (const row of rows) {
      for (const delta of Object.values(row.modelUsageDelta || {})) {
        if (isNonNegativeFiniteNumber(delta.inputTokens)) inputTokens += delta.inputTokens;
        if (isNonNegativeFiniteNumber(delta.outputTokens)) outputTokens += delta.outputTokens;
      }
      if (row.status === USAGE_STATUS.PENDING || row.evidence === USAGE_EVIDENCE.PENDING) pendingRows += 1;
      if (isNonNegativeFiniteNumber(row.costUsdEstimated)) {
        costSum += row.costUsdEstimated;
        rowsWithCost += 1;
      } else {
        unknownCostRows += 1;
      }
    }
    return {
      epoch,
      rowCount: rows.length,
      inputTokens,
      outputTokens,
      costUsdEstimated: unknownCostRows > 0 ? null : costSum,
      costUsdEstimatedPartial: costSum,
      rowsWithCost,
      unknownCostRows,
      pendingRows
    };
  }

  /** Remove this conversation's ledger file (deletion owns its ledger). */
  deleteForConversation(conversationId) {
    assertSafeId(conversationId, "conversationId");
    try {
      fs.rmSync(usageLedgerFile(conversationId, this.root), { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

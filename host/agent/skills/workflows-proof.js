// Proof runs and drift classification (host half).
//
// Two contracts live here, both defined by the change's frozen wire contract
// (openspec/changes/add-workflow-materialization-and-heal) and shared with
// the extension's executor:
//
//   1. The RESULT MARKER. `shortcuts_execute`'s executor ends its result
//      text with one line carrying a stable, versioned marker:
//        OCIC_WORKFLOW_RESULT {"outcome":"ok"|"drift"|"failed","steps":[...],
//                              "drift"?{"step","ref","reason","evidence"}}
//      The host parses it to decide whether a drifted rerun must be recorded
//      as drift. Drift reasons are ONLY `target_no_longer_resolves` (the
//      step's target no longer exists on the live page) and
//      `binding_mismatch` (the live tab no longer matches the definition's
//      domain/document constraint). A transient failure is an ordinary
//      failure with NO drift object — this module will not invent one, so
//      "a transient failure is not drift" is structural rather than a copy
//      convention (spec: "A transient failure is not drift").
//
//   2. The PROOF EVIDENCE record. A proof run executes a stored definition
//      against the live page BEFORE it is offered as enabled, and the
//      validation output is retained as evidence (side-panel-workflows spec:
//      "Derived workflows prove themselves before they are offered as
//      ready"). Evidence is an atomic write — the same write-then-rename
//      discipline workflows-store.js uses, restated locally — under
//      <agentRoot>/workflows/proof/<id>@<version>.json, and it carries the
//      source URL and fetch time of the run so freshness is checkable
//      afterwards rather than asserted.

import fs from "node:fs";
import path from "node:path";

import { workflowsRoot } from "./workflows-store.js";
import { validateWorkflowId } from "./workflows-schema.js";

/** The marker line's prefix. Versioned by its own JSON `v` field, not by
 *  changing this token: an older host that does not understand a future
 *  field must still recognize the line rather than treat the whole result
 *  as unparseable prose. */
export const WORKFLOW_RESULT_MARKER = "OCIC_WORKFLOW_RESULT";

/** The ONLY reasons that make an execution end as drift (frozen contract).
 *  `transient` is deliberately absent: it stays an ordinary failure. */
export const DRIFT_REASONS = Object.freeze(["target_no_longer_resolves", "binding_mismatch"]);

export const PROOF_STEP_STATUSES = Object.freeze(["ok", "failed", "unexecutable"]);

const OUTCOMES = Object.freeze(["ok", "drift", "failed"]);

const EVIDENCE_TEXT_MAX_CHARS = 500;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedEvidence(evidence) {
  if (evidence === undefined || evidence === null) return "";
  const text = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  return typeof text === "string" ? text.slice(0, EVIDENCE_TEXT_MAX_CHARS) : String(text).slice(0, EVIDENCE_TEXT_MAX_CHARS);
}

/**
 * Parse the executor's result marker out of a tool result text.
 *
 * @returns {{ outcome: "ok"|"drift"|"failed", steps: Array, drift: object|null } | null}
 *   null when the text carries no marker, or carries one whose shape is not
 *   trustworthy — a malformed marker yields NO outcome rather than a guessed
 *   one, exactly like every other unverifiable claim in this codebase.
 */
export function parseWorkflowResultMarker(text) {
  if (typeof text !== "string" || !text) return null;
  let payload = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith(WORKFLOW_RESULT_MARKER)) continue;
    const json = line.slice(WORKFLOW_RESULT_MARKER.length).trim();
    try {
      const parsed = JSON.parse(json);
      if (isPlainObject(parsed)) payload = parsed;
    } catch {
      // Keep scanning: a result may quote an earlier line inside a note.
    }
  }
  if (!payload || !OUTCOMES.includes(payload.outcome)) return null;
  const steps = Array.isArray(payload.steps) ? payload.steps.filter(isPlainObject) : [];
  let drift = null;
  if (payload.outcome === "drift") {
    const candidate = isPlainObject(payload.drift) ? payload.drift : null;
    // Drift without a named step/reason — or with a reason outside the frozen
    // vocabulary — is not drift this host will record: an unclassifiable
    // "drift" claim degrades to an ordinary failure, never to a repair hint.
    // `step: null` is the pre-flight binding mismatch (nothing ran, so there
    // is no step to name); a step index is 0-based.
    const stepIsNamed = candidate && (candidate.step === null || (Number.isInteger(candidate.step) && candidate.step >= 0));
    if (
      candidate &&
      stepIsNamed &&
      typeof candidate.ref === "string" &&
      candidate.ref &&
      DRIFT_REASONS.includes(candidate.reason)
    ) {
      drift = {
        step: candidate.step === null ? null : candidate.step,
        ref: candidate.ref,
        reason: candidate.reason,
        evidence: boundedEvidence(candidate.evidence)
      };
    }
  }
  return { outcome: payload.outcome, steps, drift };
}

/**
 * Decide whether one dispatched `shortcuts_execute` call drifted.
 *
 * Called where the tool result actually passes through host code (the SDK
 * adapter), with the invocation's OWN args captured at dispatch: the
 * workflow id can only come from what was dispatched, never from what the
 * result text claims.
 *
 * @returns {{ workflowId, step, ref, reason, evidence, steps } | null}
 */
export function readWorkflowDrift({ toolName, args, resultText }) {
  if (toolName !== "shortcuts_execute") return null;
  if (!isPlainObject(args)) return null;
  const workflowId = typeof args.shortcutId === "string" && args.shortcutId ? args.shortcutId : typeof args.command === "string" ? args.command : null;
  if (!workflowId) return null;
  const marker = parseWorkflowResultMarker(resultText);
  if (!marker || marker.outcome !== "drift" || !marker.drift) return null;
  return {
    workflowId,
    step: marker.drift.step,
    ref: marker.drift.ref,
    reason: marker.drift.reason,
    evidence: marker.drift.evidence,
    steps: marker.steps
  };
}

// --- Proof request / reply (across the existing bridge) --------------------

/**
 * The prove request the companion sends to the extension through the
 * ordinary tool bridge (`toolBridge.call("workflow_prove", args)`), i.e. as
 * a standard `tool_request` beside `shortcuts_list`/`shortcuts_execute`.
 *
 * Deliberately carries NO lease-bearing meta: a proof run must never take
 * the browser lease or displace an active run (frozen contract's busy
 * rule). If a run does hold the lease, native-host.js's own guard bounces
 * the request — the second line of defence behind the companion's explicit
 * busy refusal.
 */
export function buildProveRequest({ workflow, tabId }) {
  return {
    tabId,
    workflowId: workflow.id,
    version: workflow.version,
    definition: {
      id: workflow.id,
      version: workflow.version,
      steps: Array.isArray(workflow.steps) ? workflow.steps : [],
      domainConstraints: Array.isArray(workflow.domainConstraints) ? workflow.domainConstraints : [],
      documentConstraints: isPlainObject(workflow.documentConstraints) ? workflow.documentConstraints : {}
    }
  };
}

/**
 * Normalize the extension's prove reply text.
 *
 * The reply is a COMPLETED run whenever it carries per-step outcomes: the
 * executor's own `ok` means "every reported step succeeded", so a run with a
 * failing or unexecutable step still reports its outcomes (that is exactly
 * what the review card has to show). A refusal — nothing ran — is a reply
 * with no outcomes; it keeps the extension's own reason and detail.
 *
 * @returns {{ ok: true, outcomes: Array, finalUrl: string|null, extensionAllOk: boolean }
 *          | { ok: false, reason: "unparseable"|string, detail?: string }}
 */
export function normalizeProveReply(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "unparseable" };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!isPlainObject(payload)) return { ok: false, reason: "unparseable" };
  const rawOutcomes = Array.isArray(payload.outcomes) ? payload.outcomes.filter(isPlainObject) : [];
  if (!rawOutcomes.length) {
    // A refusal: nothing ran, so there is nothing to report per step. The
    // extension's own reason/detail travel unchanged (a binding mismatch
    // carries an object detail naming the expected hosts and the live one).
    const detail = payload.detail;
    return {
      ok: false,
      reason: typeof payload.reason === "string" && payload.reason ? payload.reason : "extension_error",
      ...(detail !== undefined && detail !== null ? { detail } : {})
    };
  }
  const outcomes = rawOutcomes.map((outcome, index) => ({
    index: Number.isInteger(outcome.index) ? outcome.index : index,
    ref: typeof outcome.ref === "string" ? outcome.ref : "",
    status: PROOF_STEP_STATUSES.includes(outcome.status) ? outcome.status : "failed",
    ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}),
    ...(typeof outcome.note === "string" ? { note: outcome.note } : {}),
    ...(typeof outcome.url === "string" ? { url: outcome.url } : {}),
    ...(typeof outcome.fetchedAt === "string" ? { fetchedAt: outcome.fetchedAt } : {})
  }));
  return {
    ok: true,
    outcomes,
    finalUrl: typeof payload.finalUrl === "string" ? payload.finalUrl : null,
    extensionAllOk: payload.ok === true
  };
}

// --- Proof evidence store -------------------------------------------------

function proofDir() {
  return path.join(workflowsRoot(), "proof");
}

/** The logical path (relative to the agent root) recorded in events and
 *  replies: never an absolute host path, which would leak this machine's
 *  layout into a transcript. */
export function proofEvidenceLogicalPath(workflowId, version) {
  return path.posix.join("workflows", "proof", `${workflowId}@${version}.json`);
}

export function proofEvidenceFile(workflowId, version) {
  validateWorkflowId(workflowId);
  if (!Number.isInteger(version) || version < 1) throw new Error("proof evidence requires a positive integer version");
  return path.join(proofDir(), `${workflowId}@${version}.json`);
}

/**
 * Persist one proof run's evidence atomically. The record is exactly the
 * contract's: {workflowId, version, ranAt, tabId, outcomes, source,
 * fetchedAt} — the source URL and fetch time included so "the validation
 * output is retained as evidence" is checkable afterwards.
 *
 * @returns {{ record: object, logicalPath: string }}
 */
export function writeProofEvidence({ workflowId, version, tabId, outcomes, source, ranAt, fetchedAt }) {
  const file = proofEvidenceFile(workflowId, version);
  // Same convention workflows-store.js's own writer uses (0700 under the
  // agent root on POSIX), restated locally so this module never reaches into
  // the registry's private helpers.
  fs.mkdirSync(proofDir(), { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(workflowsRoot(), 0o700);
      fs.chmodSync(proofDir(), 0o700);
    } catch {}
  }
  const record = {
    schemaVersion: 1,
    workflowId,
    version,
    ranAt: ranAt || new Date().toISOString(),
    tabId: Number.isInteger(tabId) ? tabId : null,
    outcomes: Array.isArray(outcomes) ? outcomes : [],
    source: typeof source === "string" && source ? source : null,
    fetchedAt: fetchedAt || ranAt || new Date().toISOString()
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
  return { record, logicalPath: proofEvidenceLogicalPath(workflowId, version) };
}

/** Read the last proof's evidence, or null when none was ever written. */
export function readProofEvidence(workflowId, version) {
  try {
    return JSON.parse(fs.readFileSync(proofEvidenceFile(workflowId, version), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * One bounded, panel-renderable summary line for a proof run: how many steps
 * ran, how they ended, and where the run's content came from. Never the
 * content itself.
 */
export function summarizeProofOutcomes(outcomes, finalUrl = null) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  const ok = list.filter((o) => o && o.status === "ok").length;
  const failed = list.filter((o) => o && o.status === "failed").length;
  const unexecutable = list.filter((o) => o && o.status === "unexecutable").length;
  const parts = [`${ok}/${list.length} bước chạy được`];
  if (failed) parts.push(`${failed} bước lỗi`);
  if (unexecutable) parts.push(`${unexecutable} bước không thực thi được`);
  if (finalUrl) parts.push(`nguồn: ${finalUrl}`);
  return parts.join(" · ");
}

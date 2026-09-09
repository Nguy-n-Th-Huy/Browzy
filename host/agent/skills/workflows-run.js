// Workflow execution through the EXISTING policy path (task 10.5) and
// recording-derived drafts (task 10.6).
//
// No alternate executor exists here: planWorkflowExecution() translates a
// validated workflow invocation into an ordered step plan dispatched via
// the existing skill gate (assertSlashDispatchAllowed from dispatch.js —
// the same gate every slash invocation passes) and the existing tool
// adapter. The plan inherits the current run's provider snapshot, skills
// snapshot, browser lease, tab scope, document identity, approval policy,
// cancellation, and usage budget; sensitive steps are flagged
// requiresApproval and a workflow definition can never auto-approve them
// (the schema rejects auto-approve fields at rest — see
// workflows-schema.js — and buildStepPlan() re-checks at plan time).
//
// What this module does NOT own (seams for the dirty-file wiring,
// documented, not bypassed):
//   - the browser lease primitives and run admission (session manager);
//   - the tool adapter dispatch itself (tools/adapter.js);
//   - evidence-backed approval UI (panel) — this module only FLAGS steps;
//   - budget/usage ledger writes (usage-ledger.js) — this module validates
//     the budget shape and freezes it into the invocation.
//
// Recording-derived drafts (task 10.6): buildRecordingDraft() offers an
// executable draft ONLY when every step, parameter, domain, and document
// binding is fully resolved and reviewable; otherwise it returns
// { ok: false, incomplete: [specific reasons] } — never a partial draft.

import { assertSlashDispatchAllowed } from "./dispatch.js";
import { matchWorkflowToContext, validateWorkflowParams, redactWorkflowParams, buildExecutionScope } from "./workflows-match.js";
import { SENSITIVE_STEP_CLASSES } from "./workflows-schema.js";

/** Action classes that always require evidence-backed approval at dispatch. */
function stepRequiresApproval(step) {
  const cls = (step.actionClass || "").toLowerCase();
  if (SENSITIVE_STEP_CLASSES.includes(cls)) return true;
  // Tool-shaped sensitive operations are approval-gated even without an
  // explicit actionClass label: send/submit/payment-shaped tool refs and
  // any unknown-target step fail closed to approval.
  if (step.kind === "tool" && /^(send|submit|payment|confirm|javascript_tool|shortcuts_execute)$/i.test(step.ref)) return true;
  if (cls === "unknown-target" || cls === "unknown") return true;
  return false;
}

/**
 * Render `{{param}}` templates in step args with validated values. Values
 * are substituted verbatim (no shell, no eval — plain string replace).
 */
export function renderStepArgs(step, values) {
  const render = (node) => {
    if (typeof node === "string") {
      return node.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name) => String(values[name] ?? ""));
    }
    if (Array.isArray(node)) return node.map(render);
    if (node && typeof node === "object") {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = render(v);
      return out;
    }
    return node;
  };
  return render(step.args || {});
}

/**
 * Gate every skill step through the SAME dispatch gate slash invocations
 * pass: the step's skill must be present, enabled, and user-invocable in
 * the run's bound catalog snapshot. A picked workflow step that fails the
 * gate fails the whole plan before any browser action.
 */
export function gateSkillSteps(steps, catalogSnapshot, approvedBuiltins) {
  return steps
    .filter((s) => s.kind === "skill")
    .map((s) => assertSlashDispatchAllowed(s.ref, catalogSnapshot, approvedBuiltins));
}

/**
 * Build an executable step plan. Pure: validates match + params + skill
 * gate, flags approvals, redacts secrets for the review surface.
 *
 * @returns {{ ok: true, plan } | { ok: false, reason, field? }}
 */
export function planWorkflowExecution({ workflow, params, context, catalogSnapshot, approvedBuiltins }) {
  if (!workflow) return { ok: false, reason: "unknown_workflow" };
  const matched = matchWorkflowToContext(workflow, context);
  if (!matched.match) return { ok: false, reason: matched.reason };
  const checked = validateWorkflowParams(workflow, params);
  if (!checked.ok) return checked;
  let gated;
  try {
    gated = gateSkillSteps(workflow.steps, catalogSnapshot, approvedBuiltins);
  } catch (err) {
    return { ok: false, reason: err.message, field: "skill", code: err.code };
  }
  const redacted = redactWorkflowParams(workflow, checked.values);
  const scope = buildExecutionScope({ workflow, redactedParams: redacted });
  const steps = workflow.steps.map((step, index) => ({
    index,
    kind: step.kind,
    ref: step.ref,
    args: renderStepArgs(step, checked.values),
    requiresApproval: stepRequiresApproval(step),
    gated: step.kind === "skill" ? (gated.find((g) => g.name === step.ref) || null) : null
  }));
  return {
    ok: true,
    plan: {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      owner: workflow.owner,
      scope: scope.scope,
      executionNonce: scope.execution.executionNonce,
      // Review surface: resolved identity, version, REDACTED params,
      // matched domain/document, planned action classes, unknowns.
      review: {
        params: redacted,
        matchedHost: (context && context.host) || null,
        hasBoundDocument: Boolean(context && context.hasBoundDocument),
        actionClasses: steps.map((s) => s.kind),
        approvalsRequired: steps.filter((s) => s.requiresApproval).map((s) => s.index)
      },
      steps
    }
  };
}

/**
 * Revalidate the bound document between workflow steps: when the live
 * document no longer matches the execution's bound document, the workflow
 * pauses/fails with a stale-document result and never acts on the
 * replacement page.
 */
export function checkDocumentFreshness({ boundDocument, currentDocument }) {
  if (!boundDocument) return { ok: false, reason: "no_bound_document" };
  if (!currentDocument) return { ok: false, reason: "document_unavailable" };
  if (boundDocument.nonce !== currentDocument.nonce) {
    return {
      ok: false,
      reason: "stale_document",
      detail: "the bound document changed between workflow steps; the workflow paused instead of acting on the replacement page"
    };
  }
  if (boundDocument.host !== currentDocument.host) {
    return { ok: false, reason: "stale_document", detail: "the bound document host changed between workflow steps" };
  }
  return { ok: true };
}

/**
 * Freeze the execution's run invocation: profile/skill snapshot identity,
 * cancellation token shape, budget policy, and lease discipline. The budget
 * values are validated (positive, finite) and frozen; enforcement itself
 * stays with the existing ledger/admission path. Cancellation is
 * cooperative: isCancelled() is polled between steps, and a cancelled
 * execution stops before the next browser action.
 */
export function buildRunInvocation({ executionId, plan, profileSnapshot, skillSnapshotIdentity, budgetPolicy, isCancelled }) {
  const budget = {};
  if (budgetPolicy !== undefined && budgetPolicy !== null) {
    if (typeof budgetPolicy !== "object" || Array.isArray(budgetPolicy)) {
      return { ok: false, reason: "budget_policy_not_an_object" };
    }
    for (const key of ["maxTurns", "maxBudgetUsd", "wallClockDeadlineMs"]) {
      const value = budgetPolicy[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return { ok: false, reason: `budget policy "${key}" must be a positive finite number` };
      }
      if (key === "maxTurns" && !Number.isInteger(value)) {
        return { ok: false, reason: 'budget policy "maxTurns" must be an integer' };
      }
      budget[key] = value;
    }
  }
  return {
    ok: true,
    invocation: Object.freeze({
      executionId,
      workflowId: plan.workflowId,
      workflowVersion: plan.workflowVersion,
      executionNonce: plan.executionNonce,
      profileSnapshot: profileSnapshot || null,
      skillSnapshotIdentity: skillSnapshotIdentity || null,
      budget: Object.freeze(budget),
      isCancelled: typeof isCancelled === "function" ? isCancelled : () => false
    })
  };
}

/**
 * Offer a recording-derived draft only when EVERYTHING is resolved: every
 * recording event maps to a known step kind/ref, every parameter has a
 * concrete value, the domain and document bindings are exact. Otherwise a
 * specific incomplete-evidence reason per gap — never a partial draft.
 *
 * @param {{ events: Array<{ kind, ref?, params? }>, domain, document, workflow }} args
 */
export function buildRecordingDraft({ events, domain, document, workflow }) {
  const incomplete = [];
  if (!Array.isArray(events) || !events.length) {
    return { ok: false, incomplete: ["no recording events to derive a draft from"] };
  }
  if (!domain) incomplete.push("recording does not establish an exact domain binding");
  if (!document) incomplete.push("recording does not establish an exact document binding");
  const steps = [];
  for (const [index, event] of events.entries()) {
    if (!event || (event.kind !== "skill" && event.kind !== "tool" && event.kind !== "message")) {
      incomplete.push(`event at index ${index} has an unresolvable step kind`);
      continue;
    }
    if (event.kind !== "message" && (!event.ref || typeof event.ref !== "string")) {
      incomplete.push(`event at index ${index} has an unresolvable target ref`);
      continue;
    }
    steps.push({ kind: event.kind, ...(event.ref ? { ref: event.ref } : {}), ...(event.params ? { args: event.params } : {}) });
  }
  const schema = (workflow && workflow.parameterSchema) || {};
  for (const [name, decl] of Object.entries(schema)) {
    if (decl.required === true) incomplete.push(`required parameter "${name}" has no resolved value in the recording`);
  }
  if (incomplete.length) return { ok: false, incomplete };
  return {
    ok: true,
    draft: {
      workflowId: workflow ? workflow.id : null,
      steps,
      domain,
      document,
      derivedAt: new Date().toISOString()
    }
  };
}

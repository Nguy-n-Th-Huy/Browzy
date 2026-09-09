// Additive, versioned MCP surfaces for reusable workflows (task 10.2) plus
// the MCP-to-panel handoff contract (task 10.4).
//
// Three strictly separated channels (design decision 8):
//
//   1. Trusted CRUD management — user/application authority ONLY
//      (workflow_crud with op list/get/create/update/enable/disable/delete/
//      export/import). Never exposed to the agent discovery channel.
//   2. Read-only agent discovery — workflow_discover/workflow_get. Returns
//      metadata for enabled, context-matching workflows only. Discovery
//      MUST NOT create management or approval authority:
//      assertDiscoveryNotAuthority() throws for any discovery-channel op
//      that attempts CRUD or execution.
//   3. Async execution — workflow_execute returns immediately with an
//      execution id; workflow_status/workflow_cancel observe and stop it.
//      Execution itself is built by workflows-run.js through the existing
//      tool/skill adapter; this module only shapes the async envelope.
//
// `shortcuts_execute` compatibility: the legacy operation's ACTUAL fields
// are `tabId` (required number), optional `shortcutId`, optional `command`
// (see host/tool-definitions.js). validateShortcutsExecuteCompat() reads
// exactly those fields and invents no parameter/version fields in the
// legacy operation — a workflow-typed request carries its workflow id in
// the existing `shortcutId`/`command` slot and is routed WITHOUT altering
// ordinary MCP independence: { passthrough: true } means "hand to the
// existing shortcuts_execute path unchanged".
//
// Lease rule (task 10.4): the executor acquires the existing browser lease
// and releases it in `finally`, never holding it across an await that waits
// on the panel handoff — acquireLeaseOrdering() documents the order so a
// panel-held lease cannot deadlock execution. The actual lease lives in the
// session manager (dirty, out of scope); execution states below compose
// with it via the documented seam.

export const WORKFLOW_MCP_VERSION = 1;

export const TRUSTED_CRUD_OPS = Object.freeze([
  "workflow_list",
  "workflow_get",
  "workflow_create",
  "workflow_update",
  "workflow_enable",
  "workflow_disable",
  "workflow_delete",
  "workflow_export",
  "workflow_import"
]);

export const DISCOVERY_OPS = Object.freeze(["workflow_discover", "workflow_get"]);

export const EXEC_OPS = Object.freeze(["workflow_execute", "workflow_status", "workflow_cancel"]);

export const EXECUTION_STATES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "no_panel",
  "no_profile"
]);

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "no_panel", "no_profile"]);

export class WorkflowMcpError extends Error {
  // codes: UNKNOWN_OPERATION, UPDATE_REQUIRED, NOT_AUTHORIZED, NO_PANEL,
  // NO_PROFILE, STALE_EXECUTION, INVALID_EXEC_ARGS
  constructor(code, message, details) {
    super(message);
    this.name = "WorkflowMcpError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Guard the discovery channel: agent discovery can never manage workflows
 * or approve anything. Any CRUD/exec op arriving over discovery throws
 * NOT_AUTHORIZED instead of executing.
 */
export function assertDiscoveryNotAuthority(op) {
  if (TRUSTED_CRUD_OPS.includes(op) && op !== "workflow_get" && op !== "workflow_list") {
    throw new WorkflowMcpError("NOT_AUTHORIZED", `discovery channel op "${op}" is not authorized: management requires trusted user/application authority`);
  }
  if (EXEC_OPS.includes(op)) {
    throw new WorkflowMcpError("NOT_AUTHORIZED", `discovery channel op "${op}" is not authorized: discovery alone cannot execute a workflow`);
  }
  return true;
}

/** Stale/unknown peers get an explicit update error — never a weaker path. */
export function stalePeerError(op, version) {
  return new WorkflowMcpError(
    "UPDATE_REQUIRED",
    `workflow op "${op}" (v${version ?? "unknown"}) is not supported by this companion (v${WORKFLOW_MCP_VERSION}); update the companion and retry through the versioned op — no legacy fallback is attempted.`,
    { updateRequired: true, op, version: version ?? null, supportedVersion: WORKFLOW_MCP_VERSION }
  );
}

/** Validate an op name against the versioned surface. */
export function validateWorkflowMcpOp(op, { version = WORKFLOW_MCP_VERSION } = {}) {
  const known = [...TRUSTED_CRUD_OPS, ...EXEC_OPS, ...DISCOVERY_OPS.filter((d) => !TRUSTED_CRUD_OPS.includes(d))];
  if (!known.includes(op)) throw stalePeerError(op, version);
  if (version !== WORKFLOW_MCP_VERSION) throw stalePeerError(op, version);
  return true;
}

/**
 * Validate the legacy `shortcuts_execute` arguments WITHOUT inventing
 * fields: exactly { tabId, shortcutId?, command? }. Returns a routing
 * decision: workflow-addressed requests carry the workflow id in the
 * existing shortcutId/command slot; everything else passes through to the
 * existing operation byte-for-byte (ordinary MCP independence preserved).
 */
export function validateShortcutsExecuteCompat(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, code: "INVALID_EXEC_ARGS", message: "shortcuts_execute requires an arguments object with tabId" };
  }
  const { tabId, shortcutId, command } = args;
  if (typeof tabId !== "number" || !Number.isFinite(tabId)) {
    return { ok: false, code: "INVALID_EXEC_ARGS", message: "shortcuts_execute requires a numeric tabId" };
  }
  if (shortcutId !== undefined && (typeof shortcutId !== "string" || !shortcutId.trim())) {
    return { ok: false, code: "INVALID_EXEC_ARGS", message: "shortcutId, when given, must be a nonempty string" };
  }
  if (command !== undefined && (typeof command !== "string" || !command.trim())) {
    return { ok: false, code: "INVALID_EXEC_ARGS", message: "command, when given, must be a nonempty string" };
  }
  const target = (shortcutId || "").trim() || (command || "").trim();
  if (!target) {
    return { ok: false, code: "INVALID_EXEC_ARGS", message: "shortcuts_execute requires shortcutId or command" };
  }
  return { ok: true, tabId, shortcutId: (shortcutId || "").trim() || null, command: (command || "").trim() || null, target, passthrough: true };
}

/** Explicit no-panel result: the MCP caller, not a silent drop. */
export function noPanelResult(executionId, detail) {
  return { executionId, status: "no_panel", detail: detail || "no panel is attached to receive the workflow handoff; the request was not executed" };
}

/** Explicit no-profile result: execution needs a verified profile. */
export function noProfileResult(executionId, detail) {
  return { executionId, status: "no_profile", detail: detail || "no verified provider profile is selected; the request was not executed" };
}

/**
 * Pure in-memory async execution registry (identity/status/cancel).
 * Persistence of execution records is the run's own transcript concern;
 * this registry is the status/cancel surface the MCP schemas promise.
 */
export function createExecutionRegistry() {
  const executions = new Map();
  let seq = 0;

  function start({ workflowId, workflowVersion, tabId, redactedParams }) {
    seq += 1;
    const executionId = `wfexec_${Date.now().toString(36)}_${seq}`;
    const record = {
      executionId,
      workflowId,
      workflowVersion,
      tabId,
      redactedParams: { ...(redactedParams || {}) },
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ status: "pending", at: new Date().toISOString() }]
    };
    executions.set(executionId, record);
    return { ...record };
  }

  function transition(executionId, status, detail) {
    const record = executions.get(executionId);
    if (!record) {
      throw new WorkflowMcpError("STALE_EXECUTION", `unknown execution "${executionId}" — it may have expired or belong to a restarted companion`);
    }
    if (TERMINAL_STATES.has(record.status)) {
      throw new WorkflowMcpError("STALE_EXECUTION", `execution "${executionId}" is already terminal (${record.status})`);
    }
    if (!EXECUTION_STATES.includes(status)) {
      throw new WorkflowMcpError("INVALID_EXEC_ARGS", `unknown execution status "${status}"`);
    }
    record.status = status;
    record.updatedAt = new Date().toISOString();
    record.history.push({ status, at: record.updatedAt, ...(detail ? { detail } : {}) });
    return { ...record };
  }

  function status(executionId) {
    const record = executions.get(executionId);
    if (!record) {
      throw new WorkflowMcpError("STALE_EXECUTION", `unknown execution "${executionId}" — it may have expired or belong to a restarted companion`);
    }
    return { ...record };
  }

  function cancel(executionId, reason) {
    return transition(executionId, "cancelled", reason || "cancelled by request");
  }

  return { start, transition, status, cancel };
}

/**
 * Lease-acquisition ordering contract (deadlock avoidance): acquire the
 * existing browser lease FIRST, then open the panel handoff; release in
 * `finally`. Never hold the lease across an unbounded wait for panel
 * acknowledgement — bound the handoff wait, time out to no_panel, and
 * release. Returns the ordered step list executors must follow; the actual
 * lease primitives live in the session manager (out-of-scope wiring).
 */
export function acquireLeaseOrdering() {
  return Object.freeze([
    "1. acquire the existing conversation browser lease (fail closed when held by another run)",
    "2. snapshot profile/skills/budget/document binding for the execution",
    "3. open the panel handoff with a bounded wait (timeout yields no_panel)",
    "4. dispatch steps through the existing tool/skill adapter only",
    "5. release the lease in `finally`, even on cancel/timeout/failure"
  ]);
}

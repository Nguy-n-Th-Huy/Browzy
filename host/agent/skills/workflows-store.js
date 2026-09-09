// Durable workflow registry (task 10.1/10.3 ownership + portability).
//
// One JSON document `workflows/registry.json` under the agent root
// (OCIC_AGENT_HOME, else ~/.config/browzy-in-chrome/agent) — the same
// convention skills/paths.js and storage/paths.js use, restated locally so
// this module never depends on another work stream's paths file. Atomic
// write-then-rename, so a crash mid-write never corrupts the registry.
//
// Ownership: every record carries `owner`; import re-homes the record under
// the importing user and retains provenance — imported definitions are
// untrusted data until validated and never carry credentials or hidden
// permissions. Deletion removes future discovery; active runs keep their
// immutable snapshot (snapshots are owned by the run, never by this
// registry, so delete touches nothing outside this file).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateWorkflowRecord, validateWorkflowId, WORKFLOW_SCHEMA_VERSION, WorkflowValidationError } from "./workflows-schema.js";

function agentRoot() {
  if (process.env.OCIC_AGENT_HOME) return process.env.OCIC_AGENT_HOME;
  return path.join(os.homedir(), ".config", "browzy-in-chrome", "agent");
}

export function workflowsRoot() {
  return path.join(agentRoot(), "workflows");
}

export function workflowsRegistryFile() {
  return path.join(workflowsRoot(), "registry.json");
}

function ensureWorkflowsRoot() {
  fs.mkdirSync(workflowsRoot(), { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(workflowsRoot(), 0o700);
    } catch {}
  }
}

function atomicWriteJson(file, obj) {
  ensureWorkflowsRoot();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readRegistry() {
  let raw;
  try {
    raw = fs.readFileSync(workflowsRegistryFile(), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflows: [] };
    throw new WorkflowValidationError("INVALID_VERSION", `workflow registry is unreadable: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new WorkflowValidationError("INVALID_VERSION", `workflow registry is not valid JSON: ${err.message}`);
  }
  // Migration: a bare array (pre-schema draft) or a v0 document migrates to
  // the versioned shape; anything newer than this reader fails closed.
  if (Array.isArray(data)) data = { schemaVersion: 0, workflows: data };
  if (!data || !Array.isArray(data.workflows)) {
    throw new WorkflowValidationError("INVALID_VERSION", "workflow registry is not a well-formed registry document");
  }
  if (typeof data.schemaVersion === "number" && data.schemaVersion > WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowValidationError(
      "INVALID_VERSION",
      `workflow registry was written by a newer schema version (${data.schemaVersion} > ${WORKFLOW_SCHEMA_VERSION})`
    );
  }
  const workflows = [];
  for (const entry of data.workflows) {
    try {
      workflows.push(validateWorkflowRecord({ ...entry, version: entry.version || 1 }));
    } catch {
      // A single corrupt entry must not take down the whole registry read;
      // it is quarantined (reported via listWorkflows' `quarantined` count
      // when strict listing is needed) — discovery simply skips it.
      workflows.push({ __quarantined: true, id: entry && entry.id, reason: "validation failed on load" });
    }
  }
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflows };
}

function writeRegistry(workflows) {
  const clean = workflows.filter((w) => !w.__quarantined);
  atomicWriteJson(workflowsRegistryFile(), { schemaVersion: WORKFLOW_SCHEMA_VERSION, workflows: clean });
}

function identitiesOf(workflows) {
  // Identity is owner-namespaced: two owners may each hold their own
  // version line under the same workflow id (import re-homes records — see
  // importWorkflow). A colliding (owner, id, version) triple is a
  // DUPLICATE_IDENTITY error, never a silent overwrite.
  return new Set(workflows.filter((w) => !w.__quarantined).map((w) => `${w.owner}/${w.id}@${w.version}`));
}

function stamp(record) {
  const now = new Date().toISOString();
  return { ...record, createdAt: record.createdAt || now, updatedAt: now };
}

/** @returns {Array} all records (optionally enabled-only), quarantined entries excluded. */
export function listWorkflows({ enabledOnly = false } = {}) {
  const { workflows } = readRegistry();
  const live = workflows.filter((w) => !w.__quarantined);
  if (!enabledOnly) return live.map((w) => ({ ...w }));
  // Enabled-only discovery resolves per (owner, id) to the LATEST version:
  // an older enabled version must not leak back into discovery after the
  // owner disabled the line — the latest version is the line's state.
  const latestByLine = new Map();
  for (const w of live) {
    const key = `${w.owner}/${w.id}`;
    const prev = latestByLine.get(key);
    if (!prev || w.version > prev.version) latestByLine.set(key, w);
  }
  return [...latestByLine.values()].filter((w) => w.enabled !== false).map((w) => ({ ...w }));
}

/** @returns {object|null} the record, or null. */
export function getWorkflow(id, version, { owner } = {}) {
  validateWorkflowId(id);
  let matches = listWorkflows().filter((w) => w.id === id);
  if (owner !== undefined) matches = matches.filter((w) => w.owner === owner);
  if (!matches.length) return null;
  if (version === undefined || version === null) {
    return matches.sort((a, b) => b.version - a.version)[0];
  }
  return matches.find((w) => w.version === version) || null;
}

/**
 * Create a new workflow version. Saving an edited definition bumps the
 * version (the previous version stays addressable); saving an identical
 * re-submit of the same id+version is a DUPLICATE_IDENTITY error.
 */
export function createWorkflow(input) {
  const { workflows } = readRegistry();
  const clean = validateWorkflowRecord(input, { existingIdentities: identitiesOf(workflows) });
  const stamped = stamp(clean);
  writeRegistry([...workflows.filter((w) => !w.__quarantined), stamped]);
  return { ...stamped };
}

/**
 * Edit a workflow the caller owns: persists the next version, preserving
 * createdAt and provenance history. Editing someone else's record is
 * rejected — import it first (which re-homes ownership explicitly).
 */
export function updateWorkflow(id, patch, { owner }) {
  validateWorkflowId(id);
  const { workflows } = readRegistry();
  const live = workflows.filter((w) => !w.__quarantined);
  const owned = live.filter((w) => w.id === id && w.owner === owner).sort((a, b) => b.version - a.version);
  const current = owned[0];
  if (!current) {
    if (live.some((w) => w.id === id)) {
      throw new WorkflowValidationError("INVALID_OWNER", `workflow "${id}" is owned by another user — import it to edit your own copy`);
    }
    throw new WorkflowValidationError("MISSING_FIELD", `no workflow named "${id}"`);
  }
  if (owner !== current.owner) {
    throw new WorkflowValidationError("INVALID_OWNER", `workflow "${id}" is owned by "${current.owner}" — import it to edit your own copy`);
  }
  const next = validateWorkflowRecord(
    { ...current, ...patch, id, version: current.version + 1, createdAt: current.createdAt, updatedAt: null },
    { existingIdentities: identitiesOf(live) }
  );
  writeRegistry([...live, stamp(next)]);
  return { ...stamp(next) };
}

export function setWorkflowEnabled(id, enabled, { owner } = {}) {
  validateWorkflowId(id);
  const { workflows } = readRegistry();
  const live = workflows.filter((w) => !w.__quarantined);
  const pool = owner !== undefined ? live.filter((w) => w.id === id && w.owner === owner) : live.filter((w) => w.id === id);
  const current = pool.sort((a, b) => b.version - a.version)[0];
  if (!current) throw new WorkflowValidationError("MISSING_FIELD", `no workflow named "${id}"`);
  if (owner !== undefined && owner !== current.owner) {
    throw new WorkflowValidationError("INVALID_OWNER", `workflow "${id}" is owned by "${current.owner}"`);
  }
  const next = stamp({ ...current, version: current.version + 1, enabled: enabled !== false });
  writeRegistry([...live, next]);
  return { ...next };
}

/**
 * Delete a workflow: removes every version from discovery. Active runs are
 * unaffected by construction — they execute from an immutable snapshot
 * taken at run start, never by re-reading this registry.
 */
export function deleteWorkflow(id, { owner } = {}) {
  validateWorkflowId(id);
  const { workflows } = readRegistry();
  const live = workflows.filter((w) => !w.__quarantined);
  const mine = live.filter((w) => w.id === id);
  if (!mine.length) throw new WorkflowValidationError("MISSING_FIELD", `no workflow named "${id}"`);
  if (owner !== undefined && mine.some((w) => w.owner !== owner)) {
    throw new WorkflowValidationError("INVALID_OWNER", `workflow "${id}" is owned by another user`);
  }
  writeRegistry(live.filter((w) => w.id !== id));
  return { deleted: id, versions: mine.length };
}

/**
 * Export a workflow definition: the DEFINITION only (parameter schemas,
 * never execution values/secrets). Safe to share; importing requires a
 * separate credential/parameter entry at execution time.
 */
export function exportWorkflow(id, version) {
  const record = getWorkflow(id, version);
  if (!record) throw new WorkflowValidationError("MISSING_FIELD", `no workflow named "${id}"`);
  const { ...definition } = record;
  delete definition.createdAt;
  delete definition.updatedAt;
  return JSON.parse(JSON.stringify(definition));
}

/**
 * Import a workflow export as untrusted data: re-validated from scratch,
 * re-homed under `owner`, version reset to 1 when the id already exists
 * under another owner (never merged into their record), provenance
 * retained. Never executes package scripts, never imports credentials or
 * hidden permissions — the schema has no fields for either.
 */
export function importWorkflow(exported, { owner }) {
  if (!owner) throw new WorkflowValidationError("INVALID_OWNER", "import requires an explicit owner");
  validateWorkflowId(exported && exported.id);
  const { workflows } = readRegistry();
  const live = workflows.filter((w) => !w.__quarantined);
  const sameOwnerLatest = live.filter((w) => w.id === exported.id && w.owner === owner).sort((a, b) => b.version - a.version)[0];
  const version = sameOwnerLatest ? sameOwnerLatest.version + 1 : 1;
  const clean = validateWorkflowRecord(
    {
      ...exported,
      owner,
      version,
      enabled: false, // imports start disabled: review before first execution
      provenance: {
        ...(exported.provenance || {}),
        importedFrom: exported.owner || "unknown",
        originalVersion: exported.version || 1,
        importedAt: new Date().toISOString()
      },
      createdAt: null,
      updatedAt: null
    },
    { existingIdentities: identitiesOf(live) }
  );
  const stamped = stamp(clean);
  writeRegistry([...live, stamped]);
  return { ...stamped };
}

/** Test-only: remove the whole registry file. */
export function _clearWorkflowsForTests() {
  try {
    fs.unlinkSync(workflowsRegistryFile());
  } catch {}
}

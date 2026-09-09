// Exact workflow discovery matching + parameter validation/redaction
// (tasks 10.3, 10.6 support).
//
// Domain matching uses parsed, normalized host rules — NEVER substring
// matching. `example.com` matches exactly `example.com`; a `*.example.com`
// constraint additionally matches subdomains (`a.example.com`) but never
// the bare domain and never a superstring host (`notexample.com`).
// Persistent workflow domain/scope constraints are kept separate from
// per-execution nonces (see newExecutionNonce/buildExecutionScope): the
// former live on the record, the latter is minted fresh per execution and
// never persisted.

import crypto from "node:crypto";

import { SUPPORTED_PARAM_TYPES } from "./workflows-schema.js";

export function normalizeHost(host) {
  if (typeof host !== "string") return null;
  let h = host.trim().toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return null;
  return h;
}

/** Extract the host from a URL string; null when unparseable. */
export function hostOfUrl(url) {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Exact normalized match of one host against one constraint pattern.
 * @returns {boolean}
 */
export function domainMatches(host, pattern) {
  const h = normalizeHost(host);
  if (!h || typeof pattern !== "string") return false;
  const p = pattern.trim().toLowerCase();
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h !== base && h.endsWith(`.${base}`);
  }
  return h === p;
}

/**
 * Decide whether a workflow is discoverable in the current bound context.
 * Exposes only enabled workflows whose declared domain/document
 * constraints match; anything else yields { match: false, reason } — never
 * an execution.
 */
export function matchWorkflowToContext(workflow, context = {}) {
  if (!workflow || typeof workflow !== "object") return { match: false, reason: "unknown_workflow" };
  if (workflow.enabled === false) return { match: false, reason: "disabled" };
  const domains = Array.isArray(workflow.domainConstraints)
    ? workflow.domainConstraints
    : Array.isArray(workflow.domainConstraints && workflow.domainConstraints.domains)
      ? workflow.domainConstraints.domains
      : [];
  if (domains.length) {
    const host = normalizeHost(context.host);
    if (!host) return { match: false, reason: "no_bound_host" };
    const ok = domains.some((d) => domainMatches(host, d));
    if (!ok) return { match: false, reason: "domain_mismatch" };
  }
  const doc = workflow.documentConstraints || {};
  if (doc.requireBoundDocument === true && !context.hasBoundDocument) {
    return { match: false, reason: "no_bound_document" };
  }
  return { match: true };
}

/**
 * Validate execution parameters against the workflow's parameter schema.
 * Required/optional, type, range (min/max on numbers and string lengths),
 * enum, and pattern are all enforced BEFORE any browser action; secret
 * values are accepted as strings and NEVER echoed in the failure reason.
 */
export function validateWorkflowParams(workflow, params) {
  const schema = (workflow && workflow.parameterSchema) || {};
  const given = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const values = {};
  for (const [name, decl] of Object.entries(schema)) {
    const value = given[name];
    if (value === undefined || value === null) {
      if (decl.required === true) {
        return { ok: false, reason: `missing required parameter "${name}"`, field: name };
      }
      if (decl.default !== undefined) values[name] = decl.default;
      continue;
    }
    const type = decl.type === "secret" ? "string" : decl.type;
    if (typeof value !== type || (type === "number" && !Number.isFinite(value))) {
      return { ok: false, reason: `parameter "${name}" must be a ${decl.type}`, field: name };
    }
    if (Array.isArray(decl.enum) && !decl.enum.includes(value)) {
      return { ok: false, reason: `parameter "${name}" must be one of: ${decl.enum.map((v) => JSON.stringify(v)).join(", ")}`, field: name };
    }
    if (decl.min !== undefined || decl.max !== undefined) {
      const size = type === "number" ? value : value.length;
      if (decl.min !== undefined && size < decl.min) {
        return { ok: false, reason: `parameter "${name}" is below the minimum`, field: name };
      }
      if (decl.max !== undefined && size > decl.max) {
        return { ok: false, reason: `parameter "${name}" is above the maximum`, field: name };
      }
    }
    if (decl.pattern !== undefined && !new RegExp(decl.pattern).test(value)) {
      return { ok: false, reason: `parameter "${name}" does not match the required pattern`, field: name };
    }
    values[name] = value;
  }
  for (const name of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      return { ok: false, reason: `undeclared parameter "${name}"`, field: name };
    }
  }
  return { ok: true, values };
}

const SECRET_KEY_PATTERN = /api_?key|secret|token|password|credential|auth/i;
export const REDACTED_PARAM_MASK = "[redacted]";

/**
 * Redact secret-bearing parameter values for previews and transcripts:
 * every `secret`-typed parameter plus any defensively matched key name.
 * Returns a COPY; the input values object is never mutated.
 */
export function redactWorkflowParams(workflow, values) {
  const schema = (workflow && workflow.parameterSchema) || {};
  const out = {};
  for (const [name, value] of Object.entries(values || {})) {
    const decl = schema[name];
    if ((decl && decl.type === "secret") || SECRET_KEY_PATTERN.test(name)) {
      out[name] = REDACTED_PARAM_MASK;
    } else if (typeof value === "string" && SUPPORTED_PARAM_TYPES.includes("string")) {
      out[name] = value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Mint a fresh per-execution nonce, separate from persistent workflow scope. */
export function newExecutionNonce() {
  return `wfex_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Split an execution into its persistent scope (workflow identity/version/
 * domains — stable, reviewable) and its per-execution envelope (nonce,
 * timestamp, redacted params — never persisted on the record).
 */
export function buildExecutionScope({ workflow, redactedParams }) {
  return {
    scope: {
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      owner: workflow.owner,
      domainConstraints: [...(workflow.domainConstraints || [])]
    },
    execution: {
      executionNonce: newExecutionNonce(),
      startedAt: new Date().toISOString(),
      params: { ...(redactedParams || {}) }
    }
  };
}

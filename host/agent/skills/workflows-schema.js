// Versioned workflow record schema (P2 reusable workflows, task 10.1).
//
// A workflow is DATA, not a second executor (design decision 8): a validated
// definition whose steps map onto the existing skill/tool dispatch path.
// Exact persisted fields:
//
//   id, version, owner, name, description, parameterSchema,
//   domainConstraints, documentConstraints, steps, provenance,
//   requiredCapabilities, enabled, createdAt, updatedAt
//
// Validation rejects: missing fields, unsupported steps, undeclared
// parameters, unsafe capabilities, malformed domains, duplicate identities,
// ambiguous parameter schemas, and path traversal in id/owner. A workflow
// definition can never auto-approve a sensitive step: an `autoApprove` (or
// equivalent) field anywhere in the record is itself a validation error.

export const WORKFLOW_SCHEMA_VERSION = 1;

export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const WORKFLOW_OWNER_PATTERN = /^[A-Za-z0-9_@.+-]{1,128}$/;

/** The only step kinds a record may declare. Anything else (shell, cdp,
 *  eval, exec, script, ...) is an unsafe capability and rejected. */
export const SUPPORTED_STEP_KINDS = Object.freeze(["skill", "tool", "message"]);

export const SUPPORTED_PARAM_TYPES = Object.freeze(["string", "number", "boolean", "secret"]);

export const SENSITIVE_STEP_CLASSES = Object.freeze([
  "send",
  "submit",
  "payment",
  "confirmation",
  "unknown-target"
]);

export class WorkflowValidationError extends Error {
  // codes: MISSING_FIELD, INVALID_ID, INVALID_OWNER, INVALID_NAME,
  // DUPLICATE_IDENTITY, UNSUPPORTED_STEP, UNSAFE_CAPABILITY, INVALID_PARAMS,
  // AMBIGUOUS_PARAM_SCHEMA, INVALID_DOMAIN, PATH_TRAVERSAL,
  // AUTO_APPROVE_FORBIDDEN, INVALID_VERSION
  constructor(code, message, details) {
    super(message);
    this.name = "WorkflowValidationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new WorkflowValidationError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkflowId(id) {
  if (typeof id !== "string" || !WORKFLOW_ID_PATTERN.test(id)) {
    fail("INVALID_ID", `workflow id must be 1-64 letters, digits, "_" or "-" (got ${JSON.stringify(id)})`);
  }
  if (id === "." || id === "..") fail("PATH_TRAVERSAL", `workflow id "${id}" is not a safe path segment`);
  return id;
}

export function validateWorkflowOwner(owner) {
  if (typeof owner !== "string" || !WORKFLOW_OWNER_PATTERN.test(owner)) {
    fail("INVALID_OWNER", `workflow owner must be 1-128 safe characters (got ${JSON.stringify(owner)})`);
  }
  if (owner.includes("..") || owner.includes("/") || owner.includes("\\")) {
    fail("PATH_TRAVERSAL", `workflow owner "${owner}" is not a safe path segment`);
  }
  return owner;
}

function validateDomainPattern(pattern) {
  if (typeof pattern !== "string" || !pattern.trim()) fail("INVALID_DOMAIN", "domain constraint must be a nonempty string");
  const p = pattern.trim().toLowerCase();
  const bare = p.startsWith("*.") ? p.slice(2) : p;
  // Hostname syntax: labels of alphanumerics/hyphens, dots between, no
  // empty labels, no ports/paths/schemes/userinfo. A single "*" or a
  // substring fragment is never a valid constraint.
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(bare)) {
    fail("INVALID_DOMAIN", `malformed domain constraint ${JSON.stringify(pattern)}`);
  }
  if (p === "*" || bare.includes("*")) fail("INVALID_DOMAIN", `malformed domain constraint ${JSON.stringify(pattern)}`);
  return p;
}

/**
 * Validate a parameter schema: a plain object mapping parameter names to
 * { type, required?, enum?, min?, max?, pattern?, default?, description? }.
 * Rejects ambiguous schemas (unknown type, empty enum, min>max, bad regex,
 * illegal names) rather than guessing at execution time.
 */
export function validateParameterSchema(schema) {
  if (schema === undefined || schema === null) return {};
  if (!isPlainObject(schema)) fail("INVALID_PARAMS", "parameterSchema must be an object mapping names to declarations");
  const out = {};
  for (const [name, decl] of Object.entries(schema)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      fail("INVALID_PARAMS", `invalid parameter name ${JSON.stringify(name)}`);
    }
    if (!isPlainObject(decl)) fail("INVALID_PARAMS", `parameter "${name}" must be an object declaration`);
    if (!SUPPORTED_PARAM_TYPES.includes(decl.type)) {
      fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" has unknown type ${JSON.stringify(decl.type)}`);
    }
    if (decl.enum !== undefined) {
      if (!Array.isArray(decl.enum) || decl.enum.length === 0) {
        fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" declares an empty enum`);
      }
      for (const v of decl.enum) {
        if (typeof v !== decl.type && !(decl.type === "secret" && typeof v === "string")) {
          fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" enum value ${JSON.stringify(v)} does not match type "${decl.type}"`);
        }
      }
    }
    if (decl.min !== undefined || decl.max !== undefined) {
      if (decl.type !== "number" && decl.type !== "string") {
        fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" uses min/max on non-sized type "${decl.type}"`);
      }
      if (decl.min !== undefined && decl.max !== undefined && decl.min > decl.max) {
        fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" has min > max`);
      }
    }
    if (decl.pattern !== undefined) {
      if (decl.type !== "string" && decl.type !== "secret") {
        fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" uses pattern on non-string type "${decl.type}"`);
      }
      try {
        new RegExp(decl.pattern);
      } catch {
        fail("AMBIGUOUS_PARAM_SCHEMA", `parameter "${name}" has an invalid pattern`);
      }
    }
    out[name] = {
      type: decl.type,
      required: decl.required === true,
      ...(decl.enum !== undefined ? { enum: [...decl.enum] } : {}),
      ...(decl.min !== undefined ? { min: decl.min } : {}),
      ...(decl.max !== undefined ? { max: decl.max } : {}),
      ...(decl.pattern !== undefined ? { pattern: decl.pattern } : {}),
      ...(decl.default !== undefined ? { default: decl.default } : {}),
      ...(typeof decl.description === "string" ? { description: decl.description } : {})
    };
  }
  return out;
}

const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function validateSteps(steps, parameterSchema) {
  if (!Array.isArray(steps) || steps.length === 0) {
    fail("MISSING_FIELD", "workflow must declare a nonempty ordered steps array");
  }
  if (steps.length > 64) fail("UNSUPPORTED_STEP", "workflow declares more than 64 steps");
  const declared = new Set(Object.keys(parameterSchema));
  return steps.map((step, index) => {
    if (!isPlainObject(step)) fail("UNSUPPORTED_STEP", `step at index ${index} must be an object`);
    const { kind, ref, args, actionClass, ...rest } = step;
    if (!SUPPORTED_STEP_KINDS.includes(kind)) {
      fail(
        kind === undefined ? "MISSING_FIELD" : "UNSUPPORTED_STEP",
        `step at index ${index} has unsupported kind ${JSON.stringify(kind)} (allowed: ${SUPPORTED_STEP_KINDS.join(", ")})`
      );
    }
    // No bypass channel: a step can never carry its own authorization.
    for (const key of Object.keys(rest)) {
      if (/^(autoApprove|auto-approve|skipApproval|preApproved|allowWithoutApproval)$/i.test(key)) {
        fail("AUTO_APPROVE_FORBIDDEN", `step at index ${index} declares forbidden approval bypass field "${key}"`);
      }
    }
    if (kind === "message") {
      if (typeof ref !== "string" || !ref.trim()) fail("UNSUPPORTED_STEP", `message step at index ${index} needs a nonempty text ref`);
      return { kind, ref: ref.trim(), ...(actionClass ? { actionClass } : {}) };
    }
    if (typeof ref !== "string" || !ref.trim()) {
      fail("UNSUPPORTED_STEP", `${kind} step at index ${index} needs a nonempty ref`);
    }
    const cleanRef = ref.trim();
    if (kind === "skill" && !SKILL_NAME_PATTERN.test(cleanRef)) {
      fail("UNSUPPORTED_STEP", `skill step at index ${index} has an invalid skill ref ${JSON.stringify(ref)}`);
    }
    if (kind === "tool" && !TOOL_NAME_PATTERN.test(cleanRef)) {
      fail("UNSUPPORTED_STEP", `tool step at index ${index} has an invalid tool ref ${JSON.stringify(ref)}`);
    }
    if (args !== undefined && !isPlainObject(args)) {
      fail("UNSUPPORTED_STEP", `${kind} step at index ${index} args must be a plain object`);
    }
    const cleanArgs = args ? { ...args } : {};
    // Every `{{param}}` template referenced by args must be declared.
    const templateRefs = new Set();
    const scan = (node) => {
      if (typeof node === "string") {
        for (const m of node.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) templateRefs.add(m[1]);
      } else if (Array.isArray(node)) {
        for (const v of node) scan(v);
      } else if (isPlainObject(node)) {
        for (const v of Object.values(node)) scan(v);
      }
    };
    scan(cleanArgs);
    for (const name of templateRefs) {
      if (!declared.has(name)) {
        fail("INVALID_PARAMS", `${kind} step at index ${index} references undeclared parameter "{{${name}}}"`);
      }
    }
    return {
      kind,
      ref: cleanRef,
      ...(Object.keys(cleanArgs).length ? { args: cleanArgs } : {}),
      ...(typeof actionClass === "string" && actionClass ? { actionClass } : {})
    };
  });
}

/**
 * Validate a full workflow record. `existingIdentity` is the set of
 * "owner/id@version" strings already in the registry — a colliding triple
 * is a DUPLICATE_IDENTITY error, never a silent overwrite.
 */
export function validateWorkflowRecord(input, { existingIdentities } = {}) {
  if (!isPlainObject(input)) fail("MISSING_FIELD", "workflow must be an object");
  if ("autoApprove" in input || "skipApproval" in input || "preApproved" in input) {
    fail("AUTO_APPROVE_FORBIDDEN", "workflow records must never declare auto-approval");
  }
  const { id, version, owner, name, description, parameterSchema, domainConstraints, documentConstraints, steps, provenance, requiredCapabilities, enabled } = input;
  validateWorkflowId(id);
  validateWorkflowOwner(owner);
  if (typeof name !== "string" || !name.trim() || name.trim().length > 128) {
    fail("INVALID_NAME", "workflow name must be a nonempty string of at most 128 characters");
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 2000)) {
    fail("MISSING_FIELD", "workflow description must be a string of at most 2000 characters");
  }
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    fail("INVALID_VERSION", "workflow version must be a positive integer");
  }
  const cleanParams = validateParameterSchema(parameterSchema);
  let cleanDomains = [];
  if (domainConstraints !== undefined) {
    const list = Array.isArray(domainConstraints) ? domainConstraints : domainConstraints.domains;
    if (!Array.isArray(list)) fail("INVALID_DOMAIN", "domainConstraints must be an array of domain patterns");
    cleanDomains = list.map(validateDomainPattern);
  }
  let cleanDoc = {};
  if (documentConstraints !== undefined) {
    if (!isPlainObject(documentConstraints)) fail("INVALID_DOMAIN", "documentConstraints must be an object");
    cleanDoc = {
      ...(documentConstraints.requireBoundDocument === true ? { requireBoundDocument: true } : {})
    };
  }
  const cleanSteps = validateSteps(steps, cleanParams);
  if (requiredCapabilities !== undefined) {
    if (!Array.isArray(requiredCapabilities)) fail("UNSAFE_CAPABILITY", "requiredCapabilities must be an array");
    for (const cap of requiredCapabilities) {
      if (typeof cap !== "string" || !TOOL_NAME_PATTERN.test(cap) && !SKILL_NAME_PATTERN.test(cap)) {
        fail("UNSAFE_CAPABILITY", `unsupported required capability ${JSON.stringify(cap)}`);
      }
      if (/^(shell|exec|cdp|eval|browser_launch|nativeMessaging)$/i.test(cap)) {
        fail("UNSAFE_CAPABILITY", `workflow requires unsafe capability "${cap}"`);
      }
    }
  }
  const identity = `${owner}/${id}@${version || 1}`;
  if (existingIdentities && existingIdentities.has(identity)) {
    fail("DUPLICATE_IDENTITY", `workflow identity "${identity}" already exists`);
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    version: version || 1,
    owner,
    name: name.trim(),
    description: typeof description === "string" ? description : "",
    parameterSchema: cleanParams,
    domainConstraints: cleanDomains,
    documentConstraints: cleanDoc,
    steps: cleanSteps,
    provenance: isPlainObject(provenance) ? { ...provenance } : {},
    requiredCapabilities: Array.isArray(requiredCapabilities) ? [...requiredCapabilities] : [],
    enabled: enabled !== false,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : null,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null
  };
}

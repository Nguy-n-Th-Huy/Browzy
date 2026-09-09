// Minimal SKILL.md frontmatter reader.
//
// This intentionally does not pull in a YAML dependency: host/package.json
// and its lockfile are out of scope for this change (owned by the SDK-gate
// work in group 1), so this parses only the flat subset of YAML that a
// SKILL.md frontmatter block actually needs - "key: value" lines, booleans,
// quoted strings, and a single-line inline list like "[a, b, c]". Anything
// it cannot confidently parse (nested mappings, multi-line block scalars,
// duplicate delimiters) is rejected as invalid metadata rather than guessed
// at - the same "reject, don't guess" posture the rest of the catalog uses
// for untrusted input.
//
// Field names below (`name`, `description`, `version`, `user-invocable`,
// `disable-model-invocation`) are exactly the ones design.md section 7 names
// as the catalog's "SKILL.md frontmatter invocation flags". The
// `allowed-tools` field is this module's own interpretation, documented in
// reports/07-skills-evidence.md: no upstream SDK frontmatter field for
// "this skill needs shell/write access" was verifiable offline in this
// session, so `allowed-tools` (an array of tool names, e.g. `[Read, Bash]`)
// is read as a declared capability request and checked against the
// supported set in capabilities.js.

import { SkillValidationError } from "./errors.js";

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TRAVERSAL_PATTERN = /(\.\.|[\\/])/;

export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r\n|\n/);

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i] === undefined || lines[i].trim() !== "---") {
    throw new SkillValidationError(
      "INVALID_METADATA",
      'SKILL.md must start with a YAML frontmatter block delimited by "---".'
    );
  }
  i++;

  const block = [];
  let closed = false;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closed = true;
      break;
    }
    block.push(lines[i]);
  }
  if (!closed) {
    throw new SkillValidationError(
      "INVALID_METADATA",
      'SKILL.md frontmatter is missing its closing "---".'
    );
  }

  const meta = {};
  for (const rawLine of block) {
    if (rawLine.trim() === "") continue;
    if (rawLine.startsWith(" ") || rawLine.startsWith("\t")) {
      // Indentation signals a nested mapping, a multi-line block scalar, or
      // a list item under a key - none of which this flat parser supports.
      // Reject rather than silently flattening it into an unrelated key.
      throw new SkillValidationError(
        "INVALID_METADATA",
        `Unsupported SKILL.md frontmatter line: "${rawLine}". Only flat, unindented "key: value" entries are supported.`
      );
    }
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      throw new SkillValidationError(
        "INVALID_METADATA",
        `Unsupported SKILL.md frontmatter line: "${rawLine}". Only flat "key: value" entries are supported.`
      );
    }
    meta[m[1].toLowerCase()] = parseScalar(m[2]);
  }
  return meta;
}

function parseScalar(value) {
  const v = value.trim();
  if (v === "") return "";
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => stripQuotes(s.trim()));
  }
  return stripQuotes(v);
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function validateSkillName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new SkillValidationError(
      "INVALID_METADATA",
      'SKILL.md frontmatter is missing a non-empty "name".'
    );
  }
  // Checked before the generic pattern so a traversal attempt gets its own
  // specific, distinguishable rejection code rather than a generic one.
  if (TRAVERSAL_PATTERN.test(name)) {
    throw new SkillValidationError(
      "PATH_TRAVERSAL",
      `Skill name "${name}" contains a path separator or "..", which is not allowed.`
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new SkillValidationError(
      "INVALID_METADATA",
      `Skill name "${name}" must contain only letters, digits, "_" or "-" (1-64 characters).`
    );
  }
  return name;
}

export function validateDescription(description) {
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new SkillValidationError(
      "INVALID_METADATA",
      'SKILL.md frontmatter is missing a non-empty "description".'
    );
  }
  return description;
}

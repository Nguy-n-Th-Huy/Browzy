// Compose and persist an operator-typed skill (name + description + Markdown
// body, typed straight into the Settings > Skills form) as a real,
// host-owned SKILL.md package, then hand it to the SAME import/refresh
// pipeline import.js already exposes — see import.js's own header for why
// `importSkill(sourceDir)`/`refreshSkill(name)` must stay the only two ways
// a catalog record is ever created or updated: `source` on the record is a
// real folder `refreshSkill()` re-reads, and manage.js's remove/enable/
// disable all assume a normal catalog record. This module never writes the
// catalog store directly and never forks a second validation path — it only
// ever produces a folder for import.js to validate exactly like a
// user-picked one.
//
// Where a typed skill's folder lives: skillsRoot()/authored/<name>/SKILL.md
// (paths.js's assertSafeSegment() guards the <name> segment the same way
// every other on-disk skill path segment already is).
//
// Edit semantics (deliberate product decision, not a limitation worked
// around): re-submitting the form for a skill this module itself created
// rewrites that skill's own SKILL.md in place and calls refreshSkill(), the
// same "update content in place" operation the "Nạp lại" button already
// exposes — it does NOT hit import.js's DUPLICATE_NAME guard, because that
// guard exists to stop two DIFFERENT source folders from claiming the same
// name, not to stop this feature from editing the one folder it owns.
//
// A record this module did NOT write — one that entered the catalog through
// the folder-import path the product no longer exposes — is editable too,
// but only when the caller passes `editing: true`. That flag carries the
// operator's intent, which the name alone cannot: someone composing a brand
// new skill who happens to pick a taken name must still be told the name is
// taken, never silently overwrite the skill holding it. Editing such a
// record ADOPTS it: its `source` is re-pointed at this module's own
// authored folder before the refresh, so the app stops depending on a
// directory outside itself that it no longer reads and that may be gone.
// Without the flag, the DUPLICATE_NAME rejection is unchanged, and it still
// fires before anything is written to disk.

import fs from "node:fs";
import path from "node:path";
import { validateSkillName, validateDescription } from "./frontmatter.js";
import { importSkill, refreshSkill } from "./import.js";
import { setInvocationFlags } from "./manage.js";
import { getSkillRecord, upsertSkillRecord } from "./catalog-store.js";
import { skillsRoot, ensureSkillsRoot, assertSafeSegment } from "./paths.js";
import { SkillValidationError } from "./errors.js";

const SKILL_MANIFEST_NAME = "SKILL.md";
const AUTHORED_DIRNAME = "authored";

export function authoredSkillsRoot() {
  return path.join(skillsRoot(), AUTHORED_DIRNAME);
}

// `name` is already validated by validateSkillName() by the time any caller
// in this module reaches here, but assertSafeSegment() re-checks anyway —
// same "a path segment is validated at the point of use, not just once
// upstream" posture paths.js's own snapshotDir() documents.
export function authoredSkillDir(name) {
  assertSafeSegment(name, "name");
  return path.join(authoredSkillsRoot(), name);
}

// True only when `existingSource` is the real, on-disk authored folder for
// `name` — i.e. a catalog record this exact module produced. A record whose
// source is some other folder (a plain folder import, or one that happens to
// share a name but was never actually written by authorSkill) is never
// treated as ours, so it still falls through to import.js's normal
// DUPLICATE_NAME rejection.
function isOwnAuthoredSource(existingSource, name) {
  if (typeof existingSource !== "string" || !existingSource) return false;
  let canonicalAuthoredDir;
  try {
    canonicalAuthoredDir = fs.realpathSync(authoredSkillDir(name));
  } catch {
    return false; // nothing on disk at the authored path — can't be its source
  }
  return path.resolve(existingSource) === canonicalAuthoredDir;
}

// A description becomes one flat "key: value" frontmatter line
// (frontmatter.js's parseFrontmatter() supports nothing richer), so it is
// always emitted double-quoted: parseScalar() only strips a matching outer
// quote pair, never interprets anything inside it, so this is a safe,
// lossless round trip for ANY description text — including one that would
// otherwise be misread as a YAML-ish scalar (e.g. a description whose text
// is literally "true", or that starts with "[") — without needing any
// escaping logic this parser doesn't have. A stray newline the operator
// pasted in is collapsed to a space first: a raw newline would otherwise
// split the frontmatter block into an extra, unindented "line" the parser
// rejects outright.
function quoteFrontmatterScalar(value) {
  const flattened = String(value).replace(/\r\n|\r|\n/g, " ").trim();
  return `"${flattened}"`;
}

function normalizeAllowedTools(allowedTools) {
  if (allowedTools == null) return [];
  const list = Array.isArray(allowedTools) ? allowedTools : String(allowedTools).split(",");
  return list
    .map((t) => String(t).replace(/\r\n|\r|\n/g, " ").trim())
    .filter((t) => t.length > 0);
}

function composeSkillMd({ name, description, body, allowedTools }) {
  const lines = ["---", `name: ${name}`, `description: ${quoteFrontmatterScalar(description)}`];
  if (allowedTools.length > 0) {
    lines.push(`allowed-tools: [${allowedTools.join(", ")}]`);
  }
  lines.push("---", "");
  const normalizedBody = String(body).replace(/\r\n/g, "\n").replace(/^\n+/, "");
  const bodyWithTrailingNewline = normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`;
  return lines.join("\n") + bodyWithTrailingNewline;
}

/**
 * @param {object} input
 * @param {string} input.name - SKILL.md frontmatter `name` (validateSkillName()).
 * @param {string} input.description - SKILL.md frontmatter `description` (validateDescription()).
 * @param {string} input.body - Markdown body written below the frontmatter block. Required, non-empty.
 * @param {boolean} [input.userInvocable] - product-owned catalog flag, applied via manage.js's setInvocationFlags() (see import.js's own header on why this is never a frontmatter field).
 * @param {boolean} [input.modelInvocable] - same as above.
 * @param {string[]|string} [input.allowedTools] - optional `allowed-tools` frontmatter hint (array, or a comma-separated string from a plain text field).
 * @param {boolean} [input.editing] - the caller is deliberately editing the existing record of this name, not creating a new skill. Only this makes a record whose `source` lies outside this module's own authored folder editable (adopting it — see the module header); omitted or false keeps the DUPLICATE_NAME rejection exactly as it was.
 * @returns {Promise<object>} the resulting catalog record, exactly as importSkill()/refreshSkill() already return it.
 */
export async function authorSkill(input = {}) {
  const { name, description, body, userInvocable, modelInvocable, allowedTools, editing } = input;

  // Validate every field BEFORE touching disk at all — same "reject, don't
  // guess" posture as import.js's own full-validation-before-any-write rule.
  // A bad name gets its own distinct code, NOT import.js's generic
  // INVALID_METADATA — the operator typed straight into a "Tên skill"
  // field, so errors-ui.js must be able to say "your name is invalid",
  // never "check your folder's SKILL.md" (there is no folder here). A
  // traversal-shaped name is left as PATH_TRAVERSAL unchanged: it already
  // has its own specific, correctly-worded error.
  let validName;
  try {
    validName = validateSkillName(name);
  } catch (err) {
    if (err instanceof SkillValidationError && err.code === "INVALID_METADATA") {
      throw new SkillValidationError("INVALID_NAME", err.message);
    }
    throw err;
  }
  const validDescription = validateDescription(description);
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new SkillValidationError("INVALID_METADATA", "Skill body (Markdown content) must be a non-empty string.");
  }
  const cleanAllowedTools = normalizeAllowedTools(allowedTools);

  const existing = getSkillRecord(validName);
  const ownAuthoredSource = existing ? isOwnAuthoredSource(existing.source, validName) : false;
  // A record this module did not write — one that entered the catalog through
  // the folder-import path this product no longer exposes — can still be
  // edited, but ONLY when the caller says it is deliberately editing that
  // record. The name alone cannot carry that intent: an operator composing a
  // brand-new skill who happens to pick a name already taken must still be
  // told so, never silently overwrite someone else's skill. So the decision
  // is the caller's, passed explicitly, and its absence keeps the original
  // rejection byte-for-byte.
  const adoptingForeignSource = !!existing && !ownAuthoredSource && editing === true;
  const editingOwnSkill = ownAuthoredSource || adoptingForeignSource;
  if (existing && !editingOwnSkill) {
    throw new SkillValidationError(
      "DUPLICATE_NAME",
      `A skill named "${validName}" is already imported from a different source (${existing.source}). Remove it first, or choose a different name.`
    );
  }

  const content = composeSkillMd({ name: validName, description: validDescription, body, allowedTools: cleanAllowedTools });
  const dir = authoredSkillDir(validName);
  ensureSkillsRoot();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_MANIFEST_NAME), content, "utf-8");

  // Adopting a foreign-sourced record means its `source` still points at the
  // folder it was imported from — a path outside this application, which may
  // no longer exist and which this product deliberately no longer reads.
  // Re-point it at the authored folder just written above BEFORE refreshing,
  // so refreshSkill() re-reads the operator's edit rather than the old
  // folder. This is the whole adoption: one field, then the ordinary
  // in-place update path. Everything else about the record — enabled state,
  // invocation flags, snapshot identity — is carried forward by refresh.
  if (adoptingForeignSource) {
    upsertSkillRecord({ ...existing, source: dir });
  }

  // Same underlying pipeline a folder import uses — no parallel validation,
  // no hand-written catalog record (see this module's header).
  let record = editingOwnSkill ? await refreshSkill(validName) : await importSkill(dir);

  if (typeof userInvocable === "boolean" || typeof modelInvocable === "boolean") {
    record = setInvocationFlags(validName, {
      userInvocable: typeof userInvocable === "boolean" ? userInvocable : record.userInvocable,
      modelInvocable: typeof modelInvocable === "boolean" ? modelInvocable : record.modelInvocable
    });
  }
  return record;
}

// Exposed for the settings UI (and tests) to tell an authored skill apart
// from a folder-imported one. NOTE on remove: manage.js's removeSkill() is
// intentionally left unmodified by this feature (see this module's header —
// "manage.js's remove/enable/disable all assume a normal catalog record")
// and only ever deletes the catalog record and the snapshot copy, never
// `record.source` — so removing an authored skill leaves its
// skillsRoot()/authored/<name>/SKILL.md folder behind on disk as a harmless
// orphan, exactly like removing a folder-imported skill leaves the
// operator's own folder behind. This helper exists for a future UI that
// wants to say something more specific than that generic "source untouched"
// message for the authored case (e.g. offer to also delete the orphan); no
// caller does that yet.
export function isAuthoredSkillRecord(record) {
  return !!record && isOwnAuthoredSource(record.source, record.name);
}

// Catalog lifecycle operations: list, enable, disable, remove.
//
// enableSkill is the "never silently enable shell access" gate: a skill
// whose manifest declared an unsupported capability (capabilities.js) can
// never transition to enabled, so it can never appear in a session's
// allowlist (session-workspace.js only copies enabled entries) and can
// never pass assertSlashDispatchAllowed (dispatch.js checks `enabled` too).

import fs from "node:fs";
import { loadCatalog, getSkillRecord, upsertSkillRecord, removeSkillRecord } from "./catalog-store.js";
import { snapshotDir } from "./paths.js";
import { SkillCapabilityError, SkillNotFoundError } from "./errors.js";

// The enabled, approved catalog for display and dispatch filtering (design.md
// section 7 / specs/agent-skills). Returns every imported skill (enabled or
// not) with its `enabled` flag, so Settings > Skills can show and toggle
// disabled entries too.
export async function listCatalog() {
  return loadCatalog().skills.map((s) => ({ ...s }));
}

export function getSkill(name) {
  return getSkillRecord(name);
}

export function enableSkill(name) {
  const record = getSkillRecord(name);
  if (!record) throw new SkillNotFoundError(name);
  if (record.unsupportedCapabilities && record.unsupportedCapabilities.length > 0) {
    throw new SkillCapabilityError(
      "UNSUPPORTED_CAPABILITY",
      `Skill "${name}" requires capabilities this assistant does not support (${record.unsupportedCapabilities.join(", ")}) and cannot be enabled.`,
      { name, unsupportedCapabilities: record.unsupportedCapabilities }
    );
  }
  const updated = { ...record, enabled: true, updatedAt: Date.now() };
  upsertSkillRecord(updated);
  return updated;
}

export function disableSkill(name) {
  const record = getSkillRecord(name);
  if (!record) throw new SkillNotFoundError(name);
  const updated = { ...record, enabled: false, updatedAt: Date.now() };
  upsertSkillRecord(updated);
  return updated;
  // Interrupting an already-active run that has this skill in its bound
  // snapshot is a session/run-lifecycle concern owned by group 3 (tasks.md
  // 3.5); this function's contract ends at making the catalog change
  // immediately visible to listCatalog()/assertSlashDispatchAllowed and to
  // the next buildSessionSkills() call. See reports/07-skills-evidence.md.
}

export function removeSkill(name) {
  const record = getSkillRecord(name);
  if (!record) throw new SkillNotFoundError(name);
  removeSkillRecord(name);
  try {
    fs.rmSync(snapshotDir(name), { recursive: true, force: true });
  } catch {}
  // record.source (the user's original folder) is never touched, by design.
  return true;
}

// userInvocable/modelInvocable are product-owned catalog flags (see
// import.js's readManifestMeta doc comment: the pinned SDK defines no
// per-package SKILL.md frontmatter field for either, verified by reading
// `sdk.d.ts` directly - only a session-level `skillOverrides` option
// exists). A future Settings > Skills UI (task 7.3, out of scope here) is
// the expected caller, but the underlying catalog mutation belongs with the
// rest of this lifecycle surface, alongside enable/disable/refresh/remove.
export function setInvocationFlags(name, { userInvocable, modelInvocable } = {}) {
  const record = getSkillRecord(name);
  if (!record) throw new SkillNotFoundError(name);
  const updated = { ...record, updatedAt: Date.now() };
  if (typeof userInvocable === "boolean") updated.userInvocable = userInvocable;
  if (typeof modelInvocable === "boolean") updated.modelInvocable = modelInvocable;
  upsertSkillRecord(updated);
  return updated;
}

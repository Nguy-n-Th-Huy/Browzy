// Public facade for the application-owned skills catalog.
//
// The three functions design.md/tasks.md's group-3 session builder is
// documented to consume are listCatalog(), buildSessionSkills(), and
// assertSlashDispatchAllowed() - see each function's own module for the
// contract details. Everything else here is catalog-management surface for
// Settings > Skills (task 7.3, out of scope for this change) and optional
// integration points documented at their definition.

export { importSkill, refreshSkill } from "./import.js";
export { authorSkill, isAuthoredSkillRecord, authoredSkillsRoot } from "./author.js";
export { listCatalog, getSkill, enableSkill, disableSkill, removeSkill, setInvocationFlags } from "./manage.js";
export {
  buildSessionSkills,
  materializePluginFromCatalogSnapshot,
  assertCanonicalSkillResourcePath,
  SESSION_SKILLS_PLUGIN_NAME
} from "./session-workspace.js";
export { assertSlashDispatchAllowed, assertResumeSnapshotAvailable, buildSkillDispatchPrompt } from "./dispatch.js";
export { toSkillOverrideValue } from "./capabilities.js";
export {
  SkillValidationError,
  SkillPathError,
  SkillCapabilityError,
  SkillDispatchError,
  SkillSnapshotMismatchError,
  SkillNotFoundError
} from "./errors.js";

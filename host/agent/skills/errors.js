// Typed, actionable errors for the skills catalog and dispatch gate.
//
// Every error carries a stable `.code` so callers (settings UI, dispatch
// gate, tests) can branch on the failure kind without parsing message text.

export class SkillValidationError extends Error {
  // codes: INVALID_METADATA, DUPLICATE_NAME, PATH_TRAVERSAL, SYMLINK_ESCAPE,
  // NOT_A_SKILL, NOT_FOUND, INVALID_NAME (author.js only — a bad name typed
  // into the Settings > Skills authoring form; kept distinct from
  // INVALID_METADATA, which is about a folder's SKILL.md, so the UI can
  // point at the right field instead of a nonexistent folder)
  constructor(code, message) {
    super(message);
    this.name = "SkillValidationError";
    this.code = code;
  }
}

// Raised for a canonical-path violation discovered at runtime access time
// (not at import time) - e.g. a Read attempt that resolves outside a
// session's materialized skill snapshot directory. Kept distinct from
// SkillValidationError so a caller can tell "this package was rejected on
// import" apart from "this live access attempt was blocked."
export class SkillPathError extends Error {
  // codes: PATH_TRAVERSAL, SYMLINK_ESCAPE, NOT_FOUND
  constructor(code, message) {
    super(message);
    this.name = "SkillPathError";
    this.code = code;
  }
}

export class SkillCapabilityError extends Error {
  // codes: UNSUPPORTED_CAPABILITY
  constructor(code, message, details) {
    super(message);
    this.name = "SkillCapabilityError";
    this.code = code;
    this.details = details;
  }
}

export class SkillDispatchError extends Error {
  // codes: UNKNOWN_COMMAND, DISABLED, NOT_USER_INVOCABLE, UNSUPPORTED_CAPABILITY
  constructor(code, message) {
    super(message);
    this.name = "SkillDispatchError";
    this.code = code;
  }
}

export class SkillSnapshotMismatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SkillSnapshotMismatchError";
    this.code = "SNAPSHOT_UNAVAILABLE";
    this.details = details;
  }
}

export class SkillNotFoundError extends Error {
  constructor(name) {
    super(`No imported skill named "${name}".`);
    this.name = "SkillNotFoundError";
    this.code = "NOT_FOUND";
  }
}

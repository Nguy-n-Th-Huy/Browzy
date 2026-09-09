// Filesystem layout for the application-owned skill catalog and its
// immutable per-skill snapshots.
//
// Deliberately independent of host/agent/storage/paths.js (owned by a
// different, concurrently active work stream): both compute the same
// `OCIC_AGENT_HOME`-rooted directory convention, but this module does not
// import that file, so a concurrent edit there cannot change this module's
// behavior out from under it, and tests can isolate skills state without any
// cross-module coupling. See reports/07-skills-evidence.md for the rationale.
//
// Layout under the root:
//   skills/catalog.json           - one JSON document, the whole catalog
//   skills/snapshots/<name>/      - one immutable copy per imported skill,
//                                   named by the skill's own validated name
//                                   (already a safe path segment - see
//                                   frontmatter.js's NAME_PATTERN)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function agentRoot() {
  if (process.env.OCIC_AGENT_HOME) return process.env.OCIC_AGENT_HOME;
  return path.join(os.homedir(), ".config", "browzy-in-chrome", "agent");
}

export function skillsRoot() {
  return path.join(agentRoot(), "skills");
}

export function snapshotsDir() {
  return path.join(skillsRoot(), "snapshots");
}

// Snapshot directory names are always an already-validated skill name
// (frontmatter.js's NAME_PATTERN: letters/digits/_/- only, no separators, no
// ".."), but this is re-checked here too - a path segment that becomes part
// of an on-disk location gets validated at the point of use, not just once
// upstream.
export function snapshotDir(snapshotId) {
  assertSafeSegment(snapshotId, "snapshotId");
  return path.join(snapshotsDir(), snapshotId);
}

export function catalogFile() {
  return path.join(skillsRoot(), "catalog.json");
}

export function ensureSkillsRoot() {
  fs.mkdirSync(snapshotsDir(), { recursive: true });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(skillsRoot(), 0o700);
    } catch {}
  }
  return skillsRoot();
}

export function assertSafeSegment(id, label = "id") {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`invalid ${label}: ${JSON.stringify(id)}`);
  }
  return id;
}

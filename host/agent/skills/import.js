// Validated import and refresh of a skill package into the app-owned
// catalog. Neither function ever executes anything found in the source
// folder - files are only read (for the manifest and for hashing) and
// copied.

import fs from "node:fs";
import path from "node:path";
import { scanSkillSource, copyValidatedFiles } from "./source-scan.js";
import { hashFileList } from "./hash.js";
import { parseFrontmatter, validateSkillName, validateDescription } from "./frontmatter.js";
import { computeDeclaredCapabilities, detectContentCapabilities } from "./capabilities.js";
import { getSkillRecord, upsertSkillRecord } from "./catalog-store.js";
import { snapshotDir, snapshotsDir, ensureSkillsRoot } from "./paths.js";
import { SkillValidationError, SkillNotFoundError } from "./errors.js";

const SKILL_MANIFEST_NAME = "SKILL.md";

// Reads only name/description/version from SKILL.md frontmatter, plus the
// optional, tolerated (NOT SDK-verified - see capabilities.js) `allowed-tools`
// hint. `userInvocable`/`modelInvocable` are NOT sourced from frontmatter at
// all: the pinned SDK (`@anthropic-ai/claude-agent-sdk@0.3.263`) defines no
// such per-package frontmatter field (confirmed by reading `sdk.d.ts`
// directly - grep for "user-invocable"/"disable-model-invocation" across
// the whole installed package returns nothing outside one query()-level
// option's docstring). These are product-owned catalog flags instead,
// defaulted here and adjustable afterward via manage.js's
// setInvocationFlags() - see reports/07-skills-evidence.md.
function readManifestMeta(sourceDir) {
  const manifestPath = path.join(sourceDir, SKILL_MANIFEST_NAME);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch {
    throw new SkillValidationError(
      "INVALID_METADATA",
      `Skill folder is missing a top-level ${SKILL_MANIFEST_NAME}: ${sourceDir}`
    );
  }

  const meta = parseFrontmatter(raw);
  const name = validateSkillName(meta.name);
  const description = validateDescription(meta.description);
  const version = typeof meta.version === "string" && meta.version.length ? meta.version : null;

  const rawAllowedTools = meta["allowed-tools"];
  const allowedTools = Array.isArray(rawAllowedTools)
    ? rawAllowedTools
    : typeof rawAllowedTools === "string" && rawAllowedTools
      ? [rawAllowedTools]
      : [];
  const declaredCapabilities = computeDeclaredCapabilities(allowedTools);

  return { name, description, version, declaredCapabilities };
}

// Copies validated files into the snapshot store under a fresh staging
// directory, then swaps it into place with two renames (never a partial
// state visible at the final path). A prior snapshot at the same name (the
// refresh case) is moved aside first and only removed after the new one is
// safely in place, so a mid-swap failure can be rolled back.
function stageAndSwap(name, files) {
  ensureSkillsRoot();
  const finalDir = snapshotDir(name);
  const stagingDir = path.join(snapshotsDir(), `.staging-${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    copyValidatedFiles(files, stagingDir);

    let backupDir = null;
    if (fs.existsSync(finalDir)) {
      backupDir = `${finalDir}.old-${Date.now()}`;
      fs.renameSync(finalDir, backupDir);
    }
    try {
      fs.renameSync(stagingDir, finalDir);
    } catch (err) {
      if (backupDir) fs.renameSync(backupDir, finalDir);
      throw err;
    }
    if (backupDir) {
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch {}
    }
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
  }
  return finalDir;
}

export async function importSkill(sourceDir) {
  const absSource = path.resolve(sourceDir);
  const meta = readManifestMeta(absSource);

  const existing = getSkillRecord(meta.name);
  if (existing) {
    throw new SkillValidationError(
      "DUPLICATE_NAME",
      `A skill named "${meta.name}" is already imported (source: ${existing.source}). Remove it first, or use refresh to update it from its existing source.`
    );
  }

  // Full validation (including symlink/traversal checks) happens before any
  // write, so a rejected import never touches the catalog or the snapshot
  // store.
  const { canonicalRoot, files } = scanSkillSource(absSource);
  const hash = hashFileList(canonicalRoot, files.map((f) => f.rel));

  // Capability detection does NOT depend on the (optional, tolerated)
  // `allowed-tools` frontmatter key alone - a package's actual file content
  // is inspected unconditionally, so omitting that key cannot itself obtain
  // shell/write capability. See capabilities.js and
  // host/test/skills-catalog.test.mjs's "no tools frontmatter" case.
  const unsupportedCapabilities = [
    ...new Set([...meta.declaredCapabilities, ...detectContentCapabilities(files)])
  ];

  stageAndSwap(meta.name, files);

  const now = Date.now();
  const record = {
    name: meta.name,
    description: meta.description,
    source: canonicalRoot,
    snapshotId: meta.name,
    hash,
    version: meta.version,
    enabled: false,
    // Product-owned defaults (see readManifestMeta's comment above) -
    // adjustable afterward via manage.js's setInvocationFlags().
    userInvocable: true,
    modelInvocable: true,
    unsupportedCapabilities,
    importedAt: now,
    updatedAt: now
  };
  upsertSkillRecord(record);
  return record;
}

// Re-reads the already-recorded source folder, re-validates it exactly as
// import does, and re-hashes. Enabled state is preserved as-is: refresh
// updates content for future sessions, it never flips enable/disable itself.
export async function refreshSkill(name) {
  const existing = getSkillRecord(name);
  if (!existing) throw new SkillNotFoundError(name);

  const meta = readManifestMeta(existing.source);
  if (meta.name !== name) {
    throw new SkillValidationError(
      "INVALID_METADATA",
      `Refusing to refresh "${name}": its source folder's SKILL.md now declares a different name ("${meta.name}"). Remove and re-import instead.`
    );
  }

  const { canonicalRoot, files } = scanSkillSource(existing.source);
  const hash = hashFileList(canonicalRoot, files.map((f) => f.rel));
  const unsupportedCapabilities = [
    ...new Set([...meta.declaredCapabilities, ...detectContentCapabilities(files)])
  ];
  stageAndSwap(name, files);

  const record = {
    ...existing,
    description: meta.description,
    source: canonicalRoot,
    hash,
    version: meta.version,
    // userInvocable/modelInvocable are product-owned (see readManifestMeta's
    // comment) and intentionally NOT re-derived from frontmatter here -
    // `...existing` above already carries them forward unchanged. A refresh
    // updates content, it does not silently change who may invoke it.
    unsupportedCapabilities,
    updatedAt: Date.now()
  };
  upsertSkillRecord(record);
  return record;
}

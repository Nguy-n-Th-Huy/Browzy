// Validated walk of a candidate skill source folder.
//
// Every entry is checked before anything is copied: a symlink (or, on
// Windows, an NTFS junction - both report isSymbolicLink() === true and are
// resolved the same way by fs.realpathSync) must resolve inside the source
// package root, and every relative path a file will be copied to must
// resolve inside the destination root too. Rejection happens before any
// file is written, so a rejected import can never leave a partial snapshot
// behind and the existing catalog is never disturbed.
//
// This module never executes, requires, or evaluates anything it finds -
// every file is treated as opaque bytes to copy.

import fs from "node:fs";
import path from "node:path";
import { SkillValidationError } from "./errors.js";

const MAX_WALK_DEPTH = 64; // defends against a symlink cycle, not a real package shape

function isWithin(root, target) {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * @param {string} sourceDir - candidate skill package folder (as given by
 *   the user, e.g. from a folder picker)
 * @returns {{ canonicalRoot: string, files: Array<{ rel: string, sourceAbs: string }> }}
 */
export function scanSkillSource(sourceDir) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(sourceDir);
  } catch {
    throw new SkillValidationError("NOT_FOUND", `Skill source folder not found: ${sourceDir}`);
  }

  let rootStat;
  try {
    rootStat = fs.statSync(canonicalRoot);
  } catch {
    throw new SkillValidationError("NOT_FOUND", `Skill source folder not found: ${sourceDir}`);
  }
  if (!rootStat.isDirectory()) {
    throw new SkillValidationError("NOT_A_SKILL", `Skill source is not a folder: ${sourceDir}`);
  }

  const files = [];

  function walk(dirAbs, relPrefix, depth) {
    if (depth > MAX_WALK_DEPTH) {
      throw new SkillValidationError(
        "NOT_A_SKILL",
        `Skill package is nested too deeply under "${relPrefix}" (possible link cycle).`
      );
    }
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      throw new SkillValidationError("NOT_A_SKILL", `Could not read "${relPrefix || "."}": ${err.message}`);
    }

    for (const entry of entries) {
      const entryAbs = path.join(dirAbs, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = fs.realpathSync(entryAbs);
        } catch {
          throw new SkillValidationError(
            "SYMLINK_ESCAPE",
            `Skill package contains a broken or unresolvable link at "${rel}".`
          );
        }
        if (!isWithin(canonicalRoot, real)) {
          throw new SkillValidationError(
            "SYMLINK_ESCAPE",
            `Skill package contains a link at "${rel}" that escapes the package folder. Rejected before any files were copied.`
          );
        }
        const st = fs.statSync(real);
        if (st.isDirectory()) {
          walk(entryAbs, rel, depth + 1);
        } else if (st.isFile()) {
          files.push({ rel, sourceAbs: real });
        } else {
          throw new SkillValidationError("NOT_A_SKILL", `Unsupported file type at "${rel}".`);
        }
        continue;
      }

      if (entry.isDirectory()) {
        walk(entryAbs, rel, depth + 1);
        continue;
      }
      if (entry.isFile()) {
        files.push({ rel, sourceAbs: entryAbs });
        continue;
      }
      throw new SkillValidationError(
        "NOT_A_SKILL",
        `Unsupported file type at "${rel}" (only regular files and folders are supported).`
      );
    }
  }

  walk(canonicalRoot, "", 0);

  // Defense in depth: every relative path this scan produced must resolve
  // strictly inside canonicalRoot. Ordinary directory enumeration cannot
  // produce a ".."-bearing relative path, but this is cheap to check and
  // cheap to keep, and it is what a destination-side path-traversal check
  // for these same relative paths (source-scan.js's copy step, and
  // session-workspace.js's copy into a session workspace) actually relies on.
  for (const f of files) {
    const resolved = path.resolve(canonicalRoot, f.rel);
    if (!isWithin(canonicalRoot, resolved)) {
      throw new SkillValidationError(
        "PATH_TRAVERSAL",
        `Skill package entry "${f.rel}" resolves outside the package folder.`
      );
    }
  }

  return { canonicalRoot, files };
}

/**
 * Copies an already-validated file list into destDir. Every symlink
 * encountered during scanSkillSource() was already resolved to its real
 * file, so this only ever reads and writes plain files - the snapshot it
 * produces never itself contains a symlink.
 */
export function copyValidatedFiles(files, destDir) {
  for (const f of files) {
    const destAbs = path.join(destDir, f.rel);
    if (!isWithin(destDir, destAbs)) {
      // Cannot happen given the checks above, but a destination-side
      // containment check costs nothing and is the check that actually
      // matters for this function's own contract.
      throw new SkillValidationError("PATH_TRAVERSAL", `Refusing to write outside the snapshot: "${f.rel}".`);
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(f.sourceAbs, destAbs);
    try {
      fs.chmodSync(destAbs, 0o444);
    } catch {}
  }
}

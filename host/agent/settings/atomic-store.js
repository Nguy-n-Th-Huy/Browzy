// Atomic, crash-safe JSON file storage.
//
// The failure this defends against: a process killed (crash, power loss,
// forced host restart) halfway through writing the profile file must never
// leave a truncated or half-written JSON document as the file the next
// `loadProfile()` reads. The standard fix is write-temp-then-rename: write the
// full new content to a sibling temp file, fsync it, then rename it onto the
// real path. A rename onto an existing path is atomic on both NTFS and
// POSIX filesystems (the reader never observes a partial file — it sees
// either the old inode's full old bytes or the new inode's full new bytes),
// so a crash at any point before the rename leaves the last good file
// untouched, and a crash during/after the rename is not observable as
// corruption at all.
//
// `crashAfterWrite` exists only so tests can simulate "process died after the
// temp file was written but before rename" without an actual OS-level crash.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Write `data` (any JSON-serializable value) atomically to `filePath`.
 *
 * @param {string} filePath
 * @param {unknown} data
 * @param {{ crashAfterWrite?: boolean }} [opts] test-only hook: when true,
 *   the temp file is written and fsynced, then this function throws instead
 *   of renaming — simulating a process crash between the two steps.
 */
export function writeJsonAtomic(filePath, data, opts = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Unique temp name per call (not a fixed `.tmp` sibling) so two concurrent
  // writers never interleave their writes into the same temp file; only the
  // final rename — a single filesystem-level operation — is contended, and
  // the OS serializes that safely.
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);

  const json = JSON.stringify(data, null, 2);
  const fd = fs.openSync(tempPath, "w", 0o600);
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (opts.crashAfterWrite) {
    throw new Error("simulated crash after temp write, before rename (test-only)");
  }

  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw err;
  }
}

/**
 * Read and JSON.parse `filePath`.
 *
 * @param {string} filePath
 * @returns {unknown|null} parsed content, or null if the file does not exist.
 * @throws if the file exists but is not valid JSON — a corrupt *committed*
 *   file is a real problem the caller should surface, not silently swallow;
 *   this is distinct from a leftover uncommitted temp file, which this
 *   function never reads (temp files use a name that never matches
 *   `filePath` and are never renamed into place on a crashed write).
 */
export function readJsonAtomic(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip a stray BOM
  return JSON.parse(raw);
}

/**
 * Remove any leftover temp files beside `filePath` from a previous crashed
 * write. Safe to call on every load: these files were never linked to the
 * real path, so removing them can never lose committed data.
 * @param {string} filePath
 */
export function cleanupStaleTempFiles(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `.${base}.`;
  for (const entry of entries) {
    if (entry.startsWith(prefix) && entry.endsWith(".tmp")) {
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {}
    }
  }
}

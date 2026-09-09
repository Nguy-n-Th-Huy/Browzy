// write_if_changed, ported from install.sh/install.ps1.
//
// Writes `content` to `targetPath` only if it differs from what is already
// there (trailing-newline-insensitive, matching install.sh's comparison —
// bash captures both sides through command substitution, which strips
// trailing newlines before the `[ "$existing" = "$content" ]` comparison).
// A changed file is backed up to `<targetPath>.bak` FIRST, before the new
// content is written. Rerunning with unchanged inputs is then a true no-op:
// nothing is rewritten, nothing is re-backed-up.

import fs from "node:fs";
import path from "node:path";

function trimTrailingNewlines(text) {
  return text.replace(/[\r\n]+$/, "");
}

/**
 * @param {string} targetPath
 * @param {string} content
 * @returns {{status: "unchanged"|"written", path: string, backupPath: string|null}}
 */
export function writeIfChanged(targetPath, content) {
  if (fs.existsSync(targetPath)) {
    const existing = fs.readFileSync(targetPath, "utf-8");
    if (trimTrailingNewlines(existing) === trimTrailingNewlines(content)) {
      return { status: "unchanged", path: targetPath, backupPath: null };
    }
    const backupPath = `${targetPath}.bak`;
    fs.copyFileSync(targetPath, backupPath);
    fs.writeFileSync(targetPath, content);
    return { status: "written", path: targetPath, backupPath };
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  return { status: "written", path: targetPath, backupPath: null };
}

// Deterministic content hash for an imported skill snapshot.
//
// Hashes the validated (post symlink-resolution) file list, not the source
// folder's raw directory listing, so the hash reflects exactly the bytes
// that were actually copied into the snapshot. Sorted by relative path so
// the result does not depend on filesystem enumeration order.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function hashFileList(rootDir, relativePaths) {
  const sorted = [...relativePaths].sort();
  const hash = crypto.createHash("sha256");
  for (const rel of sorted) {
    const abs = path.join(rootDir, rel);
    const content = fs.readFileSync(abs);
    hash.update(rel.split(path.sep).join("/"), "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

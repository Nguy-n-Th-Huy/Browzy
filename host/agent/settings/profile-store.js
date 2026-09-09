// Versioned, atomic, non-secret profile persistence (task 4.1).
//
// Every write goes through atomic-store.js's write-temp-then-rename, so a
// crash mid-write can never corrupt the last good profile on disk — the next
// read either sees the fully-old file or the fully-new one.

import { writeJsonAtomic, readJsonAtomic, cleanupStaleTempFiles } from "./atomic-store.js";
import { ensureConfigDir, profileFilePath } from "./paths.js";
import { createEmptyProfile, isPlausibleProfile, PROFILE_SCHEMA_VERSION } from "./profile-schema.js";

/**
 * @param {{ crashAfterWrite?: boolean }} [opts] test-only atomic-write hook, forwarded as-is.
 * @returns the stored profile, or a freshly created empty one if none exists yet.
 */
export function readProfileFromDisk() {
  ensureConfigDir();
  const filePath = profileFilePath();
  cleanupStaleTempFiles(filePath);
  const loaded = readJsonAtomic(filePath);
  if (loaded === null) return null;
  if (!isPlausibleProfile(loaded)) {
    throw new Error(`stored profile at ${filePath} is not a well-formed profile object`);
  }
  if (loaded.schemaVersion > PROFILE_SCHEMA_VERSION) {
    throw new Error(
      `stored profile at ${filePath} was written by a newer schema version (${loaded.schemaVersion} > ${PROFILE_SCHEMA_VERSION})`
    );
  }
  return loaded;
}

/**
 * @param {object} profile
 * @param {{ crashAfterWrite?: boolean }} [opts]
 */
export function writeProfileToDisk(profile, opts = {}) {
  ensureConfigDir();
  writeJsonAtomic(profileFilePath(), profile, opts);
}

export { createEmptyProfile };

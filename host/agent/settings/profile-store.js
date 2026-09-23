// Versioned, atomic, non-secret profile persistence (task 4.1).
//
// Every write goes through atomic-store.js's write-temp-then-rename, so a
// crash mid-write can never corrupt the last good profile on disk — the next
// read either sees the fully-old file or the fully-new one.

import { writeJsonAtomic, readJsonAtomic, cleanupStaleTempFiles } from "./atomic-store.js";
import { ensureConfigDir, profileFilePath } from "./paths.js";
import { createEmptyProfile, isPlausibleProfile, migrateStoredTypesafeProfile, PROFILE_SCHEMA_VERSION } from "./profile-schema.js";

/**
 * The single point every reader of the stored profile goes through — which
 * makes it the single point a one-time migration can run from. A profile
 * stored with the removed `typesafe` provider type is rewritten to
 * `anthropic` here (migrateStoredTypesafeProfile, profile-schema.js) and
 * written back immediately, so the migration happens exactly once: every
 * later read sees the already-migrated `anthropic` profile and the
 * migration function's own reference check makes it a no-op from then on.
 *
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
  const migrated = migrateStoredTypesafeProfile(loaded);
  if (migrated !== loaded) {
    writeJsonAtomic(filePath, migrated);
    return migrated;
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

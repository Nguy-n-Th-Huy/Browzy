// Per-user application configuration directory for the assistant's provider
// profile.
//
// Follows the same convention already used elsewhere in this project
// (host/endpoint.js, host/native-host.js, host/parent-watch.js): a flat
// `~/.config/browzy-in-chrome/` directory on every platform, including
// Windows — this project deliberately does not split behavior across
// %APPDATA%/XDG/Library/Application Support, matching the existing
// native-messaging rendezvous and screenshot/log paths already shipped.
//
// `OCIC_AGENT_CONFIG_DIR` lets a test harness redirect the whole directory to
// a scratch location without touching a developer's real profile — the same
// pattern `OCIC_PIPE` already uses for the native-messaging address.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @returns {string} absolute path to `~/.config/browzy-in-chrome`
 *   (or the `OCIC_AGENT_CONFIG_DIR` override).
 */
export function configDir() {
  if (process.env.OCIC_AGENT_CONFIG_DIR) {
    return process.env.OCIC_AGENT_CONFIG_DIR;
  }
  return path.join(os.homedir(), ".config", "browzy-in-chrome");
}

/**
 * Ensure the config directory exists (mode 0700 where supported — this
 * directory holds non-secret profile data, but no reason to make it
 * world-readable) and return its path.
 * @returns {string}
 */
export function ensureConfigDir() {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** @returns {string} absolute path to the versioned profile JSON file. */
export function profileFilePath() {
  return path.join(configDir(), "agent-profile.json");
}

/** @returns {string} absolute path to the profile file's temp-write sibling. */
export function profileTempFilePath() {
  return path.join(configDir(), ".agent-profile.json.tmp");
}

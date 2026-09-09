// reg.exe wrapper for the Windows native-messaging registration branch —
// ported from install.sh's win_reg_add / install.ps1's Set-BrowserRegistration.
//
// Node's child_process.spawnSync passes argv elements directly to the child
// process (no shell re-parsing), so — unlike install.sh, which needed the
// `//` convention to survive Git Bash's own "/" -> path munging — plain "/"
// switches work here without any special-casing.

import { spawnSync } from "node:child_process";

/**
 * Read a registry key's default ("(Default)") value.
 *
 * @param {string} key e.g. "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.anthropic.browzy_in_chrome"
 * @returns {string|null} the value, or null if the key/value doesn't exist.
 */
export function regQueryDefaultValue(key) {
  const res = spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf-8" });
  if (res.status !== 0 || !res.stdout) return null;
  // reg.exe's output looks like:
  //   HKEY_CURRENT_USER\...\com.anthropic.browzy_in_chrome
  //       (Default)    REG_SZ    C:\path\to\manifest.json
  // Pull out everything after "REG_SZ" rather than field-splitting: the
  // (Default) label and the type column are separated by runs of spaces, and
  // a naive split would also mangle a value that itself contains spaces.
  const match = res.stdout.match(/REG_SZ\s*(.*)\r?\n?$/m);
  if (!match) return null;
  const value = match[1].replace(/\r$/, "").trim();
  return value || null;
}

/**
 * Export a registry key to a .reg backup file. Returns true on success.
 *
 * @param {string} key
 * @param {string} backupFilePath
 * @returns {boolean}
 */
export function regExportKey(key, backupFilePath) {
  const res = spawnSync("reg.exe", ["export", key, backupFilePath, "/y"], { encoding: "utf-8" });
  return res.status === 0;
}

/**
 * Set a registry key's default ("(Default)") value, creating the key if
 * needed. Returns true on success.
 *
 * @param {string} key
 * @param {string} value
 * @returns {boolean}
 */
export function regSetDefaultValue(key, value) {
  const res = spawnSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { encoding: "utf-8" });
  return res.status === 0;
}

/**
 * Delete a registry key outright (used by `browzy uninstall`).
 *
 * @param {string} key
 * @returns {boolean} true on success, or if the key was already absent.
 */
export function regDeleteKey(key) {
  const res = spawnSync("reg.exe", ["delete", key, "/f"], { encoding: "utf-8" });
  if (res.status === 0) return true;
  // "ERROR: The system was unable to find the specified registry key or value."
  // is not a failure to report — the end state (key absent) is what we want.
  return /unable to find/i.test(res.stderr || "");
}

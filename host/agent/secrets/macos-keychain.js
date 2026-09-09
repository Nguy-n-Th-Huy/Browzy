// macOS Keychain secret-store adapter.
//
// Shells out to the `security` CLI (bundled with every macOS install — no
// native addon, no new npm dependency), which stores/retrieves a generic
// password keyed by service+account.
//
// Disclosed, real limitation (not a workaround hidden as a pass): macOS's
// `security add-generic-password` has no stdin/env interface for the
// password — its only documented, non-interactive way to set one is the
// `-w <password>` argument. That means the plaintext secret is briefly
// present in this specific child process's own argv (visible to
// `ps`/Activity Monitor for the short lifetime of that one call) — a
// limitation of the platform CLI itself, not of this module's design; the
// same exposure exists for any caller of `security add-generic-password`,
// including Apple's own scripting examples. `find-generic-password`/
// `delete-generic-password` (read/delete) take no secret argument and carry
// no such exposure. This trade-off is recorded, not concealed, in
// reports/04-settings-evidence.md.
//
// BLOCKED on this development machine (Windows): this module cannot be
// exercised for real here. It is implemented against `security`'s
// documented, stable CLI surface and is exercised in the test suite against
// a fake `security`-shaped backend (see host/test/secrets-store.test.mjs).
// Reproduce the real path on macOS with:
//   node -e "import('./host/agent/secrets/macos-keychain.js').then(m=>m.macosKeychainWrite('t','s').then(()=>m.macosKeychainRead('t')).then(console.log))"

import { execFileSync } from "node:child_process";

const SERVICE = "browzy-in-chrome";

/**
 * @param {string} target used as the Keychain "account" name.
 * @param {string} secret
 */
export async function macosKeychainWrite(target, secret) {
  // `-U` updates an existing item instead of failing with "already exists".
  execFileSync("security", ["add-generic-password", "-a", target, "-s", SERVICE, "-w", secret, "-U"], { encoding: "utf-8" });
}

/**
 * @param {string} target
 * @returns {Promise<string|null>}
 */
export async function macosKeychainRead(target) {
  try {
    const stdout = execFileSync("security", ["find-generic-password", "-a", target, "-s", SERVICE, "-w"], { encoding: "utf-8" });
    return stdout.replace(/\r?\n$/, "");
  } catch (err) {
    if (err && err.status === 44) return null; // "The specified item could not be found in the keychain."
    throw err;
  }
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function macosKeychainDelete(target) {
  try {
    execFileSync("security", ["delete-generic-password", "-a", target, "-s", SERVICE], { encoding: "utf-8" });
    return true;
  } catch (err) {
    if (err && err.status === 44) return false;
    throw err;
  }
}

/** @returns {boolean} */
export function isMacosKeychainPlatform() {
  return process.platform === "darwin";
}

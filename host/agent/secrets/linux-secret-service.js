// Linux Secret Service adapter (GNOME Keyring / KWallet via the Secret
// Service D-Bus API).
//
// Shells out to `secret-tool` (from libsecret-tools — commonly preinstalled
// or available via the distro package manager; no native addon, no new npm
// dependency). `secret-tool store` reads the secret from **stdin**, never an
// argv element, so — unlike the macOS `security` CLI — there is no
// command-line exposure window here at all.
//
// BLOCKED on this development machine (Windows): this module cannot be
// exercised for real here. It is implemented against `secret-tool`'s
// documented, stable CLI surface and is exercised in the test suite against
// a fake `secret-tool`-shaped backend (see host/test/secrets-store.test.mjs).
// Reproduce the real path on Linux with:
//   node -e "import('./host/agent/secrets/linux-secret-service.js').then(m=>m.linuxSecretWrite('t','s').then(()=>m.linuxSecretRead('t')).then(console.log))"

import { execFileSync } from "node:child_process";

const ATTR_KEY = "browzy-in-chrome-target";

function attrArgs(target) {
  return [ATTR_KEY, target];
}

/**
 * @param {string} target
 * @param {string} secret
 */
export async function linuxSecretWrite(target, secret) {
  execFileSync("secret-tool", ["store", "--label", `Browzy in Chrome (${target})`, ...attrArgs(target)], {
    input: secret,
    encoding: "utf-8"
  });
}

/**
 * @param {string} target
 * @returns {Promise<string|null>}
 */
export async function linuxSecretRead(target) {
  try {
    const stdout = execFileSync("secret-tool", ["lookup", ...attrArgs(target)], { encoding: "utf-8" });
    return stdout.replace(/\r?\n$/, "");
  } catch (err) {
    // secret-tool exits nonzero with empty stdout when nothing matches.
    if (err && (err.status === 1 || err.status === 2)) return null;
    throw err;
  }
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export async function linuxSecretDelete(target) {
  try {
    execFileSync("secret-tool", ["clear", ...attrArgs(target)], { encoding: "utf-8" });
    return true;
  } catch (err) {
    if (err && (err.status === 1 || err.status === 2)) return false;
    throw err;
  }
}

/** @returns {boolean} */
export function isLinuxSecretServicePlatform() {
  return process.platform === "linux";
}

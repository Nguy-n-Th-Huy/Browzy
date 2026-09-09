// Secret-store interface: one dispatcher in front of the platform-specific
// adapters (task 4.1). The rest of the codebase (host/agent/settings/profile.js)
// never imports a platform adapter directly — it only calls the functions
// here, so "which OS store" is decided in exactly one place.
//
// Availability is never assumed from `process.platform` alone: a real
// write+read+delete probe with a throwaway value confirms the backend
// actually works on this machine (the credential helper binary might be
// missing, the Secret Service daemon might not be running, policy might
// block it, etc.). If no OS store is confirmed available, persistence fails
// **explicitly** — this module never falls back to a plaintext file. The
// only sanctioned fallback is an explicit, caller-opted-in memory-only mode.

import { windowsCredWrite, windowsCredRead, windowsCredDelete, isWindowsCredentialManagerPlatform } from "./windows-credential-manager.js";
import { macosKeychainWrite, macosKeychainRead, macosKeychainDelete, isMacosKeychainPlatform } from "./macos-keychain.js";
import { linuxSecretWrite, linuxSecretRead, linuxSecretDelete, isLinuxSecretServicePlatform } from "./linux-secret-service.js";
import { memoryWrite, memoryRead, memoryDelete } from "./memory-store.js";

export class SecureStorageUnavailableError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`no OS credential store is available (${reason}); persistence requires explicit memory-only mode`);
    this.name = "SecureStorageUnavailableError";
    this.code = "SECURE_STORAGE_UNAVAILABLE";
    this.reason = reason;
  }
}

// --- structural guard against a real, reproduced test-isolation bug ---
//
// `OCIC_AGENT_CONFIG_DIR` (host/agent/settings/paths.js) lets a test harness
// redirect the non-secret profile JSON to a scratch directory. It does NOT,
// and structurally cannot, scope any of the adapters above: every OS
// credential store here (Windows Credential Manager / macOS Keychain /
// Linux Secret Service) is a single, GLOBAL, machine-wide namespace keyed
// only by the `target` string this dispatcher is given. A test that reaches
// a real (non-memory) backend using the exact target string a genuine
// installation uses therefore reads, overwrites, or deletes that real
// user's actual secret — this was reproduced live: running the offline
// suite silently destroyed a real, working Anthropic API key (see
// reports/09-live-gate-evidence.md and reports/04-settings-evidence.md,
// "CRITICAL finding").
//
// This guard makes that entire class of collision structurally impossible
// rather than relying on every test author remembering to pick a safe
// target: whenever OCIC_AGENT_CONFIG_DIR is set (which only ever happens
// under a test harness — no real installation sets it), any real-backend
// storeSecret/readSecret/deleteSecret call against the exact target a real
// "default" profile resolves to (host/agent/settings/profile.js's
// `credentialTarget("default")`, i.e. `browzy-in-chrome/settings/default`)
// throws immediately instead of touching the OS store. A memory-only call is
// always exempt (it can never reach a real OS store, by construction), and
// any other target string — in particular a dedicated, non-"default"
// profileId or a one-off test target — is unaffected.
export class UnsafeTestCredentialTargetError extends Error {
  /** @param {string} target */
  constructor(target) {
    super(
      `refusing to touch the real, machine-wide OS credential store for target "${target}" while ` +
        `${TEST_HARNESS_ENV_VAR} is set. The OS credential store is a global namespace and is NOT scoped by ` +
        `${TEST_HARNESS_ENV_VAR} — only the non-secret profile JSON is. This is the exact collision that once ` +
        `silently destroyed a real user's stored API key. Use a dedicated, non-"default" test-only profile ID ` +
        `(or target string) for any check that exercises a real, non-memory secret-store backend.`
    );
    this.name = "UnsafeTestCredentialTargetError";
    this.code = "UNSAFE_TEST_CREDENTIAL_TARGET";
    this.target = target;
  }
}

export const TEST_HARNESS_ENV_VAR = "OCIC_AGENT_CONFIG_DIR";

// Mirrors host/agent/settings/profile.js's `credentialTarget(profileId)`
// (`browzy-in-chrome/settings/${profileId}`) for the one profileId
// every real installation uses. Kept as a literal here — rather than
// importing settings/profile-schema.js's DEFAULT_PROFILE_ID — so this
// generic, lower-level secrets module has no dependency on the
// higher-level settings module; if that naming scheme ever changes, update
// this constant to match.
export const PRODUCTION_DEFAULT_CREDENTIAL_TARGET = "browzy-in-chrome/settings/default";

function isRealBackendOperation(opts) {
  return !(opts && (opts.memoryOnly || opts.backend === "memory"));
}

function assertSafeCredentialTarget(target, opts) {
  if (!isRealBackendOperation(opts)) return; // memory-only can never touch a real OS store
  if (!process.env[TEST_HARNESS_ENV_VAR]) return; // not running under a test harness
  if (target !== PRODUCTION_DEFAULT_CREDENTIAL_TARGET) return; // not the exact global key a real "default" install uses
  throw new UnsafeTestCredentialTargetError(target);
}

const OS_BACKENDS = {
  "windows-credential-manager": {
    platform: isWindowsCredentialManagerPlatform,
    write: async (t, s) => windowsCredWrite(t, s),
    read: async (t) => windowsCredRead(t),
    delete: async (t) => windowsCredDelete(t)
  },
  "macos-keychain": {
    platform: isMacosKeychainPlatform,
    write: macosKeychainWrite,
    read: macosKeychainRead,
    delete: macosKeychainDelete
  },
  "linux-secret-service": {
    platform: isLinuxSecretServicePlatform,
    write: linuxSecretWrite,
    read: linuxSecretRead,
    delete: linuxSecretDelete
  }
};

const MEMORY_BACKEND = {
  write: async (t, s) => memoryWrite(t, s),
  read: async (t) => memoryRead(t),
  delete: async (t) => memoryDelete(t)
};

function backendForPlatform() {
  for (const [name, backend] of Object.entries(OS_BACKENDS)) {
    if (backend.platform()) return { name, backend };
  }
  return null;
}

const PROBE_TARGET_PREFIX = "browzy-in-chrome/availability-probe/";

/**
 * Confirm the platform's OS credential store actually works here, with a
 * real write+read+delete of a throwaway value — not just a platform check.
 *
 * @returns {Promise<{ available: true, backendName: string } | { available: false, backendName: string|null, reason: string }>}
 */
export async function detectSecureStorage() {
  const match = backendForPlatform();
  if (!match) {
    return { available: false, backendName: null, reason: `no supported OS credential store adapter for platform "${process.platform}"` };
  }
  const probeTarget = `${PROBE_TARGET_PREFIX}${process.pid}-${Date.now()}`;
  const probeValue = "probe";
  try {
    await match.backend.write(probeTarget, probeValue);
    const readBack = await match.backend.read(probeTarget);
    await match.backend.delete(probeTarget);
    if (readBack !== probeValue) {
      return { available: false, backendName: match.name, reason: "probe write/read round trip did not return the same value" };
    }
    return { available: true, backendName: match.name };
  } catch (err) {
    try {
      await match.backend.delete(probeTarget);
    } catch {}
    return { available: false, backendName: match.name, reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * @param {string} target
 * @param {string} secret
 * @param {{ memoryOnly?: boolean }} [opts]
 * @returns {Promise<{ backend: string }>}
 * @throws {SecureStorageUnavailableError} if no OS store is available and
 *   `memoryOnly` was not explicitly requested.
 */
export async function storeSecret(target, secret, opts = {}) {
  assertSafeCredentialTarget(target, opts);
  if (opts.memoryOnly) {
    await MEMORY_BACKEND.write(target, secret);
    return { backend: "memory" };
  }
  const detected = await detectSecureStorage();
  if (!detected.available) {
    throw new SecureStorageUnavailableError(detected.reason);
  }
  await OS_BACKENDS[detected.backendName].write(target, secret);
  return { backend: detected.backendName };
}

/**
 * @param {string} target
 * @param {{ memoryOnly?: boolean, backend?: string }} [opts] `backend`, when
 *   given, reads from that specific backend rather than re-detecting — used
 *   when the caller already knows (and persisted) which backend a profile's
 *   credential was written to.
 * @returns {Promise<string|null>}
 */
export async function readSecret(target, opts = {}) {
  assertSafeCredentialTarget(target, opts);
  if (opts.memoryOnly || opts.backend === "memory") {
    return MEMORY_BACKEND.read(target);
  }
  if (opts.backend && OS_BACKENDS[opts.backend]) {
    return OS_BACKENDS[opts.backend].read(target);
  }
  const detected = await detectSecureStorage();
  if (!detected.available) return null;
  return OS_BACKENDS[detected.backendName].read(target);
}

/**
 * @param {string} target
 * @param {{ memoryOnly?: boolean, backend?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function deleteSecret(target, opts = {}) {
  assertSafeCredentialTarget(target, opts);
  if (opts.memoryOnly || opts.backend === "memory") {
    return MEMORY_BACKEND.delete(target);
  }
  if (opts.backend && OS_BACKENDS[opts.backend]) {
    return OS_BACKENDS[opts.backend].delete(target);
  }
  const detected = await detectSecureStorage();
  if (!detected.available) return false;
  return OS_BACKENDS[detected.backendName].delete(target);
}

export { OS_BACKENDS };

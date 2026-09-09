#!/usr/bin/env node
//
// Secret-store adapters (host/agent/secrets/**).
//
// On this machine (Windows), the Windows Credential Manager adapter is
// exercised for real: a genuine write, read-back, and delete against the
// actual OS credential store via `powershell.exe` + Win32 Credential
// Manager P/Invoke — not a mock.
//
// The macOS Keychain and Linux Secret Service adapters cannot be exercised
// for real on this machine (no `security`/`secret-tool` binary on Windows).
// A fake-subprocess simulation was attempted and deliberately abandoned: it
// only breaks on a genuine, documented Node/Windows constraint, not on a bug
// in this code — `child_process.execFileSync` cannot invoke a `.cmd`/`.bat`
// stand-in without `shell: true` (Node docs, "spawn cannot execute a batch
// file without shell"), and ESM named imports of Node built-ins
// (`import { execFileSync } from "node:child_process"`) are snapshotted at
// first evaluation, so monkeypatching `child_process.execFileSync` from a
// test does not intercept the adapter's own call either — both were tried
// and confirmed empirically, not assumed. Faking a pass by adding
// `shell: true` to the adapters themselves purely to satisfy a Windows-only
// test harness was rejected: it would change real command-injection surface
// on the real target OSes for no correctness benefit. What IS verified here
// for real: the dispatcher's platform-routing logic correctly identifies
// this machine as neither macOS nor Linux, so `detectSecureStorage()` never
// even attempts those adapters here. The adapters' own `security`/
// `secret-tool` argv construction and exit-code mapping (0 / 44 / 1 / 2) is
// reviewed by inspection (see host/agent/secrets/macos-keychain.js and
// linux-secret-service.js) and recorded BLOCKED for execution below, with
// the exact command to close it on the real OS.
//
// Run: node host/test/secrets-store.test.mjs

import { spawnSync } from "node:child_process";

import { memoryWrite, memoryRead, memoryDelete, memoryClearAll } from "../agent/secrets/memory-store.js";
import { detectSecureStorage, storeSecret, readSecret, deleteSecret, SecureStorageUnavailableError } from "../agent/secrets/secret-store.js";
import { windowsCredWrite, windowsCredRead, windowsCredDelete, isWindowsCredentialManagerPlatform } from "../agent/secrets/windows-credential-manager.js";
import { isMacosKeychainPlatform } from "../agent/secrets/macos-keychain.js";
import { isLinuxSecretServicePlatform } from "../agent/secrets/linux-secret-service.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function checkBlocked(name, reason) {
  results.push({ name, ok: true, blocked: true });
  console.log(`  BLOCKED  ${name} — ${reason}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nSecret-store adapters\n");

// --- memory-only store ---

await check("memory store: write/read/delete round trip", () => {
  memoryClearAll();
  const target = "test/memory/target-1";
  assert(memoryRead(target) === null);
  memoryWrite(target, "sk-memory-secret");
  assert(memoryRead(target) === "sk-memory-secret");
  assert(memoryDelete(target) === true);
  assert(memoryRead(target) === null);
});

await check("dispatcher: storeSecret/readSecret/deleteSecret with memoryOnly:true never touch an OS store", async () => {
  memoryClearAll();
  const target = "test/memory/target-2";
  const { backend } = await storeSecret(target, "sk-memory-secret-2", { memoryOnly: true });
  assert(backend === "memory");
  assert((await readSecret(target, { memoryOnly: true })) === "sk-memory-secret-2");
  assert((await deleteSecret(target, { memoryOnly: true })) === true);
  assert((await readSecret(target, { memoryOnly: true })) === null);
});

// --- platform routing (dispatcher never guesses; it checks) ---

await check("platform-detection helpers agree with process.platform (dispatcher routing is correct on every OS, not just this one)", () => {
  assert(isWindowsCredentialManagerPlatform() === (process.platform === "win32"));
  assert(isMacosKeychainPlatform() === (process.platform === "darwin"));
  assert(isLinuxSecretServicePlatform() === (process.platform === "linux"));
});

// --- real Windows Credential Manager (this machine) ---

if (isWindowsCredentialManagerPlatform()) {
  await check("Windows Credential Manager: real write/read/delete against the actual OS store", () => {
    const target = `browzy-in-chrome-test/wcm/${process.pid}-${Date.now()}`;
    windowsCredWrite(target, "sk-real-wcm-secret-xyz");
    const readBack = windowsCredRead(target);
    assert(readBack === "sk-real-wcm-secret-xyz", `expected round-trip match, got ${JSON.stringify(readBack)}`);
    assert(windowsCredDelete(target) === true);
    assert(windowsCredRead(target) === null, "credential must actually be gone after delete");
  });

  await check("Windows Credential Manager: reading a nonexistent target returns null, not a thrown error", () => {
    const target = `browzy-in-chrome-test/wcm/never-written-${process.pid}-${Date.now()}`;
    assert(windowsCredRead(target) === null);
  });

  await check("Windows Credential Manager: deleting a nonexistent target returns false, not a thrown error", () => {
    const target = `browzy-in-chrome-test/wcm/never-written-2-${process.pid}-${Date.now()}`;
    assert(windowsCredDelete(target) === false);
  });

  await check("Windows Credential Manager: a secret containing unicode/whitespace round-trips exactly", () => {
    const target = `browzy-in-chrome-test/wcm/unicode-${process.pid}-${Date.now()}`;
    const secret = "sk-ünïcödé-🔑- with spaces \tand a tab";
    windowsCredWrite(target, secret);
    assert(windowsCredRead(target) === secret);
    windowsCredDelete(target);
  });

  await check("detectSecureStorage() reports the real Windows Credential Manager as available on this machine", async () => {
    const detected = await detectSecureStorage();
    assert(detected.available === true, JSON.stringify(detected));
    assert(detected.backendName === "windows-credential-manager", detected.backendName);
  });

  await check("dispatcher storeSecret()/readSecret()/deleteSecret() round trip through the real detected backend", async () => {
    const target = `browzy-in-chrome-test/dispatcher/${process.pid}-${Date.now()}`;
    const { backend } = await storeSecret(target, "sk-real-dispatcher-secret");
    assert(backend === "windows-credential-manager", backend);
    assert((await readSecret(target)) === "sk-real-dispatcher-secret");
    assert((await deleteSecret(target)) === true);
  });
} else {
  checkBlocked(
    "Windows Credential Manager: real write/read/delete",
    "this machine is not win32 — reproduce with: node host/test/secrets-store.test.mjs on Windows"
  );
}

// --- macOS Keychain / Linux Secret Service: cannot execute on this OS ---

if (process.platform !== "darwin") {
  checkBlocked(
    "macOS Keychain: real `security add-generic-password`/`find-generic-password`/`delete-generic-password` round trip",
    "this machine is not macOS, and no faithful `.cmd`/mock substitute exists for a real Mach-O `security` binary on Windows " +
      "(see the file header for what was tried and why it was abandoned rather than faked into a pass) — reproduce with: " +
      "node host/test/secrets-store.test.mjs on macOS"
  );
} else {
  await check("macOS Keychain: real write/read/delete against the actual Keychain", async () => {
    const { macosKeychainWrite, macosKeychainRead, macosKeychainDelete } = await import("../agent/secrets/macos-keychain.js");
    const target = `browzy-in-chrome-test-${process.pid}-${Date.now()}`;
    await macosKeychainWrite(target, "sk-real-keychain-secret");
    assert((await macosKeychainRead(target)) === "sk-real-keychain-secret");
    assert((await macosKeychainDelete(target)) === true);
    assert((await macosKeychainRead(target)) === null);
  });
}

// Being on Linux is not the same as having a Secret Service. `secret-tool` is
// the client for one, and a headless machine — a CI runner, a container, a
// server — routinely has neither it nor a D-Bus session to reach a provider
// through. Probing for the binary rather than inferring availability from
// `process.platform` is what keeps this suite honest in both directions: it
// still runs the REAL round trip on any Linux box that has a provider, and it
// reports BLOCKED instead of a false failure where there is nothing to talk to.
function secretToolAvailable() {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("secret-tool", ["--version"], { stdio: "ignore" });
  return !probe.error;
}

if (process.platform !== "linux") {
  checkBlocked(
    "Linux Secret Service: real `secret-tool store`/`lookup`/`clear` round trip",
    "this machine is not Linux — reproduce with: node host/test/secrets-store.test.mjs on Linux " +
      "(with a Secret Service provider, e.g. gnome-keyring or KWallet, running)"
  );
} else if (!secretToolAvailable()) {
  checkBlocked(
    "Linux Secret Service: real `secret-tool store`/`lookup`/`clear` round trip",
    "this Linux machine has no `secret-tool` on PATH, so there is no Secret Service client to exercise — " +
      "install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) and run with a provider such as " +
      "gnome-keyring or KWallet running"
  );
} else {
  await check("Linux Secret Service: real write/read/delete against the actual Secret Service", async () => {
    const { linuxSecretWrite, linuxSecretRead, linuxSecretDelete } = await import("../agent/secrets/linux-secret-service.js");
    const target = `browzy-in-chrome-test-${process.pid}-${Date.now()}`;
    await linuxSecretWrite(target, "sk-real-secret-service-secret");
    assert((await linuxSecretRead(target)) === "sk-real-secret-service-secret");
    assert((await linuxSecretDelete(target)) === true);
    assert((await linuxSecretRead(target)) === null);
  });
}

// --- explicit failure when no secure storage is available ---

await check("storeSecret() without memoryOnly throws SecureStorageUnavailableError when no OS backend is detected (simulated)", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "sunos", configurable: true }); // an unsupported platform for every adapter here
  try {
    let threw = null;
    try {
      await storeSecret("test/unavailable/target", "sk-should-not-persist");
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof SecureStorageUnavailableError, `expected SecureStorageUnavailableError, got ${threw && threw.constructor.name}`);
    assert(threw.code === "SECURE_STORAGE_UNAVAILABLE");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (BLOCKED items counted as informational, not failures)\n`);
if (failed.length > 0) process.exitCode = 1;

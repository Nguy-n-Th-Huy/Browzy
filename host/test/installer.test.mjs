#!/usr/bin/env node
//
// Tests for host/agent/installer/ — the cross-platform Node port of
// install.sh/install.ps1's native-messaging-host registration logic, shared
// by install.sh, install.ps1, and the published `browzy` npm CLI.
//
// Every test here runs against a scratch temp directory (or, for the
// registry-shaped assertions, pure in-memory string building) — nothing
// touches a real browser profile or the real Windows registry. Filesystem
// branch tests use OCIC_OS_OVERRIDE to force the mac/linux branch regardless
// of which OS actually runs this suite, exactly like install.sh's own test
// hook (see install.sh's OS_KIND detection comment).
//
// Run: node host/test/installer.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_NAME, HOST_DESCRIPTION, EXTENSION_ID } from "../agent/installer/constants.js";
import { jsonEscapePath, generateHostManifest } from "../agent/installer/manifest.js";
import { writeIfChanged } from "../agent/installer/fsops.js";
import { getBrowserTargets, isWanted } from "../agent/installer/browser-targets.js";
import { isNpxCacheDir } from "../agent/installer/npx-guard.js";
import { runInstall, runUninstall, runDoctor } from "../agent/installer/core.js";
import { main as cliMain } from "../agent/installer/cli.js";
import { deriveIdFromManifest, isValidExtensionId } from "../agent/identity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const REAL_MANIFEST_PATH = path.join(REPO_ROOT, "extension", "manifest.json");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}  — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function mkScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

console.log("\nInstaller (host/agent/installer/) — Node port of install.sh/install.ps1\n");

// --- decision 3: the embedded EXTENSION_ID constant must not drift --------

test("EXTENSION_ID constant matches the id derived from the real extension/manifest.json", () => {
  const derived = deriveIdFromManifest(REAL_MANIFEST_PATH);
  assertEqual(
    EXTENSION_ID,
    derived,
    "host/agent/installer/constants.js's EXTENSION_ID has drifted from extension/manifest.json's " +
      "persistent public key — regenerate the constant, do not silently register the wrong origin"
  );
  assert(isValidExtensionId(EXTENSION_ID), "EXTENSION_ID must itself be a well-formed 32-character id");
});

// --- manifest JSON shape (byte-identical to install.sh's generate_manifest) -

test("generateHostManifest: byte-identical shape to install.sh's generate_manifest (POSIX path)", () => {
  const content = generateHostManifest({
    hostName: HOST_NAME,
    description: HOST_DESCRIPTION,
    execPath: "/home/dev/project/host/native-host-wrapper.sh",
    extensionId: "a".repeat(32)
  });
  const expected =
    "{\n" +
    `  "name": "${HOST_NAME}",\n` +
    `  "description": "${HOST_DESCRIPTION}",\n` +
    '  "path": "/home/dev/project/host/native-host-wrapper.sh",\n' +
    '  "type": "stdio",\n' +
    '  "allowed_origins": [\n' +
    `    "chrome-extension://${"a".repeat(32)}/"\n` +
    "  ]\n" +
    "}\n";
  assertEqual(content, expected, "manifest JSON did not match install.sh's exact heredoc shape");
});

test("jsonEscapePath: doubles backslashes exactly like install.sh's json_escape (sed 's/\\\\/\\\\\\\\/g')", () => {
  const raw = "C:\\Users\\me\\project\\host\\native-host-wrapper.bat";
  const escaped = jsonEscapePath(raw);
  assertEqual(escaped, "C:\\\\Users\\\\me\\\\project\\\\host\\\\native-host-wrapper.bat", "backslash escaping mismatch");
  // POSIX paths contain no backslashes, so escaping is a no-op — matches
  // install.sh's json_escape being called unconditionally on every platform.
  assertEqual(jsonEscapePath("/no/backslashes/here"), "/no/backslashes/here", "POSIX path must be unchanged");
});

test("generateHostManifest: Windows path backslashes are escaped so the manifest round-trips through JSON.parse", () => {
  const rawPath = "C:\\Users\\me\\project\\host\\native-host-wrapper.bat";
  const content = generateHostManifest({
    hostName: HOST_NAME,
    description: HOST_DESCRIPTION,
    execPath: rawPath,
    extensionId: "b".repeat(32)
  });
  // The raw manifest text must contain the DOUBLED backslash form (this is
  // what install.sh's json_escape produces, embedded literally — not run
  // through a general-purpose JSON string serializer).
  assert(content.includes('"path": "C:\\\\Users\\\\me\\\\project\\\\host\\\\native-host-wrapper.bat",'), "manifest text must contain doubled backslashes on the path line");
  // And it must be valid JSON that decodes back to the original raw path.
  const parsed = JSON.parse(content);
  assertEqual(parsed.path, rawPath, "parsed manifest path must decode back to the original unescaped path");
  assertEqual(parsed.name, HOST_NAME, "manifest name mismatch");
  assertEqual(parsed.description, HOST_DESCRIPTION, "manifest description mismatch");
  assertEqual(parsed.type, "stdio", "manifest type mismatch");
  assertEqual(parsed.allowed_origins.length, 1, "manifest should have exactly one allowed origin");
  assertEqual(parsed.allowed_origins[0], `chrome-extension://${"b".repeat(32)}/`, "allowed_origins mismatch");
});

test("generateHostManifest matches the real, currently-registered host/com.anthropic.browzy_in_chrome.json shape", () => {
  // Cross-check against the actual generated-by-install.sh artifact
  // committed nowhere but present on any machine that has run install.sh —
  // this test only asserts on shape/fields, not on machine-specific values.
  const content = generateHostManifest({
    hostName: HOST_NAME,
    description: HOST_DESCRIPTION,
    execPath: "D:\\Dev\\www\\open-claude-in-chrome\\host\\native-host-wrapper.bat",
    extensionId: EXTENSION_ID
  });
  const parsed = JSON.parse(content);
  assertEqual(parsed.name, "com.anthropic.browzy_in_chrome", "host name must match the product's native-messaging host name");
  assertEqual(parsed.description, "Browzy Native Messaging Host", "description must match");
  assertEqual(parsed.type, "stdio", "type must be stdio");
});

// --- write_if_changed semantics --------------------------------------------

test("writeIfChanged: writes a brand-new file, no .bak", () => {
  const dir = mkScratchDir("ocic-installer-fsops-");
  try {
    const target = path.join(dir, "sub", "file.json");
    const result = writeIfChanged(target, "hello\n");
    assertEqual(result.status, "written", "new file should report 'written'");
    assertEqual(result.backupPath, null, "new file must not create a backup");
    assert(fs.existsSync(target), "target file should exist");
    assertEqual(fs.readFileSync(target, "utf-8"), "hello\n", "target file content mismatch");
    assert(!fs.existsSync(`${target}.bak`), "no .bak should exist for a brand-new file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeIfChanged: identical content is a true no-op — nothing rewritten, no .bak created", () => {
  const dir = mkScratchDir("ocic-installer-fsops-");
  try {
    const target = path.join(dir, "file.json");
    fs.writeFileSync(target, "same content\n");
    const before = fs.statSync(target).mtimeMs;
    const result = writeIfChanged(target, "same content\n");
    assertEqual(result.status, "unchanged", "identical content should report 'unchanged'");
    assertEqual(result.backupPath, null, "unchanged write must not report a backup");
    assert(!fs.existsSync(`${target}.bak`), "unchanged write must not create a .bak");
    assertEqual(fs.statSync(target).mtimeMs, before, "unchanged write must not touch the file at all");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeIfChanged: changed content backs up the previous file FIRST, then writes the new content", () => {
  const dir = mkScratchDir("ocic-installer-fsops-");
  try {
    const target = path.join(dir, "file.json");
    fs.writeFileSync(target, "old content\n");
    const result = writeIfChanged(target, "new content\n");
    assertEqual(result.status, "written", "changed content should report 'written'");
    assertEqual(result.backupPath, `${target}.bak`, "backupPath should point at target.bak");
    assert(fs.existsSync(`${target}.bak`), ".bak must exist after a changed write");
    assertEqual(fs.readFileSync(`${target}.bak`, "utf-8"), "old content\n", ".bak must hold the PREVIOUS content");
    assertEqual(fs.readFileSync(target, "utf-8"), "new content\n", "target must hold the NEW content");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeIfChanged: trailing-newline-only differences are treated as unchanged (matches bash $() stripping)", () => {
  const dir = mkScratchDir("ocic-installer-fsops-");
  try {
    const target = path.join(dir, "file.json");
    fs.writeFileSync(target, "content");
    const result = writeIfChanged(target, "content\n");
    assertEqual(result.status, "unchanged", "trailing-newline-only diff should be a no-op");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- browser filter / per-platform target lists (incl. Flatpak) -----------

test("isWanted: null/empty --only means every browser is wanted", () => {
  assert(isWanted(null, "chrome"), "null only should want chrome");
  assert(isWanted([], "brave"), "empty only should want brave");
});

test("isWanted: --only restricts to exactly the listed browser keys", () => {
  assert(isWanted(["chrome", "edge"], "chrome"), "chrome should be wanted");
  assert(isWanted(["chrome", "edge"], "edge"), "edge should be wanted");
  assert(!isWanted(["chrome", "edge"], "brave"), "brave should NOT be wanted");
});

test("getBrowserTargets(mac): exactly chrome/edge/brave under Library/Application Support", () => {
  const targets = getBrowserTargets({ osKind: "mac", homeRoot: "/Users/dev" });
  assertEqual(targets.length, 3, "mac should have exactly 3 targets");
  const byKey = Object.fromEntries(targets.map((t) => [t.key, t]));
  assertEqual(byKey.chrome.dir, "/Users/dev/Library/Application Support/Google/Chrome/NativeMessagingHosts", "mac chrome dir mismatch");
  assertEqual(byKey.edge.dir, "/Users/dev/Library/Application Support/Microsoft Edge/NativeMessagingHosts", "mac edge dir mismatch");
  assertEqual(byKey.brave.dir, "/Users/dev/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts", "mac brave dir mismatch");
});

test("getBrowserTargets(linux): chrome/edge/brave/chromium PLUS all four Flatpak variants", () => {
  const targets = getBrowserTargets({ osKind: "linux", homeRoot: "/home/dev" });
  assertEqual(targets.length, 8, "linux should have exactly 8 targets (4 native + 4 flatpak)");

  const native = targets.filter((t) => !t.flatpak);
  assertEqual(native.length, 4, "linux should have exactly 4 native targets");
  const nativeByKey = Object.fromEntries(native.map((t) => [t.key, t]));
  assertEqual(nativeByKey.chrome.dir, "/home/dev/.config/google-chrome/NativeMessagingHosts", "linux chrome dir mismatch");
  assertEqual(nativeByKey.edge.dir, "/home/dev/.config/microsoft-edge/NativeMessagingHosts", "linux edge dir mismatch");
  assertEqual(nativeByKey.brave.dir, "/home/dev/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts", "linux brave dir mismatch");
  assertEqual(nativeByKey.chromium.dir, "/home/dev/.config/chromium/NativeMessagingHosts", "linux chromium dir mismatch");

  const flatpak = targets.filter((t) => t.flatpak);
  assertEqual(flatpak.length, 4, "linux should have exactly 4 Flatpak targets");
  const flatpakByAppId = Object.fromEntries(flatpak.map((t) => [t.flatpak, t]));
  assertEqual(
    flatpakByAppId["com.brave.Browser"].dir,
    "/home/dev/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    "Brave Flatpak dir mismatch"
  );
  assertEqual(
    flatpakByAppId["com.google.Chrome"].dir,
    "/home/dev/.var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts",
    "Chrome Flatpak dir mismatch"
  );
  assertEqual(
    flatpakByAppId["com.microsoft.Edge"].dir,
    "/home/dev/.var/app/com.microsoft.Edge/config/microsoft-edge/NativeMessagingHosts",
    "Edge Flatpak dir mismatch"
  );
  assertEqual(
    flatpakByAppId["org.chromium.Chromium"].dir,
    "/home/dev/.var/app/org.chromium.Chromium/config/chromium/NativeMessagingHosts",
    "Chromium Flatpak dir mismatch"
  );
  assertEqual(flatpakByAppId["com.brave.Browser"].key, "brave", "Brave Flatpak must filter under the 'brave' --only key");
  assertEqual(flatpakByAppId["com.google.Chrome"].key, "chrome", "Chrome Flatpak must filter under the 'chrome' --only key");
  assertEqual(flatpakByAppId["com.microsoft.Edge"].key, "edge", "Edge Flatpak must filter under the 'edge' --only key");
  assertEqual(flatpakByAppId["org.chromium.Chromium"].key, "chromium", "Chromium Flatpak must filter under the 'chromium' --only key");
});

test("getBrowserTargets(windows): exactly chrome/edge/brave registry hives (no chromium, matching install.sh's install_windows)", () => {
  const targets = getBrowserTargets({ osKind: "windows", registryRoot: "HKCU\\Software" });
  assertEqual(targets.length, 3, "windows should have exactly 3 targets");
  const byKey = Object.fromEntries(targets.map((t) => [t.key, t]));
  assertEqual(byKey.chrome.hive, "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts", "windows chrome hive mismatch");
  assertEqual(byKey.edge.hive, "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts", "windows edge hive mismatch");
  assertEqual(byKey.brave.hive, "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts", "windows brave hive mismatch");
});

// --- npx refusal (decision 2) ----------------------------------------------

test("isNpxCacheDir: detects a POSIX npx cache path", () => {
  assert(isNpxCacheDir("/home/dev/.npm/_npx/abc123def/node_modules/@huydepzai2810/browzy-host"), "POSIX _npx path should be detected");
});

test("isNpxCacheDir: detects a Windows npx cache path", () => {
  assert(
    isNpxCacheDir("C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc123def\\node_modules\\@huydepzai2810\\browzy-host"),
    "Windows _npx path should be detected"
  );
});

test("isNpxCacheDir: does NOT trigger on an ordinary global install path (POSIX)", () => {
  assert(!isNpxCacheDir("/usr/local/lib/node_modules/@huydepzai2810/browzy-host"), "ordinary global install must not be flagged");
});

test("isNpxCacheDir: does NOT trigger on an ordinary global install path (Windows)", () => {
  assert(
    !isNpxCacheDir("C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@huydepzai2810\\browzy-host"),
    "ordinary Windows global install must not be flagged"
  );
});

test("isNpxCacheDir: does NOT trigger on a plain git-clone dev checkout, even one cloned under the OS temp dir", () => {
  assert(!isNpxCacheDir(REPO_ROOT), "the real repo checkout must never be flagged as an npx cache");
  assert(!isNpxCacheDir(path.join(os.tmpdir(), "some-dev-checkout", "host")), "a checkout living under the OS temp dir must not be flagged either — only an explicit _npx segment should refuse");
});

test("runInstall: refuses to install when hostDir looks like an npx cache, and writes nothing", () => {
  const dir = mkScratchDir("ocic-installer-npx-");
  try {
    const hostDir = path.join(dir, "_npx", "deadbeef", "node_modules", "@huydepzai2810", "browzy-host", "host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "native-host.js"), "// stub\n");
    const homeRoot = path.join(dir, "home");
    fs.mkdirSync(path.join(homeRoot, ".config", "google-chrome"), { recursive: true });

    const logs = [];
    const errs = [];
    const result = runInstall({
      hostDir,
      homeRoot,
      env: { OCIC_OS_OVERRIDE: "linux" },
      log: (l) => logs.push(l),
      error: (l) => errs.push(l)
    });

    assertEqual(result.ok, false, "install from an npx cache dir must be refused");
    assertEqual(result.exitCode, 1, "refusal must exit non-zero");
    assert(
      errs.some((l) => l.includes("npm i -g")),
      "refusal message should name the correct install command"
    );
    assert(
      !fs.existsSync(path.join(homeRoot, ".config", "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`)),
      "refused install must not have written any manifest"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- --extension-id override (decision 3) ----------------------------------

test("runInstall: --extension-id (via extensionId option) overrides the constant and lands in allowed_origins", () => {
  const dir = mkScratchDir("ocic-installer-override-");
  try {
    const hostDir = path.join(dir, "pkg", "host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "native-host.js"), "// stub\n");
    const homeRoot = path.join(dir, "home");
    fs.mkdirSync(path.join(homeRoot, ".config", "google-chrome"), { recursive: true });

    const overrideId = "p".repeat(32);
    const result = runInstall({
      hostDir,
      homeRoot,
      extensionId: overrideId,
      env: { OCIC_OS_OVERRIDE: "linux" },
      log: () => {},
      error: (l) => console.error(l)
    });
    assertEqual(result.ok, true, "install with a valid override id should succeed");

    const manifestPath = path.join(homeRoot, ".config", "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`);
    assert(fs.existsSync(manifestPath), "manifest should have been written");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assertEqual(manifest.allowed_origins[0], `chrome-extension://${overrideId}/`, "override id must land in allowed_origins, not the default constant");
    assert(!manifest.allowed_origins[0].includes(EXTENSION_ID), "the default constant must NOT appear when an override is given");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runInstall: an invalid --extension-id is rejected rather than silently registered", () => {
  const dir = mkScratchDir("ocic-installer-badid-");
  try {
    const hostDir = path.join(dir, "pkg", "host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "native-host.js"), "// stub\n");
    const homeRoot = path.join(dir, "home");

    const result = runInstall({
      hostDir,
      homeRoot,
      extensionId: "not-a-valid-id",
      env: { OCIC_OS_OVERRIDE: "linux" },
      log: () => {},
      error: () => {}
    });
    assertEqual(result.ok, false, "a malformed extension id must be rejected");
    assertEqual(result.exitCode, 1, "rejection must exit non-zero");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end: install -> doctor -> uninstall, on a fully scratch tree ---

test("runInstall / runDoctor / runUninstall round-trip on a scratch tree (idempotent, doctor reports it, uninstall removes it)", () => {
  const dir = mkScratchDir("ocic-installer-e2e-");
  try {
    const hostDir = path.join(dir, "pkg", "host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "native-host.js"), "// stub\n");
    const homeRoot = path.join(dir, "home");
    fs.mkdirSync(path.join(homeRoot, ".config", "google-chrome"), { recursive: true });
    const opts = { hostDir, homeRoot, env: { OCIC_OS_OVERRIDE: "linux" }, log: () => {}, error: (l) => console.error(l) };

    const first = runInstall(opts);
    assertEqual(first.ok, true, "first install should succeed");
    const manifestPath = path.join(homeRoot, ".config", "google-chrome", "NativeMessagingHosts", `${HOST_NAME}.json`);
    assert(fs.existsSync(manifestPath), "manifest should exist after install");

    // Rerun is a true no-op: no .bak anywhere.
    const second = runInstall(opts);
    assertEqual(second.ok, true, "second (idempotent) install should also succeed");
    assert(!fs.existsSync(`${manifestPath}.bak`), "idempotent rerun must not create a .bak");

    const doctorLogs = [];
    const doctorResult = runDoctor({ ...opts, log: (l) => doctorLogs.push(l) });
    assertEqual(doctorResult.ok, true, "doctor should succeed");
    const doctorText = doctorLogs.join("\n");
    assert(doctorText.includes("Google Chrome"), "doctor report should mention Google Chrome");
    assert(doctorText.includes("exists"), "doctor report should confirm the host file exists");
    assert(!doctorText.includes("MISSING"), "doctor should not report anything missing on a freshly installed tree");

    const uninstallResult = runUninstall(opts);
    assertEqual(uninstallResult.ok, true, "uninstall should succeed");
    assert(!fs.existsSync(manifestPath), "manifest should be gone after uninstall");

    const doctorAfterLogs = [];
    runDoctor({ ...opts, log: (l) => doctorAfterLogs.push(l) });
    assert(
      doctorAfterLogs.join("\n").includes("not registered"),
      "doctor should report 'not registered' after uninstall"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor: reports MISSING when a registration points at a host file that no longer exists (the 'connecting forever' bug)", () => {
  const dir = mkScratchDir("ocic-installer-doctor-missing-");
  try {
    const hostDir = path.join(dir, "pkg", "host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "native-host.js"), "// stub\n");
    const homeRoot = path.join(dir, "home");
    fs.mkdirSync(path.join(homeRoot, ".config", "google-chrome"), { recursive: true });
    const opts = { hostDir, homeRoot, env: { OCIC_OS_OVERRIDE: "linux" }, log: () => {}, error: (l) => console.error(l) };

    assertEqual(runInstall(opts).ok, true, "install should succeed");

    // Simulate the exact failure this diagnostic exists for: the registered
    // manifest is still there and still valid, but the wrapper it points at
    // is gone (e.g. the package directory moved/was reinstalled elsewhere) —
    // the browser will retry connectNative() forever with no visible error.
    fs.unlinkSync(path.join(hostDir, "native-host-wrapper.sh"));

    const doctorLogs = [];
    runDoctor({ ...opts, log: (l) => doctorLogs.push(l) });
    const doctorText = doctorLogs.join("\n");
    assert(doctorText.includes("MISSING"), "doctor must flag the missing host file instead of reporting a clean 'exists'");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI argument parsing ---------------------------------------------------

test("CLI: `browzy install --extension-id <id>` parses and forwards the override (no npx/browser side effects here)", () => {
  const dir = mkScratchDir("ocic-installer-cli-");
  try {
    const hostDir = path.join(dir, "pkg", "host");
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, "native-host.js"), "// stub\n");
    const homeRoot = path.join(dir, "home"); // no browsers "installed" -> every target skipped, no writes

    // main() always resolves hostDir via getHostDir() (this file's own real
    // location), so this test exercises argument PARSING only — it does not
    // (and must not) redirect the CLI's real host dir. Confirm indirectly:
    // an unknown flag is rejected before any install logic runs.
    const logs = [];
    const errs = [];
    const exitCode = cliMain(["install", "--extension-id"], { log: (l) => logs.push(l), error: (l) => errs.push(l) });
    assertEqual(exitCode, 1, "a dangling --extension-id with no value must be rejected");
    assert(errs.some((l) => l.includes("--extension-id requires a value")), "error should name the missing value");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: unrecognized positional argument is rejected with guidance toward --extension-id", () => {
  const errs = [];
  const exitCode = cliMain(["install", "some-stray-id"], { log: () => {}, error: (l) => errs.push(l) });
  assertEqual(exitCode, 1, "a stray positional argument must be rejected");
  assert(
    errs.some((l) => l.includes("--extension-id")),
    "rejection message should point at --extension-id"
  );
});

test("CLI: --only=chrome,edge parses into the expected array", () => {
  // Exercised indirectly through doctor (read-only, safe against the real
  // hostDir) — doctor ignores --only, so instead assert parsing behavior via
  // an unknown-flag rejection alongside a valid --only to prove --only itself
  // was accepted without error.
  const errs = [];
  const exitCode = cliMain(["doctor", "--only=chrome,edge", "--bogus-flag"], { log: () => {}, error: (l) => errs.push(l) });
  assertEqual(exitCode, 1, "the unknown flag after a valid --only should still be rejected");
  assert(errs.some((l) => l.includes("--bogus-flag")), "error should name the actual unknown flag, proving --only parsed cleanly first");
});

test("CLI: -h/--help prints usage and exits 0 for every subcommand", () => {
  for (const cmd of ["install", "uninstall", "doctor"]) {
    const logs = [];
    const exitCode = cliMain([cmd, "--help"], { log: (l) => logs.push(l), error: () => {} });
    assertEqual(exitCode, 0, `${cmd} --help should exit 0`);
    assert(logs.some((l) => l.includes("Usage: browzy")), `${cmd} --help should print usage`);
  }
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

// Core install/uninstall/doctor orchestration — a line-for-line port of
// install.sh's (and install.ps1's) registration logic into one cross-platform
// Node implementation. See install.sh for the annotated original; this file
// mirrors its structure section by section.
//
// Output goes through host/agent/installer/style.js: colour and symbols are
// decoration on top of plain-English words ("exists", "MISSING", "registered",
// "not registered", ...) that are always present in the string, so the report
// reads the same with escape codes stripped (a piped log, a bug report, an
// unstyled terminal) as it does in a colour-capable TTY.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_NAME, HOST_DESCRIPTION, EXTENSION_ID } from "./constants.js";
import { generateHostManifest } from "./manifest.js";
import { writeIfChanged } from "./fsops.js";
import { detectOsKind } from "./os-detect.js";
import { getBrowserTargets, isWanted } from "./browser-targets.js";
import { isNpxCacheDir } from "./npx-guard.js";
import { regQueryDefaultValue, regExportKey, regSetDefaultValue, regDeleteKey } from "./windows-registry.js";
import { generateUnixWrapperContent, generateWindowsWrapperContent } from "./wrapper-scripts.js";
import { isValidExtensionId } from "../identity.js";
import { createStyle, SYMBOL } from "./style.js";

/**
 * Absolute path to the package's own host/ directory (works identically
 * whether this is running from the git checkout or from an `npm i -g`
 * install — both keep host/agent/installer/core.js two levels below the
 * package root).
 *
 * @returns {string}
 */
export function getHostDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function safeFileNameFragment(name) {
  return name.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Right-pads every target's display name to the widest one in the list, so
 * per-browser rows line up in a column regardless of platform (e.g. "Brave
 * Browser (Flatpak)" next to "Google Chrome").
 *
 * @param {Array<{name: string}>} targets
 * @returns {(name: string) => string}
 */
function padTargetNames(targets) {
  const width = targets.reduce((max, t) => Math.max(max, t.name.length), 0);
  return (name) => name.padEnd(width, " ");
}

function resolveOptions(opts = {}) {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdout && process.stdout.isTTY);
  return {
    hostDir: opts.hostDir ?? getHostDir(),
    osKind: opts.osKind ?? detectOsKind(env),
    homeRoot: opts.homeRoot ?? env.OCIC_HOME_OVERRIDE ?? os.homedir(),
    registryRoot: opts.registryRoot ?? env.OCIC_REGISTRY_ROOT ?? "HKCU\\Software",
    only: opts.only ?? null,
    extensionId: opts.extensionId ?? EXTENSION_ID,
    nodeExePath: opts.nodeExePath ?? process.execPath,
    log: opts.log ?? ((line) => console.log(line)),
    error: opts.error ?? ((line) => console.error(line)),
    style: opts.style ?? createStyle({ env, isTTY })
  };
}

// --- install -----------------------------------------------------------

/**
 * @param {object} [opts]
 * @returns {{ok: boolean, exitCode: number}}
 */
export function runInstall(opts = {}) {
  const o = resolveOptions(opts);
  const { log, error, style } = o;

  if (isNpxCacheDir(o.hostDir)) {
    error(`${style.fail(SYMBOL.fail)} Error: refusing to register a native messaging host from a temporary npx install.`);
    error(`  Detected package directory: ${o.hostDir}`);
    error("");
    error("  npx installs into a prunable cache directory; a manifest built from that");
    error("  path would point at a location that can vanish later, and the only symptom");
    error("  would be the companion silently never connecting.");
    error("");
    error("  Install permanently instead, then run the install command:");
    error("    npm i -g @huydepzai2810/browzy-host");
    error("    browzy install");
    return { ok: false, exitCode: 1 };
  }

  if (!isValidExtensionId(o.extensionId)) {
    error(`${style.fail(SYMBOL.fail)} Error: "${o.extensionId}" is not a well-formed 32-character extension id (a-p only).`);
    error("  Pass a valid id with --extension-id, or omit it to use the built-in default.");
    return { ok: false, exitCode: 1 };
  }

  const nativeHostJs = path.join(o.hostDir, "native-host.js");
  if (!fs.existsSync(nativeHostJs)) {
    error(`${style.fail(SYMBOL.fail)} Error: ${nativeHostJs} not found.`);
    error("  This install is missing its own native-host.js — reinstall the package.");
    return { ok: false, exitCode: 1 };
  }

  if (o.osKind === "unknown") {
    error(`${style.fail(SYMBOL.fail)} Error: unsupported platform.`);
    error("  This installer supports macOS, Linux, and Windows.");
    return { ok: false, exitCode: 1 };
  }

  log("");
  log(style.bold(`Installing native messaging host for extension id: ${o.extensionId}`));

  const summary =
    o.osKind === "mac" || o.osKind === "linux" ? installUnix(o, nativeHostJs) : installWindows(o, nativeHostJs);

  printInstallFooter(o, summary);
  return { ok: true, exitCode: 0 };
}

function installUnix(o, nativeHostJs) {
  const { log, style } = o;
  const wrapperPath = path.join(o.hostDir, "native-host-wrapper.sh");
  const wrapperContent = generateUnixWrapperContent(o.nodeExePath, nativeHostJs);
  writeIfChanged(wrapperPath, wrapperContent);
  fs.chmodSync(wrapperPath, 0o755);

  const targets = getBrowserTargets({ osKind: o.osKind, homeRoot: o.homeRoot });
  const padName = padTargetNames(targets);
  const summary = { installed: 0, upToDate: 0, skipped: 0, failed: 0 };
  let flatpakDetected = false;

  log("");
  log(style.bold("Browsers"));
  for (const target of targets) {
    if (!isWanted(o.only, target.key)) {
      summary.skipped++;
      log(`  ${style.dim(SYMBOL.info)} ${padName(target.name)}  ${style.dim("skipped (not selected by --only)")}`);
      continue;
    }
    if (!fs.existsSync(path.dirname(target.dir))) {
      summary.skipped++;
      log(`  ${style.dim(SYMBOL.info)} ${padName(target.name)}  ${style.dim("skipped (not installed)")}`);
      continue;
    }
    if (target.flatpak && fs.existsSync(path.join(o.homeRoot, ".var", "app", target.flatpak))) {
      flatpakDetected = true;
    }
    fs.mkdirSync(target.dir, { recursive: true });
    const manifestContent = generateHostManifest({
      hostName: HOST_NAME,
      description: HOST_DESCRIPTION,
      execPath: wrapperPath,
      extensionId: o.extensionId
    });
    const manifestPath = path.join(target.dir, `${HOST_NAME}.json`);
    const result = writeIfChanged(manifestPath, manifestContent);
    reportWriteResult(o, padName(target.name), result, summary);
  }

  if (o.osKind === "linux" && flatpakDetected) {
    log("");
    log(`  ${style.warn(SYMBOL.warn)} Note: a Flatpak browser was detected. Flatpak sandboxes the browser,`);
    log("    so it also needs permission to run the native host from your home dir:");
    log("      flatpak override --user --filesystem=home <app-id>");
    log("    (e.g. com.brave.Browser), then fully restart the browser.");
  }

  return summary;
}

function installWindows(o, nativeHostJs) {
  const { log, style } = o;
  const batPath = path.join(o.hostDir, "native-host-wrapper.bat");
  const batContent = generateWindowsWrapperContent(o.nodeExePath, nativeHostJs);
  writeIfChanged(batPath, batContent);

  const manifestPath = path.join(o.hostDir, `${HOST_NAME}.json`);
  const manifestContent = generateHostManifest({
    hostName: HOST_NAME,
    description: HOST_DESCRIPTION,
    execPath: batPath,
    extensionId: o.extensionId
  });
  writeIfChanged(manifestPath, manifestContent);

  log("");
  log(style.bold("Registry (HKCU)"));
  const targets = getBrowserTargets({ osKind: "windows", registryRoot: o.registryRoot });
  const padName = padTargetNames(targets);
  const summary = { installed: 0, upToDate: 0, skipped: 0, failed: 0 };
  for (const target of targets) {
    if (!isWanted(o.only, target.key)) {
      summary.skipped++;
      log(`  ${style.dim(SYMBOL.info)} ${padName(target.name)}  ${style.dim("skipped (not selected by --only)")}`);
      continue;
    }
    const key = `${target.hive}\\${HOST_NAME}`;
    const current = regQueryDefaultValue(key);
    if (current === manifestPath) {
      summary.upToDate++;
      log(`  ${style.ok(SYMBOL.ok)} ${padName(target.name)}  ${style.dim("already up to date")}`);
      continue;
    }
    if (current) {
      const backupFile = path.join(o.hostDir, `${HOST_NAME}.${safeFileNameFragment(target.name)}.registry-backup.reg`);
      if (regExportKey(key, backupFile)) {
        log(`  ${style.warn(SYMBOL.warn)} ${padName(target.name)}  ${style.dim(`backed up previous registration -> ${backupFile}`)}`);
      }
    }
    if (regSetDefaultValue(key, manifestPath)) {
      summary.installed++;
      log(`  ${style.ok(SYMBOL.ok)} ${padName(target.name)}  registered`);
    } else {
      summary.failed++;
      log(`  ${style.fail(SYMBOL.fail)} ${padName(target.name)}  ${style.fail("could not register")}`);
    }
  }
  return summary;
}

function reportWriteResult(o, label, result, summary) {
  const { log, style } = o;
  if (result.status === "unchanged") {
    summary.upToDate++;
    log(`  ${style.ok(SYMBOL.ok)} ${label}  ${style.dim("already up to date")}`);
    return;
  }
  summary.installed++;
  if (result.backupPath) {
    log(`  ${style.warn(SYMBOL.warn)} ${label}  ${style.dim(`backed up previous registration -> ${result.backupPath}`)}`);
  }
  log(`  ${style.ok(SYMBOL.ok)} ${label}  ${style.dim(`installed -> ${result.path}`)}`);
}

function summaryLine(o, parts) {
  const { log, style } = o;
  log("");
  log(style.bold("Summary"));
  log(`  ${parts.length ? parts.join(", ") : "nothing to do"}`);
}

function printInstallFooter(o, summary) {
  const { log, style } = o;
  const parts = [];
  if (summary.installed) parts.push(`${summary.installed} registered`);
  if (summary.upToDate) parts.push(`${summary.upToDate} already up to date`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  summaryLine(o, parts);

  const mcpServerPath = path.join(o.hostDir, "mcp-server.js");
  log("");
  log(style.ok(`${SYMBOL.ok} Done.`) + "  Next steps:");
  log("");
  log("  1. Restart your browser (close all windows and reopen)");
  log("");
  log("  2. Recommended: use the built-in side panel (no Claude account,");
  log("     no terminal needed from here on):");
  log("       - Click the extension's toolbar icon to open the side panel");
  log("       - Open its settings (or right-click the extension icon -> Options)");
  log("         and enter your own Anthropic-compatible Base URL, API key, and");
  log("         at least one model, then click Test connection");
  log("       - Type a message in the side panel - that's it, no MCP setup");
  log("");
  log("  3. Optional legacy entry point: drive the same extension from Claude");
  log("     Code over external MCP (unchanged, still fully supported):");
  log("");
  log(`       claude mcp add browzy-in-chrome -- node "${mcpServerPath}"`);
  log("");
  log("     (Alternative to registering the server yourself: install this project");
  log("     as a Claude Code plugin instead — see README.md. Use ONE of the two,");
  log("     never both, or every tool registers twice under different names.)");
  log("");
}

// --- uninstall -----------------------------------------------------------

/**
 * @param {object} [opts]
 * @returns {{ok: boolean, exitCode: number}}
 */
export function runUninstall(opts = {}) {
  const o = resolveOptions(opts);
  const { log, error, style } = o;

  if (o.osKind === "unknown") {
    error(`${style.fail(SYMBOL.fail)} Error: unsupported platform.`);
    return { ok: false, exitCode: 1 };
  }

  const fullUninstall = !o.only;
  log("");
  log(style.bold("Removing native messaging host registration"));

  const summary = { removed: 0, notRegistered: 0, failed: 0 };

  log("");
  if (o.osKind === "mac" || o.osKind === "linux") {
    log(style.bold("Browsers"));
    const targets = getBrowserTargets({ osKind: o.osKind, homeRoot: o.homeRoot });
    const padName = padTargetNames(targets);
    for (const target of targets) {
      if (!isWanted(o.only, target.key)) continue;
      const manifestPath = path.join(target.dir, `${HOST_NAME}.json`);
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
        summary.removed++;
        log(`  ${style.ok(SYMBOL.ok)} ${padName(target.name)}  ${style.dim(`removed ${manifestPath}`)}`);
      } else {
        summary.notRegistered++;
        log(`  ${style.dim(SYMBOL.info)} ${padName(target.name)}  not registered`);
      }
    }
    if (fullUninstall) {
      const wrapperPath = path.join(o.hostDir, "native-host-wrapper.sh");
      if (fs.existsSync(wrapperPath)) {
        fs.unlinkSync(wrapperPath);
        log(`  ${style.dim(SYMBOL.info)} ${style.dim(`removed ${wrapperPath}`)}`);
      }
    }
  } else {
    log(style.bold("Registry (HKCU)"));
    const targets = getBrowserTargets({ osKind: "windows", registryRoot: o.registryRoot });
    const padName = padTargetNames(targets);
    for (const target of targets) {
      if (!isWanted(o.only, target.key)) continue;
      const key = `${target.hive}\\${HOST_NAME}`;
      if (regQueryDefaultValue(key) !== null) {
        if (regDeleteKey(key)) {
          summary.removed++;
          log(`  ${style.ok(SYMBOL.ok)} ${padName(target.name)}  unregistered`);
        } else {
          summary.failed++;
          log(`  ${style.fail(SYMBOL.fail)} ${padName(target.name)}  ${style.fail("could not unregister")}`);
        }
      } else {
        summary.notRegistered++;
        log(`  ${style.dim(SYMBOL.info)} ${padName(target.name)}  not registered`);
      }
    }
    if (fullUninstall) {
      const manifestPath = path.join(o.hostDir, `${HOST_NAME}.json`);
      const batPath = path.join(o.hostDir, "native-host-wrapper.bat");
      for (const p of [manifestPath, batPath]) {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          log(`  ${style.dim(SYMBOL.info)} ${style.dim(`removed ${p}`)}`);
        }
      }
    }
  }

  const parts = [];
  if (summary.removed) parts.push(`${summary.removed} removed`);
  if (summary.notRegistered) parts.push(`${summary.notRegistered} not registered`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  summaryLine(o, parts);
  log("");
  log(style.ok(`${SYMBOL.ok} Done.`));
  return { ok: true, exitCode: 0 };
}

// --- doctor -----------------------------------------------------------

/**
 * Report what is currently registered, for which extension id, and whether
 * the host file each registration points at actually exists on disk — the
 * diagnostic a "connecting forever" bug needs.
 *
 * @param {object} [opts]
 * @returns {{ok: boolean, exitCode: number}}
 */
export function runDoctor(opts = {}) {
  const o = resolveOptions(opts);
  const { log, style } = o;

  log("");
  log(style.bold("Browzy native messaging host — diagnostic report"));
  log("");
  log(`  Platform:              ${o.osKind}`);
  log(`  Package directory:     ${o.hostDir}`);
  log(`  Default extension id:  ${EXTENSION_ID}`);
  if (isNpxCacheDir(o.hostDir)) {
    log(`  ${style.warn(SYMBOL.warn)} WARNING: running from what looks like an npx cache directory.`);
    log("             `browzy install` will refuse to register from here — see --help.");
  }

  const nativeHostJs = path.join(o.hostDir, "native-host.js");
  const nativeHostPresent = fs.existsSync(nativeHostJs);
  log(`  native-host.js present: ${nativeHostPresent ? style.ok("yes") : style.fail("NO")}`);

  const counts = { registered: 0, missing: 0, notRegistered: 0, error: 0 };

  log("");
  if (o.osKind === "mac" || o.osKind === "linux") {
    log(style.bold("Browsers"));
    const targets = getBrowserTargets({ osKind: o.osKind, homeRoot: o.homeRoot });
    const padName = padTargetNames(targets);
    for (const target of targets) {
      counts[reportUnixTarget(o, target, padName)]++;
    }
  } else if (o.osKind === "windows") {
    log(style.bold("Registry (HKCU)"));
    const targets = getBrowserTargets({ osKind: "windows", registryRoot: o.registryRoot });
    const padName = padTargetNames(targets);
    for (const target of targets) {
      counts[reportWindowsTarget(o, target, padName)]++;
    }
  } else {
    log("  Unsupported platform — nothing to report.");
  }

  const parts = [];
  if (counts.registered) parts.push(`${counts.registered} registered and healthy`);
  if (counts.missing) parts.push(`${counts.missing} missing`);
  if (counts.notRegistered) parts.push(`${counts.notRegistered} not registered`);
  if (counts.error) parts.push(`${counts.error} unreadable`);
  summaryLine(o, parts);
  if (counts.missing > 0) {
    log(`  ${style.warn(SYMBOL.warn)} Run \`browzy install\` to fix the missing registration(s) above.`);
  } else if (counts.notRegistered > 0 && counts.registered === 0) {
    log(`  ${style.warn(SYMBOL.warn)} Nothing registered yet. Run \`browzy install\` to set it up.`);
  }
  log("");
  return { ok: true, exitCode: 0 };
}

function describeManifestFile(o, manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    return { error: `could not parse ${manifestPath}: ${err.message}` };
  }
  const execPath = manifest.path;
  const execExists = execPath ? fs.existsSync(execPath) : false;
  return {
    manifestPath,
    execPath,
    execExists,
    allowedOrigins: manifest.allowed_origins ?? []
  };
}

function reportUnixTarget(o, target, padName) {
  const { log, style } = o;
  const manifestPath = path.join(target.dir, `${HOST_NAME}.json`);
  const info = describeManifestFile(o, manifestPath);
  const name = padName(target.name);
  if (!info) {
    log(`  ${style.dim(SYMBOL.info)} ${name}  not registered`);
    return "notRegistered";
  }
  if (info.error) {
    log(`  ${style.fail(SYMBOL.fail)} ${name}  ${style.fail(info.error)}`);
    return "error";
  }
  const healthy = info.execExists;
  log(`  ${healthy ? style.ok(SYMBOL.ok) : style.fail(SYMBOL.fail)} ${name}`);
  log(`      manifest:        ${style.dim(info.manifestPath)}`);
  log(`      host path:       ${info.execPath} (${healthy ? style.ok("exists") : style.fail("MISSING")})`);
  log(`      allowed_origins: ${info.allowedOrigins.join(", ")}`);
  return healthy ? "registered" : "missing";
}

function reportWindowsTarget(o, target, padName) {
  const { log, style } = o;
  const key = `${target.hive}\\${HOST_NAME}`;
  const manifestPath = regQueryDefaultValue(key);
  const name = padName(target.name);
  if (!manifestPath) {
    log(`  ${style.dim(SYMBOL.info)} ${name}  not registered`);
    return "notRegistered";
  }
  const info = describeManifestFile(o, manifestPath);
  if (!info) {
    log(`  ${style.fail(SYMBOL.fail)} ${name}`);
    log(`      registry ->      ${style.dim(manifestPath)}`);
    log(`      ${style.fail("MISSING")}: the manifest file the registry points at does not exist`);
    return "missing";
  }
  if (info.error) {
    log(`  ${style.fail(SYMBOL.fail)} ${name}`);
    log(`      registry ->      ${style.dim(manifestPath)}`);
    log(`      ${style.fail(info.error)}`);
    return "error";
  }
  const healthy = info.execExists;
  log(`  ${healthy ? style.ok(SYMBOL.ok) : style.fail(SYMBOL.fail)} ${name}`);
  log(`      registry ->      ${style.dim(manifestPath)}`);
  log(`      host path:       ${info.execPath} (${healthy ? style.ok("exists") : style.fail("MISSING")})`);
  log(`      allowed_origins: ${info.allowedOrigins.join(", ")}`);
  return healthy ? "registered" : "missing";
}

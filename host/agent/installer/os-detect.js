// Platform detection for the installer. install.sh/install.ps1 were split by
// shell (bash vs PowerShell); the Node CLI instead branches on Node's own
// os.platform(), which reports the true native platform in every shell.

import os from "node:os";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"mac"|"linux"|"windows"|"unknown"}
 */
export function detectOsKind(env = process.env) {
  // Test hook only (never needed for a real install): lets the test suite
  // exercise the mac/linux/windows branches regardless of which platform the
  // tests actually run on — mirrors install.sh's OCIC_OS_OVERRIDE.
  if (env.OCIC_OS_OVERRIDE) return env.OCIC_OS_OVERRIDE;
  const platform = os.platform();
  if (platform === "darwin") return "mac";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "unknown";
}

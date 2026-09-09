// Per-platform, per-browser native-messaging-host registration targets —
// ported directly from install.sh's mac/linux/windows case branches.
//
// macOS/Linux targets are a directory that gets a "<HOST_NAME>.json" manifest
// file written into it (skipped if the browser isn't installed, i.e. the
// directory's PARENT doesn't exist). Windows targets are a registry hive
// path instead, since Chromium on Windows locates a native host purely
// through HKCU\Software\<vendor>\NativeMessagingHosts\<name>.

import path from "node:path";

/**
 * `wanted BROWSER_KEY -> true` iff `only` was not given, or BROWSER_KEY is in
 * it. Direct port of install.sh's `wanted()` / install.ps1's `Test-Wanted`.
 *
 * @param {string[]|null|undefined} only
 * @param {string} key
 * @returns {boolean}
 */
export function isWanted(only, key) {
  if (!only || only.length === 0) return true;
  return only.includes(key);
}

/**
 * macOS/Linux targets are always POSIX paths — even when this CLI itself is
 * running under Windows exercising these branches via OCIC_OS_OVERRIDE (see
 * install.sh's own OS_KIND override comment) — so these use `path.posix`
 * rather than the platform-native `path`, which would emit backslashes on
 * Windows and corrupt the resulting path.
 *
 * @param {"mac"|"linux"} osKind
 * @param {string} homeRoot
 * @returns {Array<{key: string, name: string, dir: string, flatpak?: string}>}
 */
function unixTargets(osKind, homeRoot) {
  const posix = path.posix;
  if (osKind === "mac") {
    const base = posix.join(homeRoot, "Library", "Application Support");
    return [
      { key: "chrome", name: "Google Chrome", dir: posix.join(base, "Google", "Chrome", "NativeMessagingHosts") },
      { key: "edge", name: "Microsoft Edge", dir: posix.join(base, "Microsoft Edge", "NativeMessagingHosts") },
      { key: "brave", name: "Brave Browser", dir: posix.join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts") }
    ];
  }

  // linux
  const config = posix.join(homeRoot, ".config");
  const varApp = posix.join(homeRoot, ".var", "app");
  return [
    { key: "chrome", name: "Google Chrome", dir: posix.join(config, "google-chrome", "NativeMessagingHosts") },
    { key: "edge", name: "Microsoft Edge", dir: posix.join(config, "microsoft-edge", "NativeMessagingHosts") },
    { key: "brave", name: "Brave Browser", dir: posix.join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts") },
    { key: "chromium", name: "Chromium", dir: posix.join(config, "chromium", "NativeMessagingHosts") },
    // Flatpak browsers are sandboxed: they never read ~/.config, only their
    // own per-app tree, where Flatpak maps ~/.config -> ~/.var/app/<id>/config.
    // A target whose directory's parent doesn't exist is skipped, so these
    // are a no-op on a machine with no Flatpak browser installed.
    {
      key: "brave",
      name: "Brave Browser (Flatpak)",
      dir: posix.join(varApp, "com.brave.Browser", "config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      flatpak: "com.brave.Browser"
    },
    {
      key: "chrome",
      name: "Google Chrome (Flatpak)",
      dir: posix.join(varApp, "com.google.Chrome", "config", "google-chrome", "NativeMessagingHosts"),
      flatpak: "com.google.Chrome"
    },
    {
      key: "edge",
      name: "Microsoft Edge (Flatpak)",
      dir: posix.join(varApp, "com.microsoft.Edge", "config", "microsoft-edge", "NativeMessagingHosts"),
      flatpak: "com.microsoft.Edge"
    },
    {
      key: "chromium",
      name: "Chromium (Flatpak)",
      dir: posix.join(varApp, "org.chromium.Chromium", "config", "chromium", "NativeMessagingHosts"),
      flatpak: "org.chromium.Chromium"
    }
  ];
}

/**
 * @param {string} registryRoot e.g. "HKCU\Software"
 * @returns {Array<{key: string, name: string, hive: string}>}
 */
function windowsTargets(registryRoot) {
  // Windows registration never included "chromium" (no stock Chromium
  // registry convention on Windows) — matches install.sh's install_windows.
  return [
    { key: "chrome", name: "Google Chrome", hive: `${registryRoot}\\Google\\Chrome\\NativeMessagingHosts` },
    { key: "edge", name: "Microsoft Edge", hive: `${registryRoot}\\Microsoft\\Edge\\NativeMessagingHosts` },
    { key: "brave", name: "Brave", hive: `${registryRoot}\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts` }
  ];
}

/**
 * Return every registration target for `osKind` (unfiltered — callers that
 * care about `--only` apply {@link isWanted} themselves, since doctor's
 * report and install/uninstall's skip-messages need the full list either
 * way).
 *
 * @param {{osKind: "mac"|"linux"|"windows", homeRoot?: string, registryRoot?: string}} opts
 */
export function getBrowserTargets({ osKind, homeRoot, registryRoot }) {
  if (osKind === "mac" || osKind === "linux") {
    return unixTargets(osKind, homeRoot);
  }
  if (osKind === "windows") {
    return windowsTargets(registryRoot);
  }
  return [];
}

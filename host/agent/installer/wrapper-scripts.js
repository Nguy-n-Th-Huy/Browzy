// The launcher scripts Chrome actually execs (ported from install.sh's
// create_unix_wrapper / install.ps1's $BatContent):
//
//  - macOS/Linux: a `sh` wrapper that `exec`s node against native-host.js.
//  - Windows: a `.bat` that invokes node with CRLF endings ("%*" forwards
//    Chrome's args — the extension origin + parent-window handle, which the
//    host ignores; cmd.exe hands node the inherited std handles, so Chrome's
//    binary native-messaging stream flows straight to/from node).
//
// Both use the CURRENT process's own node executable (process.execPath),
// which is always an absolute, already-resolved path — more reliable than
// install.sh's `command -v node` PATH lookup, and there is no analogous
// "resolve node on PATH" step needed since this code is itself running
// under node already.

/**
 * @param {string} nodeExePath absolute path to the node executable.
 * @param {string} nativeHostJsPath absolute path to host/native-host.js.
 * @returns {string}
 */
export function generateUnixWrapperContent(nodeExePath, nativeHostJsPath) {
  return `#!/bin/sh\nexec "${nodeExePath}" "${nativeHostJsPath}"\n`;
}

/**
 * @param {string} nodeExePath absolute path to the node executable.
 * @param {string} nativeHostJsPath absolute path to host/native-host.js.
 * @returns {string}
 */
export function generateWindowsWrapperContent(nodeExePath, nativeHostJsPath) {
  return `@echo off\r\n"${nodeExePath}" "${nativeHostJsPath}" %*\r\n`;
}

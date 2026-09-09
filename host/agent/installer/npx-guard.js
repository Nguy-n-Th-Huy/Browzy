// Refuse to *register* a native-messaging host manifest whose absolute
// `path` points into an npx cache. npx installs a package into npm's `_npx`
// cache directory and does not keep it around — a manifest built from that
// path will point at a location that can vanish at any time, whose symptom
// ("the companion never connects") is indistinguishable from "the companion
// was never installed". `npm i -g <package>` installs into a stable,
// permanent global directory instead, so only that path is safe to bake
// into a manifest.

import path from "node:path";

/**
 * @param {string} packageDir absolute path to the installer's own package
 *   directory (i.e. where `browzy`'s code is actually running from).
 * @returns {boolean} true iff `packageDir` looks like an npx cache install
 *   rather than a stable global install.
 */
export function isNpxCacheDir(packageDir) {
  const normalized = String(packageDir).split(path.sep).join("/").split("\\").join("/");

  // npm's npx cache always contains a literal "_npx" path segment, e.g.
  //   ~/.npm/_npx/<hash>/node_modules/@scope/pkg                  (POSIX)
  //   C:\Users\<user>\AppData\Local\npm-cache\_npx\<hash>\...      (Windows)
  //
  // Deliberately NOT a broader "under the OS temp dir" heuristic: no
  // supported npm version stages an npx install there, and it would
  // misfire on anything merely built/tested under a temp directory (e.g. a
  // dev checkout cloned into /tmp, or this project's own test suite).
  return /(^|\/)_npx(\/|$)/.test(normalized);
}

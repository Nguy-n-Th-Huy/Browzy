// Shared constants for native-messaging-host registration (install/uninstall/
// doctor). Kept in one place so the CLI, the tests, and every platform branch
// agree on the exact same host name, description, and default extension id.

// Must match the native messaging host manifest `name` install.sh/install.ps1
// have always used, and the key every browser-registration path (registry
// value name on Windows, filename on macOS/Linux) is built from.
export const HOST_NAME = "com.anthropic.browzy_in_chrome";

// The native messaging host manifest `description` field.
export const HOST_DESCRIPTION = "Browzy Native Messaging Host";

// The extension id derived from extension/manifest.json's persistent public
// key (see host/agent/identity.js). The npm package ships host/ only — there
// is no extension/manifest.json alongside it to derive this from at install
// time — so the id is embedded here as a constant instead.
//
// This MUST stay in sync with the real manifest key. It is verified by
// host/test/installer-extension-id.test.mjs, which recomputes the id from
// the actual extension/manifest.json (via host/agent/identity.js) and fails
// loudly if this constant has drifted — a stale id here would silently
// register the wrong chrome-extension:// origin.
//
// Override at install time with `browzy install --extension-id <id>` (e.g.
// for a Chrome Web Store install, which is assigned its own id — see
// package-extension.sh).
export const EXTENSION_ID = "ihljfjgoakmoemkdondoaadegpmibimh";

# Report 13 (branding) — Browzy branding audit

**Scope:** Task 5.13 of the `migrate-to-claude-agent-sdk` change.

**Status:** DONE. All 80 tests pass (`node --test "test/*.test.mjs"
"host/test/*.test.mjs"` → 80/80).

**Spec authority.** `specs/browser-assistant-panel/spec.md` lines 102-103:
"The extension display name, assistant header, settings, onboarding and
product notifications SHALL use the approved name Browzy."

**Design constraint.** `design.md` line 27: "A branding change must not
rotate the extension public key, change its stable ID, rename native-
messaging host identifiers, change MCP server/tool identifiers or break
existing client launch paths."

---

## Browzy branding applied (user-facing surfaces)

### Extension display name and description

| File | Field | Value |
|---|---|---|
| `extension/manifest.json` line 3 | `name` | `"Browzy"` |
| `extension/manifest.json` line 5 | `description` | `"Browzy — Claude Agent SDK in your browser. No Claude account needed. Any Anthropic-compatible provider. Any Chromium browser."` |
| `extension/manifest.json` line 29 | `action.default_title` | `"Browzy — click to open the assistant panel"` |

The `name` field is the extension's display name shown in
`chrome://extensions` and the Chrome/Edge toolbar — the single most
user-facing name the extension has. Changing it does NOT affect the
extension ID (derived from the `key` field, line 62, unchanged).

### Side panel

| File | Surface | Value |
|---|---|---|
| `extension/sidepanel/sidepanel.html` | `<title>` | `Browzy` |
| `extension/sidepanel/sidepanel.html` | header title `<span class="panel-header-title">` | `Browzy` |

### Settings pages

| File | Surface | Value |
|---|---|---|
| `extension/settings/settings.html` | `<title>` | `Cài đặt — Browzy` |
| `extension/settings/skills.html` | `<title>` | `Skills — Browzy` |

### Recorder options

| File | Surface | Value |
|---|---|---|
| `extension/recorder/options.html` | `<title>` | `Browzy — Recorder` |
| `extension/recorder/options.html` | `<h1>` | `Browzy — Recorder` |
| `extension/recorder/options.js` | error message | `"open it in the Browzy extension Options to inspect"` |

### Background service worker

| File | Surface | Value |
|---|---|---|
| `extension/background.js` line 1 | comment header | `"Background service worker for the Browzy extension."` |
| `extension/background.js` | overlay message types | `browzyOverlayEvent`, `browzyOverlayTeardown` |

### Content script

| File | Surface | Value |
|---|---|---|
| `extension/content.js` line 1 | comment header | `"Content script for the Browzy extension."` |

### Pointer overlay

| File | Surface | Value |
|---|---|---|
| `extension/overlay/pointer-overlay.js` | CSS class names | `.browzy-cursor`, `.browzy-click-ring`, `.browzy-badge`, `.browzy-stop` |

### UI tokens

| File | Surface | Value |
|---|---|---|
| `extension/ui/tokens.css` line 1 | comment header | `"Shared design tokens for the Browzy extension UI."` |

### Installers

| File | Surface | Value |
|---|---|---|
| `install.sh` line 4 | comment | `"Install script for the Browzy extension."` |
| `install.sh` line 155 | native-messaging host `description` | `"Browzy Native Messaging Host"` |
| `install.ps1` line 3 | comment | `"Installs the Browzy native messaging host for Chrome, Edge, ..."` |
| `install.ps1` line 184 | native-messaging host `description` | `"Browzy Native Messaging Host"` |

### Host runtime

| File | Surface | Value |
|---|---|---|
| `host/tool-runtime.js` line 54 | NO_BRIDGE_ERROR text | `"...is running with the Browzy extension installed and enabled."` |

### Documentation

| File | Surface | Value |
|---|---|---|
| `docs/skills.html` line 6 | `<title>` | `Skills · Browzy user guide` |
| `docs/skills.html` line 140 | body text | `"Part of Browzy's user documentation."` |
| `README.md` line 2 | logo `alt` | `Browzy` |
| `README.md` line 5 | `<h1>` | `Browzy` |
| `README.md` line 9 | tagline | `Browzy gives you the whole web.` |
| `README.md` line 41 | historical description | `Browzy (originally Open Claude in Chrome) is a clean-room reimplementation ...` |
| `README.md` line 99 | product-facing restrictions claim | `Browzy has none of these restrictions.` |

---

## UNCHANGED technical identifiers (design.md line 27)

### Extension public key and stable ID

| File | Field | Status |
|---|---|---|
| `extension/manifest.json` line 62 | `key` (extension public key) | **UNCHANGED** — derives the stable extension ID; rotating it would break every installed user |

### Native-messaging host name

| File | Surface | Status |
|---|---|---|
| `install.sh` line 27 | `HOST_NAME="com.anthropic.open_claude_in_chrome"` | **UNCHANGED** |
| `install.ps1` line 66 | `$HostName = "com.anthropic.open_claude_in_chrome"` | **UNCHANGED** |
| `extension/background.js` line 13 | `const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome"` | **UNCHANGED** |

The native-messaging host name is the OS-level identifier the browser uses
to find and launch the companion process. Renaming it would break every
existing install.

### MCP server names

| File | Surface | Status |
|---|---|---|
| `host/mcp-server.js` line 40 | `name: "open-claude-in-chrome"` | **UNCHANGED** |
| `host/codemode/server-codemode.js` line 83 | `name: "open-claude-in-chrome-codemode"` | **UNCHANGED** |
| `host/codemode/server-hybrid.js` | `open-claude-in-chrome-hybrid` | **UNCHANGED** |
| `host/agent/tools/adapter.js` line 34 | `SDK_MCP_SERVER_NAME = "open-claude-in-chrome-browser"` | **UNCHANGED** |

### npm package names

| File | Field | Status |
|---|---|---|
| `host/package.json` line 2 | `"name": "open-claude-in-chrome-host"` | **UNCHANGED** |

(No root `package.json` exists.)

### Filesystem paths

| File | Path | Status |
|---|---|---|
| `host/agent/storage/paths.js` line 19 | `~/.config/open-claude-in-chrome/agent` | **UNCHANGED** |
| `host/endpoint.js` line 23 | `~/.config/open-claude-in-chrome/config.json` | **UNCHANGED** |
| `install.sh` | `~/.config/open-claude-in-chrome/` references | **UNCHANGED** |

### Pipe name (Windows named pipe)

| File | Surface | Status |
|---|---|---|
| `host/endpoint.js` line 56 | `\\.\pipe\open-claude-in-chrome-<user>` | **UNCHANGED** |
| `host/endpoint.js` line 71 | `open-claude-in-chrome-<uid>` | **UNCHANGED** |

### MCP registration command (legacy/external-MCP path)

| File | Surface | Status |
|---|---|---|
| `install.sh` line 375 | `claude mcp add open-claude-in-chrome -- node "$MCP_SERVER_DISPLAY"` | **UNCHANGED** |

---

## Verification

- **Consistent visible name:** every user-facing surface (extension display
  name, panel header, settings titles, recorder title, error messages,
  overlay CSS, listaller descriptions, docs, README heading) uses "Browzy".
  No user-facing surface retains "Open Claude in Chrome" as a product name.
  The one historical reference in `README.md` line 41 explicitly says
  `"Browzy (originally Open Claude in Chrome)"` — naming the project's
  origin without presenting the old name as the current product name.

- **Unchanged keyed identity:** the extension public `key` (line 62) is
  byte-for-byte unchanged, so the extension ID is stable.

- **Unchanged external MCP contracts:** the native-messaging host name
  (`com.anthropic.open_claude_in_chrome`), all MCP server names
  (`open-claude-in-chrome`, `-codemode`, `-hybrid`, `-browser`), the npm
  package name (`open-claude-in-chrome-host`), the filesystem path
  (`~/.config/open-claude-in-chrome/`), the Windows pipe name
  (`\\.\pipe\open-claude-in-chrome-<user>`), and the legacy `claude mcp add`
  command are all byte-for-byte unchanged. No client launch path, MCP
  registration, or existing install is affected.

- **All 80 tests pass** after the `manifest.json` `name`/`description` and
  `README.md` heading changes. No test, linter, or build step references the
  manifest's `name` or `description` field as a truth comparison (the
  extension ID is derived from `key`, not `name`).

---

## Summary

| Task | Status | Evidence |
|---|---|---|
| 5.13 | DONE | All user-facing surfaces use "Browzy"; all technical identifiers (key, native-messaging host name, MCP server names, npm package name, filesystem paths, pipe name, MCP registration command) byte-for-byte unchanged. 80/80 tests pass. |

---
name: browzy-setup
description: Use when a Browzy in Chrome browser tool call (navigate, computer, find, read_page, ...) hangs, times out, or returns "Browser extension is not connected", or when a user asks how to finish setting up the Browzy plugin. Explains the two-halves requirement and the exact command that closes the gap.
---

# Finishing Browzy in Chrome setup

Installing this plugin starts its bundled MCP server (`mcp-server.js`), which
gives Claude Code its browser-automation tools. That server is only **one
of two halves** Browzy needs to actually control a browser:

1. **The MCP server** (this plugin) — started automatically by Claude Code.
   It waits for the browser extension to connect to it over a local named
   pipe (Windows) or unix socket (macOS/Linux).
2. **The native messaging host registration** — a small file (and, on
   Windows, a registry entry) that tells Chrome/Edge/Brave "when the Browzy
   extension asks to talk to a native program, run this one." Chrome refuses
   to start native messaging at all without it, and it does not exist
   until it has been registered on this machine.

**Installing this plugin does not perform step 2.** Nothing about the Claude
Code plugin system registers native messaging hosts — that is outside its
scope by design. Left alone, this produces exactly the failure that follows:
tool calls hang for the full timeout, or fail with "Browser extension is not
connected", with nothing on screen explaining why.

## The fix

Run this once per machine, from the same package this plugin bundles:

```bash
npm i -g @huydepzai2810/browzy-host
browzy install
```

Then **restart the browser** (close every window, reopen) and make sure the
Browzy extension itself is loaded (`chrome://extensions` → enable Developer
mode → Load unpacked → the repo's `extension/` directory, or the Chrome Web
Store build). The plugin cannot install the browser extension either — only
the native host half.

## Diagnose without changing anything

```bash
browzy doctor
```

Reports, per installed browser, whether the native host is registered and
whether the file the registration points at still exists. `MISSING` means a
stale registration (the package directory moved, or was reinstalled
elsewhere) — rerun `browzy install` to fix it.

## Do not also register the standalone MCP server

If this machine already has the standalone/manual registration
(`claude mcp add browzy-in-chrome -- node .../mcp-server.js`), do not also
install this plugin. Both start the exact same MCP server, so running
both registers every tool twice, under two different name prefixes:

- Manual `claude mcp add`: `mcp__browzy-in-chrome__navigate`
- This plugin: `mcp__plugin_browzy_browzy-in-chrome__navigate`

Pick one path per machine. If you have existing permission rules written
against one tool-name prefix, they will not match the other — update them if
you switch paths.

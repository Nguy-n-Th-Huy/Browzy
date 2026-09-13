## Why

Three capabilities the panel is expected to have are reachable only by another route, or not at all.

Opening the assistant requires a mouse: the extension declares no keyboard command at all, so a user working in the page has to leave the keyboard to reach the panel. The machinery to close it already exists (`extension/background.js` sets `enabled: false` and calls `chrome.sidePanel.close()` where available); only the key binding is missing.

`execute_code` and `recording_ack` exist solely on the external MCP stdio entry points (`host/codemode/server-codemode.js`, `host/codemode/server-hybrid.js`). A user driving the agent from the side panel cannot run sandboxed code, and the panel's agent cannot acknowledge a recording it was handed — `extension/background.js` only handles `recording_ack` when it arrives from the MCP server. The SDK path and the MCP path have drifted into two different tool surfaces.

A conversation cannot leave the machine that made it. Transcripts, metadata and artifacts live under the companion's own conversation directory, and nothing reads or writes a portable form of them. `LIST_CONVERSATIONS` and `DELETE_CONVERSATION` message types exist in `host/agent/protocol.js` and `SessionManager` implements the matching methods, but `host/agent/companion.js` handles neither — so even listing what could be moved is unimplemented. A user who changes machines, or who wants a colleague to pick up an investigation, starts over.

## What Changes

- The extension declares a keyboard command that toggles the side panel: opens it when closed, closes it when open, on the tab the user is looking at.
- `execute_code` and `recording_ack` become available to the panel's agent through the same registry every other browser tool uses, with the same result, error and image shapes the MCP entry points already produce.
- A conversation can be exported to a single portable file and imported on another machine, carrying its transcript, metadata and artifacts.
- An imported conversation is explicitly marked as imported and is continued as a new run. The original provider-side session reference is not portable and SHALL NOT be presented as resumable elsewhere.
- Export excludes credentials and provider profile data; the bundle carries conversation content only.
- `list_conversations` and `delete_conversation` gain companion-side handlers, closing the documented gap that export/import depends on.

## Capabilities

### New Capabilities
- `agent-session-portability`: exporting a conversation to a portable bundle, importing one on another machine, what a bundle may and may not carry, and how an imported conversation is distinguished from one produced locally.

### Modified Capabilities
- `browser-assistant-panel`: gains a keyboard command that toggles the panel, and the export/import entry points together with the conversation list they operate on.
- `agent-browser-runtime`: `execute_code` and `recording_ack` join the operation set reachable from the panel's SDK path, and are recorded in the enumerated post-baseline additions rather than appearing as unaccounted-for registry entries.

## Impact

- `extension/manifest.json` — a `commands` entry with a suggested binding; the extension currently declares none.
- `extension/background.js` — a `chrome.commands.onCommand` handler reusing the existing open and close paths, and handling `recording_ack` from the panel's agent as well as from the MCP server.
- `host/tool-definitions.js`, `host/agent/tools/adapter.js` — the two added operations and their argument, result and error contracts.
- `host/codemode/` — the sandbox `execute_code` already runs in, reused rather than reimplemented.
- `host/agent/companion.js` — handlers for `list_conversations`, `delete_conversation`, and the export/import operations.
- `host/agent/storage/` — bundle writing and reading over the existing conversation directory layout (`events.jsonl`, `meta.json`, `artifacts/`).
- `extension/sidepanel/history-store.js` — its documented "Known protocol gap" note becomes obsolete and must be corrected rather than left describing a gap that no longer exists.
- `openspec/specs/agent-browser-runtime/spec.md`, `openspec/specs/browser-assistant-panel/spec.md` — the modified requirements above.
- Adding two operations to the registry interacts with the permission classification introduced by `add-permission-modes-and-threat-signals`: an operation with no classification entry resolves to protected and fails that change's registry coverage check. Both additions need an explicit, deliberate classification; `execute_code` runs arbitrary sandboxed code and is the more consequential of the two.

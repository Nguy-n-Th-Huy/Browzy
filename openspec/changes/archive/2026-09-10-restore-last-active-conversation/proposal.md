## Why

Closing the side panel — or restarting the browser — discards every visible trace of the conversation the operator was in the middle of. The panel remounts, `PanelController.currentConversationId` starts as `null`, and `boot()` unconditionally creates a brand-new conversation, so the operator lands in an empty chat and believes their session data was destroyed. The transcript is in fact still on disk (the companion persists it and already answers `resume`), which makes this a pure client-side loss of continuity: the panel has the data available and simply never asks for it.

## What Changes

- The panel records which conversation is currently active and persists that identity across panel unmounts and browser restarts.
- On startup the panel resumes that conversation instead of always creating a new one, so the operator continues where they left off.
- When the remembered conversation can no longer be resumed — the companion no longer knows it (reinstall, wiped agent home), or the operator deleted it locally — the panel silently falls back to a new conversation rather than stranding the operator in an empty, un-actionable chat.
- The fallback is scoped to startup restore only. A conversation the operator explicitly reopens from the history list still surfaces a real error if it cannot be resumed, and is never silently swapped for a different conversation.
- No wire protocol change and no companion change: `resume` and its `unknown_conversation` error reply already exist.

## Capabilities

### New Capabilities
<!-- None: this extends an existing panel capability rather than introducing a new one. -->

### Modified Capabilities
- `browser-assistant-panel`: adds a requirement that the panel restores the last active conversation when it is reopened, and defines the fallback behavior when that conversation is unresumable or was deleted locally. Today the spec only requires that reopening a conversation is *possible* (`Session and recording access`), never that the panel does so automatically on startup.

## Impact

- `extension/sidepanel/history-store.js` — gains persistence of the last-active conversation identity alongside the existing conversation index.
- `extension/sidepanel/panel-controller.js` — every assignment of the active conversation is funneled through one place so the persisted identity cannot drift; gains a DOM-free startup restore entry point and the `unknown_conversation` fallback path.
- `extension/sidepanel/sidepanel.js` — `boot()` calls the restore entry point instead of unconditionally starting a new conversation.
- `test/sidepanel-history-store.test.mjs`, `test/sidepanel-fake-companion.test.mjs` — coverage for persistence and for the three restore outcomes (restored, deleted-locally, unresumable) against the real companion core.
- No change to `host/**`, to the wire protocol version, or to any stored transcript format. A panel from before this change and one from after interoperate with the same companion.

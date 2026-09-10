## Why

The conversation-restore shipped in `restore-last-active-conversation` remembers a single conversation id for the whole browser profile. But a Browzy panel is per-tab: `syncSidePanelForTab()` enables the panel only on tabs the operator explicitly opened it on, and `side-panel-follows-active-tab` defines each such tab as "an independent agent scope... per-tab panel + per-tab page context". A profile-wide remembered id therefore leaks one tab's conversation into another tab's panel: the operator opens Browzy on a second, unrelated page and is handed the conversation from the first, instead of a fresh one. Continuity was restored at the cost of isolation between scopes that the product already promises are independent.

## What Changes

- The remembered conversation becomes per-panel-scope rather than per-profile. Each tab the panel is opened on restores only the conversation that was active in that tab, and a tab that has never had one starts fresh.
- The remembered identity now lives for exactly as long as the panel's own per-tab enablement does — a browser session. The set of tabs the panel is enabled on is already session-scoped (`chrome.storage.session`, cleared on browser restart), so after a restart the panel is not shown anywhere until the operator explicitly opens it again; that explicit open now starts a new conversation rather than resurrecting the last one from the previous session.
- **BREAKING** (behavioral, no API): the previously specified "remembered identity survives a browser restart" no longer holds, and is removed rather than left as an unmet promise. Continuity across a panel close within the same browsing session — the primary complaint behind the original bug report — is unchanged.
- Prior conversations remain reachable: nothing is deleted, and the history list still lists and reopens every conversation this profile knows about, across tabs and across restarts.

## Capabilities

### New Capabilities
<!-- None: this narrows the scope of requirements added by the previous change. -->

### Modified Capabilities
- `browser-assistant-panel`: `Last active conversation restored on reopen` gains a scope — the restore is per panel scope, not per profile — and drops its browser-restart scenario. `Restore falls back instead of stranding the operator` gains the no-identifiable-scope case as another fallback trigger.

## Impact

- `extension/sidepanel/history-store.js` — the last-active key becomes a per-scope map held in session-lifetime storage instead of a single profile-wide value in local storage.
- `extension/sidepanel/panel-controller.js` — the controller learns its panel scope and reads and writes the remembered identity under it.
- `extension/sidepanel/sidepanel.js` — `boot()` resolves the scope once, before restoring.
- `test/sidepanel-history-store.test.mjs`, `test/sidepanel-fake-companion.test.mjs` — coverage that two scopes sharing one storage each restore their own conversation, and that a third starts fresh.
- No change to `host/**`, to the wire protocol, or to any stored transcript. The conversation index itself stays in local storage and is untouched: only which conversation is *auto-restored* changes, never which conversations exist.

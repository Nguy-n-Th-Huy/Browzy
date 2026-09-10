## Context

See proposal.md — Why. The facts that decide the approach, all verified in source:

- The panel is per-tab. `background.js`'s `syncSidePanelForTab()` calls `chrome.sidePanel.setOptions({ tabId, enabled })` from `tabs.onActivated`, enabling the panel only on tabs in the explicitly-opened set. Every explicitly-opened tab therefore hosts its own panel document, booted independently.
- That explicitly-opened set lives in `chrome.storage.session` (`PANEL_ENABLED_TABS_SESSION_KEY`, `background.js:96`), which Chrome clears on browser restart. After a restart no tab is enabled, so the panel is not shown anywhere until the operator clicks the toolbar icon again — and `action.onClicked` treats that as a fresh explicit open, creating/assigning the tab's own numbered agent group.
- `side-panel-follows-active-tab` already states the model this change aligns with: each explicitly-opened tab is "an independent agent scope", with per-tab panel and per-tab page context.
- In `boot()`, `pageContext.start()` is awaited before the restore call, so the panel's tab is known by the time a scope is needed.
- `PageContextTracker` is a *following* tracker when unpinned: it moves to whatever tab becomes active in the window. It is therefore a correct source for "which tab is this panel on" only at boot, not continuously.

## Goals / Non-Goals

**Goals:**

- Two panels open in two tabs never show each other's conversation, and never interfere with each other's runs.
- The remembered identity and the panel enablement it describes share one lifetime, so neither can outlive the other and produce a restore into a scope that no longer exists.
- The scope resolution stays in one place, so no code path can accidentally read or write the remembered id unscoped.

**Non-Goals:**

- Preserving continuity across a browser restart. Explicitly dropped (proposal.md), because after a restart the operator's first action is always an explicit fresh open of the panel on a tab.
- Scoping the conversation *index* or history list. Those stay profile-wide in local storage: every conversation remains listed and reopenable from any tab. Only auto-restore is scoped.
- Following the operator's tab. A panel's scope is the tab it booted on and does not move, even though its page context does.
- Binding a conversation to a tab on the host side. The companion neither knows nor needs to know about tabs; this is entirely a panel-side question of which conversation opens automatically.

## Decisions

### Scope by the tab the panel booted on, captured once

The scope id is the tab id resolved at boot, frozen for the life of the panel document.

Alternative considered and rejected: read the scope from `PageContextTracker` on each access. It follows the active tab when unpinned, so a panel booted on tab A would start reading and writing tab C's remembered id the moment the operator glanced at another tab — silently corrupting a scope the panel does not belong to. Capturing once is what makes "this panel's scope" a stable fact.

Alternative considered and rejected: scope by the agent tab group (`Browzy`, `Browzy 2`, …) rather than the tab. Groups are recovered by title after a restart, which would offer cross-restart identity — but that identity is precisely what this change deliberately drops, and a group can contain several adopted tabs, which would reintroduce the leak within a group.

When no tab id can be resolved (a restricted or blank page where the tracker reports no usable tab), there is no scope to restore against, and the panel starts a new conversation. Writing this down matters: silently falling back to some other scope's id is the exact bug being fixed.

### Hold the remembered ids in session-lifetime storage, keyed by scope

The single last-active value becomes a mapping from scope id to conversation id, stored in `chrome.storage.session` rather than `chrome.storage.local`.

That mapping is realized as one storage key per scope, not as a single key holding a `{scope: id}` object. Two panel documents in two tabs are separate JS realms writing to the same session storage, and a shared object would force every write through read-modify-write: both panels read the same snapshot, each mutates its own entry in memory, and whichever `set()` lands last writes back a whole object that never contained the other's change — a lost update, silently. Per-scope keys need no read step at all, so two panels writing different scopes cannot conflict. The race stops being unlikely and becomes unrepresentable, which is the same standard applied to the session-vs-local choice below.

Clearing a scope writes `null` under that scope's key rather than deleting the key. Absent and explicitly-cleared then read identically — both mean "nothing remembered for this scope", which is exactly the question the restore path asks — and the store needs no delete path it would otherwise have to make failure-safe.

Session storage is not an implementation convenience here, it is the correctness argument: tab ids are only meaningful within a browser session, and the panel-enabled tab set they must agree with is itself session-scoped. Putting the map in local storage would let ids from a previous session survive into a new one where the same numeric tab id belongs to an entirely unrelated tab — restoring a stranger's conversation, a worse version of the bug being fixed. Sharing the lifetime makes that unrepresentable rather than merely unlikely.

The conversation index stays in local storage exactly as it is. The two have genuinely different lifetimes: what conversations exist is durable, which one auto-opens is not.

### Keep one setter, give it the scope

The controller already funnels every active-conversation assignment through a single setter. That stays; the setter gains the scope. The scope is supplied to the controller once as a resolver rather than threaded through each call site, so no call site can forget it and no future call site can reintroduce an unscoped write.

Entries for other scopes are read and written independently, so `deleteConversationLocally` clears only its own scope's entry and a restore reads only its own.

## Risks / Trade-offs

- **Continuity across a browser restart is gone** → Accepted deliberately (proposal.md). Nothing is lost, only auto-opened: the history list still lists and reopens every conversation from earlier sessions. The scenario that prompted the original bug report — closing and reopening the panel mid-conversation — is unaffected.
- **Entries accumulate for tabs closed during the session** → Bounded by the browser session, and each entry is a short string keyed by a numeric tab id, so the map cannot grow beyond the tabs the operator opened the panel on before restarting. Not worth pruning on `tabs.onRemoved`, which would couple the panel to a background event it does not otherwise observe.
- **`chrome.storage.session` is unavailable in some contexts** → The store already degrades to an in-memory fallback when its backing storage is missing, and every read resolves to "nothing remembered", which starts a new conversation — the safe direction.
- **Two panels racing on the same scope** → Not reachable: one panel document per tab, and the scope is that tab.

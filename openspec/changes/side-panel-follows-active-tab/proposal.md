## Why

After opening a page to control, pressing Ctrl+T (or opening any other tab) leaves the extension side panel still visible on the new tab. The panel chrome should be visible only on the tab where the toolbar icon was explicitly clicked; switching to any other tab must hide it.

## What Changes

- Close-on-switch: `syncSidePanelForTab` disables the panel (per-tab `chrome.sidePanel.setOptions`) for the newly activated tab unless that tab is explicitly enabled; returning to an explicitly-opened tab reshows the panel without a re-click. This governs panel *chrome visibility only*; `extension/sidepanel/page-context.js` content behavior (unpinned follows active tab, pinned ignores switch) is unchanged.
- Numbered independent agent-group family: group titles are `Browzy`, then `Browzy 2`, `Browzy 3`, … allocated as the next free number at creation time; titles are never duplicated. Each group is an independent agent scope: a tab belongs to exactly one group, groups are never merged, old groups are kept as-is.
- Single-group-id memory becomes a tracked group-id SET: every reader/writer of `tabGroupId` is migrated (sync, adopt/release, guard, recovery, onRemoved, `panel_bind_tab`, `ensureTabGroup` call sites). `onRemoved` removes just that id. Empty set means "no group", which keeps the panel enabled everywhere (preserves first-run openability).
- Explicit icon click path: enables + opens the tab-scoped panel (never window-scoped) on the clicked tab, then creates/assigns its numbered group — including on blank New Tabs (`explicit: true` skips the blank guard). The blank-tab passive path never adopts and never enables.
- Post-restart recovery finds ALL family titles (`Browzy`, `Browzy N`, plus legacy `MCP Browzy` / `MCP` for pre-existing groups). Legacy titles are recognized, never created.
- No auto-cleanup: stale groups are never deleted and user tabs are never closed (accumulation tradeoff stated in design).
- Honesty scope: "independent" means separate groups + per-tab panel + per-tab page context on top of the existing conversation/run machinery — NOT a new multi-agent orchestrator.

## Capabilities

### New Capabilities

None — this change modifies existing spec-level behavior only.

### Modified Capabilities

- `browser-assistant-panel`: panel chrome visibility rule — visible only on the explicitly-enabled tab; hidden on every other tab including blank New Tabs; per-tab enablement via `chrome.sidePanel.setOptions` (Chrome has no close call).
- `agent-browser-runtime`: agent tab-group scope becomes a numbered, never-merged family (`Browzy`, `Browzy 2`, …) with set-based tracking, next-free-number allocation (incl. best-effort race handling), full-family post-restart recovery, no auto-cleanup, and unchanged group-membership authority semantics.

## Impact

- `extension/background.js` only: `AGENT_TAB_GROUP_TITLE` family + numbering allocator, `tabGroupId` → tracked group-id set (+ `resolveAgentGroupId` title recovery), `syncSidePanelForTab` + `onActivated`/`onUpdated(groupId)` triggers, `action.onClicked`, `adoptBorrowedTab` blank guard / `isBlankNewTab`, `guardInheritedTabGroup` + `looksLikeOperatorNewTab` + `recentlyCreatedTabs` window, `tabGroups.onRemoved`, `recoverTabGroupState`, `panel_bind_tab` handler, `ensureTabGroup` call sites, `isInGroup` authority boundary.
- Tests: existing suites `test/side-panel-group-scope.test.mjs`, `test/tab-group-inheritance.test.mjs`, `test/overlay-background-bridge.test.mjs` must stay green; new unit tests for the blank × group × explicit matrix, numbering allocation (race + restart recovery), and single-id `onRemoved` removal. `test/_extract.mjs` constraints respected (no destructured params, named top-level functions, brace-balanced strings).
- Out of scope: overlay, recorder, MCP servers, skills, settings, tool schemas, tab closing, new orchestrator.

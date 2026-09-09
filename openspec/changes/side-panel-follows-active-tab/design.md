## Context

See proposal.md (Why) for motivation. Current state in `extension/background.js` (all anchors verified by reading):

- Single-group memory: `let tabGroupId = null` (:18); `AGENT_TAB_GROUP_TITLE = "Browzy"` (:33); `LEGACY_TAB_GROUP_TITLES` (:37).
- Panel visibility rule: `syncSidePanelForTab` (:5868–5898) enables the panel only when the tab's `groupId` equals the resolved group, and keeps it enabled everywhere when no group resolves ("no group = enabled", :5840–5843, first-run openability). Triggers: `tabs.onActivated` (:5889–5891), `tabs.onUpdated` on `groupId` (:5896–5898), one-shot active-tab sync at worker start (:5904–5911), `tabGroups.onRemoved` (:5915–5925, today nulls the single id).
- Title recovery after MV3 eviction: `resolveAgentGroupId` (:5850–5866) queries `Browzy` then legacy titles; `isInGroup` does its own recovery (:1893–1903).
- Explicit click: `action.onClicked` (:5958–5991) — `setOptions({tabId, path, enabled:true})`, tab-scoped `sidePanel.open({tabId})` (never window-scoped, :5972–5978), then `adoptBorrowedTab(tab.id, {explicit:true})` (:5984).
- Blank guard: `isBlankNewTab` (:1947–1952, `BROWSER_NEW_TAB_URL` :1945), `adoptBorrowedTab` (:1963–2001) returns false for passive blank tabs (:1977) but adopts explicit ones; builds the group out of the tab itself when none exists (:1984–1992).
- Inheritance guard: `guardInheritedTabGroup` (:6296–6356) evicts operator tabs Chrome auto-files into the group (incl. `+` button inside a group via the `recentlyCreatedTabs` window :6231–6253 + `onUpdated groupId` path :6371–6379), keeps agent tabs (`tabGroupTabs` / `sdkAgentCreatedTabs` / `adoptedBorrowedTabs` claims, :6308–6314), re-checks blank via `looksLikeOperatorNewTab` (:6257–6270) even mid-run (:6341).
- Recovery + bind: `recoverTabGroupState` (:6402–6417, first title match wins), `panel_bind_tab` handler (:6002–6015, passive `adoptBorrowedTab` without `explicit`).
- Authority boundary: `isInGroup` (~:1890–1922) — adopted borrowed tabs return false (:1915) so visibility membership never becomes legacy MCP authority; group membership alone grants legacy authority (`tab.groupId === tabGroupId`, :1916).
- Content vs chrome: `extension/sidepanel/page-context.js` `PageContextTracker._onActivated` follows the active tab unless pinned (:133–137) — panel *content*; this change governs panel *chrome visibility* only.

## Goals / Non-Goals

**Goals:**

- Panel chrome visible only on the explicitly-enabled tab; hidden everywhere else, including blank New Tabs.
- Numbered group family (`Browzy`, `Browzy 2`, …) with next-free-number allocation, set-based tracking, full-family recovery, no merges, no auto-cleanup.
- Every `tabGroupId` reader/writer migrated with defined per-site behavior; error paths best-effort, never throwing on event/click paths.

**Non-Goals:**

- Overlay, recorder, MCP servers, skills, settings, tool schemas (untouched).
- Closing user tabs, deleting stale groups, new multi-agent orchestrator (explicitly excluded).
- Changing page-context content rules (pinned/unpinned follow behavior stays byte-for-byte).

## Decisions

1. **Numbered titles via next-free-number scan, not a counter.** A persisted counter drifts after external deletes/restarts; scanning live `tabGroups.query` results for `Browzy` / `Browzy N` occupancy at creation time always yields a collision-free title. Alternative (monotonic counter in storage) rejected: gaps from user-deleted groups would either be reused (confusing) or permanently skipped (unbounded growth).
2. **Best-effort race handling on the click path.** Two racing explicit clicks each re-query after a failed `tabGroups.update`/group race and increment to the next free number; if allocation still cannot be secured, the tab stays ungrouped-but-enabled. Never throw: the click path already swallows errors (`.catch(() => {})`, :5970, :5975, :5984) and allocation must preserve that.
3. **Set-based tracking (`trackedAgentGroupIds: Set<number>`) replacing the scalar, with `tabGroupId` kept only as a derived/compat alias if call sites require it.** Per-site behavior:
   - `syncSidePanelForTab`: enabled iff tab's `groupId` is in the set; empty set → enabled everywhere (preserves :5840–5843 first-run rule).
   - `resolveAgentGroupId` → `resolveAgentGroupIds`: query every family title (`Browzy`, `Browzy N` pattern, legacy titles) and return all matching ids.
   - `adoptBorrowedTab` / `releaseBorrowedTab`: adopt into the target (most-recent/explicit) group; release returns the tab to its recorded previous group (unchanged).
   - `guardInheritedTabGroup`: "ours" means member of any tracked id; evict operator tabs from whichever tracked group Chrome filed them into; keep-claims (`tabGroupTabs`, `sdkAgentCreatedTabs`, `adoptedBorrowedTabs`) unchanged.
   - `recoverTabGroupState`: collect ALL family matches (not first-wins as today, :6404–6408).
   - `tabGroups.onRemoved`: delete just that id; re-sync the active tab (empty set re-enables).
   - `panel_bind_tab`: passive adopt path unchanged (no `explicit`), targeting the current group.
   - `ensureTabGroup` call sites (tabs_create_mcp ~:3494–3550, context listing ~:3650–3756): operate on / create within the numbered family; never merge.
4. **Explicit click keeps its exact order and gains group assignment.** `setOptions(enable)` → tab-scoped `open({tabId})` (window-scoped `open({windowId})` stays a fallback only when `tab.id` is null, :5974–5978) → explicit adopt into a numbered group. The blank guard stays skipped for `explicit: true`; the passive path (`panel_bind_tab`, context follow) keeps the blank guard.
5. **No auto-cleanup, stated tradeoff.** Stale groups accumulate (one per distinct control context over time). Accepted because auto-deletion risks destroying the operator's tabs/context; the cost is a growing set of small collapsed groups, which the operator can delete manually (single-id removal handles that).
6. **Authority semantic preserved per group.** `isInGroup` grants legacy authority for membership in ANY tracked family group; adopted-borrowed-tab exclusion (:1915) stays. No silent widening: only title-family membership confers it.
7. **Test-extraction constraints honored.** New/edited functions in `background.js` keep named top-level function declarations, options objects instead of destructured params (cf. :1964–1968), and brace-balanced bodies so `test/_extract.mjs` keeps working.

## Risks / Trade-offs

- [Risk] Group accumulation clutters the tab strip → Mitigation: numbered titles make ownership obvious; document manual deletion; single-id `onRemoved` keeps tracking correct.
- [Risk] Allocation race creates a duplicate title → Mitigation: re-check-then-increment loop; queries are the source of truth, never cached titles.
- [Risk] SW eviction mid-flow loses the in-memory set → Mitigation: every read path recovers by title family before deciding (as `resolveAgentGroupId`/:1893–1903 already do); failures resolve to "enabled", never to hiding the panel on a guess.
- [Risk] `chrome.tabs.get` / `tabGroups.query` / `setOptions` failures on event paths → Mitigation: best-effort catch-and-skip everywhere (existing style: :5876–5879, :6348–6353, :5970); tab-vanished-mid-check returns without configuring.
- [Risk] Window-scoped `open` fallback would ignore per-tab disables → Mitigation: fallback only when `tab.id == null`; explicit path always tab-scoped.
- [Risk] Dragging a tab between groups is a user choice → Mitigation: `guardInheritedTabGroup` leaves deliberate drags alone (only `recentlyCreatedTabs`-window groupings are judged, :6377); sync follows the tab's actual `groupId`.

## Edge cases (explicit handling)

- `+` button INSIDE a group: temp membership, then evict via the `recentlyCreatedTabs` + `onUpdated(groupId)` path; blank + passive ⇒ never adopted, never enabled.
- Ctrl+T mid-run: same as above; run keeps its original target (page-context run binding unchanged).
- Tab dragged between groups: left alone (deliberate choice); panel sync follows live `groupId`.
- Pinned page-context tab: chrome visibility follows the active tab's enablement; composer content keeps the pin.
- Window-scoped open fallback: only when `tab.id == null`; normal path is tab-scoped.
- SW eviction mid-flow: recover set by title family; fail-open to enabled.
- Tab vanished mid-check: return without configuring (existing :5876–5879 pattern).
- Rapid double-click on icon: idempotent adopt (`adoptedBorrowedTabs.has` early-return, :1969) + allocation race loop; one group, panel enabled.
- Group deleted by user externally: `onRemoved` drops just that id; active tab re-synced.

## Migration Plan

No migration: additive behavior change behind existing entry points; legacy-titled groups are adopted, never renamed or moved. Rollback is the previous single-group behavior.

## Open Questions

None — user-confirmed decisions (numbering, no-merge, no-cleanup, per-tab disable semantics, blank-tab rule, honesty scope) are settled and encoded above.

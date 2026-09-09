## 1. Numbered group family allocator

- [ ] 1.1 Add next-free-number title allocation (`Browzy`, `Browzy 2`, …) with live `tabGroups.query` as source of truth, best-effort re-check-and-increment race loop, and ungrouped-but-enabled fallback that never throws on the click path
- [ ] 1.2 Route explicit adoption (`action.onClicked`, `explicit: true`) through the allocator; keep the passive blank-tab guard (`isBlankNewTab` + `adoptBorrowedTab` blank check) unchanged
- [ ] 1.3 Add unit tests for allocation: first group, next-free-number with gaps, duplicate titles never issued, racing double-click resolves to distinct groups, restart recovery finds all family titles plus legacy titles ← (verify: title pattern `Browzy`/`Browzy N` exact, race never throws, legacy titles recognized-not-created)

## 2. Single-group-id to tracked-set refactor

- [ ] 2.1 Replace scalar `tabGroupId` memory with a tracked group-id set; migrate `resolveAgentGroupId` to family-wide resolution, `syncSidePanelForTab` to set membership (empty set = enabled everywhere), and `recoverTabGroupState` to collect ALL family matches
- [ ] 2.2 Migrate `adoptBorrowedTab`/`releaseBorrowedTab`, `guardInheritedTabGroup`, `isInGroup` recovery, `panel_bind_tab`, and all `ensureTabGroup` call sites to the set with the per-site behavior in design.md Decision 3; `onRemoved` removes just that id and re-syncs the active tab ← (verify: every `tabGroupId` reader/writer enumerated and migrated, group authority semantic unchanged, no `_extract.mjs` violations)
- [ ] 2.3 Add unit tests for set tracking: multi-group membership, single-id `onRemoved` removal, empty-set openability, drag-between-groups left alone ← (verify: removal is per-id, empty set enables panel everywhere)

## 3. Close-on-switch panel visibility

- [ ] 3.1 Confirm `syncSidePanelForTab` disables the panel per-tab on `onActivated`/`onUpdated(groupId)` for any tab outside the tracked set (including blank New Tabs), keeps tab-scoped enable+open on the explicit path, and leaves `page-context.js` content behavior untouched
- [ ] 3.2 Add unit tests for the blank-URL × in-group/out-of-group × explicit/passive matrix ← (verify: passive blank tabs never adopted nor enabled; explicit blank tabs adopted and enabled)
- [ ] 3.3 Keep regression suites green: `test/side-panel-group-scope.test.mjs`, `test/tab-group-inheritance.test.mjs`, `test/overlay-background-bridge.test.mjs` ← (verify: all three suites pass unmodified in intent)

## 4. Edge cases, error paths, and acceptance

- [ ] 4.1 Cover edge cases: `+` inside a group (temp membership then evict), Ctrl+T mid-run, pinned page-context tab, window-scoped open fallback, SW eviction mid-flow, tab vanished mid-check, group deleted externally — all best-effort catch-and-skip, never throwing on event paths
- [ ] 4.2 Operator-run live browser acceptance (NOT claimed done until executed): control a page → Ctrl+T → panel hidden on New Tab; click icon on New Tab → numbered group created, panel opens there; switch back → old tab panel state per its own enablement; switch to a plain tab → hidden ← (verify: concrete pass/fail observed in a live browser)

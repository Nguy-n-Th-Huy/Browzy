## ADDED Requirements

### Requirement: Numbered independent agent tab-group family

Agent tabs SHALL be organized in a numbered family of independent groups, not a single group. The first group is titled `Browzy`; each further group created while that title is taken is titled `Browzy N` (`Browzy 2`, `Browzy 3`, …) using the next free number at creation time. Group titles SHALL never be duplicated. Each group is an independent agent scope: a tab belongs to exactly one agent group, groups are never merged, and old groups are kept as-is. Stale groups SHALL never be auto-deleted and user tabs SHALL never be closed by group management (accumulation is the accepted tradeoff). After a service-worker restart, recovery SHALL recognize ALL family titles (`Browzy`, every `Browzy N`, plus legacy `MCP Browzy` and `MCP` for pre-existing groups); legacy titles are recognized but never created. When two explicit enablements race, allocation SHALL re-check and increment on a best-effort basis and SHALL never throw on the click path — if no free number can be secured, the tab stays ungrouped-but-enabled. Group membership SHALL keep its existing authority semantic: membership in any tracked agent-family group grants the same legacy MCP authority that membership in the single group previously granted (`isInGroup` boundary), and no silent widening beyond title-family membership is permitted. "Independent" means separate groups plus per-tab panel plus per-tab page context on top of the existing conversation/run machinery — it SHALL NOT introduce a new multi-agent orchestrator.

#### Scenario: Second explicit click creates Browzy 2

- **WHEN** the operator clicks the toolbar icon on a tab while a `Browzy` group already exists
- **THEN** the new tab is placed in a group titled `Browzy 2`, and the existing `Browzy` group and its tabs are untouched

#### Scenario: Titles are never duplicated

- **WHEN** groups `Browzy` and `Browzy 2` both exist and another explicit click occurs
- **THEN** the new group is titled `Browzy 3`, never `Browzy` or `Browzy 2` again

#### Scenario: Groups are never merged

- **WHEN** multiple agent groups exist and tabs move, runs start, or recovery executes
- **THEN** every tab remains in exactly one group and no two groups are combined

#### Scenario: Stale groups and tabs are kept

- **WHEN** an agent group has no remaining live purpose (run ended, tabs navigated away)
- **THEN** the group is left in place and no user tab is closed or moved by cleanup

#### Scenario: Restart recovers the whole family

- **WHEN** the service worker restarts with `Browzy` and `Browzy 2` groups present (and optionally a legacy-titled group)
- **THEN** all of them are tracked again without creating a duplicate group beside them

#### Scenario: Allocation race never breaks the click

- **WHEN** two explicit icon clicks race each other
- **THEN** each resolves to a distinct free number, or a tab that cannot secure one stays ungrouped-but-enabled, and neither click path throws

### Requirement: Tracked agent groups are a set, and empty means no group

The runtime SHALL track agent groups as a set of group ids rather than a single group id. Removing a group (user deletes it externally, or `tabGroups.onRemoved` fires) SHALL remove just that id from the set. An empty set means "no group", in which state the panel stays enabled everywhere so the extension remains openable for first-run use.

#### Scenario: Deleting one group leaves the others tracked

- **WHEN** the operator deletes the `Browzy 2` group externally while `Browzy` still exists
- **THEN** only that id leaves the tracked set and tabs in `Browzy` keep their panel and scope behavior

#### Scenario: No groups means panel enabled everywhere

- **WHEN** no tracked agent group exists (fresh install, or all groups removed)
- **THEN** the panel remains enabled on every tab so the operator can start from the panel

### Requirement: Passive blank tabs never join a group or gain the panel

A blank New Tab (as classified by the existing blank-tab check) that becomes active passively — Ctrl+T, the `+` button, or page-context following — SHALL NOT be adopted into any agent group and SHALL NOT gain an enabled panel. Only an explicit toolbar-icon click on that tab adopts and enables it.

#### Scenario: Ctrl+T mid-run stays outside every group

- **WHEN** the operator presses Ctrl+T in the middle of an agent run
- **THEN** the New Tab is left ungrouped (evicted if Chrome auto-filed it into a group) and its panel stays disabled, and the run keeps its original target

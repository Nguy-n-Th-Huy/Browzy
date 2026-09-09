## ADDED Requirements

### Requirement: Side panel chrome follows the explicitly-enabled tab

The side panel chrome SHALL be visible only on the tab where the toolbar icon was explicitly clicked. Switching to any other tab SHALL hide the panel chrome for that tab via per-tab disable (`chrome.sidePanel.setOptions` with `enabled: false`; Chrome provides no close call). Returning to an explicitly-opened tab SHALL reshow the panel without requiring another click. "Closed" for any tab means per-tab disabled. This requirement governs panel *chrome visibility only*; panel *content* behavior defined by `extension/sidepanel/page-context.js` (unpinned context follows the active tab, pinned context ignores tab switches) is unchanged.

#### Scenario: Ctrl+T hides the panel on the New Tab

- **WHEN** the operator controls a page with the panel open and then presses Ctrl+T (or otherwise opens a blank New Tab)
- **THEN** the panel chrome is hidden on the New Tab while the original tab keeps its own enablement state

#### Scenario: Returning to the explicitly-opened tab reshows the panel

- **WHEN** the operator switches back to the tab where the toolbar icon was explicitly clicked
- **THEN** the panel is visible again with no re-click required

#### Scenario: Switching to a plain tab hides the panel

- **WHEN** the operator switches from an explicitly-enabled tab to any other ordinary tab
- **THEN** the panel chrome is hidden on that tab

#### Scenario: Explicit click on a New Tab opens the panel there

- **WHEN** the operator clicks the toolbar icon while a blank New Tab is active
- **THEN** the panel is enabled and opened tab-scoped on that New Tab (never window-scoped), even though the passive path would never adopt a blank tab

#### Scenario: Pinned page-context tab keeps its content rule

- **WHEN** the composer has pinned a tab and the operator switches tabs
- **THEN** the panel chrome follows the per-tab visibility rule above while the composer content keeps showing the pinned tab (content rule unchanged)

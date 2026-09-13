## Purpose

Keep the assistant anchored to the page the user is viewing so common requests work without manual tab setup.

## ADDED Requirements
### Requirement: Active page binding
The panel SHALL expose the active tab's URL, title, tab ID, and document identity before a browser-dependent run.
#### Scenario: User asks about current page
- **WHEN** the panel is open and the active tab changes
- **THEN** the binding updates and the next read operation targets that tab without creating a new tab.
### Requirement: Stale binding protection
The system SHALL reject a bound read or mutation when the document identity no longer matches and SHALL request refreshed context.
#### Scenario: Page navigates while run is paused
- **WHEN** the bound tab navigates or reloads
- **THEN** the pending action is blocked and the panel shows a refresh-context action.
### Requirement: Pin and remove
Users SHALL be able to pin the current tab or remove the binding without closing the conversation.
#### Scenario: User pins a research tab
- **WHEN** pin is selected
- **THEN** active-tab changes do not retarget the run until the user unpins it.

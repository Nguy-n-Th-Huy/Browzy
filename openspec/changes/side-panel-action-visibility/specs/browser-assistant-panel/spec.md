## Purpose

Make browser automation observable and controllable through a live visual status shared by the page and side panel.

## ADDED Requirements
### Requirement: Live action status
The panel SHALL show the current tool, target tab, action label, elapsed time, and stop control.
#### Scenario: Agent clicks a button
- **WHEN** a click is dispatched
- **THEN** the panel shows the click as running and marks success or failure when the result arrives.
### Requirement: Cursor and timeline
The controlled page SHALL display an optional cursor indicator, while the panel SHALL retain ordered action entries with screenshot thumbnails.
#### Scenario: User inspects a completed run
- **WHEN** the run ends
- **THEN** each action can be selected to view its screenshot and result details.
### Requirement: Pause and approval
The user SHALL be able to stop a run and answer approval requests from the same visible action surface.
#### Scenario: Protected send action
- **WHEN** approval is required
- **THEN** execution pauses, the action and destination are shown, and no dispatch occurs until a decision is made.

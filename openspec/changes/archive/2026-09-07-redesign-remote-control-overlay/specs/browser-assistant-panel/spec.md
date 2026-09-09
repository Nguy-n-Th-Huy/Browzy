## MODIFIED Requirements

### Requirement: Visible agent pointer and control status
During pointer-based browser actions, the controlled page SHALL display a distinct agent cursor at the actual dispatched coordinates, with movement, click feedback and drag state. The cursor SHALL identify the agent by name and SHALL name the action currently in flight. The page SHALL display an active-control indicator with a Stop control, and that indicator SHALL hold one fixed position on screen for the whole session rather than moving in response to pointer position. The page SHALL indicate active control for as long as the run holds the page, including while no action is being dispatched. A viewer who has asked the operating system to reduce motion SHALL still receive a persistent, non-animated indication of active control. The cursor SHALL be a page overlay independent of the user's physical mouse, SHALL not intercept page input, and SHALL not appear on unrelated tabs. Read-only extraction or page-script execution SHALL not fabricate mouse movement.

#### Scenario: Visible click and drag
- **WHEN** the agent moves, clicks or drags in the visible authorized page
- **THEN** its pointer follows the dispatched path, marks the dispatched click or held drag, and does not cover or intercept the target interaction

#### Scenario: The cursor says who and what
- **WHEN** the agent dispatches an action of any kind at a known pointer position
- **THEN** the cursor carries a label naming the agent and describing the action in flight, distinguishing at minimum an ordinary action, a held drag, and a period with no action in flight
- **AND** the label describes only actions the agent actually dispatched — no action name is shown for a read, an extraction or a page-script call, which move no pointer

#### Scenario: The control indicator does not move
- **WHEN** the agent's pointer moves anywhere in the viewport during a run
- **THEN** the active-control indicator stays in the same screen position it occupied before the move, so its Stop control is always found in one place

#### Scenario: Control is visible between actions
- **WHEN** a run holds the page but dispatches nothing for several seconds
- **THEN** the page continues to indicate that it is under active control
- **AND** the indication clears within 3 seconds of the run ending, the controller disconnecting, or the extension ceasing to signal

#### Scenario: Reduced motion still shows control
- **WHEN** the viewer's system requests reduced motion
- **THEN** animated indication is suppressed and a static, persistent indication of active control remains visible for the whole run

#### Scenario: Stop and disconnect
- **WHEN** the user presses Stop in either the panel or page indicator, or the browser controller disconnects
- **THEN** further actions are blocked, the cursor/active indicator is cleared, and the panel reports stopped or interrupted state without claiming an in-flight action was undone

#### Scenario: Background tab or unavailable overlay
- **WHEN** the target is a background tab or the browser prevents overlay rendering
- **THEN** the panel identifies the actual target and the unavailable visual feedback; no cursor is drawn on the user's unrelated foreground tab and no focus switch happens without user authorization

## ADDED Requirements

### Requirement: Blocked-on-approval is visible on the controlled page
When a run is blocked waiting for the operator to approve an action, the controlled page SHALL show that the run is waiting and what it is waiting for, distinguishably from a run that is proceeding. The approval decision itself SHALL NOT be takeable from the controlled page: the page indicator SHALL offer no control that grants or denies the pending action, and SHALL instead route the operator to the panel where the decision is made. The page SHALL return to its ordinary active-control indication once the decision is recorded, whoever recorded it.

The prohibition is not stylistic. The agent's own pointer input is dispatched at browser level, is indistinguishable from the operator's by any trust signal available to page content, and reaches any coordinate on the controlled page. A grant control rendered there would sit within the pointer reach of the agent requesting the grant.

#### Scenario: A run blocked on approval
- **WHEN** a run requests the operator's approval for an action
- **THEN** the controlled page's indicator shows the waiting state and names the action awaiting a decision
- **AND** the indicator offers no control that would grant or deny it

#### Scenario: The decision is recorded elsewhere
- **WHEN** the operator grants or denies the pending action in the panel
- **THEN** the controlled page's indicator leaves the waiting state without the operator having to touch the page

#### Scenario: A stale waiting state cannot persist
- **WHEN** a run ends, is stopped, or the controller disconnects while an approval is still pending
- **THEN** the waiting indication is cleared on the same terms as every other active-control indication, and never outlives the run that raised it

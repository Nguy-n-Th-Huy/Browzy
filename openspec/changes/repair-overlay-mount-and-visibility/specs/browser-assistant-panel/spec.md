## MODIFIED Requirements

### Requirement: Visible agent pointer and control status
During pointer-based browser actions, the controlled page SHALL display a distinct agent cursor at the actual dispatched coordinates, with movement, click feedback and drag state. The cursor SHALL identify the agent by name and SHALL name the action currently in flight. The page SHALL display an active-control indicator with a Stop control, and that indicator SHALL hold one fixed position on screen for the whole session rather than moving in response to pointer position. The page SHALL indicate active control for as long as the run holds the page, including while no action is being dispatched, and SHALL do so whether or not the run named a specific tab when it started. A viewer who has asked the operating system to reduce motion SHALL still receive a persistent, non-animated indication of active control. Pointer movement between dispatched actions SHALL be drawn as continuous movement rather than as an instantaneous jump, without the drawn path ever implying a coordinate the agent did not dispatch. Any suppression of the indication for image capture SHALL be bounded in time and SHALL end on its own, so a run that is still holding the page can never be left with no indication. The cursor SHALL be a page overlay independent of the user's physical mouse and SHALL not appear on unrelated tabs. The overlay's own markup SHALL NOT be reported as page content by any page read, text extraction or element search. Read-only extraction or page-script execution SHALL not fabricate mouse movement.

While a run holds a page, the user's pointer, mouse, wheel, touch and keyboard input directed at that page's content SHALL be suppressed, and only on the pages that run actually holds. Suppression SHALL apply only to input that originates from a person or from the agent, and SHALL NOT affect events the page's own scripts generate. Suppression is a guard against unintended interaction, NOT an enforcement boundary: a page that intercepts its own input first can bypass it, and the product SHALL NOT present it as a guarantee. The suppression SHALL NOT prevent the agent from acting on the page. The overlay's own controls SHALL remain operable throughout. Browser-level control — closing or switching tabs, the address bar, and the assistant panel — SHALL remain unaffected. The suppression SHALL be lifted while the run is waiting for the user's approval decision, and SHALL end within 3 seconds of the run ending, the controller disconnecting, or the extension ceasing to signal. While input is suppressed, the page SHALL make that state visible to the user before they attempt to interact, and every visual sign of it SHALL be removed when suppression ends. The indication of active control SHALL NOT alter the page's own appearance beyond that signal.

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

#### Scenario: Control is visible for a run that named no tab
- **WHEN** a run starts without an explicit tab scope and holds pages the operator's browser already groups together
- **THEN** those pages indicate active control from the start of the run, without waiting for a dispatched action that happens to name a tab
- **AND** a page the run does not hold shows no indication

#### Scenario: Indication survives a lost capture signal
- **WHEN** the indication is suppressed so an image capture excludes it, and the signal that would restore it never arrives or arrives out of order
- **THEN** the indication returns on its own within a bounded interval while the run is still holding the page
- **AND** a later capture's suppression is never cancelled by a restore belonging to an earlier one

#### Scenario: Pointer movement reads as movement
- **WHEN** consecutive dispatched actions are far apart in the viewport and separated by seconds of no dispatch
- **THEN** the cursor is drawn travelling between the two dispatched coordinates rather than disappearing from one and reappearing at the other
- **AND** no click, drag or action label is shown at any coordinate along that path

#### Scenario: The overlay is not page content
- **WHEN** the agent reads the page, extracts its text, or searches it for an element while the overlay is displayed
- **THEN** the result contains none of the overlay's own markup, text or controls

#### Scenario: The user cannot disturb the page mid-run
- **WHEN** a run is holding a page and the user clicks, types, scrolls or right-clicks on that page's content
- **THEN** the page does not receive that input and nothing on it changes as a result
- **AND** a page the same run does not hold receives the user's input normally

#### Scenario: The page's own scripts keep working
- **WHEN** a page whose user input is suppressed runs its own code that triggers clicks, input or navigation without a person doing anything
- **THEN** that code behaves exactly as it would with no suppression in force

#### Scenario: The agent still acts on a locked page
- **WHEN** the agent dispatches a click, a drag or typing on a page whose user input is suppressed
- **THEN** the action reaches the page and takes effect exactly as it would with no suppression in force

#### Scenario: The user can always stop and always leave
- **WHEN** the user's input to a page is suppressed
- **THEN** the page indicator's own controls still respond to the user, by pointer and by keyboard
- **AND** closing the tab, switching tabs, using the address bar and using the assistant panel all still work

#### Scenario: Approval lifts the lock
- **WHEN** a run is blocked waiting for the user's approval decision
- **THEN** the user can interact with the page normally for as long as that decision is outstanding, so they can inspect what is about to happen before deciding

#### Scenario: The lock is visible before it is discovered
- **WHEN** the user moves the pointer over a page whose input is suppressed, without clicking
- **THEN** the page already signals that it is locked, so they learn it from looking rather than from a click that silently does nothing

#### Scenario: The lock releases itself
- **WHEN** the run ends, the controller disconnects, or the extension stops signalling
- **THEN** the user's input to that page works again within 3 seconds, with no action required from them
- **AND** every visual sign of the lock is gone, leaving the page's own appearance and behaviour exactly as they were before the run

#### Scenario: Reduced motion still shows control
- **WHEN** the viewer's system requests reduced motion
- **THEN** animated indication is suppressed and a static, persistent indication of active control remains visible for the whole run

#### Scenario: Stop and disconnect
- **WHEN** the user presses Stop in either the panel or page indicator, or the browser controller disconnects
- **THEN** further actions are blocked, the cursor/active indicator is cleared, and the panel reports stopped or interrupted state without claiming an in-flight action was undone

#### Scenario: Background tab or unavailable overlay
- **WHEN** the target is a background tab or the browser prevents overlay rendering
- **THEN** the panel identifies the actual target and the unavailable visual feedback; no cursor is drawn on the user's unrelated foreground tab and no focus switch happens without user authorization

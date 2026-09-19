# browser-assistant-panel delta

## MODIFIED Requirements

### Requirement: A locked page answers no operator pointer input

While a run holds the controlled page and no approval is waiting and no action of the agent's own is in flight, the page SHALL answer none of the operator's pointer interaction: no click lands, no hover state lights up, no tooltip or hover-only menu opens, no wheel scroll moves the page, and no text selection or drag begins. The suppression SHALL be lifted while an approval is waiting — the operator must be able to read the page being asked about — and while the agent's own dispatched action is in flight, whose input must reach the page; it SHALL end with the run. While the suppression holds, the page SHALL keep showing the locked state (the wait cursor and the indicator), and the indicator's own Stop and Open-panel controls SHALL remain operable. This is the one deliberate interception of page content by the overlay layer; the agent cursor itself still never intercepts page input.

The suppression SHALL additionally stay lifted after the agent's own hover has settled, until the agent next moves the pointer. A hover exists to open what exists only while the pointer rests on a control, and the browser decides that from its own hit test at the pointer's current position — so taking the hit test back the moment the hover's dispatch completes would close what that hover just opened, before the run's next step could reach into it. The hold SHALL survive every call that cannot move the pointer (an observation, a capture, a page script), because the run's own observation and decision fall between the hover and the action that uses it. It SHALL end at the next action that can move the pointer — a click, another hover, a scroll, a drag — so the page is shielded again as soon as that action settles. While the hold is in force the operator's pointer can produce hover states on the page; every other suppression stays exactly as it is, and the page keeps showing the locked state.

#### Scenario: Buttons do not react to the operator's pointer

- **WHEN** a run holds the page, dispatches nothing, has not just hovered, and the operator moves the pointer over a button or a menu
- **THEN** the button shows no hover state, no tooltip or hover-only menu opens, a click or wheel there changes nothing on the page, and the operator sees the locked indication — the wait cursor and the indicator — instead

#### Scenario: A hover-only menu stays open for the step that uses it

- **WHEN** the agent hovers a control whose menu opens only while the pointer rests on it, and the run then observes the page and decides its next step
- **THEN** the menu is still open across that observation and decision, and the action that follows can operate an item inside it

#### Scenario: The hold ends when the agent moves on

- **WHEN** the agent's next pointer-moving action settles after a held hover
- **THEN** the page is shielded again on the same terms as before the hover, and a later observation does not re-open the hold

#### Scenario: A held hover concedes nothing but hit-testing

- **WHEN** the operator clicks, scrolls with the wheel, types, or pastes while the agent's hover is held
- **THEN** none of it reaches the page, and the wait cursor and the indicator still show the page is held

#### Scenario: The agent's own action still reaches the page

- **WHEN** the run dispatches an action while the page is locked
- **THEN** that input reaches the page normally (the suppression never swallows the agent's own dispatch), and the suppression resumes once the action settles

#### Scenario: An approval lifts the suppression

- **WHEN** an action waits for the operator's decision
- **THEN** the page accepts the operator's pointer input again so the page in question can be read, while the indicator still offers no control that grants or denies the action

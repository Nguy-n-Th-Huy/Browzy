## ADDED Requirements

### Requirement: A locked page answers no operator pointer input

While a run holds the controlled page and no approval is waiting and no action of the agent's own is in flight, the page SHALL answer none of the operator's pointer interaction: no click lands, no hover state lights up, no tooltip or hover-only menu opens, no wheel scroll moves the page, and no text selection or drag begins. The suppression SHALL be lifted while an approval is waiting — the operator must be able to read the page being asked about — and while the agent's own dispatched action is in flight, whose input must reach the page; it SHALL end with the run. While the suppression holds, the page SHALL keep showing the locked state (the wait cursor and the indicator), and the indicator's own Stop and Open-panel controls SHALL remain operable. This is the one deliberate interception of page content by the overlay layer; the agent cursor itself still never intercepts page input.

#### Scenario: Buttons do not react to the operator's pointer

- **WHEN** a run holds the page, dispatches nothing, and the operator moves the pointer over a button or a menu
- **THEN** the button shows no hover state, no tooltip or hover-only menu opens, a click or wheel there changes nothing on the page, and the operator sees the locked indication — the wait cursor and the indicator — instead

#### Scenario: The agent's own action still reaches the page

- **WHEN** the run dispatches an action while the page is locked
- **THEN** that input reaches the page normally (the suppression never swallows the agent's own dispatch), and the suppression resumes once the action settles

#### Scenario: An approval lifts the suppression

- **WHEN** an action waits for the operator's decision
- **THEN** the page accepts the operator's pointer input again so the page in question can be read, while the indicator still offers no control that grants or denies the action

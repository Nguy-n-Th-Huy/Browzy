# design-mode-picker Specification

## Purpose
Lets the operator point at an element on the page they are looking at and hand the assistant that element's picture, markup and resolved styling, instead of describing it in prose the assistant then has to go hunting with.

## Requirements

### Requirement: Operator-driven element picking
The side panel SHALL offer a control that activates a picking mode over the currently bound page. While the mode is active, moving the pointer over the page SHALL highlight the single element under it, and activating that element SHALL select it and end the mode. The mode SHALL also end, selecting nothing, when the operator presses `Escape`, activates the control a second time, or the bound page changes. After the mode ends by any route, the page SHALL receive pointer and keyboard events exactly as it did before the mode began.

The control SHALL be an ordinary panel control, carrying an accessible name and reachable and operable by keyboard on the same terms as every other composer control.

Picking SHALL be an operator action on the page, never an agent action: it SHALL NOT acquire the browser lease, SHALL NOT pass through or consume the send-class approval gate, and SHALL NOT widen any run's tab scope. Activating it SHALL be refused while the agent is actively driving the bound tab, so the two never contend for the same page.

#### Scenario: Pick an element
- **WHEN** the operator activates the control and then activates an element on the bound page
- **THEN** that element is selected, the mode ends, and the page is left with its own event handling intact

#### Scenario: Cancel without selecting
- **WHEN** the operator presses `Escape`, activates the control again, or the bound page changes while the mode is active
- **THEN** the mode ends with nothing selected and the page is left with its own event handling intact

#### Scenario: The agent is driving the same tab
- **WHEN** the operator activates the control while a run is controlling the bound tab
- **THEN** activation is refused with a reason naming that cause, and no highlight or capture occurs

#### Scenario: Picking grants the agent nothing
- **WHEN** an element has been picked
- **THEN** no browser lease was taken, no approval was requested or consumed, and the run's authorized tab scope is identical to what it was before

### Requirement: A page a content script cannot reach refuses explicitly
Activating the picking mode on a page the browser will never permit a content script to run on — including `chrome://` pages, `chrome-extension://` pages and the extension gallery — SHALL be refused with a reason identifying that cause. The refusal SHALL be visible to the operator. The mode SHALL NOT appear active, and SHALL NOT wait for a selection that can never arrive.

#### Scenario: Restricted page
- **WHEN** the operator activates the control while the bound page is one the browser forbids content scripts on
- **THEN** the panel states that this page cannot be inspected, the control does not enter the active state, and nothing is captured

### Requirement: A selection captures a picture, markup and resolved styling
A selection SHALL produce, for the selected element and no other: an image clipped to that element's bounding rectangle, the element's markup, and a filtered set of its resolved computed styles. The image SHALL be carried by the same attachment path as any other composer image, subject to the same size ceiling and image-type allowlist already in force. The markup and styles SHALL be carried as their own record rather than encoded into the image.

The record SHALL identify which element it describes in a form the operator can recognize before sending.

#### Scenario: What a selection yields
- **WHEN** an element is selected
- **THEN** the composer holds an image clipped to that element's bounds, the element's markup, and its filtered computed styles, and shows the operator which element they picked

#### Scenario: The image is the element, not the page
- **WHEN** the selected element occupies part of the viewport
- **THEN** the captured image covers that element's rectangle rather than the whole viewport

#### Scenario: An oversized image is handled by the existing ceiling
- **WHEN** the clipped image would exceed the composer's existing per-attachment size ceiling
- **THEN** it is handled exactly as any other over-ceiling composer image, with the same refusal or reduction and the same message

### Requirement: Values and secrets do not leave the page
Before markup leaves the page, the current values of form controls SHALL be removed: the `value` of an input, the content of a textarea, and the selected state of a select or checkbox SHALL NOT be transmitted. Structural attributes that describe the control — its type, name, placeholder, label association, and disabled/required state — SHALL be preserved, because they are what makes the markup useful.

Removal SHALL be applied to the selected element and to every descendant it carries, not only to the outermost node.

#### Scenario: A filled-in form control
- **WHEN** the selected element contains an input, textarea or select the operator has already filled in
- **THEN** the transmitted markup carries the control and its describing attributes but not the entered value

#### Scenario: A password field
- **WHEN** the selected element contains a password input with a typed value
- **THEN** no part of that value appears anywhere in the transmitted markup, image metadata or style record

#### Scenario: A nested control
- **WHEN** the filled-in control is a descendant several levels below the selected element
- **THEN** its value is removed exactly as if it were the selected element itself

### Requirement: Text payloads are bounded and truncation is stated
The transmitted markup and the transmitted style set SHALL each be subject to an explicit byte ceiling. When a payload exceeds its ceiling it SHALL be truncated, and the record SHALL state that truncation occurred and name the ceiling that applied. An unbounded payload SHALL never be transmitted, and truncation SHALL never be silent.

The transmitted styles SHALL be a filtered subset of the element's computed styles rather than the complete set the browser exposes.

#### Scenario: Oversized markup
- **WHEN** the selected element's markup exceeds the markup ceiling
- **THEN** the transmitted markup is truncated and the record states that it was truncated and at what limit

#### Scenario: Styles are filtered, not dumped
- **WHEN** an element's styles are captured
- **THEN** the transmitted set is the filtered subset, and a property outside that subset does not appear

### Requirement: A picked element is bound to the page it came from
A selection SHALL record the identity of the page it was taken from. At send time that identity SHALL be re-checked against the page the message will actually target. If they differ, the operator SHALL be told and the message SHALL NOT be sent on that activation; sending SHALL require a further, explicit action by the operator.

#### Scenario: The page changed after picking
- **WHEN** the bound tab or its URL changes between selecting an element and sending the message
- **THEN** the operator is shown that the target changed and the message is not dispatched on that activation

#### Scenario: The page is unchanged
- **WHEN** the bound page is the same one the element was picked from
- **THEN** the message sends carrying the element's image, markup and styles

### Requirement: Captured page content is data, never instruction
Markup, styles and text captured from a page SHALL be treated as task data. Text appearing inside a captured element SHALL NOT be able to change the assistant's instructions, authorize an action, expand tool or tab scope, or cause any approval to be granted, regardless of how it is phrased.

#### Scenario: Markup containing an instruction
- **WHEN** a captured element contains text phrased as an instruction to the assistant, such as a demand to ignore prior instructions or to approve an action
- **THEN** it reaches the model as part of the described element and changes no permission, scope or approval decision

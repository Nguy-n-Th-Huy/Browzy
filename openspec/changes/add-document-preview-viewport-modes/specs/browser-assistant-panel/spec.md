## ADDED Requirements

### Requirement: An HTML-rendered preview can be viewed at phone, tablet and desktop widths

While the document detail view's Preview tab is showing a document rendered as HTML (formats `html`, `docx`, `xlsx`, `pptx`), the view SHALL offer a viewport mode control with exactly four modes: **Fit** (`Vừa khung`), **Mobile** (`Di động`, 390 CSS px), **Tablet** (768 CSS px) and **PC** (1280 CSS px). Fit SHALL render exactly as the view renders today: the frame fills the body width. A device mode SHALL give the preview frame that mode's CSS width so the document lays out for that width, SHALL centre the frame, and SHALL scale the frame down uniformly when the body is narrower than that width so the whole width remains visible; the frame SHALL never be scaled above 1:1. The control SHALL be hidden on the Markdown tab and for previews that are not rendered as HTML (`md`, `txt`, `json`, `csv`, `pdf`). The control SHALL be keyboard-operable with an accessible name, and each mode SHALL name its width where assistive technology can read it. Changing the mode SHALL NOT re-render, re-convert or refetch the document.

#### Scenario: Checking a responsive page at mobile width

- **WHEN** the operator previews an `html` document containing a `max-width: 768px` media rule and selects Mobile
- **THEN** the frame is 390 CSS px wide, the document's mobile layout is shown, and the frame is centred in the body

#### Scenario: A desktop width inside a narrow panel

- **WHEN** the operator selects PC while the viewer body is narrower than 1280 px
- **THEN** the frame lays the document out at 1280 CSS px and is scaled down so its full width is visible, and the document still scrolls inside the frame

#### Scenario: Fit is unchanged

- **WHEN** the mode is Fit
- **THEN** the preview renders exactly as it did before this capability existed, with no stage sizing, transform or caption

#### Scenario: The control is absent where there is no viewport

- **WHEN** the operator opens a `pdf`, `md`, `txt`, `csv` or `json` document, or switches to the Markdown tab
- **THEN** no viewport mode control is shown

#### Scenario: Switching mode does not reload the document

- **WHEN** the operator switches between modes on a `docx` preview
- **THEN** the already-converted HTML is kept and only the frame's size and scale change

### Requirement: A scaled preview states its scale

Whenever a device mode is active, the view SHALL state, as panel text outside the frame, the active mode, the frame's CSS width and the applied scale as a percentage. Under Fit no such statement SHALL be shown. The statement SHALL be written as text and SHALL never be derived from document content.

#### Scenario: A scaled desktop preview

- **WHEN** PC is active and the frame is scaled to 31 %
- **THEN** the view reads `PC · 1280px · 31%` outside the frame

#### Scenario: A 1:1 mobile preview

- **WHEN** Mobile is active and the body is at least 390 px wide
- **THEN** the view reads `Di động · 390px · 100%`

### Requirement: Viewport modes follow the panel and are remembered for the session

When the viewer body is resized while a device mode is active, the frame's scale SHALL be recomputed without reloading the document. The selected mode SHALL be kept while the panel document lives — across opening other documents and across switching between the Preview and Markdown tabs — and SHALL reset to Fit when the panel is reloaded. The mode SHALL NOT be persisted to storage.

#### Scenario: Widening the side panel

- **WHEN** the operator widens the side panel while PC is active
- **THEN** the scale rises toward 100 % and the document is not reloaded

#### Scenario: The next document opens in the same mode

- **WHEN** the operator selects Tablet, closes the viewer and opens another `html` document
- **THEN** that document's preview opens in Tablet

### Requirement: Viewport modes do not change what the preview may do

Applying any viewport mode SHALL change only the preview frame's CSS width, height and transform. The frame's sandbox attributes, frame content-security policy, referrer policy and `srcdoc` handling SHALL be identical to those of a Fit preview. No touch, user-agent, device-pixel-ratio or orientation emulation SHALL be applied or implied, and the control's descriptions SHALL speak of widths, not devices.

#### Scenario: A document with markup under a device mode

- **WHEN** a document containing a `<script>` element or an event-handler attribute is previewed under Mobile, Tablet or PC
- **THEN** neither executes, no request leaves the browser for its resources, and the frame carries the same sandbox, CSP and referrer attributes it carries under Fit

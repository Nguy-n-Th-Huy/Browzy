# agent-browser-runtime delta

## MODIFIED Requirements

### Requirement: Page snapshot operation

The runtime SHALL provide a `page_snapshot` operation that returns, for one tab, a bounded and structured observation: the page URL and title; viewport size and scroll position; an ordered table of the tab's currently visible, enabled interactive controls, each carrying a code-owned element reference that existing actions (`computer` clicks, `form_input`, `scroll_to`) resolve exactly as they resolve `read_page`/`find` references, together with the control's role, accessible name, and current state (value, checked/selected/expanded state, disabled state, and options for native selects); a bounded extract of the page's rendered text — elements that are not rendered (`display: none`, `visibility: hidden`, the `hidden` attribute) SHALL contribute nothing, so hidden navigation, collapsed menus, or other invisible chrome cannot crowd the extract ahead of the page's content; and explicit disclosure, including an omission count, whenever the element table or the text was truncated by a bound. The text bound SHALL be sized so that a long content page's main content is reached rather than consumed by chrome, and a truncation SHALL always be disclosed. The operation SHALL NOT mutate the page or browser state, SHALL be classified read-only for tab-scope purposes (usable on the bound page tab on the same terms as the existing read tools), and SHALL never be classified send/submit-class. Values of masked controls SHALL be returned in their masked form, never their live values.

A control SHALL be listed when it is operable in fact, not only when it declares itself operable in markup. Beyond native controls, an explicit ARIA role, a non-negative tab index, an inline click handler, and editable content, the observation SHALL include elements that carry a visible pointer affordance — rendered, intersecting the viewport, with a computed pointer cursor — so that a control built from a plain element with a delegated listener (an autocomplete suggestion row, a custom option list, a card that acts as a link) is observable rather than absent. That second pass SHALL be conservative and deterministic: only the innermost such element in a nesting SHALL be listed, an element that merely contains an already-listed control SHALL NOT be listed in its place, the pass SHALL be capped by its own bound, and anything it drops SHALL be counted in the existing omission disclosure. An element the pass cannot establish as rendered and pointer-affording SHALL NOT be listed.

Each listed control SHALL carry the same "newly appeared since the previous read of this document" marking the runtime's other reads already carry, produced by the same per-document mechanism and reset by the same document-identity rule — so a control that the run's own last action revealed is distinguishable from one that was always there, and a snapshot participates in that record rather than keeping a second one of its own.

#### Scenario: Structured observation with resolvable references

- **WHEN** the operator or a run requests `page_snapshot` for a tab with interactive controls
- **THEN** the result lists those controls in an ordered, bounded table with their roles, names, and current states, and every listed reference is accepted by the existing click, form-input, and scroll-to actions on the same document

#### Scenario: A snapshot marks what just appeared

- **WHEN** a page renders controls that were not present at the previous read of the same document — a suggestion list after typing, an expanded panel — and the snapshot is taken
- **THEN** those controls are marked as newly appeared on the same terms the runtime's other reads mark them, controls that were already present are not, and the marking resets with the document identity

#### Scenario: A delegated-listener control is observable

- **WHEN** a page renders an operable control as a plain element with a delegated listener and a pointer cursor — for example an autocomplete suggestion row or a custom option list item — with no ARIA role, tab index, or inline handler
- **THEN** the snapshot lists that control with a resolvable reference and its accessible name, and the existing click action operates it

#### Scenario: The pointer pass does not duplicate or inflate

- **WHEN** a pointer-affording element wraps a control the snapshot already lists, or a page nests several pointer-affording ancestors around one target
- **THEN** only the innermost operable element is listed, the wrapper is not listed in its place, and a page with no such controls produces the same table it produced before the pass existed

#### Scenario: Truncation is disclosed

- **WHEN** a page's interactive controls or text exceed the operation's bounds
- **THEN** the result states that it was truncated, reports how many elements were omitted, and never presents the truncated table as the complete page

#### Scenario: Invisible chrome does not crowd out content

- **WHEN** a page carries large hidden navigation, collapsed menu, or other non-rendered text ahead of its content
- **THEN** the extract reflects rendered text only and the page's content is present within the bound, with any truncation disclosed as usual

#### Scenario: Read-only on a borrowed tab

- **WHEN** `page_snapshot` targets a tab outside the session's owned group that the user has bound, without mutating authorization
- **THEN** the observation is allowed on the same basis as the existing read tools, and no page or browser state is changed and no dispatch outside the read path occurs

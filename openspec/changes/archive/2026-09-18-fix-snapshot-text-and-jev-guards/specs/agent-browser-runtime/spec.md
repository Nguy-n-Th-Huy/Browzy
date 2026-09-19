## MODIFIED Requirements

### Requirement: Page snapshot operation

The runtime SHALL provide a `page_snapshot` operation that returns, for one tab, a bounded and structured observation: the page URL and title; viewport size and scroll position; an ordered table of the tab's currently visible, enabled interactive controls, each carrying a code-owned element reference that existing actions (`computer` clicks, `form_input`, `scroll_to`) resolve exactly as they resolve `read_page`/`find` references, together with the control's role, accessible name, and current state (value, checked/selected/expanded state, disabled state, and options for native selects); a bounded extract of the page's rendered text — elements that are not rendered (`display: none`, `visibility: hidden`, the `hidden` attribute) SHALL contribute nothing, so hidden navigation, collapsed menus, or other invisible chrome cannot crowd the extract ahead of the page's content; and explicit disclosure, including an omission count, whenever the element table or the text was truncated by a bound. The text bound SHALL be sized so that a long content page's main content is reached rather than consumed by chrome, and a truncation SHALL always be disclosed. The operation SHALL NOT mutate the page or browser state, SHALL be classified read-only for tab-scope purposes (usable on the bound page tab on the same terms as the existing read tools), and SHALL never be classified send/submit-class. Values of masked controls SHALL be returned in their masked form, never their live values.

#### Scenario: Structured observation with resolvable references

- **WHEN** the operator or a run requests `page_snapshot` for a tab with interactive controls
- **THEN** the result lists those controls in an ordered, bounded table with their roles, names, and current states, and every listed reference is accepted by the existing click, form-input, and scroll-to actions on the same document

#### Scenario: Truncation is disclosed

- **WHEN** a page's interactive controls or text exceed the operation's bounds
- **THEN** the result states that it was truncated, reports how many elements were omitted, and never presents the truncated table as the complete page

#### Scenario: Invisible chrome does not crowd out content

- **WHEN** a page carries large hidden navigation, collapsed menu, or other non-rendered text ahead of its content
- **THEN** the extract reflects rendered text only and the page's content is present within the bound, with any truncation disclosed as usual

#### Scenario: Read-only on a borrowed tab

- **WHEN** `page_snapshot` targets a tab outside the session's owned group that the user has bound, without mutating authorization
- **THEN** the observation is allowed on the same basis as the existing read tools, and no page or browser state is changed and no dispatch outside the read path occurs

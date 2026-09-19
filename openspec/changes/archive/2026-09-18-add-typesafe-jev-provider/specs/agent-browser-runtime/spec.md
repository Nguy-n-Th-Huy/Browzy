## ADDED Requirements

### Requirement: Page snapshot operation

The runtime SHALL provide a `page_snapshot` operation that returns, for one tab, a bounded and structured observation: the page URL and title; viewport size and scroll position; an ordered table of the tab's currently visible, enabled interactive controls, each carrying a code-owned element reference that existing actions (`computer` clicks, `form_input`, `scroll_to`) resolve exactly as they resolve `read_page`/`find` references, together with the control's role, accessible name, and current state (value, checked/selected/expanded state, disabled state, and options for native selects); a bounded extract of visible page text; and explicit disclosure, including an omission count, whenever the element table or the text was truncated by a bound. The operation SHALL NOT mutate the page or browser state, SHALL be classified read-only for tab-scope purposes (usable on the bound page tab on the same terms as the existing read tools), and SHALL never be classified send/submit-class. Values of masked controls SHALL be returned in their masked form, never their live values.

#### Scenario: Structured observation with resolvable references

- **WHEN** the operator or a run requests `page_snapshot` for a tab with interactive controls
- **THEN** the result lists those controls in an ordered, bounded table with their roles, names, and current states, and every listed reference is accepted by the existing click, form-input, and scroll-to actions on the same document

#### Scenario: Truncation is disclosed

- **WHEN** a page's interactive controls or text exceed the operation's bounds
- **THEN** the result states that it was truncated, reports how many elements were omitted, and never presents the truncated table as the complete page

#### Scenario: Read-only on a borrowed tab

- **WHEN** `page_snapshot` targets a tab outside the session's owned group that the user has bound, without mutating authorization
- **THEN** the observation is allowed on the same basis as the existing read tools, and no page or browser state is changed and no dispatch outside the read path occurs

### Requirement: Decision-engine independence of execution guarantees

A run's execution guarantees SHALL NOT depend on which decision engine drives it. Whether a step's tool call originates from the LLM tool-use loop or from the structured-choice runtime, an equivalent classified call SHALL pass the same run-state, lease, and tab-scope checks; the same protected-action backstop; the same send/submit approval gate and bound single-use approval artifacts; the same borrowed-tab rules; and the same result-unknown handling. Stop SHALL prevent further dispatch identically in both, and a dispatched effect SHALL never be represented as undone in either.

#### Scenario: Same classification, same gate

- **WHEN** an equivalent send/submit-class action is attempted under either decision engine with the same run, target, and scope
- **THEN** both suspend on the same approval mechanism with the same binding requirements, and neither can dispatch while lacking a decision

#### Scenario: Same failure semantics

- **WHEN** a dispatch's response is lost under either engine
- **THEN** both report the action as result unknown, neither retries it automatically, and both pause further mutation until page state is observed again

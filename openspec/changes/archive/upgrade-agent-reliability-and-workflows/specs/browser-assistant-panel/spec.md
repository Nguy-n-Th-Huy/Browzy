## MODIFIED Requirements

### Requirement: Browser side panel
The toolbar action SHALL open a right-side assistant panel with conversation history, a bottom composer, model selector, send/stop controls, settings access, browser connection status, and a slash skill picker as defined in agent-skills. The panel SHALL additionally expose the selected named provider profile, truthful usage state, recording target state, document-aware context status, and workflow discovery without removing existing overlay, image attachment, timeline, prompt-enhancement, or skill behavior. The webpage SHALL remain visible beside the panel. The attached images SHALL be treated as layout references, not a source of model identifiers, required bundled skills, product promises, or website instructions.

#### Scenario: First use
- **WHEN** the user opens the panel without a complete verified provider profile
- **THEN** it shows setup guidance, disables send, and links to connection settings

#### Scenario: Ready conversation
- **WHEN** the browser and provider are ready and the user submits a nonempty message
- **THEN** the user message appears immediately and assistant output streams into one response while tool activity is shown separately

#### Scenario: Resume compatibility failure
- **WHEN** a conversation's SDK session or profile endpoint/model/skill identity cannot be resumed
- **THEN** the panel shows the exact recovery/new-conversation action and does not silently switch provider context or fabricate memory

### Requirement: Scope and permission controls
The composer SHALL show current page context with title and hostname. Opening the extension on an existing page SHALL select that page by default, without requiring a tab picker or creating a new tab. Users SHALL be able to pin another permitted tab or remove page context. Each submitted message SHALL retain its exact page-context identity and each turn SHALL revalidate fresh browser/document context. Actions outside the task's existing authorization SHALL wait for a user decision; already authorized actions SHALL proceed without repeated prompts. Webpage text alone SHALL never authorize a sensitive external action. Approval cards SHALL show known recipients, data, amounts, domain, document identity, normalized action arguments, and explicit unknowns; controls SHALL remain in the panel only.

#### Scenario: Approval response
- **WHEN** a requested browser action needs additional authorization
- **THEN** the panel displays the concrete action and target with allow/deny controls bound to that run and invalidated on stop or scope change

#### Scenario: Document changed before send
- **WHEN** the displayed document reloads, navigates, closes, or changes identity before Send
- **THEN** the panel refreshes or removes the context and requires an explicit second Send before dispatch

### Requirement: Session and recording access
The panel SHALL support new conversation, list/reopen conversations, explicit local history deletion, and start/stop/list/attach recordings. Existing recording options including microphone permission and separate transcription credentials SHALL remain accessible. Toolbar recording behavior SHALL move to a labeled control rather than disappearing. Recording attachment SHALL target an explicitly selected idle conversation and show reference, submitted, included, unknown, and failed states separately.

#### Scenario: Attachment to conversation
- **WHEN** the user attaches a saved recording
- **THEN** the composer shows its identity and the companion makes its permitted trace/artifacts available to that conversation without an MCP channel only after the defined model-input inclusion acknowledgement succeeds

#### Scenario: Recording controls remain available
- **WHEN** the user opens recording controls
- **THEN** start, stop, list, attach, microphone permission, and separate transcription-credential controls remain labeled and reachable

### Requirement: Responsive and accessible controls
The panel and settings SHALL support keyboard navigation, accessible control names, visible focus, WCAG 2.1 AA text contrast, and 320 CSS-pixel panel width without horizontal page scrolling. Streaming updates SHALL use a polite live region without announcing every token, and code or long URLs SHALL wrap or scroll within their own blocks. New profile, usage, recording, document, approval, and workflow states SHALL follow the same guarantees.

#### Scenario: Keyboard-only operation
- **WHEN** the user navigates with the keyboard at narrow panel width
- **THEN** send, stop, model/profile choice, settings, history, recordings, workflow, and permission controls remain reachable and focused elements stay visible

### Requirement: Send/submit approval card
When a run's tool call is classified as a send/submit-class action (submitting a form, clicking a send/submit/pay/confirm control, or a comparably hard-to-reverse outward-facing action), the panel SHALL display a card naming the concrete action and its target, with explicit Allow and Deny controls, bound to that run and to that exact normalized action/target evidence. The card SHALL NOT appear for any action outside this classification; reading, extracting text, screenshots, scrolling, hovering, navigation clicks, typing, filling forms, opening/closing agent-created tabs, and in-scope page script execution SHALL continue with no card except where the conservative unknown-action matrix requires explicit approval. An outstanding card SHALL be invalidated and removed from view on Stop, on a browser or tab scope change, on document replacement, or on replacement/deletion of the active credential, without waiting for the user to respond first. The controlled-page overlay SHALL offer no approval control.

#### Scenario: Send-class action requests a decision
- **WHEN** a normalized registry action attempts to submit a form or click a send/submit/pay/confirm control
- **THEN** the panel shows an approval card naming that exact action and target, execution pauses, and the run reports a waiting-for-permission state until the user answers

#### Scenario: Unknown sensitive action
- **WHEN** target/effect evidence is incomplete for a potentially sensitive coordinate, key sequence, JavaScript, or non-browser action
- **THEN** the card shows explicit unknowns only when the action is in the approvable-unknown class; otherwise the runtime denies it without an approval card

#### Scenario: Approval card invalidated by scope change
- **WHEN** the user stops the run, switches the bound browser/tab, or replaces or deletes the active credential while a card is outstanding
- **THEN** the card is invalidated and cleared from the panel, and any late answer to it is rejected rather than silently applied

## ADDED Requirements

### Requirement: Usage, profile, and workflow status
The panel SHALL show configured run/conversation limits and a ledger that distinguishes local counters, SDK estimates, external billing evidence, pending usage, and unknown usage. It SHALL display named profile identity and workflow version/parameter/domain review state, and SHALL disable or redirect actions when a local limit, profile compatibility, document guard, or workflow validation fails.

#### Scenario: Estimated budget stop
- **WHEN** the SDK stops for its estimated budget behavior
- **THEN** the panel labels it as an SDK estimate rather than a provider billing ceiling and preserves unknown external billing status

### Requirement: Workflow execution handoff
The sidepanel SHALL display asynchronous workflow execution identity, status, and cancel state. A workflow requested through MCP without a sidepanel or verified profile SHALL return an explicit no-panel/no-profile result or an actionable handoff, while ordinary MCP browser operations remain independent and unchanged.

#### Scenario: MCP workflow without panel
- **WHEN** an MCP client requests a workflow without a connected panel or verified profile
- **THEN** the request returns a stable explicit status/handoff result and does not create hidden management authority or deadlock the ordinary MCP lease

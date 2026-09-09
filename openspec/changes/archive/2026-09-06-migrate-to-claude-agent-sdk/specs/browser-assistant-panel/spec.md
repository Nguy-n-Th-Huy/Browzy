## Purpose

Provide an accessible in-browser assistant surface for conversations and browser control while keeping connection, model, action, and recording state visible.

## ADDED Requirements

### Requirement: Browser side panel
The toolbar action SHALL open a right-side assistant panel with conversation history, a bottom composer, model selector, send/stop controls, settings access, browser connection status, and a slash skill picker as defined in agent-skills. The webpage SHALL remain visible beside the panel. The attached images SHALL be treated as layout references, not a source of model identifiers, required bundled skills, product promises, or website instructions.

#### Scenario: First use
- **WHEN** the user opens the panel without a complete verified provider profile
- **THEN** it shows setup guidance, disables send, and links to connection settings

#### Scenario: Ready conversation
- **WHEN** the browser and provider are ready and the user submits a nonempty message
- **THEN** the user message appears immediately and assistant output streams into one response while tool activity is shown separately

### Requirement: Observable run states
The panel SHALL represent empty, connecting, ready, queued, streaming, waiting-for-permission, stopping, stopped, interrupted, completed, and error states. Browser actions SHALL show human-readable names, status, associated tab, and expandable result details. A partial response SHALL not be shown as complete after interruption.

#### Scenario: Tool failure
- **WHEN** a tool fails or its outcome is unknown
- **THEN** its activity item identifies that condition and keeps the transcript available, without a generic retry that repeats an uncertain mutation

### Requirement: Scope and permission controls
The composer SHALL show current page context with title and hostname. Opening the extension on an existing page SHALL select that page by default, without requiring a tab picker or creating a new tab. Users SHALL be able to pin another permitted tab or remove page context. Each submitted message SHALL retain its exact page-context identity. Actions outside the task's existing authorization SHALL wait for a user decision; already authorized actions SHALL proceed without repeated prompts. Webpage text alone SHALL never authorize a sensitive external action.

#### Scenario: Approval response
- **WHEN** a requested browser action needs additional authorization
- **THEN** the panel displays the concrete action and target with allow/deny controls bound to that run and invalidated on stop or scope change

### Requirement: Session and recording access
The panel SHALL support new conversation, list/reopen conversations, explicit local history deletion, and start/stop/list/attach recordings. Existing recording options including microphone permission and separate transcription credentials SHALL remain accessible. Toolbar recording behavior SHALL move to a labeled control rather than disappearing.

#### Scenario: Attachment to conversation
- **WHEN** the user attaches a saved recording
- **THEN** the composer shows its identity and the companion makes its permitted trace/artifacts available to that conversation without an MCP channel

### Requirement: Responsive and accessible controls
The panel and settings SHALL support keyboard navigation, accessible control names, visible focus, WCAG 2.1 AA text contrast, and 320 CSS-pixel panel width without horizontal page scrolling. Streaming updates SHALL use a polite live region without announcing every token, and code or long URLs SHALL wrap or scroll within their own blocks.

#### Scenario: Keyboard-only operation
- **WHEN** the user navigates with the keyboard at narrow panel width
- **THEN** send, stop, model choice, settings, history, recordings, and permission controls remain reachable and focused elements stay visible

### Requirement: Current-page conversation context
References such as "this page" and "this article" SHALL resolve to the page shown in the composer at submission time. Unpinned context SHALL follow the active tab in the panel's browser window before submission, while an in-progress run SHALL retain its submitted target.

#### Scenario: Read the article on this page
- **WHEN** the user opens the extension on article A and sends "đọc bài viết này và phân tích"
- **THEN** the assistant reads article A directly from that tab and analyzes its content without asking for its URL, asking the user to select the same tab, or opening a replacement tab

#### Scenario: Tab switch before submission
- **WHEN** the unpinned composer is open and the user switches from article A to article B in the panel's browser window before Send
- **THEN** the context chip updates to B and the submitted message targets B

#### Scenario: Tab switch during a run
- **WHEN** a message targeting article A is already running and the user switches to B
- **THEN** that run remains bound to A, its transcript shows A as the source, and the next unpinned message can target B

### Requirement: Polished visual design
The panel, settings, history, permission cards and skill picker SHALL share a coherent Claude-in-Chrome-inspired visual system with warm neutral surfaces, restrained accent color, readable typography, generous spacing, rounded composer, and quiet tool activity. Both light and dark themes SHALL be available with system-theme default and a persistent override. Visual QA SHALL cover all primary screens and states, rather than accepting functional controls alone as completion.

#### Scenario: Visual acceptance
- **WHEN** screenshots of empty chat, long conversation, active tools, errors, settings, history and slash picker are reviewed at 320, 400 and 480 CSS-pixel widths in both themes
- **THEN** text, controls and overlays are legible, aligned and unclipped, spacing and icon treatment are consistent, and no overlay hides the active composer or its focused control

#### Scenario: Streaming and reduced motion
- **WHEN** content streams while the user reads an earlier message or prefers reduced motion
- **THEN** the interface preserves reading position, offers a jump-to-latest control, and disables decorative motion under reduced-motion preferences

### Requirement: Visible agent pointer and control status
During pointer-based browser actions, the controlled page SHALL display a distinct agent cursor at the actual dispatched coordinates, with movement, click feedback and drag state. It SHALL display an active-control indicator with a Stop control. The cursor SHALL be a page overlay independent of the user's physical mouse, SHALL not intercept page input, and SHALL not appear on unrelated tabs. Read-only extraction or page-script execution SHALL not fabricate mouse movement.

#### Scenario: Visible click and drag
- **WHEN** the agent moves, clicks or drags in the visible authorized page
- **THEN** its pointer follows the dispatched path, marks the dispatched click or held drag, and does not cover or intercept the target interaction

#### Scenario: Stop and disconnect
- **WHEN** the user presses Stop in either the panel or page indicator, or the browser controller disconnects
- **THEN** further actions are blocked, the cursor/active indicator is cleared, and the panel reports stopped or interrupted state without claiming an in-flight action was undone

#### Scenario: Background tab or unavailable overlay
- **WHEN** the target is a background tab or the browser prevents overlay rendering
- **THEN** the panel identifies the actual target and the unavailable visual feedback; no cursor is drawn on the user's unrelated foreground tab and no focus switch happens without user authorization

### Requirement: Truthful action timeline and screenshot previews
The panel SHALL show an ordered, expandable action timeline for each run with icons, concise labels, target context, and running/succeeded/failed/cancelled/unknown states. It SHALL distinguish opening a page, reading, finding a target, clicking, scrolling, typing, waiting, capturing an image and executing page script. Captured-page events SHALL include thumbnails linked to the exact captured image, with source and capture time. The final answer SHALL remain a separate readable response.

#### Scenario: Multi-step browser response
- **WHEN** an agent opens a page, finds a link, clicks, waits and captures a screenshot
- **THEN** the timeline reflects those actual events in order, displays measured waiting duration and a screenshot thumbnail, and never marks a click as proof that the intended page effect succeeded

#### Scenario: Preview and reconnect
- **WHEN** the user opens a thumbnail or reconnects the panel after a temporary interruption
- **THEN** preview displays that historical image rather than a fresh capture and timeline entries are restored without duplicates or invented completed actions

#### Scenario: Sensitive input
- **WHEN** a tool types into a credential field or its payload contains a secret
- **THEN** the timeline identifies the action without displaying the typed secret or exposing raw sensitive arguments

### Requirement: Browzy product branding
The extension display name, assistant header, settings, onboarding and product notifications SHALL use the approved name Browzy. User-facing documentation and new visual mockups SHALL use the same name. Technology attribution SHALL remain accurate and SHALL not imply official Claude affiliation.

#### Scenario: Consistent product identity
- **WHEN** the user installs the extension, opens its panel and settings, or reads onboarding
- **THEN** the displayed product name is Browzy across those surfaces

#### Scenario: Branding preserves connectivity
- **WHEN** the displayed name changes to Browzy
- **THEN** the persistent public key, extension ID, native-host registration and existing external MCP launch/tool contracts remain compatible

### Requirement: Send/submit approval card
When a run's tool call is classified as a send/submit-class action (submitting a form, clicking a send/submit/pay/confirm control, or a comparably hard-to-reverse outward-facing action), the panel SHALL display a card naming the concrete action and its target, with explicit Allow and Deny controls, bound to that run and to that exact action/target. The card SHALL NOT appear for any action outside this classification; reading, extracting text, screenshots, scrolling, hovering, navigation clicks, typing, filling forms, opening/closing agent-created tabs, and in-scope page script execution SHALL continue with no card. An outstanding card SHALL be invalidated and removed from view on Stop, on a browser or tab scope change, or on replacement or deletion of the active credential, without waiting for the user to respond first.

#### Scenario: Send-class action requests a decision
- **WHEN** a run attempts to submit a form or click a send/submit/pay/confirm control
- **THEN** the panel shows an approval card naming that exact action and its target, execution pauses, and the run reports a waiting-for-permission state until the user answers

#### Scenario: Approval card invalidated by scope change
- **WHEN** the user stops the run, switches the bound browser/tab, or replaces or deletes the active credential while a card is outstanding
- **THEN** the card is invalidated and cleared from the panel, and any late answer to it is rejected rather than silently applied

### Requirement: Deny does not perform the action, and is not itself Stop
Denying an approval card SHALL prevent the named action from executing and SHALL NOT mark it as performed anywhere in the transcript or timeline. Denial SHALL allow the run to continue with other permitted work, or to end, at the model's or user's discretion; deny is not itself a Stop. An approval left unanswered past its bounded expiry SHALL resolve as a timeout denial, distinguishable from a user's explicit deny.

#### Scenario: User denies
- **WHEN** the user selects Deny on an approval card
- **THEN** the named action does not execute, the transcript records it as denied by the user, and the run continues to be usable for further messages or a graceful stop

#### Scenario: No answer before expiry
- **WHEN** no Allow or Deny is selected before the approval's timeout elapses
- **THEN** the action is denied with a timeout reason distinguishable from an explicit user denial, and the panel clears the card instead of leaving it pending indefinitely

### Requirement: Pending decision restored on reconnect
A pending approval card or ask-the-user question SHALL be restored when the panel reconnects after a temporary interruption, using the same sequenced-event snapshot mechanism as the rest of the transcript. Reconnection SHALL NOT duplicate a pending card or question, and SHALL NOT automatically answer it on the user's behalf.

#### Scenario: Reconnect while a decision is pending
- **WHEN** the panel reopens after a disconnect while an approval card or question was awaiting the user
- **THEN** the same card or question reappears exactly once, still awaiting a real answer, with no assumed decision applied

### Requirement: Ask-the-user question card
The agent SHALL be able to present the user with one question and 2-4 pre-written answer options in the panel; the user's selected option SHALL be returned to the run as plain data for the agent to use, never as authorization for any action. The card SHALL be keyboard-accessible: reachable by Tab, navigable between options, and selectable with Enter or Space. The transcript SHALL record which option was chosen once answered.

#### Scenario: Agent asks the user to choose
- **WHEN** the agent has found multiple plausible candidates, such as several matching notices, and calls the ask-the-user tool with pre-written options
- **THEN** the panel shows the question and its options, the run pauses for that answer, and after the user clicks or keyboard-selects an option the run continues using that answer

#### Scenario: An answer is not a permission
- **WHEN** the user answers an ask-the-user question
- **THEN** the answer is recorded in the transcript as data the agent used, and it does not by itself authorize any send/submit-class action the agent later attempts

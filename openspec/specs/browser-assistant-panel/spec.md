# browser-assistant-panel Specification

## Purpose
Provide an accessible in-browser assistant surface for conversations and browser control while keeping connection, model, action, and recording state visible.

## Requirements

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
During pointer-based browser actions, the controlled page SHALL display a distinct agent cursor at the actual dispatched coordinates, with movement, click feedback and drag state. The cursor SHALL identify the agent by name and SHALL name the action currently in flight. The page SHALL display an active-control indicator with a Stop control, and that indicator SHALL hold one fixed position on screen for the whole session rather than moving in response to pointer position. The page SHALL indicate active control for as long as the run holds the page, including while no action is being dispatched. A viewer who has asked the operating system to reduce motion SHALL still receive a persistent, non-animated indication of active control. The cursor SHALL be a page overlay independent of the user's physical mouse, SHALL not intercept page input, and SHALL not appear on unrelated tabs. Read-only extraction or page-script execution SHALL not fabricate mouse movement.

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

#### Scenario: Reduced motion still shows control
- **WHEN** the viewer's system requests reduced motion
- **THEN** animated indication is suppressed and a static, persistent indication of active control remains visible for the whole run

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
When a run's tool call requires a user decision under the active permission mode, the panel SHALL display a card naming the concrete action and its target, with explicit Allow and Deny controls, bound to that run and to that exact action/target. The card SHALL NOT appear for any call the active mode resolves without a decision, nor for a call resolved by a remembered per-site decision. For a call classified as protected, the card SHALL name the protected category that applies and SHALL state that the decision cannot be remembered. For any other card, the panel SHALL offer remembering the decision for that origin and action class, and SHALL record an entry only when the user asks for it. Under Auto, reading, extracting text, screenshots, scrolling, hovering, navigation clicks, typing, filling forms, opening/closing agent-created tabs, and in-scope page script execution SHALL continue with no card. An outstanding card SHALL be invalidated and removed from view on Stop, on a browser or tab scope change, on a permission mode change, or on replacement or deletion of the active credential, without waiting for the user to respond first.

#### Scenario: Send-class action requests a decision
- **WHEN** the mode is Auto and a run attempts to submit a form or click a send/submit/pay/confirm control
- **THEN** the panel shows an approval card naming that exact action and its target, execution pauses, and the run reports a waiting-for-permission state until the user answers

#### Scenario: Approval card invalidated by scope change
- **WHEN** the user stops the run, switches the bound browser/tab, changes the permission mode, or replaces or deletes the active credential while a card is outstanding
- **THEN** the card is invalidated and cleared from the panel, and any late answer to it is rejected rather than silently applied

#### Scenario: A protected action names its category and cannot be remembered
- **WHEN** a run attempts a protected action
- **THEN** the card names the protected category that applies, offers no option to remember the decision, and appears whichever mode is active

#### Scenario: Remembering a decision
- **WHEN** the user allows a non-protected action and asks for the decision to be remembered
- **THEN** an entry is recorded for that origin and action class, and it appears on the approved-sites surface

#### Scenario: No card for a remembered decision
- **WHEN** a call matches a remembered allowance for its origin and action class
- **THEN** no card appears, and the timeline records that a remembered decision resolved it rather than showing an unanswered request

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

### Requirement: Blocked-on-approval is visible on the controlled page
When a run is blocked waiting for the operator to approve an action, the controlled page SHALL show that the run is waiting and what it is waiting for, distinguishably from a run that is proceeding. The approval decision itself SHALL NOT be takeable from the controlled page: the page indicator SHALL offer no control that grants or denies the pending action, and SHALL instead route the operator to the panel where the decision is made. The page SHALL return to its ordinary active-control indication once the decision is recorded, whoever recorded it.

The prohibition is not stylistic. The agent's own pointer input is dispatched at browser level, is indistinguishable from the operator's by any trust signal available to page content, and reaches any coordinate on the controlled page. A grant control rendered there would sit within the pointer reach of the agent requesting the grant.

#### Scenario: A run blocked on approval
- **WHEN** a run requests the operator's approval for an action
- **THEN** the controlled page's indicator shows the waiting state and names the action awaiting a decision
- **AND** the indicator offers no control that would grant or deny it

#### Scenario: The decision is recorded elsewhere
- **WHEN** the operator grants or denies the pending action in the panel
- **THEN** the controlled page's indicator leaves the waiting state without the operator having to touch the page

#### Scenario: A stale waiting state cannot persist
- **WHEN** a run ends, is stopped, or the controller disconnects while an approval is still pending
- **THEN** the waiting indication is cleared on the same terms as every other active-control indication, and never outlives the run that raised it

### Requirement: Composer prompt enhancement control
The composer SHALL offer a prompt-enhancement control positioned immediately before the send/stop control in the composer action row. Activating it SHALL submit the composer's current text to the companion for rewriting and SHALL replace the composer text with the rewritten result. The rewritten text SHALL preserve the language the operator wrote in. The composer text SHALL be the only input carried by the request: page context, conversation history, attachments, and provider profile secrets SHALL NOT be included. The control SHALL carry an accessible name and SHALL be reachable and operable by keyboard on the same terms as the send control.

#### Scenario: Successful enhancement
- **WHEN** the operator activates the enhancement control with a nonempty composer draft and the companion returns a rewritten prompt
- **THEN** the composer text is replaced by the rewritten prompt, the composer becomes editable again, and no message is added to the conversation

#### Scenario: Original language is preserved
- **WHEN** the operator's draft is written in a language other than English
- **THEN** the rewritten prompt returned to the composer is in that same language

#### Scenario: Undo restores the draft
- **WHEN** the composer text has been replaced by a rewritten prompt and the operator issues the browser's undo command in the composer
- **THEN** the text the operator had before enhancement is restored

### Requirement: Prompt enhancement availability
The enhancement control SHALL be unavailable when the composer is empty or contains only whitespace, when there is no conversation to compose into, when a run is queued, streaming, stopping, or waiting for permission, when an enhancement request for this panel is already in flight, and when the trimmed composer text begins with `/` (a slash command, whose literal text is what the companion dispatches on). Availability SHALL be derived from the same readiness signals the send control already uses; enhancement SHALL NOT introduce a separate provider-readiness gate that blocks the control while send remains usable.

#### Scenario: Empty draft
- **WHEN** the composer is empty or holds only whitespace
- **THEN** the enhancement control is disabled

#### Scenario: Slash command draft
- **WHEN** the trimmed composer text begins with `/`
- **THEN** the enhancement control is disabled, so the dispatched command text can never be rewritten

#### Scenario: Run in progress
- **WHEN** a run is queued, streaming, stopping, or waiting for permission
- **THEN** the enhancement control is disabled for the duration of that run

### Requirement: Prompt enhancement in-flight and cancellation
While an enhancement request is in flight the composer SHALL be read-only and marked busy, and the enhancement control SHALL act as Cancel. Cancelling SHALL instruct the companion to abandon the request. On cancellation, on any reported error, and on loss of the companion connection, the panel SHALL restore the exact composer text captured at the moment the request started and SHALL return the composer to its editable state. A late reply for a request that was cancelled SHALL be ignored rather than applied.

#### Scenario: Operator cancels
- **WHEN** the operator activates the enhancement control while a request is in flight
- **THEN** the companion is told to abandon that request, the composer is restored to the pre-request text, and any reply that arrives afterwards for that request is ignored

#### Scenario: Connection lost mid-request
- **WHEN** the companion connection drops while an enhancement request is in flight
- **THEN** the composer is restored to the pre-request text and becomes editable again

#### Scenario: Enhancement fails
- **WHEN** the companion reports an error for the enhancement request
- **THEN** the composer is restored to the pre-request text and the failure is shown to the operator as a distinguishable message, never as a silent no-op and never as a partial or empty draft

#### Scenario: Companion does not support enhancement
- **WHEN** the connected companion answers that it does not recognize the enhancement request
- **THEN** the panel reports that the companion needs updating and restores the composer to the pre-request text

### Requirement: Prompt enhancement is not a run
An enhancement request SHALL NOT create or advance a conversation, SHALL NOT append to any transcript, SHALL NOT emit run-state or action-timeline events, SHALL NOT take the browser lease, and SHALL NOT make any tool, skill, or browser automation available to the model answering it. It SHALL be answered by a bounded single-turn model call using the operator's already-configured provider profile.

#### Scenario: No transcript or run side effects
- **WHEN** an enhancement request completes, fails, or is cancelled
- **THEN** the conversation transcript, the run state shown in the panel, and the action timeline are all unchanged by it

#### Scenario: No browser or tool access
- **WHEN** the companion answers an enhancement request
- **THEN** the model answering it has no browser tools, no MCP servers, and no skills available, and no tab is opened, focused, or acted upon

#### Scenario: No configured provider
- **WHEN** the operator activates the enhancement control while no usable provider profile is configured
- **THEN** the request fails with a message naming that cause and the composer text is left untouched

### Requirement: Restore falls back instead of stranding the operator

When the panel cannot restore the remembered conversation, it SHALL start a new conversation and SHALL clear the remembered identity, rather than leaving the operator in an empty conversation that cannot be used. This SHALL apply when the companion reports the conversation is unknown to it, when the request cannot be sent at all, when the conversation is absent from the panel's own conversation list or is marked deleted on this browser, and when no panel scope can be identified to restore against. The fallback SHALL apply only to restore at panel startup; a conversation the operator explicitly reopens from the history list SHALL surface the failure as an error on that conversation and SHALL NOT be silently replaced by a different conversation.

#### Scenario: Remembered conversation is unknown to the companion

- **WHEN** the panel is opened, the remembered conversation is restored, and the companion reports it does not know that conversation (for example after the agent home was wiped or the companion was reinstalled)
- **THEN** the panel starts a new usable conversation, forgets the remembered identity, and does not leave the operator on an empty conversation showing only an error

#### Scenario: Remembered conversation was deleted locally

- **WHEN** the operator deletes a conversation from the history list and later reopens the panel
- **THEN** the panel does not attempt to restore that conversation and starts a new one instead

#### Scenario: No identifiable scope

- **WHEN** the panel opens and cannot determine which tab it belongs to
- **THEN** it starts a new conversation rather than restoring one remembered for some other scope

#### Scenario: Explicit reopen of an unknown conversation is not swapped

- **WHEN** the operator reopens a conversation from the history list and the companion reports it does not know that conversation
- **THEN** the panel surfaces the failure against the conversation the operator asked for, and does not silently switch the operator to a different or newly created conversation

### Requirement: Last active conversation restored per panel scope

The panel SHALL remember which conversation is active within the scope of the tab it was opened on, and SHALL restore that conversation when a panel is reopened in that same scope. A panel opened in a scope that has no remembered conversation SHALL start a new one; it SHALL NOT adopt a conversation remembered for a different scope, because each tab the panel is explicitly opened on is an independent agent scope with its own page context and its own agent tab group. The remembered identity SHALL be updated whenever the active conversation changes — a conversation created by the operator, one reopened from the history list, or one adopted from the companion — and SHALL be cleared when the active conversation is deleted locally. The panel SHALL NOT infer the conversation to restore from recency of transcript activity, because a conversation the operator is not looking at can still receive events. The remembered identity SHALL NOT outlive the browser session, matching the lifetime of the per-tab panel enablement it is scoped to. Failure to persist or read the remembered identity SHALL NOT block the panel from opening; the panel SHALL fall back to starting a new conversation.

Restoring is about which conversation opens automatically, never about which conversations exist. Conversations SHALL remain listed and reopenable from the history list regardless of the scope they were started in or the browser session they belong to.

#### Scenario: Panel reopened after being closed

- **WHEN** the operator sends a message in a conversation, closes the side panel, and reopens it on the same tab
- **THEN** the panel reopens that same conversation with its transcript restored from the companion, and does not create a new conversation

#### Scenario: Panel reopened while a run is still in flight

- **WHEN** the operator submits a message, closes the side panel before the response completes, and reopens it on the same tab
- **THEN** the panel reopens that conversation and the run that was already in progress continues to be reflected there

#### Scenario: Panel opened on a different tab

- **WHEN** the operator opens the panel on a tab that has no conversation of its own, while another tab's conversation is active or still running
- **THEN** the panel starts a new conversation for that tab, and the other tab's conversation is neither shown nor interrupted

#### Scenario: First ever open

- **WHEN** the panel is opened and no conversation has been active in this scope during this browser session
- **THEN** the panel starts a new conversation

#### Scenario: Earlier conversations stay reachable

- **WHEN** the operator opens the history list from a panel that started a new conversation
- **THEN** conversations started in other tabs and in earlier browser sessions are still listed and can still be reopened

### Requirement: The permission mode is visible and changeable from the panel
The panel SHALL display the active permission mode wherever a run can act, and SHALL let the user change it between Manual, Auto, and Skip. When administrator-managed policy pins the mode, the control SHALL show the pinned mode as administrator-controlled and SHALL NOT allow a local change. Changing the mode SHALL take effect for actions decided after the change, and SHALL invalidate any outstanding decision card rather than reinterpreting it under the new mode.

#### Scenario: Reading and changing the mode
- **WHEN** the user opens the panel while a run can act
- **THEN** the active mode is visible, and selecting a different mode applies it to subsequently decided actions

#### Scenario: Administrator-pinned mode
- **WHEN** managed policy pins the mode
- **THEN** the control shows that mode as administrator-controlled and offers no local change

#### Scenario: Mode change clears an outstanding card
- **WHEN** the user changes the mode while a decision card is outstanding
- **THEN** the card is invalidated and cleared, and a late answer to it is rejected rather than applied under either mode

### Requirement: Approved sites are listed and revocable from a management surface
The product SHALL provide a surface listing every site with a remembered permission decision, showing each site's origin, the action class it covers, whether it is an allowance or a denial, and when it was recorded. The user SHALL be able to revoke any single entry or every entry from that surface. Entries placed by administrator-managed policy SHALL be listed as administrator-controlled and SHALL NOT be locally revocable. The surface SHALL state that protected actions are never remembered.

#### Scenario: Listing remembered sites
- **WHEN** the user opens the approved-sites surface with remembered decisions present
- **THEN** each entry is listed with its origin, action class, allowance or denial, and the time it was recorded

#### Scenario: Revoking a single site
- **WHEN** the user revokes one entry
- **THEN** that entry is removed and the remaining entries are unchanged

#### Scenario: Revoking everything
- **WHEN** the user revokes all entries
- **THEN** the list is empty and the surface states that no site has a remembered decision

#### Scenario: An administrator entry cannot be revoked here
- **WHEN** the list contains an entry placed by managed policy
- **THEN** that entry is marked administrator-controlled and offers no revoke control, while locally created entries remain revocable

#### Scenario: Empty state
- **WHEN** the user opens the surface with no remembered decisions
- **THEN** it states that no site has a remembered decision, rather than showing an empty list with no explanation

### Requirement: Warnings are shown separately from decision requests
The panel SHALL display injection findings and tab risk categories as warnings that carry no allow or deny control and suspend nothing. A warning SHALL be visually and semantically distinct from a decision card. Where a decision card is shown for an action on a tab carrying a finding or an elevated risk category, the card SHALL display that context alongside the request. Matched injected text SHALL be displayed as quoted data, never rendered as instructions or as panel-authored copy.

#### Scenario: A finding appears as a warning
- **WHEN** the probe records a finding for content a run read
- **THEN** the panel shows it as a warning with no allow or deny control, and no run is suspended by it

#### Scenario: Risk context on a decision card
- **WHEN** a decision card is shown for an action on a tab with an elevated risk category
- **THEN** the card displays that category and its contributing signals alongside the action and target, and the decision controls remain those of the card

#### Scenario: Injected text is quoted, not rendered
- **WHEN** a warning displays matched injected text
- **THEN** the text appears as quoted data, and any markup or instruction inside it is not rendered or acted on

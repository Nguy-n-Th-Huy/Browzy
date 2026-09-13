## MODIFIED Requirements

### Requirement: Observable run states
The panel SHALL represent empty, connecting, ready, queued, streaming, waiting-for-permission, stopping, stopped, interrupted, completed, and error states. Browser actions SHALL show human-readable names, status, associated tab, and expandable result details. A partial response SHALL not be shown as complete after interruption.

While a run is streaming, the panel SHALL show the assistant's answer text as it is produced, into the same response being assembled, rather than only once the message completes. Model thinking produced during a run SHALL be shown to the operator inside the assistant turn it belongs to, live while it is produced and also when it arrives only within a completed assistant message. A thinking block whose content is not disclosable SHALL be represented as thinking that occurred, without revealing or fabricating its content.

Live fragments are transient. The panel SHALL NOT treat streamed fragments as the durable record, and when the completed message corresponding to already-streamed fragments arrives, the panel SHALL append only the content not already shown, so no text appears twice. Text that was only streamed and never confirmed by a completed assistant message SHALL remain distinguishable from a completed answer and SHALL NOT be presented as the run's final response. A panel that is given no streamed fragments SHALL continue to show completed messages exactly as before, and a panel that receives fragments it does not recognize SHALL ignore them rather than fail.

#### Scenario: Tool failure
- **WHEN** a tool fails or its outcome is unknown
- **THEN** its activity item identifies that condition and keeps the transcript available, without a generic retry that repeats an uncertain mutation

#### Scenario: Answer text appears while the run is still streaming
- **WHEN** a run is streaming and the assistant's answer has begun but its message has not completed
- **THEN** the answer text produced so far is visible in the current assistant turn, replacing the busy/working indicator in the position the answer occupies

#### Scenario: Thinking appears while it streams
- **WHEN** the model produces thinking during a streaming run
- **THEN** the panel shows a thinking block inside that assistant turn, updating as the thinking is produced, distinguishable from the answer text

#### Scenario: Thinking that arrives only in a completed message
- **WHEN** a completed assistant message contains a thinking block and no streamed thinking was shown for it
- **THEN** that thinking is shown in the turn's thinking block rather than being dropped

#### Scenario: No duplicated text when the completed message arrives
- **WHEN** answer text was already shown from streamed fragments and the corresponding completed assistant message then arrives
- **THEN** the panel appends only the content that was not already shown, and the turn shows that text exactly once

#### Scenario: Interrupted mid-answer
- **WHEN** a run is stopped or fails after some answer text was streamed but before the message completed
- **THEN** the text shown from fragments is not presented as the run's completed answer, and no text is shown for the part that was never received

#### Scenario: A companion without live fragments
- **WHEN** the connected companion does not emit streamed fragments
- **THEN** the panel continues to show completed messages exactly as before, with no error state and no empty placeholder created for fragments that never arrive

### Requirement: Responsive and accessible controls
The panel and settings SHALL support keyboard navigation, accessible control names, visible focus, WCAG 2.1 AA text contrast, and 320 CSS-pixel panel width without horizontal page scrolling. Streaming updates SHALL use a polite live region without announcing every token, and code or long URLs SHALL wrap or scroll within their own blocks. Streamed answer text SHALL NOT be announced fragment by fragment, and the growing answer SHALL NOT be re-announced on every update. The thinking block SHALL be a keyboard-operable disclosure with an accessible name and its expanded or collapsed state exposed to assistive technology, and incoming thinking SHALL neither announce each fragment nor move focus.

#### Scenario: Keyboard-only operation
- **WHEN** the user navigates with the keyboard at narrow panel width
- **THEN** send, stop, model choice, settings, history, recordings, and permission controls remain reachable and focused elements stay visible

#### Scenario: Live text does not storm the live region
- **WHEN** answer text arrives as many streamed fragments over a run
- **THEN** the polite live region is not announced once per fragment and the growing answer is not re-announced on each update

#### Scenario: Thinking disclosure is operable without stealing focus
- **WHEN** the user operates the thinking block's disclosure control by keyboard while thinking is still arriving
- **THEN** the block expands or collapses, its state is exposed to assistive technology, and focus stays on the control the user activated while further thinking updates do not move it

### Requirement: Polished visual design
The panel, settings, history, permission cards and skill picker SHALL share a coherent Claude-in-Chrome-inspired visual system with warm neutral surfaces, restrained accent color, readable typography, generous spacing, rounded composer, and quiet tool activity. Both light and dark themes SHALL be available with system-theme default and a persistent override. Visual QA SHALL cover all primary screens and states, rather than accepting functional controls alone as completion. While content is arriving, the panel SHALL update the streaming turn in place rather than rebuilding the transcript around it, so the reader's scroll position, text selection and focused control are preserved, and already-rendered content SHALL NOT flicker or be replaced wholesale on each update. Streamed answer text SHALL grow in the same slot the completed answer will occupy, and the thinking block SHALL be visually quieter than and subordinate to the answer it belongs to.

#### Scenario: Visual acceptance
- **WHEN** screenshots of empty chat, long conversation, active tools, errors, settings, history and slash picker are reviewed at 320, 400 and 480 CSS-pixel widths in both themes
- **THEN** text, controls and overlays are legible, aligned and unclipped, spacing and icon treatment are consistent, and no overlay hides the active composer or its focused control

#### Scenario: Streaming and reduced motion
- **WHEN** content streams while the user reads an earlier message or prefers reduced motion
- **THEN** the interface preserves reading position, offers a jump-to-latest control, and disables decorative motion under reduced-motion preferences

#### Scenario: Reading while content streams in place
- **WHEN** the operator has scrolled away from the bottom of the transcript to read an earlier message while the current run is streaming text
- **THEN** the new text is added without moving the reading position, and the operator can return to the live answer through the existing jump-to-latest control

#### Scenario: Selection and focus survive a streaming update
- **WHEN** the operator has selected text or focused a control in the transcript and further streamed content arrives
- **THEN** the selection and focus are still where the operator left them, and no part of the transcript rebuilds so as to drop them

#### Scenario: Thinking is subordinate to the answer
- **WHEN** a turn contains both a thinking block and answer text
- **THEN** the thinking block reads as secondary to the answer, the answer remains the prominent content of the turn, and collapsing the thinking block does not hide the answer

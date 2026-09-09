## MODIFIED Requirements

### Requirement: Observable run states
The panel SHALL represent empty, connecting, ready, queued, streaming, waiting-for-permission, stopping, stopped, interrupted, completed, and error states. Browser actions SHALL show human-readable names, status, associated tab, and expandable result details. A partial response SHALL not be shown as complete after interruption. While the run's phase is queued, or the phase is streaming and no assistant answer text has yet appeared for the current turn since the run started or since the most recent tool activity, the panel SHALL show a busy/working indicator in the position the next answer content will occupy, including while a pending ask-the-user question is outstanding for that run. The indicator SHALL be removed the instant answer text resumes appearing for that turn, replaced in place rather than covered by it, and SHALL NOT appear during waiting-for-permission, stopping, stopped, interrupted, completed, or error, each of which already has its own distinct treatment.

#### Scenario: Tool failure
- **WHEN** a tool fails or its outcome is unknown
- **THEN** its activity item identifies that condition and keeps the transcript available, without a generic retry that repeats an uncertain mutation

#### Scenario: Busy indicator before the first token
- **WHEN** a run's phase becomes queued, and later streaming, and no text content has yet been added to the current turn
- **THEN** the panel shows the busy/working indicator at the position the assistant's answer will appear, and removes it the instant the first text content of that turn is applied

#### Scenario: Busy indicator during tool activity between answer segments
- **WHEN** the model has already produced some answer text for the current turn, then invokes a tool, and has not yet resumed producing answer text
- **THEN** the panel shows the busy/working indicator again for that gap and removes it the instant answer text resumes, without altering or duplicating the answer text already shown

#### Scenario: No busy indicator while the system is waiting on the user
- **WHEN** the run's phase is waiting-for-permission, or an ask-the-user question is pending for the run
- **THEN** the panel does not show the busy/working indicator, and instead shows the approval card or question card already required for that condition

#### Scenario: No busy indicator once a run has actually ended or is ending
- **WHEN** the run's phase is stopping, stopped, interrupted, completed, or error
- **THEN** the panel does not show or continue animating the busy/working indicator, regardless of whether it was visible immediately beforehand

### Requirement: Truthful action timeline and screenshot previews
The panel SHALL show an ordered, expandable action timeline for each run with icons, concise labels, target context, and running/succeeded/failed/cancelled/unknown states. It SHALL distinguish opening a page, reading, finding a target, clicking, scrolling, typing, waiting, capturing an image and executing page script. Captured-page events SHALL include thumbnails linked to the exact captured image, with source and capture time. The final answer SHALL remain a separate readable response. The timeline SHALL render collapsed by default as one summary row naming the product, the total action count, and the run's elapsed duration; activating that row SHALL expand it into the full ordered list along a thin vertical guide with consistent outline icons and screenshot thumbnails, and activating it again SHALL collapse it back to the summary row without discarding or reordering the underlying events.

#### Scenario: Multi-step browser response
- **WHEN** an agent opens a page, finds a link, clicks, waits and captures a screenshot
- **THEN** the timeline reflects those actual events in order, displays measured waiting duration and a screenshot thumbnail, and never marks a click as proof that the intended page effect succeeded

#### Scenario: Preview and reconnect
- **WHEN** the user opens a thumbnail or reconnects the panel after a temporary interruption
- **THEN** preview displays that historical image rather than a fresh capture and timeline entries are restored without duplicates or invented completed actions

#### Scenario: Sensitive input
- **WHEN** a tool types into a credential field or its payload contains a secret
- **THEN** the timeline identifies the action without displaying the typed secret or exposing raw sensitive arguments

#### Scenario: Collapsed by default, expands on activation
- **WHEN** a run that performed one or more browser actions finishes, or is still in progress
- **THEN** the panel shows one summary row naming the action count and elapsed duration instead of one row per action, and activating that row (by click, Enter, or Space) expands it into the full ordered timeline described above

#### Scenario: Expansion state does not alter the underlying record
- **WHEN** the user expands or re-collapses the summary row, reconnects the panel, or reopens a past conversation
- **THEN** the same ordered set of actions, states, and screenshot thumbnails is available every time, unaffected by whether the row happens to be shown expanded or collapsed at that moment

### Requirement: Polished visual design
The panel, settings, history, permission cards and skill picker SHALL share a coherent Claude-in-Chrome-inspired visual system with warm neutral surfaces, restrained accent color, readable typography, generous spacing, rounded composer, and quiet tool activity. Both light and dark themes SHALL be available with system-theme default and a persistent override. Visual QA SHALL cover all primary screens and states, rather than accepting functional controls alone as completion. An answer whose content is naturally structured facts (for example, key details of a specific record the assistant read) SHALL render as a label/value grid rather than only prose, followed by a one-line source citation naming the page's hostname and the time it was read when the answer draws on bound or read page content. The empty conversation state SHALL offer suggestion chips that, when activated, fill the composer with that suggestion's text for the user to review and edit, and SHALL NOT send a message automatically on activation. This visual system change SHALL NOT reduce any existing accessibility or truthfulness guarantee elsewhere in this capability: the responsive/keyboard/contrast/live-region requirements below, the truthful-timeline requirement above, and the page-context and approval requirements elsewhere in this document continue to hold exactly as specified, restyled but not weakened.

#### Scenario: Visual acceptance
- **WHEN** screenshots of empty chat, long conversation, active tools, errors, settings, history and slash picker are reviewed at 320, 400 and 480 CSS-pixel widths in both themes
- **THEN** text, controls and overlays are legible, aligned and unclipped, spacing and icon treatment are consistent, and no overlay hides the active composer or its focused control

#### Scenario: Streaming and reduced motion
- **WHEN** content streams while the user reads an earlier message or prefers reduced motion
- **THEN** the interface preserves reading position, offers a jump-to-latest control, and disables decorative motion under reduced-motion preferences

#### Scenario: Structured answer with source line
- **WHEN** the assistant answers using facts read from a specific bound or read page
- **THEN** the answer presents those facts as a label/value grid where the content is naturally structured, and shows one source line naming the page's hostname and the time it was read, distinguishable from the assistant's own prose

#### Scenario: Suggestion chip fills the composer
- **WHEN** the user activates a suggestion chip shown in the empty conversation state
- **THEN** the composer is filled with that suggestion's text and receives focus, and no message is sent until the user explicitly sends it

#### Scenario: Accessibility continuity under the new treatment
- **WHEN** the collapsed timeline summary, the structured answer grid, and the composer-filling suggestion chips are all present in the same conversation
- **THEN** WCAG 2.1 AA text contrast, 320 CSS-pixel width with no horizontal page scrolling, full keyboard reachability, and the polite live region for streaming updates all continue to hold exactly as required elsewhere in this document

## ADDED Requirements

### Requirement: Image attachment entry points
The composer SHALL accept an image attachment through three entry points that produce the same attachment representation: dragging an image file onto the panel and dropping it, pasting an image from the clipboard with Ctrl+V while the composer has focus, and pressing Ctrl+U while the panel has focus to open a keyboard-accessible picker modal restricted to image files. Each entry point SHALL be independently usable; none SHALL require another to have been used first.

#### Scenario: Drag-and-drop attaches an image
- **WHEN** the user drags an accepted image file over the panel and drops it
- **THEN** the image is attached to the composer with a visible thumbnail, without navigating away from the panel or the page beside it

#### Scenario: Clipboard paste attaches an image
- **WHEN** the composer has focus and the user pastes clipboard content that is an accepted image
- **THEN** the image is attached to the composer with a visible thumbnail, and any accompanying plain text on the clipboard is not treated as an attachment

#### Scenario: Ctrl+U opens a picker modal
- **WHEN** the panel has focus and the user presses Ctrl+U
- **THEN** a keyboard-accessible modal opens offering to choose image files, is closable with Escape, and returns focus to the composer on close

#### Scenario: Picker selection attaches an image
- **WHEN** the user chooses one or more accepted image files from the Ctrl+U picker modal
- **THEN** each chosen image is attached to the composer exactly as a drag-and-drop or paste attachment would be, and the modal closes

### Requirement: Composer attachment representation and message binding
Each attached image SHALL appear in the composer as a thumbnail with a control to remove it before sending. The set of attachments bound to a sent message SHALL be exactly the attachments present in the composer at the instant Send is activated, mirroring this capability's existing page-context binding: "Each submitted message SHALL retain its exact page-context identity." Removing an attachment before Send SHALL exclude it entirely; an attachment added after Send SHALL NOT retroactively join a run already in progress.

#### Scenario: Remove before sending
- **WHEN** the user activates the remove control on an attached image before sending
- **THEN** that image is no longer attached and is not included when the message is later sent

#### Scenario: Multiple images in one message
- **WHEN** the user attaches more than one accepted image before sending, within the per-message limits below
- **THEN** every attached image is bound to that one sent message and shown as such in the transcript

#### Scenario: Attaching after Send does not affect the in-flight run
- **WHEN** the user sends a message and then attaches a new image while that run is still in progress
- **THEN** the newly attached image is not part of the run already sent and remains available to attach to the next message

### Requirement: Accepted image types, size limits, and rejection
The composer SHALL accept image/png, image/jpeg, image/webp, and image/gif, up to 10 MB per image and up to 4 images totaling 20 MB per message. Any drop, paste, or picker selection outside these limits, or of a type other than the accepted set, SHALL be refused with a specific, visible reason distinguishing the failure (unsupported type, single-image size, or combined-message size) rather than being silently ignored or accepted without effect. This refusal is the visible boundary of images-only attachment support: no other file kind is accepted or partially processed.

#### Scenario: Unsupported file type is refused with a reason
- **WHEN** the user drops, pastes, or picks a file that is not one of the accepted image types (including any non-image file)
- **THEN** the composer shows a specific reason naming that the type is not supported, and no attachment is added

#### Scenario: Oversized single image is refused with a reason
- **WHEN** the user attempts to attach a single accepted-type image larger than the per-image limit
- **THEN** the composer shows a specific reason naming the size limit, and no attachment is added

#### Scenario: Oversized combined message is refused with a reason
- **WHEN** attaching an otherwise-accepted image would put the message's combined attached image count or byte total over the per-message limit
- **THEN** the composer shows a specific reason naming the per-message limit, and that image is not added while previously attached images remain unaffected

### Requirement: Attachment entry points follow existing composer readiness
Image attachment entry points SHALL be available exactly when the composer is otherwise able to send: they SHALL be inert or unavailable under the same conditions that already disable Send, and SHALL become available exactly when Send does.

#### Scenario: No verified provider profile
- **WHEN** the user opens the panel without a complete verified provider profile
- **THEN** drag-and-drop, paste, and Ctrl+U attachment entry points are inert or unavailable, matching the existing disabled-Send state for that condition

#### Scenario: Verified provider without vision capability
- **WHEN** the configured provider profile's connection test recorded a failed image/vision capability, which already blocks full browser-assistant use
- **THEN** attachment entry points remain unavailable under that same existing block, with no separate or additional error specific to attachments

### Requirement: An attachment is data the user supplied, never authorization
An image attachment SHALL be treated as ordinary data the user provided, exactly like an ask-the-user answer. It SHALL NOT widen a run's authorized tab scope, SHALL NOT add to or bypass the upload path allowlist used for browser-automation file uploads, and SHALL NOT itself satisfy a pending send/submit-class approval decision. Attached image bytes SHALL NOT be written to browser extension storage, application logs, diagnostics output, or settings/session exports; they SHALL exist only as in-memory composer state before sending and, after sending, only within the same private per-conversation storage this capability already uses for other run artifacts. The transcript SHALL show exactly which attachments were actually bound to and sent with a message, and SHALL NOT represent an image as sent or seen by the assistant when it failed to be stored or delivered.

#### Scenario: Attachment does not authorize a browser action
- **WHEN** an image is attached to a message that also asks the assistant to perform a browser action
- **THEN** the attachment itself grants no additional tab scope, tool permission, or upload allowlist entry; any send/submit-class action still requires its own separate approval decision

#### Scenario: Attachment never reaches storage, logs, diagnostics, or exports
- **WHEN** an image is attached, sent, or later removed
- **THEN** its bytes are never present in extension storage, application logs, diagnostics output, or any settings/session export at any point in that lifecycle

#### Scenario: A failed attachment is reported, not implied
- **WHEN** an attached image fails to store or transmit before the message is actually sent
- **THEN** the run reports that failure explicitly, and the transcript does not present the message as having included an image the assistant never actually received

### Requirement: Busy/working indicator label, elapsed time, and accessibility
The busy/working indicator SHALL show a localized Vietnamese label, "Đang xử lý…", distinct from this capability's existing "Đang phản hồi" streaming-phase announcement so it never claims answer text is already flowing when none has arrived yet; an English reference such as "Working on it…" SHALL NOT ship as the label — it is a treatment reference only. Once the indicator has remained continuously visible for at least 3 seconds, it SHALL additionally show an elapsed-time count that increases once per second, computed only from the wall-clock instant the current turn actually began, never estimated or interpolated, and never restarted by an intervening tool-activity gap within the same run; on reconnect, that same recorded start instant SHALL be restored rather than reset to the reconnect time. The indicator's appearance and its disappearance SHALL each be announced through the panel's existing polite live region exactly once per transition, reusing the same single-announcement-per-phase-change discipline already applied to streaming, completed, stopped, error, and interrupted, extended to also cover entering the queued phase and each busy/not-busy transition within streaming; it SHALL NOT push a further announcement for its own looping animation or for the elapsed-time count changing. The label and glyph SHALL meet the same WCAG 2.1 AA contrast requirement already required of panel text and functional icons against the canvas in both themes.

#### Scenario: Localized label, not the English reference string
- **WHEN** the busy/working indicator is shown
- **THEN** its label reads "Đang xử lý…", never the English "Working on it…" used only as this feature's design reference

#### Scenario: Elapsed time is sourced, not fabricated
- **WHEN** the busy/working indicator has been continuously visible for at least 3 seconds
- **THEN** the panel shows an elapsed count computed from the current turn's actual recorded start time, increasing once per second, and that count is removed along with the rest of the indicator the instant the busy state ends

#### Scenario: One announcement per transition, not per frame
- **WHEN** the busy/working indicator appears, disappears, or continues animating across many frames
- **THEN** the panel's polite live region receives exactly one announcement for the appear transition and exactly one for the disappear transition, and none for the animation frames or elapsed-count updates in between

### Requirement: Busy/working indicator glyph and motion
The busy/working indicator SHALL show a solid warm-terracotta starburst glyph — a new named icon in the shared icon module (`extension/ui/icons.js`) rather than a one-off SVG hand-rolled beside it — sized at 18 CSS pixels (the module's existing `--icon-size-md` scale) and colored via the `--color-accent-text` token, not the raw `--color-accent` value which does not meet AA text-scale contrast against the light-theme canvas. As the module's icons are otherwise unfilled outlines (no fill, stroke only), this glyph is a deliberate, explicitly-flagged exception rendered filled rather than stroked; no other icon in the set gains a fill because of it. The glyph SHALL be marked decorative to assistive technology, carrying no accessible name of its own, since the indicator's state is already communicated once through the label text and the live region above. The glyph SHALL rotate continuously and slowly while the indicator is shown, and the label text SHALL show a slow brightness sweep travelling across it while shown; both are a deliberate, narrowly-scoped amendment to this capability's standing rule against looping decorative animation, justified because this is the only signal available that a run is alive during a long model turn or a tool-activity gap, when nothing else on screen is changing. The amendment covers this glyph and this label only, in this one location; the standing ban on looping decorative animation remains in force everywhere else in the panel, including the separate visible-agent-pointer overlay's own click and drag feedback. Both animations SHALL stop immediately, without completing their current cycle, the instant the indicator is removed. Under a reduced-motion preference, both loops SHALL stop while the glyph and label remain visibly present at a constant, readable appearance for as long as the run is actually busy, per this capability's existing rule that reduced motion removes decorative pulses and trails while preserving accurate state.

#### Scenario: Glyph and label identity
- **WHEN** the busy/working indicator is rendered
- **THEN** it shows the shared icon module's starburst glyph at 18 CSS pixels in the `--color-accent-text` token color, marked decorative to assistive technology, beside the localized label

#### Scenario: Motion stops the instant work is no longer in flight
- **WHEN** the busy/working indicator is removed because the run left the busy condition
- **THEN** any in-progress glyph rotation or label sweep stops immediately rather than finishing its current cycle, and no part of the indicator remains on screen

#### Scenario: Reduced motion keeps the indicator legible without looping motion
- **WHEN** the user prefers reduced motion and the busy/working indicator is shown
- **THEN** the glyph renders as a static filled shape and the label renders at a constant, readable color, the indicator remains visibly present for as long as the run is actually busy, and neither the rotation nor the sweep loops

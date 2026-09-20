## MODIFIED Requirements

### Requirement: Jev selects complete fresh actions

The TypeSafe runtime SHALL build complete host-owned action candidates from each fresh observation and ask Jev to select an offered action key. Each key SHALL resolve to exactly one operation, current target and prepared payload where required. Routine decisions SHALL NOT require a configured-language-model NEXT_STEP request or a prose-to-target reconstruction. A selected NAVIGATE action carries no observed target and its destination is independent of the observed page, so its dispatch SHALL require only that its prepared record is still unconsumed and that the destination differs from the current page; movement elsewhere on the observed page SHALL NOT invalidate it, and a pre-dispatch capture that no longer matches the observation SHALL be recorded as unavailable evidence rather than cancelling the navigation. A dispatch against an observed target SHALL be invalidated by a change to that target's own identity or state, by a change of document, or by a failed re-read — and SHALL NOT be invalidated by movement elsewhere on the observed page during pre-dispatch evidence capture. A capture that no longer depicts the observation SHALL be recorded as unavailable evidence, which SHALL NOT by itself cancel the dispatch.

#### Scenario: Multiple actions under one plan

- **WHEN** the prepared plan contains enough information for multiple routine actions
- **THEN** each cycle observes and consults Jev, executing validated offered actions without a language-model step request

#### Scenario: A target appears after hover

- **WHEN** HOVER reveals a new menu item
- **THEN** the next observation creates new candidates including the item without reusing prior target indices

#### Scenario: State changes during decision

- **WHEN** refreshed state no longer matches the selected target's relevant identity or state
- **THEN** no action is dispatched from the stale key and a fresh cycle rebuilds candidates

#### Scenario: The page moves under a selected navigation

- **WHEN** NAVIGATE is selected and the observed page's text, elements or document change before dispatch while the prepared record remains unconsumed
- **THEN** the navigation is dispatched to its prepared destination rather than skipped as a stale observation

#### Scenario: A prepared navigation was already spent

- **WHEN** NAVIGATE is selected from a prepared record that a previous dispatch consumed, or whose destination equals the current page
- **THEN** no navigation is dispatched from that record and a fresh cycle rebuilds candidates

#### Scenario: The page moves away from the target during evidence capture

- **WHEN** an enabled screenshot is captured before a targeted dispatch and the page changes elsewhere — rotating content, a lazy-loaded widget, a refreshed counter — while the target's own state and the document are unchanged
- **THEN** the action is dispatched and the capture is recorded as unavailable evidence rather than the step being skipped as a stale observation

#### Scenario: The target itself changes during evidence capture

- **WHEN** an enabled screenshot is captured before a targeted dispatch and the target's own observed state changes during that capture
- **THEN** no action is dispatched and a fresh cycle rebuilds candidates

### Requirement: Decision attribution is observable

Step records and user-visible descriptions SHALL attribute action decisions to Jev and planning/completion to the configured language model. They SHALL preserve target, action and outcome observability and render older records. Screenshots SHALL remain optional LLM context; Jev SHALL receive supported structured text input only. A step whose dispatch was abandoned as a stale observation or refused by a gate SHALL record a bounded host-authored code naming the condition that caused it. Those codes SHALL be host-authored classifications only and SHALL NOT echo page content, field values or tool-supplied error text.

#### Scenario: Screenshot is available

- **WHEN** an enabled screenshot is captured for a planning or completion consultation
- **THEN** the LLM receives it while Jev receives bounded structured page state and history

#### Scenario: A dispatch is abandoned as stale

- **WHEN** a step is skipped because the re-read failed, the document or target changed, a prepared record is no longer valid, or a capture no longer depicts the observation
- **THEN** the step records which of those conditions applied, distinguishably, alongside its skipped reason

#### Scenario: A dispatch is refused

- **WHEN** a gate refuses a dispatch
- **THEN** the step records the host-authored refusal reason rather than discarding it

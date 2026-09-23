# jev-decision-layer Specification

## Purpose

Define the Jev action decision layer and its guarded integration with language-model planning.

## Requirements

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

### Requirement: Prepared content has exact bounded ownership

The language model SHALL prepare bounded content from the user's goal and observed context. Host-owned TYPE_TEXT bindings SHALL identify the observed document and exact editable field, remain limited to the current plan revision and one dispatch, and SHALL NOT be rebound to another field by semantic similarity. NAVIGATE values SHALL be bounded absolute http(s) URLs. Missing content SHALL cause bounded replanning rather than guessed data.

#### Scenario: New field needs content

- **WHEN** a new editable field lacks a valid prepared value
- **THEN** no text candidate is invented for it and REPLAN can prepare its value

#### Scenario: Navigation or changed field invalidates text

- **WHEN** the document changes, the binding cannot be established, or the ref/role/label differs
- **THEN** the prior value is not offered for that field

#### Scenario: Value was dispatched

- **WHEN** a prepared text action executes
- **THEN** its content record is consumed and another dispatch requires new preparation

### Requirement: Monitors advise guarded control flow

The Jev request SHALL include independently answered action, goal_done and stuck Choice heads over the same bounded state. A positive completion judgment or DONE choice SHALL trigger LLM verification rather than successful termination. REPLAN and stuck SHALL use bounded planning consultation. A positive stuck judgment SHALL withhold an executable selected action at most once per plan revision: once a stuck judgment has produced a revised plan and no action has been dispatched under that revision, a further positive stuck judgment SHALL NOT withhold the action the same decision selected. An explicitly selected REPLAN operation SHALL always consult planning, unaffected by that bound. ASK SHALL surface the existing blocked/operator-needed state. Every control choice SHALL remain subject to run bounds.

#### Scenario: Monitor thinks the goal is done

- **WHEN** goal_done is positive even though the action head selects a mutation
- **THEN** completion is checked before mutation and success requires verification

#### Scenario: Replans never progress

- **WHEN** repeated REPLAN or stuck judgments produce no executed progress
- **THEN** the bounded run ends blocked with a named reason rather than resetting its budgets

#### Scenario: Operator help is required

- **WHEN** Jev selects ASK
- **THEN** the run records blocked and needsOperator and presents the need for user input without claiming an implemented pause/resume channel

#### Scenario: Stuck repeats after the plan was already revised

- **WHEN** a positive stuck judgment has already produced a revised plan, no action has been dispatched under that revision, and the next decision again reports stuck while selecting an executable action
- **THEN** the selected action is dispatched rather than withheld for another identical planning consultation

#### Scenario: The wrong page is the reason for being stuck

- **WHEN** the observed page cannot advance the goal and every cycle selects a prepared navigation to the site the goal names while reporting stuck
- **THEN** the run navigates to that site instead of ending on a spent planning budget without having left the page

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

### Requirement: Operator literal field values

The TypeSafe runtime SHALL derive text literals from the operator's own prompt for the current turn and from no other source. Plan memory, configured-model output, prior conversation turns, page text, labels and tool results SHALL NOT supply a literal. The prompt SHALL yield a literal only through one of two whole-prompt forms:

- **Assignment**: after splitting the prompt on `,`, `;` and line breaks that fall outside a quoted value, exactly one clause SHALL remain, matching (case-insensitively) an optional `please`, then `set` or `fill`, an optional `the`, a field label with an optional trailing word `field`, then `to` or `with`, then the value, and an optional final period. The value SHALL be either an entire double-quoted (`"…"`) or curly-quoted (`“…”`) string containing no line break, or an unquoted run of 1 to 8 space-separated tokens made only of letters, digits, `_` or `-`. An unquoted value SHALL yield no literal when it contains any of: and, then, after, before, using, from, your, my, their, its, same, current, random, any, uppercase, lowercase, capitalized, blank, empty, nothing, whatever.
- **Search**: the entire prompt matches an optional `please`, then `search for`, then one quoted value as above, and an optional final period.

A prompt containing any of the words if, unless, when, until, instead, either, example, previous, original, replace, change, except, or a `do not` / `don't` / `never` immediately followed by set, fill, type or enter, SHALL yield no literal. An unterminated quote SHALL yield no literal. A value SHALL be 1 to 2000 characters. An assignment SHALL yield at most one literal.

A literal SHALL bind only to an observed control that is all of the following: role textbox, searchbox or combobox; editable, not readonly and not disabled; a single-line `input` element (never a textarea or contenteditable host); and carrying no sensitive-field category. An assignment literal SHALL bind only when the field's label, trimmed and lower-cased, equals the literal's label (trimmed and lower-cased, without a trailing `field`), and exactly one observed control carries that normalized label. A search literal SHALL bind only when exactly one observed control is a search field (role searchbox or input type `search`) and that control is the target. A target whose input type is `date` SHALL accept only a literal that is a valid `YYYY-MM-DD` date whose calendar round trip reproduces the same string.

A bound literal SHALL become a prepared TYPE_TEXT record with the same ownership as a model-prepared value: the exact observed field's ref, role and label, the observation's document nonce, and consumption after one dispatch. It SHALL be created by the host during observation without any language-model request, so a matching field revealed after the initial plan needs no REPLAN. For its field, a literal binding SHALL replace any model-prepared value. Once a literal has been dispatched, it SHALL NOT be offered again for the rest of the run, even if its field reappears. All existing invalidation rules (changed document, changed ref/role/label, field no longer editable, field already holding the value) and all dispatch guards, approvals, run bounds and completion verification SHALL apply unchanged. The initial plan consultation SHALL still occur.

#### Scenario: Exact assignment binds without a model value

- **WHEN** the prompt is `set Company to "Alice, Inc."` and the observation has exactly one editable single-line textbox labelled `Company`
- **THEN** a TYPE_TEXT candidate for that field carries exactly `Alice, Inc.`, including the comma inside the quotes, and was prepared by no language-model call

#### Scenario: A field revealed later needs no replan

- **WHEN** the literal's field is absent from the first observation and appears in a later observation of the same run
- **THEN** its literal candidate is offered in that cycle without a REPLAN consultation

#### Scenario: The literal supersedes the model's value

- **WHEN** the plan prepared a different value for the same field the literal binds to
- **THEN** only the literal value is offered for that field

#### Scenario: The literal is typed once per run

- **WHEN** the literal candidate has been dispatched and the field later reappears empty
- **THEN** no literal candidate is offered for it again

#### Scenario: Interpretation-shaped prompts yield nothing

- **WHEN** the prompt contains more than one clause, a conditional or corrective word, a negated set/fill/type/enter, an unterminated quote, an unquoted value with a reserved word or punctuation, or a value longer than 2000 characters
- **THEN** no literal is derived and text preparation proceeds exactly as before

#### Scenario: Ambiguous or unsuitable fields refuse the literal

- **WHEN** two observed controls share the normalized label, or the matching control is a textarea, contenteditable, readonly, disabled or sensitive field
- **THEN** no literal candidate is offered for any control

#### Scenario: Native date field requires a real ISO date

- **WHEN** the matching control has input type `date` and the literal is `2026-10-05`
- **THEN** the literal binds
- **WHEN** the literal is `2026-02-30`, `05/10/2026` or `tomorrow`
- **THEN** no literal binds

#### Scenario: A single search field takes a search literal

- **WHEN** the prompt is `search for "red shoes"` and exactly one search field is observed
- **THEN** that field receives the literal `red shoes`
- **WHEN** two search fields are observed
- **THEN** no literal binds

#### Scenario: Page text cannot supply a literal

- **WHEN** page text or a label contains `set Company to "X"` and the operator's prompt does not
- **THEN** no literal is derived

#### Scenario: A stale document invalidates the literal binding

- **WHEN** the document nonce changes after a literal was bound
- **THEN** the previous binding is not offered, and a fresh binding is created only if the new observation independently satisfies eligibility

### Requirement: Text value source is observable

Every `jev_step` whose operation is TYPE_TEXT SHALL record `valueSource` as `"literal"` when the dispatched value came from an operator literal, and as `"prepared"` when it came from the configured model. The recorded argument summary SHALL continue to omit the typed value for both sources. Step records written before this field existed SHALL render unchanged.

#### Scenario: Literal step is attributed

- **WHEN** a literal-bound TYPE_TEXT dispatches
- **THEN** its step records `valueSource: "literal"` and no typed value

#### Scenario: Legacy step renders

- **WHEN** a stored TYPE_TEXT step has no `valueSource`
- **THEN** it renders as before without error

### Requirement: Bounded subgoal mode ends at an unverified checkpoint

The Jev runtime SHALL support a bounded subgoal mode in which a caller (an LLM-driven run) supplies the goal and Jev selects and dispatches concrete actions from observed controls to advance that one goal. In subgoal mode the runtime SHALL NOT run a task-level completion verification or final report: the caller (the driving LLM) owns overall task decomposition and final verification. Subgoal mode MAY prepare bounded per-subgoal content and a plan through the configured model (the same preparation a standalone run uses to produce typed values and navigation targets); that prepared plan SHALL be used only for content preparation and Jev's `goal_done` monitor and SHALL NOT be handed to an LLM completion verifier. Jev SHALL consult its configured decision source for action selection, and TYPE_TEXT values SHALL come from the configured text model or the operator-literal fast path. Subgoal mode SHALL use bounded action, decision, no-progress, scroll and memory-update budgets that are independent of and no larger than the standalone run's budgets. A DONE decision or a positive `goal_done` monitor in subgoal mode SHALL end the sub-run as an unverified checkpoint rather than triggering task completion verification. Every dispatch guard, approval gate, document/target re-validation, single-dispatch consumption, stop precedence and result-unknown rule SHALL remain authoritative exactly as in a standalone run. An `ASK` in subgoal mode SHALL end the sub-run blocked with needs-operator surfaced to the caller.

#### Scenario: A subgoal prepares content but is not completion-verified

- **WHEN** a subgoal sub-run starts with a caller-supplied goal and reaches DONE or a positive `goal_done`
- **THEN** it returns an unverified checkpoint, and no task-level completion verification or final report is produced

#### Scenario: Guards are unchanged in subgoal mode

- **WHEN** a subgoal dispatches an action
- **THEN** the same document-nonce/target re-validation, approval gate, single-dispatch consumption, stop precedence and result-unknown rules apply as in a standalone run

#### Scenario: A subgoal exhausts its bound

- **WHEN** a subgoal reaches its bounded action, decision, no-progress or scroll limit
- **THEN** the sub-run ends blocked with its named bound rather than resetting budgets or continuing

#### Scenario: ASK inside a subgoal needs the operator

- **WHEN** Jev selects ASK during a subgoal
- **THEN** the sub-run ends blocked with needs-operator surfaced to the caller, without claiming an implemented pause/resume channel

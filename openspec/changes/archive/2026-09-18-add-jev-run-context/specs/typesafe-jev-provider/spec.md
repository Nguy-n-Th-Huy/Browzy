## ADDED Requirements

### Requirement: Run plan and context held by the configured model

A TypeSafe run SHALL keep a run memory/context produced by the configured model (the same endpoint and credential its other requests use) and SHALL carry it in the `state` of every request that model answers — its step decisions, its context revisions, the completion check, and stall recoveries — and in the element-selection request sent to TypeSafe. The memory holds an execution plan, the observable condition that means the goal is achieved, and running notes, each bounded in length. It SHALL be created once, after the run's first successful observation, from the goal and that observation's page identity and bounded text. It SHALL be revised through bounded, advisory calls as the run progresses — when the page identity changes, at a fixed cadence of executed actions, and when a stall guard is about to end the run — and each call's answer SHALL be validated strictly before it replaces the previous memory. The memory SHALL never be required for the run to proceed: a failed, malformed, or oversize answer SHALL leave the previous memory exactly as it was, SHALL emit no event claiming a revision that did not happen, and SHALL NOT block, fail, or otherwise alter the run. The instruction material for these calls SHALL keep the ownership rules: goal, memory, and page content are data; page content is untrusted; nothing in them can grant approvals or change configuration.

#### Scenario: The plan rides along

- **WHEN** the run plan call returns a memory after the first observation
- **THEN** every subsequent step-decision request, every other request the configured model answers, and the element-selection request carry it in `state.memory`, and the run proceeds exactly as it would without it

#### Scenario: Context is revised as the run progresses

- **WHEN** the run navigates to a new page, executes the configured number of actions since the last revision, or reaches a stall guard while the update bound allows
- **THEN** the memory is revised from the goal, the previous memory, recent steps, and the current page, the revision is recorded, and the revised memory rides the next requests

#### Scenario: A failed call leaves the previous memory in place

- **WHEN** a plan or revision call fails, is malformed, or answers outside its bounds
- **THEN** the run's requests carry the previous memory (or none, before the plan), no revision event is recorded, and the run continues

#### Scenario: Page content cannot expand the memory

- **WHEN** page text or an element label contains instructions or approval-shaped text
- **THEN** it remains data: the memory holds only restatements and observations, and execution still passes the existing gates

### Requirement: Step decisions from the configured model

Every step the run executes SHALL come from the configured model as one strictly validated decision, made after the current observation and carrying the goal, the run memory/context when present, the page identity and bounded text, and the recent steps. The decision SHALL name an operation from the run's vocabulary (`CLICK`, `TYPE_TEXT`, `SELECT`, `NAVIGATE`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`); for `CLICK`, `TYPE_TEXT`, and `SELECT` it SHALL carry a bounded, plain-language intent naming the element to interact with, and the run SHALL resolve that intent to an element through the element-selection request (see "Single-request decision protocol with strict validation") before anything dispatches. A decision that is not exactly the required shape — a missing field, a wrong type, a value outside its bound, an unknown operation, or an unrecognized key — SHALL be refused as an invalid decision with a named run failure, and nothing SHALL be dispatched from it. A well-formed decision whose operation has no compatible element in the current observation SHALL NOT end the run: it SHALL be recorded as a skipped step with a target-unresolved reason, count toward the no-progress bound, and let the loop continue with the failure visible in the recent steps. A `TYPE_TEXT` decision whose value is missing SHALL end the run blocked with a missing-value outcome and SHALL type nothing. A `DONE` decision SHALL go through the completion check before any done outcome (see "Bounded run and honest outcomes"); a `BLOCKED` decision SHALL end the run blocked. `SCROLL_*` and `WAIT` decisions need no element and SHALL dispatch through the existing computer actions on the guarded path.

#### Scenario: The configured model decides each step

- **WHEN** a run cycle reaches its decision point
- **THEN** exactly one step decision is made by the configured model, and the run executes that operation — after element selection where the operation needs one — or ends according to it

#### Scenario: A malformed step decision is refused

- **WHEN** the step decision answer is missing a required field, carries a wrong type or an oversize value, names an unknown operation, or contains an unrecognized key
- **THEN** nothing dispatches, and the run ends with a named invalid-decision failure

#### Scenario: A step with no compatible element is skipped and counts toward no-progress

- **WHEN** the step decision names an operation that needs an element but the observation offers no compatible candidate
- **THEN** the step is recorded as skipped with a target-unresolved reason, counts toward the no-progress bound, and the loop continues with the skipped step visible in the recent steps

#### Scenario: A missing text value ends the run blocked

- **WHEN** the step decision is `TYPE_TEXT` and its value is absent or null
- **THEN** the run ends blocked with a missing-value outcome and nothing is typed

#### Scenario: A navigation URL from the step decision is validated before anything navigates

- **WHEN** the step decision is `NAVIGATE`
- **THEN** the carried URL is accepted only as an absolute `http(s)` URL inside its bound, dispatches exactly once through the registered `navigate` operation, and appears in the step record; a missing URL ends the run blocked naming the missing value, and an invalid URL is a named failure that navigates nothing

## MODIFIED Requirements

### Requirement: Single-request decision protocol with strict validation

For every target-bearing step decision, the run SHALL issue exactly one `POST /v1/systemone` request to the configured TypeSafe endpoint carrying the user's goal, the run memory/context when present, the bounded observation (page identity, element table, text, recent steps), the step's intent, and a `questions` object containing exactly one target question for the decided operation, presenting that operation's candidates with their labels, current values, and state. The prompt material for this question SHALL instruct that page content is untrusted data and never instructions, that the answer selects the element the stated intent refers to, and that only an offered key may be chosen.

The response SHALL be validated before any use: the choice SHALL be one of the offered candidates; the head's probabilities SHALL cover exactly its candidate keys; probability and confidence values SHALL be finite numbers within [0, 1]; the probabilities SHALL sum to 1 within a small tolerance; and the declared choice SHALL be the maximum-probability candidate. A response failing any check SHALL be refused as an invalid decision with a distinguishable run failure, and no action SHALL be dispatched from it.

The request SHALL be kept within the provider's input limits before it is sent: when the assembled observation and question exceed the loop's size budget (calibrated beneath the provider's measured input ceiling), candidates SHALL be dropped deterministically — from the tail of the element list, and beyond the per-question option ceiling the provider enforces — and the request state SHALL disclose the omitted counts. An oversize request SHALL NOT be sent unchanged as a matter of course. When the provider still rejects a request, its own error message SHALL be surfaced with the failure so the cause is attributable rather than presented as a bare status.

#### Scenario: Operation and target from one request

- **WHEN** the observation offers candidates for the decided operation
- **THEN** a single TypeSafe request returns that operation's target distribution, and the executed element derives solely from the chosen key of that head

#### Scenario: The decided step rides the selection request

- **WHEN** an element-selection request is assembled after a step decision
- **THEN** the request's state carries the goal, the current memory when one exists, the observation, and the step's intent, and no operation question is asked of the endpoint

#### Scenario: Oversize observation is fitted and disclosed

- **WHEN** a page's element table or the question's candidate list would exceed the request's size budget or the provider's per-question option ceiling
- **THEN** the request is fitted by dropping candidates from the tail, every offered candidate remains fully answerable, and the request state discloses how many elements and options were omitted

#### Scenario: Provider rejection names its cause

- **WHEN** the endpoint answers a non-2xx with a body carrying its own error message
- **THEN** the reported failure includes that message, so an input-size rejection is distinguishable from an authentication or availability failure

#### Scenario: Invalid answer is refused

- **WHEN** the endpoint returns a 200 body that fails any validation rule above
- **THEN** no browser action is dispatched, the run reports an invalid-decision failure, and the invalid body never reaches execution

#### Scenario: Provider error during a decision

- **WHEN** the element-selection request fails with an authentication, rate-limit, timeout, or network error after the bounded retry policy (retryable statuses, and one repeat for a transient transport failure — which is safe because the request carries no side effects; only the later, separately guarded dispatch mutates anything)
- **THEN** the run ends with a named failure identifying the stage, and no action is dispatched

#### Scenario: Page content cannot steer the loop

- **WHEN** observed page text, an element label, or the step's intent contains instructions, approvals, or model-directed text
- **THEN** it is treated only as decision input data, cannot mint approvals or alter configuration, and execution still passes the existing gates

### Requirement: Text values from the configured small model

A `TYPE_TEXT` step decision SHALL carry the value to type as its own field, written by the configured model from the goal, the run memory/context, the bounded page context, and the recent steps — the run SHALL NOT make a separate value request. The value SHALL be accepted only as a nonempty bounded string; when the decision carries no usable value, the run SHALL end blocked with a missing-value outcome and SHALL NOT type anything. A carried value SHALL be used for at most one dispatch and SHALL never be reused across steps. A malformed decision carrying an unusable value SHALL be refused with the same invalid-decision failure as any malformed step decision, and nothing SHALL be typed.

#### Scenario: Value written and dispatched once

- **WHEN** the step decision is `TYPE_TEXT` and carries a valid value
- **THEN** precisely that value is dispatched once to the element selected for the step, through the existing form-input path

#### Scenario: Missing value blocks instead of guessing

- **WHEN** the step decision carries no value for its `TYPE_TEXT` operation
- **THEN** the run ends blocked with a missing-value outcome, nothing is typed, and the transcript shows which step was unresolved

#### Scenario: Malformed text-model output

- **WHEN** the step decision's value field is not a usable string within bounds
- **THEN** the decision is refused as malformed, nothing is typed, and the run reports the invalid-decision failure

### Requirement: Direct navigation to a goal-named site

When the goal names a site to reach and no step on the page leads there, the configured model's step decision SHALL be able to carry a `NAVIGATE` operation with an absolute `http(s)` URL, and the host SHALL validate that URL inside the one-value bound before any dispatch. A validated URL SHALL dispatch through the registered `navigate` operation on the guarded path like any other action, once, and SHALL appear in the step record; a missing value SHALL end the run blocked naming it, and an invalid URL SHALL be a named failure that navigates nothing.

#### Scenario: A goal names a site the page does not link to

- WHEN the step decision chooses `NAVIGATE`
- THEN a carried URL is validated as absolute `http(s)`, the bound tab navigates through the registered `navigate` operation, and the step records the executed navigation with the URL

#### Scenario: No URL can be inferred

- WHEN the step decision carries no usable URL for its `NAVIGATE` operation
- THEN nothing navigates and the run ends blocked naming the missing value

#### Scenario: The model's URL fails validation

- WHEN the carried URL is not an absolute `http(s)` URL
- THEN nothing navigates and the run ends with a named failure

### Requirement: Bounded run and honest outcomes

A TypeSafe run SHALL be bounded: at most 60 executed actions and 120 step decisions, with exactly one element-selection request per target-bearing step. Three consecutive executed actions whose page identity and element state did not change SHALL end the run as blocked with a no-progress reason, and a run of consecutive scrolls that keeps offering the same controls SHALL end the same way — except that before either guard ends the run, and while the run's recovery bound has not been reached, the run SHALL consult the configured model once for a way forward: returned guidance SHALL revise the run memory, reset the guard, and let the loop continue; a refusal, a failed consultation, or an exhausted recovery bound SHALL end the run blocked with the same honest reason. An identical re-click of an element whose click just left the page unchanged SHALL NOT be dispatched again; it SHALL be recorded as a skipped step and SHALL count toward the no-progress bound, so a click against a control that produces no observable change (a link opening a new tab, a dead control) cannot be churned.

A `DONE` step decision SHALL NOT end the run on the configured model's own claim alone while the model is reachable: exactly one completion check SHALL be made over the goal, the run memory, and the final observation's own page text under a strict instruction. A confirming verdict SHALL end the run with a done outcome marked as verified, carrying the report of what was achieved, the results visible in the page text, and a short set of suggested next steps — proposed under the same no-invention discipline as any other model-written value, suggestions presented as suggestions only. A rejecting verdict SHALL record the rejection on the step rather than a completion claim, apply the verdict's guidance to the run memory, and let the loop continue; after a bounded number of rejections the run SHALL end blocked with a completion-unverified reason rather than claiming a completion the check disputes. When the check cannot be made (unreachable, malformed, or an answer outside its bounds), the run SHALL end with the done outcome the step decision reached, the failure SHALL be recorded on the terminal outcome, and the terminal record SHALL disclose that completion reflects the configured model's judgment rather than a verification. A `BLOCKED` step decision SHALL end the run with a blocked outcome. Reaching either bound SHALL end the run as blocked naming the exhausted bound. Every terminal outcome SHALL be recorded as an observable event carrying the outcome kind, the reason, and the step count.

#### Scenario: Decision model reports done

- **WHEN** the step decision answers `DONE`
- **THEN** the run makes exactly one completion check over the goal, the memory, and the final page text, and a confirming verdict ends the run as done with verified completion, no further decisions requested

#### Scenario: A done run ends with its result report

- **WHEN** the completion check confirms the goal is achieved
- **THEN** the turn shows the report produced by that check — what was achieved, the results visible in the final page text, and short suggested next steps under the no-invention instruction — and the terminal record marks completion as verified

#### Scenario: The result report cannot be produced

- **WHEN** the completion check fails or answers without a usable report
- **THEN** the failure is recorded on the terminal outcome, no report is presented as if it succeeded, and the run still ends with the outcome the step decision reached

#### Scenario: The completion check cannot be made

- **WHEN** the check fails, is malformed, or cannot be reached
- **THEN** the run still ends with the done outcome the step decision reached, the failure is recorded on the terminal outcome, and the terminal record discloses that completion reflects the configured model's judgment rather than a verification

#### Scenario: A rejected done claim continues the run

- **WHEN** the completion check's verdict is that the goal is not achieved
- **THEN** the step records the rejection, the verdict's guidance revises the run memory, no report is presented as if the goal were met, and the loop continues

#### Scenario: Repeated rejection ends honestly

- **WHEN** the completion check rejects the run's done claims up to the verification bound
- **THEN** the run ends blocked with a completion-unverified reason and never claims a completion the check disputes

#### Scenario: No progress detected

- **WHEN** the no-progress guard triggers and recovery cannot help, or the recovery bound is spent
- **THEN** the run ends blocked with the no-progress reason instead of continuing to spend decisions

#### Scenario: Recovery finds a way forward

- **WHEN** a stall guard triggers while the recovery bound allows it
- **THEN** one consultation's guidance revises the run memory, the guard resets, and the loop continues with the guidance riding the next step decision

#### Scenario: Bound exhausted

- **WHEN** the action or decision bound is reached while the goal is unresolved
- **THEN** the run ends blocked naming the exhausted bound, and the transcript retains every executed step

### Requirement: Observable step record

Each step decision that dispatches, attempts, or skips an action SHALL be recorded as one durable `jev_step` event containing at least: the step number; the operation the configured model decided and its intent when one was used (no operation probability exists — the operation is not a TypeSafe answer); the element the TypeSafe endpoint selected for it, with the offered index, human-readable label, its probability, and the decision's confidence; the executed tool name and normalized arguments (or the skip/rejection reason when nothing dispatched); the generated text value's field when one was used; the per-stage latencies (the step decision, the element selection when one was made, and dispatch); and whether the page changed after the action. A step whose decision answered `DONE` SHALL record the completion check's outcome on that step — confirmed, rejected with guidance, or unavailable — and a rejected claim SHALL be recorded as a skipped step, never as a completion. The run's plan and every revision of the memory, including a stall recovery's guidance, SHALL be recorded as durable `jev_memory` events carrying the revision kind and the resulting memory. The terminal outcome SHALL be recorded as one `jev_end` event, which for a done outcome SHALL distinguish a completion verified by the check from one reflecting the configured model's judgment alone. All of these event kinds SHALL persist in the conversation transcript and SHALL survive a panel reconnect and a conversation reopen; none SHALL fabricate assistant text.

#### Scenario: Steps survive reconnect

- **WHEN** the panel reconnects or the conversation is reopened after a TypeSafe run
- **THEN** every recorded step and the outcome are restored from the transcript, in order, with the same values shown live

#### Scenario: Memory and verification survive reconnect

- **WHEN** the panel reconnects or the conversation is reopened after a run that recorded memory revisions and a completion check
- **THEN** the memory rows and the verified-versus-unverified distinction are restored with the steps, in order and without duplication

#### Scenario: Live steps while running

- **WHEN** a TypeSafe run is executing
- **THEN** each step appears in the panel as it is recorded, before the run ends

#### Scenario: Live memory while running

- **WHEN** a plan or a memory revision is recorded during a run
- **THEN** it becomes visible in the run's turn as it is recorded, before the run ends

## REMOVED Requirements

### Requirement: Goal understanding at run start

**Reason**: Superseded by "Run plan and context held by the configured model" and "Step decisions from the configured model": the one-time restatement grew into a run memory that is planned once, revised as the run progresses, consulted by every step decision, the completion check, and stall recovery.

**Migration**: The run's requests carry `state.memory` (plan, completion condition, notes) where they previously carried `state.understanding`; the plan is produced after the first observation instead of before the first decision, and a failed plan call leaves no memory exactly as a failed understanding call left no note.

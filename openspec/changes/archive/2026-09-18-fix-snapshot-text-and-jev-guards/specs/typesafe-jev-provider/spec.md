## MODIFIED Requirements

### Requirement: Bounded run and honest outcomes

A TypeSafe run SHALL be bounded: at most 60 executed actions and 120 step decisions, with exactly one element-selection request per target-bearing step. Three consecutive executed actions whose page identity and element state did not change SHALL end the run as blocked with a no-progress reason, and a run of consecutive scrolls that keeps offering the same controls SHALL end the same way — except that before either guard ends the run, and while the run's recovery bound has not been reached, the run SHALL consult the configured model once for a way forward: returned guidance SHALL revise the run memory, reset the guard, and let the loop continue; a refusal, a failed consultation, or an exhausted recovery bound SHALL end the run blocked with the same honest reason. The same stall treatment SHALL apply to a run of consecutive executed steps whose every action is a scroll — in either direction and regardless of whether the element table changed: once the configured number of such steps is reached the recovery consultation runs, and with recovery refused, unavailable, or spent — or after a recovery, if the next executed step is again a scroll — the run SHALL end blocked with the no-progress reason rather than continuing to spend decisions. An identical re-click of an element whose click just left the page unchanged SHALL NOT be dispatched again; it SHALL be recorded as a skipped step and SHALL count toward the no-progress bound, so a click against a control that produces no observable change (a link opening a new tab, a dead control) cannot be churned.

A `DONE` step decision SHALL NOT end the run on the configured model's own claim alone while the model is reachable: exactly one completion check SHALL be made over the goal, the run memory, the final observation's own page text, and — when the cycle has one — the step's capture, under a strict instruction. For a goal that asks for information or analysis rather than a page action, a confirming verdict SHALL mean the gathered material — the page text the run observed, its memory notes, and any captures — supports the requested analysis, with any part that could not be obtained named as a limitation rather than looping the run. A confirming verdict SHALL end the run with a done outcome marked as verified, carrying the report of what was achieved, the results visible in the page text, and a short set of suggested next steps — proposed under the same no-invention discipline as any other model-written value, suggestions presented as suggestions only. A rejecting verdict SHALL record the rejection on the step rather than a completion claim, apply the verdict's guidance to the run memory, and let the loop continue; after a bounded number of rejections the run SHALL end blocked with a completion-unverified reason rather than claiming a completion the check disputes. When the check cannot be made (unreachable, malformed, or an answer outside its bounds), the run SHALL end with the done outcome the step decision reached, the failure SHALL be recorded on the terminal outcome, and the terminal record SHALL disclose that completion reflects the configured model's judgment rather than a verification. A `BLOCKED` step decision SHALL end the run with a blocked outcome. Reaching either bound SHALL end the run as blocked naming the exhausted bound. Every terminal outcome SHALL be recorded as an observable event carrying the outcome kind, the reason, and the step count.

#### Scenario: Decision model reports done

- **WHEN** the step decision answers `DONE`
- **THEN** the run makes exactly one completion check over the goal, the memory, the final page text, and the step's capture when one exists, and a confirming verdict ends the run as done with verified completion, no further decisions requested

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

#### Scenario: An analysis goal can finish with what was gathered

- **WHEN** the goal asks for information or analysis and the gathered material supports the requested analysis
- **THEN** the completion check may confirm, the report presents the analysis, and anything that could not be obtained is named as a limitation instead of looping the run

#### Scenario: Scroll-only steps trip the stall guard

- **WHEN** consecutive executed steps are scrolls in either direction — whether or not the element table changed — up to the configured number
- **THEN** the recovery consultation runs as at any stall, and with recovery refused, unavailable, or spent — or after a recovery, if the next executed step is again a scroll — the run ends blocked with the no-progress reason

#### Scenario: No progress detected

- **WHEN** the no-progress guard triggers and recovery cannot help, or the recovery bound is spent
- **THEN** the run ends blocked with the no-progress reason instead of continuing to spend decisions

#### Scenario: Recovery finds a way forward

- **WHEN** a stall guard triggers while the recovery bound allows it
- **THEN** one consultation's guidance revises the run memory, the guard resets, and the loop continues with the guidance riding the next step decision

#### Scenario: Bound exhausted

- **WHEN** the action or decision bound is reached while the goal is unresolved
- **THEN** the run ends blocked naming the exhausted bound, and the transcript retains every executed step

### Requirement: Step decisions from the configured model

Every step the run executes SHALL come from the configured model as one strictly validated decision, made after the current observation and carrying the goal, the run memory/context when present, the page identity and bounded text, the recent steps, and — when screenshots are enabled and the cycle's capture succeeded — the current page capture. The decision SHALL name an operation from the run's vocabulary (`CLICK`, `TYPE_TEXT`, `SELECT`, `NAVIGATE`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`); for `CLICK`, `TYPE_TEXT`, and `SELECT` it SHALL carry a bounded, plain-language intent naming the element to interact with, and the run SHALL resolve that intent to an element through the element-selection request (see "Single-request decision protocol with strict validation") before anything dispatches. A decision that is not exactly the required shape — a missing field, a wrong type, a value outside its bound, an unknown operation, or an unrecognized key — SHALL be refused as an invalid decision with a named run failure, and nothing SHALL be dispatched from it. A well-formed decision whose operation has no compatible element in the current observation SHALL NOT end the run: it SHALL be recorded as a skipped step with a target-unresolved reason, count toward the no-progress bound, and let the loop continue with the failure visible in the recent steps. A `TYPE_TEXT` decision whose value is missing SHALL end the run blocked with a missing-value outcome and SHALL type nothing. A `DONE` decision SHALL go through the completion check before any done outcome (see "Bounded run and honest outcomes"); a `BLOCKED` decision SHALL end the run blocked. `SCROLL_*` and `WAIT` decisions need no element and SHALL dispatch through the existing computer actions on the guarded path. The decision SHALL follow the run memory's own plan and notes: it SHALL NOT repeat an action those notes call ineffective, it SHALL choose the control the notes name for the next step, and when what the goal needs cannot be obtained from the current page with the available operations (an access, login, or gating limit) it SHALL choose `BLOCKED` naming that reason instead of repeating ineffective actions; when the goal asks for information or analysis and the gathered material is sufficient, it SHALL choose `DONE` so the completion check can render the answer.

#### Scenario: The configured model decides each step

- **WHEN** a run cycle reaches its decision point
- **THEN** exactly one step decision is made by the configured model, and the run executes that operation — after element selection where the operation needs one — or ends according to it

#### Scenario: The decision honours its own plan

- **WHEN** the run memory's notes state that an action is ineffective or name the control the next step requires
- **THEN** the next step decision chooses accordingly — the named control, or `BLOCKED` naming why what the goal needs is unobtainable — and never repeats the action its notes call ineffective

#### Scenario: The step decision can see the page

- **WHEN** screenshots are enabled and the cycle captured the tab
- **THEN** the step decision is made with the capture attached as image content beside the textual context, and its strict output validation is unchanged

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

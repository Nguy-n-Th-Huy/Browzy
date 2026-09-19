## ADDED Requirements

### Requirement: Screenshot context for the configured model

When screenshots are enabled for a `typesafe` profile (the default; a profile stored before the toggle existed loads as enabled), a run SHALL capture the bound tab once per cycle, after the structured observation, through the same read-only dispatch discipline every observation passes — run-state, lease, and tab-scope checks, no approval because a capture changes nothing — and SHALL attach the capture to that cycle's step-decision request as image content alongside the textual context. The capture SHALL be unannotated and SHALL NOT be written to disk by this feature; its size is bounded by the existing capture path. A failed capture SHALL NOT block, fail, or otherwise alter the run: the cycle proceeds text-only and a later cycle captures again. The completion check for a `DONE` step SHALL reuse that step's capture when one exists and SHALL proceed text-only otherwise. No capture SHALL be attached to the element-selection request — that request answers only over the structured observation. A capture is data like any other page content: nothing in it can grant approvals, change configuration, or become a selector or coordinate.

#### Scenario: A capture rides the step decision

- **WHEN** screenshots are enabled and a cycle captures the tab
- **THEN** the step-decision request carries the capture as image content beside the textual context, and the run otherwise proceeds exactly as it would without it

#### Scenario: A failed capture degrades that cycle to text only

- **WHEN** the capture cannot be produced (the tab is gone, the document refuses capture, or the response is lost)
- **THEN** that cycle's step decision is made without an image, nothing else about the run changes, and a later cycle captures again

#### Scenario: The completion check reuses the step's capture

- **WHEN** the step decision answers `DONE` and the cycle captured the tab
- **THEN** the completion check carries that same capture, and when the cycle has no capture the check proceeds text-only as before

#### Scenario: Screenshots can be disabled

- **WHEN** the profile's screenshot toggle is off
- **THEN** no capture is made and every request the configured model answers is text-only

## MODIFIED Requirements

### Requirement: Provider type and configuration surface

A provider profile SHALL support a third provider type, `typesafe`, alongside `anthropic` and `chatgpt`. Selecting it in Settings SHALL expose the TypeSafe credential, the text-model configuration (base URL, model ID, credential), the profile's editable model list with exactly one default model, and a screenshot toggle that is enabled by default; it SHALL NOT expose the `anthropic` Base URL or API-key fields. Switching a profile's provider type SHALL remain nondestructive to the other fields, and SHALL reject any value that is not a known provider type.

When a `typesafe` profile's model list is empty at the moment the provider type is selected, settings SHALL seed it with the provider's documented `jev-latest` entry; an existing or user-edited list SHALL never be overwritten. The text-model base URL and text-model ID SHALL be required, nonempty settings before a run or a capability test is attempted, and SHALL be validated as a well-formed HTTPS URL (loopback HTTP permitted under the existing URL rules). The screenshot toggle SHALL persist with the profile as a non-secret setting, and a profile stored before the toggle existed SHALL load with it enabled.

#### Scenario: Switching to the TypeSafe provider

- **WHEN** the user selects the `typesafe` provider type in Settings
- **THEN** the Anthropic Base URL and API-key fields are hidden, the TypeSafe credential, text-model fields, and the enabled screenshot toggle are shown, and an empty model list is seeded with `jev-latest` exactly once

#### Scenario: Existing profiles are unaffected

- **WHEN** a profile of type `anthropic` or `chatgpt` is loaded or used after this change
- **THEN** its provider type, fields, credentials, capability results, and run behavior are unchanged

#### Scenario: Invalid provider type value

- **WHEN** a caller attempts to persist a provider type that is not `anthropic`, `chatgpt`, or `typesafe`
- **THEN** the change is rejected and no profile is written

#### Scenario: The screenshot toggle defaults on for existing profiles

- **WHEN** a `typesafe` profile stored before the toggle existed is loaded
- **THEN** the toggle shows enabled and its runs capture the bound tab as if it had been set

### Requirement: TypeSafe capability test

The provider capability test for a `typesafe` profile SHALL issue one `POST /v1/systemone` request with a trivial choice question against the configured endpoint, model, and credential, validate the structured answer shape; separately issue one minimal completion against the configured text model, validating that its response parses as a JSON object with a single `text` key; and separately issue one minimal completion carrying a small embedded image to the same text-model endpoint, validating the same single-key parse so the wire's image support is proven. The combined result SHALL be recorded for the exact (endpoint, model, credential revision) triple the test ran against, so any change to those values invalidates it naturally. The image stage's outcome SHALL be reported as its own capability and SHALL NOT decide the profile's runnability: a model that rejects images remains runnable with screenshots disabled. Failures SHALL be reported with the existing actionable codes where they apply (`AUTH_ERROR`, `MODEL_UNAVAILABLE_ERROR`, `RATE_LIMIT_ERROR`, `TIMEOUT_ERROR`, `NETWORK_ERROR`, `NO_CREDENTIAL`, `INVALID_PROFILE`) and with `INVALID_RESPONSE` when a 200 response fails the expected structured validation; the text-model and image outcomes SHALL be distinguishable from each other and from the TypeSafe outcome. No test SHALL reveal either key.

#### Scenario: Successful test

- **WHEN** the user runs the capability test on a `typesafe` profile with valid credentials, a reachable text model, and a model that accepts images
- **THEN** the result is recorded as passed for the exact endpoint/model/credential revision triple, all three stages report their own pass, and the profile reports runnable

#### Scenario: Invalid structured response

- **WHEN** the TypeSafe endpoint answers 200 with a body that fails choice validation (unknown choice, missing or extra probability keys, probabilities not summing to 1, or a choice that is not the maximum)
- **THEN** the test reports `INVALID_RESPONSE` and the profile is not marked verified

#### Scenario: Text-model failure is distinguishable

- **WHEN** the TypeSafe question succeeds but the text-model completion is unreachable, unauthorized, or returns no valid `{"text"}` object
- **THEN** the failure names the text-model stage, the profile is not marked verified, and re-running after fixing only the text configuration is possible

#### Scenario: Image stage is reported separately

- **WHEN** the text-model completion succeeds but the image completion is rejected or fails (for example the model does not accept image content)
- **THEN** the result reports the image stage as failed distinctly (the applicable connectivity code or `INVALID_RESPONSE`), the profile remains runnable when the other stages passed, and settings can tell the operator to disable screenshots or choose a vision-capable model

### Requirement: Step decisions from the configured model

Every step the run executes SHALL come from the configured model as one strictly validated decision, made after the current observation and carrying the goal, the run memory/context when present, the page identity and bounded text, the recent steps, and — when screenshots are enabled and the cycle's capture succeeded — the current page capture. The decision SHALL name an operation from the run's vocabulary (`CLICK`, `TYPE_TEXT`, `SELECT`, `NAVIGATE`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`); for `CLICK`, `TYPE_TEXT`, and `SELECT` it SHALL carry a bounded, plain-language intent naming the element to interact with, and the run SHALL resolve that intent to an element through the element-selection request (see "Single-request decision protocol with strict validation") before anything dispatches. A decision that is not exactly the required shape — a missing field, a wrong type, a value outside its bound, an unknown operation, or an unrecognized key — SHALL be refused as an invalid decision with a named run failure, and nothing SHALL be dispatched from it. A well-formed decision whose operation has no compatible element in the current observation SHALL NOT end the run: it SHALL be recorded as a skipped step with a target-unresolved reason, count toward the no-progress bound, and let the loop continue with the failure visible in the recent steps. A `TYPE_TEXT` decision whose value is missing SHALL end the run blocked with a missing-value outcome and SHALL type nothing. A `DONE` decision SHALL go through the completion check before any done outcome (see "Bounded run and honest outcomes"); a `BLOCKED` decision SHALL end the run blocked. `SCROLL_*` and `WAIT` decisions need no element and SHALL dispatch through the existing computer actions on the guarded path.

#### Scenario: The configured model decides each step

- **WHEN** a run cycle reaches its decision point
- **THEN** exactly one step decision is made by the configured model, and the run executes that operation — after element selection where the operation needs one — or ends according to it

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

### Requirement: Bounded run and honest outcomes

A TypeSafe run SHALL be bounded: at most 60 executed actions and 120 step decisions, with exactly one element-selection request per target-bearing step. Three consecutive executed actions whose page identity and element state did not change SHALL end the run as blocked with a no-progress reason, and a run of consecutive scrolls that keeps offering the same controls SHALL end the same way — except that before either guard ends the run, and while the run's recovery bound has not been reached, the run SHALL consult the configured model once for a way forward: returned guidance SHALL revise the run memory, reset the guard, and let the loop continue; a refusal, a failed consultation, or an exhausted recovery bound SHALL end the run blocked with the same honest reason. An identical re-click of an element whose click just left the page unchanged SHALL NOT be dispatched again; it SHALL be recorded as a skipped step and SHALL count toward the no-progress bound, so a click against a control that produces no observable change (a link opening a new tab, a dead control) cannot be churned.

A `DONE` step decision SHALL NOT end the run on the configured model's own claim alone while the model is reachable: exactly one completion check SHALL be made over the goal, the run memory, the final observation's own page text, and — when the cycle has one — the step's capture, under a strict instruction. A confirming verdict SHALL end the run with a done outcome marked as verified, carrying the report of what was achieved, the results visible in the page text, and a short set of suggested next steps — proposed under the same no-invention discipline as any other model-written value, suggestions presented as suggestions only. A rejecting verdict SHALL record the rejection on the step rather than a completion claim, apply the verdict's guidance to the run memory, and let the loop continue; after a bounded number of rejections the run SHALL end blocked with a completion-unverified reason rather than claiming a completion the check disputes. When the check cannot be made (unreachable, malformed, or an answer outside its bounds), the run SHALL end with the done outcome the step decision reached, the failure SHALL be recorded on the terminal outcome, and the terminal record SHALL disclose that completion reflects the configured model's judgment rather than a verification. A `BLOCKED` step decision SHALL end the run with a blocked outcome. Reaching either bound SHALL end the run as blocked naming the exhausted bound. Every terminal outcome SHALL be recorded as an observable event carrying the outcome kind, the reason, and the step count.

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

#### Scenario: No progress detected

- **WHEN** the no-progress guard triggers and recovery cannot help, or the recovery bound is spent
- **THEN** the run ends blocked with the no-progress reason instead of continuing to spend decisions

#### Scenario: Recovery finds a way forward

- **WHEN** a stall guard triggers while the recovery bound allows it
- **THEN** one consultation's guidance revises the run memory, the guard resets, and the loop continues with the guidance riding the next step decision

#### Scenario: Bound exhausted

- **WHEN** the action or decision bound is reached while the goal is unresolved
- **THEN** the run ends blocked naming the exhausted bound, and the transcript retains every executed step

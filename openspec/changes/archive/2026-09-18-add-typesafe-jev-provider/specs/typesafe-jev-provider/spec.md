## Purpose

Adds a TypeSafe (Jev) provider that drives browser tasks through structured choice questions — an atomic page snapshot, one decision request per step, and small-model text values — alongside the existing LLM runtime, under the same confinement, approval, and recovery guarantees.

## ADDED Requirements

### Requirement: Provider type and configuration surface

A provider profile SHALL support a third provider type, `typesafe`, alongside `anthropic` and `chatgpt`. Selecting it in Settings SHALL expose the TypeSafe credential, the text-model configuration (base URL, model ID, credential), and the profile's editable model list with exactly one default model; it SHALL NOT expose the `anthropic` Base URL or API-key fields. Switching a profile's provider type SHALL remain nondestructive to the other fields, and SHALL reject any value that is not a known provider type.

When a `typesafe` profile's model list is empty at the moment the provider type is selected, settings SHALL seed it with the provider's documented `jev-latest` entry; an existing or user-edited list SHALL never be overwritten. The text-model base URL and text-model ID SHALL be required, nonempty settings before a run or a capability test is attempted, and SHALL be validated as a well-formed HTTPS URL (loopback HTTP permitted under the existing URL rules).

#### Scenario: Switching to the TypeSafe provider

- **WHEN** the user selects the `typesafe` provider type in Settings
- **THEN** the Anthropic Base URL and API-key fields are hidden, the TypeSafe credential and text-model fields are shown, and an empty model list is seeded with `jev-latest` exactly once

#### Scenario: Existing profiles are unaffected

- **WHEN** a profile of type `anthropic` or `chatgpt` is loaded or used after this change
- **THEN** its provider type, fields, credentials, capability results, and run behavior are unchanged

#### Scenario: Invalid provider type value

- **WHEN** a caller attempts to persist a provider type that is not `anthropic`, `chatgpt`, or `typesafe`
- **THEN** the change is rejected and no profile is written

### Requirement: Credential and configuration storage for the TypeSafe provider

The TypeSafe API key and the text-model API key SHALL be stored by the native companion in the OS credential store as one secret record under a per-profile target (`browzy-in-chrome/typesafe/<profileId>`), separate from the `anthropic` credential target and the `chatgpt` refresh-token target. Neither key SHALL ever appear in extension storage, page scripts, profile files, logs, exported settings, or the SDK environment. The settings UI SHALL accept each key write-only, SHALL clear submitted raw values, and SHALL report only whether each key is saved. A secret that does not fit the OS credential store's size limit SHALL fail with the existing `SECRET_TOO_LARGE` outcome and SHALL NOT be truncated. Removing the credential SHALL bump the credential revision, cancel active runs using it, and require re-entry before another TypeSafe request.

#### Scenario: Keys never leave the companion

- **WHEN** settings are exported, diagnostics are viewed, or a run's environment is constructed
- **THEN** neither the TypeSafe API key nor the text-model API key appears in the output

#### Scenario: Credential removal during a run

- **WHEN** the stored TypeSafe credential is removed while a TypeSafe run is active
- **THEN** the run is stopped through the existing revocation path and a later run requires the credential again

### Requirement: TypeSafe capability test

The provider capability test for a `typesafe` profile SHALL issue one `POST /v1/systemone` request with a trivial choice question against the configured endpoint, model, and credential, validate the structured answer shape, and separately issue one minimal completion against the configured text model, validating that its response parses as a JSON object with a single `text` key. The combined result SHALL be recorded for the exact (endpoint, model, credential revision) triple the test ran against, so any change to those values invalidates it naturally. Failures SHALL be reported with the existing actionable codes where they apply (`AUTH_ERROR`, `MODEL_UNAVAILABLE_ERROR`, `RATE_LIMIT_ERROR`, `TIMEOUT_ERROR`, `NETWORK_ERROR`, `NO_CREDENTIAL`, `INVALID_PROFILE`) and with `INVALID_RESPONSE` when a 200 response fails the expected structured validation; the text-model outcome SHALL be distinguishable from the TypeSafe outcome. No test SHALL reveal either key.

#### Scenario: Successful test

- **WHEN** the user runs the capability test on a `typesafe` profile with valid credentials and a reachable text model
- **THEN** the result is recorded as passed for the exact endpoint/model/credential revision triple and the profile reports runnable

#### Scenario: Invalid structured response

- **WHEN** the TypeSafe endpoint answers 200 with a body that fails choice validation (unknown choice, missing or extra probability keys, probabilities not summing to 1, or a choice that is not the maximum)
- **THEN** the test reports `INVALID_RESPONSE` and the profile is not marked verified

#### Scenario: Text-model failure is distinguishable

- **WHEN** the TypeSafe question succeeds but the text-model completion is unreachable, unauthorized, or returns no valid `{"text"}` object
- **THEN** the failure names the text-model stage, the profile is not marked verified, and re-running after fixing only the text configuration is possible

### Requirement: Structured observation through `page_snapshot`

Before every decision, a TypeSafe run SHALL observe the target tab through the `page_snapshot` operation and use only that observation for the next decision. The observation SHALL contain, bounded and code-generated: the page URL, title, viewport and scroll position; an ordered element table of the currently visible, enabled interactive controls, each carrying a code-owned reference usable by existing tools, its role, accessible name, and current state (value, checked/selected/expanded, disabled, and options for native selects); a bounded extract of visible page text; and explicit truncation disclosure when the element count or text was cut. Elements SHALL be numbered for the decision request, and the mapping from an offered number to the code-owned reference SHALL exist only in host code, never in the model's answer.

#### Scenario: Observation reflects current state

- **WHEN** the run observes a page after a previous action changed a control's value or revealed new controls
- **THEN** the new snapshot reflects the current values and includes the newly visible controls, in the same reference space the existing browser tools resolve

#### Scenario: Bounded observation discloses omission

- **WHEN** a page holds more interactive elements or more text than the observation's bounds allow
- **THEN** the observation reports that it was truncated and how much was omitted, and no omitted element can be selected as an action target

#### Scenario: Observation failure

- **WHEN** the snapshot cannot be produced (for example the extension predates `page_snapshot`, the tab is gone, or the document is unreadable)
- **THEN** the run reports a named observation failure without dispatching any browser action and remains stoppable; it SHALL NOT silently substitute a different observation it cannot bound

### Requirement: Single-request decision protocol with strict validation

Each decision cycle SHALL issue exactly one `POST /v1/systemone` request to the configured TypeSafe endpoint carrying the user's goal, the bounded observation (page identity, element table, text, recent steps), and a `questions` object containing: one operation question whose criteria enumerate only the operations actually supported by the observation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`, with only the per-operation target questions that have at least one candidate), and one target question per offered operation presenting that operation's candidates with their labels, current values, and state. The prompt material for these questions SHALL instruct that page content is untrusted data and never instructions.

The response SHALL be validated before any use: the operation choice SHALL be one of the offered operations; the chosen operation's target head SHALL place its choice among that head's offered candidates; each head's probabilities SHALL cover exactly that head's candidate keys; probability and confidence values SHALL be finite numbers within [0, 1]; the probabilities SHALL sum to 1 within a small tolerance; and the declared choice SHALL be the maximum-probability candidate. A response failing any check SHALL be refused as an invalid decision with a distinguishable run failure, and no action SHALL be dispatched from it. Only the target head corresponding to the chosen operation may be consumed.

#### Scenario: Operation and target from one request

- **WHEN** the observation offers multiple operations and candidates
- **THEN** a single TypeSafe request returns both the operation and each offered operation's target distribution, and the executed action derives solely from the chosen operation's own head

#### Scenario: Invalid answer is refused

- **WHEN** the endpoint returns a 200 body that fails any validation rule above
- **THEN** no browser action is dispatched, the run reports an invalid-decision failure, and the invalid body never reaches execution

#### Scenario: Provider error during a decision

- **WHEN** the decision request fails with an authentication, rate-limit, timeout, or network error after the bounded retry policy for retryable statuses
- **THEN** the run ends with a named failure identifying the stage, and no action is dispatched

#### Scenario: Page content cannot steer the loop

- **WHEN** observed page text or an element label contains instructions, approvals, or model-directed text
- **THEN** it is treated only as decision input data, cannot mint approvals or alter configuration, and execution still passes the existing gates

### Requirement: Text values from the configured small model

An action whose operation is `TYPE_TEXT` SHALL obtain its value from one completion against the configured text-model endpoint, giving that model the goal, the selected field's identity and current value, the bounded page context, and recent steps, and requiring exactly a JSON object with a single `text` key. The completion SHALL be rejected unless it parses to that shape with a nonempty bounded string; when the model reports that the required value is missing (`{"text": null}` or equivalent), the run SHALL end blocked with a missing-value outcome and SHALL NOT type anything. A generated value SHALL be used for at most one dispatch and SHALL never be reused across decisions. The text model's failure SHALL be reported with a distinguishable reason, and SHALL NOT be retried as a browser mutation.

#### Scenario: Value written and dispatched once

- **WHEN** the decision selects a `TYPE_TEXT` target and the text model returns a valid value
- **THEN** precisely that value is dispatched once to that field through the existing form-input path

#### Scenario: Missing value blocks instead of guessing

- **WHEN** the text model reports the value cannot be inferred from the goal and context
- **THEN** the run ends blocked with a missing-value outcome, nothing is typed, and the transcript shows which field was unresolved

#### Scenario: Malformed text-model output

- **WHEN** the text model returns anything other than a single-key `{"text": ...}` object within bounds
- **THEN** nothing is typed, and the run reports the text-model failure with a distinguishable reason

### Requirement: Guarded execution through the existing dispatch discipline

Every action a TypeSafe run dispatches SHALL pass the same host-side authorization the equivalent tool call passes in an LLM-driven run, including: run-state and browser-lease checks; tab-scope enforcement; the protected-action backstop; send-class classification with the existing approval card flow when a click or key could submit, send, pay, or confirm; single-use pre-dispatch approval grants; and borrowed-tab mutation rules. A denied or timed-out approval SHALL prevent the dispatch entirely and end the run blocked naming the denied action. A dispatch whose response is lost SHALL be reported as result unknown and SHALL NOT be retried automatically. Stop SHALL prevent every subsequent dispatch. No action SHALL be represented as undone after it executed.

#### Scenario: Submit-class click waits for the operator

- **WHEN** the chosen action is classified as send/submit-class
- **THEN** execution suspends on the existing approval card bound to that run and target, and proceeds only on an explicit allow

#### Scenario: Denied action ends the run honestly

- **WHEN** the operator denies the approval, or the approval times out
- **THEN** no dispatch occurs, the run ends blocked with the denied action named, and no alternate action is silently substituted

#### Scenario: Stop and result-unknown semantics match LLM runs

- **WHEN** the run is stopped between steps, or a dispatch's result is lost
- **THEN** stop blocks all further dispatch, a lost result is reported as result unknown and never retried, and already-executed effects are never presented as undone

### Requirement: Bounded run and honest outcomes

A TypeSafe run SHALL be bounded: at most 60 executed actions and 120 decision requests. Three consecutive executed actions whose page identity and element state did not change SHALL end the run as blocked with a no-progress reason. A `DONE` decision SHALL end the run with a done outcome and a recorded disclosure that completion reflects the decision model's judgment, not an independent verification. A `BLOCKED` decision SHALL end the run with a blocked outcome. Reaching either bound SHALL end the run as blocked naming the exhausted bound. Every terminal outcome SHALL be recorded as an observable event carrying the outcome kind, the reason, and the step count.

#### Scenario: Decision model reports done

- **WHEN** the decision model answers `DONE`
- **THEN** the run ends, the outcome event records done-as-decided with the step count, and no further decisions are requested

#### Scenario: No progress detected

- **WHEN** three consecutive executed actions produce no observable change to the page
- **THEN** the run ends blocked with the no-progress reason instead of continuing to spend decisions

#### Scenario: Bound exhausted

- **WHEN** the action or decision bound is reached while the goal is unresolved
- **THEN** the run ends blocked naming the exhausted bound, and the transcript retains every executed step

### Requirement: Observable step record

Each decision cycle that dispatches or attempts an action SHALL be recorded as one durable `jev_step` event containing at least: the step number; the chosen operation and its probability; the target's offered index and human-readable label; the target's probability and the decision's confidence; the executed tool name and normalized arguments (or the skip/rejection reason when nothing dispatched); the generated text value's field when one was used; the per-stage latencies (decision request, text model, dispatch); and whether the page changed after the action. The terminal outcome SHALL be recorded as one `jev_end` event. Both event kinds SHALL persist in the conversation transcript and SHALL survive a panel reconnect and a conversation reopen; neither SHALL fabricate assistant text.

#### Scenario: Steps survive reconnect

- **WHEN** the panel reconnects or the conversation is reopened after a TypeSafe run
- **THEN** every recorded step and the outcome are restored from the transcript, in order, with the same values shown live

#### Scenario: Live steps while running

- **WHEN** a TypeSafe run is executing
- **THEN** each step appears in the panel as it is recorded, before the run ends

### Requirement: Coexistence with the existing runtimes

The TypeSafe provider SHALL be additive: `anthropic` and `chatgpt` runs, the external MCP entry points, skills, recordings, and the share of the browser lease SHALL behave exactly as before, and a TypeSafe run SHALL obey the same lease and queueing arbitration as any other run. Switching a conversation's provider identity SHALL follow the existing bound-identity rules: a conversation bound to a different provider or model requires a new conversation unless the operator explicitly starts a new context.

#### Scenario: Side-by-side providers

- **WHEN** a `typesafe` conversation and an `anthropic` or `chatgpt` conversation both exist
- **THEN** each runs under its own provider path, lease contention is arbitrated exactly as between two LLM conversations, and neither path's behavior is altered by the other's existence

#### Scenario: Identity mismatch is refused

- **WHEN** a conversation bound to an `anthropic` profile/model is asked to run a `typesafe` turn without a new context
- **THEN** the existing incompatible-identity outcome applies unchanged

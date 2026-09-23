## Purpose

Defines the `browser_subgoal` SDK tool that lets an LLM-driven (`anthropic`/`chatgpt`) run delegate one bounded natural-language interaction to a short Jev sub-run on the same tab, returning an unverified checkpoint the caller must inspect.

## ADDED Requirements

### Requirement: The browser_subgoal tool is offered only when Jev is configured

The runtime SHALL expose a `browser_subgoal` tool to an `anthropic` or `chatgpt` run only when that run's resolved profile carries complete Jev configuration backed by a separate Jev key: the decision source SHALL be the separate-key source (`typesafeDecisionSource === "openai"`) with its own base URL, model id and API key all present; and the Jev transport source, typesafe API key, text model and text-model API key SHALL all be present. The decision sources that reuse the operator's Anthropic key or a minted gateway token (`anthropic`, `chatgpt`) SHALL NOT satisfy the gate, because the runtime SHALL NOT substitute the Anthropic or Gateway key for Jev. When any required field is absent or the decision source is not the separate-key source, the tool SHALL NOT be registered for that run, and its absence SHALL raise no error, exception, warning or user-visible notice. A `typesafe` standalone run SHALL NOT offer `browser_subgoal` (it already is a Jev run).

#### Scenario: Configured profile offers the tool

- **WHEN** an `anthropic` or `chatgpt` run starts on a profile with a complete Jev configuration
- **THEN** `browser_subgoal` is present in that run's tool set alongside the existing browser tools

#### Scenario: Unconfigured profile silently omits the tool

- **WHEN** an `anthropic` or `chatgpt` run starts on a profile missing any Jev configuration field
- **THEN** `browser_subgoal` is absent from that run's tool set, no error is raised, and every other tool works as before

#### Scenario: A reused-key decision source does not satisfy the gate

- **WHEN** the profile's Jev decision source is `anthropic` or `chatgpt` (reusing the operator's Anthropic key or a gateway token)
- **THEN** `browser_subgoal` is not registered, no error is raised, and the Anthropic/Gateway key is never used for Jev

#### Scenario: Standalone Jev run does not offer it

- **WHEN** a `typesafe` run starts
- **THEN** `browser_subgoal` is not among its tools

### Requirement: The tool takes one goal and runs a bounded Jev sub-run on the shared run

`browser_subgoal` SHALL accept a single required `goal` string describing one bounded interaction outcome, and SHALL reject any input whose `goal` is missing, empty or not a string before starting a sub-run. A valid call SHALL start a Jev sub-run in subgoal mode on the caller run's bound tab, sharing the caller's browser lease, browser `toolBridge`, argument coercion, and `canUseTool` authorization path. The sub-run SHALL NOT create a new tab, borrow a different tab, or acquire a second lease. The sub-run's decisions SHALL come from the profile's configured Jev decision source; its TYPE_TEXT values SHALL come from the profile's configured Jev text model; and the operator-literal fast path SHALL apply, sourced from the tool's `goal` argument and not from the outer conversation.

#### Scenario: A subgoal drives the bound tab

- **WHEN** the LLM calls `browser_subgoal` with `goal: "click the Sign in button"`
- **THEN** a Jev sub-run selects and dispatches actions on the caller's bound tab through the shared toolBridge and authorization path

#### Scenario: Missing or empty goal is rejected

- **WHEN** the tool is called with no `goal`, an empty `goal`, or a non-string `goal`
- **THEN** no sub-run starts and the call returns a bounded validation failure

#### Scenario: A literal in the subgoal text types exactly

- **WHEN** the `goal` is a whole-prompt operator literal such as `set Email to "a@b.com"` and the field is uniquely eligible
- **THEN** the exact value is typed through the existing literal path, and no Jev text-model call is made for it

### Requirement: Every existing guard applies to the sub-run

A `browser_subgoal` sub-run SHALL pass every guard an ordinary dispatch passes: run-state, browser-lease, tab-scope, protected-action, borrowed-tab and send-class authorization; the existing approval cards and single-use grants; post-approval reobservation with document-nonce and target re-validation; single-dispatch consumption; stop precedence; and result-unknown termination. A send/submit-class action inside a subgoal SHALL suspend on the same approval card, bound to the same run, target and document, as it would outside a subgoal. Denied or timed-out approval SHALL end the subgoal blocked without an alternate action. Stop SHALL prevent further dispatch, and executed effects SHALL never be reported as undone.

#### Scenario: Submit-class action inside a subgoal waits for approval

- **WHEN** a subgoal selects a send/submit-class action
- **THEN** the existing approval card must allow it, refreshed state must still validate, and only then does it execute

#### Scenario: Denied approval ends the subgoal honestly

- **WHEN** approval is denied or times out during a subgoal
- **THEN** the subgoal ends blocked naming the action, with no dispatch or silent substitution

#### Scenario: Stop during a subgoal

- **WHEN** the run is stopped while a subgoal is executing or awaiting approval
- **THEN** no further action dispatches and any lost result is reported result-unknown, never retried or claimed undone

### Requirement: The tool returns an unverified checkpoint

`browser_subgoal` SHALL return a structured, unverified checkpoint: the observed URL and title after the sub-run, a bounded ordered summary of the actions Jev took (operation, target label and role, and outcome, with the typed value omitted for TYPE_TEXT), and the sub-run's terminal reason. The result SHALL be explicitly marked unverified, indicating the caller must inspect it before dependent actions and that final task verification is the caller's responsibility. Page-derived text in the checkpoint SHALL remain untrusted data and SHALL NOT grant authority or alter configuration. The checkpoint SHALL never assert task completion.

#### Scenario: A completed subgoal returns a checkpoint

- **WHEN** Jev ends a subgoal at DONE
- **THEN** the tool returns the observed page state and action summary marked unverified, not a task-success claim

#### Scenario: The typed value never appears

- **WHEN** a subgoal dispatched a TYPE_TEXT action
- **THEN** the returned summary names the field and operation but omits the typed value

#### Scenario: A blocked subgoal reports its reason

- **WHEN** a subgoal ends blocked (no progress, bound exhausted, denied approval, or ASK)
- **THEN** the tool returns the bounded named reason as an unverified checkpoint, and an ASK outcome is surfaced as needs-operator

### Requirement: Availability and failure are reported honestly

When Jev configuration is present but a sub-run cannot start or run — an invalid or rejected Jev key, a capability test that never passed, or a provider/transport failure — `browser_subgoal` SHALL return a bounded named failure and SHALL NOT return a fabricated success. The failure text SHALL be a host-authored classification and SHALL NOT echo raw provider secrets. A sub-run failure SHALL NOT crash or terminate the outer LLM run; the caller SHALL remain able to choose another action.

#### Scenario: Bad Jev key surfaces as a named failure

- **WHEN** the configured Jev key is rejected by its provider during a subgoal
- **THEN** the tool returns a bounded provider-failure result, the outer run continues, and no success is claimed

#### Scenario: Capability was never proven

- **WHEN** the profile's Jev capability test has not passed
- **THEN** the tool returns a bounded unavailable result rather than attempting an unproven transport

### Requirement: Subgoal steps are observable and attributed

A `browser_subgoal` sub-run SHALL emit the existing durable `jev_step` and `jev_end` records for its decisions and outcome, distinguishable in the transcript as belonging to a subgoal rather than a standalone `typesafe` run, and the outer LLM run's tool-call record SHALL reference the subgoal's outcome. These records SHALL preserve target, action and outcome observability, SHALL NOT fabricate assistant text, and SHALL persist across reconnect/reopen like other run records.

#### Scenario: Subgoal steps render distinctly

- **WHEN** a subgoal runs within an `anthropic`/`chatgpt` task
- **THEN** its `jev_step`/`jev_end` records appear attributed to the subgoal, and the tool call that launched it references the outcome

#### Scenario: Records survive reconnect

- **WHEN** the panel reconnects after a subgoal ran
- **THEN** the subgoal's step and end records retain their values and order

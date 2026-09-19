# typesafe-jev-provider Specification

## Purpose
Adds a TypeSafe (Jev) provider that drives browser tasks through structured choice questions — an atomic page snapshot, one decision request per step, and small-model text values — alongside the existing LLM runtime, under the same confinement, approval, and recovery guarantees.

## Requirements

### Requirement: Provider type and configuration surface

A provider profile SHALL support a third provider type, `typesafe`, alongside `anthropic` and `chatgpt`. Selecting it in Settings SHALL expose the TypeSafe credential (for the selected Jev source), the text-model configuration (base URL, model ID, credential), the profile's editable model list with exactly one default model, a screenshot toggle that is enabled by default, and an editable endpoint field for the provider's own requests — prefilled with the profile's current endpoint and labeled with the selected Jev source; it SHALL NOT expose Base URL or API-key fields for an Anthropic endpoint. The provider-type choice and the provider's own settings section SHALL label the Jev integration as beta, stating that its behavior, quality, and results may change between releases. Switching a profile's provider type SHALL remain nondestructive to the other fields, and SHALL reject any value that is not a known provider type.

When a `typesafe` profile's model list is empty at the moment the provider type is selected, settings SHALL seed it with the provider's documented `jev-latest` entry; an existing or user-edited list SHALL never be overwritten. The text-model base URL and text-model ID SHALL be required, nonempty settings before a run or a capability test is attempted, and SHALL be validated as a well-formed HTTPS URL (loopback HTTP permitted under the existing URL rules). The screenshot toggle SHALL persist with the profile as a non-secret setting, and a profile stored before the toggle existed SHALL load with it enabled. The endpoint SHALL be validated under the same URL rules, persisted with the profile, and used by every request the provider makes; a change of Jev source SHALL move it to the new source's documented default (`https://api.typesafe.ai` for TypeSafe API, `https://ai-gateway.vercel.sh` for Vercel AI Gateway) only while it is still a known default, and SHALL leave any other endpoint untouched — reachable for editing under its own label rather than hidden.

#### Scenario: Switching to the TypeSafe provider

- **WHEN** the user selects the `typesafe` provider type in Settings
- **THEN** the Anthropic Base URL and API-key fields are hidden, the TypeSafe credential, text-model fields, the enabled screenshot toggle, and the endpoint field carrying the profile's current endpoint are shown, and an empty model list is seeded with `jev-latest` exactly once

#### Scenario: The beta status is disclosed

- **WHEN** the operator views the provider-type choice, or the `typesafe` provider's own section in Settings
- **THEN** the Jev — ultrafast integration is labeled as beta there, stating that its behavior and results may change between releases

#### Scenario: Existing profiles are unaffected

- **WHEN** a profile of type `anthropic` or `chatgpt` is loaded or used after this change
- **THEN** its provider type, fields, credentials, capability results, and run behavior are unchanged

#### Scenario: Invalid provider type value

- **WHEN** a caller attempts to persist a provider type that is not `anthropic`, `chatgpt`, or `typesafe`
- **THEN** the change is rejected and no profile is written

#### Scenario: The screenshot toggle defaults on for existing profiles

- **WHEN** a `typesafe` profile stored before the toggle existed is loaded
- **THEN** the toggle shows enabled and its runs capture the bound tab as if it had been set

#### Scenario: The endpoint is editable

- **WHEN** the operator edits the endpoint field on a `typesafe` profile — including an endpoint carried over as a custom URL from another provider type — to a valid URL and saves
- **THEN** the profile persists it, subsequent capability tests and runs issue their provider requests against exactly that endpoint, and a source change no longer strands it

### Requirement: Credential and configuration storage for the TypeSafe provider

The TypeSafe API key and the text-model API key SHALL be stored by the native companion in the OS credential store as one secret record under a per-profile target (`browzy-in-chrome/typesafe/<profileId>`), separate from the `anthropic` credential target and the `chatgpt` refresh-token target. Neither key SHALL ever appear in extension storage, page scripts, profile files, logs, exported settings, or the SDK environment. The settings UI SHALL accept each key write-only, SHALL clear submitted raw values, and SHALL report only whether each key is saved. A secret that does not fit the OS credential store's size limit SHALL fail with the existing `SECRET_TOO_LARGE` outcome and SHALL NOT be truncated. Removing the credential SHALL bump the credential revision, cancel active runs using it, and require re-entry before another TypeSafe request.

#### Scenario: Keys never leave the companion

- **WHEN** settings are exported, diagnostics are viewed, or a run's environment is constructed
- **THEN** neither the TypeSafe API key nor the text-model API key appears in the output

#### Scenario: Credential removal during a run

- **WHEN** the stored TypeSafe credential is removed while a TypeSafe run is active
- **THEN** the run is stopped through the existing revocation path and a later run requires the credential again

### Requirement: TypeSafe capability test

The capability test for a `typesafe` profile SHALL issue one decision request through its configured supported Jev transport with the same `action`, `goal_done`, and `stuck` Choice heads and strict response validation used by the runtime. It SHALL separately test the configured text model with a minimal single-`text` JSON completion and an embedded-image completion. Results SHALL be recorded for the exact endpoint/model/credential revision tested; changes invalidate the result. Each stage SHALL report separately. Image failure SHALL NOT decide runnability when the other stages pass, allowing screenshots to be disabled. Existing actionable error codes and `INVALID_RESPONSE` for malformed successful responses SHALL remain, and neither credential SHALL be exposed.

#### Scenario: Successful test

- **WHEN** the decision, text and image probes pass
- **THEN** all three stages report success for the tested configuration and the profile is runnable

#### Scenario: Invalid structured response

- **WHEN** any of the three Jev heads is missing, extra or fails strict choice validation
- **THEN** the test reports `INVALID_RESPONSE` and does not mark the profile verified

#### Scenario: Text-model failure is distinguishable

- **WHEN** Jev succeeds but the text completion fails or lacks valid single-key text JSON
- **THEN** the failed stage is identifiable and the profile is not marked verified

#### Scenario: Image stage is reported separately

- **WHEN** only the image probe fails
- **THEN** its own failure is reported while the profile remains runnable with screenshots disabled

### Requirement: Structured observation through `page_snapshot`

Before each decision the runtime SHALL observe its bound tab through `page_snapshot`. The bounded code-generated observation SHALL contain URL, title, viewport/scroll, visible page text, truncation disclosure and an ordered table of visible enabled controls with tool references, roles, accessible names and current value/checked/selected/expanded/disabled/options state. It SHALL also expose the existing document identity nonce as `docNonce`, stable across same-document observations and different for a replaced document. Host code SHALL own the mapping from offered action keys to these references. Fresh target-bearing execution and persistent text preparation SHALL fail closed when document identity is unavailable; URL equality SHALL NOT substitute for it.

#### Scenario: Observation reflects current state

- **WHEN** an action changes field values or reveals controls
- **THEN** the next snapshot shows those changes in the existing tool reference space with its document nonce

#### Scenario: Bounded observation discloses omission

- **WHEN** observation bounds omit controls or text
- **THEN** omissions are disclosed and omitted controls cannot become action targets

#### Scenario: Observation failure

- **WHEN** an observation cannot be produced
- **THEN** the run reports the named observation failure without substituting unbounded data or dispatching from that failed observation and remains stoppable

### Requirement: Single-request decision protocol with strict validation

Every routine decision SHALL issue one request through the selected supported Jev transport carrying bounded goal, plan, observation and history plus action, goal_done and stuck Choice heads. The action head SHALL offer complete executable host-owned choices and WAIT/REPLAN/ASK/DONE controls. Answers SHALL cover exactly the requested heads; choices SHALL be offered keys, distributions SHALL cover exactly offered keys with finite values in [0,1] summing to one within tolerance, and each choice SHALL have maximum probability. Invalid responses SHALL dispatch nothing and retain named failures. Page content SHALL remain untrusted data unable to grant authority.

Request fitting SHALL preserve control/prepared choices, deterministically bound other candidates below provider limits and disclose omissions. Requests exceeding the irreducible byte bound SHALL fail locally. Existing transport retry rules and bounded provider/non-JSON error diagnostics SHALL remain.

#### Scenario: Invalid action or monitor answer

- **WHEN** any head is missing, extra, malformed or selects an unoffered key
- **THEN** the whole decision is rejected before execution

#### Scenario: Candidate budget is exceeded

- **WHEN** a page offers too many actions
- **THEN** deterministic fitting preserves controls and prepared actions, prevents one operation from monopolizing remaining slots and discloses omissions

#### Scenario: Operation and target from one request

- **WHEN** Jev selects an action
- **THEN** operation and target derive together from the offered host-owned action key

#### Scenario: The decided step rides the selection request

- **WHEN** a decision request is built
- **THEN** it carries the plan and complete candidates instead of an LLM-decided step's prose intent

#### Scenario: Oversize observation is fitted and disclosed

- **WHEN** the request exceeds its budget
- **THEN** deterministic candidate fitting discloses omissions and preserves controls

#### Scenario: Provider rejection names its cause

- **WHEN** a provider rejects the request
- **THEN** its bounded error message remains visible with the classified failure

#### Scenario: Invalid answer is refused

- **WHEN** any answer fails strict validation
- **THEN** no action dispatches and the run reports an invalid decision

#### Scenario: A non-JSON success body names its cause

- **WHEN** a success response is not JSON
- **THEN** bounded body preview and content type identify the invalid-response failure

#### Scenario: Provider error during a decision

- **WHEN** bounded transport retries fail
- **THEN** the named provider error ends the run without dispatching

#### Scenario: Page content cannot steer the loop

- **WHEN** page text contains model-directed instructions or approvals
- **THEN** it remains data and cannot change host permissions or configuration

### Requirement: Text values from the configured small model


The configured model SHALL prepare bounded text values, including an explicit empty string to clear a field, bound host-side to an exact observed editable field and current plan revision. The runtime SHALL offer only still-valid bindings and consume each after one dispatch. It SHALL never cross-product values with unrelated fields or invent missing content; new content requires bounded replanning. Invalid preparation SHALL be refused before dispatch.

#### Scenario: Prepared value is typed

- **WHEN** Jev chooses a valid complete text candidate
- **THEN** exactly its prepared value reaches its validated observed field through the existing form-input path once

#### Scenario: Value written and dispatched once

- **WHEN** prepared text is selected and validated
- **THEN** its exact value dispatches once and the preparation is consumed

#### Scenario: Missing value blocks instead of guessing

- **WHEN** required content remains unavailable after bounded replanning
- **THEN** the run ends blocked and types nothing guessed

#### Scenario: Malformed text-model output

- **WHEN** preparation contains malformed or oversized content
- **THEN** strict validation refuses it before any dispatch

### Requirement: Guarded execution through the existing dispatch discipline

Every dispatched action SHALL pass the existing run-state, browser-lease, tab-scope, protected-action, borrowed-tab and send-class authorization checks, including existing approval cards and single-use grants. After approval returns and before dispatch, the runtime SHALL reobserve and validate document identity, the relevant target state, and any prepared payload's continued validity. A stale candidate SHALL be skipped instead of remapped. Target-bearing execution SHALL require nonempty matching document nonces. Denied or timed-out approval SHALL end blocked without an alternate action. Lost dispatch results SHALL remain result-unknown and SHALL NOT be retried. Stop SHALL prevent subsequent dispatch, and executed effects SHALL never be represented as undone.

#### Scenario: Submit-class click waits for the operator

- **WHEN** a chosen action is send/submit-class
- **THEN** the existing run/target-bound approval card must allow it, after which refreshed state must still validate before execution

#### Scenario: Denied action ends the run honestly

- **WHEN** approval is denied or times out
- **THEN** the run ends blocked naming the action and no dispatch or silent substitution occurs

#### Scenario: Stop and result-unknown semantics match LLM runs

- **WHEN** the run stops during a decision or approval wait, or a dispatched result is lost
- **THEN** stop prevents further dispatch and lost results are reported without retrying or pretending to undo effects

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

The runtime SHALL preserve its existing action/decision limits, stop precedence, repeated-click protection, scroll/no-progress guards, bounded recovery, permission gates and result-unknown termination. WAIT, REPLAN and monitor-triggered consultations SHALL not reset global limits. ASK SHALL end blocked with needsOperator. Every terminal path SHALL emit its durable outcome and named reason.

DONE or a positive completion monitor SHALL require the existing configured-model completion check using available goal, plan, observations and optional screenshot. A confirming check SHALL preserve report/source consultation behavior and mark done verified. A rejecting check SHALL revise guidance and continue only within the existing rejection bound. A failed, malformed or unavailable check SHALL end blocked completion-unverified, never successful done. Reports SHALL distinguish observed results, unavailable material and suggestions without invention.

#### Scenario: Completion verification fails

- **WHEN** the completion checker times out, returns malformed data or cannot verify completion
- **THEN** the outcome is blocked completion-unverified and no successful completion is claimed

#### Scenario: Completion requires source consultation

- **WHEN** the completion check requests allowed supporting sources
- **THEN** bounded source fetching and report generation remain available and the report states limitations honestly

#### Scenario: Decision model reports done

- **WHEN** Jev selects DONE
- **THEN** completion verification is required before successful termination

#### Scenario: A done run ends with its result report

- **WHEN** verification confirms completion and a report is available
- **THEN** the run shows the grounded report and verified completion

#### Scenario: The result report cannot be produced

- **WHEN** completion cannot produce its required usable report
- **THEN** the failure remains visible and no unverified success is claimed

#### Scenario: The completion check cannot be made

- **WHEN** completion checking fails or is unreachable
- **THEN** the run ends blocked completion-unverified rather than done

#### Scenario: A rejected done claim continues the run

- **WHEN** verification rejects completion within its bound
- **THEN** updated guidance permits another bounded cycle

#### Scenario: Repeated rejection ends honestly

- **WHEN** completion rejection reaches its limit
- **THEN** the run ends blocked completion-unverified

#### Scenario: An analysis goal can finish with what was gathered

- **WHEN** available evidence supports the requested analysis
- **THEN** verification may confirm a report that clearly names unavailable material as a limitation

#### Scenario: Scroll-only steps trip the stall guard

- **WHEN** consecutive scrolls reach the existing scroll-only bound
- **THEN** bounded recovery or blocked no-progress applies, including the existing post-recovery scroll restriction

#### Scenario: No progress detected

- **WHEN** unchanged actions or repeated ineffective clicks reach existing limits
- **THEN** bounded recovery or blocked no-progress prevents churn

#### Scenario: Recovery finds a way forward

- **WHEN** a permitted recovery supplies revised guidance and required content
- **THEN** the run can continue without resetting global budgets

#### Scenario: Bound exhausted

- **WHEN** an action, decision or replan bound is exhausted
- **THEN** the run ends blocked with its named exhausted bound

### Requirement: Observable step record

Every attempted, executed or skipped decision SHALL produce a durable `jev_step` carrying its operation, offered action key, `decisionSource: "jev"`, action probability/confidence, independent goalDone/stuck monitor data, plan revision, available target label/role, executed tool and bounded argument summary or skip/rejection reason, applicable per-stage latencies and page-change status. Probability SHALL be attributed to the complete Jev action rather than an LLM operation or target-only guess. Completion checks SHALL record confirmed, rejected or unavailable outcomes; rejected claims SHALL be skips, not completions. Successful plan/revision/recovery updates SHALL emit durable `jev_memory` events. Exactly one `jev_end` SHALL record the outcome and reason, including `needsOperator` for ASK. New successful done outcomes SHALL require verified completion. Prior records, including legacy unverified outcomes, SHALL still render faithfully. Events SHALL persist across reconnect/reopen and SHALL NOT fabricate assistant text.

#### Scenario: Steps survive reconnect

- **WHEN** the panel reconnects or the conversation reopens
- **THEN** recorded steps and outcomes retain their original values and order

#### Scenario: Memory and verification survive reconnect

- **WHEN** recorded memory and completion checks are restored
- **THEN** their verification status, including legacy records, appears in order without duplication

#### Scenario: Live steps while running

- **WHEN** a decision is recorded during execution
- **THEN** its correctly attributed step becomes visible before the run ends

#### Scenario: Live memory while running

- **WHEN** a successful preparation or revision emits memory
- **THEN** it appears in the current turn immediately

### Requirement: Coexistence with the existing runtimes

The TypeSafe provider SHALL be additive: `anthropic` and `chatgpt` runs, the external MCP entry points, skills, recordings, and the share of the browser lease SHALL behave exactly as before, and a TypeSafe run SHALL obey the same lease and queueing arbitration as any other run. Switching a conversation's provider identity SHALL follow the existing bound-identity rules: a conversation bound to a different provider or model requires a new conversation unless the operator explicitly starts a new context.

#### Scenario: Side-by-side providers

- **WHEN** a `typesafe` conversation and an `anthropic` or `chatgpt` conversation both exist
- **THEN** each runs under its own provider path, lease contention is arbitrated exactly as between two LLM conversations, and neither path's behavior is altered by the other's existence

#### Scenario: Identity mismatch is refused

- **WHEN** a conversation bound to an `anthropic` profile/model is asked to run a `typesafe` turn without a new context
- **THEN** the existing incompatible-identity outcome applies unchanged

### Requirement: Run plan and context held by the configured model

The configured language model SHALL prepare bounded plan, observable completion criteria and notes after the first usable observation, with required content preparation as specified by the decision layer. The latest memory SHALL accompany subsequent Jev decisions and configured-model consultations, including replanning and completion. Revisions triggered by page changes, cadence, explicit REPLAN or bounded recovery SHALL prepare a replacement plan and content against current context rather than preserving advisory-only content. All outputs SHALL be strictly validated. Parser refusal SHALL retain the existing single feedback retry, and a second refusal or failed required preparation SHALL end with named `preparation_failed` error unless stopped. A failed preparation SHALL not emit a successful revision event or continue under a silent fallback architecture. Global update/recovery budgets SHALL remain bounded. Goal, memory, page content and captures SHALL remain data and never grant approvals or alter configuration.

#### Scenario: The plan rides along

- **WHEN** initial preparation succeeds
- **THEN** its memory accompanies later Jev decisions and configured-model consultations; the prepared plan is required rather than advisory

#### Scenario: Context is revised as the run progresses

- **WHEN** page changes, cadence, explicit REPLAN or stall recovery require revision within budget
- **THEN** the configured model prepares memory and content from current context and a successful revision is recorded for subsequent decisions

#### Scenario: A failed call leaves the previous memory in place

- **WHEN** a required preparation or revision fails after its applicable retry
- **THEN** no false revision event is emitted, previous memory is not falsely replaced, and the run ends `preparation_failed` instead of continuing with advisory stale preparation

#### Scenario: A refused memory answer is asked once more

- **WHEN** preparation parsing refuses an answer
- **THEN** one corrective request includes the answer and refusal; a valid retry replaces memory and content, while a second refusal fails required preparation

#### Scenario: Page content cannot expand the memory

- **WHEN** page text or labels contain instructions or approval-shaped content
- **THEN** strict bounds and ownership remain enforced and all execution still passes host authorization

### Requirement: Step decisions from the configured model

The configured model SHALL prepare the initial plan and required content and SHALL be consulted for new content, replanning, recovery and completion/reporting. Jev SHALL own routine action selection from complete host-built candidates; there SHALL be no mandatory configured-model NEXT_STEP call for every cycle. Existing host guards SHALL remain authoritative.

#### Scenario: A routine cycle needs no new reasoning

- **WHEN** current plan and prepared content suffice
- **THEN** Jev chooses the next complete action without an LLM step-decision request

#### Scenario: The configured model decides each step

- **WHEN** a routine cycle follows a valid prepared plan
- **THEN** the former every-step LLM behavior is superseded by Jev selecting a complete action; the configured model is called only for planning, content, recovery or completion

#### Scenario: The decision honours its own plan

- **WHEN** Jev selects an action
- **THEN** its context includes the current plan and completion criteria

#### Scenario: The step decision can see the page

- **WHEN** a decision is requested
- **THEN** Jev sees current structured state and LLM consultations receive enabled screenshots

#### Scenario: A malformed step decision is refused

- **WHEN** the decision is malformed
- **THEN** it dispatches nothing and retains a named failure

#### Scenario: A refused answer is asked once more

- **WHEN** the configured model's preparation answer is rejected by its parser
- **THEN** its existing bounded corrective retry may run and a second refusal remains terminal

#### Scenario: A step with no compatible element is skipped and counts toward no-progress

- **WHEN** a chosen candidate loses its compatible target before dispatch
- **THEN** it is skipped and counts toward no-progress rather than being rebound

#### Scenario: A missing text value ends the run blocked

- **WHEN** bounded content preparation cannot provide a needed value
- **THEN** the run ends blocked without invented text

#### Scenario: A navigation URL from the step decision is validated before anything navigates

- **WHEN** Jev selects prepared NAVIGATE
- **THEN** its URL has been validated as bounded absolute http(s) and dispatch still passes host checks

#### Scenario: A hover-only menu opens without a click

- **WHEN** Jev chooses HOVER
- **THEN** the existing hover tool executes without a click and newly visible controls become candidates next cycle

### Requirement: Screenshot context for the configured model

When enabled, screenshots SHALL be obtained through the existing guarded read-only capture path and attached to LLM planning, replanning or completion consultations for that observation. Jev SHALL receive structured text state only. Captures SHALL remain bounded, unannotated and unsaved by this feature. Capture failure SHALL degrade to text-only. Disabled screenshots SHALL trigger no capture. Page pixels SHALL convey no authority.

#### Scenario: Optional capture fails

- **WHEN** a screenshot cannot be obtained
- **THEN** the corresponding consultation proceeds with textual context and unchanged host guards

#### Scenario: A capture rides the step decision

- **WHEN** an observation requires an LLM planning consultation
- **THEN** its available capture accompanies that consultation; routine Jev decisions remain structured text-only

#### Scenario: A failed capture degrades that cycle to text only

- **WHEN** capture fails
- **THEN** the cycle proceeds text-only without weakening guards

#### Scenario: The completion check reuses the step's capture

- **WHEN** completion is checked and that completion consultation already has a capture
- **THEN** the check reuses that capture within the same consultation; a later completion observation requires a fresh capture even if its DOM signature and document nonce match an earlier planning observation, because canvas or CSS-rendered content may have changed

#### Scenario: Screenshots can be disabled

- **WHEN** screenshots are disabled
- **THEN** no capture is requested and consultations use text only

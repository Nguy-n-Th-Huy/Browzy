# typesafe-jev-provider delta

> Archive order matters: this delta is written against the spec as it stands
> once `improve-jev-step-reasoning` and `jev-runs-answer-the-operator` have
> landed, because it builds on the element table and the evaluation field those
> changes add. Rebase it onto the spec if they archive after this one.

## MODIFIED Requirements

### Requirement: Step decisions from the configured model

Every step the run executes SHALL come from the configured model as one strictly validated decision, made after the current observation and carrying the goal, the run memory/context when present, the conversation's earlier turns when any, the page identity and bounded text, a bounded projection of the observation's element table, the recent steps with their outcomes, and — when screenshots are enabled and the cycle's capture succeeded — the current page capture, attached in whatever image form the decision-model source's transport takes.

The element-table projection SHALL present, for each observed element the run could operate, its 1-based index in the observation, its tag or role, its bounded label, its bounded current value, its state where the observation carries it, and the observation's own newly-appeared marking. It SHALL NOT carry a `ref`, a selector, a coordinate, or any other execution handle. It SHALL be fitted to the decision request's own size budget by dropping elements deterministically from the tail, and a fitted table SHALL disclose within the context how many elements were omitted — an omission meaning that more of the page exists to be reached, never that the goal is unreachable. An element the fitted table does not show SHALL NOT be addressable in that cycle.

The decision SHALL name an operation from the run's vocabulary (`CLICK`, `TYPE_TEXT`, `SELECT`, `HOVER`, `NAVIGATE`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`). For `CLICK`, `TYPE_TEXT`, `SELECT`, and `HOVER` it SHALL name **the element it chose, by the offered key of the table it was given** — an index for a control, and the composite `<index>:<option>` key for a `SELECT`'s control and option. It SHALL NOT describe the element in prose, and the run SHALL NOT ask any other model which element a description refers to: the decision model is looking at the table while it decides, so the key it returns is the choice itself rather than a reconstruction of it.

An offered key is the only executable thing a model answer may carry. The mapping from a key to the code-owned element reference SHALL exist only in host code, built from the same observation the decision was made on, and SHALL be applied only after the decision passes validation. A decision whose element field carries a reference, a selector, a coordinate, a script, or anything else that is not an offered key of that observation SHALL be refused as a malformed decision, and nothing SHALL be dispatched from it.

The decision SHALL additionally carry a bounded `evaluation`: in plain language, what the previous action was meant to achieve and whether the current observation shows that it did; for the first decision of a run it SHALL state the starting position instead. The evaluation SHALL be required, bounded, recorded on the step, and never interpreted, merged, or rewritten by the host.

The request that carries the decision SHALL be sent with a deliberate reasoning budget: the decision-class calls (the step decision, the run plan, memory revisions, stall recovery, the completion check, and the final report) SHALL enable the configured source's reasoning or thinking control rather than disabling or minimising it, and the step decision's output budget SHALL hold a complete answer including its evaluation. Where a source returns its reasoning in a channel or block type of its own beside the answer, the run SHALL read only the answer channel and SHALL NOT treat reasoning content as the answer or carry it into a later request.

A decision that is not exactly the required shape — a missing field, a wrong type, a value outside its bound, an unknown operation, or an unrecognized key — SHALL be refused as an invalid decision, and nothing SHALL be dispatched from it. An answer the decision's own validation refuses SHALL be asked again exactly once, carrying the refused answer and the refusal back as feedback; only a second refusal is acted on: a second malformed decision ends the run with a named invalid-decision failure, a second answer without a usable value ends the run blocked with a missing-value outcome, and a second invalid URL is the named failure that navigates nothing.

A well-formed decision whose named key is not offered by the current observation — an index the fitted table does not contain, an element that cannot take the decided operation, or a `SELECT` option the control does not offer — SHALL NOT end the run: it SHALL be recorded as a skipped step with a target-unresolved reason, count toward the no-progress bound, and let the loop continue with the skip visible in the recent steps. A `TYPE_TEXT` decision whose value is missing SHALL type nothing, and once its one feedback retry has not produced a usable value the run SHALL end blocked with a missing-value outcome. A `DONE` decision SHALL go through the completion check before any done outcome; a `BLOCKED` decision SHALL end the run blocked, with the operator-needed reason when it says the operator is the one who can resolve it. `SCROLL_*` and `WAIT` decisions need no element and SHALL dispatch through the existing computer actions on the guarded path. A `HOVER` decision SHALL move the pointer over the named element without clicking it, so a menu or tooltip that opens only while the pointer rests on it can be opened before a later step operates one of its items. The decision SHALL follow the run memory's own plan and notes: it SHALL NOT repeat an action those notes call ineffective, it SHALL choose the control the notes name for the next step, and when what the goal needs cannot be obtained from the current page with the available operations it SHALL choose `BLOCKED` naming that reason; when the goal asks for information or analysis and the gathered material is sufficient, it SHALL choose `DONE`.

The recent steps carried to the decision SHALL describe outcomes, not intentions: each row SHALL carry the operation, the bounded label of the element actually operated where one was, the step's text value where it had one, whether the observation changed after it, and whether the step was executed, skipped with its reason, or denied at the gate.

#### Scenario: The decision names its own element

- **WHEN** a step decision chooses a `CLICK`, `TYPE_TEXT`, `SELECT`, or `HOVER`
- **THEN** it returns the offered key of the element from the table it was given, no prose description of that element is produced, and no further model is asked which element was meant

#### Scenario: A SELECT names the control and the option together

- **WHEN** the decided operation is `SELECT`
- **THEN** the decision names the composite `<index>:<option>` key the observation offered, and an option the control does not offer is refused as unoffered rather than resolved to a nearby one

#### Scenario: Only an offered key is executable

- **WHEN** a decision's element field carries a code-owned reference, a selector, a CSS path, a coordinate, or a script
- **THEN** the decision is refused as malformed, nothing is dispatched, and the key-to-reference mapping — which exists only in host code, for the observation the decision was made on — is never consulted for it

#### Scenario: A key the observation does not offer is skipped, not resolved

- **WHEN** the decision names an index the fitted table does not contain, or an element that cannot take the decided operation
- **THEN** the step is recorded skipped with the target-unresolved reason, counts toward the no-progress bound, nothing is dispatched, and the loop continues with the skip visible in the recent steps

#### Scenario: The decision is made against the observed controls

- **WHEN** a step decision is requested
- **THEN** its context carries the bounded element-table projection of the current observation, without any execution handle, and a table fitted to the size budget discloses the number of elements omitted

#### Scenario: No offered control can advance the goal

- **WHEN** the projected element table contains no control that can advance the goal from the current page
- **THEN** the decision chooses a scroll, a wait, a navigation, or `BLOCKED`, and does not name a control the observation does not contain

#### Scenario: Each step evaluates the one before it

- **WHEN** a step decision follows an executed, skipped, or denied step
- **THEN** its answer carries a bounded evaluation of what that step was meant to achieve and whether the current observation shows it did, the evaluation is recorded on the step, and an answer without it is refused like any other malformed decision

#### Scenario: The decision call is allowed to reason

- **WHEN** a decision-class request is sent to the configured source
- **THEN** it enables that source's reasoning or thinking control rather than disabling or minimising it, and the step decision's output budget holds a complete answer including its evaluation

#### Scenario: Recent steps describe what happened

- **WHEN** the recent-step rows are projected into a decision request
- **THEN** each row states the operation, the element actually operated where there was one, whether the observation changed, and whether the step was executed, skipped with its reason, or denied

#### Scenario: The decision honours its own plan

- **WHEN** the run memory's notes state that an action is ineffective or name the control the next step requires
- **THEN** the next step decision chooses accordingly — the named control, or `BLOCKED` naming why what the goal needs is unobtainable — and never repeats the action its notes call ineffective

#### Scenario: The step decision can see the page

- **WHEN** screenshots are enabled and the cycle captured the tab
- **THEN** the step decision is made with the capture attached beside the textual context, and its strict output validation is unchanged

#### Scenario: A malformed step decision is refused

- **WHEN** the step decision answer is missing a required field, carries a wrong type or an oversize value, names an unknown operation, or contains an unrecognized key
- **THEN** the answer is asked again exactly once with the refusal carried back as feedback; a second malformed answer dispatches nothing and ends the run with a named invalid-decision failure

#### Scenario: A refused answer is asked once more

- **WHEN** the step decision's answer is refused by its own validation — a malformed shape, a missing evaluation, a missing text value, or an invalid URL
- **THEN** exactly one further request carries the refused answer and the refusal back as feedback, and the second answer is validated and acted on like any first answer; only its refusal is terminal

#### Scenario: A missing text value ends the run blocked

- **WHEN** the step decision is `TYPE_TEXT` and its value is absent or null, and the one feedback retry produces no usable value either
- **THEN** the run ends blocked with a missing-value outcome and nothing is typed

#### Scenario: A navigation URL from the step decision is validated before anything navigates

- **WHEN** the step decision is `NAVIGATE`
- **THEN** the carried URL is accepted only as an absolute `http(s)` URL inside its bound, dispatches exactly once through the registered `navigate` operation, and appears in the step record; a missing URL ends the run blocked naming the missing value, and an invalid URL is a named failure that navigates nothing

#### Scenario: A hover-only menu opens without a click

- **WHEN** a control's menu or tooltip appears only while the pointer rests on it and a click leaves it closed
- **THEN** the step decision can name that control with `HOVER`, the dispatch moves the pointer over it without clicking, and a later step can operate an item the menu then offers

### Requirement: Single-request decision protocol with strict validation

Jev speaks its own decision protocol — a `state` and a `questions` object answered as a typed structured decision — and SHALL NOT be reached through any chat-completion or Messages endpoint; a source whose general-purpose ports refuse the model SHALL be reached only through its own decision route. The supported sources SHALL be: TypeSafe's own `POST {endpoint}/v1/systemone`; the Vercel AI Gateway's `POST {endpoint}/v4/ai/evaluation-model`, whose protocol headers carry the model and whose answers report confidence in the response's provider metadata; and OpenRouter's `POST {endpoint}/api/alpha/decisions`, carrying the model id in the body beside the same `state` and `questions`. Every source SHALL end in exactly one decision of the same validated shape, SHALL share one retry policy and one failure taxonomy, and SHALL be selectable per profile with its own credential and its own documented default endpoint. A source whose route is published as alpha SHALL be labeled as such where it is selected, and a protocol change on any source SHALL surface as a loud, named capability or decision failure rather than a silently degraded decision.

A run's step path SHALL make no Jev request: the element a step operates is named by the step decision itself (see "Step decisions from the configured model"), so no request is issued to resolve it. The provider's own requests are those the profile's capability test makes.

Any Jev response this provider accepts SHALL be validated before any use: the choice SHALL be one of the offered candidates; the head's probabilities SHALL cover exactly its candidate keys; probability and confidence values SHALL be finite numbers within [0, 1]; the probabilities SHALL sum to 1 within a small tolerance; and the declared choice SHALL be the maximum-probability candidate. A response failing any check SHALL be refused with a distinguishable failure, and nothing SHALL be acted on from it. When the provider rejects a request, its own error message SHALL be surfaced with the failure so the cause is attributable rather than presented as a bare status. A success response whose body cannot be parsed as JSON SHALL likewise be reported with the response's content type and a bounded preview of the body's beginning, so a misrouted request is attributable from the failure itself.

#### Scenario: The step path issues no Jev request

- **WHEN** a run executes a target-bearing step
- **THEN** the element comes from the step decision's own offered key, no request is made to the Jev endpoint for that step, and the run's provider requests for the cycle are exactly the decision-class calls it already makes

#### Scenario: Each Jev source uses its own decision route

- **WHEN** a profile selects the TypeSafe, Vercel AI Gateway, or OpenRouter Jev source and a request is made to it
- **THEN** the request goes to that source's own decision route with that source's credential and body shape, never to a chat-completion or Messages endpoint, and the validated decision shape, retry policy, and failure taxonomy are identical across sources

#### Scenario: Invalid answer is refused

- **WHEN** the endpoint returns a 200 body that fails any validation rule above
- **THEN** nothing is acted on, the failure is reported distinguishably, and the invalid body never reaches execution

#### Scenario: Provider rejection names its cause

- **WHEN** the endpoint answers a non-2xx with a body carrying its own error message
- **THEN** the reported failure includes that message, so an input-size rejection is distinguishable from an authentication or availability failure

#### Scenario: A non-JSON success body names its cause

- **WHEN** a 2xx response body cannot be parsed as JSON
- **THEN** the reported failure includes the response's content type and a bounded preview of the body's beginning, and keeps the same invalid-response classification as any unreadable body

#### Scenario: Page content cannot steer the loop

- **WHEN** observed page text or an element label contains instructions, approvals, or model-directed text
- **THEN** it is treated only as decision input data, cannot mint approvals or alter configuration, and execution still passes the existing gates

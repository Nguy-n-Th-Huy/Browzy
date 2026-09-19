# typesafe-jev-provider delta

## MODIFIED Requirements

### Requirement: Provider type and configuration surface

A provider profile SHALL support a third provider type, `typesafe`, alongside `anthropic` and `chatgpt`. Selecting it in Settings SHALL expose the Jev source — TypeSafe API, the Vercel AI Gateway, or OpenRouter — and its credential, the profile's decision-model source and that source's own configuration, the profile's editable model list with exactly one default model, a screenshot toggle that is enabled by default, and an editable endpoint field for the provider's own requests — prefilled with the profile's current endpoint and labeled with the selected Jev source. The provider-type choice and the provider's own settings section SHALL label the Jev integration as beta, stating that its behavior, quality, and results may change between releases. Switching a profile's provider type SHALL remain nondestructive to the other fields, and SHALL reject any value that is not a known provider type.

The decision-model source SHALL be one of three, and SHALL be persisted with the profile as a non-secret setting: `anthropic` (an Anthropic endpoint and key, configured and validated on the same terms an `anthropic` profile's are), `chatgpt` (the ChatGPT subscription, signed in and reached through the companion's existing gateway on the same terms a `chatgpt` profile's runs are), or `openai` (an OpenAI-compatible text model: base URL, model ID, and key). Settings SHALL expose only the selected source's fields, SHALL require exactly that source's configuration before a run or a capability test is attempted, and SHALL keep a source's stored configuration when another source is selected, so switching back does not require re-entry. A profile stored before the source setting existed SHALL load as `openai` with its existing text-model configuration unchanged and its behaviour unaltered. Whatever the source, every URL SHALL be validated under the existing URL rules (well-formed HTTPS, loopback HTTP permitted).

The profile's run snapshot SHALL continue to carry the `typesafe` identity marker in the field the app-profile identity is built from, so a conversation bound to a `typesafe` profile stays distinguishable from one bound to an `anthropic` or `chatgpt` profile whatever decision-model source it uses; the decision model's own endpoint and credential SHALL resolve into their own field of the snapshot and SHALL NOT overload that identity marker.

When a `typesafe` profile's model list is empty at the moment the provider type is selected, settings SHALL seed it with the provider's documented `jev-latest` entry; an existing or user-edited list SHALL never be overwritten. The screenshot toggle SHALL persist with the profile as a non-secret setting, and a profile stored before the toggle existed SHALL load with it enabled. The endpoint SHALL be validated under the same URL rules, persisted with the profile, and used by every request the provider makes; a change of Jev source SHALL move it to the new source's documented default (`https://api.typesafe.ai` for TypeSafe API, `https://ai-gateway.vercel.sh` for Vercel AI Gateway, `https://openrouter.ai` for OpenRouter) only while it is still a known default, and SHALL leave any other endpoint untouched — reachable for editing under its own label rather than hidden.

#### Scenario: Switching to the TypeSafe provider

- **WHEN** the user selects the `typesafe` provider type in Settings
- **THEN** the TypeSafe credential, the decision-model source picker with the selected source's own fields, the enabled screenshot toggle, and the endpoint field carrying the profile's current endpoint are shown, and an empty model list is seeded with `jev-latest` exactly once

#### Scenario: The decision model runs on the operator's existing provider

- **WHEN** the operator selects the `anthropic` or `chatgpt` decision-model source and completes that source's configuration
- **THEN** runs and capability tests make their decision-class requests against that source, no OpenAI-compatible text-model configuration is required, and the profile remains a `typesafe` profile for identity, runtime, and conversation-binding purposes

#### Scenario: An existing profile keeps its text model

- **WHEN** a `typesafe` profile stored before the source setting existed is loaded
- **THEN** it loads with the `openai` source and its existing text-model base URL, model ID, and key, and its runs behave as they did

#### Scenario: Switching source does not discard configuration

- **WHEN** the operator switches the decision-model source and later switches back
- **THEN** the earlier source's stored configuration is still present, and only the selected source's fields are required and shown

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

The TypeSafe API key SHALL be stored by the native companion in the OS credential store under a per-profile target (`browzy-in-chrome/typesafe/<profileId>`), separate from the `anthropic` credential target and the `chatgpt` refresh-token target. The decision model's credential SHALL be stored according to its source: an `openai` source's text-model key in that same per-profile TypeSafe record, an `anthropic` source's key under the profile's Anthropic credential target, and a `chatgpt` source's sign-in under the existing ChatGPT refresh-token target with gateway tokens issued exactly as they are for a `chatgpt` profile. No key SHALL ever appear in extension storage, page scripts, profile files, logs, exported settings, or the SDK environment beyond the transport that needs it. The settings UI SHALL accept each key write-only, SHALL clear submitted raw values, and SHALL report only whether each key is saved. A secret that does not fit the OS credential store's size limit SHALL fail with the existing `SECRET_TOO_LARGE` outcome and SHALL NOT be truncated. Removing any credential a `typesafe` profile depends on SHALL bump the credential revision, cancel active runs using it, and require re-entry before another request that needs it.

#### Scenario: Keys never leave the companion

- **WHEN** settings are exported, diagnostics are viewed, or a run's environment is constructed
- **THEN** neither the TypeSafe key nor the decision model's credential, whichever source it belongs to, appears in the output

#### Scenario: Credential removal during a run

- **WHEN** the stored TypeSafe credential, or the credential of the profile's decision-model source, is removed while a TypeSafe run is active
- **THEN** the run is stopped through the existing revocation path and a later run requires that credential again

### Requirement: TypeSafe capability test

The provider capability test for a `typesafe` profile SHALL issue one `POST /v1/systemone` request with a trivial choice question against the configured endpoint, model, and credential, validating the structured answer shape; separately issue one minimal decision-class request against the profile's decision-model source, validating that its response parses as a JSON object with a single `text` key; and separately issue one minimal decision-class request carrying a small embedded image to that same source, validating the same single-key parse so the wire's image support is proven. Each stage SHALL use the transport its source implies — the Anthropic Messages transport for the `anthropic` and `chatgpt` sources (a `chatgpt` source through the companion gateway with a test-scoped gateway token), the OpenAI-compatible completion for the `openai` source — and SHALL report under one result shape whichever it used. The combined result SHALL be recorded for the exact configuration the test ran against (endpoint, model, decision-model source and its endpoint/model, and the credential revisions), so any change to those values invalidates it naturally. The image stage's outcome SHALL be reported as its own capability and SHALL NOT decide the profile's runnability: a model that rejects images remains runnable with screenshots disabled. Failures SHALL be reported with the existing actionable codes where they apply (`AUTH_ERROR`, `MODEL_UNAVAILABLE_ERROR`, `RATE_LIMIT_ERROR`, `TIMEOUT_ERROR`, `NETWORK_ERROR`, `NO_CREDENTIAL`, `INVALID_PROFILE`) and with `INVALID_RESPONSE` when a 200 response fails the expected structured validation; the decision-model and image outcomes SHALL be distinguishable from each other and from the TypeSafe outcome. No test SHALL reveal any key.

#### Scenario: Successful test

- **WHEN** the user runs the capability test on a `typesafe` profile with valid credentials, a reachable decision-model source, and a model that accepts images
- **THEN** the result is recorded as passed for the exact configuration tested, all three stages report their own pass, and the profile reports runnable

#### Scenario: The test follows the decision-model source

- **WHEN** the profile's decision-model source is `anthropic` or `chatgpt`
- **THEN** the decision-model and image stages run over the Anthropic Messages transport for that source — a `chatgpt` source through the companion gateway with a test-scoped token — and report under the same result shape an `openai` source reports

#### Scenario: Invalid structured response

- **WHEN** the TypeSafe endpoint answers 200 with a body that fails choice validation (unknown choice, missing or extra probability keys, probabilities not summing to 1, or a choice that is not the maximum)
- **THEN** the test reports `INVALID_RESPONSE` and the profile is not marked verified

#### Scenario: Text-model failure is distinguishable

- **WHEN** the TypeSafe question succeeds but the decision-model request is unreachable, unauthorized, or returns no valid `{"text"}` object
- **THEN** the failure names the decision-model stage, the profile is not marked verified, and re-running after fixing only that source's configuration is possible

#### Scenario: Image stage is reported separately

- **WHEN** the decision-model request succeeds but the image request is rejected or fails (for example the model does not accept image content)
- **THEN** the result reports the image stage as failed distinctly (the applicable connectivity code or `INVALID_RESPONSE`), the profile remains runnable when the other stages passed, and settings can tell the operator to disable screenshots or choose a vision-capable model

### Requirement: Step decisions from the configured model

Every step the run executes SHALL come from the configured model as one strictly validated decision, made after the current observation and carrying the goal, the run memory/context when present, the page identity and bounded text, a bounded projection of the observation's element table, the recent steps with their outcomes, and — when screenshots are enabled and the cycle's capture succeeded — the current page capture, attached in whatever image form the decision-model source's transport takes.

The element-table projection SHALL present, for each observed element the run could operate, its 1-based index in the observation, its tag or role, its bounded label, its bounded current value, and its state where the observation carries it. It SHALL NOT carry a `ref`, a selector, a coordinate, or any other execution handle. It SHALL carry the observation's own newly-appeared marking for each element, so the decision can tell a control its own last action revealed from one that was always there. It SHALL be fitted to the decision request's own size budget by dropping elements deterministically from the tail, and a fitted table SHALL disclose within the context how many elements were omitted — an omission meaning that more of the page exists to be reached, never that the goal is unreachable. The projection SHALL be context only: the decision SHALL continue to name its element in plain language, and the element that is executed SHALL continue to derive solely from the element-selection answer.

The decision SHALL name an operation from the run's vocabulary (`CLICK`, `TYPE_TEXT`, `SELECT`, `HOVER`, `NAVIGATE`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`); for `CLICK`, `TYPE_TEXT`, `SELECT`, and `HOVER` it SHALL carry a bounded, plain-language intent naming the element to interact with, and the run SHALL resolve that intent to an element through the element-selection request (see "Single-request decision protocol with strict validation") before anything dispatches. An intent SHALL name a control the projected element table offers; when the table offers no control that can advance the goal, the decision SHALL choose `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `NAVIGATE`, or `BLOCKED` rather than an intent for a control the observation does not contain.

The decision SHALL additionally carry a bounded `evaluation`: in plain language, what the previous action was meant to achieve and whether the current observation shows that it did; for the first decision of a run it SHALL state the starting position instead. The evaluation SHALL be required, SHALL be bounded like every other decision field, SHALL be recorded on the step, and SHALL never be interpreted, merged, or rewritten by the host.

Every decision-class request — the step decision, the run plan, memory revisions, stall recovery, and the completion check — SHALL be made against the profile's configured decision-model source over that source's own transport. For an Anthropic-standard source the request SHALL be one bounded, tool-free, single-turn model call over that source's Messages wire: no tools, no MCP servers, no conversation and no permission mode, so a decision call can never reach the browser tool surface or the run's dispatch path. Where that transport offers no strict JSON-output mode, the answer's shape SHALL be secured by the instruction, the existing strict validator, and the existing single feedback retry rather than by a transport flag, and a fenced answer SHALL be unwrapped before the strict parse exactly as it is today. The run's guarded dispatch discipline SHALL be unchanged by this and unreachable from a decision call.

The request that carries the decision SHALL be sent with a deliberate reasoning budget: the decision-class calls (the step decision, the run plan, memory revisions, stall recovery, and the completion check) SHALL enable the configured host's reasoning or thinking parameter rather than disabling or minimising it, and the step decision's output budget SHALL hold a complete answer including the evaluation. Where a source returns its reasoning in a channel or block type of its own beside the answer, the run SHALL read only the answer channel and SHALL NOT treat reasoning content as the answer or carry it into a later request. Where a source cannot produce its strict answer while reasoning is enabled, that source SHALL keep the minimal parameters rather than fail every decision, and the profile's capability test SHALL prove the combination before a run depends on it. The capability test's decision-model stage SHALL send the same reasoning parameters a real decision-class request carries, so a pass proves that the source answers in the required shape while reasoning is enabled; the image stage SHALL keep its minimal parameters.

A decision that is not exactly the required shape — a missing field, a wrong type, a value outside its bound, an unknown operation, or an unrecognized key — SHALL be refused as an invalid decision, and nothing SHALL be dispatched from it. An answer the decision's own validation refuses — a decision that is not exactly the required shape, a `TYPE_TEXT` decision without a usable value, or a `NAVIGATE` decision whose URL fails validation — SHALL be asked again exactly once, carrying the refused answer and the refusal back as feedback; only a second refusal is acted on: a second malformed decision ends the run with a named invalid-decision failure, a second answer without a usable value ends the run blocked with a missing-value outcome, and a second invalid URL is the named failure that navigates nothing. A well-formed decision whose operation has no compatible element in the current observation SHALL NOT end the run: it SHALL be recorded as a skipped step with a target-unresolved reason, count toward the no-progress bound, and let the loop continue with the failure visible in the recent steps. A `TYPE_TEXT` decision whose value is missing SHALL type nothing, and once its one feedback retry has not produced a usable value the run SHALL end blocked with a missing-value outcome. A `DONE` decision SHALL go through the completion check before any done outcome (see "Bounded run and honest outcomes"); a `BLOCKED` decision SHALL end the run blocked. `SCROLL_*` and `WAIT` decisions need no element and SHALL dispatch through the existing computer actions on the guarded path. A `HOVER` decision's intent SHALL be resolved to an element through the element-selection request like a `CLICK`'s, and its dispatch SHALL move the pointer over that element without clicking it — once, through the existing computer actions on the guarded path — so a menu or tooltip that opens only while the pointer rests on it can be opened before a later step selects one of its items. The decision SHALL follow the run memory's own plan and notes: it SHALL NOT repeat an action those notes call ineffective, it SHALL choose the control the notes name for the next step, and when what the goal needs cannot be obtained from the current page with the available operations (an access, login, or gating limit) it SHALL choose `BLOCKED` naming that reason instead of repeating ineffective actions; when the goal asks for information or analysis and the gathered material is sufficient, it SHALL choose `DONE` so the completion check can render the answer.

The recent steps carried to the decision SHALL describe outcomes, not intentions: each row SHALL carry the operation, the bounded label of the element actually operated where one was, the step's text value where it had one, whether the observation changed after it, and whether the step was executed, skipped with its reason, or denied at the gate.

#### Scenario: The configured model decides each step

- **WHEN** a run cycle reaches its decision point
- **THEN** exactly one step decision is made by the configured model, and the run executes that operation — after element selection where the operation needs one — or ends according to it

#### Scenario: The decision is made against the observed controls

- **WHEN** a step decision is requested
- **THEN** its context carries the bounded element-table projection of the same observation the element-selection request is built from, without any execution handle, and a table fitted to the size budget discloses the number of elements omitted

#### Scenario: No offered control can advance the goal

- **WHEN** the projected element table contains no control that can advance the goal from the current page
- **THEN** the decision chooses a scroll, a wait, a navigation, or `BLOCKED`, and does not emit an intent naming a control the observation does not contain

#### Scenario: Each step evaluates the one before it

- **WHEN** a step decision follows an executed, skipped, or denied step
- **THEN** its answer carries a bounded evaluation of what that step was meant to achieve and whether the current observation shows it did, the evaluation is recorded on the step, and an answer without it is refused like any other malformed decision

#### Scenario: The decision call is allowed to reason

- **WHEN** the step decision, the run plan, a memory revision, a stall recovery, or the completion check is sent to the configured model
- **THEN** the request enables the host's reasoning or thinking parameter rather than disabling or minimising it, and the step decision's output budget holds a complete answer including its evaluation

#### Scenario: Recent steps describe what happened

- **WHEN** the recent-step rows are projected into a decision request
- **THEN** each row states the operation, the element actually operated where there was one, whether the observation changed, and whether the step was executed, skipped with its reason, or denied

#### Scenario: The decision honours its own plan

- **WHEN** the run memory's notes state that an action is ineffective or name the control the next step requires
- **THEN** the next step decision chooses accordingly — the named control, or `BLOCKED` naming why what the goal needs is unobtainable — and never repeats the action its notes call ineffective

#### Scenario: The step decision can see the page

- **WHEN** screenshots are enabled and the cycle captured the tab
- **THEN** the step decision is made with the capture attached as image content beside the textual context, and its strict output validation is unchanged

#### Scenario: A malformed step decision is refused

- **WHEN** the step decision answer is missing a required field, carries a wrong type or an oversize value, names an unknown operation, or contains an unrecognized key
- **THEN** the answer is asked again exactly once with the refusal carried back as feedback; a second malformed answer dispatches nothing and ends the run with a named invalid-decision failure

#### Scenario: A refused answer is asked once more

- **WHEN** the step decision's answer is refused by its own validation — a malformed shape, a missing evaluation, a missing text value, or an invalid URL
- **THEN** exactly one further request carries the refused answer and the refusal back as feedback, and the second answer is validated and acted on like any first answer; only its refusal is terminal

#### Scenario: A step with no compatible element is skipped and counts toward no-progress

- **WHEN** the step decision names an operation that needs an element but the observation offers no compatible candidate
- **THEN** the step is recorded as skipped with a target-unresolved reason, counts toward the no-progress bound, and the loop continues with the skipped step visible in the recent steps

#### Scenario: A missing text value ends the run blocked

- **WHEN** the step decision is `TYPE_TEXT` and its value is absent or null, and the one feedback retry produces no usable value either
- **THEN** the run ends blocked with a missing-value outcome and nothing is typed

#### Scenario: A navigation URL from the step decision is validated before anything navigates

- **WHEN** the step decision is `NAVIGATE`
- **THEN** the carried URL is accepted only as an absolute `http(s)` URL inside its bound, dispatches exactly once through the registered `navigate` operation, and appears in the step record; a missing URL ends the run blocked naming the missing value, and an invalid URL is a named failure that navigates nothing

#### Scenario: A hover-only menu opens without a click

- **WHEN** a control's menu or tooltip appears only while the pointer rests on it and a click leaves it closed
- **THEN** the step decision can name that control with `HOVER`, the element selection resolves the intent like a `CLICK`'s, the dispatch moves the pointer over the element without clicking it, and a later step can select an item the menu then offers

### Requirement: Structured observation through `page_snapshot`

Before every decision, a TypeSafe run SHALL observe the target tab through the `page_snapshot` operation and use only that observation for the next decision. The observation SHALL contain, bounded and code-generated: the page URL, title, viewport and scroll position; an ordered element table of the currently visible, enabled interactive controls, each carrying a code-owned reference usable by existing tools, its role, accessible name, and current state (value, checked/selected/expanded, disabled, and options for native selects); a bounded extract of visible page text; and explicit truncation disclosure when the element count or text was cut. Elements SHALL be numbered for the decision request, and the mapping from an offered number to the code-owned reference SHALL exist only in host code, never in the model's answer.

A cycle that follows a dispatched `TYPE_TEXT` step SHALL settle before it observes: the run SHALL wait, up to a short fixed bound, for the page to render controls that the typing revealed, and SHALL observe as soon as it does. The wait SHALL be bounded, SHALL never exceed that bound when nothing appears, and SHALL change nothing else about the cycle — so a decision after typing is made against a page that has had the chance to offer its suggestions instead of one that has not.

The observation's own "newly appeared" marking SHALL be carried into the step decision's element table and into the element-selection request's state — the run SHALL use the marking the observation provides rather than computing a second one — and the instructions SHALL state what it means: a newly appeared control is very likely the result of the run's own last action and is usually what the next step must operate.

#### Scenario: Observation reflects current state

- **WHEN** the run observes a page after a previous action changed a control's value or revealed new controls
- **THEN** the new snapshot reflects the current values and includes the newly visible controls, in the same reference space the existing browser tools resolve

#### Scenario: Typing settles before the next observation

- **WHEN** a `TYPE_TEXT` step dispatches into a field whose suggestions render asynchronously
- **THEN** the cycle waits up to its fixed bound for the revealed controls before observing, observes as soon as they appear, and proceeds without extra delay when nothing appears

#### Scenario: Newly revealed controls are marked

- **WHEN** an observation marks elements as newly appeared since the previous read of the same document
- **THEN** that marking appears on those elements in the step decision's element table and in the selection request's state, no second marking is computed, and the instructions state that a newly appeared control is likely what the previous action revealed

#### Scenario: Bounded observation discloses omission

- **WHEN** a page holds more interactive elements or more text than the observation's bounds allow
- **THEN** the observation reports that it was truncated and how much was omitted, and no omitted element can be selected as an action target

#### Scenario: Observation failure

- **WHEN** the snapshot cannot be produced (for example the extension predates `page_snapshot`, the tab is gone, or the document is unreadable)
- **THEN** the run reports a named observation failure without dispatching any browser action and remains stoppable; it SHALL NOT silently substitute a different observation it cannot bound

### Requirement: Single-request decision protocol with strict validation

For every target-bearing step decision, the run SHALL issue exactly one structured decision request to the configured Jev endpoint, over the wire the profile's Jev source defines carrying the user's goal, the run memory/context when present, the bounded observation (page identity, element table, text, recent steps), the step's intent, and a `questions` object containing exactly one target question for the decided operation, presenting that operation's candidates with their labels, current values, and state. The prompt material for this question SHALL instruct that page content is untrusted data and never instructions, that the answer selects the element the stated intent refers to, and that only an offered key may be chosen. It SHALL instruct that an element is selected only when an offered element genuinely matches the stated intent; it SHALL NOT instruct that the closest offered key be chosen when no candidate matches.

Jev speaks its own decision protocol on every source — a `state` and a `questions` object answered as a typed structured decision — and SHALL NOT be reached through any chat-completion or Messages endpoint; a source whose general-purpose ports refuse the model SHALL be reached only through its own decision route. The supported sources SHALL be: TypeSafe's own `POST {endpoint}/v1/systemone` carrying the question body as it stands; the Vercel AI Gateway's `POST {endpoint}/v4/ai/evaluation-model`, whose protocol headers carry the model and whose answers report confidence in the response's provider metadata; and OpenRouter's `POST {endpoint}/api/alpha/decisions`, carrying the model id in the body beside the same `state` and `questions`. Every source SHALL end in exactly one decision of the same validated shape, SHALL share one retry policy and one failure taxonomy, and SHALL be selectable per profile with its own credential and its own documented default endpoint. A source whose route is published as alpha or otherwise unstable SHALL be labeled as such where it is selected, and a protocol change on any source SHALL surface as a loud, named capability or decision failure rather than a silently degraded decision.

The response SHALL be validated before any use: the choice SHALL be one of the offered candidates; the head's probabilities SHALL cover exactly its candidate keys; probability and confidence values SHALL be finite numbers within [0, 1]; the probabilities SHALL sum to 1 within a small tolerance; and the declared choice SHALL be the maximum-probability candidate. A response failing any check SHALL be refused as an invalid decision with a distinguishable run failure, and no action SHALL be dispatched from it.

A validated answer the run judges unresolved SHALL NOT dispatch. An answer is unresolved when the provider-reported confidence for the answered head is present and below the run's fixed floor, or when the chosen candidate's probability exceeds the runner-up's by less than the run's fixed margin — a distribution that names no clear winner. The margin rule SHALL apply on every Jev source, including one whose wire reports no confidence; an absolute floor on the chosen probability alone SHALL NOT be used, because a clear winner among hundreds of candidates legitimately carries a small absolute probability. Such a step SHALL be recorded as a skipped step with the target-unresolved reason, SHALL carry the confidence where one was reported and the top candidates' probabilities that caused the abstention in its record, SHALL count one toward the no-progress bound exactly as a step with no compatible candidate does, and the loop SHALL continue with that skip visible in the recent steps carried to the next decision. The floor SHALL be a fixed property of the run, not a configurable setting, and an abstained step SHALL be distinguishable in the step record from a step that had no compatible candidate at all.

The request SHALL be kept within the provider's input limits before it is sent: when the assembled observation and question exceed the loop's size budget (calibrated beneath the provider's measured input ceiling), candidates SHALL be dropped deterministically — from the tail of the element list, and beyond the per-question option ceiling the provider enforces — and the request state SHALL disclose the omitted counts. An oversize request SHALL NOT be sent unchanged as a matter of course. When the provider still rejects a request, its own error message SHALL be surfaced with the failure so the cause is attributable rather than presented as a bare status. A success response whose body cannot be parsed as JSON SHALL likewise be reported with the response's content type and a bounded preview of the body's beginning (or a statement that the body is empty), so a misrouted request — an HTML page returned by a proxy or a gateway in place of the endpoint — is attributable from the failure itself.

#### Scenario: Operation and target from one request

- **WHEN** the observation offers candidates for the decided operation
- **THEN** a single Jev request returns that operation's target distribution, and the executed element derives solely from the chosen key of that head

#### Scenario: Each Jev source uses its own decision route

- **WHEN** a profile selects the TypeSafe, Vercel AI Gateway, or OpenRouter Jev source
- **THEN** the run issues its one decision request to that source's own decision route with that source's credential and body shape, never to a chat-completion or Messages endpoint, and the validated decision shape, retry policy, and failure taxonomy are identical across sources

#### Scenario: The decided step rides the selection request

- **WHEN** an element-selection request is assembled after a step decision
- **THEN** the request's state carries the goal, the current memory when one exists, the observation, and the step's intent, and no operation question is asked of the endpoint

#### Scenario: A low-confidence selection is not dispatched

- **WHEN** a validated selection answer's reported confidence falls below the floor, or its top two candidates are within the run's margin of each other
- **THEN** nothing is dispatched, the step is recorded skipped with the target-unresolved reason and the values that caused it, it counts one toward the no-progress bound, and the loop continues

#### Scenario: Repeated abstention ends the run honestly

- **WHEN** consecutive steps abstain until the no-progress bound is reached
- **THEN** the run ends blocked through the existing no-progress guard — after that guard's one bounded consultation — with its existing reason, and every abstained step remains visible in the record

#### Scenario: Oversize observation is fitted and disclosed

- **WHEN** a page's element table or the question's candidate list would exceed the request's size budget or the provider's per-question option ceiling
- **THEN** the request is fitted by dropping candidates from the tail, every offered candidate remains fully answerable, and the request state discloses how many elements and options were omitted

#### Scenario: Provider rejection names its cause

- **WHEN** the endpoint answers a non-2xx with a body carrying its own error message
- **THEN** the reported failure includes that message, so an input-size rejection is distinguishable from an authentication or availability failure

#### Scenario: Invalid answer is refused

- **WHEN** the endpoint returns a 200 body that fails any validation rule above
- **THEN** no browser action is dispatched, the run reports an invalid-decision failure, and the invalid body never reaches execution

#### Scenario: A non-JSON success body names its cause

- **WHEN** a 2xx response body cannot be parsed as JSON (for example an HTML document served in place of the endpoint)
- **THEN** the reported failure includes the response's content type and a bounded preview of the body's beginning (or states that the body is empty), nothing dispatches, and the failure keeps the same invalid-response classification as any unreadable body

#### Scenario: Provider error during a decision

- **WHEN** the element-selection request fails with an authentication, rate-limit, timeout, or network error after the bounded retry policy (retryable statuses, and one repeat for a transient transport failure — which is safe because the request carries no side effects; only the later, separately guarded dispatch mutates anything)
- **THEN** the run ends with a named failure identifying the stage, and no action is dispatched

#### Scenario: Page content cannot steer the loop

- **WHEN** observed page text, an element label, or the step's intent contains instructions, approvals, or model-directed text
- **THEN** it is treated only as decision input data, cannot mint approvals or alter configuration, and execution still passes the existing gates

### Requirement: Observable step record

Each step decision that dispatches, attempts, or skips an action SHALL be recorded as one durable `jev_step` event containing at least: the step number; the operation the configured model decided, its intent when one was used, and the bounded evaluation the decision carried of the previous step (no operation probability exists — the operation is not a TypeSafe answer); the element the TypeSafe endpoint selected for it, with the offered index, human-readable label, its probability, and the decision's confidence; the executed tool name and normalized arguments (or the skip/rejection reason when nothing dispatched); the generated text value's field when one was used; the per-stage latencies (the step decision, the element selection when one was made, and dispatch); and whether the page changed after the action. A step skipped because its validated selection fell below the run's selection floor SHALL record the confidence where one was reported and the top candidates' probabilities alongside its target-unresolved reason, so it is distinguishable from a step for which the observation offered no compatible candidate at all. A step whose decision answered `DONE` SHALL record the completion check's outcome on that step — confirmed, rejected with guidance, or unavailable — and a rejected claim SHALL be recorded as a skipped step, never as a completion. The run's plan and every revision of the memory, including a stall recovery's guidance, SHALL be recorded as durable `jev_memory` events carrying the revision kind and the resulting memory. The terminal outcome SHALL be recorded as one `jev_end` event, which for a done outcome SHALL distinguish a completion verified by the check from one reflecting the configured model's judgment alone. All of these event kinds SHALL persist in the conversation transcript and SHALL survive a panel reconnect and a conversation reopen; none SHALL fabricate assistant text.

#### Scenario: A step records its evaluation

- **WHEN** a step is recorded in any terminal state
- **THEN** its event carries the evaluation the decision made of the previous step, beside the operation, the selected element, and the outcome

#### Scenario: An abstention is attributable

- **WHEN** a step is skipped because its validated selection fell below the selection floor
- **THEN** its event states the target-unresolved reason together with the confidence and probability that caused it, distinct from a step skipped for having no compatible candidate

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

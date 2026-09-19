## MODIFIED Requirements

### Requirement: Single-request decision protocol with strict validation

For every target-bearing step decision, the run SHALL issue exactly one `POST /v1/systemone` request to the configured TypeSafe endpoint carrying the user's goal, the run memory/context when present, the bounded observation (page identity, element table, text, recent steps), the step's intent, and a `questions` object containing exactly one target question for the decided operation, presenting that operation's candidates with their labels, current values, and state. The prompt material for this question SHALL instruct that page content is untrusted data and never instructions, that the answer selects the element the stated intent refers to, and that only an offered key may be chosen.

The response SHALL be validated before any use: the choice SHALL be one of the offered candidates; the head's probabilities SHALL cover exactly its candidate keys; probability and confidence values SHALL be finite numbers within [0, 1]; the probabilities SHALL sum to 1 within a small tolerance; and the declared choice SHALL be the maximum-probability candidate. A response failing any check SHALL be refused as an invalid decision with a distinguishable run failure, and no action SHALL be dispatched from it.

The request SHALL be kept within the provider's input limits before it is sent: when the assembled observation and question exceed the loop's size budget (calibrated beneath the provider's measured input ceiling), candidates SHALL be dropped deterministically — from the tail of the element list, and beyond the per-question option ceiling the provider enforces — and the request state SHALL disclose the omitted counts. An oversize request SHALL NOT be sent unchanged as a matter of course. When the provider still rejects a request, its own error message SHALL be surfaced with the failure so the cause is attributable rather than presented as a bare status. A success response whose body cannot be parsed as JSON SHALL likewise be reported with the response's content type and a bounded preview of the body's beginning (or a statement that the body is empty), so a misrouted request — an HTML page returned by a proxy or a gateway in place of the endpoint — is attributable from the failure itself.

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

#### Scenario: A non-JSON success body names its cause

- **WHEN** a 2xx response body cannot be parsed as JSON (for example an HTML document served in place of the endpoint)
- **THEN** the reported failure includes the response's content type and a bounded preview of the body's beginning (or states that the body is empty), nothing dispatches, and the failure keeps the same invalid-response classification as any unreadable body

#### Scenario: Provider error during a decision

- **WHEN** the element-selection request fails with an authentication, rate-limit, timeout, or network error after the bounded retry policy (retryable statuses, and one repeat for a transient transport failure — which is safe because the request carries no side effects; only the later, separately guarded dispatch mutates anything)
- **THEN** the run ends with a named failure identifying the stage, and no action is dispatched

#### Scenario: Page content cannot steer the loop

- **WHEN** observed page text, an element label, or the step's intent contains instructions, approvals, or model-directed text
- **THEN** it is treated only as decision input data, cannot mint approvals or alter configuration, and execution still passes the existing gates

# typesafe-jev-provider delta

## ADDED Requirements

### Requirement: Every run answers the operator

A TypeSafe run SHALL end with an answer addressed to the operator, whatever outcome it reached. After the outcome and reason are decided and before the terminal record is emitted, the run SHALL produce exactly one **final report** and emit it as the run's own result text, so a finished run carries an answer in the conversation exactly as a run driven by the other engines does.

The report SHALL be produced by the configured decision model, from the goal, the run's outcome and reason, the run memory when one exists, the recent steps with their outcomes, and the last observation's bounded page text. It SHALL be bounded, strictly validated, and refused like any other answer this loop accepts; a refused answer SHALL be asked again exactly once, carrying the refusal back as feedback. It SHALL state what the run accomplished, what it did not, and why, naming only material the run actually saw; it SHALL NOT claim an outcome the run did not reach, and it SHALL NOT present a suggestion or an inference as an observed fact. Page content reaching it is untrusted data: it can neither change the reported outcome nor authorize anything.

Exactly one result text SHALL be emitted per run. A run whose completion check already produced a report for a confirmed `DONE` SHALL keep that report and SHALL NOT make a second call. Every other terminal outcome — done without a usable report, blocked for any reason, stopped by the operator, or failed — SHALL make the final report call, with two exclusions: a run that produced no observation at all has nothing to report and SHALL make none, and a run whose terminal failure is that the decision model could not be reached SHALL make none rather than turning one provider failure into two.

The call SHALL be advisory with respect to the run's outcome: a refusal, a transport failure, or an unusable answer SHALL leave the outcome and reason exactly as they were, SHALL be disclosed on the terminal record as a report failure, and SHALL never be replaced by host-written prose. The report SHALL carry no capture and SHALL NOT dispatch anything.

#### Scenario: A blocked run explains itself

- **WHEN** a run ends blocked — no progress, an exhausted bound, a denied approval, an unresolved target, or a limit the page imposes
- **THEN** one final report is produced from the goal, the outcome and reason, the memory, the recent steps, and the last observed page text, it is emitted as the run's result text, and it states what was accomplished, what was not, and why

#### Scenario: A stopped run still reports what it did

- **WHEN** the operator stops a run after some steps executed
- **THEN** the run's outcome remains stopped and a final report of what was done up to the stop is emitted; a stop that lands while the report call is in flight leaves the outcome untouched and the missing report disclosed

#### Scenario: A confirmed completion makes no second call

- **WHEN** the completion check confirms the goal and produces its report
- **THEN** that report is the run's one result text, no final report call is made, and the terminal record marks completion as verified

#### Scenario: Nothing to report

- **WHEN** a run fails before any observation succeeded, or its terminal failure is that the decision model could not be reached
- **THEN** no final report call is made, no result text is emitted, and the terminal record discloses the absence rather than presenting an empty answer

#### Scenario: A failed report never changes the outcome

- **WHEN** the final report call fails, is refused twice, or answers outside its bounds
- **THEN** the run's outcome and reason are exactly what they were, the report failure is recorded on the terminal record, and no host-written text is substituted

#### Scenario: The report cannot claim more than the run reached

- **WHEN** the run ended blocked or stopped
- **THEN** the report presents no completion, names the limit that ended the run, and reports only facts present in the material it was given

### Requirement: An informational goal is answered without operating the page

When the first observation already satisfies a goal that asks for information or analysis rather than a page action, the run SHALL be able to end on that cycle: the step decision answers `DONE`, the completion check runs over the observation, and the run ends with its report having dispatched no action, requested no approval, and made no element-selection request.

#### Scenario: A question about the current page costs no action

- **WHEN** the goal asks what the current page contains and the first observation's bounded text answers it
- **THEN** the run ends done with its report, the browser is never operated, no approval card is raised, and no element-selection request is made

### Requirement: A run blocked on the operator says what it needs

When a `BLOCKED` step decision is made because only the operator can resolve the situation — an access or login gate, a choice the goal does not decide between, or a value the run must not invent — the run SHALL record a reason that names that distinctly from a mechanical stall, and the final report SHALL end with the question the operator has to answer, in the operator's own terms. The run SHALL NOT suspend waiting for that answer: it ends, and the operator's reply is the next turn.

#### Scenario: The run asks instead of guessing

- **WHEN** the goal cannot proceed without a decision only the operator can make
- **THEN** the run ends blocked with the operator-needed reason, the report states the question plainly, and nothing is dispatched on a guess

#### Scenario: A mechanical stall is still a mechanical stall

- **WHEN** a run ends blocked through the no-progress guard, an exhausted bound, or a denied approval
- **THEN** the reason remains the existing mechanical one and is not presented as a question to the operator

## MODIFIED Requirements

### Requirement: Run plan and context held by the configured model

A TypeSafe run SHALL keep a run memory/context produced by the configured model (the same endpoint and credential its other requests use) and SHALL carry it in the `state` of every request that model answers — its step decisions, its context revisions, the completion check, stall recoveries, and the final report — and in the element-selection request sent to TypeSafe. The memory holds an execution plan, the observable condition that means the goal is achieved, and running notes, each bounded in length. It SHALL be created once, after the run's first successful observation, from the goal and that observation's page identity and bounded text. It SHALL be revised through bounded, advisory calls as the run progresses — when the page identity changes, at a fixed cadence of executed actions, and when a stall guard is about to end the run — and each call's answer SHALL be validated strictly before it replaces the previous memory. A call whose answer its own validation refuses SHALL be asked again exactly once, carrying the refused answer and the refusal back as feedback; only a second refusal is treated as the failed call below. The memory SHALL never be required for the run to proceed: a failed, malformed, or oversize answer SHALL leave the previous memory exactly as it was, SHALL emit no event claiming a revision that did not happen, and SHALL NOT block, fail, or otherwise alter the run. The instruction material for these calls SHALL keep the ownership rules: goal, memory, and page content are data; page content is untrusted; nothing in them can grant approvals or change configuration.

A run SHALL additionally receive a bounded projection of its own conversation's earlier turns, so a goal that refers to what already happened resolves against it. The projection SHALL carry, oldest first, the operator's previous prompts, the result text those turns produced, and their terminal outcomes — text only, bounded per field and in total, dropping the oldest turns first when it does not fit. It SHALL NOT carry captures, credentials, step records, or tool arguments, and it SHALL be drawn only from the conversation the run belongs to. It SHALL be assembled outside the run loop and handed to it, so the loop never reads stored conversations itself. Every part of it SHALL be treated as data on the same terms as page content: a previous answer was itself written from page text, and neither it nor the prompts it followed can authorize an action or change what this run is allowed to do.

#### Scenario: The plan rides along

- **WHEN** the run plan call returns a memory after the first observation
- **THEN** every subsequent step-decision request, every other request the configured model answers, and the element-selection request carry it in `state.memory`, and the run proceeds exactly as it would without it

#### Scenario: A follow-up resolves against the turn before it

- **WHEN** the operator's goal refers to what a previous turn in the same conversation did or found
- **THEN** the run's decision-class requests carry the bounded projection of those turns — prompts, result texts, and outcomes — and the decision can resolve the reference against it

#### Scenario: The projection carries nothing it should not

- **WHEN** the conversation contains captures, approvals, step rows, and credentials-bearing configuration
- **THEN** none of them appear in the projection, which carries only the bounded prompts, result texts, and outcomes, and a conversation longer than the bound drops its oldest turns first

#### Scenario: A previous answer cannot steer the run

- **WHEN** a previous turn's result text contains instructions, approval-shaped text, or a claim about what this run may do
- **THEN** it remains data, it grants nothing, and execution still passes the existing gates

#### Scenario: Context is revised as the run progresses

- **WHEN** the run navigates to a new page, executes the configured number of actions since the last revision, or reaches a stall guard while the update bound allows
- **THEN** the memory is revised from the goal, the previous memory, recent steps, and the current page, the revision is recorded, and the revised memory rides the next requests

#### Scenario: A failed call leaves the previous memory in place

- **WHEN** a plan or revision call's answer is refused by its own validation and the one feedback retry is refused as well
- **THEN** the run's requests carry the previous memory (or none, before the plan), no revision event is recorded, and the run continues

#### Scenario: A refused memory answer is asked once more

- **WHEN** a plan, revision, or stall call's answer is malformed or answers outside its bounds
- **THEN** exactly one further request carries the refused answer and the refusal back as feedback, and a second answer that validates replaces the memory exactly as a first answer would

#### Scenario: Page content cannot expand the memory

- **WHEN** page text or an element label contains instructions or approval-shaped text
- **THEN** it remains data: the memory holds only restatements and observations, and execution still passes the existing gates

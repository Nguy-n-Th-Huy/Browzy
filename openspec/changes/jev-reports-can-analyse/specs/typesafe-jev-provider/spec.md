# typesafe-jev-provider delta

> Written against the spec as it stands once `jev-runs-answer-the-operator` has
> landed, since it modifies the requirement that change adds. Rebase if the
> archive order differs.

## MODIFIED Requirements

### Requirement: Every run answers the operator

A TypeSafe run SHALL end with an answer addressed to the operator, whatever outcome it reached. After the outcome and reason are decided and before the terminal record is emitted, the run SHALL produce exactly one **final report** and emit it as the run's own result text, so a finished run carries an answer in the conversation exactly as a run driven by the other engines does.

The report SHALL be produced by the configured decision model, from the goal, the run's outcome and reason, the run memory when one exists, the recent steps with their outcomes, and **the observations the run accumulated over its whole course** — not the final observation alone. The accumulation SHALL hold one bounded record per successful observation, carrying that page's identity and its bounded text; it SHALL contribute one record, not many, for a page observed repeatedly without changing; it SHALL be bounded in total, dropping the OLDEST records first when it does not fit and disclosing how many were dropped; and it SHALL be material for the answer only — never summarised by a model, never carried into a step decision, and never able to steer one.

The report SHALL be bounded, strictly validated, and refused like any other answer this loop accepts; a refused answer SHALL be asked again exactly once, carrying the refusal back as feedback.

**What the answer may contain.** Every *factual* claim SHALL trace to the material the run was given: a value the material does not contain SHALL NOT appear, and an outcome the run did not reach SHALL NOT be claimed. An *inference* — a ratio computed from given figures, a comparison, a pattern across them, a risk or a judgment they support — SHALL be permitted, SHALL name the facts it rests on, and SHALL be recognisable as the answer's own reasoning rather than as something the source stated. An answer SHALL NOT present a conclusion as a quotation, and SHALL NOT withhold an obvious conclusion merely because the source did not state it in those words.

**What shape the answer takes.** When the goal asked for an action on the page, the answer SHALL state what was accomplished, what was not, and why, in that order, and SHALL stay brief. When the goal asked for analysis, an assessment or a report, the answer SHALL open with its conclusion and the basis for it, then the evidence, then what could not be established from the material available — and its bound SHALL be large enough to hold an assessment rather than a paragraph. The kind of goal SHALL be judged from the goal itself by the model writing the answer; the host SHALL NOT classify goals by keyword.

Exactly one result text SHALL be emitted per run. A run whose completion check already produced a report for a confirmed `DONE` SHALL keep that report and SHALL NOT make a second call; that report SHALL follow the same content and shape rules as the final report. Every other terminal outcome SHALL make the final report call, with two exclusions: a run that produced no observation at all, and a run whose terminal failure is that the decision model could not be reached.

The call SHALL be advisory with respect to the run's outcome: a refusal, a transport failure, or an unusable answer SHALL leave the outcome and reason exactly as they were, SHALL be disclosed on the terminal record as a report failure, and SHALL never be replaced by host-written prose. The report SHALL carry no capture and SHALL NOT dispatch anything.

#### Scenario: An analysis answers with a conclusion, not a transcription

- **WHEN** the goal asked for an analysis or an assessment and the run gathered the material for it
- **THEN** the answer opens with its conclusion and the basis for it, states the ratios, comparisons and risks the facts support while naming those facts, and does not merely restate the source's fields in the source's own order

#### Scenario: An inference is allowed, a fabrication is not

- **WHEN** the answer computes a ratio from figures the material shows, or names a pattern across them
- **THEN** that is permitted and the facts it rests on are named; a value the material does not contain still never appears, and no outcome the run did not reach is ever claimed

#### Scenario: An action goal keeps its short answer

- **WHEN** the goal asked for an action on the page
- **THEN** the answer states what was accomplished, what was not, and why, in that order, and stays brief

#### Scenario: The answer can look back over the run

- **WHEN** a run observed several distinct pages before it ended
- **THEN** the report is written from all of them, each identified by the page it came from, not from the final observation alone

#### Scenario: A page observed repeatedly costs one record

- **WHEN** a run observes the same unchanged page many times — a menu opening and closing, a stall
- **THEN** the accumulation holds one record for it, and the budget is spent on distinct pages instead of repeats

#### Scenario: The accumulation is bounded and its loss is disclosed

- **WHEN** the accumulated observations exceed their budget
- **THEN** the oldest records are dropped first, the context discloses how many were dropped, and the answer is still produced

#### Scenario: A blocked run explains itself

- **WHEN** a run ends blocked — no progress, an exhausted bound, a denied approval, an unresolved target, or a limit the page imposes
- **THEN** one final report is produced from the goal, the outcome and reason, the memory, the recent steps and the accumulated observations, it is emitted as the run's result text, and it states what was accomplished, what was not, and why

#### Scenario: A stopped run still reports what it did

- **WHEN** the operator stops a run after some steps executed
- **THEN** the run's outcome remains stopped and a final report of what was done up to the stop is emitted; a stop that lands while the report call is in flight leaves the outcome untouched and the missing report disclosed

#### Scenario: A confirmed completion makes no second call

- **WHEN** the completion check confirms the goal and produces its report
- **THEN** that report is the run's one result text, it follows the same content and shape rules, no final report call is made, and the terminal record marks completion as verified

#### Scenario: Nothing to report

- **WHEN** a run fails before any observation succeeded, or its terminal failure is that the decision model could not be reached
- **THEN** no final report call is made, no result text is emitted, and the terminal record discloses the absence rather than presenting an empty answer

#### Scenario: A failed report never changes the outcome

- **WHEN** the final report call fails, is refused twice, or answers outside its bounds
- **THEN** the run's outcome and reason are exactly what they were, the report failure is recorded on the terminal record, and no host-written text is substituted

#### Scenario: The report cannot claim more than the run reached

- **WHEN** the run ended blocked or stopped
- **THEN** the report presents no completion, names the limit that ended the run, and reports only facts present in the material it was given

## MODIFIED Requirements

### Requirement: Step decisions from the configured model

Every step the run executes SHALL come from the configured model as one strictly validated decision, made after the current observation and carrying the goal, the run memory/context when present, the page identity and bounded text, the recent steps, and — when screenshots are enabled and the cycle's capture succeeded — the current page capture. The decision SHALL name an operation from the run's vocabulary (`CLICK`, `TYPE_TEXT`, `SELECT`, `HOVER`, `NAVIGATE`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `DONE`, `BLOCKED`); for `CLICK`, `TYPE_TEXT`, `SELECT`, and `HOVER` it SHALL carry a bounded, plain-language intent naming the element to interact with, and the run SHALL resolve that intent to an element through the element-selection request (see "Single-request decision protocol with strict validation") before anything dispatches. A decision that is not exactly the required shape — a missing field, a wrong type, a value outside its bound, an unknown operation, or an unrecognized key — SHALL be refused as an invalid decision, and nothing SHALL be dispatched from it. An answer the decision's own validation refuses — a decision that is not exactly the required shape, a `TYPE_TEXT` decision without a usable value, or a `NAVIGATE` decision whose URL fails validation — SHALL be asked again exactly once, carrying the refused answer and the refusal back as feedback; only a second refusal is acted on: a second malformed decision ends the run with a named invalid-decision failure, a second answer without a usable value ends the run blocked with a missing-value outcome, and a second invalid URL is the named failure that navigates nothing. A well-formed decision whose operation has no compatible element in the current observation SHALL NOT end the run: it SHALL be recorded as a skipped step with a target-unresolved reason, count toward the no-progress bound, and let the loop continue with the failure visible in the recent steps. A `TYPE_TEXT` decision whose value is missing SHALL type nothing, and once its one feedback retry has not produced a usable value the run SHALL end blocked with a missing-value outcome. A `DONE` decision SHALL go through the completion check before any done outcome (see "Bounded run and honest outcomes"); a `BLOCKED` decision SHALL end the run blocked. `SCROLL_*` and `WAIT` decisions need no element and SHALL dispatch through the existing computer actions on the guarded path. A `HOVER` decision's intent SHALL be resolved to an element through the element-selection request like a `CLICK`'s, and its dispatch SHALL move the pointer over that element without clicking it — once, through the existing computer actions on the guarded path — so a menu or tooltip that opens only while the pointer rests on it can be opened before a later step selects one of its items. The decision SHALL follow the run memory's own plan and notes: it SHALL NOT repeat an action those notes call ineffective, it SHALL choose the control the notes name for the next step, and when what the goal needs cannot be obtained from the current page with the available operations (an access, login, or gating limit) it SHALL choose `BLOCKED` naming that reason instead of repeating ineffective actions; when the goal asks for information or analysis and the gathered material is sufficient, it SHALL choose `DONE` so the completion check can render the answer.

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
- **THEN** the answer is asked again exactly once with the refusal carried back as feedback; a second malformed answer dispatches nothing and ends the run with a named invalid-decision failure

#### Scenario: A refused answer is asked once more

- **WHEN** the step decision's answer is refused by its own validation — a malformed shape, a missing text value, or an invalid URL
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

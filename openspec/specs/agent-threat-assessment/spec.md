# agent-threat-assessment Specification

## Purpose
Inspects returned web content for instructions aimed at the agent and scores what each tab appears to be for, surfacing both as warnings that inform the user and raise visible risk without ever deciding whether an action proceeds.

## Requirements

### Requirement: Returned web content is probed for agent-directed instructions before the agent acts on it
The runtime SHALL scan web content returned by a tool for text that attempts to instruct the agent, before that content is available for the agent to act on. A finding SHALL record what was matched, where in the content it appeared, and which tool returned it. The probe SHALL run on content the agent reads from a page, including extracted text, accessibility trees, and page-tool results. A finding SHALL NOT by itself prevent an action from dispatching.

#### Scenario: Injected instruction in page text
- **WHEN** a run extracts page text containing an instruction addressed to the agent
- **THEN** a finding is recorded naming the matched text, its location in the content, and the tool that returned it, and the content is still delivered to the agent

#### Scenario: Clean content
- **WHEN** returned content contains no agent-directed instruction
- **THEN** no finding is recorded and the content is delivered unchanged

#### Scenario: A finding does not block
- **WHEN** a finding is recorded and the agent then attempts an action
- **THEN** the action is decided by the permission policy alone, and the finding does not refuse it

#### Scenario: The finding is not itself an instruction
- **WHEN** matched text is recorded, surfaced, or included in a warning
- **THEN** it is carried as quoted data that is never interpreted as an instruction to the agent or to the runtime

#### Scenario: Probe failure
- **WHEN** the probe cannot complete for a piece of returned content
- **THEN** the content is delivered, the probe's failure is recorded distinguishably from a clean result, and the run is not blocked

### Requirement: Findings and risk are surfaced as warnings, never as decisions
An injection finding and a tab risk category SHALL be surfaced to the user as warnings, visually and semantically distinct from a request for a decision. A warning SHALL NOT present allow/deny controls, SHALL NOT suspend a run, and SHALL NOT be resolvable as an approval. Where the permission policy does ask for a decision on an action, any finding or risk relevant to that action SHALL be shown alongside the request as context.

#### Scenario: A warning carries no decision controls
- **WHEN** an injection finding is surfaced
- **THEN** it appears as a warning with no allow or deny control, and no run is suspended by it

#### Scenario: Warning shown as context on a real decision
- **WHEN** the permission policy suspends an action on a tab that has a finding or an elevated risk category
- **THEN** the decision request displays that finding or risk as context, while the decision itself remains the user's

#### Scenario: A warning is not an approval
- **WHEN** a user dismisses or acknowledges a warning
- **THEN** no action is authorized by that acknowledgement, and any action requiring a decision still requires its own

### Requirement: Each tab carries a risk category derived from observable signals
The runtime SHALL assign each tab a risk category derived from observable signals about what the tab is for, and SHALL recompute it when the tab's document identity changes. The category SHALL be visible for the tab the agent is controlling and in the panel. A category SHALL NOT by itself refuse an action, change the permission mode, or alter a remembered per-site decision. The signals contributing to a category SHALL be inspectable by the user.

#### Scenario: An elevated-risk tab
- **WHEN** the agent controls a tab whose signals indicate a higher-risk purpose
- **THEN** the tab's category is shown as elevated on the controlled tab and in the panel, with its contributing signals inspectable

#### Scenario: Category does not gate
- **WHEN** a tab carries an elevated category and a run attempts an action the active mode allows
- **THEN** the action proceeds, and the category does not refuse it or escalate the decision requirement

#### Scenario: Recomputation on navigation
- **WHEN** a controlled tab's document identity changes
- **THEN** its category is recomputed for the new document, and the previous document's category is not carried forward

#### Scenario: Insufficient signals
- **WHEN** a tab's signals are insufficient to assign a category
- **THEN** the tab is shown as uncategorized, distinguishable from a category of low risk

#### Scenario: An injection finding raises the tab's risk
- **WHEN** a finding is recorded for content returned from a tab
- **THEN** that tab's risk category reflects the finding, and the finding is listed among the contributing signals

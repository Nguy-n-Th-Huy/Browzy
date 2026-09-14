## Purpose

Offer fast, predictable entry points for frequent browser tasks while keeping every consequential action behind the existing policy gate.

## ADDED Requirements
### Requirement: Built-in slash workflows
The picker SHALL provide `/summarize`, `/research`, `/extract`, and `/fill-form` with editable arguments.
#### Scenario: User selects summarize
- **WHEN** `/summarize` is submitted with no URL
- **THEN** the workflow uses the bound page and presents the result in the conversation.
### Requirement: Safe dispatch
Built-in workflows SHALL use the same approval, scope, and untrusted-page-content rules as free-form requests.
#### Scenario: Fill form requires submission
- **WHEN** a workflow reaches a send or submit action
- **THEN** it pauses for explicit approval and shows the exact target and values.

### Requirement: Workflow reruns fetch live content
Every workflow execution that retrieves page or site content SHALL obtain it from the live source at execution time. A stored workflow definition SHALL NOT embed previously fetched content, and a prior run's output SHALL NOT be returned as a fresh result.

#### Scenario: Rerun reflects the current page
- **WHEN** a stored workflow is executed again after its source page changed
- **THEN** the result reflects the live page, not the earlier output

#### Scenario: Freshness is visible on results
- **WHEN** a workflow returns retrieved content
- **THEN** the result identifies its source and when it was retrieved

### Requirement: Derived workflows prove themselves before they are offered as ready
A workflow draft derived from a recording or a completed run SHALL be validated by live re-execution before it can be enabled: the draft runs against live content, its output is checked before the workflow is offered as runnable, and the validation output is retained as evidence. A draft that cannot be validated SHALL remain a draft and SHALL NOT be silently enabled.

#### Scenario: A derived draft is tested before it is enabled
- **WHEN** a workflow draft is derived from a recording or a completed run
- **THEN** it is executed against live content and its output checked, with the check's output retained as evidence, before it is offered as enabled

#### Scenario: An unvalidated draft stays a draft
- **WHEN** a derived draft fails validation — the execution fails or produces no usable result
- **THEN** it remains a draft and is not presented as a runnable workflow

#### Scenario: A draft derived from an existing tab proves on that tab
- **WHEN** a draft is derived from work done on a tab the operator already had open, and that tab is the proof's target
- **THEN** the proof's steps execute against that live tab — admitted for exactly that tab, for the duration of the proof — rather than being refused as outside the extension's scope

#### Scenario: The proof's admission does not outlive the proof
- **WHEN** a proof has finished (or was refused before running)
- **THEN** no tab retains any authorization from it: the same tab is refused again outside a proof, and no other tab was ever admitted by it

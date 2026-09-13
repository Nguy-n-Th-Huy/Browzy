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

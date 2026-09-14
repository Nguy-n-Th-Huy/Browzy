## Why

A recording will always carry something wrong — a mistaken step, a stale target, an exploratory click the model took while thinking (the dauthau.asia select-click of 2026-09-14 is the canonical example). Until now the only repair paths were re-recording the whole flow or waiting for a drift and approving a model-authored heal proposal; the operator could not touch the steps themselves. Operator decision, 2026-09-15: *"kiểu gì trong quá trình cũng sai — cho phép sửa workflow"*.

## What Changes

- **The panel can fetch a stored definition for editing.** A saved/enabled card gains a "Sửa" action; `workflow_edit_request` returns the record's current `steps` (read-only, resolvable by exact version or latest), and the card opens an editor seeded with those — never with the card's possibly-stale derivation.
- **Editing is per-step and explicit:** each row shows the step identity read-only plus its `args` as editable JSON, with a remove control. Saving (`workflow_edit_save`) is all-or-nothing: rows with unparseable or non-object args are refused locally with the row named, and the host validates the whole array through the same registry door a heal candidate uses.
- **A save is a new version, never an overwrite.** The bump goes through `updateWorkflow`: earlier versions stay addressable, the edited version carries the record's current enablement state (same rule as heal approval), and its provenance names the version it was edited from. A stale `version` is refused with the current one disclosed; an identical steps array is refused as `NO_CHANGE` rather than minting an empty version.
- **An edited version is unproven by construction.** The save stores it disabled; the card returns to "saved" and the proof has to pass again before enablement. The durable `workflow_updated` event moves any panel onto the written version.

## Capabilities

### Modified Capabilities

- `agent-skills`: adds the operator-edit requirement — a stored workflow's steps are editable by the operator, the edit is validated by the registry, saved as the next disabled version, and never changes the enablement state or replaces history.

## Impact

- `host/agent/protocol.js` — `workflow_edit_request` / `workflow_edit_save` envelope types + the `workflow_updated` event.
- `host/agent/companion.js` — `_handleWorkflowEditRequest` / `_handleWorkflowEditSave` (validate via `validateHealCandidate`, bump via `updateWorkflow`).
- `extension/sidepanel/protocol-client.js`, `panel-controller.js`, `conversation-model.js`, `sidepanel.js`, `sidepanel.css` — the two operations, the edit state machine, the editor rendering, and the row→steps builder.
- Tests: `host/test/workflow-prove-bridge.test.mjs` (fetch/save/refusals/enablement-preserved) and `test/sidepanel-workflow-cards.test.mjs` (wire shapes, editor rendering, refusals, event application).

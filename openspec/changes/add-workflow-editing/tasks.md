## 1. Host (protocol + companion)

- [x] 1.1 `workflow_edit_request` / `workflow_edit_save` envelope types and the `workflow_updated` transcript event (protocol.js both sides).
- [x] 1.2 `_handleWorkflowEditRequest`: resolve the exact version (or latest), return `{workflowId, version, name, steps}`; unknown workflow/conversation refused by name. ← (verify: `host/test/workflow-prove-bridge.test.mjs`)
- [x] 1.3 `_handleWorkflowEditSave`: latest-version check (`stale_version` + disclosed latest), `validateHealCandidate` (registry codes, `NO_CHANGE`), `updateWorkflow` bump with `provenance.editedFrom`, enablement preserved, `workflow_updated` emitted. ← (verify: v2 stored, v1 addressable, stale/NO_CHANGE/unsafe refused with nothing written, enabled line stays enabled)

## 2. Panel (protocol client + controller + model + render)

- [x] 2.1 `workflowEditRequest` / `workflowEditSave` client ops + controller methods returning the reply untouched (an unanswered op claims nothing).
- [x] 2.2 Model edit state: `beginWorkflowEditLoad` / `settleWorkflowEditLoad` / `replaceWorkflowEditSteps` / `setWorkflowEditProblem` / `cancelWorkflowEdit` / `beginWorkflowEditSave` / `settleWorkflowEditSave`; `workflow_updated` application; a saved edit drops to `saved` with the proof cleared. ← (verify: panel suite)
- [x] 2.3 Card rendering: "Sửa" on saved/proved/enabled cards; edit view rows (identity read-only, args JSON input, remove control); save/cancel actions; local and host problems rendered on the card. ← (verify: rows/inputs/actions asserted against the shipped renderer)
- [x] 2.4 Pure step builder (`parseWorkflowEditArgs` / `applyWorkflowEditArgs` / `buildWorkflowEditSteps`): empty input = no args, invalid JSON refuses by row index, identity fields untouched. ← (verify: panel suite)
- [x] 2.5 Delegation wiring for edit/edit-save/edit-cancel/remove-step + CSS for the edit rows.

## 3. Verification

- [x] 3.1 `node host/test/workflow-prove-bridge.test.mjs` — 19/19 (2 new tests).
- [x] 3.2 `node test/sidepanel-workflow-cards.test.mjs` — all passed (23 new assertions).
- [x] 3.3 Full sweeps (`node test/*.test.mjs`, `node host/test/*.test.mjs`) — no regressions beyond the pre-existing reds.
- [ ] 3.4 Live follow-up (operator): "Sửa" on the dauthau card, remove the stray step, save → new version, prove, enable.

## Why

Saving a reviewed draft refused with `DUPLICATE_IDENTITY` whenever the workflow id was already stored — `createWorkflow` is create-only. The operator hit it live (re-deriving the same dauthau.asia workflow made "Lưu bản nháp" impossible) and settled the semantics explicitly on 2026-09-15: *"cứ có là tăng để lưu hết"* — a save always means "store what I reviewed"; when the id exists, the version bumps.

## What Changes

- **`workflow_draft_save` no longer refuses on `DUPLICATE_IDENTITY`.** The save persists the NEXT version through the store's existing version-bump mechanics (`updateWorkflow`); earlier versions remain addressable.
- **The bumped version is stored disabled, exactly like a first save.** A derived draft never enables itself — a bump must not become the one path that turns a proof-less change into an enabled workflow, and it can never silently re-enable one the operator disabled.
- **Provenance stays host-written** and names the version it replaced (`supersededVersion`); the `workflow_draft_saved` event and the reply carry the new version, so the panel card keeps working unchanged (prove/enable key off the id).
- **Every other validation error still refuses** with the registry's own codes (unsafe step kinds, malformed targets, invalid id/owner) — the bump covers identity collisions only and is never a validation bypass.
- **Heal is untouched**: drift repair keeps its propose → approve → save discipline. This changes only what the operator's own save button means.

## Capabilities

### Modified Capabilities

- `agent-skills`: the draft-save path gains the "a save always stores what was reviewed — the next version when the id exists, disabled until proven" requirement; the registry's own validation remains the only refusal source.

## Impact

- `host/agent/companion.js` — `_handleWorkflowDraftSave`'s duplicate branch (+ its doc comment).
- `host/test/workflow-prove-bridge.test.mjs` — the colliding-save case now asserts the bump: v2 stored disabled, v1 addressable, `supersededVersion: 1`, the event carries v2.

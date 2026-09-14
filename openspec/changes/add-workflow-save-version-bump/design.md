# Design

## Context

`createWorkflow` is create-only: an identical id@1 is a refusal by design. Evolution had exactly one path — heal (propose → approve → save) — which requires a drift. But a re-derived draft of the same workflow is a normal, expected save: the operator re-records, fixes, re-derives. Refusing that with an error code the operator cannot act on from the card is a dead end, and the operator has ruled on it: bump instead.

## Decisions

### 1. Bump, never overwrite

On `DUPLICATE_IDENTITY`, the save routes through `updateWorkflow` — the store's one version-bump path — so earlier versions stay addressable and nothing is silently replaced in history. Not a merge, not an overwrite: a new version beside the old ones.

### 2. The bumped version is disabled, exactly like a first save

"Drafts are never enabled by their own save" is load-bearing — it is what keeps proof-before-enable honest. A bump must not become the path that turns a proof-less change into the live version. The reply and event carry the new version so the card's prove/enable flow acts on it, unchanged.

### 3. Only identity collisions bump

Any other `WorkflowValidationError` (unsafe step kinds, malformed targets, invalid id/owner) still refuses with its own code — a save never becomes a bypass for validation.

### 4. Provenance names the replaced version

Host-written, as always: `{materializedFromRun, conversationId, materializedAt, supersededVersion}` — the last field is new and records which version this save replaced, so a version history reads without guesswork.

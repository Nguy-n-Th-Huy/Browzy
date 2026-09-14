# Design

## Context

The registry already owns every mechanic an edit needs: `updateWorkflow` bumps a version preserving `createdAt` and addressability; `validateHealCandidate` runs a steps array through the same registry validation a heal proposal passes (unsafe kinds refused, identical arrays refused as `NO_CHANGE`); the panel already renders a steps list with per-step identity, and the card states (review → saved → proved → enabled) already encode "a saved version is disabled until a proof passes". Editing is those pieces wired together by the operator's own hand.

## Decisions

### 1. Fetch the definition from the host; never edit the card's copy

The card's step list is a derivation shown for review; the record's actual steps live host-side and may have moved on (another editor, a heal). `workflow_edit_request` returns the CURRENT steps — the editor's inputs are seeded from the record, so an edit can never silently rebase onto a stale list.

### 2. Per-step rows, all-or-nothing save

Rows expose the step identity read-only and its `args` as a single JSON input, plus a remove control. The row inputs are merged back into the steps at save time, in order; one unparseable or non-object row refuses the whole save locally (row named, nothing sent). The alternative — a free-form whole-array JSON editor — was rejected as a footgun: it makes every JSON typo a rewrite of the whole definition, and it cannot show a proof's per-step verdicts beside each step.

### 3. Save = the next version, with the heal rules

`workflow_edit_save` requires the line's LATEST version (stale edits refused with the current version disclosed, exactly like enable), validates through `validateHealCandidate`, and bumps via `updateWorkflow`. The new version carries the record's current enablement state and `provenance.editedFrom`. It is stored disabled when the line was disabled — and when the line was enabled, the edit keeps it enabled, the same "enablement state is unchanged by the save" rule heal approval uses; nothing about this path re-enables a disabled workflow.

### 4. An edit invalidates the proof

The edited version is a different definition: the card drops to "saved", the previous proof verdict and outcomes are cleared, and enablement must be earned by a new proof of the new version. The durable `workflow_updated` event carries `fromVersion`/`toVersion` so every panel (and a reload) lands on the written version.

### 5. Refusals are shown where the work is

A host refusal (`stale_version`/`invalid_candidate`/`save_failed`) keeps the editor open with the working copy intact and the reason (plus the current version when disclosed) rendered on the card; a local problem (bad JSON) is equally visible and blockable. Nothing is ever half-applied.

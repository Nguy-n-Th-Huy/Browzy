## ADDED Requirements

### Requirement: A stored workflow is editable by its operator
A stored workflow's steps SHALL be editable by the operator from the panel: the panel SHALL be able to fetch the record's current steps (starting from the record, never from a possibly-stale local copy) and save an edited steps array as the NEXT version of the line. A save SHALL pass the registry's own validation (unsafe step kinds and malformed targets refused with their error codes; an identical array refused rather than minting an empty version), SHALL leave every earlier version addressable, SHALL preserve the record's enablement state, and SHALL NOT enable anything by itself — the edited version is disabled until a proof passes. A `version` that is no longer the line's latest SHALL be refused with the current version disclosed, and a row-level input that cannot be parsed SHALL refuse the whole save with the offending row named, never half-apply.

#### Scenario: Fixing a wrong step
- **WHEN** the operator opens a stored workflow for editing, removes or corrects a step, and saves
- **THEN** the corrected steps are stored as the next version, the earlier versions remain addressable, and the card returns to the unproven state that requires a new proof before enablement

#### Scenario: An invalid edit is refused with its reason
- **WHEN** an edited steps array contains an unsupported step kind, a malformed target, or is identical to the stored definition
- **THEN** the save is refused with the registry's own error (or `NO_CHANGE`), nothing is written, and the editor keeps the working copy with the refusal shown

#### Scenario: A stale edit never lands on a newer record
- **WHEN** the operator saves an edit fetched from a version that is no longer the line's latest
- **THEN** the save is refused as `stale_version` with the current version disclosed, and the newer record is left untouched

#### Scenario: Editing never flips enablement
- **WHEN** a disabled workflow is edited, or an enabled one is
- **THEN** the new version carries the record's enablement state unchanged — an edit can neither enable a disabled workflow nor disable a running one

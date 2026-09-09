## Purpose

Deliver compatible Rust-based extension and companion packages with predictable upgrades, explicit rollback and preserved assistant features.

## ADDED Requirements

### Requirement: Stable complete installation
Release installation SHALL preserve extension identity and exact native allowed origins, supply validated supported runtime components, and require no developer toolchain or repeated ID entry. Unverified platform combinations SHALL be labeled unsupported for the Rust release.

#### Scenario: Install and restart
- **WHEN** a supported user installs the complete release and restarts the browser
- **THEN** the keyed extension connects to the registered Rust host and compatible SDK adapter without manual runtime launch

### Requirement: Versioned migration and rollback
Upgrade SHALL validate component compatibility before switching registration and migrate configuration atomically with a backup. Rollback SHALL restore a compatible previous installation without deleting user recordings, skills or newer data that must be retained separately.

#### Scenario: Interrupted upgrade
- **WHEN** package validation or configuration migration fails
- **THEN** the previous working registration and data remain recoverable and no partially upgraded runtime is presented as ready

### Requirement: Product parity before cutover
Release SHALL pass the baseline SDK product requirements for accountless onboarding, provider/model settings, skills, polished UI, current-page reading, visible cursor, action timeline, all browser tools and recordings. Language migration SHALL not weaken permissions or remove features to pass validation.

#### Scenario: Regression found
- **WHEN** an acceptance case loses a browser operation, reads the wrong page, exposes a secret, duplicates an action or requires Claude login
- **THEN** release cutover is blocked until corrected and the legacy baseline remains available

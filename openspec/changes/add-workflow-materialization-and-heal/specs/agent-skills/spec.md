## ADDED Requirements

### Requirement: Materialization from a completed run
The host SHALL be able to derive a workflow draft from a completed run's recorded action trail and its bound context: each recorded action SHALL map onto one of the existing step kinds (`skill`, `tool`, or `message`); the draft SHALL carry the run's domain and document bindings; and a value that cannot be resolved to a concrete, reviewable value SHALL be reported as a specific incompleteness reason rather than guessed. A draft SHALL be surfaced for review and SHALL NOT be enabled by the derivation itself.

#### Scenario: A successful run becomes a reviewable draft
- **WHEN** a run completes and the operator asks to save its repeated work as a workflow
- **THEN** a draft is derived from the run's recorded actions and bound context and is presented for review before anything is enabled

#### Scenario: A partially-resolvable trail is reported, never guessed
- **WHEN** some recorded action cannot be mapped to a known step kind or a required value cannot be resolved from the trail
- **THEN** the draft is withheld and each gap is reported as a specific incompleteness reason, never as a partial draft presented as complete

#### Scenario: Sensitive steps keep failing closed
- **WHEN** a derived draft contains a step that requires approval
- **THEN** the draft follows the existing fail-closed approval rules exactly as an authored workflow would, and the derivation never marks such a step pre-approved

### Requirement: Drift is a distinguishable execution outcome
A stored workflow's execution SHALL end in a structured drift outcome — never a plain success and never an undifferentiated failure — when a step's target no longer resolves on the live page, when the bound domain or document no longer matches the live context, or when a data-retrieving step cannot produce a result shown to come from the live source. The drift outcome SHALL name the step and the evidence it is based on. Transient conditions unrelated to the stored definition SHALL remain ordinary failures and SHALL NOT be reported as drift.

#### Scenario: The site changed under a stored workflow
- **WHEN** a rerun's step target no longer exists on the live page
- **THEN** the execution ends with a drift outcome naming that step and the missing target, not a generic failure and not a success

#### Scenario: The bound document changed
- **WHEN** the live document no longer matches the execution's bound document
- **THEN** the existing stale-document check is surfaced as a drift outcome with its evidence

#### Scenario: A transient failure is not drift
- **WHEN** a step fails for a reason unrelated to the stored definition, such as a transport error
- **THEN** the outcome is an ordinary failure distinguishable from drift, and no repair is proposed

#### Scenario: A healthy rerun stays untouched
- **WHEN** a stored workflow executes successfully against the live source
- **THEN** its definition is not modified and no repair is proposed

### Requirement: Healing proposes a new version and never rewrites silently
A repair of a drifted workflow SHALL take the form of a proposed new version of the definition: produced by inspecting the live site with the existing tools, validated by the same registry validation as any authored or imported workflow, saved as a new version through the existing version-bump mechanics with earlier versions remaining addressable, and enabled only after an explicit operator approval. The proposal SHALL carry provenance naming the version it heals and the drift evidence it addresses, and a rejected or expired proposal SHALL leave the stored definition and its executions unchanged.

#### Scenario: A drifted rerun yields a proposal, not an edit
- **WHEN** a workflow execution ends in drift
- **THEN** the assistant may propose a healed definition for review, the stored definition is unchanged until approval, and further executions use the existing version

#### Scenario: Approval saves exactly one new version
- **WHEN** the operator approves a healed proposal
- **THEN** a new version is saved with provenance naming the healed version and the drift evidence, and the previous version remains addressable

#### Scenario: Rejection and expiry leave everything as it was
- **WHEN** the operator rejects a proposal or it expires unanswered
- **THEN** no version is saved, no execution behavior changes, and the outcome is distinguishable from an approval in the record

### Requirement: Materialization and healing introduce no new step kinds
Workflow definitions produced by materialization or healing SHALL remain data within the existing step kinds (`skill`, `tool`, `message`), and any proposal that would require a different kind of step, such as stored executable code, SHALL be rejected by the registry's existing validation exactly as any unsupported definition is.

#### Scenario: A proposed heal cannot smuggle in an executor
- **WHEN** a healed definition contains a step kind outside the supported set
- **THEN** validation rejects it, nothing is saved, and the rejection names the unsupported kind

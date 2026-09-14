## 1. Draft derivation from a run trail

- [x] 1.1 New `host/agent/skills/workflows-materialize.js`: map a run's sanitized action-timeline events into the event shape `buildRecordingDraft()` consumes, reusing its fully-resolved-or-incomplete contract; input is the run's trail + bound context (domain/document) only.
- [x] 1.2 Conservative parameterization per design.md decision 3: identical, context-independent literals become constants; context-dependent-looking values surface as specific incompleteness reasons. No speculative generalization.
- [x] 1.3 Validate a derived draft through the existing registry validation (`workflows-schema.js`) before it is ever presented; unsupported kinds and auto-approve fields are rejected exactly as for authored definitions. ← (verify: a draft containing an unsupported step kind or an auto-approve field is rejected with the existing validation errors; a partially-resolvable trail yields specific reasons and no partial draft)

## 2. Materialization surfacing

- [x] 2.1 Host API + conversation surface to offer "save as workflow" for a completed run and to present the derived draft for review (steps, bindings, params, approvals named) before anything is enabled.
- [x] 2.2 Enabling path stays exactly the existing workflow save/enable path — the derivation itself never enables, and duplicate identities follow the registry's existing duplicate rules. ← (verify: a saved draft passes the same validation and approval path as an authored workflow; no new enable flag or shortcut exists)

## 3. Drift classification

- [x] 3.1 Classify step-boundary outcomes in `workflows-run.js`: target-no-longer-resolves, binding mismatch (reuse `checkDocumentFreshness`), freshness-contract violation on data steps; produce `{outcome:"drift", step, reason, evidence}` and surface it to the conversation. Transport-class failures stay ordinary failures.
- [x] 3.2 Record drift outcomes durably (conversation transcript) so the repair flow and later review can cite the evidence; healthy executions never emit drift and never modify the definition. ← (verify: drift vs ordinary-failure vs success are distinguishable in the transcript and the outcome object; a healthy rerun leaves the definition byte-identical)

## 4. Heal proposal

- [x] 4.1 Proposal object + assembly: candidate definition (agent-built with ordinary tools against the live site), provenance `{healedFrom, reason, evidence, proposedAt}`, drift reference; validated like an import before presentation; one live proposal per workflow (new supersedes pending).
- [x] 4.2 Approval flow: explicit Allow/Deny review card bound to the proposal id with bounded expiry resolving to a distinguishable timeout; Allow invokes `updateWorkflow` (version bump, provenance history preserved); Deny/expiry is a no-op. No auto-approve path. ← (verify: rejection/expiry leaves the stored definition and executions unchanged and is recorded distinguishably; approved heal saves exactly one new version with provenance naming the healed version)
- [x] 4.3 Rollback discipline: previous versions remain addressable through the existing registry semantics; tests prove the pre-heal version still executes after a heal. ← (verify: after a heal, the previous version is still addressable and runnable; nothing about it was mutated)

## 5. Panel / settings surfacing

- [x] 5.1 Draft review card and heal proposal card built on the existing approval-card and skills surfaces (explicit Vietnamese copy naming the subject as a workflow repair, distinguishable from tool approvals); drift notice in the conversation names the step and evidence.
- [x] 5.2 Keyboard/accessibility parity with existing cards; visuals reviewed at the established 320/400/480 widths in both themes.

## 6. Tests and sweeps

- [x] 6.1 New host tests: materialization derivation (complete, partial, redacted-value, unsupported-kind cases) and heal lifecycle (propose/approve/reject/expire/supersede, provenance, version rollback).
- [x] 6.2 Drift classification tests pinning drift vs ordinary failure vs success for each reason class, including the document-freshness mapping.
- [x] 6.3 Extend `host/test/skills-workflows.test.mjs` where its existing harness covers the same modules; run it plus `node host/test/*.test.mjs` sweep. ← (verify: new tests fail before the implementation and pass after; no pre-existing suite regresses)
- [x] 6.4 Panel-side tests for the review/notice surfaces following the existing extract-based patterns; enhancement/approval availability rules elsewhere are untouched.

## 7. Docs and status

- [x] 7.1 README side-panel status and skills documentation updated only once the behavior ships; the freshness/proof-run contract from `side-panel-workflows` and this lifecycle are described together, not promised ahead of the build.

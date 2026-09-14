## Context

See proposal.md — Why for motivation. Current state this design builds on (all anchors verified by reading):

- The registry is strict data: versioned records with `id/version/owner/.../steps/provenance/requiredCapabilities`; `updateWorkflow` persists the next version and preserves provenance history; import re-validates untrusted input; only step kinds `skill | tool | message` pass `workflows-schema.js` (anything executable — `script`, `shell`, `eval` — is rejected as an unsafe capability; an `autoApprove` field anywhere is itself a validation error).
- Draft derivation already exists for recordings: `buildRecordingDraft()` in `workflows-run.js` offers a draft ONLY when every step, parameter, domain, and document binding is fully resolved, returning `{ok:false, incomplete:[reasons]}` otherwise — never a partial draft.
- Execution already stops at the first failing step and already has a document-freshness check (`checkDocumentFreshness`), and the plan/review surface (`planWorkflowExecution`) names steps, approvals, and scope without executing anything.
- The run's action trail is already recorded in sanitized form (`storage/action-timeline.js` on ingest; ACTION_EVENT envelopes from the extension) and is the secret-free, replayable record of what a run did.
- The sibling contract is `side-panel-workflows`' freshness and proof-run requirements: reruns fetch live; drafts are validated by live re-execution before enablement. This change supplies the lifecycle operations around that contract.

## Goals / Non-Goals

**Goals:**

- Close the loop: a successful run can become a workflow; a drifted workflow can be healed — both as reviewable, approval-gated, versioned data.
- Drift is honest: distinguishable from both success and transient failure, with named evidence.
- Everything reuses existing machinery: registry validation, version bumping, provenance, the approval surface, the executor as-is.

**Non-Goals:**

- No second executor, no script/executable steps (decision 8 stands; the new spec requirement binds this).
- No silent or automatic healing; no auto-enable anywhere in the loop.
- No change to `planWorkflowExecution`'s dispatch behavior beyond outcome classification.
- V1 parameter inference stays conservative: no speculative heuristics — unresolved values are reported, not guessed.
- No cross-machine sync of workflows or proposals.

## Decisions

1. **Materialize from the recorded trail, not from model memory.** The derivation input is the run's already-sanitized action-timeline events plus the run's bound context (domain/document), page bindings, and the operator's request — deterministic and replayable. Alternative rejected: asking the model to summarize what it did (unverifiable and un-reviewable against a record).

2. **One draft contract for recordings and runs.** Run-trail events are mapped into the same event shape `buildRecordingDraft()` consumes, so the `{ok:false, incomplete:[...]}` posture is reused verbatim: a draft exists only when fully resolved; gaps are specific reasons. This keeps exactly one definition of "reviewable draft" in the codebase.

3. **Conservative parameterization.** A literal that is identical everywhere it appears and does not depend on the run's context becomes a constant; values that look context-dependent (URLs, dates, per-run identifiers) are NOT silently generalized — they surface as incompleteness reasons the operator resolves by editing the draft. Never guess.

4. **Drift classification at the step boundary, with evidence.** The executor already stops at the first failing step; classification adds the *reason* vocabulary: target-no-longer-resolves, binding mismatch (domain/document, reusing `checkDocumentFreshness`), freshness-contract violation on a data step. A step failure with none of those signals stays an ordinary failure. The outcome is a structured result (`{outcome:"drift", step, reason, evidence}`) surfaced to the conversation and recorded — never a success, never a bare failure string.

5. **Heal = propose → approve → save.** A proposal is a conversation-scoped review object (definition candidate + provenance `{healedFrom, reason, evidence, proposedAt}` + drift reference), presented with explicit Allow/Deny controls in the existing approval-card idiom, bound to the proposal id, with bounded expiry resolving to a distinguishable timeout outcome. Approval invokes `updateWorkflow` (version bump; provenance history preserved); rejection/expiry is a no-op with a distinguishable record. Rollback is inherent: prior versions stay addressable.

6. **No new approval semantics.** The proposal card reuses the established bound-decision discipline (a decision applies to exactly that proposal; webpage content can never self-approve; unanswered decisions resolve distinguishably) without widening the send/submit gate — it is an application-level review, not a tool dispatch.

7. **Heal only on drift.** Repair is offered only after a drift outcome; a healthy rerun proposes nothing. This is what keeps approval fatigue bounded and makes "definition untouched" testable.

## Risks / Trade-offs

- [Risk] Trail-derived drafts carry args that were redacted on ingest (secrets are stripped by design) → Mitigation: a step whose exact value cannot be reconstructed is an incompleteness reason; the operator supplies it at review — the derivation never fabricates a value. Redaction is a feature of the input, not a bug to route around.
- [Risk] Over-eager drift classification (a transient hiccup recorded as drift, prompting needless repairs) → Mitigation: classification requires site-change evidence; transport-class failures are ordinary failures; tests pin the boundary with both classes.
- [Risk] Proposal fatigue → Mitigation: proposals only on drift, one live proposal per workflow version (a new one supersedes the pending one), rejection/expiry cleanly recorded.
- [Risk] Approval card confusion with tool approvals → Mitigation: distinct copy naming it as a workflow repair; same visual discipline, different subject.
- [Risk] Heal edits subtly change behavior beyond the drift → Mitigation: proposals are validated like imports and reviewed as a diff (steps named in the review surface); approval is per-proposal, and the previous version remains addressable for reuse.

## Edge cases (explicit handling)

- Heal proposed while an execution is running → executions use the version they started with; the proposal can be approved but never mid-run.
- Two drifts before review → newest proposal supersedes the pending one; the older one is recorded as superseded, never silently applied.
- Proposal for a workflow the operator disables meanwhile → approval still saves a new version; enablement state is unchanged by the save.
- Run trail contains a step the model executed but was rejected → rejected steps never materialize; only completed actions do.
- Recording-derived and run-derived drafts for the same workflow id → identical duplicate-identity rules as the registry already enforces; a draft colliding with an existing identity requires explicit resolution.
- Conversation deleted while a proposal is pending → the proposal dies with the conversation; nothing is saved.

## Migration Plan

No data migration: additive modules and outcome vocabulary; registry schema unchanged. Rollback: stop offering the materialize/heal entry points; stored workflows (healed or not) remain valid data.

## Open Questions

None blocking. Review-surface placement (composer card vs skills settings) and copy wording are implementation details confined to existing surfaces, decided during apply against the current UI patterns.

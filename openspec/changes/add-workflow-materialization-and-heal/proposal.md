## Why

Workflows are already a versioned, approval-gated data registry (`host/agent/skills/workflows-store.js`, `workflows-schema.js`, `workflows-run.js`) with its core guarantees encoded: definitions are DATA, not a second executor (decision 8); sensitive steps fail closed to approval; edits bump versions and earlier versions stay addressable; exports carry the definition only. What the registry cannot do today is close the reuse loop. A workflow is authored by hand or derived from a recording (and only when fully resolved), and once stored, nothing keeps it working: when the site changes underneath it, the next run fails — or worse, returns a stale-shaped success — and the operator is left to re-author by hand. The complementary freshness and proof-run contract lives in `side-panel-workflows`; this change adds the two lifecycle operations that contract implies but cannot perform by itself: turning a completed run into a reviewable draft, and healing a drifted workflow as a proposed new version.

## What Changes

- **Materialization**: the host can derive a workflow draft from a completed run's recorded action trail and bound context. Each recorded action maps onto an existing step kind (`skill | tool | message`); the draft carries the run's domain and document bindings; values that cannot be resolved to a concrete, reviewable value are reported as specific incompleteness reasons — never guessed. A draft is surfaced for review and is never enabled by the derivation itself.
- **Drift as a distinguishable outcome**: an execution ends in a structured drift outcome — never a plain success — when a step's target no longer resolves on the live page, when the bound domain or document no longer matches, or when a data-retrieving step's result cannot be shown to come from the live source. Transient failures (network, overload) remain ordinary failures and are never reported as drift.
- **Heal as a proposed new version**: on drift, the assistant diagnoses against the live site with ordinary tools and proposes an updated definition. Saving is a new version through the existing `updateWorkflow` mechanics (previous versions remain addressable), carries provenance naming the version it heals and the drift evidence it addresses, and requires an explicit operator approval before it is enabled. No silent rewrite; the schema's existing rejection of auto-approve fields continues to bind.
- **Heal only when needed**: a healthy rerun proposes no edit and leaves the definition untouched.
- No new executor and no new step kinds: materialization and healing produce data definitions within `skill | tool | message` exactly as the registry already enforces.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-skills`: the workflow lifecycle gains requirements for materialization from a completed run (derive-and-review, never guess), the drift outcome at execution, and heal-as-proposed-new-version (provenance, explicit approval, no silent rewrite). Together with the freshness/proof-run requirements defined in `side-panel-workflows`, this completes the teach → store → rerun → heal loop.

## Impact

- New `host/agent/skills/workflows-materialize.js` — run-trail → draft derivation, reusing `buildRecordingDraft`'s fully-resolved-or-incomplete contract and the registry's own validation.
- `host/agent/skills/workflows-run.js` — drift classification at step boundaries (stop-at-first-failure already exists); a structured drift result exposed to the conversation; no change to the executor's dispatch path.
- `host/agent/storage/action-timeline.js` — read side for a run's sanitized action trail (materialization input; already the sanitized, secret-free record).
- `host/agent/skills/workflows-store.js` — no schema change expected: heal rides the existing `updateWorkflow` version bump and provenance history.
- Panel/settings surfaces — a draft review card, a drift notice, and a heal proposal card, built on the existing approval-card and skills surfaces; Vietnamese copy following the reviewed vocabulary.
- Tests: `host/test/skills-workflows.test.mjs` extensions plus new materialization and heal test files.

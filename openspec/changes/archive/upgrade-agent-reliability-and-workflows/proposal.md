## Why

The assistant has durable UI transcripts and several isolated execution boundaries, but important user-visible guarantees stop at those boundaries: a later turn starts a fresh SDK query, approvals can be classified without resolved target evidence, usage is not bounded or honestly accounted for, recordings can remain detached, page identity is weaker than document identity, provider profiles are not manageable from the panel, and reusable workflow operations are still stubs. These gaps affect reliability, safety, cost control, and repeated browser work, so they must be specified as one dependency-ordered upgrade before implementation.

## What Changes

- **P0:** Add real SDK session continuity across turns and companion restarts, with durable conversation-to-SDK-session mapping, immutable per-run provider/model/skills/permissions/context snapshots, explicit missing-session and legacy-conversation outcomes, cancellation and partial-turn handling, concurrent-start leases, and deletion of all associated state. No automatic replay of browser actions or invented memory.
- **P0:** Make send/submit approval evidence-backed. Resolve coordinate, reference, keyboard, JavaScript, and non-browser targets where possible; pass resolved hints into classification; fail closed for sensitive unknowns; bind approvals to exact domain/document/action arguments and observed state with expiry and invalidation. The policy remains conservative and does not claim infallible semantic detection.
- **P1:** Add configurable usage and budget limits using the SDK's exact `maxTurns`, `maxBudgetUsd`, result usage, cumulative cost, and cost-basis semantics. Enforce hard turn/time counters, distinguish known, estimated, and unknown billing, account for retries/subagents/restarts without double counting, and handle cancellation and in-flight overrun honestly.
- **P1:** Add explicit recording attachment targeting. Persist an attachment acknowledgement for the selected idle conversation, enforce recording ownership and idempotency across leases and panel races, report missing recordings, and incorporate the recording into the next model turn rather than attaching metadata only.
- **P1:** Strengthen page context from tab+URL revision to browser-backed document identity and revalidate it at send, lease acquisition, read, and action time. Handle same-URL reloads, SPA navigation, closed tabs, queued runs, pin/unpin, and stale permissions without silently reading or acting on a replacement document.
- **P2:** Add provider-profile management in the settings and composer surfaces over the existing backend/profile snapshot model: named Anthropic-compatible profiles, CRUD/select, OS credential storage, per-snapshot capability verification, immutable in-flight configuration, explicit deletion/revocation behavior, and migration of the current default profile. Native OpenAI/Gemini adapters are out of scope.
- **P2:** Add reusable, parameterized workflows backed by the existing skills/dispatch and authorization surfaces. Define durable storage, schema, CRUD, exact domain matching, safe execution and preview rules, discoverability through existing MCP/sidepanel registries, ownership/portability, and no new bypass path. Scheduled automation and GIF generation are out of scope.
- Preserve existing overlay/page binding/image attachment/skill behavior and treat outstanding live checks in active changes as release dependencies, not completed evidence.

## Capabilities

### New Capabilities

- `reusable-workflows`: User-owned, parameterized browser workflows that are discoverable, validated, previewable when evidence is complete, and executed through existing authorization.

### Modified Capabilities

- `agent-browser-runtime`: real SDK session continuity, evidence-backed approval, usage/budget enforcement, recording attachment completion, and document-identity-safe context/action handling.
- `browser-assistant-panel`: continuity/error states, approval previews, usage ledger and limits, recording target selection, document-aware context, provider profile selection, and workflow discovery/execution controls.
- `agent-settings`: named provider profiles, credential lifecycle, profile selection, immutable snapshots, and capability-test status per profile/model.
- `agent-skills`: reusable workflow discovery and invocation must coexist with skill dispatch without changing skill authorization or adding a bypass.

## Impact

- Host runtime: `host/agent/companion.js`, `host/agent/session/*`, `host/agent/tools/query-options.js`, policy/approval/mapping modules, recording storage, usage accounting, protocol validation, settings/profile modules, and workflow storage/registry modules.
- Extension: `extension/sidepanel/*`, `extension/settings/*`, `extension/background.js`, `extension/content.js`, page-context binding, composer and transcript models, and existing registry clients.
- Persistence: conversation metadata and SDK session references, usage ledger, recording attachment records, document identity snapshots, provider profile records, OS credential entries, and workflow records. Schemas require atomic writes, migration/versioning, redaction, and deletion semantics.
- Verification: existing individual Node test commands and host test script, targeted integration tests, live browser/provider gates, security checks, and 320/400/480 light/dark accessibility matrices. No root `package.json` is assumed.
- No product implementation, archive, commit, GitNexus index, or modification of existing OpenSpec changes is part of this change request.

## Context

The current companion persists transcript events and UI snapshots, but `SessionManager.resumeConversation()` only restores display state and marks active work interrupted. `companion.js` builds isolated options and starts a fresh `sdk.query()` for each turn. The installed SDK typings document `options.resume`, `persistSession`, `forkSession`, `maxTurns`, `maxBudgetUsd`, result usage/cost fields, `modelUsage`, and reset behavior for resume/clear; these are the authority, but runtime behavior against the pinned installed package and configured gateways still requires an implementation gate. The SDK's cost table is an estimate, not provider billing, and its aggregate usage excludes subagents while `modelUsage` includes them.

Approval classification currently calls `isSendClassCall(toolName, args)` without the target hint already supported by `mapping.js`; the registered computer action vocabulary is not identical to the classifier's `click` wording, and JavaScript uses its registered script argument shape. Page context currently identifies `tabId + url` and a local revision. Recordings have a durable pending reference store but no conversation-targeted acknowledgement or SDK-readable model input. Provider settings already have profile snapshots, OS secret storage, capability tests, and revocation hooks, while the UI assumes a default profile. Skills and the sidepanel registry provide the existing discovery/dispatch boundary; `shortcuts_execute` currently accepts `tabId`, optional `shortcutId`, or `command` and is asynchronous rather than a parameterized/versioned workflow runner. Existing ordinary MCP control must remain independent.

Existing active changes remain external release dependencies: `repair-overlay-mount-and-visibility` has outstanding live checks and `adopt-panel-design-and-image-attachments` has outstanding live, gateway, regression, and accessibility checks. Their artifacts and functionality are preserved and not edited here.

## Goals / Non-Goals

**Goals:** make every turn and approval attributable to a durable immutable snapshot; make limits and uncertainty visible; make recording and document attachment explicit and truthful; expose named profile and workflow controls; preserve browser lease, overlay, attachments, skills, external MCP, sandbox, and no-replay guarantees.

**Non-Goals:** implementing native OpenAI/Gemini adapters, semantic-detection infallibility, automatic replay of browser actions, scheduled automation, GIF generation, changing the existing overlay design, or replacing the established chunked attachment/recording transport.

## Decisions

### 1. SDK continuity is gated before product integration

First verify the installed SDK's `resume` flow with a two-turn fixture, restart simulation, `persistSession`, working-directory behavior, partial result behavior, `forkSession`, and cancellation. The gate passes only if a known session reference resumes prior model context, does not replay browser tool calls, and reports an explicit failure for a missing reference. If any assertion fails, implementation stops at the gate and the design is revised; no shadow history or synthetic prompt replay is an acceptable substitute. Valid sessions use `resume`; a deliberate branch uses `forkSession` only for an explicit new-conversation action. No `continue` option is used as a substitute for a durable mapping.

### 2. Conversation state is a versioned, atomic ownership record

Extend conversation metadata with a secret-free app profile identity (profile id, endpoint/model identity, credential revision), skill identity, permission policy, SDK reference, session schema version, lifecycle status, and budget policy. Runtime secrets remain outside conversation metadata. Do not conflate this app snapshot with the SDK's persisted prompt/system snapshot: every resumed turn must rebuild fresh page context after the SDK resume gate confirms the mechanism. Store a per-turn id and SDK message/result identity in the existing atomic transcript/session storage. Acquire the existing conversation guard and shared browser lease before starting; use compare-and-set style ownership and release in `finally`. Deletion marks a tombstone before aborting, removes all conversation-owned mappings/ledger/recording references/artifacts, and prevents late writes. Legacy conversations without a valid SDK reference resume their transcript only and require an explicit new context/session choice.

### 3. Approval is a conservative evidence pipeline

Add a target-resolution stage before `canUseTool`: derive a normalized matrix from the actual qualified tool/action registry, including `left_click`/`double_click` mappings, key sequences/repeats, and the registered JavaScript script argument. Resolve refs and coordinates through the existing browser bridge where possible, capture document/domain and action arguments, and pass a normalized target hint to `isSendClassCall`. For keyboard submit, arbitrary JavaScript, unknown coordinates, and non-browser routes, distinguish explicitly approvable unknowns from unconditional denials; never claim semantic detection is infallible. Revalidate browser evidence immediately before dispatch, including after Allow. Keep the overlay free of approval controls, and retain the borrowed-tab JavaScript restriction.

### 4. Usage is event-sourced, monotonic, and uncertainty-preserving

Record run/turn/subagent usage records keyed by provider request/session, SDK result identity, and an explicit usage epoch. Use cumulative `modelUsage` deltas for accounting, because SDK aggregate usage excludes subagents while `modelUsage` includes them; start a new epoch when SDK totals reset on resume/clear. Use SDK `maxTurns` and `maxBudgetUsd` only after the SDK gate confirms their behavior. Treat `maxBudgetUsd` as the SDK's estimated query-budget stop, never a hard provider billing ceiling. Enforce a local wall-clock deadline and model-turn admission counter, but do not claim a local tool counter controls SDK calls. Display SDK cost-table values as estimates with their basis, actual provider billing only from external billing evidence, and unknown otherwise. A cancellation freezes new admissions and marks in-flight usage pending until a terminal result or explicit unknown outcome.

### 5. Recording attachment is a two-phase claim

The panel selects one idle conversation and sends an idempotency key. The companion atomically claims the durable pending recording reference, verifies ownership/path/schema/integrity, persists `selected -> attached -> submitted -> included|unknown|failed` state, and only then removes it from pending. The existing pending channel remains reference-only. Define a separate scoped model-readable delivery path: bounded, redacted, size-limited trace/transcript content blocks or a read-only recording tool with conversation ownership and an explicit result. The next model turn may report `included` only after that path succeeds. Crash/cancel leaves `submitted` or `unknown` until reconciled; a lease or conversation race returns the existing idempotent result or a conflict, and completion with no active run reconciles the selected owner rather than routing to an arbitrary run.

### 6. Document identity uses browser-observable lifecycle evidence

Capture a document token from the strongest available Chrome APIs and content-script handshake at implementation time, combining tab/frame identity, committed URL, lifecycle/navigation signal, and a per-document nonce observed in the target document. Treat same-URL reload and SPA route/document changes as new revisions when the handshake or navigation signal changes. Separate persistent workflow domain/scope constraints from per-execution document and approval nonces. An authorized create/navigate sequence may commit a new binding only after destination scope/domain validation; unexpected replacement invalidates old refs and approvals. Revalidate at send, lease acquisition, read, and mutation. If the browser cannot provide a stable token for a boundary, the operation fails closed rather than falling back to URL-only identity.

### 7. Profiles reuse existing backend primitives; runs snapshot them

Generalize the current default profile record into a named profile collection while preserving the current record through a one-time migration. Keep a secret-free profile identity and credential revision in conversation metadata, and secrets in the existing OS store keyed by profile id. Selection sends only profile id/model id to the companion, which resolves the current credential and snapshots it for a run; it never reconstructs a deleted historical credential. Endpoint/model/skill identity is conversation-bound for resume, while ordinary nonsecret edits affect future runs and credential replacement/removal/revocation cancels affected active runs. Capability results are keyed by endpoint/model/credential revision/SDK version.

### 8. Workflows are data, not a second executor

Persist validated workflow definitions with exact fields for workflow id/version/owner/name, parameter schema, domain/document constraints, and an allowlisted step vocabulary that maps to existing skills/tools. CRUD management is trusted user/application authority only; agent discovery is read-only and cannot create/edit/approve workflows. Add versioned MCP schemas for list/get/create/update/enable/disable/delete and for `shortcuts_execute`-compatible execution, with tabId, workflow/shortcut id, version, parameters, execution id, status, and cancel fields explicitly separated. Execution is asynchronous with a status/cancel surface and panel handoff; no-panel/no-profile is an explicit result. Ordinary MCP runs remain independent. Acquire/release the existing browser lease without self-deadlock. Execution creates an ordinary run invocation with the same policy, lease, document, profile, skills, cancellation, and budget snapshots. Recording-to-draft is opt-in and only succeeds when evidence fully resolves every required field; otherwise it returns a specific incomplete-evidence result. No workflow operation bypasses `canUseTool`, authorization, or the existing tool adapter.

### 9. Verification gates are part of the release contract

Unit and integration tests cover pure policy, persistence, protocol, migration, dedupe, and error paths. Live gates cover SDK resume, real browser document identity/reload/SPA behavior, approval target previews and overlay absence, recording model input, real provider usage/cost semantics, named-profile capability tests, workflow execution, and existing active-change checks. UI gates cover 320/400/480 widths, light/dark themes, keyboard/a11y, focus, reduced motion, and no clipping. Unpassed live gates block release and are never represented as completed by structural tests.

## Risks / Trade-offs

- [SDK resume semantics or persistence paths differ from the installed typings] -> the concrete SDK gate blocks integration; the system reports unavailable-session errors rather than replaying or inventing context.
- [Anthropic-compatible gateways report different usage or pricing fields] -> preserve provider values and cost basis, show unknown when untrusted, and keep local hard turn/time limits independent of price.
- [Document identity is unavailable in a browser boundary or SPA] -> fail closed for reads/mutations and retain already captured content with its original identity; do not weaken to URL-only.
- [Target resolution adds latency before sensitive approval] -> resolve only when classification needs it, cache evidence for the same action, and surface unknowns instead of hiding the delay or guessing.
- [A conservative policy blocks legitimate arbitrary JavaScript or keyboard actions] -> provide explicit, descriptive approval/deny outcomes and document the limitation; never trade it for silent auto-allow.
- [Recording or workflow definitions race with panel restarts] -> idempotency keys, atomic claims, ownership checks, and immutable run snapshots prevent duplicate or cross-conversation input.
- [Profile deletion conflicts with an active run] -> active work remains immutable and cancellable, while no new turn starts after credential revocation; transcript states the exact boundary.
- [Existing active changes have incomplete live evidence] -> release gates reference their unchecked tasks and retain legacy behavior until those checks pass.

## Migration Plan

1. Run the SDK investigatory gate and persist its evidence in implementation tests/logs owned by the change; stop if it fails.
2. Add backward-compatible versioned metadata migrations for session references, usage ledger, recording claims, named profiles, and workflows. Existing conversations without SDK references remain transcript-resumable but require explicit new-session recovery.
3. Roll out P0 continuity and approval gates behind existing run admission, then P1 ledger/recording/document checks, then P2 profile/workflow surfaces.
4. Keep old protocol peers on explicit update-required/unknown-operation errors. Do not route to weaker legacy paths for new workflow or attachment claims.
5. Rollback disables new admissions and leaves existing transcript/artifact data readable; migration readers retain old records, and deletion is tested before any schema cleanup.

## Open Questions

None. The SDK behavior and browser document-token feasibility are implementation gates with pass/fail criteria, not unresolved design decisions.

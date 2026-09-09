## MODIFIED Requirements

### Requirement: Session continuity and honest cancellation
The assistant SHALL persist conversation metadata and SDK session references locally, support resume and new conversation, and prevent more than one active run per conversation. A conversation SHALL be bound to an app-level provider endpoint/model identity, skill identity, permission policy, and other immutable run policy snapshots; each new turn SHALL obtain fresh browser/document context rather than freezing a prior page-context system prompt. The assistant SHALL resume the same SDK session only when its reference, cwd, SDK/session identity, and app snapshot are compatible. Stop SHALL cancel model generation and block subsequent browser dispatch; already executed browser effects SHALL not be represented as undone. Missing or unavailable historical SDK sessions or credentials SHALL produce an explicit recovery/new-conversation result and MUST NOT be replaced by invented memory, historical-secret reconstruction, or automatic browser-action replay.

#### Scenario: Stop during execution
- **WHEN** the user stops a run with an action already in flight
- **THEN** further actions are blocked, pending approvals are invalidated, and the UI identifies any action whose final result is not known

#### Scenario: Resume after restart
- **WHEN** the user reopens a persisted conversation after browser or companion restart
- **THEN** the transcript is restored, interrupted work is marked interrupted, and a new action requires renewed browser context rather than replaying pending work

#### Scenario: Valid compatible continuation
- **WHEN** a later turn has a valid SDK session reference, compatible app profile/endpoint/model/skill identity, and current browser context
- **THEN** the SDK session resumes for model context while the turn uses freshly revalidated browser context and dispatches no prior action again

#### Scenario: Incompatible selection or unavailable credential
- **WHEN** the selected endpoint, model, skill identity, SDK session identity, or required credential is incompatible or unavailable for resume
- **THEN** the panel rejects continuation and requires a new conversation or explicit recovery, without claiming historical credentials or silently switching provider context

#### Scenario: Concurrent start and deletion
- **WHEN** two starts race for one conversation, or a conversation is deleted while its run is unwinding
- **THEN** only one run owns the conversation, late events cannot resurrect deleted state, and deletion removes the conversation's SDK mapping and all associated state

## ADDED Requirements

### Requirement: Usage and budget integrity
The assistant SHALL expose configurable run and conversation usage policies and maintain a durable epoch-based ledger. SDK `maxTurns` and `maxBudgetUsd` SHALL be used only with semantics verified against the installed SDK; `maxBudgetUsd` SHALL be described as the SDK's estimated query-budget stop behavior, not a guaranteed provider billing ceiling. The ledger SHALL use cumulative `modelUsage` deltas, including subagent usage where provided, and stable SDK/session/turn/result identities to avoid double counting. SDK cost fields and `costBasis` SHALL be labeled as SDK pricing estimates or unknown; actual provider billing SHALL be reported only when supported by external provider evidence. Totals that reset on resume/clear SHALL start a new epoch, and unknown intervals SHALL remain pending/unknown rather than zero.

#### Scenario: Run limit admission
- **WHEN** a run reaches its configured wall-clock or local model-turn admission limit
- **THEN** no new model turn or browser dispatch is admitted, and the run reports the exact local limit without claiming that SDK calls already admitted were cancelled retroactively

#### Scenario: SDK budget estimate exceeds
- **WHEN** the SDK reports or terminates after its estimated `maxBudgetUsd` query budget is exceeded
- **THEN** the UI labels the outcome as an SDK estimated-budget stop and does not present it as a hard dollar billing limit

#### Scenario: Unknown pricing or reset epoch
- **WHEN** usage is known but no trusted provider billing evidence exists, or SDK totals reset after resume/clear
- **THEN** the ledger preserves usage with unknown/estimated status and a new epoch id, without subtracting or fabricating zero cost

### Requirement: Conversation-targeted recording input
The assistant SHALL support explicit attachment of a persisted recording to a selected idle conversation with durable states `selected`, `attached`, `submitted`, `included`, `unknown`, and `failed`. Attachment SHALL verify ownership and integrity, define bounded model-readable content (permitted trace/artifacts, redaction, truncation, and size limits), and identify exactly which scoped tool or content blocks make that data available to the model. The existing pending-recording channel is reference-only and MUST NOT be described as model delivery until this inclusion path succeeds. Completion routing SHALL reconcile the selected conversation/owner even when no run is active.

#### Scenario: Recording included
- **WHEN** an owned recording is attached and the next turn is submitted
- **THEN** the model receives the specified bounded recording content and the transcript records `included` only after that content is successfully made available

#### Scenario: Missing, oversized, or redacted recording
- **WHEN** recording files are missing, exceed limits, contain redacted content, or cannot be exposed through the scoped model input
- **THEN** the attachment is failed or marked unknown with the exact reason and the transcript does not claim model access

#### Scenario: Completion without active run
- **WHEN** recording completion arrives while no SDK run is active
- **THEN** the manager persists the reference and later reconciles it to the explicitly selected conversation owner without routing it to an arbitrary active run

### Requirement: Document-aware page context and action safety
The assistant SHALL bind page context to browser instance, window, tab, a browser-observable document identity, and execution nonces. Persistent workflow scope constraints SHALL remain separate from per-execution context/approval nonces. Every send, lease acquisition, read, and mutation SHALL revalidate identity. A navigation correlated with an authorized create/navigate action MAY commit a new document binding only after destination scope/domain validation; an unexpected replacement SHALL invalidate the old binding and permissions. Same-URL reloads, SPA changes, closed tabs, queued runs, pin/unpin, and stale approvals SHALL never silently target a replacement document.

#### Scenario: Page changes or disappears
- **WHEN** the bound tab closes or navigates to a different document before extraction finishes
- **THEN** the run reports changed or unavailable context and does not silently read the replacement page; content already captured remains labeled with its original source

#### Scenario: SPA and incomplete extraction
- **WHEN** article content changes without full navigation or extraction is truncated, blocked by login, or inaccessible
- **THEN** the assistant uses refreshed readable content tied to the current route and reports missing portions instead of claiming a complete reading or fabricating content

#### Scenario: Authorized navigation commits identity
- **WHEN** an authorized create/navigate sequence reaches an in-scope destination and the browser reports a new document identity
- **THEN** the runtime commits the new binding, invalidates old document-bound approvals/refs, and permits subsequent read only after revalidation

#### Scenario: Unexpected replacement or closed tab
- **WHEN** a document changes outside the authorized navigation sequence, or the tab closes before a read/action
- **THEN** the operation fails closed with stale/unavailable context and no replacement tab is selected automatically

### Requirement: Send/submit-class actions gate at canUseTool
The runtime SHALL classify each browser tool call attributable to `computer` or `javascript_tool` before executing it. Classification SHALL use a registry-derived normalized matrix of qualified tool name, registered action names (including `click`, `left_click`, and `double_click` where applicable), key sequences and repeats, target reference/coordinate evidence, and JavaScript arguments. A call classified as submitting a form, clicking a send/submit/pay/confirm control, or a comparably hard-to-reverse outward-facing action MUST suspend execution pending an explicit user decision; every other classified call, and every call to any other registered browser tool, MUST proceed automatically with no decision required. A tool name capable of producing a send/submit-class call MUST NOT be included in the SDK's auto-approval list; it MAY remain in the SDK's tool-availability list so the call still reaches this classification. Resolved target hints SHALL be passed where available. Sensitive unknowns SHALL either be explicitly approvable with visible unknown fields or unconditionally denied when their effect cannot be bounded. Approval SHALL be bound to exact run, domain, document identity, execution nonce, normalized tool/action/arguments, target evidence, and observed state; browser evidence SHALL be revalidated immediately before dispatch, not only when Allow is selected. Arbitrary JavaScript remains subject to the borrowed-tab scripting restriction.

#### Scenario: Automatic action bypasses the gate
- **WHEN** a call is classified outside the send/submit set — reading, extraction, screenshot, scroll, hover, navigation click, typing, form-field filling, opening/closing an agent-created tab, or in-scope script execution
- **THEN** it executes without waiting for a user decision, exactly as before this gate existed

#### Scenario: Known submit target
- **WHEN** a normalized registry action resolves to a submit/send/pay/confirm target with matching metadata
- **THEN** execution pauses for an explicit decision showing the concrete target and action before dispatch

#### Scenario: Send/submit call suspends for a decision
- **WHEN** a call is classified as submitting a form, clicking a send/submit/pay/confirm control, or an equivalently outward-facing action
- **THEN** execution does not proceed until an explicit allow or deny decision resolves it, and a denial or timeout prevents that dispatch entirely

#### Scenario: Unknown sensitive action
- **WHEN** a coordinate, reference, key sequence/repeat, JavaScript argument, or non-browser route may produce a sensitive effect but evidence is incomplete
- **THEN** the policy either shows an explicit approval with the unknowns or denies unconditionally according to the documented matrix, and never auto-allows by semantic guess

#### Scenario: Evidence changes before dispatch
- **WHEN** the target document, domain, element state, coordinates, normalized arguments, scope, or execution nonce changes after Allow but before dispatch
- **THEN** the approval is invalidated and no stale action is dispatched

#### Scenario: Borrowed-tab JavaScript
- **WHEN** JavaScript is requested against a borrowed tab without separate scripting authorization
- **THEN** it is rejected by the existing borrowed-tab mutation restriction regardless of approval text or other tab authorization

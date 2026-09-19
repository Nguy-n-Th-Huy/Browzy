## Context

Before this change, `runtime.js` observed, called `requestStepDecision`, and called `requestDecision` for target-bearing actions. `questions.js` already built bounded observed candidates, and `client.js` supported direct TypeSafe, Vercel and OpenRouter transports. The prior validator accepted a single operation-specific target head. `text-helper.js` owns memory, screenshots for reasoning, completion, source consultation and reports. The host dispatch gate remains the authority boundary.

## Decisions

### 1. Plan and prepare, then decide

The configured language model initially prepares bounded plan/doneWhen/notes plus optional text and navigation records from the goal, conversation, current observation and enabled screenshot. A text record identifies an observed editable target and exact bounded value; the host binds it to the observation's document identity, ref, role and label. A navigation record carries a validated absolute http(s) URL and purpose. Strict parsing refuses unknown or malformed records; no arbitrary selectors, coordinates or code are accepted. Initial preparation and required revisions are mandatory: failure after the applicable bounded retry ends `error/preparation_failed` unless stopped. The prior advisory-memory failure semantics are deliberately superseded, including revisions triggered by navigation, cadence or recovery.

Only the current plan revision's prepared content is eligible. Text is offered for its exact matching observed field, never crossed with all editable elements or semantically rebound to a different field. A dispatched value is consumed; repeated input requires fresh preparation. Values that already match the current field are not offered. Document change, lost identity, incompatible role or changed label invalidates a binding. Reuse the extension's existing `getDocumentIdentity` nonce and `DocumentBindingTracker` identity, exposing `docNonce` in `page_snapshot` as needed; missing identity cannot authorize persistent field content. URL equality is not document identity. A newly encountered field with no prepared content causes REPLAN, not guessed typing.

Host action candidates are regenerated from every snapshot, including controls that appeared after a hover or click. Each opaque offered key maps to exactly one full action (operation, observed target and optional prepared value/option/URL). No executable target index survives across snapshot generations. Reobserve and validate the chosen target after `canUseTool` returns and before execution, including after an approval wait; a changed document nonce or relevant target identity/state skips the action and starts a fresh decision rather than remapping the old key. Permission and run-state checks still apply after model latency and approval waits.

### 2. One Jev request, three independent Choice heads

Use the existing typed Choice wire shape for `action`, `goal_done`, and `stuck`; binary heads use explicit offered yes/no keys. All heads see the same bounded goal, plan, current DOM/text and history; no head sees another head's answer. Jev receives structured text, not a screenshot or invented multimodal API.

The official [Choice documentation](https://docs.typesafe.ai/primitives/choice) confirms up to 255 options and independent questions over shared state. The official [state documentation](https://docs.typesafe.ai/concepts/state) describes text-only input. The coordinator verified these sources during this change's preparation. Update the settings capability probe to exercise the three-head decision protocol; merely retaining a successful legacy single-target probe is insufficient.

The action head offers CLICK, HOVER, SELECT and properly bound TYPE_TEXT/NAVIGATE actions, scroll controls and WAIT/REPLAN/ASK/DONE. The host resolves the selected opaque key in the same request's map. The client validates exact answered heads, offered keys, complete finite normalized distributions and maximum-probability choices. Preserve existing transport differences and confidence handling, without weakening validation for compatibility probes or legacy selection callers.

Cap the action head below the existing provider choice ceiling and fit the complete request to the byte budget. Reserve control choices and prepared actions, distribute remaining space deterministically across element operations so HOVER duplicates cannot starve CLICK or SELECT, and disclose omitted candidates. If the irreducible request is too large, fail locally with a named error rather than knowingly send an oversized body.

### 3. Control flow and precedence

Every routine cycle observes and calls Jev without a mandatory LLM NEXT_STEP call. Stop/cancellation outranks all model responses. Structurally invalid Jev responses dispatch nothing and fail with the existing classified error. Low-confidence or near-tied action choices abstain through the existing bounded no-progress mechanism; they do not gain authority from a monitor.

DONE or an independently positive goal_done result triggers the existing LLM completion check before any mutation. A rejected check updates guidance and continues within the existing rejection limit; an unavailable or invalid check ends blocked completion-unverified. A positive monitor is evidence to check, never proof of success. Preserve bounded source fetching and report generation, including honest limitations and source attribution.

Otherwise ASK ends blocked with needsOperator and an honest request for user input through the existing operator mechanism. It does not pretend to suspend and resume. A positive stuck monitor or REPLAN triggers bounded LLM preparation/revision; controls cannot reset the global decision/action budgets. Repeated replans without executed progress exhaust a named bound. WAIT dispatches the existing bounded wait and counts toward bounds. Keep existing scroll, repeated-click, result-unknown and no-progress protections, with recovery renewing content when needed. Failed required planning/preparation must not silently fall back to the old LLM-per-step architecture.

### 4. Observability and compatibility

Keep durable jev_step/jev_end events and existing action/target information. Where needed add bounded action/monitor metadata and decision origin. Labels must not describe a Jev action decision as LLM reasoning or target-only confidence. Existing records still render. Screenshots remain optional, captured through the existing guarded path and attached only to LLM consultations and completion; capture failure degrades to text without changing authority.

Preserve source/report paths, configured model transport behavior, and the unrelated runtimes. Update code comments and user documentation that still promise an LLM decision each step. Do not merge or alter the other pending proposal.

## Implementation ownership and integration contract

Protocol ownership: `questions.js`, `client.js`, `capability.js` and their tests. Runtime ownership: `runtime.js`, `text-helper.js` and runtime/helper tests. Surface ownership: snapshot `docNonce` exposure in `extension/content.js`, directly affected protocol/panel labels, README and their tests. These can run concurrently after agreeing the following contract; incidental export naming may be adapted consistently by the coordinator.

- `requestActionPlan(...)` returns `{memory: {plan, doneWhen, notes}, textValues: [{element, value}], navigation: [{url, purpose}]}` with optional bounded visual notes; indices are checked against the preparation observation before host binding.
- `buildDecisionRequest({goal, snapshot, memory, history, prepared})` returns `{body, candidates}`; candidates map opaque keys to `{operation, target, value?, url?, preparedId?}` and target includes its observed ref, label/role and document identity. Controls have no target.
- `requestDecision` for the three-head request returns selected `actionKey`, `goalDone`, `stuck`, plus per-head probability/confidence data; legacy validation remains isolated where needed.
- Runtime owns prepared record IDs, consumption and document-bound validity and supplies only eligible records to the builder. The builder independently checks operation/target compatibility. Stable field metadata must not depend on untrusted model-written identity.
- The snapshot exposes `docNonce` using existing document identity infrastructure; absent nonce fails closed for persistent prepared text rather than silently using URL equality.

## Risks and validation

Candidate caps can hide relevant controls; reserve control/prepared choices and disclose omissions. Persistent text could reach a wrong field; exact identity binding, single-use consumption and refresh validation prevent silent rebinding. Jev can misjudge progress or completion; deterministic bounds and LLM verification remain independent safeguards. API mocks prove integration, not real-world model quality or a speed improvement.

Test a multi-step flow in which initial preparation is followed by several Jev choices with no NEXT_STEP calls, a new field forces replan, a hover reveals a fresh target, and DONE requires verified completion. Cover all transports, malformed heads, stale targets, content invalidation, candidate/request bounds, monitors, repeated WAIT/REPLAN, approvals/stop/result-unknown, failed completion, source reports and unchanged runtimes.

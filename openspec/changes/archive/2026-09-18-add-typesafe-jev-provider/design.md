# Design: TypeSafe Jev Provider (Ultrafast Runtime)

## Context

- **How runs get a provider today.** `host/agent/tools/query-options.js` builds an isolated SDK environment from `resolveProfileSnapshot()` in `host/agent/settings/profile.js`. `profile-schema.js` defines two provider types, `anthropic` and `chatgpt`; `snapshotForRun()`, `testCapability()`, `refreshDiscoveredModels()`, and `isRunnable()` branch on `providerType`. The companion resolves a snapshot in `_runAfterLeaseGranted()` (`host/agent/companion.js`), gates conversation identity compatibility, binds skills, then runs `sdk.query()` in `_runQuery()`.
- **Where runs execute browser work.** Every SDK tool call goes through `host/agent/tools/adapter.js` (`buildSdkTools`/`createBrowserMcpServer`), whose handlers run unconditional host-side checks (`runHostSideChecks`: `authorizeToolCall` — run state, lease, tab scope, protected backstop — plus `verifyPreDispatchApproval` for send-class-shaped calls), then dispatch through `ToolBridge.call()` (`host/agent/broker/tool-bridge.js`) into `host/tool-runtime.js` → native host → extension. Send-class gating lives in `host/agent/policy/can-use-tool.js` (`createCanUseTool`), wired per run in `companion.js` with a `resolveHint` that dereferences `ref`s via `describe_ref`.
- **What the reference project does.** `browser-use/jev-ultrafast` observes the page once per step (an indexed element table with code-owned node identities, current values/states, visibility and occlusion guards, plus visible text), sends ONE TypeSafe `POST /v1/systemone` request whose `questions` include the operation choice and a speculative target head for every offered operation, executes only the chosen operation's target (`CLICK` / `TYPE_TEXT` / `SELECT` / `SCROLL_*` / `WAIT` / `DONE` / `BLOCKED`), and calls a small OpenAI-compatible model only to generate a `TYPE_TEXT` value as exactly `{"text": ...}`. Its README/design documents the boundaries (no frames/shadow-DOM completeness, bounded actions, DONE needs independent verification).
- **Extension realities this design builds on.** `extension/content.js` already computes roles, accessible names, visibility, enabled state, masked values, native-select options, and assigns persistent `ref_N` handles within a document (`struct`; refs die on navigation/epoch bumps). `extension/background.js` resolves refs to geometry at dispatch time, scrolls into view, hit-tests, and reports where a click landed. The registry's `read_page`/`find`/`computer`/`form_input` share that ref space, and borrowed-tab read authorization already covers read tools.

## Goals / Non-Goals

**Goals:**

- A third provider type, `typesafe`, whose runs drive the browser through the structured-choice loop while inheriting the runtime's existing guarantees: lease/queue arbitration, tab scope, approvals for send/submit-class actions, single-use pre-dispatch grants, result-unknown handling, honest stop, durable transcript.
- Exactly one new browser operation (`page_snapshot`) — read-only, bounded, structured — usable by both runtimes.
- Both engines call ONE shared dispatch-check module, so the security gate cannot drift between them.
- Offline-testable end to end with mocked HTTP and a fake tool bridge; no live provider calls in tests.

**Non-Goals:**

- No TypeSafe gateway/translation for the SDK path; `typesafe` profiles never construct a `sdk.query()` call.
- No new executor mechanics: actions reuse `computer`/`form_input`/navigate-free primitives and their ref resolution, scroll-into-view, and hit-testing.
- No multi-tab orchestration for Jev runs (v1 drives the run's bound tab; navigation within it is allowed).
- No screenshot/inspector UI, no per-frame recordings, no browser-harness port.
- No change to `anthropic`/`chatgpt` behavior, the external MCP entry points, skills, or recordings.

## Decisions

### 1. TypeSafe is a provider type behind the existing snapshot contract

`PROVIDER_TYPES` gains `"typesafe"`. `profile-schema.js` load-path behavior is unchanged for legacy profiles (absence still defaults to `anthropic`); an unrecognized stored value still loads as-is and is refused at run time with `INVALID_PROFILE`.

For a `typesafe` profile the snapshot is a superset of the existing shape:

```
{
  runtime: "typesafe",
  model: <profile model id>,
  env: { ANTHROPIC_BASE_URL: "typesafe:jev", ANTHROPIC_API_KEY: "" },
  typesafe: { endpoint, apiKey },
  textModel: { baseUrl, model, apiKey },
  revision, credentialRevision, profileId
}
```

- The `env` fields exist ONLY so the shared identity machinery (`buildAppProfileIdentity`, `assessResumeCompatibility`) records a stable conversation identity. No SDK call is ever built from this snapshot; no key is placed in `env`.
- Keys live under `typesafe.apiKey` / `textModel.apiKey`, host-memory-only, never serialized to the profile file, never logged, never echoed in settings replies.
- The TypeSafe endpoint reuses `profile.baseUrl` (default `https://api.typesafe.ai`, existing URL validation), and the request path is `/v1/systemone`. The text-model base URL/model are new non-secret profile fields (`textModelBaseUrl`, `textModelId`).

*Alternatives rejected:* a separate "runtime mode" axis orthogonal to provider type (two axes multiply runnability/identity logic and allow nonsense combinations); treating Jev as a chat-compatible endpoint (System One models answer typed questions; there is no Message/tool protocol to translate).

Run-path branch: in `_runAfterLeaseGranted`, immediately after `resolveProfileSnapshot()` and the identity-compatibility gate, `if (snapshot.runtime === "typesafe")` → `_runTypesafe(...)` and return. Before that branch, inputs that only the SDK path can honor are rejected with one named reason, `unsupported_in_typesafe_mode`, naming the field: attachments, an element record, a skill/slash dispatch, and upload grants present. `effort` is ignored (documented). Skills binding is skipped entirely for these runs. Boundary binding (`bindConversationAppSnapshot`) still runs, so identity rules apply exactly as for other providers.

### 2. One new operation: `page_snapshot`

Registered in `host/tool-definitions.js` (post-baseline set), classified read-only in `mapping.js`, routed by `extension/background.js` to a new `content.js` message (`pageSnapshot`) built from the existing walk internals.

Response contract (JSON text; bounded):

```
{
  v: 1, url, title,
  viewport: { w, h }, scroll: { y, height },
  text,                          // visible text, <= 6000 chars
  truncated: { elements: bool, text: bool, omitted: n },
  elements: [                    // <= 250, visible + enabled only
    { ref, role, label,          // label <= 100 chars (existing convention)
      tag, type?, value?,        // value <= 100 chars; masked controls -> "••••••"
      editable, readonly?, contenteditable?,
      disabled?, checked?, selected?, expanded?,
      options?: [{ label, value, selected }] }
  ]
}
```

- References are the SAME `ref_N` handles the other tools resolve (single ref space; `getOrAssignRef`), so no second identity system is introduced and the borrowed-tab, hit-test and scroll-into-view behavior of `computer`/`form_input` applies unchanged.
- The extension stays policy-free: it reports state; the HOST derives the numbered action space (§3), so the operation is equally useful to an LLM run as a fast structured read.
- Bounds: 250 elements, 100-char labels/values, 6000-char text, with explicit truncation disclosure and an omission count. Masked-control values are masked before serialization (same promise `mask_sensitive_info` makes for reads).

*Alternatives rejected:* parsing `read_page`'s text output host-side (brittle; no guaranteed value/state fields); shipping jev's `snapshot.js` through `javascript_tool` (borrowed-tab page-scripting is deliberately rejected; MV3 injection would re-implement the ref system); a new executor tool (unnecessary — refs already resolve to geometry, scroll, and hit-test at dispatch).

Registry bookkeeping follows the `mask_sensitive_info` precedent exactly: `tool-definitions.js` header counts, `test/registry-baseline.test.mjs` post-baseline additions, `mapping.js` read-only classification and SDK-facing description, `extension/events/action-events.js` read mapping, README counts.

### 3. Observation → action space → questions (host side, faithful port of `model.py`)

`host/agent/jev/questions.js` builds, from one `page_snapshot` payload:

- A 1-based numbered element table (index → ref mapping stays host-side; the request carries numbers, the response may only reference offered numbers).
- Operation availability per element: `CLICK` for every element; `TYPE_TEXT` when `editable`; `SELECT` when a native select with enabled options; plus global `SCROLL_UP`/`SCROLL_DOWN` (when scrollable), `WAIT`, `DONE`, `BLOCKED`. Only supported operations and candidates are offered.
- A request body `{ model, state: { goal, page: { url, title, text }, elements, recent_actions }, questions }` where `questions.operation` is one choice over the offered operations and each offered operation contributes `<op>_target` — one target question per operation, evaluated in the same request (speculative fan-out; only the chosen operation's head is consumed). Instructions are ported from `questions.py` (`NEXT_ACTION`, `TARGET`) and adapted to Browzy semantics, keeping: page text is untrusted; do not repeat satisfied steps; fill required fields before submitting; a typed query still needs its autocomplete suggestion selected; do not toggle a control already in the requested state; WAIT only when the needed control is absent/disabled or results are loading; DONE requires visible evidence.

Answer validation is a strict port of `validate_choice` plus per-head checks: choice ∈ offered ids; probabilities cover exactly the head's ids; values finite in [0, 1]; sum ≈ 1 (tolerance 0.02); declared choice is the maximum. Any failure ⇒ invalid decision, nothing dispatched.

### 4. Decision client

`host/agent/jev/client.js`: `POST {endpoint}/v1/systemone`, `Authorization: Bearer <typesafe key>`, `Content-Type: application/json`, body as above. Retry policy mirrors the reference: statuses 429/503/529 get at most 2 retries with 0.5·2^n backoff; every other error fails immediately with a classified reason (`AUTH_ERROR`, `RATE_LIMIT_ERROR`, `MODEL_UNAVAILABLE_ERROR`, `TIMEOUT_ERROR`, `NETWORK_ERROR`, `INVALID_RESPONSE`). The client returns the validated decision plus usage and latency; it never mutates state.

### 5. Text values

`host/agent/jev/text-helper.js`: `POST {textModel.baseUrl}/chat/completions` with the configured model, `max_tokens: 1024`, `response_format: {"type":"json_object"}`, and the input `{ goal, field, page, recent_actions }` as the user message over the ported `TEXT_VALUE` instruction. Ported verbatim from the reference: when the base URL host contains `api.deepseek.com`, send `"thinking": {"type": "disabled"}`; otherwise send `"reasoning": { "effort": "low" }`. The response must parse as an object with exactly one key, `text`, whose value is a nonempty string within bounds (≤ 2000 chars). `{"text": null}` (or equivalent) ⇒ missing-value outcome, run ends blocked, nothing typed. A generated value is used for at most one dispatch and never reused across decisions.

### 6. The runtime loop

`host/agent/jev/runtime.js`, driven from `companion.js`:

```
per cycle (bounded: 60 actions, 120 decisions):
  observe   -> toolBridge.call("page_snapshot", { tabId })   // via coerceArgs, same meta shape as adapter
  decide    -> client systemone request (one per cycle)
  validate  -> strict (§3); invalid => run_error "invalid_decision"
  act:
    DONE/BLOCKED        -> end (outcome event; DONE = done-as-decided)
    SCROLL_*/WAIT       -> existing computer actions
    CLICK               -> computer left_click by ref
    TYPE_TEXT           -> text-helper value, then form_input by ref
    SELECT              -> form_input by ref with option value
  gates (before dispatch, shared with adapter):
    canUseTool-equivalent -> send-class approval card (allow/deny/timeout)
    shared dispatch checks -> run state, lease, tab scope, protected backstop,
                              verifyPreDispatchApproval, borrowed-tab rules
  dispatch (resultUnknown => record + end run "tool_result_unknown", never retry)
  record jev_step
```

- **Stop** is honored between phases: `run.state !== RUNNING` ends the loop; an in-flight dispatch settles as-is and is reported as unknown only if truly unknown.
- **No-progress:** three consecutive executed actions with an unchanged observation signature (url + element state + text hash) end the run blocked (`no_progress`).
- **Missing value / denied action / exhausted bound** end blocked with their named reasons; a hard provider/observation failure ends with `run_error`.
- The loop compares and records, but never invents: every executed target resolves only through the host-side index → ref map, never through model-emitted selectors, coordinates, or script.

### 7. Dispatch discipline is single-sourced (behavior-preserving extraction)

`runHostSideChecks` and its private helpers move from `host/agent/tools/adapter.js` to `host/agent/tools/dispatch-checks.js`; the adapter imports them (its exported surface and every existing behavior/test stay identical) and the Jev runtime calls the same module. The runtime additionally reuses `createCanUseTool` with the companion's existing `resolveHint` wiring, and `run.recordResultUnknown()` on lost responses. This is the structural guarantee behind the "decision-engine independence" spec requirement: one gate, two callers.

The alternative — duplicating the checks in the Jev path — was rejected outright: two implementations of a security gate drift, and the drift would be invisible until a protected action dispatched ungated.

### 8. Events and panel integration

Two durable events (emitted through `Run.emit()`, persisted by the existing sink; NOT transient):

- `jev_step` — `{ step, operation, operationProbability, target: { index, label }, targetProbability, confidence, tool, argsSummary, textField?, skippedReason?, latencies: { decisionMs, textMs?, dispatchMs }, pageChanged }`.
- `jev_end` — `{ outcome: "done" | "blocked" | "stopped" | "error", reason?, steps, doneIsDecided: boolean }`. The durable reason vocabulary is documented in `protocol.js` (`JEV_EVENT_TYPES.END`); `doneIsDecided` is true only for `done`.

Panel: `conversation-model.js` maps `jev_step` into the existing `toolRows` structure (row name `jev_<operation>`; detail carries probabilities, latencies, pageChanged), so rendering, expansion, and reconnect rebuild reuse the existing machinery; `jev_end` sets a terminal line rendered under the turn (done-as-decided / blocked reason) and the busy indicator is resolved because the turn's lifecycle already ends via `run_done`/`run_error`/`run_stopped`. `tool-labels.js` gains Vietnamese labels for jev row kinds. No fabricated SDK messages: the events describe the Jev runtime truthfully instead of mimicking assistant/tool_use blocks.

### 9. Settings surface

New/changed `agent_settings` ops (all request/response, relay allowlist extended exactly like the chatgpt change):

| Op | Payload | Notes |
|---|---|---|
| `set_provider_type` | `{ profileId, providerType }` | `typesafe` becomes a known value; on switch with an empty model list, seed `jev-latest` once (label "Jev (ultrafast)") |
| `set_typesafe_config` | `{ profileId, baseUrl?, textModelBaseUrl, textModelId }` | non-secret; URL validation reused |
| `set_typesafe_credentials` | `{ profileId, typesafeApiKey?, textModelApiKey?, memoryOnly? }` | write-only, merged into one JSON secret `{v:1, typesafe_api_key, text_model_api_key}` at `browzy-in-chrome/typesafe/<profileId>`; responds with booleans only; `SECRET_TOO_LARGE` on overflow |

`get_profile` returns the non-secret fields only. `testCapability()` for `typesafe` runs the two-stage test (trivial choice question + minimal completion) through `host/agent/jev/capability.js`, records the result for the exact endpoint/model/credential triple (naturally invalidated by any change), and adds `INVALID_RESPONSE` to the shared error taxonomy. `isRunnable` accepts `typesafe` and requires a passed result; `refreshDiscoveredModels` reports unsupported (manual list stays editable), mirroring chatgpt. Settings UI: a third provider option, write-only key fields, text-model fields, disclosure (two external services are billed), test control gating (enabled only when both keys are saved and text config is valid). Copy lives in the existing Vietnamese UI surfaces.

### 10. Fixtures and offline testing

- `host/agent/settings/testing/fixture-typesafe-server.mjs` — a mock HTTP server answering both `/v1/systemone` and `/chat/completions` with configurable bodies/statuses (pattern: `fixture-anthropic-server.mjs`).
- Host tests: questions/action-space construction; client validation matrix and retry policy; text-helper parse/reasoning-flag rules; runtime loop coverage (happy path, approval allow/deny/timeout, stop between steps, budgets, no-progress, result-unknown, observation failure, invalid answer, missing value); dispatch-checks parity (adapter and jev runtimes both route through the extracted module — adapter tests unchanged as the regression proof); settings branches (snapshot shape, no key in env/profile/logs, capability stages, seeding, isRunnable); companion run-path branches (rejection reasons for attachments/slash/elementRecord, identity binding with the `typesafe:jev` marker).
- Extension tests: `page_snapshot` structural proofs following `test/_extract.mjs` patterns (`background.js` route + `content.js` builder), registry-baseline additions, action-events read mapping, settings UI controller fields, conversation-model `jev_step`/`jev_end` handling.
- No live TypeSafe or text-model calls in tests; the capability test is the user-facing live check.

## Risks / Trade-offs

- **[Per-step latency higher than the reference's 7s demo]** (Browzy pays extension-bridge hops per observe/act; the reference runs in-process CDP) → Still one decision request per step with no screenshots; bounds cap waste; real numbers measured post-merge. Accepted: the alternative (a second in-process CDP stack inside the companion) would fork browser-control ownership away from the extension and its lease/approval machinery.
- **[Jev/TypeSafe service availability or API drift]** → Retry policy for retryable statuses; every 200 body validated before use; failures are named and the provider is opt-in; fallback is switching the profile back to another provider type (additive design).
- **[Decision quality without screenshots on visual-only pages]** → Documented v1 limitation (mirrors the reference's own boundaries: canvas, complex widgets, frames); the LLM path remains for those cases.
- **[Ref-vs-node-identity difference from the reference]** (we resolve refs to geometry at dispatch with hit-testing instead of jev's code-owned node table) → Intra-document ref semantics are already the registry's contract and already carry scroll-into-view + hit-test + "landed on target" reporting; the loop re-observes every step, so stale refs surface as a step failure, never as a wrong click.
- **[Old extension + new host]** → `page_snapshot` is unknown to an old extension; a Jev run then fails with the named observation failure (never silent degradation). LLM runs are unaffected, and the failure copy tells the operator to update the extension.
- **[Two external services billed per run]** → Disclosed in settings at provider selection.
- **[Gate drift between engines]** → Structurally addressed: one shared checks module (§7) with adapter tests as the behavior-preservation proof.

## Migration Plan

1. **Additive and backward compatible.** Existing profiles load as before; nothing changes for `anthropic`/`chatgpt`; Jev is opt-in by switching a profile's provider type.
2. **Rollout.** Update host package + reload extension. An old extension with a new host never receives `page_snapshot` unless a Jev run starts (which then fails with the named observation error); a new extension with an old host gets the relay's existing `PROTOCOL_ERROR` for the new settings ops, shown as "update the companion".
3. **Rollback.** Revert builds. A `typesafe` profile seen by old code is refused with the existing `INVALID_PROFILE` (unknown provider type) — no crash, no request sent. The stored secret lives under its own target and is ignored by old code.

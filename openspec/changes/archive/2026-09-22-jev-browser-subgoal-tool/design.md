## Context

Two run shapes exist today:

- **SDK runs (`anthropic`/`chatgpt`)**: the LLM drives. `createBrowserMcpServer({ toolBridge, coerceArgs, run, extraTools, tabRiskRegistry })` (host/agent/companion.js ~3944) builds an internal MCP server whose tools the LLM calls; host-implemented tools ride in `extraTools` (today: `askUserTool`, `createDocumentTool`, `pageSnapshotsTool`, `proposeHealTool`). `canUseTool` (built ~4007) gates every send-class call with the run's approval registry.
- **Jev run (`typesafe`)**: `runTypesafeRun({ run, toolBridge, coerceArgs, canUseTool, provider, limits })` (host/agent/jev/runtime.js line 342) owns the whole loop. It calls the browser through the same `toolBridge` and gates through the same `canUseTool`. It does its own configured-model planning (`prepare("start")` / `replan`), completion verification and report. `provider` carries `goal`, the Jev source/endpoint/apiKey, `textModel`+apiKey, `tabId`, `sendScreenshots`, `consultSources`, `conversation`.

The profile schema (host/agent/settings/profile-schema.js) already stores the Jev fields (`typesafeSource`, `typesafeDecisionSource`, `textModelBaseUrl`, `textModelId`, per-key secrets) as flat profile fields, not structurally gated by `providerType`. `set_typesafe_config` / `set_typesafe_credentials` envelopes exist in companion.js (~2753-2809).

The idea comes from ulka's `browser_subgoal` (its `AgentRunner` with `completionMode: 'subgoal'` returns an unverified checkpoint, and its FX planner owns task completion). It is reimplemented in plain JS; nothing is imported from ulka.

## Goals / Non-Goals

**Goals:**
- Let an LLM run delegate one bounded interaction to Jev via a `browser_subgoal` tool.
- Keep every existing guard; the sub-run shares the caller's lease, tab, toolBridge and canUseTool.
- Offer the tool only when Jev is configured; silent absence otherwise.
- Return an unverified checkpoint; the LLM keeps ownership of planning and final verification.

**Non-Goals:**
- Making Jev the sole driver of an LLM run. This is additive; the LLM still has its direct tools.
- Per-subgoal task-level LLM planning/verification/report.
- Action caching, `extract_page`, iframe/remote MCP, or any change to the standalone `typesafe` run.

## Decisions

1. **`browser_subgoal` is an `extraTools` entry, added conditionally.** In `_runAfterLeaseGranted`'s SDK branch, when the resolved profile snapshot carries a complete Jev configuration (source + typesafe apiKey + textModel + textModel apiKey), push a `browser_subgoal` tool into the `extraTools` array passed to `createBrowserMcpServer`. When any field is missing, do not push it — the tool simply does not exist for that run (WebMCP silent-absence pattern). This keeps the 26-operation executor baseline untouched (it is an SDK extra tool, like `ask_the_user`, not an executor operation).

2. **The tool handler runs `runTypesafeRun` in subgoal mode.** The handler validates `goal` (non-empty string), then calls `runTypesafeRun({ run, toolBridge: this.toolBridge, coerceArgs: this.coerceArgs, canUseTool, provider, limits })` where:
   - `provider.goal` = the tool's `goal` argument; `provider` Jev source/endpoint/apiKey + textModel/apiKey come from the resolved profile snapshot; `provider.tabId` = the outer run's bound tab; `provider.sendScreenshots` per profile; `provider.conversation` = empty/minimal (the subgoal is self-contained).
   - `canUseTool` is the SAME instance the SDK run built, so approvals, single-use grants and the pending-approval tracker are shared.
   - `limits` = a subgoal profile with smaller `maxActions`/`maxDecisions`/no-progress budgets, plus a new `mode: "subgoal"` flag.

3. **Subgoal mode in `runTypesafeRun`.** A new `mode === "subgoal"` (via `limits.mode` or an explicit parameter) is the standalone loop **minus task-level completion verification/report**, plus smaller bounds, plus a checkpoint terminal. It changes exactly three things and nothing else:
   - **Content preparation is KEPT.** `prepare("start")` and bounded `replan(...)` still run — they ARE Jev's per-subgoal content preparation (the same role ulka's `TextEngine` plays inside a subgoal). `requestActionPlan` in this codebase returns `memory` + `textValues` + `navigation` together, and `questions.js` offers TYPE_TEXT/NAVIGATE candidates to Jev ONLY from `prepared.textValues`/`prepared.navigation`; so skipping `prepare()` would make every non-literal typed value and every planned navigation impossible. The returned `memory.plan`/`memory.doneWhen` is scoped to the single subgoal text and feeds Jev's `goal_done` monitor (so Jev knows when to return the checkpoint) — it is content and a stop signal, never handed to an LLM completion verifier. The operator-literal fast path (jev-literal-field-values) still applies, sourced from `provider.goal` (the subgoal text).
   - **No task-level completion verification/report.** A Jev DONE, or a positive `goal_done` monitor, ends the sub-run as an unverified checkpoint; `requestCompletionCheck`/`requestFinalReport` are NOT called. This is the one behavioral subtraction versus standalone.
   - **Smaller bounds.** The subgoal budgets from `limits` apply: small `maxActions`/`maxDecisions`/no-progress, and `maxMemoryUpdates` of 1–2 so `replan`/`stuck` behave exactly as standalone but within a tiny budget. All other guards, gates and the no-progress/scroll/stop/result-unknown machinery are byte-for-byte the standalone path.
   - Because `prepare()`/`replan()` are retained, there is no loop-invariant seam to force: `memory`/`prepared` are populated exactly as in a standalone run. The only guarded skip is the completion-check/report call at the DONE/`goal_done` branch.

4. **Checkpoint result contract.** The handler maps the sub-run's return into `{ status: "checkpoint" | "blocked", unverified: true, subgoalId, url, title, actions: [{ operation, targetLabel, targetRole, outcome }], reason, needsOperator? }`, with TYPE_TEXT values omitted (reuse the existing `omitValue` summary rule), and a fixed note that the caller must inspect it and owns final verification. `subgoalId` is the SAME id the handler minted and passed as `provider.subgoalId` (decision 6) — present even on a start/transport failure, when no `checkpoint` came back from the sub-run. A start/transport failure maps to a bounded named failure (`status: "error"`, host-authored reason, no secrets), never a success. The outer tool result carries this object; the outer run continues regardless.

5. **Credentials gating, endpoint, and honesty.** The availability gate honors user decision 1 (a separate Jev key, never the Anthropic key) by requiring the one decision source that carries its own key: `typesafeDecisionSource === "openai"` (enum in host/agent/settings/profile-schema.js:88 = `openai` | `anthropic` | `chatgpt`; only `openai` uses a separate base URL + model id + key — the `anthropic`/`chatgpt` sources reuse the operator's Anthropic key or a minted gateway token, which decision 1 excludes and which would drag in gateway-token lifecycle). Full gate: an `anthropic`/`chatgpt` run **and** `typesafeDecisionSource === "openai"` with its base URL + model id + key present **and** the Jev transport source (`typesafeSource`) + typesafe apiKey present **and** the text model + text-model apiKey present.
   - **Endpoint.** `profile.baseUrl` is provider-multiplexed (on an `anthropic`/`chatgpt` profile it holds the Anthropic endpoint), so the sub-run's Jev transport endpoint MUST come from `typesafeDefaultForSource(resolveTypesafeSource(profile))`, never `profile.baseUrl`.
   - **Plumbing.** `resolveProfileSnapshot`/`snapshotForRun`'s `anthropic`/`chatgpt` branch (host/agent/settings/profile.js ~1402-1449) returns no Jev fields today, and the resolver helpers (`readTypesafeKeys`, `resolveTypesafeDecisionModel`, `typesafeDefaultForSource`, `resolveTypesafeSource`) are private to profile.js. Add ONE new exported resolver in host/agent/settings/profile.js that returns the resolved Jev config (transport source + endpoint + apiKey, decision model, text model + apiKey) for both the gate and the sub-run `provider` — or `null` when the gate is unmet. No schema-shape change.
   - **Honesty.** A present-but-invalid Jev key or an unpassed capability test is not a gating failure (the tool is still offered) but a run-time failure (the call returns a bounded named failure). No fallback to the Anthropic/Gateway key.

6. **Observability.** The handler mints a `subgoalId` per call and passes it as `provider.subgoalId`; the sub-run emits the existing `jev_step`/`jev_end` records tagged as subgoal-originated with that SAME id (`subgoal: true`, `subgoalId`) so the panel can attribute them, and the checkpoint returned to the outer tool call carries the identical `subgoalId` (decision 4), letting the outer tool-call record reference the exact sub-run outcome. No assistant text is fabricated. This reuses the existing event channel and the panel's allowlist renderer tolerates the extra tag.

7. **Settings — confirmed no host change.** `set_typesafe_config`/`set_typesafe_credentials` (companion.js ~2753-2823) and `setTypesafeConfig`/`setTypesafeCredentials` (profile.js ~748-963) have NO `providerType` gate: they already persist Jev config on any profile with the shape unchanged. So the host needs only the new exported resolver from decision 5 to READ that config for `anthropic`/`chatgpt` gating; no settings envelope, writer, or persisted-shape change, and no `agent-settings` spec change. The extension-side settings UI hides these fields for non-`typesafe` provider types — an out-of-scope, extension-side gap noted here, not fixed by this change.

## Risks / Trade-offs

- [The LLM treats the checkpoint as success] → The result is explicitly marked `unverified: true` with a fixed caller-owns-verification note, mirroring the existing checkpoint contract Browzy already uses.
- [One content-prep model call per subgoal adds cost versus a literal-only path] → Accepted (user decision A): it is the only way a subgoal can type non-literal values or plan a navigation, and it matches ulka's per-subgoal `TextEngine` call. Bounded by `maxMemoryUpdates` 1–2 so a subgoal cannot spend the standalone planning budget.
- [A subgoal loops or burns budget] → Smaller bounded subgoal budgets and the unchanged no-progress/scroll guards end it blocked with a named reason.
- [Parallel sessions hold uncommitted edits in runtime.js/companion.js] → All edits are additive and localized (a new mode branch, a new extraTool). Build on current contents; revert nothing.
- [Sensitive actions inside a subgoal bypass approval] → They do not: the sub-run shares the caller's `canUseTool`, so send-class actions suspend on the same cards.

## Migration Plan

Additive and opt-in. A profile without Jev config sees no change. Rollback = remove the `extraTools` registration and the subgoal-mode branch; standalone `typesafe` and existing SDK runs are untouched.

## Open Questions

None blocking. One to confirm at implement time (decision 7): whether the existing settings envelopes already accept Jev config on an `anthropic`/`chatgpt` profile, or need a minimal gate relaxation.

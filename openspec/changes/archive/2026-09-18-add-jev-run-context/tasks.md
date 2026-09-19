# Tasks: add-jev-run-context

## 1. Model call contracts (`host/agent/jev/text-helper.js`)

- [x] 1.1 Add the shared memory validator: strict JSON, exactly `plan` / `doneWhen` / `notes` string keys, per-field bounds (600 / 300 / 600) matching design.md §1
- [x] 1.2 Add `RUN_PLAN` (goal + first page → memory) and `requestRunPlan`, replacing `GOAL_UNDERSTANDING` / `requestGoalUnderstanding`
- [x] 1.3 Add `MEMORY_REVISION` (goal + previous memory + recent actions + page → memory) and `requestMemoryRevision`
- [x] 1.4 Add `COMPLETION_CHECK` (`{achieved, report?, memory?}`, report ≤ 1400 only when achieved, memory only when not) and `requestCompletionCheck`; delete `RESULT_SUMMARY` / `requestResultSummary` and its callers in the runtime
- [x] 1.5 Keep the transport/reasoning/timeout rules untouched (the `requestTextValue` / `requestNavigationUrl` helpers this originally kept were later deleted by 9.1) and update `host/test/jev-text-helper.test.mjs` for the new instructions' parse matrices and the removed ones ← (verify: every new instruction has malformed/oversize/missing-key rejection tests; no dead exports of the removed instructions remain)

## 2. Decision request state (`host/agent/jev/questions.js`)

- [x] 2.1 `buildQuestionRequest` (reshaped to `buildSelectionRequest` by 9.2) takes `memory` (object) in place of `understanding`: emit `state.memory` with exactly `plan` / `doneWhen` / `notes` when present, omit the key entirely when absent
- [x] 2.2 Extend the request's instruction material with the memory sentence (operator plan/context to steer by; page content stays untrusted data; ownership rules unchanged)
- [x] 2.3 Update `host/test/jev-questions.test.mjs`: memory present/absent/partial shapes, bounds, and that questions/observation assembly is otherwise byte-identical (assembly later reshaped by 9.2's single-head request)

## 3. Runtime loop (`host/agent/jev/runtime.js`)

- [x] 3.1 Add exported bounds: `MEMORY_UPDATE_EVERY_ACTIONS = 5`, `MAX_MEMORY_UPDATES = 8`, `MAX_VERIFICATION_REJECTIONS = 3`, `MAX_RECOVERIES = 2`; extend the `limits` overrides for tests
- [x] 3.2 Plan call after the first successful observation, before the first decision; failure leaves no `state.memory`; stop during the call discards it
- [x] 3.3 Memory revisions: triggers (page identity change, cadence of 5 executed actions, stall entry), global cap 8, whole-memory replacement, advisory failures, stop discard, `jev_memory` emitted on success with `index` / `kind` / `trigger` / `memory` / `latencyMs`
- [x] 3.4 Completion check on `DONE`: confirm → `jev_result` + `done` with `doneVerified: true`; reject → step `skippedReason: "completion_rejected"` + `verification` + optional memory revision + continue, bounded by 3 → blocked `completion_unverified`; unavailable → `done` with `doneVerified: false` + `summaryError`, step `verification: { achieved: null, error }`
- [x] 3.5 Stall recovery at the three guard sites: one consultation per trigger while the recovery bound allows; `continue` + valid memory resets the guards and records the recovery; refusal/failure/bound ends blocked with the original reason
- [x] 3.6 Extend `JEV_REASON_VOCABULARY`: blocked `completion_unverified`, step `completion_rejected`
- [x] 3.7 Update `host/test/jev-runtime.test.mjs` for every new path (plan failure, revision triggers and cap, all three check outcomes, rejection bound, recovery continue/block/failure, stop during consultations) with the mock model server ← (verify: each path's terminal `jev_end` carries the design §7 fields and reasons; guards reset only on a successful recovery; no dispatch ever originates from a consultation)

## 4. Protocol vocabulary (`host/agent/protocol.js`)

- [x] 4.1 Add `JEV_EVENT_TYPES.MEMORY = "jev_memory"` with the payload contract (design §7), and extend the `STEP` / `END` payload comments for `verification`, `doneVerified`, and the new reasons
- [x] 4.2 Update any protocol/store test that enumerates the durable Jev event kinds

## 5. Companion run path

- [x] 5.1 Confirm `_runTypesafe` needs no signature change; adjust only what the new `limits`/imports require; keep `unsupported_in_typesafe_mode` and identity binding untouched
- [x] 5.2 Update `host/test/agent-typesafe-run.test.mjs` fixtures so a `DONE` stub answers the completion check and the run-path assertions still hold ← (verify: run-path branches for attachments/skills/identity are unchanged; a done run's terminal record now carries `doneVerified`)

## 6. Panel: mapping, copy, outcome

- [x] 6.1 `conversation-model.js`: map `jev_memory` into `toolRows` (deterministic key `jev_memory_<index>`, `row.jevMemory` verbatim), render the `DONE` step's `verification`, carry `doneVerified` into `turn.jevOutcome`
- [x] 6.2 `tool-labels.js`: labels for memory kinds (`plan` / `update` / `recovery`) and triggers, `jevStepDetail` extension for verification, `completion_unverified` + `completion_rejected` in `JEV_REASON_LABELS_VI`, and the outcome line's verified / judgment-only / unverified distinctions
- [x] 6.3 `sidepanel.js`: outcome line renders the new distinctions (no layout change beyond the line's copy)
- [x] 6.4 Update extension tests: `test/sidepanel-conversation-model.test.mjs` (memory rows, rebuild determinism, label coverage of the two new reasons, outcome states) and any tool-label suites
- [x] 6.5 `extension/settings/settings.html`: text-model field hint describes the broadened role (plan, context revisions, completion check, text values) ← (verify: label-coverage test passes with the runtime vocabulary; a rebuilt transcript shows memory rows in order without duplication)

## 7. Docs

- [x] 7.1 README: rewrite the "Run it on TypeSafe (Jev)" loop description (memory, verified completion, recovery, the added small-model calls) and the side-panel status line for memory rows + verified outcome
- [x] 7.2 Confirm the agent-settings disclosure copy in `extension/settings/settings.html` matches the modified `agent-settings` requirement ← (verify: README statements match the shipped behavior; no copy promises an independent verification the implementation cannot make)

## 8. Final verification sweep

- [x] 8.1 Run the focused suites: `host/test/jev-*.test.mjs`, `host/test/agent-typesafe-run.test.mjs`, `test/sidepanel-*.test.mjs`, and the registry/label tests; fix fallout inside scope only — done within the change's scope: every named suite ran green in verification rounds 3 and 4 and `openspec validate add-jev-run-context --strict` is valid; unrelated suites untouched ← (verify: all green; no unrelated suite edited; the change's spec deltas still validate with `openspec validate add-jev-run-context --strict`)

## 9. Labour-split rework (user clarification: Jev = element selection only; the configured model decides everything)

- [x] 9.1 `text-helper.js`: add `NEXT_STEP` — the step decision: strict `{operation, intent?, text?, url?}` with the operation vocabulary, `intent` (≤ 200) required for `CLICK`/`TYPE_TEXT`/`SELECT`, `text` (≤ 2000) for `TYPE_TEXT`, absolute `http(s)` `url` for `NAVIGATE`; only those keys are read; the ported NEXT_ACTION discipline rides the instruction — and `TARGET_SELECTION`, the element-selection question instruction. Delete `TEXT_VALUE` / `NAVIGATION_URL` and `requestTextValue` / `requestNavigationUrl`. Update `host/test/jev-text-helper.test.mjs` ← (verify: step-decision parse matrix — every missing/wrong-type/oversize/unknown-key/unknown-operation case refused, every legitimate shape accepted; the deleted helpers leave no dead exports)
- [x] 9.2 `questions.js`: build the element-selection request for one decided operation — exactly one `<op>_target` question, no operation question; `state` = goal + memory + observation + recent actions + the step's `intent`; reuse the candidate machinery, `<index>:<option>` keys, fitter and omission disclosure; instruction = `TARGET_SELECTION`; update `host/test/jev-questions.test.mjs`
- [x] 9.3 `runtime.js`: per cycle — `requestStepDecision` (goal + memory + page + recent actions) → validate and route: malformed → end `error`/`invalid_decision`, nothing dispatched; target-bearing with no compatible candidate → `target_unresolved` skip, counts one toward no-progress, loop continues; `TYPE_TEXT` missing value → blocked `missing_value`; `NAVIGATE` missing url → blocked `missing_value`, invalid url → named failure; `DONE` → completion check (§4); `BLOCKED` → blocked; `CLICK`/`TYPE_TEXT`/`SELECT` → exactly one element-selection request → resolve the selected key → dispatch. Step record: `{operation, intent?, target, targetProbability, confidence, latencies:{decisionMs, selectionMs?, dispatchMs}}`; `operationProbability` removed. Also fold the round-2 finding: a stop that landed during the decision request must end the run `stopped` on every terminal path (an exhausted recovery bound and `model_blocked` included) — prefer `stopped` over `blocked` when the run is no longer running, with tests. Update `host/test/jev-runtime.test.mjs` ← (verify: every route covered with the mock endpoints; no post-stop call or dispatch; step record carries no operationProbability; invalid decisions dispatch nothing)
- [x] 9.4 `protocol.js` + panel mapping/copy: update the `jev_step` payload docs; `conversation-model.js` copies the reshaped step fields; `tool-labels.js` step copy reads as the configured model's operation → the element Jev selected (with its probability, confidence, selection latency, and the intent), operation-probability copy removed; update `test/sidepanel-conversation-model.test.mjs` + `test/sidepanel-streaming-render.test.mjs` ← (verify: exact-coverage label test still green; reconnect rebuild determinism intact) — panel side done by ReworkJevSplitPanel; protocol.js's payload docs done by ReworkJevSplitHost
- [x] 9.5 Copy: `extension/settings/settings.html` (text-model hint + disclosure: element-selection requests to TypeSafe; plan / each step decision / context revisions / completion check / stall-recovery consultations / generated text values to the text-model endpoint) and README (loop description: the configured model decides each step, Jev selects the element; call families and costs) ← (verify: copy matches the updated deltas and claims no more than the code does)
- [x] 9.6 Run the focused suites (`cd host && node --test test/jev-*.test.mjs test/agent-typesafe-run.test.mjs`; `node --test test/sidepanel-*.test.mjs`) and `openspec validate add-jev-run-context --strict` — done: all green in verification rounds 3 and 4 ← (verify: green; only in-scope files edited)
- [x] 9.7 Stop-ordering closure on every terminal path (verification rounds 3-4): guard the step-decision refusal/transport routes, the element-selection windows (resolving and failing), and the failing stall-recovery consultation so a stop that landed in any of those windows ends the run `stopped`; one test per route — done: round-4 harness 158/158 with the rerouted row, round-3 harness 12/12 STOP WINS, jev-runtime 62/62 ← (verify: the round-3/4 harness rows all report STOP WINS; running-run mappings unchanged)

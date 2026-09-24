# Tasks: Task Memory

Scope excludes the workflow registry/schema, the recorder, the approval policy and classifier, and the browser tool registry.

## 0. Baseline

- [x] 0.1 Re-read `host/agent/skills/workflows-materialize.js` (trail window, tool-call extraction, identity extraction, `screenTrailArgs`), `host/agent/tools/query-options.js` (system-prompt section assembly), `host/agent/jev/runtime.js` (the within-run `memory` — a different thing; confirm no name collision in code, events or copy), and `host/agent/companion.js`'s `run_done` / `DELETE_CONVERSATION` paths; record findings in this change's implementation evidence only. (Evidence: Jev's within-run memory is `jev_memory` / `provider.memory`; this change uses `task memory`, `memory_recalled`, `task_memory` and `priorPathAdvice` throughout — no collision. `recordedStartUrl` was exported from materialize for reuse; no second trail reader exists.)
- [x] 0.2 Confirm the transcript events a completed run leaves behind (`run_created`, `stream_message` tool_use blocks, `jev_step`, `run_done`) on a real recent conversation under `OCIC_AGENT_HOME`, so derivation is built against actual bytes ← (verify: a `run_stopped`/`run_error` trail is distinguishable from `run_done` without heuristics) (Evidence: `SessionManager.finishRun()` always calls `markDone()`, so a `run_error` run ALSO ends with `run_done`; `runSucceeded()` therefore scans the whole window for `run_error` / `run_stopped` / non-done `jev_end` / drift, pinned by task-memory-derive "run_error followed by finishRun()'s run_done derives nothing".)

## 1. Storage

- [x] 1.1 `host/agent/storage/paths.js`: `memoryRoot()` (`<agentRoot()>/memory`) and `memoryHostDir(hostHash)` through `assertSafeId`; no path logic elsewhere
- [x] 1.2 `host/agent/memory/store.js`: `TaskMemoryStore` with `write`, `listForHost`, `listAll`, `freshForHost`, `get`, `forget`, `forgetHost`, `forgetAll`, `forgetByConversation`, `reinforce`, `markStale`; `TASK_MEMORY_SCHEMA_VERSION = 1`; rejecting guards `MAX_MEMORY_BYTES = 64 KiB`, `MAX_STEPS = 40`, `MAX_INTENT_CHARS = 200`; eviction caps `MAX_PER_HOST = 20`, `MAX_TOTAL = 400` (stale first, then least recently confirmed); the schema rejects any `approve`/`remember`/scope-like key; corrupt file ⇒ listed invalid with reason; missing root ⇒ empty; atomic writes; a repeat (intent and step sequence each ≥ 80 %) replaces instead of accumulating. `host/agent/memory/settings.js` holds the switch (default on).
- [x] 1.3 `host/test/task-memory-store.test.mjs` (19/19): round-trip; per-host listing; hostile ids rejected; oversize/too-many-steps/overlong intent rejected not truncated; eviction order; `forget*` remove exactly the named entries and prune empty host dirs; corrupt entry marked invalid; forbidden authority-shaped keys rejected; settings persist ← (verify: no path outside `memoryRoot()` is ever touched — asserted over the scratch tree)

## 2. Derivation

- [x] 2.1 `host/agent/memory/derive.js`: pure `deriveTaskMemory(...)` reusing `runTrailWindow`, `extractRunToolCalls`, `extractRunTargetIdentities`, `recordedStartUrl`, `TRAIL_EXCLUDED_TOOL_REFS`, `screenTrailArgs`, `freezeStableTargets`; only a clean `run_done` trail derives; a screened-out step becomes `{ omitted: true, tool, reason }` in place; typed values and script source dropped with `valueOmitted`/`scriptOmitted`; credential-shaped control names not kept; `intent.text` bounded and the privacy flag pauses writing entirely; `intent.tokens` normalized (case + punctuation folded, diacritics kept); `DERIVE_VERSION = 1`
- [x] 2.2 `host/test/task-memory-derive.test.mjs` (18/18): SDK-tool trail and Jev `jev_step` trail both derive; `run_error`+`run_done`, `run_stopped`, Jev blocked and drift derive nothing; bookkeeping and conversation tools dropped; credential-shaped keys name the key never the value; typed text never stored; identity frozen as role/name; tool results and assistant text never appear; privacy pauses writing ← (verify: the record contains no string that appears only in a tool result)

## 3. Recall

- [x] 3.1 `host/agent/memory/recall.js` + `intent.js`: pure `recallForRun({ memories, host, request, explicitRepeat })` → ≤ 3 candidates; exact host via `normalizeHost`; Jaccard on `intent.tokens`; repeat-cue bonus; `RECALL_MIN_SCORE = 0.35`; stale excluded; an explicit repeat offers the best site match below threshold as `explicit_repeat`
- [x] 3.2 `host/test/task-memory-recall.test.mjs` (13/13): real Vietnamese requests; same host different intent ⇒ none; different host same intent ⇒ none; explicit repeat; stale excluded (even on repeat); ordering, cap and input-order independence; measured: an unaccented request does not match an accented memory (diacritics are not folded — the design's open question stays open, now with a number) ← (verify: deterministic — no clock or randomness)

## 4. Delivery to the model and to Jev

- [x] 4.1 `host/agent/memory/guidance.js`: `renderTaskMemorySystemPrompt(serverName, candidates, extraToolNames)` → `## What worked on this site before` or `null`; names `task_memory` only when registered; standing "past evidence, verify live, permissions unchanged" framing; bounded to 2000 characters; `renderPriorPathAdvice` for Jev
- [x] 4.2 `host/agent/tools/query-options.js`: `taskMemoryGuidance` appended beside the Jev preference section with the same `.filter(Boolean).join()` discipline ← (verify: task-memory-guidance "byte-identical" through the real `buildIsolatedOptions`; wiring test shows `prompt` untouched)
- [x] 4.3 `host/agent/jev/text-helper.js` + `runtime.js` + `tools/browser-subgoal.js`: optional `priorPathAdvice` on the plan request as `prior_path_advice` (bounded), described in the plan instruction as untrusted context; selection, verification and all bounds unchanged ← (verify: only the plan request reads it; the decision request and selection code are untouched)
- [x] 4.4 `host/test/task-memory-guidance.test.mjs` (8/8): section shape and framing; null on empty; tool named only when registered; bound enforced; the plan request carries the advice and omits it when absent

## 5. The read-only tool

- [x] 5.1 `host/agent/tools/task-memory.js` (+ `task-memory-name.js`): `task_memory` with `recall` and `list` only, pinned to the run's bound host
- [x] 5.2 `host/test/task-memory-tool.test.mjs` (8/8): both actions through the factory; another host refused; no bound page is a named error; calls never change the store ← (verify: the module has no call to any store writer — asserted over its source)

## 6. Companion wiring and lifecycle

- [x] 6.1 `host/agent/companion.js`: `_prepareTaskMemory` at run start (switch read fresh, recall for the bound host), the tool in `extraTools` **and** `extraToolNames`, guidance into the options, one durable `memory_recalled` event once the options are built ← (verify: registered AND visible — page-snapshots-tool's source-level wiring guard still passes, and task-memory-wiring checks the qualified name in the run's visible tools)
- [x] 6.2 `_settleTaskMemory` after `finishRun()` (deferred with `setImmediate`): clean success ⇒ reinforce offered ids and derive + write (unless the switch is off or the privacy control paused it); `run_error`, drift, a non-done Jev end, or an operator stop after a failed step ⇒ `markStale` on the offered ids
- [x] 6.3 `DELETE_CONVERSATION` forgets the conversation's memories first and answers `memory_forget_failed` (nothing deleted) if that fails; delete-all forgets per removed conversation and reports a failure as a partial sweep
- [x] 6.4 `host/agent/protocol.js` `validateStartPrivacy` (START `privacy: { rawPromptCaching }`, malformed refused); settings relay ops `task_memory_get_settings`, `task_memory_set_settings`, `task_memory_list`, `task_memory_forget` (`{ host } | { all: true }`), handled before the provider-settings module loads; allowlisted in `extension/background.js`
- [x] 6.5 `host/test/task-memory-wiring.test.mjs` (10/10) through the real `CompanionCore`: first visit writes and recalls nothing; a later run in a new conversation gets the guidance, the tool and one `memory_recalled` event, and reinforces instead of duplicating; an erroring run stales it; a later success re-confirms it; switch off ⇒ no recall, no write, no tool; privacy ⇒ recall only; malformed privacy refused; relay ops; deletion forgets ← (verify: no module under `host/agent/policy/` imports the memory modules — asserted)

## 7. Panel and settings

- [x] 7.1 `extension/sidepanel/conversation-model.js` keeps `memory_recalled` as `turn.memoryRecall` (apart from `toolRows`, overwrite-on-replay); `sidepanel.js` renders "Đã tham khảo cách làm lần trước · <host> · <khi nào>" inside the run's timeline card, outside the counted list, with no state icon; `sidepanel.css` `.memory-recall-note` uses tokens only. `panel-controller.js`/`protocol-client.js` send the history privacy policy with every START.
- [x] 7.2 `extension/sidepanel/tool-labels.js`: `task_memory` → "Đã xem lại cách làm lần trước"
- [x] 7.3 Switch "Ghi nhớ cách làm việc" (default on) with the hint that "Không lưu nội dung câu hỏi" pauses new memories — on the memory settings page below
- [x] 7.4 Management surface: its own Settings page (`extension/settings/memory.html` + `memory-app.js` / `memory-controller.js` / `memory-client.js`), linked from Settings > Skills & tiện ích: list per site (site, intent, step count, last confirmed, reuse count, state), "Quên trang này", "Quên tất cả" with a second-click confirmation, explained empty state; real `<input type="checkbox" role="switch">` and `<button>`s. Rendered in headless Chromium at 320 (light), 400 (light, dark) and 480 (dark): no page errors, no horizontal overflow.
- [x] 7.5 `test/sidepanel-memory-recall.test.mjs` (disclosure once, replay-safe, not counted, renderer placement, START privacy, label) and `test/settings-memory-controller.test.mjs` (28 checks: load, switch round-trip and failure, forget success/failure, empty state, wire ops, page copy); `test/background-agent-settings-relay.test.mjs`'s drift guard now reads `memory-client.js`

## 8. Validation

- [x] 8.1 All `host/test/task-memory-*.test.mjs` pass; every other host and root test file was run: the only failures (`agent-settings-relay`, `settings-all`, `settings-capability-test`, `skills-scope-verification`, `settings-ui-real-companion`) fail identically on the base commit because this container runs as root and the Claude CLI refuses `--dangerously-skip-permissions` under root; `node test/design-tokens-contrast.test.mjs` passes; `openspec validate add-task-memory --strict` passes
- [ ] 8.2 Live QA: run a site task twice in two conversations in a real browser with a real provider; confirm the second run's guidance names the first run's steps, the disclosure line appears, the operation count excludes it, every permission is still asked, and a deliberately changed page marks the memory stale on the next failure ← (verify: no action was taken that the same run without memory would not have been asked about) — NOT done here: it needs the extension loaded in a real browser and a live provider, neither available in this environment; structural tests do not substitute for it

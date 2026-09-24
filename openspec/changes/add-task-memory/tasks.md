# Tasks: Task Memory

All tasks unchecked. Scope excludes the workflow registry/schema, the recorder, the approval policy and classifier, and the browser tool registry.

## 0. Baseline

- [ ] 0.1 Re-read `host/agent/skills/workflows-materialize.js` (trail window, tool-call extraction, identity extraction, `screenTrailArgs`), `host/agent/tools/query-options.js` (system-prompt section assembly), `host/agent/jev/runtime.js` (the within-run `memory` — a different thing; confirm no name collision in code, events or copy), and `host/agent/companion.js`'s `run_done` / `DELETE_CONVERSATION` paths; record findings in this change's implementation evidence only
- [ ] 0.2 Confirm the transcript events a completed run leaves behind (`run_created`, `stream_message` tool_use blocks, `jev_step`, `run_done`) on a real recent conversation under `OCIC_AGENT_HOME`, so derivation is built against actual bytes ← (verify: a `run_stopped`/`run_error` trail is distinguishable from `run_done` without heuristics)

## 1. Storage

- [ ] 1.1 `host/agent/storage/paths.js`: `memoryRoot()` (`<agentRoot()>/memory`) and `memoryHostDir(hostHash)` through `assertSafeId`; no path logic elsewhere
- [ ] 1.2 `host/agent/memory/store.js`: `TaskMemoryStore` with `write`, `listForHost`, `listAll`, `get`, `forget`, `forgetHost`, `forgetAll`, `forgetByConversation`, `reinforce`, `markStale`; `TASK_MEMORY_SCHEMA_VERSION = 1`; rejecting guards `MAX_MEMORY_BYTES = 64 KiB`, `MAX_STEPS = 40`, `MAX_INTENT_CHARS = 200`; eviction caps `MAX_PER_HOST = 20`, `MAX_TOTAL = 400` (least-recently-confirmed first, stale before fresh); the schema rejects any `approve`/`remember`/scope-like key; corrupt file ⇒ listed invalid with reason; missing root ⇒ empty
- [ ] 1.3 `host/test/task-memory-store.test.mjs`: round-trip; per-host listing; hostile host hash and id rejected; oversize entry rejected not truncated; eviction order; `forgetHost`/`forgetAll`/`forgetByConversation` remove exactly the named entries and prune empty host dirs; corrupt entry marked invalid; forbidden authority-shaped keys rejected — all against a scratch `OCIC_AGENT_HOME` ← (verify: no path outside `memoryRoot()` is ever touched)

## 2. Derivation

- [ ] 2.1 `host/agent/memory/derive.js`: pure `deriveTaskMemory({ conversationEvents, runId, request, metaHostname, startedAt, endedAt, now, privacy })` reusing `runTrailWindow`, `extractRunToolCalls`, `extractRunTargetIdentities`, `TRAIL_EXCLUDED_TOOL_REFS`, `screenTrailArgs`, `freezeStableTargets`; only a `run_done` trail derives; a screened-out step becomes `{ omitted: true, tool, reason }` in place; `intent.text` bounded and `null` when `privacy.rawPromptCachingDisabled`; `intent.tokens` normalized (case + punctuation folded, diacritics kept); `DERIVE_VERSION = 1`
- [ ] 2.2 `host/test/task-memory-derive.test.mjs`: SDK-tool trail and Jev `jev_step` trail both derive; `run_stopped`/`run_error`/blocked/drift derive nothing; excluded bookkeeping tools dropped; credential-shaped arg keys and high-entropy values become `omitted` steps naming the key never the value; typed text never stored; element identity frozen as `role`/`name`; assistant text and tool results never appear in the record; privacy flag nulls `intent.text` ← (verify: the record contains no string that appears only in a tool result)

## 3. Recall

- [ ] 3.1 `host/agent/memory/recall.js`: pure `recallForRun({ memories, host, request, explicitRepeat })` → ≤ 3 candidates; exact host via `normalizeHost`; Jaccard on `intent.tokens`; repeat-cue bonus; `RECALL_MIN_SCORE = 0.35` exported; stale entries excluded; `explicitRepeat` offers the best host match below threshold marked `why: "explicit_repeat"`
- [ ] 3.2 `host/test/task-memory-recall.test.mjs`: fixture of real Vietnamese requests (accented and unaccented variants); same host different intent ⇒ no candidate; different host same intent ⇒ no candidate; explicit repeat cue; stale excluded; ordering and cap ← (verify: the function is deterministic across runs and uses no clock or randomness)

## 4. Delivery to the model and to Jev

- [ ] 4.1 `host/agent/memory/guidance.js`: `renderTaskMemorySystemPrompt(serverName, candidates, extraToolNames)` → section `## What worked on this site before` or `null`; names `task_memory` only when registered; carries the standing "past evidence, verify live, permissions unchanged" instruction; bounded to 2000 characters
- [ ] 4.2 `host/agent/tools/query-options.js`: accept `taskMemoryGuidance` and append it beside the Jev preference section with the same `.filter(Boolean).join()` discipline ← (verify: with no candidates `systemPromptText` is byte-identical to before; guidance never enters `prompt`)
- [ ] 4.3 `host/agent/jev/client.js` + `runtime.js`: accept optional bounded `priorPathAdvice` on the plan request and render it under the goal as advice; selection, verification and all bounds unchanged ← (verify: an advised step absent from the live snapshot is not selectable)
- [ ] 4.4 `host/test/task-memory-guidance.test.mjs`: section shape; null on empty; tool named only when registered; bound enforced; Jev plan request carries the advice verbatim and nothing else changes in its shape

## 5. The read-only tool

- [ ] 5.1 `host/agent/tools/task-memory.js`: `TASK_MEMORY_TOOL_NAME = "task_memory"`, `createTaskMemoryTool({ run, store, host, toolFactory })` mirroring `create-document.js`; actions `recall` (offered candidates' full steps) and `list` (site's fresh summaries); host pinned to the run's bound page; no write/forget/note action
- [ ] 5.2 `host/test/task-memory-tool.test.mjs`: both actions through the factory with a scratch store; a request naming another host is refused; every error is a named non-throwing result ← (verify: the tool has no code path that writes to the store)

## 6. Companion wiring and lifecycle

- [ ] 6.1 `host/agent/companion.js`: at run start, when `taskMemoryEnabled`, load the bound host's memories, call `recallForRun`, render guidance into the options, register the tool in `extraTools` **and** `extraToolNames`, emit one durable `memory_recalled` transcript event `{ runId, memoryIds, host, confirmedAt[] }` ← (verify: registered AND visible; grep both sites agree)
- [ ] 6.2 On `run_done`: derive and `write` (unless the toggle is off or raw prompt caching is disabled); `reinforce` every id in the run's `memory_recalled` event. On `run_error`, operator `run_stopped` after a failed step, Jev `blocked`, or drift on the same host: `markStale` those ids ← (verify: derivation runs after the terminal event is persisted and never delays the panel outcome)
- [ ] 6.3 `DELETE_CONVERSATION` / delete-all: `forgetByConversation` inside the same atomic-or-reported contract as transcript deletion
- [ ] 6.4 `host/agent/protocol.js` + settings relay: `task_memory_list`, `task_memory_forget` (`{ host } | { all: true }`), `get/set` of `taskMemoryEnabled`; validation rejects unknown shapes
- [ ] 6.5 `host/test/agent-run-lifecycle` neighbours or a new `task-memory-wiring.test.mjs`: recall → guidance present; `run_done` writes and reinforces; failure marks stale; toggle off ⇒ no recall and no write; privacy on ⇒ recall only; conversation deletion forgets; a recalled `form_input`/submit step still produces a `canUseTool` decision ← (verify: no approval path reads the memory store)

## 7. Panel and settings

- [ ] 7.1 `extension/sidepanel/conversation-model.js` + `sidepanel.js`: render the `memory_recalled` event as one disclosure line inside the run's `.tool-timeline-group` ("Đã tham khảo cách làm lần trước · <host> · <relative time>"), excluded from the operation count, no state icon, restored from the durable event on reconnect without duplication; existing tokens/disclosure primitives only (openspec/ui-dna.md)
- [ ] 7.2 `extension/sidepanel/tool-labels.js`: one label for `task_memory`
- [ ] 7.3 `extension/settings/settings.html` + `settings-client.js`: "Ghi nhớ cách làm việc" switch (default on) with a hint that "Không lưu nội dung câu hỏi" pauses new memories
- [ ] 7.4 Management surface (beside the approved-sites page): list per site (site, intent, step count, last confirmed, state), "Quên trang này", "Quên tất cả" with confirmation, empty state text; keyboard-operable and 320/400/480 light/dark
- [ ] 7.5 Panel tests: disclosure renders once and survives a reconnect replay; count unaffected; management surface list/forget/empty; settings toggle round-trips

## 8. Validation

- [ ] 8.1 `cd host && node --test test/task-memory-*.test.mjs`, the companion wiring suite, `node test/sidepanel-*.test.mjs` for the touched panel files, `node test/design-tokens-contrast.test.mjs`; `openspec validate add-task-memory --strict`
- [ ] 8.2 Live QA: run a site task twice in two conversations; confirm the second run's guidance names the first run's steps, the disclosure line appears, the operation count excludes it, every permission is still asked, and a deliberately changed page marks the memory stale on the next failure ← (verify: no action was taken that the same run without memory would not have been asked about)

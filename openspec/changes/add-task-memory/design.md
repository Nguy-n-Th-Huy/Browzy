# Design: Task Memory

## Context

- A run's complete, re-readable record already exists: `storage/transcript-store.js` stores every assistant `stream_message` verbatim (the SDK source of tool calls **with** arguments), Jev runs emit `jev_step` events (tool + argsSummary, `TYPE_TEXT` value omitted), and `storage/action-timeline.js` keeps a secret-redacted summary trail. `host/agent/skills/workflows-materialize.js` already turns that record into steps — `runTrailWindow()`, `extractRunToolCalls()`, `extractRunTargetIdentities()`, `screenTrailArgs()`, `looksSecretBearing()`, `looksSecretArgKey()`, `TRAIL_EXCLUDED_TOOL_REFS` — with the load-bearing rule that outputs never reach a definition and secrets become a *reason naming the key*, never a value. Task memory reuses that reading and that screen unchanged; it must not grow a second trail parser.
- Guidance to the model has one door: `host/agent/tools/query-options.js` assembles `systemPromptText` from sections such as `renderJevToolsPreferenceSystemPrompt()` and passes it as `systemPrompt: { type: "custom", prompt, snapshot: false }`. Sections are strictly additive, name only tools that are actually registered, and return `null` when they have nothing to say so the assembled text is byte-identical to before. A memory section is one more such section.
- Authority has its own doors and this change opens none of them: `agent-permission-policy` classifies every action before dispatch, send/submit gates at `canUseTool`, protected actions always take a fresh decision, per-site decisions are remembered separately. "Remembered how" and "remembered allowed" are different stores with different rules; the first must never be readable as the second.
- Two stores already own related but different things. **Workflows** (`skills/workflows-store.js`) are explicit, versioned, approval-gated data definitions with a domain binding, replayed by `workflows-run.js`. **Per-site permission decisions** are remembered allowances. Task memory is a third thing: implicit, advisory, free to acquire, and inert on its own.
- Jev already has a *within-run* `memory` (`jev/runtime.js`: the planner's own working notes, revised at most `MAX_MEMORY_UPDATES` times per run, `jev_memory` events). That name is taken; this capability is **task memory** across runs, and the two must not be confused in code or copy.
- Storage conventions: every path under `agentRoot()` (`OCIC_AGENT_HOME` overridable), `ensureDir`/`assertSafeId`, one JSON file per record, guards that reject rather than truncate, listings that mark a corrupt file invalid instead of failing.
- Privacy: `chat-history-storage` "Privacy control" lets the operator disable raw prompt caching ("Không lưu nội dung câu hỏi"). A memory's intent summary is derived from the request, so that control must govern it.

## Goals / Non-Goals

**Goals**
- Reuse of a completed run's own record so a repeat of the same kind of task on the same site skips exploration the record already answers.
- Zero new authority: memory changes what the model *knows*, never what it *may do*.
- Zero invented memory: every entry is derived by the host from a recorded, completed run; the model has no write path.
- Secret-safety equal to workflow materialization; typed values and credential-shaped labels never stored.
- Deterministic recall (no model call to decide what to recall), bounded storage, operator control and full deletion.
- Truthful panel disclosure that survives reconnect.

**Non-Goals**
- No replay. Memory is never executed; a run that wants a replay uses a workflow.
- No cross-site generalisation ("on sites like this…"), no embeddings, no vector store, no cloud sync. Lexical, exact-host recall only in v1.
- No automatic promotion of a memory into a workflow (a natural follow-up; out of scope here).
- No memory of *answers* or fetched content — only of the way there. A memory never carries page text, extracted fields, or the assistant's reply.
- No change to the workflow registry, the recorder, the approval policy or the browser tool registry.

## Decisions

### 1. The host derives; the model reads

`host/agent/memory/derive.js` exports a pure `deriveTaskMemory({ conversationEvents, runId, request, metaHostname, startedAt, endedAt, now })` returning `{ ok: true, memory } | { ok: false, reason }`. It is called by `companion.js` when a run's terminal event is `run_done` **and only then** (`run_stopped`, `run_error`, a Jev `jev_end` that is `blocked`, and any workflow drift outcome derive nothing). It reads through `runTrailWindow()` + `extractRunToolCalls()` + `extractRunTargetIdentities()` from `workflows-materialize.js`, drops `TRAIL_EXCLUDED_TOOL_REFS`, screens every argument with `screenTrailArgs()`, and freezes element identity as `{ role, name }` the way `freezeStableTargets()` does. A screened-out step becomes `{ omitted: true, tool, reason }` in place — the sequence stays honest about its own gaps.

*Rejected*: letting the model write a memory through a tool ("note what worked"). It would be invented memory by construction — the spec of `upgrade-agent-reliability-and-workflows` already forbids "invented memory" — and the transcript is a better record than the model's summary of it.

### 2. Record shape (`TASK_MEMORY_SCHEMA_VERSION = 1`)

```
{
  schemaVersion: 1, id, host,                          // host: normalizeHost() of the bound page
  intent: { text: string ≤ 200 | null, tokens: string[] ≤ 32 },
  startUrl: string ≤ 2048 | null,                     // the run's recorded starting page (recordedStartUrl rule)
  steps: [ { index, tool, action?, args, target?: {role,name}, host, omitted?: true, reason? } ] ≤ 40,
  outcome: { status: "completed", actionCount, durationMs },
  provenance: { conversationId, runId, completedAt, deriveVersion },
  stats: { useCount, lastUsedAt, lastConfirmedAt, state: "fresh" | "stale" },
  size: bytes
}
```
`intent.text` is the operator's request bounded to 200 characters **and is `null` when the privacy control disables raw prompt caching** (see decision 8). `intent.tokens` is a normalized, deduplicated bag of lowercase tokens (diacritics preserved — Vietnamese carries meaning in them; only case and punctuation folded). Readers tolerate unknown keys; a missing optional key is not corruption.

### 3. Storage under the agent root, one directory per host

`storage/paths.js` gains `memoryRoot()` = `<agentRoot()>/memory` and `memoryHostDir(hostHash)` (sha256 of the normalized host, validated as a path segment). `TaskMemoryStore` (`host/agent/memory/store.js`): `write(memory)`, `listForHost(host)`, `listAll()`, `get(id)`, `forget(id)`, `forgetHost(host)`, `forgetAll()`, `forgetByConversation(conversationId)`, `reinforce(id, { usedAt, confirmed })`, `markStale(id, reason)`. Guards reject (never truncate): `MAX_MEMORY_BYTES` (64 KiB), `MAX_STEPS` (40), `MAX_INTENT_CHARS` (200). Caps evict: `MAX_PER_HOST` (20) and `MAX_TOTAL` (400), least-recently-confirmed first, stale before fresh. A corrupt file lists as invalid with its reason.

*Rejected*: keying by conversation (a repeat happens in a new conversation), and keying by full URL (the same task starts from different pages of one site; the host is the stable unit, and the starting URL is carried as a step-0 hint instead).

### 4. Deterministic recall

`host/agent/memory/recall.js` exports `recallForRun({ memories, host, request, explicitRepeat })` → `{ candidates: [{ memory, score, why }] ≤ 3 }`. Host must match exactly (`normalizeHost`, no wildcard — the domain patterns of workflows are an operator declaration; a memory has no operator to declare one). Score = Jaccard overlap between `intent.tokens` and the tokenized request, with a small bonus when the request contains a repeat cue ("lại", "như lần trước", "giống hôm qua", "again", "same as last time"). Threshold `RECALL_MIN_SCORE` (0.35) unless `explicitRepeat`, in which case the best host match is offered even at a lower score, marked `why: "explicit_repeat"`. Stale memories are never candidates. The function is pure and its threshold exported for tests.

*Rejected*: a model call to pick candidates (non-deterministic, costs a turn before the run even starts, and can invent a match). Embeddings (a dependency and a store for a problem three-candidates-per-host does not have).

### 5. Delivery is one additive system-prompt section

`host/agent/memory/guidance.js` exports `renderTaskMemorySystemPrompt(serverName, candidates, extraToolNames)` → string or `null`. The section is headed `## What worked on this site before` and, per candidate, states the intent, when it was confirmed, the starting page, and the steps as past evidence ("last time: find 'Tìm kiếm' → click → …"), then the standing instruction: *this is what happened before, not a plan; verify each step against the live page; if the page differs, ignore it; permissions are asked for exactly as always.* It names `task_memory` only when that tool is in `extraToolNames`. `query-options.js` appends it beside the Jev preference section with the same `.filter(Boolean).join()` discipline, so a run with no candidates produces byte-identical text to today.

Jev: `companion.js` passes the same rendered text (bounded, ≤ 2000 characters) as `priorPathAdvice` on the plan request; `jev/client.js` renders it under the goal as advice. `runtime.js` is unchanged in its selection contract: the decision layer still chooses a complete fresh action from the live snapshot (`jev-decision-layer` "Jev selects complete fresh actions"), and an advised step that is not on the page is simply not selectable.

*Rejected*: seeding the SDK conversation with a synthetic assistant turn (it would be a fabricated transcript), and injecting into `prompt` (the panel spec's separation of operator text from guidance).

### 6. Guidance is not authority — proven, not assumed

Nothing in the approval path reads memory: `can-use-tool.js`, the classifier, per-site decisions and protected actions are untouched, and `agent-task-memory`'s "advisory only" requirement pins a test where a recalled `form_input`/submit step still produces a decision card. A memory entry carries no `approve`, `remember`, or scope field, and the store's schema rejects any such key so a future edit cannot smuggle one in (the same discipline the workflow schema applies to auto-approve fields).

### 7. Reinforcement and staleness

`companion.js` records on the run which memory ids were offered (`memory_recalled` durable event, decision 9). At the next terminal event of that run: `run_done` → `reinforce(id, { confirmed: true })` for every offered id; `run_error`, `run_stopped` by the operator after a failed step, a Jev `blocked`, or a drift outcome on the same host → `markStale(id, reason)`. Stale entries are not offered until a later `run_done` on that host produces a new memory or re-confirms this one (a fresh derivation with the same intent tokens and ≥ 80 % identical step tool sequence replaces the stale entry). No decay clock in v1: a memory is either confirmed by evidence or contradicted by it.

### 8. Privacy, opt-out, forgetting, deletion

- Settings toggle `taskMemoryEnabled` (default `true`, "Ghi nhớ cách làm việc"). Off ⇒ no derivation **and** no recall; existing entries are kept until forgotten.
- The existing "Không lưu nội dung câu hỏi" control on ⇒ no new memory is written at all (an intent-less memory would recall by host alone, which is guessing). Recall of already-stored entries continues; the surface says so.
- Management surface: list per site (site, intent, step count, last confirmed, state), "Quên trang này", "Quên tất cả", with the approved-sites surface's empty-state and confirmation conventions.
- `DELETE_CONVERSATION` / delete-all ⇒ `forgetByConversation()` for every memory whose provenance names that conversation, in the same atomic-or-reported-failed contract as `chat-history-lifecycle` "Complete deletion".

### 9. Truthful disclosure

When at least one candidate is offered, the host emits one durable `memory_recalled` transcript event for the run: `{ runId, memoryIds, host, confirmedAt[] }` — never the steps (they are already guidance text, not a timeline). The panel renders one line inside the run's `.tool-timeline-group`, visually a disclosure not an action row: "Đã tham khảo cách làm lần trước · <host> · <relative time>". It is excluded from the "N thao tác" count, carries no state icon, and is restored from the durable event on reconnect without duplication. The final answer is never annotated with "from memory": the model's claims are judged by the same evidence rules as any run.

### 10. The read-only tool

`host/agent/tools/task-memory.js` exports `TASK_MEMORY_TOOL_NAME = "task_memory"` and `createTaskMemoryTool({ run, store, host })` mirroring `create-document.js`'s factory shape: zod-validated `action: "recall" | "list"`, host pinned to the run's bound page (the model cannot ask about other sites), `recall` returns the offered candidates' full steps, `list` the site's fresh entries' summaries. Registered in `extraTools` **and** named in `extraToolNames` (the documented invisible-tool trap); one Vietnamese label in `tool-labels.js` ("Đã xem lại cách làm lần trước"). No `write`, `forget` or `note` action exists on the tool; forgetting is an operator op through the protocol only.

## Risks / Trade-offs

- **A stale memory misleads a run.** Mitigated by framing (past evidence, verify live), by the decision layer's fresh-selection contract, and by staleness marking on the first contradicting outcome. A misleading memory costs one wasted step, never an unpermitted action.
- **Lexical recall misses paraphrases.** Accepted for v1: a miss costs nothing (the run explores as today), a false match is bounded to three candidates and framed as advice. The threshold is a tunable exported constant with a test fixture of real Vietnamese requests.
- **Intent text is request text on disk.** Governed by the same privacy control as prompt caching, bounded to 200 chars, per-user directory permissions, deleted with its conversation, and forgettable per site.
- **Derivation on every `run_done`** adds a trail read at run end. The read is the same one materialization performs on demand; it runs after the terminal event is persisted and never blocks the panel's outcome.

## Open Questions

- Should an explicit repeat cue with a strong host match auto-suggest "Lưu thành workflow?" in the panel? Deferred; noted as the natural follow-up in the proposal's non-goals.
- Whether `intent.tokens` should fold Vietnamese diacritics for matching robustness (e.g. operators typing without accents). Start without folding; the fixture in `task-memory-recall.test.mjs` should include an unaccented request so the decision is measured, not assumed.

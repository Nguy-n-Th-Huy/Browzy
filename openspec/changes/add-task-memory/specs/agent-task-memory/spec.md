## Purpose

Remember, per site, how a completed task was actually done, so that a later request of the same kind on the same site can start from what worked instead of exploring from nothing — as advice the model reads, never as steps the host replays and never as permission to act.

## ADDED Requirements

### Requirement: A task memory is derived only from a completed run's recorded evidence

The host SHALL derive a task memory from a run only when that run's terminal transcript event is `run_done`, reading the run's own recorded trail (the transcript's assistant `tool_use` blocks and Jev `jev_step` events within the run's sequence window) through the same trail reading the workflow materialization uses. A run that ended in `run_stopped`, `run_error`, a Jev `blocked` outcome, or a workflow drift outcome SHALL derive nothing. The model SHALL have no write path to task memory: no tool, prompt or message can create, edit or delete a memory entry. Bookkeeping and diagnostic tools excluded from workflow derivation SHALL be excluded here too. The assistant's own text, tool results, fetched content and extracted fields SHALL never be part of a memory.

#### Scenario: Completed run derives a memory
- **WHEN** a run on `dauthau.asia` ends in `run_done` after listing tabs, reading the page, finding a filter, clicking it and reading results
- **THEN** one memory entry is written for host `dauthau.asia` whose steps name those dispatched actions in order and whose record contains none of the page text that was read

#### Scenario: Interrupted or failed run derives nothing
- **WHEN** a run ends in `run_stopped`, `run_error`, a Jev `blocked` outcome, or a drift outcome
- **THEN** no memory entry is written and no existing entry is modified except as the staleness rule below requires

#### Scenario: The model cannot write memory
- **WHEN** a model turn asks, in any form, to remember, note or save how a task was done
- **THEN** no memory entry is created or changed by that turn; only a later `run_done` derivation can write

### Requirement: Memory record shape and secret screening

A memory entry SHALL be one JSON record carrying at least: a schema version, an identifier, the normalized site host, an intent (a bounded text of at most 200 characters, or `null`, plus a normalized token bag), the run's recorded starting page when known, an ordered list of at most 40 steps (each with its index, tool, optional action, screened arguments, optional element identity as `role` and `name`, and the host it ran on), the outcome with action count and duration, provenance naming the conversation, run, completion time and derivation version, and usage statistics. Every argument SHALL pass the workflow materialization's secret screen: a credential-shaped argument key, an opaque high-entropy value, or a redacted value SHALL cause that step to be recorded as omitted with a reason naming the argument key and never its value. Typed text SHALL never be stored. A credential-shaped element label SHALL never be stored. The record SHALL reject any key that expresses authority (approval, remembering a decision, a permission scope). Readers SHALL tolerate unknown keys and SHALL NOT treat a missing optional key as corruption.

#### Scenario: Credential-shaped argument
- **WHEN** a recorded step's arguments include a key such as `password` or a value that looks like an opaque token
- **THEN** the stored step is marked omitted with a reason naming the key, and the value appears nowhere in the record

#### Scenario: Typed text is not remembered
- **WHEN** a recorded step typed text into a field
- **THEN** the stored step names the tool and the target's role and name, and carries no typed value

#### Scenario: Authority-shaped key is rejected
- **WHEN** a record is written with a key such as `approve`, `remember` or `scope`
- **THEN** the write is rejected with the offending key named and nothing is stored

### Requirement: Bounded per-user storage with rejecting guards

Memory entries SHALL be stored under the companion's own per-user agent root at `<agent root>/memory/<host-hash>/<id>.json`, where `<host-hash>` is a stable hash of the normalized host minted by the store and validated as a path segment. Guards SHALL reject, never truncate, an entry over 64 KiB, more than 40 steps, or an intent over 200 characters. The store SHALL keep at most 20 entries per host and 400 in total, evicting the least recently confirmed entries first and stale entries before fresh ones. A corrupt file SHALL list as invalid with its reason and SHALL NOT fail the listing; an absent memory directory SHALL list as empty.

#### Scenario: Per-host cap
- **WHEN** a 21st entry is written for one host
- **THEN** the least recently confirmed entry for that host (a stale one first, if any) is removed and the new entry is stored

#### Scenario: Oversize entry
- **WHEN** a derived entry exceeds 64 KiB or 40 steps
- **THEN** it is rejected with the bound named and nothing partial is written

### Requirement: Recall is deterministic and bound to the site

At run start the host SHALL select at most three candidate memories whose host exactly equals the bound page's normalized host and whose intent token overlap with the operator's request meets a fixed, exported threshold, ordered by score. A request carrying an explicit repeat cue (such as "làm lại", "như lần trước", "giống hôm qua", "again", "same as last time") MAY offer the best host match below the threshold, marked as an explicit repeat. Selection SHALL use no model call, no clock and no randomness, SHALL never match across hosts, and SHALL never offer a stale entry.

#### Scenario: Repeat on the same site
- **WHEN** a new conversation on the same host asks for a task whose wording overlaps a stored intent above the threshold
- **THEN** that memory is a candidate, and the same inputs always produce the same candidates in the same order

#### Scenario: Same words, different site
- **WHEN** the request matches a stored intent but the bound page's host differs
- **THEN** no candidate is offered

#### Scenario: Explicit repeat below threshold
- **WHEN** the request says "làm lại như lần trước" on a host with one fresh memory whose overlap is below the threshold
- **THEN** that memory is offered as the single candidate marked as an explicit repeat

### Requirement: Recalled memory is advisory guidance, never authority

Recalled candidates SHALL reach the model only as an additive system-prompt section that presents each step as what happened before, instructs the model to verify every step against the live page and to ignore the memory when the page differs, and states that permissions are requested exactly as always. The section SHALL never be inserted into the operator's prompt. When there are no candidates the assembled system prompt SHALL be byte-identical to a run without this capability. No approval, classification, per-site decision or protected-action path SHALL read task memory, and a recalled step SHALL confer no allowance: a recalled send/submit-class or protected action SHALL produce the same decision request it would produce without memory.

#### Scenario: Recalled submit still asks
- **WHEN** a recalled step is a form submission on a site with no remembered allowance
- **THEN** the run still gates that action at `canUseTool` and the panel shows the decision card

#### Scenario: No candidates leaves the prompt untouched
- **WHEN** recall yields no candidates
- **THEN** the run's system prompt text is identical to one produced with task memory absent

#### Scenario: Live page differs
- **WHEN** a recalled step names an element that does not exist on the live page
- **THEN** nothing is clicked on its account; the model proceeds from the live page as in a run without memory

### Requirement: Recall reaches the Jev planner as advice only

When a run delegates a step to the Jev decision layer, the same rendered advice, bounded in length, MAY be attached to the plan request as prior-path advice. The decision layer's contract SHALL be unchanged: it selects complete fresh actions from the live observation, an advised action absent from the observation is not selectable, and every existing bound and verification rule applies. Jev's own within-run planning memory is a separate concept and SHALL NOT be written to or read from task memory.

#### Scenario: Advice with a missing target
- **WHEN** the plan request carries advice naming a control that the live snapshot does not contain
- **THEN** the decision layer selects among the controls it observes and the advised control is never dispatched

### Requirement: Reinforcement, staleness and confirmation

The host SHALL record which memory ids were offered to a run. When that run ends in `run_done`, each offered entry SHALL be reinforced (use count incremented, last used and last confirmed times updated). When that run ends in `run_error`, is stopped by the operator after a failed step, ends Jev `blocked`, or ends in a drift outcome on the same host, each offered entry SHALL be marked stale with the reason. A stale entry SHALL not be offered again until a later `run_done` on that host confirms it: a new derivation with the same intent tokens and a step tool sequence at least 80 % identical SHALL replace the stale entry as fresh.

#### Scenario: Memory contradicted by a failure
- **WHEN** a run that received a memory fails on that site
- **THEN** the memory is marked stale, and the next request of the same kind receives no candidate from it

#### Scenario: Memory re-confirmed
- **WHEN** a later run on that host completes with the same intent and a nearly identical step sequence
- **THEN** the stale entry is replaced by the fresh derivation and becomes a candidate again

### Requirement: Operator control, privacy and deletion

Task memory SHALL be governed by a settings toggle, default on; when off, the host SHALL neither derive nor recall, and existing entries SHALL remain until forgotten. When the existing prompt-caching privacy control is on ("Không lưu nội dung câu hỏi"), the host SHALL write no new memory while continuing to recall stored entries, and the settings surface SHALL say so. The operator SHALL be able to list memories per site and forget one site or all sites. Deleting a conversation, or all conversations, SHALL forget every memory whose provenance names that conversation, within the same atomic-or-reported-failed contract as transcript deletion.

#### Scenario: Toggle off
- **WHEN** task memory is disabled in settings and a run completes
- **THEN** no entry is written and no guidance section is rendered for any run

#### Scenario: Privacy control pauses writing
- **WHEN** raw prompt caching is disabled and a run completes
- **THEN** no new entry is written, while a stored fresh entry for the host is still offered to a matching request

#### Scenario: Conversation deleted
- **WHEN** the operator confirms deletion of a conversation that produced two memories
- **THEN** both entries are removed together with the transcript, or the deletion is reported as failed

### Requirement: The recall tool is read-only and site-pinned

The runtime SHALL expose a `task_memory` tool to runs with exactly two actions: `recall`, returning the full steps of the candidates offered to this run, and `list`, returning summaries of the bound host's fresh entries. The tool SHALL be pinned to the run's bound host and SHALL refuse a request naming another host. It SHALL have no action that creates, edits, forgets or reinforces an entry. It SHALL be registered and visible to the model in the same way other host-side tools are, and it SHALL be classified read-only for tab-scope purposes.

#### Scenario: Mid-run recall
- **WHEN** the model calls `task_memory` with action `recall` during a run that received candidates
- **THEN** the offered candidates' steps are returned and nothing in the store changes

#### Scenario: Other host refused
- **WHEN** the model calls `task_memory` naming a host other than the run's bound page
- **THEN** the call fails with a named reason and returns no entries

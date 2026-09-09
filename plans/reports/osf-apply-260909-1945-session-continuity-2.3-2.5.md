# Tasks 2.3-2.5 — atomic SDK-reference ownership, resume compatibility, failure handling

Change: `upgrade-agent-reliability-and-workflows`, tasks.md group 2, **tasks
2.3, 2.4, 2.5 only**. `design.md` decisions 1 and 2. Built directly on
2.1/2.2's conversation-metadata schema
(`plans/reports/osf-apply-260909-1833-conversation-metadata-schema-and-snapshot-boundary.md`)
and the group-0 SDK gate
(`plans/reports/osf-apply-260909-1504-sdk-continuity-gate.md`).

## Status

DONE

## Summary

Implemented the actual SDK-level session continuity this change exists to
add: a conversation's second and later turns now pass `resume` to the SDK
when (and only when) the run's freshly resolved identity is compatible with
what the conversation already has bound, with atomic (CAS-style) ownership
of the captured `session_id`, explicit failure classification with no
automatic retry, and a deletion path that tombstones before it aborts and
never resurrects. 51/51 `host/test/*.test.mjs` pass; 60/62
`test/*.test.mjs` pass, with the 2 non-passing files both attributable to
the parallel session's in-flight work, not this change (detail below).

## Files changed

Modified:
- `host/agent/storage/conversation-metadata.js` — `SDK_SESSION_REF_STATUS` (ACTIVE/MISSING/RESUME_FAILED), `buildSdkSessionRef()`, `assessResumeCompatibility()`.
- `host/agent/session/manager.js` — `claimSdkSessionRef()` (CAS), `markSdkSessionRefStatus()`, `getResumeSessionId()`; `hasConversation()`/`getConversationMetadata()` now consult the deletion tombstone directly (real gap found and fixed — see below); `deleteConversation()` now tombstones *before* stopping the run and wraps the disk removal in try/catch; `finishRun()` now retries the disk removal for a tombstoned conversation (late-unwind sweep).
- `host/agent/companion.js` — `_handleStart()` validates and threads a new `newSdkSession` field; `_runAfterLeaseGranted()` runs the resume-compatibility gate before any SDK call and computes `resumeSessionId`; `_runQuery()` captures `session_id` from the `system`/`init` message, claims it, and classifies resume failures (`session_missing` / `session_resume_failed`) without reclassifying a deliberate stop.
- `host/agent/tools/query-options.js` — `buildIsolatedOptions()` accepts `resume`; always sets `persistSession: true` explicitly.
- `host/agent/protocol.js` — `validateStartSessionChoice()` for the new optional START field `newSdkSession`.
- `host/test/agent-conversation-metadata.test.mjs` — one assertion updated (not weakened) from "the second run also reached query()" to "a run whose resolved model disagrees ... is rejected before query()" — the old assertion tested exactly the behavior the previous wave's own report said was "out of this task's scope" pending 2.4; now that 2.4 exists, the outdated expectation was corrected in place, keeping the never-overwrite guarantee it actually protects.
- `openspec/changes/upgrade-agent-reliability-and-workflows/tasks.md` — checked off 2.3, 2.4, 2.5 only.

New:
- `host/test/agent-session-continuity.test.mjs` — 47 assertions across CAS ownership, compatibility assessment, end-to-end resume/reject/recover via CompanionCore, missing/failed-resume classification with no auto-retry, partial-turn/abort handling, restart survival, and deletion-tombstone ordering with the late-unwind sweep.

## Ownership/compatibility model

**SDK-reference ownership (`conversationMetadata.sdkSessionRef`)**: `{ sessionId, status, capturedAt, updatedAt }`, `status` one of `active` / `missing` / `resume_failed`. Atomicity is single-writer, not filesystem locking: `SessionManager.startRun()` already guarantees at most one `Run` per conversation, so at most one caller can ever reach `claimSdkSessionRef()` for a given conversation concurrently — the CAS check on top of that is:
- No existing ref, or same `sessionId` → claim succeeds (normal first-capture and per-turn resume-confirmation path).
- Existing ref is **not ACTIVE** (`missing`/`resume_failed`) → a *different* `sessionId` may still be claimed — that old id was already known-unresumable, so a fresh one replacing it is expected, not a surprise.
- Existing ref is **ACTIVE** and the id differs → rejected, ref left untouched, never silently overwritten.

`markSdkSessionRefStatus()` never clears `sessionId` — only `status`/`updatedAt` change. `getResumeSessionId()` only ever offers an id whose status is `active`, so a `missing`/`resume_failed` ref is never retried automatically.

**Compatibility (`assessResumeCompatibility`)**: pure function comparing bound vs. current `{endpoint, modelId, cwd, pluginDir, allowedSkillNames, skillOverrides}`. `bound.appProfile === null` (nothing bound yet — first run, or a genuinely legacy pre-2.1 record) is always compatible. Deliberately **excluded**: `profileId` (two ids can share one real endpoint+model), `credentialRevision` (a rotated key on the same endpoint+model is exactly the "current credential" case 2.4 names separately — resolved earlier by `resolveProfileSnapshot`/`ProfileUnavailableError`, never by this check; comparing it would force incompatibility on ordinary key rotation and contradicts "no historical-secret reconstruction"), `permissionPolicy` (fully derived from the other fields — never an independent signal), `settingSources` (a fixed constant). In today's architecture `sessionSchemaIdentity`/`cwd`/`pluginDir`/skills are bound once and physically cannot drift once `appProfile` is bound at all (proven: whenever `appProfile` is null, `sessionSchemaIdentity` is also null, so there is nothing to compare mid-flight) — the comparison exists for spec completeness and as a forward-compatible guard, but **endpoint+modelId is the only field that is reachable in practice today**, because it is the only one a later Send can genuinely resend differently.

## Exactly which incompatibilities force a new conversation vs. are repairable

- **Repairable (not incompatible at all)**: the pre-existing `pluginDir`/`configDir` backfill in `_bindSkillsForRun()` (found by the 2.1/2.2 wave's own census: 45 plugin-era conversations missing `configDir`, 624 pre-plugin conversations missing `pluginDir` entirely). These conversations have **no `appProfile` bound yet** (they predate this schema), so `assessResumeCompatibility` reports them compatible unconditionally — the backfill runs, the first-ever bind captures the *repaired* identity, and no rejection ever fires. This is the "legacy conversation" case from 2.5 — resolved by binding fresh on first touch, not by any new gate.
- **Genuinely incompatible (requires an explicit choice)**: a later turn on an **already-bound** conversation resolves to a different `endpoint` or `modelId` than the one recorded at first bind (the operator picked a different profile/model in the composer). This is rejected *before* any SDK call, with a structured `run_error` (`reason: "conversation_identity_incompatible"`, `mismatches: [{field, bound, current}]`). The bound identity is **never** silently overwritten to the new one — recovery is per-turn via the new `newSdkSession: true` START field (skips resume, runs a fresh SDK session, still doesn't rebind), a **permanent** switch requires a new conversation. This matches decision 2.4's own wording, which names both "recovery" and "new-conversation" as the two UI options — I built the host-side mechanics for both; the actual button/UI is out of scope (owned by the panel, a parallel session's file).

## How deletion prevents late resurrection

Three changes, in order of when they matter:
1. **Tombstone-first ordering**: `deleteConversation()` now adds the conversationId to the in-memory `_deletedConversations` set as its very first statement — before `stopRun()` aborts the SDK call, before the disk `rmSync`. Every write path in `SessionManager` already checked this set; `_runQuery`'s new `claimSdkSessionRef`/`markSdkSessionRefStatus` calls inherit that guard automatically (both call `getConversationMetadata`, which now also short-circuits on the tombstone — see next point).
2. **Read paths now also honor the tombstone** (a real gap this task found, not just extended): `hasConversation()` and `getConversationMetadata()` previously consulted only `store.loadMeta()` — if the on-disk `rmSync` failed (e.g. a still-open file handle from an aborting CLI subprocess, a real possibility on Windows per gate-0.2's own G5 finding of ~7s abort→settle latency), a reader in that window would see the conversation as still present. Both methods now check the tombstone set first and return `false`/`null` immediately regardless of disk state. Proven directly: a test that makes the store's delete throw once shows `hasConversation()` is `false` **immediately**, while the directory is still physically on disk.
3. **Late-unwind sweep**: `finishRun()`, when called for a tombstoned conversation, retries `store.deleteConversation()` (best-effort, swallowed) — closing the window between a failed first removal and the aborting run's handles actually releasing.

`sdkSessionRef` (the SDK mapping) lives inside the same `conversationMetadata` the directory removal deletes — no separate step needed. The usage ledger (group 5) doesn't exist yet — nothing to remove. "Recording claims": `PendingRecordingsStore` is companion-wide and only ever holds a recording *before* any conversation claims it; once claimed it becomes a `recording_complete` transcript event inside the deleted directory — there is no conversation-scoped claim state anywhere else. Documented explicitly in `deleteConversation()`'s own doc comment rather than left implicit.

## 2.5's failure paths

- **Stop**: `Run.stop()` already aborts synchronously and releases the lease in `finally`-equivalent code (`_releaseFromLease()`, unchanged). `_runQuery`'s new catch block checks `run.state !== RUN_STATES.STOPPED` before classifying anything — a deliberate stop is never reclassified as `session_missing`/`session_resume_failed`, and the ref stays `ACTIVE` (proven by test).
- **Restart**: `sdkSessionRef` is durable on-disk metadata (not in-memory), so a companion restart (new `SessionManager`/`CompanionCore`, same store) still offers it via `getResumeSessionId()` — proven by constructing two independent `SessionManager` instances over the same scratch home.
- **Cancellation**: identical to stop (same code path — `Run.stop()` is the one cancellation mechanism).
- **Partial turns**: an `init` message (session_id) arriving before a mid-stream throw is still captured and claimed (`ACTIVE`) — proven with a scripted SDK that yields `init` then throws. The *next* turn successfully resumes using that preserved ref. A partial turn with **no** resume attempted is classified as a plain `run_error`, never mislabeled as a resume failure (the classifier only fires when `resumeAttempted` is true).
- **Concurrent starts**: unchanged, already enforced by `startRun()`'s existing `hasActiveRun` check (pre-existing, re-verified green in `agent-companion-core.test.mjs`'s "a second start ... is rejected" test — not modified this wave).
- **Missing sessions**: a resume attempt whose thrown error matches gate-0.2's G2 shape (`"No conversation found"` / names the session id) is classified `session_missing`; any other failure during an attempted resume is `session_resume_failed`. Both mark the ref's `status` (never clearing `sessionId`) and emit a structured `run_error`. The very next turn does **not** retry resume automatically (`getResumeSessionId()` returns `null` for a non-ACTIVE ref) — it runs a fresh SDK session, and the fresh id it captures is claimable (the old ref was already stale, not ACTIVE).
- **Legacy conversations**: no `sdkSessionRef` exists → no resume ever attempted → identical to every conversation's own first turn. No special-casing needed or added; proven via `assessResumeCompatibility`'s "nothing bound yet" case plus the existing 2.1/2.2 migration tests.
- **Unknown in-flight effects**: `Run.recordResultUnknown()`/`unknownResults()` (pre-existing, untouched) already cover a tool dispatch whose result never arrived; nothing in this wave changes or needs to change that mechanism — session continuity and tool-result uncertainty are orthogonal concerns.
- **No memory synthesis (the task's own verify clause)**: proven directly, not just by construction — a test captures the exact `prompt` argument `sdk.query()` receives on a resumed second turn and asserts it equals only that turn's own text and never contains the first turn's text. This holds on every path (resumed, rejected, recovered-fresh, missing-then-retried): `_runQuery`'s `prompt` parameter is always this turn's own `queryPrompt`/attachments — there is no code path that reads the transcript log back into a request.

## Real test output

```
$ node host/test/agent-session-continuity.test.mjs
...
ALL SESSION CONTINUITY TESTS PASSED   (47/47)

$ node host/test/agent-conversation-metadata.test.mjs
ALL CONVERSATION METADATA TESTS PASSED

$ node host/test/agent-companion-core.test.mjs
20/20 passed
```

Full suites (real output, this session):

```
host/test/*.test.mjs — 51 files (50 + 1 new)
  First pass with a 20s per-file cap: 4 apparent timeouts
    (external-mcp-companion-resilience, external-mcp-launch-contracts,
     settings-all, settings-capability-test)
  Each re-run individually with a 90s cap: all 4 PASS in full
    (they spawn real subprocesses / hit the real Windows Credential
    Manager and legitimately take 5-40s — a harness artifact, not a
    regression; none touch anything in this task's scope)
  Net: 51/51 pass
TOTAL=51 FAILED=0 (after confirming the 4 timeout artifacts)

test/*.test.mjs — 62 files
TOTAL=62 FAILED=2
  FAIL(1)   test/side-panel-group-scope.test.mjs   — the known, named,
            not-mine failure (parallel session's side-panel-follows-
            active-tab work).
  FAIL(124) test/navigate-url-scheme.test.mjs       — NOT previously named
            as a known failure. Investigated: this file only imports
            node:fs and ./_extract.mjs, and extracts/evals the
            hasUrlScheme/navigate functions' SOURCE TEXT directly out of
            extension/background.js (test/_extract.mjs's BACKGROUND
            constant) — it has zero dependency on anything in this
            task's scope (host/agent/**, protocol.js). It hangs
            deterministically (reproduced twice, both times stalling at
            the identical assertion, "bare host/path still gets https://
            prepended") — never finishes even at a 90s cap. Because it
            only ever touches extracted text from extension/background.js,
            which git status shows modified and which the task's own
            constraints name as the parallel session's owned, in-flight
            file, this is attributable to their work-in-progress, not
            this change. Per the "hands off, report don't fix" scope
            rule, I did not touch extension/background.js or this test
            file. Net: 60/62 pass, both non-passing files are outside
            this task's ownership.
```

## Tasks checked off, with evidence

- **2.3** — `claimSdkSessionRef`/`markSdkSessionRefStatus`/`getResumeSessionId` (session/manager.js), tombstone-first `deleteConversation()` + `hasConversation()`/`getConversationMetadata()` tombstone guards + `finishRun()` late-unwind sweep. Evidence: `agent-session-continuity.test.mjs`'s "2.3" and "2.3/2.5" sections (CAS claim/conflict/stale-replace, tombstone-immediate-on-read, late-unwind-sweep-retries, active-run deletion race), `agent-companion-core.test.mjs`'s pre-existing DELETE_CONVERSATION suite (still green).
- **2.4** — `assessResumeCompatibility` (conversation-metadata.js), the compatibility gate + `newSdkSession` in `_runAfterLeaseGranted`/`_handleStart` (companion.js), `validateStartSessionChoice` (protocol.js). Evidence: `agent-session-continuity.test.mjs`'s "2.4" pure-function section and the end-to-end "capture, resume, reject, no-memory-synthesis" section (incompatible-model rejection with structured mismatches, `newSdkSession` bypass, malformed-field rejection); `agent-conversation-metadata.test.mjs`'s corrected assertion.
- **2.5** — `_runQuery`'s classified catch block (companion.js), `SDK_SESSION_REF_STATUS` (conversation-metadata.js). Evidence: `agent-session-continuity.test.mjs`'s "2.5" section (missing-session classification + no auto-retry + recovery, partial-turn preserves ref, deliberate-stop never reclassified) and the restart-survival test.

## Concerns for the controller

None for 2.3-2.5 itself. One item to hand back: `test/navigate-url-scheme.test.mjs` hangs deterministically right now, tied to `extension/background.js` (the parallel session's owned, in-flight file) — not something I touched or can safely fix without editing a file outside my scope. Flagging it explicitly since it was not one of the two failures named in my instructions, in case the controller wants to alert that session.

# Implementation evidence — optimize-chat-history

## Wave A (tasks 1.1–3.3): authoritative lifecycle, storage/retention, transcript performance

Date: 2026-09-13. Repo: `D:/Dev/www/Browzy`. All commands run from the repo root.
Exit code 0 = suite passed (`node <file>`); every tail below is verbatim.

### Files changed

Host:

| File | What changed |
| --- | --- |
| `host/agent/storage/transcript-store.js` | Presentation metadata (`updatePresentation` + `revision`/`ifRevision`), summary fields, deferred `lastSeq` meta writes (`_markMetaDirty`/`flushMeta`/`flushAllMeta`, log-derived allocator recovery `_lastSeqFromLog`, `_writeMeta` never lowers the cursor), `transcriptWindow()` sequence-range pages, `snapshot()` now reports `firstSeq`/`hasOlder`, `deleteConversation()` returns `{removed}`, `deleteAllConversations()` collects per-conversation failures, `listConversations(limit)`/`conversationCount()`, `PRESENTATION_LIMITS`. |
| `host/agent/session/manager.js` | `conversationSummaries({limit})` → `{conversations,total,hasMore}` with title/hostname/pinned/archived/revision/updatedAt, `updateConversationPresentation`, `wasDeleted`, `transcriptWindow`, `deleteConversation()` → `{hadActiveRun,onDiskRemoved}`, `deleteAllConversations()`. |
| `host/agent/protocol.js` | Message types `UPDATE_CONVERSATION`, `DELETE_ALL_CONVERSATIONS`, `TRANSCRIPT_WINDOW_REQUEST`/`TRANSCRIPT_WINDOW`; `validateConversationUpdate`, `validateIdempotencyKey` + bounds. |
| `host/agent/companion.js` | `_handleUpdateConversation`, `_handleDeleteAllConversations`, `_handleTranscriptWindowRequest`; rewritten `_handleDeleteConversation` (idempotency replay, `alreadyDeleted`, `onDiskRemoved`, never reports success for an unknown conversation); `_handleListConversations` carries the new summary fields + `requestId`; `_deleteReplies` success-only memo; history error replies echo `requestId`. |

Panel:

| File | What changed |
| --- | --- |
| `extension/sidepanel/history-store.js` | Rewritten: schema v2 per-conversation keys (`ocic_conversation_history_v2:<id>`) with in-memory cache + dirty set + 700 ms debounce (`_scheduleFlush`/`flushNow`/`_writeDirty`), v1→v2 migration (prompts/createdAt/deletedLocally preserved, legacy key dropped), `reconcile()` (host fields win, orphans marked `stale` or removed by policy), retention (`maxConversations`/`maxBytes`/`maxPromptPreviewChars`/`maxTitleChars`/`ttlDays`/`archiveOnEvict` + `evictionReport()`), privacy toggle (`setRawPromptCachingEnabled`), `clearAll()`, `onChange` + `chrome.storage.onChanged` adoption (pending local writes win), `forgetLastActive`/`pruneLastActive`. |
| `extension/sidepanel/protocol-client.js` | `MSG` constants + `listConversations`, `updateConversation`, `deleteConversation`, `deleteAllConversations`, `requestTranscriptWindow`. |
| `extension/sidepanel/panel-controller.js` | Request/reply correlation (`_sendRequest`/`_resolveRequest`/`_settleAllRequests`, errors resolve as answers), `reconcileHistory`, `loadOlderEvents`, host-first `deleteConversation`/`deleteAllConversations`, coalesced presentation-metadata push (`_queueHostMetadata`/`_flushHostMetadata`), `flushHistory`, run-terminal flush, migration-plan capability gate (`hostHistorySupported`/`_probeHostHistory`, fallback when a host answers `unknown_message_type`), removed `deleteConversationLocally`, `requestTimeoutMs`. |
| `extension/sidepanel/conversation-model.js` | Bounded event window (`maxWindowEvents`, `_windowEvents`), seq watermarks (`_highSeq`/`_lowSeq`) for duplicate suppression, `applyOlderPage` (lazy older pages), `hasOlderEvents`/`oldestLoadedSeq`/`highestSeq`/`windowSize`, batched eviction with rebuild, live-state preservation across rebuilds (`_captureLiveState`/`_restoreLiveState`), `_applyEventToItems` split. |
| `extension/sidepanel/sidepanel.js` | History view reconciles against the host before rendering, stale/pin/archive markers, host-first delete with an explicit failure alert, clear-all button handler, `pagehide` flush, `chrome.tabs.onRemoved` + boot-time prune of stale last-active keys, `deleteFailureText`. |
| `extension/sidepanel/sidepanel.html` | One additive header button (`btn-history-clear-all`) for delete-all. |

Tests:

| File | What |
| --- | --- |
| `host/test/chat-history-host.test.mjs` | NEW — 51 assertions: summaries/revision/conflict/validation, batched meta writes + crash/restart sequence preservation, sequence-window pagination, delete idempotency/unknown-conversation failure, delete-all full/partial/empty, wire gating for the new types. |
| `test/sidepanel-history-store.test.mjs` | Rewritten/extended — 81 assertions: coalescing measured via write counters (only dirty keys, no whole-index rewrite), lifecycle flushes, migration, retention (count/bytes/TTL/archive/remove), preview caps, privacy toggle, reconcile/orphans, quota-write-failure retry, restart, cross-panel `onChanged`, last-active forgotten/pruned. |
| `test/sidepanel-conversation-model.test.mjs` | +3 blocks: bounded window with eviction, lazy older-page merge (order, idempotence, cap), 5000-event benchmark, reconnect/replay overlap with no duplicates. |
| `test/sidepanel-chat-history-lifecycle.test.mjs` | NEW — 45 assertions: panel↔real-companion reconcile/orphan behaviour, delete confirmed / unknown-conversation / dead-host / partial delete-all (local cache never cleared on failure), idempotent retry, real older-page round trip, coalesced streaming writes, older-companion fallback gate. |
| `test/sidepanel-fake-companion.test.mjs` | Updated: `memStorage` supports `get(null)`/array/`remove`; the local-delete block now goes through the host-first `deleteConversation()`. |
| `test/enhance-prompt-companion.test.mjs` | Updated one assertion for the new `conversationSummaries()` return shape. |

### Notable decisions

1. **Duplicate-seq regression found and fixed (3.1).** Batching `meta.json` initially let an `updateMeta()` write re-persist a stale on-disk `lastSeq` and poison the in-memory allocator, so a later append reused a sequence number (`4:stream_message, 4:run_interrupted_by_restart`). Root cause fixed: `updateMeta()` reconciles the cursor from the event log via `_lastSeqOf()` before writing, and `_writeMeta()` can never lower the allocator. Proven by tests in `chat-history-host.test.mjs` ("the restarted store allocated seq 3 from the LOG") and by the previously-red `sidepanel-fake-companion` interrupted case.
2. **Retention cannot re-evict.** Already-evicted rows are ineligible (a count-overflow pass used to keep "evicting" the same archived row, recursing `flushNow↔_enforceRetention` until OOM). `_enforceRetention` is now re-entrancy guarded and persists through `_writeDirty()`.
3. **Eviction preserves live state.** A rebuild triggered by eviction/an older page carries the current turn lifecycle/completion/error, pending approval/question/download decision, tab-risk map, connection error and pending-user binding — otherwise evicting `run_started` would demote a streaming run to idle and a pending approval card would vanish.
4. **Snapshot `hasOlder` is OR-ed**, never overwritten: both the host page and local eviction can mean "there is more below".
5. **Migration-plan feature gate.** The new host-authoritative/windowed behaviour is enabled only once a host proves it answers the added protocol messages (`list_conversations` probe; a handshake-change retry, and probes that learn nothing are not memoized). A host that answers `unknown_message_type` gets pre-change behaviour: local cache as the list, the whole host-bounded snapshot (no window), and an explicit `host_protocol_unsupported` delete failure — never a local-only "success". The legacy local-only delete path is deleted (protocol tests pass).
6. **Last-active cleanup lives in the panel, not `background.js`** (which another session has in flight and is outside this change's file list): `sidepanel.js` registers `chrome.tabs.onRemoved` (drops that tab's key) and prunes every stale scope at boot. A key written while a panel was open is therefore removed either the moment its tab closes, or at the next panel boot if no panel was open at that time. `pruneLastActive([])` is a deliberate no-op so an unenumerable tab list can never wipe every scope.
7. **Panel-side `home` for prompt echoes.** `reconcile()` keeps the local-only prompt echo (the host never persists prompt text) while host fields (title/hostname/pin/archive/revision/timestamps) overwrite local guesses.

### Exact test output tails

```
### node host/test/chat-history-host.test.mjs            (51 PASS)
  PASS and reports that older events remain
  PASS an unknown conversation fails honestly rather than returning an empty page

ALL CHAT-HISTORY HOST TESTS PASSED
exit=0

### node test/sidepanel-history-store.test.mjs           (81 PASS)
  PASS no chrome.storage.session present still resolves to null rather than throwing
  PASS the in-memory fallback still round-trips within the life of this store instance

ALL SIDEPANEL HISTORY-STORE TESTS PASSED
exit=0

### node test/sidepanel-conversation-model.test.mjs      (102 PASS)
  PASS an overlapping live event at seq <= the watermark is dropped
  PASS a newer event is applied exactly once

ALL SIDEPANEL CONVERSATION-MODEL TESTS PASSED
exit=0

### node test/sidepanel-chat-history-lifecycle.test.mjs  (45 PASS)
  PASS models created while the host is unsupported render the whole transcript, not a window
  PASS every event stays in the model (no hidden history)

ALL SIDEPANEL CHAT-HISTORY LIFECYCLE TESTS PASSED
exit=0

### node test/sidepanel-fake-companion.test.mjs          (77 PASS)
  PASS an unscoped panel starts a brand-new conversation instead
  PASS the known scope's remembered id is exactly what it was before the unscoped panel ever ran

ALL SIDEPANEL FAKE-COMPANION TESTS PASSED
exit=0
```

Regression runs of every suite this change touches or that imports a changed module:

```
host/test/*.test.mjs (all 78 files)                        exit=0 for every file
test/sidepanel-readiness-states.test.mjs                   exit=0 fails=0
test/permission-mode-panel-wiring.test.mjs                 exit=0 fails=0
test/sidepanel-slash-picker-dispatch.test.mjs              exit=0 fails=0
test/sidepanel-context-binding.test.mjs                    exit=0 fails=0
test/companion-missing-notice.test.mjs                     exit=0 fails=0
test/sidepanel-protocol-client.test.mjs                    exit=0 fails=0
test/sidepanel-documents.test.mjs                          exit=0 fails=0
test/composer-enhance-prompt.test.mjs                      exit=0 fails=0
test/composer-add-and-effort.test.mjs                      exit=0 fails=0
test/sidepanel-design-mode.test.mjs                        exit=0 fails=0
test/navigate-url-scheme.test.mjs                          exit=0 fails=0
test/approval-gate.test.mjs                                exit=0 fails=0
test/extension-scripts-parse.test.mjs                      exit=0 (8/8)
```

Verify annotations:

- **1.3 failure never reports success** — `host/test/chat-history-host.test.mjs` ("deleting a conversation the host never had FAILS", "a partial sweep reports deleted:false, never success") and `test/sidepanel-chat-history-lifecycle.test.mjs` (unknown-conversation and dead-host both leave the local row in place and return `ok:false`).
- **2.3 quota/race/restart** — `test/sidepanel-history-store.test.mjs` ("quota / write failure: the change is kept and retried", "cross-panel convergence", "restart: a new store over the same storage sees the flushed cache").
- **3.3 large transcript benchmark and no duplicate events** — `test/sidepanel-conversation-model.test.mjs` ("large transcript benchmark: 5000 events stay bounded and duplicate-free" — 464 retained of 5000, 2 items, 7 ms; "reconnect replay overlap … never duplicates").

### Unresolved / surfaced (not worked around)

1. `test/overlay-background-bridge.test.mjs` fails with `ReferenceError: requestAnnotationClear is not defined` inside `teardownOverlayForRun` as extracted from `extension/background.js`. `extension/background.js` carries another session's in-flight edits (132 insertions) and this change never touches it; the helper exists in `background.js` (line ~3401) but not in the test's extract list. Not fixed here (out of scope, foreign file) — needs the owner of that edit or task 5.3's sweep.
2. Wave B follow-ups owned by tasks 4.x: search/filter UI, DOM virtualization, richer loading/empty/offline/error states, rename/export/pin/archive *controls* (pin/archive/rename/export metadata already flow through the host API, but the history view only surfaces pin/archive as badges and delete/clear-all as controls). `loadOlderEvents()` is wired end-to-end but has no scroll trigger yet; the model's window cap (default 1000 events, host page 500) is what bounds rendering until then.
3. Transcript-window loading is bounded by `maxWindowEvents`: at capacity an older page is refused with `limitReached: true` rather than silently dropping anything. A follow-up may want a configurable cap or a detached scrollback buffer in wave B.

---

## Wave B (tasks 4.1–5.3): history UI, validation, docs, performance

Date: 2026-09-13. Repo: `D:/Dev/www/Browzy`. All commands run from the repo root.
Exit code 0 = suite passed (`node <file>`); every tail below is verbatim.

### Files changed

| File | What changed |
| --- | --- |
| `extension/sidepanel/history-view.js` | NEW. The history screen's policy as an importable module: `normalizeFilters`/`matchesFilters`/`filterConversations` (local metadata search over title, prompt preview, hostname and conversation id — diacritic- and case-insensitive; date range and domain filters), `groupConversations` (pinned, then local-day buckets), `deriveHistoryState` (loading / empty / offline / error / no-match / ready, as data), `historyErrorText` (one message per reason, shared with the delete/rename/export alerts), `rowSignature`/`entryBadges`/`domainOptions`/`formatRowSubtitle`, `debounce` with `cancel()`/`flush()`, and `HistoryListView` — a keyed incremental DOM patcher with pagination (`loadMore`/`onScroll`), scroll preservation, per-row open/pin/archive/rename/export/delete controls, stale-row disabling, busy-export state, and arrow/Home/End/Enter keyboard navigation. No `innerHTML` parsing, no `querySelector`, no `chrome.*`. |
| `extension/sidepanel/history-export.js` | NEW. `buildConversationArtifact` (Markdown + JSON), `transcriptMessages` (unbounded rebuild through the same `ConversationModel` the panel renders, so an export and the screen never disagree), `artifactMessages`, `runTimestamps`, `exportFilename`/`slugify`, `normalizeExportFormat`. Pure, read-only, deterministic. |
| `extension/sidepanel/panel-controller.js` | `updateConversationPresentation()` (rename/pin/archive with an `ifRevision` guard, host-confirmed write adopted into the cache); `collectTranscript()` (walks the host's transcript pages newest-first) and `exportConversation()` (format validation + artifact build); `_hostTitles`/`_createdConversations` + `_deriveHostMetadataPatch()`/`_persistHistoryEntry()` fixes so a rename is never reverted by the derived default (see decisions 1–2); `hostHistorySupport()` tri-state accessor. |
| `extension/sidepanel/sidepanel.js` | History section rewritten to drive `HistoryListView`: toolbar wiring (debounced search, date range, domain select, clear filters, filter summary via the view's `onRender` hook), host-state description (offline vs outdated-companion vs no answer), rename/pin/archive/export handlers, `downloadTextArtifact` (blob URL + `<a download>`), transient export status, clear-all busy label, `deleteFailureText` replaced by the shared `historyErrorText`. Also wired the transcript's older-history affordance (see decision 5): `shouldLoadOlderTranscript()` + `loadOlderTranscript()` + a "Tải lịch sử cũ hơn" control, with scroll-height compensation. |
| `extension/sidepanel/history-view.js` (same file, second half) | `setBusy()` for the in-flight export row. |
| `extension/sidepanel/sidepanel.html` | History toolbar: search field, `Từ ngày`/`Đến ngày` date inputs, `Trang` domain select, `Xóa bộ lọc`, filter summary and status lines — all wired via `addEventListener` (CSP: no inline handlers). |
| `extension/sidepanel/sidepanel.css` | Toolbar/filter layout, history row re-layout (title + badges + subtitle + wrapped action row), group headings, "Xem thêm" and state line, `.older-transcript`. Tokens only. |
| `README.md` | "Side panel status": conversation history now described as search/filters/grouping/reopen/rename/pin/archive/export plus host-transcript deletion; the screenshot-verification claim is scoped to the screens that have screenshots, pointing at this report for the later surface. No protocol-gap claim existed to remove (see 5.2 below). |
| `test/_fake-dom.mjs` | NEW test helper: the minimal DOM the view is written against (`createElement`, children/insertBefore/remove, real `textContent` semantics, attributes/dataset, listeners + dispatch, `focus()`, scroll metrics). |
| `test/sidepanel-history-view.test.mjs` | NEW — 135 assertions: search/filter/group/state policy, incremental patch identity, paging + scroll preservation, keyboard reopen, stale/pin/archive/rename/export controls, export artifacts (both formats, order- and duplicate-independence, determinism), the extracted older-transcript predicate, and a module-parse guard for every sidepanel file this wave edits. |
| `test/sidepanel-chat-history-multipanel.test.mjs` | NEW — 60 assertions: two panels over one storage + one real companion (rename/pin/archive convergence with row-node identity, revision-conflict refusal, rename durability across later turns, resume-does-not-overwrite, export end-to-end and multi-page, old-companion refusal, cross-panel privacy policy, concurrent deletes, older-page loading with an honest `limitReached`). |
| `test/sidepanel-chat-history-perf.test.mjs` | NEW — 52 assertions: the scripted 1/100/1000-conversation measurements (latency, storage writes, memory) with stated budgets. |
| `openspec/changes/optimize-chat-history/tasks.md` | 4.1–5.3 checked off. |

Untouched on purpose: `extension/sidepanel/history-store.js` (wave A's rewrite is complete and its header carries no protocol-gap claim — 5.2's history-store half was already done there), `extension/ui/**` (shared; no new icons added — rename uses a labelled button, archive reuses `folder`, export reuses `download`), `extension/background.js` (another session's in-flight edits).

### Notable decisions

1. **`ifRevision` was never reaching the host (found by the new revision-conflict test).** `protocol-client.js`'s `updateConversation()` flattens its patch into the wire envelope (`{conversationId, ...patch, requestId}`), so the first implementation's `{conversationId, patch, ifRevision}` sent no guard at all and a stale second-panel edit silently overwrote the first. Fixed by putting `ifRevision` inside the patch object; the multi-panel test now proves the refusal (`revision_conflict`), that the host keeps the newer title, and that the refused panel can retry after re-reading.
2. **A rename could be reverted by the panel's own derived title.** `_deriveHostMetadataPatch()` used to push "first user message" as the title whenever it differed from what this panel last sent, and `_persistHistoryEntry()` wrote the same value into the local cache — so a later stream tick would undo the operator's rename (task 4.3). Root-cause fix: a derived title is a DEFAULT, pushed only for a conversation THIS panel created (`_createdConversations`), only while the host has no title (`_hostTitles`, learned from `list_conversations` replies and accepted `update_conversation` replies), and never from a placeholder prompt (`isPlaceholder`). Both halves are covered by tests ("a rename is never reverted…", "a panel that only RESUMES…").
3. **Exports were not reproducible.** The artifact took each message's `ts` from the rebuilt model, and the model stamps a user item with `Date.now()`; two exports of an unchanged conversation differed by a millisecond, and a "newest-page-first" event list produced different bytes than an oldest-first one. Fixed by deriving per-run times from the stored events (`runTimestamps()`) and exporting `null` for a user message's time — the host does not store prompt text or when it arrived, so inventing the panel's clock would be a fabricated fact in a document that claims to be the transcript.
4. **`hostHistorySupported()` conflates "unknown" with "refused".** The accessor is a strict boolean, so the new view state could not tell "the companion is too old" (an error the operator can act on) from "the probe has not answered yet". Added `hostHistorySupport()` (tri-state) and a `describeHistoryHostState()` helper; the tests wait on the tri-state, which is what makes the old-companion case deterministic rather than a 1s-timeout race.
5. **The transcript's older-history window had no UI trigger** (wave A's own follow-up note). Without one, `maxWindowEvents` silently hides older history in a long conversation: nothing on screen says the transcript begins mid-history. Implemented as a "Tải lịch sử cũ hơn" control plus a top-of-scroll pull, one page at a time, with `scrollHeight`-delta compensation so the reader's position is unchanged (the archived design's "preserve scroll position when reading older content"), and an explicit notice — not a silently dead button — when the window is at its cap (`limitReached`).
6. **Incremental rendering is proven by node identity, not by timing.** The renderer is a keyed patch (create/update/reuse/reorder/remove over a `Map` of nodes), and every claim about it in the tests is "the same DOM node object", which is unfalsifiable by a fast machine and impossible to satisfy with an `innerHTML` rebuild.
7. **Search stays local and opt-in-free.** Design decision 4's "full-transcript search is an explicit opt-in operation" is not half-implemented: nothing in this wave transfers a transcript to search it, and the module header says so.
8. **Migration Plan closeout.** Wave A's capability gate is the "feature flag": the host-authoritative + windowed behaviour turns on only once the host answers the added protocol messages, and an older companion keeps the pre-change behaviour (whole host-bounded snapshot, no local-only delete). Wave B adds no second gate and leaves no legacy path behind; the flag's *removal* condition ("remove the legacy local-only delete path after protocol tests pass") was met in wave A and is re-proven here ("export against a companion that cannot serve transcripts fails explicitly", "…as does a pin, instead of a local-only pretend success").

### Exact test output tails

```
### node test/sidepanel-history-view.test.mjs             (135 PASS)
  PASS at the very top, with more history and nothing in flight: load
  PASS just below the threshold is still not the top
  PASS extension/sidepanel/sidepanel.js parses as a module

ALL SIDEPANEL HISTORY-VIEW TESTS PASSED
exit=0

### node test/sidepanel-chat-history-multipanel.test.mjs  (60 PASS)
  PASS …still on the same row node it has had all along
  PASS loading past the cap reports limitReached instead of pretending it worked
  PASS the removed node was detached, not merely hidden

ALL SIDEPANEL CHAT-HISTORY MULTIPANEL TESTS PASSED
exit=0

### node test/sidepanel-chat-history-perf.test.mjs        (52 PASS)
  PASS [1000] …and touches exactly one key, never the whole index (keys per set: 1)
  PASS a 5000-event transcript keeps at most 1000 events (984 retained)

ALL SIDEPANEL CHAT-HISTORY PERF CHECKS PASSED
exit=0

### node test/extension-scripts-parse.test.mjs
  PASS  parses: webmcp/relay-isolated.js

8/8 passed
exit=0

### node test/extension-csp-no-inline-scripts.test.mjs
  PASS extension/sidepanel/sidepanel.html: no inline <script> (element without a src attribute) — none found
  PASS extension/sidepanel/sidepanel.html: no inline event-handler attributes (onclick=, onload=, onchange=, ...) — none found

ALL EXTENSION CSP GUARD TESTS PASSED
exit=0
```

Regression runs (second pass, after every edit landed):

```
test/sidepanel-*.test.mjs (23 files, incl. the 3 new ones)   exit=0 for every file
test/background-*.test.mjs (4 files)                         exit=0 for every file
test/extension-*.test.mjs                                    exit=0 for every file
test/enhance-prompt-companion.test.mjs                       exit=0
test/composer-enhance-prompt.test.mjs                        exit=0
host/test/chat-history-host.test.mjs                         exit=0
```

### Recorded performance numbers (task 5.3)

Command: `node --expose-gc test/sidepanel-chat-history-perf.test.mjs` (also passes without `--expose-gc`). Measured twice; the table is the second run.

```
  conversations | cold load | open screen | search | domain filter | rows rendered | cache heap
              1 |      0.1ms |       18.3ms |  0.5ms |         0.1ms |             1 |       0.0 KB
            100 |      0.3ms |        1.2ms |  1.5ms |         0.2ms |            25 |      14.9 KB
           1000 |      6.4ms |        1.3ms |  5.0ms |         0.8ms |            25 |     169.7 KB
```

Storage writes, at every size (1/100/1000 cached conversations):
`list()` = exactly **1 `storage.get`, 0 `storage.set`**; one conversation update = **1 `set` touching exactly 1 key** (never the whole index); 20 rapid prompt updates = **1 `set`** (coalesced).

Memory: 1000 cached conversations listed = **169.7 KB** heap (budget 12 MB); a 5000-event transcript = **984 events retained / 0.45 MB** heap (budget 1000 events / 8 MB); the 5000-event stream itself ran in **6.3–6.9 ms**; building a 2000-event export artifact = **2.4 ms** (budget 300 ms).

Budgets held on every assertion: open ≤ 250 ms, search ≤ 150 ms, domain filter ≤ 150 ms, cold load ≤ 750 ms, rendered rows ≤ 26 at any conversation count, cache ≤ 12 MB, transcript window ≤ 1000 events / 8 MB, export build ≤ 300 ms.

### Verify annotations

- **4.3 multi-panel live sync** — `test/sidepanel-chat-history-multipanel.test.mjs`: two panel documents share one `chrome.storage` backend (with a real `onChanged` fan-out) and one `CompanionCore`. Panel A's rename lands on the host, reaches panel B's live view, and B updates **the same row node** (asserted by object identity) with the new title; a pin made in B appears as a badge plus `aria-pressed="true"` in A on the same node; the archive badge propagates the same way; a delete in either panel removes the row and leaves the other node untouched; two concurrent deletes both report success with the host removing it once; reopening the deleted conversation surfaces the host's refusal on that conversation instead of opening a different one.
- **5.3 latency, storage writes, memory within budget** — the table above, asserted by `test/sidepanel-chat-history-perf.test.mjs`; parse/CSP proofs above (`test/extension-scripts-parse.test.mjs` for the shipped classic scripts, `test/extension-csp-no-inline-scripts.test.mjs` for the edited page, plus the module-parse section of `test/sidepanel-history-view.test.mjs` covering `history-view.js`, `history-export.js`, `panel-controller.js` and `sidepanel.js` as ES modules — `sidepanel.js` is loaded only from `sidepanel.html`, so nothing else in the tree parses it whole).
- **5.1 test coverage map** — migration: `test/sidepanel-history-store.test.mjs` (v1→v2, prompts/createdAt preserved, legacy key dropped); retention: same file (count/bytes/TTL/archive, re-entrancy); deletion: wave-A suite + the concurrent-delete block here; export: `test/sidepanel-history-view.test.mjs` (artifact contract) + `test/sidepanel-chat-history-multipanel.test.mjs` (multi-page end-to-end through a real companion); concurrent panels: `test/sidepanel-chat-history-multipanel.test.mjs`; privacy: `test/sidepanel-history-store.test.mjs` plus the cross-panel policy block here (disabling raw-prompt caching in one panel suppresses the other panel's prompt writes).
- **5.2** — the obsolete claim was `history-store.js`'s old file header ("KNOWN PROTOCOL GAP … defines no LIST_CONVERSATIONS or DELETE_CONVERSATION"), which wave A's rewrite removed; re-checked in this wave (no `gap`/`cannot list`/local-only-delete wording remains in that file or in the README, confirmed by grep and by the wave-A owner). The README's history sentence was still the pre-wave-B feature list ("list/reopen/delete"), so it was updated to the shipped surface with the evidence pointer above.

### Unresolved / surfaced (not worked around)

1. **No browser/visual pass in this environment.** The history screen's new toolbar/rows/state wording is proven by the DOM-level suite (real view code, fake DOM), by the CSP/parse guards and by the multi-panel integration — not by rendered screenshots. `reports/05-panel-evidence.md`'s visual claim was therefore left scoped to the screens it actually covers, and the README says the same.
2. **`test/overlay-background-bridge.test.mjs` still fails** (`ReferenceError: requestAnnotationClear is not defined` inside `teardownOverlayForRun`, extracted from `extension/background.js`) — pre-existing, foreign in-flight file, unchanged by this wave.
3. **The transcript view still rebuilds its DOM via `innerHTML`.** Task 4.2's incremental rendering is about the history list (which is now a keyed patch); the chat transcript is rebuilt from a bounded window on each render. Not converted here: it is outside this change's task list, and a comment-based partial conversion would be worse than the current, obviously-correct rebuild.
4. **Full-transcript search remains unimplemented by design** (design decision 4: explicit opt-in). The search box searches metadata locally; nothing in this wave transfers a transcript to search it.
5. **The older-history cap is a hard window, not a scrollback buffer.** At `maxWindowEvents` the panel says so and stops; a configurable cap or a detached scrollback remains the wave-A follow-up it was, now with an honest UI instead of silence.

---

## Findings resolution — verification round 1

Date: 2026-09-13. Independent verification (`agent://VerifyChatHistory`) returned **PASS / 0 CRITICAL** with three MAJOR findings and one MINOR that must not reach the archive. This section records each finding, the root-cause fix, the exact output afterwards, and noted corrections to claims in the two wave sections above (kept as written — history is corrected by note, not rewritten). All commands run from the repo root; every tail is verbatim; exit 0 = suite passed.

### Finding 1 (MAJOR) — the declared `browser-assistant-panel` modification shipped no delta

**Was:** `proposal.md` lists `browser-assistant-panel` under Modified Capabilities ("Change history UI and deletion behavior to use authoritative host state"), but `openspec/changes/optimize-chat-history/specs/` held only the three ADDED deltas — while the canonical spec still mandates the behavior this change removes (`openspec/specs/browser-assistant-panel/spec.md:34`: "new conversation, list/reopen conversations, **explicit local history deletion**, …"). Archiving would have dropped the declared modification and left the canonical spec contradicting shipped host-first deletion.

**Now:** `openspec/changes/optimize-chat-history/specs/browser-assistant-panel/spec.md` (NEW) with `## MODIFIED Requirements` → **Session and recording access**, the only requirement this change actually changes. The replacement text keeps the recording-access sentences and the "Attachment to conversation" scenario verbatim and replaces the deletion/listing half with the shipped contract: listing/reopening driven by host summaries with stale/orphan handling; deletion as a host operation that drops the local cache entry only after the host acknowledges; an idempotency key so a replayed/concurrent delete resolves as the same success; failures (unknown conversation, unreachable companion, old companion) reported with the local entry intact and never as a local-only success; a partial delete-all reported as incomplete. New scenarios: *Delete a conversation from the history list*, *A conversation the host no longer reports*, *A replayed delete is not a second failure*, *Delete-all cannot be confirmed in full*. Structure mirrors the established archived convention (`openspec/changes/archive/2026-09-10-scope-conversation-restore-per-tab/specs/browser-assistant-panel/spec.md`).

**Proof:**

```
openspec validate optimize-chat-history --strict
Change 'optimize-chat-history' is valid
exit=0
```

### Finding 2 (MAJOR) — privacy/retention were store-only: no user could reach them

**Was:** `setRawPromptCachingEnabled`, `setPolicy` and `evictionReport` had no caller outside the store and its tests; the history screen's only privacy control was "Xóa tất cả". The enforcement (write-point suppression, dropping cached previews, retention + eviction log) was real and tested — the gap was that nothing shipped ever called it, so tasks.md 2.2's privacy toggle and chat-history-storage's "the user can see the outcome" were unreachable.

**Now (reachability added, enforcement untouched):**

- `extension/sidepanel/history-privacy.js` (NEW). `HistoryPrivacyControls` binds the switch to `store.setRawPromptCachingEnabled()` and the outcome line to `store.evictionReport()`; `sync()` reads the **persisted** policy (new `HistoryStore#effectivePolicy()`, because `policy()` answers from defaults until the first load) and flushes so retention this session has not yet applied is reflected; a `retention` store notification re-renders the line without a reload. `retentionSummaryText()` is the copy decision as a pure function (counts by outcome, hidden when nothing was evicted, and states the conversations themselves are still on the companion so the line cannot read as data loss). The switch is a negative control ("Không lưu nội dung câu hỏi") — checked means caching disabled — and the inversion lives in one method so the checkbox, the policy and the copy cannot disagree.
- `extension/sidepanel/sidepanel.html`: the switch (accessible name, shared `.switch` component, no inline handlers) and the `role="status"` outcome line, in the history section between the toolbar and the list.
- `extension/sidepanel/sidepanel.css`: `.history-privacy` block (row layout + the outcome line slot), tokens only.
- `extension/sidepanel/sidepanel.js`: imports the module, registers `history-privacy-toggle`/`history-retention-outcome` in the element map, constructs the controls over the real `historyStore`, and `await historyPrivacy.sync()` on every `refreshHistoryView()`. The store's live-sync listener now also re-renders on `policy`, which is what carries a change made in the other panel onto this screen.
- `extension/sidepanel/history-store.js`: `effectivePolicy()` (one new method; the enforcement code is unchanged).

**Proof** — DOM-level, through the real module and a real `HistoryStore` over the fake `chrome.storage` (`test/sidepanel-history-store.test.mjs`; the DOM suite that owns the privacy story, since the control is a thin binding over exactly the store APIs tested there):

```
== privacy switch (history screen): pressing it reaches the store, and dropping previews is real ==
  PASS with the default policy the switch is off — caching is ON, and the control says so by being off
  PASS sanity: the prompt is cached while caching is on
  PASS the switch disabled raw-prompt caching in the store
  PASS …and the previews it had already cached are dropped, not merely stopped
  PASS the conversation still lists, marked preview-suppressed
  PASS the choice is persisted, so it survives a panel restart
  PASS a later run is not cached either
  PASS switching it back resumes caching
  PASS after a restart the switch reads the persisted policy (caching disabled => switch on)
== effectivePolicy: a control sees the PERSISTED policy, not the pre-load defaults ==
  PASS policy() alone answers from the defaults until the store has loaded (which is why effectivePolicy() exists)
  PASS effectivePolicy() returns the persisted record after the first load
== retention outcome (history screen): what retention did is visible, and honest about where the conversations are ==
  PASS nothing evicted renders as nothing — the line stays hidden rather than announcing a non-event
  PASS the summary counts each outcome (Bản lưu cục bộ đã tự lưu trữ 2 và xóa 1 cuộc trò chuyện cũ để giữ trong giới hạn; hội thoại vẫn còn trên máy chủ companion.)
  PASS …and says the conversations themselves are still on the companion, so it cannot read as data loss
  PASS an archive-only outcome says so
  PASS a remove-only outcome says so
  PASS with nothing evicted yet the line stays hidden
  PASS sanity: retention archived the oldest eligible conversation
  PASS the outcome line shows up as soon as retention acts (Bản lưu cục bộ đã tự lưu trữ 1 cuộc trò chuyện cũ để giữ trong giới hạn; hội thoại vẫn còn trên máy chủ companion.)
  PASS …over a list that still shows every conversation (archived, not deleted)
  PASS a remove-on-evict policy reports a removal (Bản lưu cục bộ đã tự xóa 1 cuộc trò chuyện cũ để giữ trong giới hạn; hội thoại vẫn còn trên máy chủ companion.)
== reachability: the shipped panel offers these controls (the store-only gap, closed) ==
  PASS the history screen's switch exists and carries an accessible name
  PASS the retention outcome line exists as a status region — the user can see the outcome
  PASS both ids are registered in the panel's element map, so the markup and the wiring cannot drift apart
  PASS the panel binds them to the real HistoryStore — not to a second, decorative copy of the policy
  PASS and syncs them on every history refresh, so a policy changed in another panel is reflected here too
```

The last block is the wiring contract asserted the way this repo asserts a control that lives in the non-importable `sidepanel.js` (`test/composer-enhance-prompt.test.mjs` does the same for `btn-enhance`): the markup carries the control, and the panel binds those exact ids to the real store.

**Visual smoke check (static, not the extension surface).** The new block was rendered once against the real `tokens.css`/`base.css`/`components.css`/`sidepanel.css` in a throwaway page at 320px: the label column and the switch lay out on one row (label 214px, switch 40px inside a 292px block), the outcome line wraps below it, and the document has no horizontal overflow (`scrollWidth === viewport`). This is a layout check of the CSS only — the panel itself still has no browser pass in this environment (see "Unresolved" above).

### Finding 3 (MAJOR) — the scroll-preservation test was vacuous

**Was:** `withReflowClamping` was installed on the SCROLLER while `HistoryListView._patch` mutates the CONTAINER, and the scenario re-rendered 12 rows in unchanged order, so no `insertBefore`/`removeChild` ever fired: the instrumented run reported `{scrollerClampCalls:0, containerMutations:0, scrollTopAfter:500}`. The assertion passed whether or not `_patch`'s restore line existed.

**Now:** the simulator is installed on the element the patch mutates (`withReflowClamping(container, { scroller })`) and moves the scroller's offset once per mutation; it exposes `mutations`/`lastClampedTo` so the scenario can prove it ran. The re-render now forces container mutations — a pin moves a row to the pinned group (reorder), one row is deleted, one added, the rest renamed in place — and the test asserts (a) the simulator fired, (b) the clamped offset really moved away from the snapshot, (c) exactly one row was created and one removed, and only then (d) the offset is back at 500.

**Proof:**

```
== paging: only the first page renders, more loads on demand, scroll survives a render ==
  PASS the re-render mutated the container, so the reflow simulator fired (17 insert/remove calls)
  PASS …and it moved the scroll offset away from the snapshot (clamped to 0)
  PASS …with one row created and one removed, the rest kept ({"created":1,"updated":4,"reused":8,"removed":1})
  PASS the reader's scroll offset survives a render that reordered, added and removed rows (scrollTop=500)
  PASS far from the bottom, scrolling does not pull a page
  PASS near the bottom it does
```

**Negative control (scratch, not committed).** With the restore line in `history-view.js:_patch` replaced by a comment, the very same test fails exactly on that property — proving the assertion is falsifiable:

```
  FAIL the reader's scroll offset survives a render that reordered, added and removed rows (scrollTop=0)
```

The file was restored byte-for-byte afterwards (`md5sum -c` → OK) and the suite re-run green.

Wording corrected to match what is now actually tested: `test/_fake-dom.mjs`'s capability list (the scroll metrics are "plain writable numbers, so a test can install a reflow simulation…") and `history-view.js`'s header claim now names the paging scenario and the removal-of-restore failure mode.

### Finding 4 (MINOR) — the boot race read "probe unanswered" as "host refused", leaving a model uncapped

**Was:** `_getOrCreateModel` chose `maxWindowEvents` from the strict boolean `hostHistorySupported()` (`null` → `false` → `Infinity`), and the probe is fire-and-forget — so a conversation whose snapshot/resume reply beat the `list_conversations` reply kept an unbounded event window for the panel's whole lifetime. Measured semantics: 20000/20000 events retained with `Infinity` vs 924 with the default cap.

**Now:** the construction site reads the tri-state and only an actual refusal is unbounded:

```js
maxWindowEvents: this.hostHistorySupport() === false ? Infinity : undefined
```

Anything short of a proven refusal (including the in-flight probe) keeps the model on the windowed protocol. Every other gate already compared against `false` explicitly; the boolean accessor had no production caller left, so it was removed and `hostHistorySupport()` (tri-state) is now the single accessor (its comment documents that null ≠ refused).

**Proof** — `test/sidepanel-chat-history-lifecycle.test.mjs` reproduces the race with a transport that holds the `list_conversations` request until released:

```
== boot race: a conversation whose snapshot beats the history probe stays CAPPED (tasks.md 3.3) ==
  PASS exactly one history probe is outstanding while the reply is held
  PASS the probe has not answered, so support is still unproven (null, not false)
  PASS the snapshot reply built the conversation's model while the probe was still in flight
  PASS …and that model is capped, not unbounded (maxWindowEvents=1000)
  PASS a 1500-event snapshot is trimmed to the window (750 retained)
  PASS the held probe reply lands and proves the host speaks the history protocol
  PASS the raced conversation keeps its capped model after the proof arrives
```

**Negative control (scratch, not committed).** With the old expression restored in `panel-controller.js`, the same tests fail — the race test is falsifiable:

```
  FAIL …and that model is capped, not unbounded (maxWindowEvents=Infinity)
  FAIL a 1500-event snapshot is trimmed to the window (1500 retained)
  FAIL the raced conversation keeps its capped model after the proof arrives
3 FAILED
```

The file was restored byte-for-byte afterwards and the suite re-run green. The old-host behavior is unchanged and still pinned: a host that REFUSED (`false`) gets `maxWindowEvents === Infinity` and retains the whole snapshot ("models created while the host is unsupported render the whole transcript, not a window").

### Files changed by this fix pass

| File | What changed |
| --- | --- |
| `openspec/changes/optimize-chat-history/specs/browser-assistant-panel/spec.md` | NEW — `## MODIFIED Requirements` for "Session and recording access" (finding 1). |
| `extension/sidepanel/history-privacy.js` | NEW — the privacy switch + retention outcome controls over the store's own APIs (finding 2). |
| `extension/sidepanel/history-store.js` | `effectivePolicy()`: the persisted policy after the first load, so a control never reads pre-load defaults. Enforcement untouched. |
| `extension/sidepanel/sidepanel.html` | The switch (`history-privacy-toggle`) and the `role="status"` outcome line (`history-retention-outcome`) in the history section. |
| `extension/sidepanel/sidepanel.css` | `.history-privacy`/`.history-privacy-row`/`.history-privacy-label` (tokens only). |
| `extension/sidepanel/sidepanel.js` | Element refs, module import, controls construction over `historyStore`, `historyPrivacy.sync()` in `refreshHistoryView()`, and `policy` added to the live-sync listener. |
| `extension/sidepanel/panel-controller.js` | `_getOrCreateModel` reads the tri-state; the boolean `hostHistorySupported()` accessor removed (finding 4). |
| `extension/sidepanel/history-view.js` | Header note only: the scroll-preservation claim now names its test and failure mode. |
| `test/sidepanel-history-view.test.mjs` | Reflow simulator moved onto the container, mutation-producing scroll scenario + falsifiability evidence (finding 3). |
| `test/sidepanel-chat-history-lifecycle.test.mjs` | Gated-probe transport + the boot-race test; gate assertions moved to the tri-state (finding 4). |
| `test/sidepanel-history-store.test.mjs` | `effectivePolicy`, the DOM-driven switch, the retention outcome, and the reachability contract (finding 2). |
| `test/_fake-dom.mjs` | `removeEventListener`; comment corrected to what a reflow simulation can actually observe. |
| `README.md` | History sentence names the prompt-caching switch and the retention outcome line; the screenshot caveat now says "search/filter/export/privacy surface". |
| `reports/implementation-evidence.md` | This section. |

### Exact test output tails (after every edit above)

```
### node test/sidepanel-history-view.test.mjs              (137 PASS, exit 0)
  PASS extension/sidepanel/panel-controller.js parses as a module
  PASS extension/sidepanel/sidepanel.js parses as a module

ALL SIDEPANEL HISTORY-VIEW TESTS PASSED

### node test/sidepanel-history-store.test.mjs             (107 PASS, exit 0)
  PASS no chrome.storage.session present still resolves to null rather than throwing
  PASS the in-memory fallback still round-trips within the life of this store instance

ALL SIDEPANEL HISTORY-STORE TESTS PASSED

### node test/sidepanel-chat-history-lifecycle.test.mjs    (52 PASS, exit 0)
  PASS the held probe reply lands and proves the host speaks the history protocol
  PASS the raced conversation keeps its capped model after the proof arrives

ALL SIDEPANEL CHAT-HISTORY LIFECYCLE TESTS PASSED

### node test/sidepanel-chat-history-multipanel.test.mjs   (59 PASS, exit 0)
  PASS the surviving row kept its exact DOM node — the delete was incremental
  PASS the removed node was detached, not merely hidden

ALL SIDEPANEL CHAT-HISTORY MULTIPANEL TESTS PASSED

### node test/sidepanel-fake-companion.test.mjs            (77 PASS, exit 0)
  PASS an unscoped panel starts a brand-new conversation instead
  PASS the known scope's remembered id is exactly what it was before the unscoped panel ever ran

ALL SIDEPANEL FAKE-COMPANION TESTS PASSED

### node test/sidepanel-conversation-model.test.mjs        (102 PASS, exit 0)
  PASS an overlapping live event at seq <= the watermark is dropped
  PASS a newer event is applied exactly once

ALL SIDEPANEL CONVERSATION-MODEL TESTS PASSED

### node host/test/chat-history-host.test.mjs              (51 PASS, exit 0)
  PASS and reports that older events remain
  PASS an unknown conversation fails honestly rather than returning an empty page

ALL CHAT-HISTORY HOST TESTS PASSED

### node test/extension-scripts-parse.test.mjs             (8/8, exit 0)
8/8 passed

### node test/extension-csp-no-inline-scripts.test.mjs     (15 PASS, exit 0)
  PASS extension/sidepanel/sidepanel.html: no inline <script> (element without a src attribute) — none found
  PASS extension/sidepanel/sidepanel.html: no inline event-handler attributes (onclick=, onload=, onchange=, ...) — none found

ALL EXTENSION CSP GUARD TESTS PASSED

### node test/sidepanel-chat-history-perf.test.mjs         (51 PASS, exit 0)
  5000 events              17.9ms
  export 2000 events       2.5ms

ALL SIDEPANEL CHAT-HISTORY PERF CHECKS PASSED
```

Scoped area sweep (markup + `panel-controller.js` + `history-store.js` are inputs to all of these): all 23 `test/sidepanel-*.test.mjs` suites exit 0, plus the four suites that read `sidepanel.html` as text (`test/composer-enhance-prompt.test.mjs` 48, `test/composer-add-and-effort.test.mjs` 41, `test/sidepanel-design-mode.test.mjs` 31, `test/navigate-url-scheme.test.mjs`) exit 0.

### Corrections to the wave sections above (noted, not rewritten)

- **Assertion counts.** The verifier's `grep -c '  PASS '` counts are the accurate ones: `sidepanel-history-view` 134 (reported 135), `sidepanel-chat-history-multipanel` 59 (reported 60), `sidepanel-chat-history-perf` 51 (reported 52). The wave sections' numbers were one high each; after this fix pass the counts are: history-view **137**, history-store **107** (was 81), multipanel **59**, fake-companion **77**, conversation-model **102**, lifecycle **52** (was 45), host **51**, perf **51**.
- **Run-dependent performance numbers.** The table under "Recorded performance numbers (task 5.3)" is one sample of a measurement that varies with machine load: the verifier's re-run measured cache heap 273.4 KB (recorded 169.7 KB) and transcript window 5.09 MB (recorded 0.45 MB) with every budget assertion still holding. The budgets are asserted by the perf suite; the printed values are not constants and should be read as such.
- **`extension/sidepanel/history-store.js` is no longer untouched by wave B.** The "Untouched on purpose" line in wave B's files table predates this pass; the file now carries `effectivePolicy()` (finding 2). The wave-B prose remains as written — this note is the correction.
- **`hostHistorySupported` no longer exists.** Wave B's files table and Notable decision 4 above describe it, and the report's decision-4 fix ("Added `hostHistorySupport()` tri-state") is what this pass completed: the strict boolean accessor was removed once every caller compared against `false` explicitly (finding 4). The tri-state `hostHistorySupport()` is the only accessor now.
- **`test/_fake-dom.mjs`'s coverage line changed.** Wave B's files table described it as covering "scroll metrics" as an observability aid; the comment now states precisely what makes scroll preservation observable (a reflow simulation over the container's mutations), which is what the fixed test installs.

### Unresolved / surfaced (this pass)

1. **The static render is not a panel pass.** The privacy block's layout was checked against the real stylesheets in a throwaway page (320px, no overflow), and its behavior by the DOM suite — but the extension's own side panel still has no browser/visual pass in this environment, as wave B recorded.
2. **A failed policy *persistence* is still silent** (the store's `_persistPolicy()` swallows a storage error, the in-memory policy and the switch still show the new choice). That is the store's pre-existing best-effort contract, not introduced here; the switch reports the effective policy of the running panel either way.

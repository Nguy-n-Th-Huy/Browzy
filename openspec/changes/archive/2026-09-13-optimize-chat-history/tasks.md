## 1. Authoritative lifecycle
- [x] 1.1 Add host summary revision, title, hostname, pinned, archived, and updated metadata.
- [x] 1.2 Wire panel list/reconcile to host summaries and mark orphaned local entries.
- [x] 1.3 Make delete/delete-all remove host data and local cache with idempotency and confirmation. ← (verify: failure never reports success)

## 2. Storage and retention
- [x] 2.1 Replace whole-list read-modify-write with per-conversation dirty queue and 500–1000ms debounce.
- [x] 2.2 Add schema migration, count/byte limits, preview caps, TTL/archive policy, and privacy toggle.
- [x] 2.3 Flush on run terminal, delete, unload, and clean stale last-active keys on tab removal. ← (verify: quota/race/restart tests)

## 3. Transcript performance
- [x] 3.1 Batch host metadata writes while preserving durable event sequence.
- [x] 3.2 Add sequence-window transcript loading and lazy older-event retrieval.
- [x] 3.3 Cap rendered model memory and preserve reconnect/replay correctness. ← (verify: large transcript benchmark and no duplicate events)

## 4. History UI
- [x] 4.1 Add debounced search, date/domain filters, grouping, and keyboard reopen.
- [x] 4.2 Implement pagination or virtualization with incremental DOM updates and scroll preservation.
- [x] 4.3 Add loading, empty, offline, error, stale, pin, archive, rename, export, and clear-all states. ← (verify: multi-panel live sync)

## 5. Validation and docs
- [x] 5.1 Add unit/integration tests for migration, retention, deletion, export, concurrent panels, and privacy settings.
- [x] 5.2 Update history-store comments and README to remove the obsolete protocol-gap claim.
- [x] 5.3 Run extension parse/CSP and manual performance checks with 1, 100, and 1000 conversations. ← (verify: latency, storage writes, and memory remain within agreed budgets)

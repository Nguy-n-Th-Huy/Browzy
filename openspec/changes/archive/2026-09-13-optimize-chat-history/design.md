## Context

The panel's local `HistoryStore` currently performs read-modify-write of one growing list, while the host already has conversation summaries and delete handlers. Transcript replay is bounded at the event payload level but still rebuilds an unbounded client model and rewrites host metadata frequently.

## Goals / Non-Goals

**Goals:** authoritative host lifecycle, low-write local cache, bounded transcript rendering, fast search/filtering, cross-panel convergence, and explicit privacy/retention controls.

**Non-Goals:** changing conversation semantics, deleting recordings implicitly, or weakening transcript access controls.

## Decisions

1. Host summaries are canonical; local storage is a cache with schema version and reconciliation timestamps. This fixes stale deletion behavior without breaking offline startup.
2. Use per-conversation dirty records and a debounced flush queue. This avoids full-index rewrites and preserves a final synchronous best-effort flush on lifecycle events.
3. Keep durable event sequence numbers while loading transcript pages by sequence range. The model renders a window and requests older events on scroll rather than dropping replay correctness.
4. Search metadata locally after host summaries load, with cancellation and incremental row updates. Full transcript search is an explicit opt-in operation to avoid transferring large logs.
5. Treat delete/export as host operations with idempotency keys; clear local cache only after acknowledgement, then reconcile.

## Risks / Trade-offs

- [Crash before a debounced flush] → Host transcript remains durable; local index rebuilds from host summaries on next startup.
- [Large host directories] → Maintain a lightweight metadata index and limit summary responses.
- [Cross-panel races] → Use revision/updatedAt checks and last-write-wins only for presentation metadata; transcript events remain append-only.
- [Privacy expectations] → Default to short previews, expose retention settings, and make clear-all explicit.

## Migration Plan

Read the existing local v1 index, write a versioned cache, reconcile against host summaries, and preserve entries that cannot yet be resolved as clearly marked legacy items. Enable debounced writes and virtual rendering behind a feature flag, then remove the legacy local-only delete path after protocol tests pass.

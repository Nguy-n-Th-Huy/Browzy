## Why

Chat history becomes slow and misleading as conversations grow because the panel repeatedly rewrites the entire local index, rebuilds every row, and does not use the host's authoritative conversation list for deletion and reconciliation. Large transcripts also increase filesystem and DOM work, while raw prompt caching has no clear retention limit.

## What Changes

- Make host conversation metadata the authoritative source and reconcile the local cache.
- Coalesce history writes, add bounded retention, and clean per-tab last-active keys.
- Batch transcript metadata I/O and provide bounded/lazy transcript replay.
- Add search, date/domain filters, pagination or virtualized rendering, and incremental updates.
- Support true host-side delete-all semantics, export, rename, pin, and archive metadata.
- Add privacy controls for prompt retention and clear loading/error/empty states.

## Capabilities

### New Capabilities
- `chat-history-storage`: Bounded, coalesced, privacy-aware conversation index and transcript retention.
- `chat-history-browsing`: Search, filtering, pagination, virtualization, and live synchronization.
- `chat-history-lifecycle`: Authoritative list/delete/reconcile, export, rename, pin, and archive operations.

### Modified Capabilities
- `browser-assistant-panel`: Change history UI and deletion behavior to use authoritative host state.

## Impact

Affected code includes `extension/sidepanel/history-store.js`, `panel-controller.js`, `sidepanel.js`, `conversation-model.js`, host protocol/companion/session manager/transcript store, storage metadata, and related tests and documentation. Existing conversations and MCP browser execution remain compatible through migration and fallback handling.

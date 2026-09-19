# Design: Page Snapshot Comparison

## Context

- Browzy's run surface is the SDK tool set assembled in `host/agent/companion.js`: extension-backed tools through the tool bridge, plus **host-side SDK tools** registered on the same server (`extraTools`) and named in `extraToolNames`. `create_document` (`host/agent/tools/create-document.js`) is the precedent and the template: a factory `create<Name>Tool({ run, conversationId, store, toolFactory, now })`, an exported `*_TOOL_NAME` constant, zod parameter shapes, and guards that **reject rather than truncate**.
- Every destination path is owned by `host/agent/storage/paths.js` (`agentRoot()` under `~/.config/browzy-in-chrome/agent`, overridable with `OCIC_AGENT_HOME`; `ensureDir`, `assertSafeId`). A run may not choose paths.
- Report writing already exists: `host/agent/documents/store.js` (`DocumentStore.write`) + `host/agent/documents/render/*`, behind `create_document`. A comparison report must reuse it, not reinvent it.
- The page-reading side needs nothing new: runs already extract fields with `page_snapshot`, `get_page_text`, `read_page`, or `javascript_tool`. Snapshotting persists what the run already read.
- See proposal.md for motivation; deltas: `workflow/page-snapshot`, `workflow/snapshot-comparison`.

## Goals / Non-Goals

**Goals:**
- One host-side tool (`page_snapshots`) with five actions — save, list, get, delete, compare — bound to the run like `create_document`.
- Durable, human-browsable JSON snapshots under the agent root, with a documented record shape and rejecting guards.
- A pure recursive diff with path tracking, and dual reports (JSON + markdown), the markdown reusable as a document card.
- Zero extension, wire-protocol, approval, or workflow-record changes.

**Non-Goals:**
- No page-side extraction heuristics or selectors: the caller supplies `fields` (the run has the read tools; inference would add a second, drifting extractor).
- No scheduler, watcher, notification, or background job: the pattern is "save now, revisit later, compare", driven by runs.
- No snapshot versioning/retention policy beyond name + timestamp; no cross-machine sync.
- No new render pipeline: reports go through the existing document path.

## Decisions

### 1. One host-side tool, five actions

`host/agent/tools/page-snapshots.js` exports `PAGE_SNAPSHOTS_TOOL_NAME = "page_snapshots"` and `createPageSnapshotsTool({ run, conversationId, store, reportStore, toolFactory, now })`. Parameters: `action` (`save|list|get|delete|compare`) plus the per-action fields, validated by zod and then by the store/diff modules.

*Alternatives rejected*: five separate tools (five registrations, five `extraToolNames` entries, five labels — more surface for the same behavior); extension-side tools (storage belongs to the host, and a browser-side store would be invisible to the panel, CLI, and tests).

### 2. Storage under the agent root, one directory per URL

`storage/paths.js` gains `snapshotsRoot()` = `path.join(agentRoot(), "snapshots")` and `snapshotUrlDir(urlHash)`. `SnapshotStore` (`host/agent/snapshots/store.js`):
- `save({ name, url, title, fields, metadata })` → mints the timestamp (`new Date().toISOString()`), slugifies `name` with the same bounded, safe-character discipline as `slugifyTitle`, hashes the normalized URL with sha256 (scheme+host+path, sorted query), writes `<name>-<timestamp>.json`, returns the record.
- `list({ url, namePattern })` → newest first, tolerant of unreadable files (marked invalid); missing root ⇒ empty.
- `read(ref)` / `remove(ref)` — by `{ name, url }` or `{ path }`, with the path form still confined to the snapshots root.
- Guards (rejecting): `MAX_FIELDS_BYTES` (2 MiB, mirroring `MAX_SOURCE_BYTES`), name length, JSON-serializability of `fields`, and a bound on snapshots per URL directory.

*Alternatives rejected*: per-conversation storage (monitoring spans conversations, and a baseline captured last week must stay reachable); SQLite (dependency, and the snapshots are meant to be human-browsable files).

### 3. A pure diff engine with path tracking

`host/agent/snapshots/diff.js` exports `diffFields(baseline, current)` returning `{ added: [{path, value}], removed: [{path, value}], changed: [{path, old, new, typeChanged}] }`. Recursion walks objects by key and arrays by index; identical array multisets in a different order collapse into a `reordered` entry (items and their old/new positions) instead of N changed entries; type mismatches are `changed` with `typeChanged: true`. The engine is pure — no I/O, no clock — so it is unit-testable against fixtures.

*Alternatives rejected*: an external diff library (output shape would not match the report contract; the function is ~150 lines of plain recursion).

### 4. Reports: JSON + markdown, document write on request

`host/agent/snapshots/report.js` exports `jsonReport(...)` and `markdownReport(...)` (identity of both sides, summary counts, then Added / Removed / Changed sections). The `compare` action returns both inline; when `writeReport: true` (default) it also writes the markdown through the injected `DocumentStore` (`reportStore`) as `create_document` does, and names the created document in the result. A failed document write never fails the comparison: the diff is returned with the document failure noted.

### 5. Registration and the invisible-tool trap

`companion.js` mirrors the `create_document` wiring exactly: import the factory, `await createPageSnapshotsTool({ run, conversationId, store: this.snapshotStore, reportStore: this.documentStore })`, add it to `extraTools: [...]`, and add `PAGE_SNAPSHOTS_TOOL_NAME` to the `extraToolNames` list passed into `buildIsolatedOptions()` — the documented failure mode where a tool is registered but never visible to the model. A constructor field `snapshotStore` follows `documentStore`'s injection pattern (tests pass a scratch-rooted store). The panel gets one label in `extension/sidepanel/tool-labels.js`.

### 6. Tests

- `host/test/page-snapshots-store.test.mjs`: save/round-trip/multiple-per-URL/hostile names/storage guards; list filters + corrupted entry; get/delete + directory pruning — against a scratch `OCIC_AGENT_HOME`.
- `host/test/page-snapshots-diff.test.mjs`: added/removed/changed, nested paths, array add/remove/reorder, type change, identical inputs.
- `host/test/page-snapshots-tool.test.mjs`: the tool's five actions end-to-end through the factory with a stubbed `toolFactory`, including the document-write-on-compare path and every rejecting guard, plus the registration proof (name present in `extraToolNames`) in the style the existing host-tool tests use.

## Risks / Trade-offs

- **[Snapshots accumulate on disk]** → delete action + documented retention; no automatic sweeping (a baseline the operator forgot about is still a baseline).
- **[Caller-supplied `fields` vary in shape between captures]** → that is visible as a diff, which is the point; the record shape stays stable and the diff tolerates type changes rather than rejecting them.
- **[Large `fields` payloads]** → bounded at 2 MiB, reject-not-truncate; a truncated snapshot silently missing rows would be worse than a failed save.
- **[Markdown report duplication with existing document rendering]** → deliberately none: the report is markdown text handed to `DocumentStore`, not a new format.

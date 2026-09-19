# Proposal: Page Snapshot Comparison

## Why

The operator needs to monitor pages over time — capture the fields a page shows today, come back days or weeks later, and see exactly what changed. Browzy today can read a page in one run but keeps nothing: no snapshot to return to, no baseline to compare against, so "what changed since last time?" can only be answered by eyeballing two visits. The feature is a small, self-contained host-side capability: persist a run's extracted fields as JSON, then diff two saved snapshots into a report the operator can read or download.

## What Changes

- **A snapshot capability exposed to runs** (`page_snapshots`, one tool with actions `save`, `list`, `get`, `delete`, `compare`), bound to the run the way `create_document` already is: the model supplies the data it read from the page, the host owns every path, id, and filename.
- **Snapshot storage**: one JSON file per capture under the companion's own user-data tree (`<agent root>/snapshots/<url-hash>/<name>-<timestamp>.json`, `OCIC_AGENT_HOME` overridable for tests), with a documented record shape (page identity, capture timestamp, extracted `fields`, and metadata). Names are slugified host-side; guards reject rather than truncate.
- **Field-level comparison**: a recursive diff (added / removed / changed, with full field paths, old and new values, array handling, type-change detection) rendered in two forms — a JSON report for automation and a markdown report for reading. When asked, the markdown report is also written through the **existing** `create_document`/`DocumentStore` path so it appears as a document card — no new render pipeline.
- **Unchanged**: the browser tool registry, the extension, the wire protocol, approvals, and the workflow record format. This is additive and host-only: no new extension code, no page-side extraction heuristics (the run already reads pages with the tools it has).

## Capabilities

### New Capabilities
- `workflow/page-snapshot`: the snapshot capability's save/list/get/delete actions, the stored record shape, the storage layout and its guards.
- `workflow/snapshot-comparison`: the compare action — recursive field diff, JSON + markdown reports, and the revisit-and-compare pattern.

### Modified Capabilities
- (none — additive feature)

## Impact

- **New host modules**: `host/agent/snapshots/store.js` (SnapshotStore), `host/agent/snapshots/diff.js` (pure diff), `host/agent/snapshots/report.js` (JSON + markdown reports), `host/agent/tools/page-snapshots.js` (the SDK tool, `PAGE_SNAPSHOTS_TOOL_NAME`).
- **Modified host files**: `host/agent/storage/paths.js` (snapshot directory helpers under the existing agent root), `host/agent/companion.js` (register the tool beside `create_document`/`ask_user`/`propose_workflow_heal` **and** name it in `extraToolNames` — the documented registered-but-invisible trap).
- **Panel**: `extension/sidepanel/tool-labels.js` (one Vietnamese label for the new tool).
- **Tests**: `host/test/` — store/diff/report units against a scratch `OCIC_AGENT_HOME`, tool-level actions end-to-end, and the registration proof the existing host-tool tests use.

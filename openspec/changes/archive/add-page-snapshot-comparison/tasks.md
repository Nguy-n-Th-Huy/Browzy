# Tasks: Page Snapshot Comparison

## 1. Storage paths and the snapshot store

- [x] 1.1 `host/agent/storage/paths.js`: add `snapshotsRoot()` (`<agentRoot()>/snapshots`, `OCIC_AGENT_HOME` honored through the existing `agentRoot()`) and `snapshotUrlDir(urlHash)`; reuse `ensureDir`/`assertSafeId` — no new path logic elsewhere
- [x] 1.2 `host/agent/snapshots/store.js`: `SnapshotStore` with `save`, `list`, `read`, `remove`, plus `urlHash(url)`, `slugifyName(name)`, and the rejecting guards (`MAX_FIELDS_BYTES = 2 MiB`, name length bound, JSON-serializability, per-URL count bound). Record shape exactly as the spec's "Snapshot record shape": `url, title, name, timestamp, fields, metadata`. Missing root ⇒ empty listing; corrupted file ⇒ marked invalid, never fatal
- [x] 1.3 `host/test/page-snapshots-store.test.mjs`: round-trip; several snapshots per URL with no overwrite; hostile names rejected (empty, path separators, traversal, oversize); storage failure named; list newest-first with URL/name filters; corrupted entry marked invalid; get/delete by name+URL and by path; emptied URL directory pruned; oversize `fields` rejected — all against a scratch `OCIC_AGENT_HOME` ← (verify: guards reject rather than truncate; no path outside the snapshots root is ever touched)

## 2. Diff engine and reports

- [x] 2.1 `host/agent/snapshots/diff.js`: pure `diffFields(baseline, current)` → `{ added, removed, changed, reordered }` with full paths (`user.email`, `items[2].name`), type-change flagging, array add/remove, and reorder detection instead of position-by-position noise
- [x] 2.2 `host/agent/snapshots/report.js`: `jsonReport(...)` (both sides' identity, summary counts, the three lists) and `markdownReport(...)` (identity, summary, Added / Removed / Changed sections with paths and values) — the exact shapes the spec's "Comparison report forms" pins
- [x] 2.3 `host/test/page-snapshots-diff.test.mjs`: identical inputs ⇒ empty diff; added/removed/changed; nested paths; array additions/removals; reorder reported as reorder; type change reported with both values and the flag; deep fixtures ← (verify: paths are unambiguous and no unchanged field is reported)

## 3. The tool

- [x] 3.1 `host/agent/tools/page-snapshots.js`: export `PAGE_SNAPSHOTS_TOOL_NAME = "page_snapshots"` and `createPageSnapshotsTool({ run, conversationId, store, reportStore, toolFactory, now })` mirroring `create-document.js` (SDK `tool()` with zod shapes, `run.emit(...)` on a successful save/compare, errors returned as `isError` text naming the reason). Actions: `save`, `list`, `get`, `delete`, `compare`; `compare` returns JSON + markdown and writes the markdown through `reportStore` (a failed write is noted without failing the comparison)
- [x] 3.2 `host/test/page-snapshots-tool.test.mjs`: all five actions end-to-end through the factory with a stubbed `toolFactory` and a scratch-rooted store; compare of two stored snapshots returns both report forms and names the written document; every rejecting guard surfaces as a named, non-throwing error ← (verify: the tool never reads the page and never chooses a path)
- [x] 3.3 `host/agent/companion.js`: import the factory, add a `snapshotStore` constructor field (injection pattern of `documentStore`), create the tool beside `createDocumentTool`/`proposeHealTool`, add it to `extraTools`, **and** name `PAGE_SNAPSHOTS_TOOL_NAME` in the `extraToolNames` list feeding `buildIsolatedOptions()` ← (verify: registered AND visible — the documented invisible-tool trap; grep both sites agree)

## 4. Panel surface

- [x] 4.1 `extension/sidepanel/tool-labels.js`: one Vietnamese label for `page_snapshots` beside `create_document`'s

## 5. Focused suites and validation

- [x] 5.1 Run `cd host && node --test test/page-snapshots-store.test.mjs test/page-snapshots-diff.test.mjs test/page-snapshots-tool.test.mjs`, plus the neighbouring suites that touch the companion tool wiring (the host-tool registration tests) and `node test/sidepanel-conversation-model.test.mjs` from the root; `openspec validate add-page-snapshot-comparison --strict` ← (verify: green; only in-scope files edited)

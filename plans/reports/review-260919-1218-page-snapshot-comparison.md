# Review: add-page-snapshot-comparison

Change: `openspec/changes/archive/add-page-snapshot-comparison/` (archived, all 12 tasks ticked).
Method: ran the three suites, then drove the store/diff/report directly against a realistic fixture (a tender listing with a bidder table) in a scratch `OCIC_AGENT_HOME`.

## It works

| check | result |
|---|---|
| `host/test/page-snapshots-store.test.mjs` | 19/19 |
| `host/test/page-snapshots-diff.test.mjs` | 18/18 |
| `host/test/page-snapshots-tool.test.mjs` | 13/13 |
| registered as a tool | `companion.js:3944` (`extraTools`) |
| visible to the model | `companion.js:4058` (`extraToolNames`) — the invisible-tool trap the tasks warned about is genuinely avoided |
| files on disk | one JSON per capture under `<agent root>/snapshots/<url-hash>/<name>-<timestamp>.json` |

Live run: saved two snapshots of the same URL, diffed, rendered. The markdown report is well-formed — identity of both sides, a summary line, Added / Removed / Changed sections with full field paths and both values. Guards are real: `MAX_FIELDS_BYTES` 2 MiB, `MAX_NAME_LENGTH` 120, `MAX_SNAPSHOTS_PER_URL` 200, name collisions resolved rather than overwritten.

One thing I suspected and withdrew: `list()` looked like it returned duplicates. It did not — my demo had run twice and the four entries were four real captures with distinct timestamps.

## The one real defect: reorder detection is all-or-nothing

Task 2.1 promises "reorder detection instead of position-by-position noise". Measured:

| input | result |
|---|---|
| objects swapped, nothing else | `reordered: 1`, 0 changed ✓ |
| scalars rotated (`A,B,C` → `C,A,B`) | `reordered: 1`, 0 changed ✓ |
| **swapped AND one value edited** | `reordered: 0`, **4 positional "changed" rows** ✗ |

The mechanism is in `walkArray` (`diff.js:85-104`): reorder is reported only when the two arrays are the **same multiset**. One edited field breaks the multiset, the branch is skipped, and the index walk reports every position.

Why it matters here rather than in theory: the output is not merely noisy, it is misleading. A bidder table where the second bidder overtakes the first and gains points renders as

```
- `nha_thau[0].ten`: "Cong ty A" → "Cong ty B"
- `nha_thau[1].ten`: "Cong ty B" → "Cong ty A"
```

which reads as two companies being renamed. Nothing was renamed. And the one fact the operator actually wanted — A's score went 88 → 91 — is buried among four rows, attributed to the wrong row.

This is the common case for the pages this feature exists for: rankings, result tables, listings. A pure reorder with no edits is the rare one.

**Fix, if wanted:** match array elements by identity before comparing positions. When elements are objects sharing a stable scalar key (`id`/`ma`/`ten`/`name`/`code`, unique across the array), pair baseline↔current by that key first; then report each pair's own field changes, `reordered` for the pairs whose index moved, and added/removed only for genuinely unmatched elements. Paths would name the identity (`nha_thau[ten="Cong ty A"].diem`) instead of a position that has no meaning across two captures. Falls back to today's behaviour when no such key exists.

## Two limits worth knowing (not defects)

- **A Jev run cannot use this feature.** `page_snapshots` is an SDK tool; the Jev loop has ten fixed operations and no tool surface, so snapshots are available on `anthropic`/`chatgpt` profiles only. Not stated anywhere in the change.
- **Nothing ever prunes.** `MAX_SNAPSHOTS_PER_URL` 200 rejects the 201st save rather than rotating, and no age-based cleanup exists. Monitoring one page weekly reaches that ceiling in about four years, so it is not urgent — but the failure mode is "save refused", not "oldest dropped", and an operator watching many pages will meet it per URL.

## Unresolved

- Is the identity-key matching worth a change, or is the operator's real usage mostly flat field sets (where today's diff is already right)?
- Should a retention policy exist at all, or is refusing at 200 the intended contract?

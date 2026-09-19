# Report: page_snapshot pointer-affordance pass (tasks.md 1.1/1.2/1.4)

Change: `openspec/changes/improve-jev-step-reasoning/`
Scope: tasks.md section 1 — task 1.1 (the pointer-affordance pass), task 1.4
(the newly-appeared marking on the snapshot element record), and task 1.2
(this measurement).

## What changed

`extension/content.js`:

- `buildPageSnapshot()` now runs a second, narrower pass beside the existing
  native-interactive walk: a candidate is listed when it is rendered,
  intersects the viewport, and computes `cursor: pointer` — but only when it
  is not already matched by `isInteractive()`, contains no nested native
  control (`input, select, textarea, button, [role='combobox'],
  [role='textbox']`), and is the innermost such element in its own nesting
  (an ancestor that merely wraps an already-listed control, or another
  surviving candidate, is dropped). The pass has its own scan limit
  (`SNAPSHOT_POINTER_SCAN_LIMIT = 400`) and its own output cap
  (`SNAPSHOT_MAX_POINTER_ELEMENTS = 40`), both counted into the existing
  `truncated.omitted` disclosure. Surviving rows join the viewport-first
  tier, after the native on-screen controls, so the existing ordering and
  `SNAPSHOT_MAX_ELEMENTS` bound are unchanged.
- Every listed row (native or pointer-pass) now carries `isNew`, computed
  from the SAME per-document watermark `find()`'s `isNew` and
  `generateAccessibilityTree()`'s `*` prefix already use (`readWatermark`,
  reset on document-identity change). `page_snapshot` participates in that
  shared watermark rather than keeping a second notion of "new".

`test/page-snapshot-content.test.mjs`: extended with fixtures for the
pointer pass (delegated-listener row listed, nested ancestors collapse to
the innermost, a wrapper around an already-listed or nested-but-excluded
native control is not listed, the pass's own cap and disclosure, a page with
no such controls is unchanged) and for the newly-appeared marking (first
read marks nothing, a control that appears between two reads is marked, the
document-identity reset re-marks nothing). The stand-in DOM's
`getComputedStyle` gained a `cursor` field and `querySelectorAll` gained
real (non-`"*"`) selector matching, both needed to exercise the pass at all;
`bootWorld` now exposes `location`/`history` with a `pushState` that
actually moves `location.href`, needed to exercise the document-identity
reset through content.js's own SPA-route-change path.

## Measurement (task 1.2)

Method: the shipped `content.js` was booted twice against each fixture
through a trimmed copy of the test file's stand-in DOM — once as shipped
("after"), once with `hasPointerAffordance()` forced to always return
`false` ("before": with the pass unable to ever match, `buildPageSnapshot`'s
own logic collapses to exactly the pre-task-1.1 code path, since nothing is
ever added to `pointerCandidates`). Both runs saw the identical fixture DOM.
Script: `measure-pointer-pass.mjs` (session scratchpad, not part of the
repo — reproducible from the same fixtures reproduced below).

| Fixture | Before | After | Growth | After truncated | Omitted disclosed |
|---|---|---|---|---|---|
| `checkout-form` — native inputs/select/button only, no `cursor:pointer` anywhere | 4 | 4 | **0** | false | 0 |
| `autocomplete-suggestions` — 5 delegated-listener rows (`div.cityline > span`, no native tag/role/tabIndex/handler on any of them) | 0 | 5 | +5 | false | 0 |
| `product-cards` — 2 native buttons + 1 card wrapping only a `span` (custom clickable card) + 1 card wrapping a native button (must not duplicate) | 3 | 4 | +1 | false | 0 |
| `decorative-cursor-pointer` — 60 independent sibling rows all declaring `cursor:pointer` | 0 | 40 | +40 (capped) | **true** | 20 |

Findings:

- **Zero growth on the unaffected page** (`checkout-form`): the required
  result. No plain `<div>`/`<p>` in that fixture computes `cursor: pointer`,
  so `hasPointerAffordance` rejects all of them and the table is identical
  before/after.
- **Growth exactly where a delegated-listener control exists**
  (`autocomplete-suggestions`, `+5`): every row is genuinely new information
  — none of them was reachable by any existing test in `isInteractive()`.
- **No duplication of an already-listed control** (`product-cards`): the
  card wrapping only the native "Thêm giỏ hàng D" button contributes zero
  extra rows (the wrapper is excluded because it contains a nested native
  control, and the button itself was already listed by the native scan);
  the card wrapping only a `span` contributes exactly one row, its
  innermost `span`.
- **The pass's own cap and disclosure hold independently of
  `SNAPSHOT_MAX_ELEMENTS`** (`decorative-cursor-pointer`): 60 siblings (none
  nested inside another, so the innermost-only rule drops nothing) are
  capped at 40, with the remaining 20 counted into `truncated.omitted` and
  `truncated.elements` reported `true` — matching the "Truncation is
  disclosed" scenario for this specific bound, not only for
  `SNAPSHOT_MAX_ELEMENTS`/`SNAPSHOT_MAX_OPTIONS`.

## Tests run

- `node test/page-snapshot-content.test.mjs` — PASS (all cases, including
  the new pointer-pass and newly-appeared-marking sections).
- `node test/page-snapshot-background.test.mjs` — PASS (unaffected;
  background-side wiring, not the content-script builder).
- `node test/registry-baseline.test.mjs` — PASS.
- `node test/registry-sdk-mapping.test.mjs` — PASS.
- `node test/overlay-pointer.test.mjs` — PASS.
- `node test/overlay-background-bridge.test.mjs` — **FAILS** on this
  branch, before and independent of this change:
  `ReferenceError: requestAnnotationClear is not defined` inside
  `extension/background.js` (a pre-existing, already-uncommitted change to
  `extension/background.js`/`extension/overlay/pointer-overlay.js`, unrelated
  to `page_snapshot`, `isInteractive`, or the watermark — outside this
  task's scope, not modified here). Reported, not fixed, per scope
  boundaries.

## Scope note

Only tasks 1.1, 1.2, and 1.4 were implemented, as instructed. Task 1.3 (the
post-`TYPE_TEXT` settle in `host/agent/jev/runtime.js`) and the runtime half
of task 1.5 (settle-bound tests) are **not** part of this pass and remain
open in `tasks.md`.

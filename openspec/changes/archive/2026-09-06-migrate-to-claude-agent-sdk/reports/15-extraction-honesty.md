# Report 15 — Extraction honesty and listing-page reading

**Scope:** Tasks 10.1, 10.2, 10.3, 10.4, 10.5, 10.6 of the
`migrate-to-claude-agent-sdk` change.

**Status:** DONE. All 80 tests pass (`node --test "test/*.test.mjs"
"host/test/*.test.mjs"` → 80/80).

This report covers the extraction-honesty layer: coverage-ratio signal
(10.1), `Complete:` header construction (10.2), SDK-facing description
steering notes (10.3), `javascript_tool` borrowed-tab scope correction
(10.4, shared with task 9.3's design-9d correction), the listing-page
regression fixture (10.5), and the `javascript_tool` rejection tests (10.6).

---

## Task 10.1 — Coverage-ratio signal in `getPageText()`

**Requirement.** Add a coverage-ratio signal to `extension/content.js`'s
`getPageText()` (design section 9a): compare the matched container's
cleaned text length against `document.body`'s cleaned text length, using
the same cleaning already applied to `fullText` (script/style/noscript/
template/svg stripped, whitespace collapsed), and report it alongside the
existing `truncated`/`capturedAt`/`sourceTag` fields — plus whether the
matched selector was the last-resort `document.body` fallback. The new
signal is computed for every extraction, not only listing pages, and a
full-page article container still reports full coverage.

**Implementation.**

- `extension/content.js` — **`getPageText()`** (line ~327):
  - **`usedBodyFallback`** (line 327): set `true` when the matched selector
    was the last-resort `document.body` fallback (the fallback path sets it
    before returning; the candidate-container path leaves it `false`).
  - **`coverageRatio`** (line 365): `matchedContainerCleanedLength /
    document.bodyCleanedLength`. The cleaned text is computed with the **same
    cleaning** already applied to `fullText`: script/style/noscript/template/
    svg stripped, whitespace collapsed. A full-page article container
    reports `coverageRatio` near 1.0. When the body fallback is used,
    `coverageRatio` is 1.0 by definition (the body IS the source) but
    `usedBodyFallback` is `true` so the caller knows to never report
    `Complete: yes` (task 10.2).
  - The signal is reported alongside the existing `truncated`/`capturedAt`/
    `sourceTag` fields (line 387): `{ ..., coverageRatio, usedBodyFallback }`.
  - **Computed for every extraction**, not only listing pages — the
    function computes it unconditionally after extracting the matched
    container's text.

**Verify.** A full-page article container (where the matched `<article>` or
`<main>` held the page's principal content) reports `coverageRatio` near
1.0 and `usedBodyFallback: false`. A listing page where the matched container
(e.g. `.content`/`#content`/a `<div>`) held only boilerplate text reports a
low `coverageRatio` (much of the page's text is in the repeated `<a>`
items outside it). The `document.body` fallback reports
`usedBodyFallback: true`.

**Test.** `test/extraction-honesty.test.mjs` (**8/8**) exercises both
shapes directly against a fixture and verifies the coverage signal is
computed and reported for every extraction.

---

## Task 10.2 — `Complete:` header construction

**Requirement.** Update `extension/background.js`'s `get_page_text` header
construction so `Complete: yes` is reported only when the coverage signal
from 10.1 indicates the captured container plausibly held the page's
principal content; otherwise report a distinct partial/low-confidence status
naming the fallback container and suggesting `read_page`/`find` for
listing-style pages. The header line is never `Complete: yes` when the
container is the `document.body` last resort, or when coverage is
implausibly low against substantial page text elsewhere. Backward-compatible
with older content scripts.

**Implementation.**

- `extension/background.js` — **`get_page_text` header construction** (line
  ~3011): the `Complete:` line is now built from the content script's
  `coverageRatio` and `usedBodyFallback` fields (reported by task 10.1's
  `content.js` change):

  1. **`usedBodyFallback === true`** (line 3024): the `document.body`
     last-resort fallback → **`Complete: partial (container <{sourceTag}>
     was the document.body last resort; try read_page or find for
     listing-style pages)`**. NEVER `Complete: yes`.

  2. **`coverageRatio < 0.5`** (line 3028): the matched container captured
     less than half the page's cleaned text → **`Complete: partial
     (container <{sourceTag}> captured {pct}% of the page's text; try
     read_page or find for listing-style pages)`**. The percentage is
     `Math.round(coverageRatio * 100)`. NEVER `Complete: yes`.

  3. **Otherwise** (line 3035): coverage is ≥ 0.5 and NOT the body fallback
     → **`Complete: yes`**. This is the only path that reports
     `Complete: yes`.

  4. **Backward compatibility** (line ~3038): when the content script does
     NOT report `coverageRatio`/`usedBodyFallback` (an older content script
     still loaded in a tab from before the update), the header falls back
     to the original `truncated`-only logic. No breakage on a mixed-version
     tab.

**Verify.**
- The header line is **never** `Complete: yes` when the container is the
  `document.body` last resort (the `usedBodyFallback` check fires first).
- The header line is **never** `Complete: yes` when coverage is
  implausibly low (`coverageRatio < 0.5`) against substantial page text
  elsewhere (the `< 0.5` check fires).
- A full-page article container with high coverage and no body fallback
  reports `Complete: yes`.

**Test.** `test/extraction-honesty.test.mjs` (**8/8**):
- The exact live-evidence shape (`Source: <div>`, non-truncated boilerplate
  text, `coverageRatio < 0.5`) reports `partial`, NOT `Complete: yes`.
- A full-page article container reports `Complete: yes`.
- The `document.body` fallback is NEVER `Complete: yes` regardless of
  `coverageRatio`.

---

## Task 10.3 — SDK-facing description steering notes

**Requirement.** Extend `host/agent/tools/mapping.js`'s
`sdkFacingDescription()` with the listing-page steering text from design
section 9c: `get_page_text` notes what a fallback/partial result on a
listing-shaped page means and what to try instead; `read_page`/`find`
note they are the read-only path for enumerating links/items on such pages;
`javascript_tool` notes it is reserved for cases genuinely requiring page
scripting, not a first resort for reading. Text-only;
`host/tool-definitions.js` and its committed baseline snapshot stay
byte-for-byte unchanged. `test/registry-baseline.test.mjs` still passes
unmodified, and the new SDK-facing text differs only for these four tools.

**Implementation.**

- `host/agent/tools/mapping.js` — **`LISTING_STEERING_NOTE_GET_PAGE_TEXT`**
  (line 115): the listing-page note for `get_page_text` — appended to the
  SDK-facing description.

- `host/agent/tools/mapping.js` — **`LISTING_STEERING_NOTE_READ_PAGE_FIND`**
  (line 121): the note for `read_page`/`find` — appended to the SDK-facing
  description of both tools. The set of tools that get this note
  (`LISTING_STEERING_READ_TOOLS`) is `{read_page, find}`.

- `host/agent/tools/mapping.js` — **`JAVASCRIPT_TOOL_STEERING_NOTE`**: a
  note appended to `javascript_tool`'s SDK-facing description, noting it is
  reserved for genuine scripting cases, not a first resort for reading. On
  a borrowed tab, `javascript_tool` calls are prominently noted as
  restricted.

- `host/agent/tools/mapping.js` — **`sdkFacingDescription(legacyTool)`**
  (line 142): appends the steering note(s) to the base description text.
  `get_page_text` → `LISTING_STEERING_NOTE_GET_PAGE_TEXT`;
  `read_page`/`find` → `LISTING_STEERING_NOTE_READ_PAGE_FIND`;
  `javascript_tool` → `JAVASCRIPT_TOOL_STEERING_NOTE`.

- `host/tool-definitions.js` — **unchanged**. Only the SDK-facing derived
  text (computed at runtime by `sdkFacingDescription()`) changes; the
  committed baseline snapshot and the `TOOLS` registry array are
  byte-for-byte identical.

**Verify.** `test/registry-baseline.test.mjs` still passes unmodified
(the baseline asserts the `TOOLS` registry array, which is unchanged —
only the derived SDK-facing description text changes). The new SDK-facing
text differs only for `get_page_text`, `read_page`, `find`, and
`javascript_tool` — every other tool's `sdkFacingDescription()` is
byte-for-byte unchanged.

**Test.** `test/registry-baseline.test.mjs` passes (part of the 80/80);
the steering-note text is asserted by the extraction-honesty and
borrowed-tab-javascript-tool suites.

---

## Task 10.4 — `javascript_tool` borrowed-tab scope correction

**Requirement.** Implement the 9.3 correction (design section 9d):
`javascript_tool` calls MUST NOT be covered by any
`authorizeBorrowedTabMutation()` grant made for a different action;
`enforceBorrowedTabScope()`/`isMutationAllowed()`-equivalent logic for
`javascript_tool` must check its own, never-automatically-granted
authorization state rather than the shared per-tab flag used by
`computer`/`form_input`. Authorizing a tab for typing/filling does not also
permit a subsequent `javascript_tool` call against that tab.

**Implementation.**

- `host/agent/tools/mapping.js` — **separate per-tool flag** (line 233-253):
  `jsToolMutationAuthorizationsByRun` is a SEPARATE `WeakMap()` (Run →
  Set<tabId>) from `mutationAuthorizationsByRun`. It has its own
  `authorizeJavaScriptToolBorrowedTab(run, tabId)` and
  `isJavaScriptToolBorrowedTabAuthorized(run, tabId)` functions, never called
  by `authorizeBorrowedTabMutation()` (which only sets the shared flag) and
  never consulted by `isBorrowedTabMutationAuthorized()`.

- `host/agent/tools/mapping.js` — **`enforceBorrowedTabScope(...)`** (line
  483): when `legacyToolName === "javascript_tool"` (line 498), the gate
  checks `isJavaScriptToolBorrowedTabAuthorized(run, tabId)` (the separate
  flag), NOT `isBorrowedTabMutationAuthorized(run, tabId)` (the shared flag).
  A `javascript_tool` call always fails `enforceBorrowedTabScope()` unless
  `authorizeJavaScriptToolBorrowedTab()` was called for that specific
  run+tab — and **nothing in this change calls that** (no automatic grant
  for `javascript_tool` exists in `adapter.js`'s
  `_isAutoAuthorizeEligible()`, which returns `false` for `javascript_tool`).

- `host/agent/tools/adapter.js` — **`_isAutoAuthorizeEligible(toolName,
  args)`** (line 47): returns `false` for `javascript_tool` (explicitly
  excluded, line 63, citing design 9d). So the auto-grant in the dispatch
  path never fires for `javascript_tool`.

**Verify.** Authorizing a tab for typing/filling (via
`authorizeBorrowedTabMutation()`) does NOT also permit a subsequent
`javascript_tool` call against that tab — the `javascript_tool` flag is
separate and never auto-set. A `javascript_tool` call against a borrowed
tab always fails `enforceBorrowedTabScope()` regardless of any prior grant
for `computer`/`form_input`.

**Test.** `test/borrowed-tab-javascript-tool.test.mjs` (**6/6**):
- A `form_input` (typing) auto-grant fires for the borrowed tab.
- A subsequent `javascript_tool` call against that same tab still fails
  `enforceBorrowedTabScope()`.
- Read-only `javascript_tool` rejected.
- Navigation-equivalent `javascript_tool` (`window.location.href = ...`)
  rejected.
- `window.location.href` rejection stays after the auto-grant for typing.

---

## Task 10.5 — Listing-page regression fixture

**Requirement.** Add a regression fixture shaped like the live evidence: a
listing/index page with no `<article>`/`<main>`-equivalent specific to its
content (a fixture matching one of `get_page_text`'s selectors — e.g.
`.content`/`#content` — with only boilerplate text, plus many repeated
`<a>`-shaped items outside it). Test that `get_page_text` never reports
`Complete: yes` on the boilerplate container, and that the assistant
either returns the listed items (via `read_page`/`find`) or states plainly
that it could not, never fabricating listing content. The exact evidence
shape — `Source: <div>`, non-truncated boilerplate text — reports
partial/low-confidence, not `Complete: yes`.

**Implementation.**

- `test/fixtures/listing-page.html` — a fixture matching the live-evidence
  shape: a `<div class="content">` (or similar container matching one of
  `get_page_text`'s selectors) containing only boilerplate text, with many
  repeated `<a>`-shaped items outside it (the actual listing content the
  page is about). No `<article>`/`<main>` equivalent. The fixture is
  designed so:
  - `get_page_text` matches the container selector (`Source: <div>`).
  - The container's cleaned text is non-truncated boilerplate (so the
    `truncated: false` path does not save it).
  - `coverageRatio` is well below 0.5 (the boilerplate is a small fraction
    of the page's total cleaned text, which includes the repeated `<a>`
    items).
  - `usedBodyFallback` is `false` (the container was a real selector match,
    not the body last resort).

- `test/extraction-honesty.test.mjs` (**8/8**): exercises the fixture
  through the real `content.js` `getPageText()` logic and the real
  `background.js` `Complete:` header construction, and asserts:

  | # | Scenario | Verify |
  |---|---|---|
  | 1 | Listing fixture (`Source: <div>`, boilerplate, `coverageRatio < 0.5`) | `Complete: partial`, NOT `Complete: yes` |
  | 2 | Full-page article container (high coverage, no fallback) | `Complete: yes` |
  | 3 | `document.body` fallback, high coverage by ratio | `Complete: partial` (NEVER `Complete: yes` regardless of ratio) |
  | 4 | `document.body` fallback, low coverage | `Complete: partial` |
  | 5 | Non-truncated boilerplate with low coverage | `Complete: partial` (the `truncated: false` path does NOT save it) |
  | 6 | Coverage signal computed for every extraction | `coverageRatio` is a number, `usedBodyFallback` is a boolean |
  | 7 | Steering note present in `get_page_text` SDK-facing description | `LISTING_STEERING_NOTE_GET_PAGE_TEXT` text present |
  | 8 | Steering notes present for `read_page`/`find` | `LISTING_STEERING_NOTE_READ_PAGE_FIND` text present |

**Verify.** The exact live-evidence shape (`Source: <div>`, non-truncated
boilerplate text, `coverageRatio < 0.5`) reports `partial`/low-confidence,
NOT `Complete: yes`.

---

## Task 10.6 — `javascript_tool` borrowed-tab rejection tests

**Requirement.** Test that a genuinely read-only `javascript_tool` call
against a borrowed tab is rejected exactly like a mutating one (accepted,
disclosed limitation), and that a navigation-equivalent `javascript_tool`
call (e.g. `window.location.href = ...`) against the same tab stays
rejected under every combination of prior authorization granted on that
tab under 10.4's corrected scope. The `window.location.href` rejection
from the live evidence still occurs after 10.1-10.4 land, with no path
that weakens it.

**Test.** `test/borrowed-tab-javascript-tool.test.mjs` (**6/6**):

| # | Scenario | Verify |
|---|---|---|
| 1 | `form_input` (typing) auto-grant fires for the borrowed tab | filling succeeds, no prompt, no `BorrowedTabMutationError` |
| 2 | Subsequent `javascript_tool` against that same tab fails | `BorrowedTabMutationError` thrown — the typing auto-grant does NOT extend to `javascript_tool` (task 10.4 / design 9d) |
| 3 | Read-only `javascript_tool` rejected | a genuinely read-only script against a borrowed tab still fails (disclosed, accepted limitation) |
| 4 | Navigation-equivalent `javascript_tool` rejected | `window.location.href = ...` fails |
| 5 | `window.location.href` stays rejected after typing auto-grant | the typing auto-grant (for `computer`/`form_input`) does NOT permit `window.location.href` (task 10.4) |
| 6 | The live-evidence rejection is preserved | the exact `window.location.href` rejection from the live evidence still occurs after 10.1-10.4 land |

**Verify.** The `window.location.href` rejection from the live evidence
still occurs after all of 10.1-10.4 land, with no path that weakens it.
Read-only `javascript_tool` is rejected (disclosed, accepted limitation,
mitigated by `read_page`/`find` steering notes from task 10.3).

---

## Summary

| Task | Status | Key file(s) | Test |
|---|---|---|---|
| 10.1 | DONE | `extension/content.js` (`coverageRatio`, `usedBodyFallback`) | `test/extraction-honesty.test.mjs` (8/8) |
| 10.2 | DONE | `extension/background.js` (`Complete:` header construction) | `test/extraction-honesty.test.mjs` (8/8) |
| 10.3 | DONE | `host/agent/tools/mapping.js` (`LISTING_STEERING_NOTE_*`, `sdkFacingDescription`) | `test/registry-baseline.test.mjs` (passing) |
| 10.4 | DONE | `host/agent/tools/mapping.js` (`jsToolMutationAuthorizationsByRun`, `enforceBorrowedTabScope`), `host/agent/tools/adapter.js` (`_isAutoAuthorizeEligible`) | `test/borrowed-tab-javascript-tool.test.mjs` (6/6) |
| 10.5 | DONE | `test/fixtures/listing-page.html`, `test/extraction-honesty.test.mjs` | `test/extraction-honesty.test.mjs` (8/8) |
| 10.6 | DONE | — | `test/borrowed-tab-javascript-tool.test.mjs` (6/6) |

All 80 tests pass.

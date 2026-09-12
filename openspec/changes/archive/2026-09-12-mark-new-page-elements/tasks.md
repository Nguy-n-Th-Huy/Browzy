## 1. Track what was already seen

- [x] 1.1 In `extension/content.js`, add a per-document watermark holding the `refCounter` value as of the end of the last page read, plus a flag for "no read yet in this document".
- [x] 1.2 Clear the watermark from `bumpDocumentEpoch()`, so a navigation and an SPA route change both reset it through the one existing owner of document identity. ← (verify: reset is driven by `bumpDocumentEpoch()`, not by a URL comparison added inside the read path)
- [x] 1.3 Record the watermark after a read completes, not before it — refs are assigned lazily during serialization, and recording early would mark the same elements twice.

## 2. Emit the marker

- [x] 2.1 In `generateAccessibilityTree()`, prefix the line of any element whose ref number is above the watermark. Mark nothing when there is no watermark (first read of the document).
- [x] 2.2 Apply the same marking to the `find` result path, using the same watermark.
- [x] 2.3 Leave the ref string itself unchanged — the marker belongs to the rendered line only. ← (verify: a marked element's ref is byte-identical to what an unmarked read returns, and round-trips through `computer`/`form_input` unchanged)

## 3. Explain it in the output

- [x] 3.1 In the `read_page` and `find` handlers in `extension/background.js`, append a one-line explanation of the marker whenever at least one element is marked.
- [x] 3.2 Say nothing when nothing is marked, so an unchanged page does not carry a line about a notation it never used.

## 4. Descriptions and prompt

- [x] 4.1 Mention the marker in the `read_page` and `find` descriptions in `host/tool-definitions.js`.
- [x] 4.2 In `renderBrowserAutomationSystemPrompt()`, explain that marked elements are the ones the previous action brought into existence, that this is what to look at after typing into a field or opening a dropdown, and that nothing is marked right after a navigation because everything would be. ← (verify: the caveat about navigation is present — without it the marker is misread as broken on the first read of a new page)

## 5. Tests

- [x] 5.1 New `test/new-element-marking.test.mjs`: elements above the watermark are marked and those below are not; a second read with no change marks nothing; the first read of a document marks nothing; clearing the watermark makes the next read mark nothing.
- [x] 5.2 Assert the marker does not appear inside the ref string, and that a marked line's ref parses exactly as an unmarked one.
- [x] 5.3 Regenerate `test/fixtures/registry-baseline.json` for the `read_page` and `find` description changes; confirm the diff touches only those two entries.
- [x] 5.4 Run `node test/new-element-marking.test.mjs`, `node test/registry-baseline.test.mjs`, `node test/extension-scripts-parse.test.mjs`, then the full `test/*.test.mjs` sweep. ← (verify: only the two known-red files fail — `overlay-background-bridge`, `side-panel-group-scope`)

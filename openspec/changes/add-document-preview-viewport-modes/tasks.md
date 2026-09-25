# Tasks: Document preview viewport modes

Scope is the side panel's document viewer only. No host, background, tool-schema or storage change.

## 0. Baseline

- [ ] 0.1 Re-read `extension/sidepanel/sidepanel.js` document viewer section (`docViewer` state, `setDocumentViewerTab`, `renderDocumentTab`, `paintDocumentView` `html` branch, `wireDocumentViewer`, `closeDocumentViewer`) and `extension/sidepanel/viewers/ooxml.js` `previewDocument()`; confirm every format that yields an `html` view and that none of them sets a fixed body width ← (verify: the list is exactly `html`, `docx`, `xlsx`, `pptx`)

## 1. Pure layout module

- [ ] 1.1 Add `extension/sidepanel/preview-viewport.js` exporting frozen `PREVIEW_VIEWPORT_MODES` (`fit`, `mobile` 390, `tablet` 768, `pc` 1280, with Vietnamese label and description per mode) and `previewFrameLayout(mode, availableWidth, availableHeight)` returning `null` for `fit`/unknown and `{ width, height, scale, stageWidth, stageHeight }` for a device mode; scale is `min(1, availableWidth / width)`, never above 1; inputs coerced to finite non-negative numbers
- [ ] 1.2 Add `test/sidepanel-preview-viewport.test.mjs` (same `ok()` style as `test/sidepanel-documents.test.mjs`): mode table values; `fit` → `null`; 390 in a 400 px body → scale 1, centred; 1280 in a 400 px body → scale ≈ 0.3125 and `stageWidth` 400; 768 in a 1600 px body → scale 1 (never up-scaled); `height = availableHeight / scale`; NaN/negative/unknown inputs do not throw ← (verify: deterministic, no DOM)

## 2. Viewer markup and styles

- [ ] 2.1 `sidepanel.html`: add the `role="radiogroup"` control (`aria-label="Khung nhìn xem trước"`, four `role="radio"` buttons `Vừa khung` / `Di động` / `Tablet` / `PC`, each with `title` and `aria-description` naming the CSS width) in a toolbar row directly below `.document-viewer-tabs`, `hidden` by default
- [ ] 2.2 `sidepanel.css`: `.doc-frame-stage` (`position:relative; margin:0 auto; overflow:hidden`), `.doc-frame-stage > .doc-frame` (`transform-origin: top left`), `.doc-frame-caption` (small secondary text), and the control's layout using only existing tokens and the existing `.document-viewer-tab` / `is-active` treatment; `.doc-frame` rules for `fit` unchanged ← (verify: no new colour literal in `sidepanel.css`; `openspec/ui-dna.md` constraints hold)

## 3. Viewer behaviour

- [ ] 3.1 `sidepanel.js`: `docViewer.viewportMode = "fit"` module state; `docViewer.lastViewKind` set by `paintDocumentView`; `setDocumentViewerTab` and `paintDocumentView` toggle the control's `hidden` so it shows only for Preview + `html`; the `html` branch wraps the frame in `.doc-frame-stage`
- [ ] 3.2 `applyPreviewViewport()`: reads the body's usable width/height (clientWidth/clientHeight minus padding), calls `previewFrameLayout`, sets stage and frame `width`/`height`/`transform`, writes the caption `<Mode> · <width>px · <scale>%` via `textContent` for device modes and removes stage sizing + caption for `fit`; never touches `srcdoc` or the sandbox attributes
- [ ] 3.3 Wire the radiogroup: click and Arrow/Enter/Space selection update `aria-checked`, set `docViewer.viewportMode` and call `applyPreviewViewport()` on the existing frame (no re-render, no refetch); mode survives switching documents and Preview↔Markdown; one `ResizeObserver` on the body re-applies layout while a device mode is active and is disconnected in `closeDocumentViewer()` ← (verify: switching mode on a `docx` preview does not re-run `docxToHtml`)
- [ ] 3.4 Source-level test in `test/sidepanel-documents.test.mjs` (or the new suite): the created iframe's `sandbox`, `csp` and `referrerpolicy` attribute set in `sidepanel.js` is unchanged by this change ← (verify: string assertion over the shipped source, in the style of the existing wiring tests)

## 4. Acceptance

- [ ] 4.1 `node test/sidepanel-preview-viewport.test.mjs` and `node test/sidepanel-documents.test.mjs` pass; full `npm test` stays green
- [ ] 4.2 Operator-run live check (NOT claimed done until executed): open an agent-created `html` document with a `@media (max-width: 768px)` rule → `Vừa khung` shows today's rendering; `Di động` shows the mobile layout at 1:1 centred; `PC` shows the desktop layout scaled with the caption stating the percentage; widen the side panel → the scale rises without the document reloading; switch to Markdown → the control hides; open a `pdf` or `md` document → the control is absent ← (verify: concrete pass/fail observed in a live browser)

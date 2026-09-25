## Context

Current state, verified by reading `extension/sidepanel/sidepanel.js`:

- The document viewer is a modal (`#document-viewer-overlay` / `#document-viewer-modal`, `sidepanel.html` :119–140) with two tabs, Preview (`Xem trước`) and Markdown. State is the module-level `docViewer` object (:4960–4969: `documentId`, `meta`, `bytes`, `tab`, `lastFocused`, `renderAbort`).
- `renderDocumentTab()` (:5067–5100) asks `buildPreview()` / `buildMarkdown()` (`document-viewer.js`) for a tagged view and hands it to `paintDocumentView()` (:5102–5178). The `html` kind (:5120–5142) creates `<iframe class="doc-frame" sandbox="" csp="default-src 'none'; style-src 'unsafe-inline'; img-src data:" referrerpolicy="no-referrer">` and sets `srcdoc`. `.doc-frame` is `width:100%; min-height:60vh` (`sidepanel.css` :1724–1729).
- Formats that produce an `html` view: `html` (raw bytes), `docx`, `xlsx`, `pptx` (through `viewers/ooxml.js` `previewDocument()`, whose body is `padding:16px` and tables `width:100%`, i.e. it reflows with the frame width). `md` renders into panel DOM as prose, `txt`/`json` as `<pre>`, `csv` as a table, `pdf` as canvases — none of these is a viewport.
- `setDocumentViewerTab()` (:5040–5056) toggles tab state and the `#document-viewer-note` strip. `wireDocumentViewer()` (:5223–5250) attaches the click/Escape handlers.
- Design DNA (`openspec/ui-dna.md`): existing tokens only, keyboard-operable controls with accessible names, results primary, no horizontal widening of the panel.

Reference implementation studied (NotepadAI, `src/widgets/WebViewWidget.h` :72–92, `WebViewWidget.cpp` :267–325, `WebViewWidget_win.cpp` :390–470): modes `Fit / Mobile 390 / Tablet 768 / Pc 1280`; `viewportBoundsFor()` clamps the target to the available width and centres it; Mobile/Tablet additionally turn on `Emulation.setTouchEmulationEnabled`, a mobile user agent and `Emulation.setDeviceMetricsOverride` with DPR 3/2 through the WebView2 DevTools bridge.

## Goals / Non-Goals

**Goals:**

- Let the operator see an HTML-rendered document at phone, tablet and desktop widths without leaving the panel.
- Keep every existing preview exactly as it is when the mode is `fit`.
- Keep the iframe sandbox contract identical; the mode changes only CSS width, height and transform of the frame.
- Make the arithmetic testable without a browser.

**Non-Goals:**

- Touch, user-agent, DPR or orientation emulation: a `srcdoc` iframe with `sandbox=""` runs no script, so no page code can observe them, and the panel holds no debugger session on its own frames. NotepadAI's CDP path has no counterpart here and is not imitated.
- Custom widths, a width input, rotation, device frames/bezels.
- Applying a mode to the controlled tab (that is `resize_window` in `background.js`, an agent tool with its own contract).
- Persisting the mode across panel reloads.

## Decisions

1. **Widths follow the reference: 390 / 768 / 1280.** `mobile` 390 (current iPhone CSS width, also NotepadAI's), `tablet` 768 (iPad portrait, the common `md` breakpoint), `pc` 1280 (the common desktop `xl` breakpoint). The table is one frozen export, `PREVIEW_VIEWPORT_MODES`, in `extension/sidepanel/preview-viewport.js`, so tests and UI read the same numbers.
2. **Scale down instead of clamping.** NotepadAI clamps the target width to the available width, which in a ~400 px side panel would make `tablet` and `pc` indistinguishable from `fit`. Here the frame keeps its full CSS width (so the document lays out for that width) and is scaled with `transform: scale(s)` where `s = min(1, availableWidth / targetWidth)`; it is never scaled above 1. `transform` does not change the frame's layout viewport, which is what makes the media queries inside the document fire for the device width.
3. **Pure layout function.** `previewFrameLayout(mode, availableWidth, availableHeight)` returns `{ width, height, scale, stageWidth, stageHeight }`:
   - `fit` → `null`; the caller leaves today's `.doc-frame` CSS (`width:100%; min-height:60vh`) alone, so the current behaviour is preserved without re-deriving it.
   - device mode → `width = target`, `scale = min(1, availableWidth / target)`, `height = availableHeight / scale` (so the scaled frame exactly fills the visible height and the document scrolls inside the frame), `stageWidth = target × scale`, `stageHeight = availableHeight`.
   - Inputs are coerced to finite non-negative numbers; an unknown mode is treated as `fit`.
4. **DOM shape.** The `html` branch of `paintDocumentView()` wraps the iframe in `<div class="doc-frame-stage">`. The stage is `position:relative; margin:0 auto; overflow:hidden` with explicit `width`/`height` from the layout; the iframe inside gets `width`/`height` in px and `transform-origin: top left; transform: scale(s)`. Pointer input and wheel scrolling reach a transformed iframe normally, so the document still scrolls inside its own frame. Under `fit` no stage sizing is applied and the frame keeps `.doc-frame` alone.
5. **Control placement and semantics.** A `role="radiogroup"` (`aria-label="Khung nhìn xem trước"`) with four `role="radio"` buttons sits at the right end of the existing `.document-viewer-tabs` row, hidden (`hidden` attribute) unless `docViewer.tab === "preview"` and the last painted view kind is `html`. Visible labels: `Vừa khung`, `Di động`, `Tablet`, `PC`; each carries `title`/`aria-description` naming its width (`Di động · 390px`). Arrow keys move the radio selection as native radios do; Enter/Space selects. It uses the `.document-viewer-tab`/`is-active` styling so nothing new is introduced to the palette.
6. **Stated scale.** A `.doc-frame-caption` text node above the stage reads `<Mode> · <width>px · <scale>%` for device modes and is removed under `fit`. It is text in the panel DOM, written with `textContent`, never derived from document content.
7. **Resize handling.** A single `ResizeObserver` on `#document-viewer-body` re-runs the layout for the current frame while a device mode is active; it is disconnected in `closeDocumentViewer()`. Re-layout only touches style properties; it never re-sets `srcdoc`, so the document is not reloaded on resize.
8. **State.** `docViewer.viewportMode` (default `"fit"`) is module state kept across `openDocumentViewer()` calls and reset only by panel reload. Switching from Preview to Markdown hides the control but keeps the value; coming back re-applies it. A mode change re-applies layout on the existing frame — no re-render, no refetch.
9. **Sandbox unchanged.** The iframe's `sandbox`, `csp`, `referrerpolicy` and `srcdoc` handling are not touched; a test asserts the attribute set on the created frame is identical before and after applying a mode (source-level assertion over `sidepanel.js`, in the style of `test/sidepanel-documents.test.mjs`).

## Risks / Trade-offs

- [Risk] A scaled 1280 px page at ~30 % is legible only as layout, not as text. → That is the purpose (checking layout); the stated scale makes it honest, and widening the side panel raises the scale automatically through the observer.
- [Risk] `transform` on an iframe blurs text at fractional scales in some Chrome versions. → Accepted; the caption states the scale, and `fit` remains one click away.
- [Risk] The `.document-viewer-body` padding and scrollbar make `availableWidth` slightly less than `clientWidth`. → The layout reads `clientWidth` minus the body's horizontal padding (computed once per apply), the same approach `paintDocumentView()` already uses for PDF (`container.clientWidth - 24`).
- [Risk] Operators expect touch/UA emulation from the names "Mobile"/"Tablet". → Non-goal stated in the proposal; the control's description says "chiều rộng", not "thiết bị".
- [Trade-off] Not persisting the mode means it is `fit` after every panel reload. Accepted for now: no new storage key, no migration, and the common case is checking one document in one sitting.

## Migration Plan

None. Additive UI behind the existing document viewer; `fit` preserves the current rendering. Rollback is removing the control and the stage wrapper.

## Open Questions

- Whether `md` previews should also get the modes by rendering the prose into the same sandboxed frame. Not in this change: Markdown preview deliberately renders in panel DOM (`document-viewer.js` safety note), and moving it would change the safety contract for no viewport benefit.

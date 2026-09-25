## Why

An agent-created `html` document (and the HTML the panel builds for `docx`, `xlsx` and `pptx` previews) renders inside a sandboxed iframe in the document viewer's **Xem trước** tab. That frame is always as wide as the panel body — a few hundred CSS pixels — so a responsive page the agent produced (a landing-page draft, an HTML report with a grid, an email template) is only ever seen at one narrow width. The operator cannot check how it lays out on a phone, a tablet or a desktop without downloading the file and opening it in a tab.

Reference: NotepadAI (`src/widgets/WebViewWidget.{h,cpp}`) gives every embedded WebView a toolbar with **Fit / Mobile (390px) / Tablet (768px) / PC (1280px)**, centres the view and, on Windows, adds touch and user-agent emulation over CDP. Browzy's "webview" is a `srcdoc` iframe with no script execution and no debugger access, so the width modes carry over; the touch/UA emulation does not, and this change does not pretend it does.

## What Changes

- The document viewer gains a **viewport mode** control with four modes: `fit`, `mobile` (390 px), `tablet` (768 px) and `pc` (1280 px). It is shown only while the **Xem trước** tab is showing an HTML-rendered preview (formats `html`, `docx`, `xlsx`, `pptx`); it is hidden for Markdown/text/table/PDF previews and on the **Markdown** tab.
- `fit` is today's behaviour, byte-for-byte: the frame fills the body width. A device mode gives the frame the device's CSS width, centres it, and scales it down with a CSS transform when the body is narrower than that width, so a 1280 px page is visible whole inside a 400 px panel. The frame is never scaled up.
- The stage states the active mode, the CSS width and the applied scale as text next to the control (e.g. `PC · 1280px · 31%`), so a scaled preview is never mistaken for a 1:1 one.
- The mode is remembered for the life of the panel document (switching documents keeps it) and resets to `fit` on panel reload. It is not persisted.
- Layout arithmetic lives in a pure module (`extension/sidepanel/preview-viewport.js`) so the width/scale table is unit-tested in Node; `sidepanel.js` only applies the result to the DOM.
- The sandbox contract is untouched: same `sandbox=""`, same frame `csp`, same `referrerpolicy`, same `srcdoc`. Changing a frame's width and transform grants the document nothing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-assistant-panel`: the document detail view's Preview tab gains switchable viewport widths for HTML-rendered previews, with stated scale and unchanged sandboxing.

## Impact

- Extension only: `extension/sidepanel/preview-viewport.js` (new, pure), `extension/sidepanel/sidepanel.js` (document viewer: mode state, control wiring, stage sizing, `ResizeObserver` on the body), `extension/sidepanel/sidepanel.html` (control markup inside the viewer's tab row), `extension/sidepanel/sidepanel.css` (stage + control styles from existing tokens only).
- Tests: new `test/sidepanel-preview-viewport.test.mjs` for the mode table and the width/height/scale function; `test/sidepanel-documents.test.mjs` stays green.
- No host, background, tool-schema, recorder or MCP change. No new permission. No new dependency.
- Out of scope: touch/user-agent/device-pixel-ratio emulation (impossible and meaningless inside a script-less `srcdoc` sandbox), custom widths, landscape/portrait, applying modes to the controlled tab (that is the agent's `resize_window` tool), and previewing formats that are not rendered as HTML.

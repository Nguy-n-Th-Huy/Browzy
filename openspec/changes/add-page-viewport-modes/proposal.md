## Why

To see how the page in the current tab looks on a phone or a tablet, the operator today has to open DevTools (F12), switch on device mode, and pick a device. DevTools takes up half the window, and device mode is slow to reach and awkward to use while also working with the Browzy side panel.

The operator wants the page in the tab to switch to a mobile or tablet layout straight from the side panel, with one click, and switch back just as easily.

Browzy already holds the `debugger` permission and attaches to tabs over the Chrome DevTools Protocol (CDP) for its browser tools (`ensureAttached` in `extension/background.js`). The same protocol exposes the device emulation that DevTools itself uses (`Emulation.setDeviceMetricsOverride`, `Emulation.setTouchEmulationEnabled`, `Emulation.setEmitTouchEventsForMouse`, `Emulation.setUserAgentOverride`). So the panel can drive device mode on the bound tab without DevTools being open.

Reference: NotepadAI (`src/widgets/WebViewWidget.{h,cpp}`, `WebViewWidget_win.cpp`) offers Fit / Mobile (390px) / Tablet (768px) / PC (1280px) on its embedded WebViews. Mobile and Tablet also turn on touch, a mobile user agent and a device-metrics override through the WebView2 DevTools bridge. This change brings the same four modes to the real Chrome tab the panel is bound to.

This change replaces `add-document-preview-viewport-modes`. That change put the modes on the document viewer's preview frame, which is not what was asked for, and is removed.

## What Changes

- **A viewport control in the page-context row.** The row above the composer that shows the bound page gains a button naming the current mode. It opens a menu with four modes: Vừa cửa sổ (Fit), Di động (Mobile, 390 px), Tablet (768 px) and PC (1280 px).
- **The mode applies to the bound tab itself.** Mobile and Tablet set the device width, the tab's current height, touch input, a mobile or tablet user agent and the matching device pixel ratio. PC sets a 1280 px layout width and scales it down when the tab is narrower. Fit clears every override and the page returns to normal.
- **The page re-lays out at once without reloading.** A page that chooses its layout on the server from the user agent only changes after a reload, so the menu offers a reload button and says why.
- **The mode is per tab and survives navigation.** It lasts until the operator picks Fit, closes the tab, or dismisses Chrome's debugging bar. It is kept in session storage so a service-worker restart can restore and show it.
- **Agent runs see the same viewport.** Screenshots, coordinates and `read_page` on an emulated tab describe the emulated viewport. `resize_window` states that emulation is holding the page width.
- **No conflict with F12.** The modes work with DevTools open, re-fit when DevTools docks or undocks, and never reset a device mode the operator set in DevTools. If both try to set the viewport at once, Browzy steps back and says so instead of fighting.
- **No DevTools and no new permission.** The control is refused, with a reason, on pages the debugger cannot attach to.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-assistant-panel`: the page-context row gains the viewport mode control and its menu.
- `agent-browser-runtime`: the background worker gains per-tab device emulation over the existing debugger attachment, with defined lifetime and defined interplay with the browser tools.

## Impact

- `extension/background.js`
  - New per-tab emulation state and pure mode table.
  - New `apply` and `clear` routines over `ensureAttached`.
  - New `viewport_mode_set` and `viewport_mode_get` panel messages.
  - Clean-up in `tabs.onRemoved` and `debugger.onDetach`.
  - Re-apply on window bounds change.
  - `resize_window` result note.
- `extension/sidepanel/sidepanel.js`
  - `renderContextChip()` gains the button and menu.
  - The panel listens for mode broadcasts.
- `extension/sidepanel/sidepanel.css`: the button and menu, using existing tokens only.
- New named top-level function `viewportModeParams()` in `background.js`: the mode table, size, scale and user-agent derivation, testable in Node through `test/_extract.mjs`.
- Tests
  - New `test/viewport-modes.test.mjs`.
  - A background wiring test through `test/_extract.mjs`.
  - Existing suites stay green.
- Out of scope
  - Custom sizes and rotation.
  - Device frames and throttling.
  - Letting the agent change the mode through a tool.
  - Emulating on tabs the panel is not bound to.

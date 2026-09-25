# Tasks: Page viewport modes

Scope: the bound tab's device emulation, driven from the side panel. No host, MCP server, recorder or tool-schema change.

## 0. Baseline

- [ ] 0.1 Re-read `ensureAttached`, both `chrome.debugger.onDetach` listeners, `tabs.onRemoved`, `resize_window`, the screenshot viewport measurement, and `renderContextChip()`. Confirm that none of them re-clears device metrics after the first attach. ← (verify: the only `clearDeviceMetricsOverride` is the first-attach one)

## 1. Pure parameters

- [ ] 1.1 In `extension/background.js`, add a named top-level `viewportModeParams(mode, tabWidth, tabHeight, uaMajor)`. It returns `null` for `fit` or an unknown mode. For a device mode it returns `{ metrics, touch, emitTouch, userAgent }`, following design.md Decisions 1–5. Inputs are coerced to finite positive numbers. PC gets `scale = min(1, tabWidth / 1280)`.
- [ ] 1.2 Add `test/viewport-modes.test.mjs` via `extractFunction`. It covers:
  - the table values;
  - Mobile at 1020×780 is 390×780, DPR 3, `mobile: true`, centred at `positionX` 315;
  - Tablet is 768 wide with DPR 2;
  - PC at 1020 wide has scale ≈ 0.797, and at 1600 wide has scale 1;
  - the phone user agent contains `Android` and `Mobile`, and the tablet one contains `Android` without `Mobile`;
  - Fit returns `null`;
  - garbage input does not throw.
  ← (verify: deterministic, no chrome.*)

## 2. Background emulation

- [ ] 2.1 Add `applyViewportMode(tabId, mode)` and `clearViewportMode(tabId)`. They use the command order in Decision 6. If any command fails, they clear and return `{ok:false, reason}`.
- [ ] 2.2 Add `viewportModeByTab` with a `chrome.storage.session` mirror. Reconcile it against `attachedTabs` at worker start. Drop the entry in `tabs.onRemoved` and in `debugger.onDetach`. Broadcast `viewport_mode_changed` on every change.
- [ ] 2.3 Add the `viewport_mode_set {tabId, mode}` and `viewport_mode_get {tabId}` messages. Refuse restricted URLs with a reason.
- [ ] 2.4 Re-apply on `chrome.windows.onBoundsChanged`, debounced by 150 ms.
- [ ] 2.4b While any tab is emulated, poll `chrome.tabs.get` every 500 ms and re-apply on a content-size change (DevTools docked or undocked). Stop polling when no tab is emulated.
- [ ] 2.4c Remove the first-attach `Emulation.clearDeviceMetricsOverride` from `ensureAttached`. After each apply, verify `innerWidth`. On a mismatch, mark the tab `overridden` and broadcast it, without re-applying. ← (verify: no code path clears or sets emulation on a tab without an operator pick for that tab)
- [ ] 2.5 Make `resize_window` append the emulation note from Decision 11. Make `tabs_context_mcp` name the mode per tab.
- [ ] 2.6 Add wiring tests through `_extract.mjs` with a fake `chrome.debugger`. They check the command order for each mode, the clear on Fit, the clear on failure, the entry dropped on detach and on tab removal, and the `resize_window` note. ← (verify: no test calls a real browser)

## 3. Panel control

- [ ] 3.1 In `renderContextChip()`, add the viewport button between the chip and the pin button. It carries an accessible name `Khung nhìn của trang: <mode>`, is accent-tinted when not Fit, and is disabled with a reason on restricted pages.
- [ ] 3.2 Add the menu. It has four `menuitemradio` rows with their descriptions, keyboard support (Arrow, Enter, Escape) and focus return. The footer holds the reload note and a `Tải lại trang` button.
- [ ] 3.3 On bind change and on `viewport_mode_changed`, the panel asks `viewport_mode_get` and re-renders.
- [ ] 3.4 Add styles in `sidepanel.css` using existing tokens only. ← (verify: `openspec/ui-dna.md` constraints; no new colour literal)

## 4. Acceptance

- [ ] 4.1 `node test/viewport-modes.test.mjs` passes, the new wiring test passes, and the full `npm test` stays green.
- [ ] 4.2 Operator-run live check, NOT claimed done until executed:
  - on a responsive site, Di động switches the tab to the phone layout without DevTools, and scrolling by drag or wheel works;
  - Tablet and PC behave likewise, with PC shrunk in a narrow window;
  - Vừa cửa sổ restores the page;
  - the mode survives clicking a link;
  - resizing the window re-fits;
  - Cancel on the debugging bar returns the tab to normal and the panel to Vừa khung;
  - with F12 docked, pick Di động: it works, and Elements, Console and Network inspect the emulated page;
  - open and close F12 while in Tablet: the page re-fits and stays in Tablet;
  - with Browzy off, turn on DevTools device mode, then use the panel's page tools and run an agent step: the DevTools device mode is not reset;
  - turn on the DevTools device toolbar while Browzy is in Di động: the panel shows `DevTools đang điều khiển khung nhìn` and nothing loops;
  - record whether `positionX` centred the page;
  - record whether an agent click lands correctly in PC mode below scale 1.
  ← (verify: concrete pass/fail observed in a live browser)

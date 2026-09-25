## Context

Verified by reading `extension/background.js` and `extension/sidepanel/sidepanel.js`:

- **Debugger attachment.** `ensureAttached(tabId)` (:3054) attaches `chrome.debugger` at protocol 1.3 once per tab and records it in `attachedTabs` (:1186). On first attach it runs `Emulation.clearDeviceMetricsOverride` (:3087) to drop an override left by old builds, then `Emulation.setFocusEmulationEnabled`. The attachment is kept until the tab closes (:3185) or Chrome detaches it (:3207). Chrome detaches it when the operator clicks Cancel on the "“Browzy” đã bắt đầu gỡ lỗi trình duyệt này" bar.
- **What detaching does.** Emulation overrides belong to the debugger session, so a detach drops them in Chrome. The page returns to normal by itself, but Browzy's own state would still claim the old mode.
- **Screenshots and resizing.** The screenshot path measures the viewport with `window.innerWidth/innerHeight` over `Runtime.evaluate` (:6185, :6670) and clips to it. `resize_window` (:7134) resizes the window and reports whether the viewport followed.
- **Page-context row.** `renderContextChip()` (sidepanel.js :543) builds the page chip, pin and clear buttons for the bound tab from `pageContext.snapshot()`. The snapshot carries `tabId`, `hostname`, `title` and `restricted`. Panel-to-background messages use flat snake_case types (`panel_bind_tab`, `design_mode_activate`) on `chrome.runtime.onMessage` (:9184).

Reference studied: NotepadAI `WebViewWidget.h` :72–92 (`viewportBoundsFor`) and `WebViewWidget_win.cpp` :390–470 (`applyTouchEmulation`). Mobile and Tablet there enable `setEmitTouchEventsForMouse` with configuration `mobile` and `setTouchEmulationEnabled`, and set an iPhone or iPad user agent. They also set `setDeviceMetricsOverride` with `mobile: true`, a device pixel ratio of 3 or 2, and portrait orientation. Fit and PC clear the metrics. Changes are debounced 50 ms on resize.

## Goals / Non-Goals

**Goals:**

- One click from the panel switches the bound tab to a phone, tablet or 1280 px desktop layout, and one click switches it back.
- No DevTools window and no new permission.
- The operator can always see which mode a tab is in, and a stale state is never shown.
- Agent tools on an emulated tab stay truthful about the viewport they act on.

**Non-Goals:**

- Custom sizes, landscape, device frames, and network or CPU throttling.
- An agent-callable tool to change the mode (possible later, but not in this change).
- Emulating tabs other than the one the panel is bound to.

## Decisions

1. **Mode table.** One frozen table, `VIEWPORT_MODES`, lives next to `viewportModeParams()` in `background.js` (see Decision 9 for why it is not a separate module).

   | mode | width | device pixel ratio | mobile | touch | user agent |
   |---|---|---|---|---|---|
   | `fit` | none, all overrides cleared | | | | |
   | `mobile` | 390 | 3 | `true` | on | Chrome Android phone |
   | `tablet` | 768 | 2 | `true` | on | Chrome Android tablet |
   | `pc` | 1280 | the window's own | `false` | off | unchanged |

2. **Height follows the tab.** The emulated height is the tab's current content height from `chrome.tabs.get(tabId).height`. That value is read before any override, so it is never contaminated by one. `screenWidth` and `screenHeight` match the emulated size, and orientation is `portraitPrimary`.
3. **PC is scaled, not clamped.** If the tab is narrower than 1280, `setDeviceMetricsOverride` receives `scale = tabWidth / 1280`. The page lays out at 1280 and is drawn smaller. NotepadAI's clamp would make PC identical to Fit in a narrow window.
4. **Centring is best-effort.** Mobile and Tablet pass `positionX = floor((tabWidth − width) / 2)` and `positionY = 0`. Both are experimental CDP fields. If Chrome ignores them, the emulated page sits at the top-left, which is acceptable. Task 4.2 verifies which one happens.
5. **User agent in the Chrome engine's own family.** User agents are built from the browser's real major version (`navigator.userAgentData` in the worker), as Chrome on Android. The phone string includes `Mobile` and the tablet string omits it, the way Chrome sends them. `userAgentMetadata` carries `mobile: true` and platform `Android`, so the Client Hints headers agree with the user agent string. NotepadAI's iPhone and iPad Safari strings are not copied, because a Blink engine claiming to be WebKit gets WebKit-only code paths it cannot run.
6. **Apply order and clearing.**
   - **Apply:** `ensureAttached`, then `setDeviceMetricsOverride`, then `setTouchEmulationEnabled` with `maxTouchPoints` 5 when touch is on, then `setEmitTouchEventsForMouse` (`enabled`, configuration `mobile`), then `setUserAgentOverride` (an empty string restores the default).
   - **Fit:** runs the same four commands with their clear or disable forms.
   - **Failure:** if any command fails, the state is cleared and the error goes back to the panel. A tab is never left half-emulated while the panel shows a mode.
7. **State and lifetime.**
   - **Where it is kept:** `viewportModeByTab: Map<tabId, {mode, appliedAt}>`, mirrored to `chrome.storage.session` under one key so a service-worker restart can read it back.
   - **What survives:** the mode survives navigation, because CDP overrides persist for the debugger session.
   - **What removes it:** picking Fit; `tabs.onRemoved`, which drops the entry; `debugger.onDetach`, which drops the entry because Chrome already dropped the overrides; and a restart that finds a stored tab not in `attachedTabs`, which drops the entry because a restart ends the debugger session.
   - **Broadcast:** every change is sent as `viewport_mode_changed {tabId, mode}` so every open panel updates.
8. **Window resize.** `chrome.windows.onBoundsChanged` re-applies emulated tabs in that window after a 150 ms debounce, so height and PC scale track the window.
9. **Module shape.** `background.js` is a classic service-worker script, and `test/_extract.mjs` extracts named top-level functions from it. The pure logic (`viewportModeParams(mode, tabWidth, tabHeight, uaMajor)`) therefore lives in `background.js` as a named top-level function with an options-free signature. `test/viewport-modes.test.mjs` exercises it through `extractFunction`. No new module and no build step are needed.
10. **Panel control.**
    - **Placement:** in `renderContextChip()`, between the page chip and the pin button, a `<button aria-haspopup="menu">` shows the mode icon and its short label (`Vừa khung`, `Di động`, `Tablet`, `PC`).
    - **Look:** it is accent-tinted when not Fit.
    - **Menu:** four `menuitemradio` rows with the width and what is emulated, then a footer line and a `Tải lại trang` button that calls `chrome.tabs.reload(tabId)`.
    - **Keyboard:** Arrow keys, Enter and Escape work as in the existing slash picker.
    - **Refusal:** on a restricted snapshot the button is disabled with a title stating the page cannot be emulated.
    - **Tokens:** only existing ones (`ui-dna.md`).
11. **Tools on an emulated tab.**
    - **Screenshots and `read_page`:** these already measure `innerWidth/innerHeight` in the page, and that returns the emulated size, so they stay truthful without change.
    - **Input:** `Input.dispatchMouseEvent` coordinates are in the emulated viewport's CSS pixels.
    - **Touch:** with `setEmitTouchEventsForMouse` on, synthesized mouse input reaches the page as touch. That is what a phone would do, and it is accepted.
    - **`resize_window`:** it appends a note that the page is emulating `<mode>` at `<w>`px and the window size does not change the page width until the operator picks Fit.
    - **PC scale below 1:** the coordinate space is verified in task 4.2 before PC is declared agent-safe. Until then, `resize_window` and screenshot results name the scale.

## Risks / Trade-offs

- [Risk] **The debugging bar is visible while emulating.** It is the same bar agent runs already show. It is inherent to CDP without DevTools and is accepted. Dismissing it is a clean way out: the tab returns to Fit and the panel follows.
- [Risk] **Server-side user-agent sniffing.** Sites that pick the mobile layout on the server change only after reload. → The menu says so and offers reload. The layout change itself is instant.
- [Risk] **`positionX` is ignored.** The page then renders at the top-left. → This is cosmetic only. Task 4.2 records which case happens.
- [Risk] **An agent run on an emulated tab sees a phone layout.** That is often desired, for example to test a mobile flow. `tabs_context_mcp` and screenshot results name the mode so the model is not surprised.
- [Risk] **Worker eviction.** The stored mode is reconciled against `attachedTabs` on start, and a state is never shown without an attachment behind it.
- [Trade-off] **Per-tab only.** A new tab opens in Fit. That matches DevTools device mode and avoids surprising the operator in unrelated tabs.

## Migration Plan

Additive. Removes the unimplemented `add-document-preview-viewport-modes` change, which targeted the wrong surface. Nothing was built from it. Rollback removes the control and the handlers. A tab left emulated is cleared when the debugger detaches.

## Open Questions

- Whether `positionX` centring works through `chrome.debugger` in current stable Chrome. Task 4.2 answers this.
- Whether PC mode's scale below 1 keeps agent input coordinates in page CSS pixels. Task 4.2 answers this. Until then PC is marked "xem" (view) only for the agent: the tool results name the scale.

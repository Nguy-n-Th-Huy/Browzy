## ADDED Requirements

### Requirement: The operator switches the bound page's viewport from the panel

The page-context row SHALL offer a viewport control for the bound tab. It opens a menu of exactly four modes: **Vừa cửa sổ** (no emulation), **Di động** (390 CSS px wide), **Tablet** (768 CSS px wide) and **PC** (1280 CSS px wide). Selecting a mode SHALL apply it to the bound tab itself, without opening DevTools and without the operator leaving the panel. The control SHALL always show the bound tab's current mode, and SHALL be visibly distinct when any mode other than Vừa cửa sổ is active. The control and its menu SHALL be keyboard-operable, and each carries an accessible name. Each menu entry SHALL state its width and what it emulates. On a page the browser does not allow Browzy to attach to, the control SHALL be disabled with a stated reason.

#### Scenario: Switching a page to mobile

- **WHEN** the operator opens the viewport menu and selects Di động
- **THEN** the page in the bound tab re-lays out at a 390 px phone width, DevTools stays closed, and the control reads Di động

#### Scenario: Switching back

- **WHEN** the operator selects Vừa cửa sổ
- **THEN** the page returns to the window's own size and behaviour, and the control reads Vừa khung

#### Scenario: A page that picks its layout on the server

- **WHEN** a device mode is active and the page has not changed its layout
- **THEN** the menu explains that some sites pick their layout only on load, and offers a reload that reloads the bound tab in the same mode

#### Scenario: A restricted page

- **WHEN** the bound tab is a browser-internal page
- **THEN** the viewport control is disabled and states that this page cannot be emulated

### Requirement: The panel never shows a viewport mode that is not in force

The control SHALL reflect the background's per-tab state and SHALL update on every change, including changes the operator did not make from this panel. If emulation ends for any reason, the control SHALL return to Vừa khung. That includes the operator dismissing the browser's debugging bar, the debugger detaching, the service worker restarting without the attachment, and the side panel that set the mode closing or reloading — unless another open panel is bound to the same tab, in which case that other panel keeps showing the mode.

#### Scenario: The operator dismisses the debugging bar

- **WHEN** a device mode is active and the operator cancels the browser's debugging bar
- **THEN** the page returns to normal and the control reads Vừa khung

#### Scenario: Closing the panel that set the mode

- **WHEN** the operator picks Tablet, then closes the side panel
- **THEN** the tab returns to normal; if the panel is reopened bound to that tab, its control reads Vừa khung

#### Scenario: DevTools takes over

- **WHEN** DevTools device mode changes the viewport of a tab that has a Browzy mode
- **THEN** the control states that DevTools is controlling the viewport, and picking a mode again hands control back to Browzy

#### Scenario: Two panels

- **WHEN** the mode is changed from one side panel window
- **THEN** every other open panel bound to that tab shows the new mode

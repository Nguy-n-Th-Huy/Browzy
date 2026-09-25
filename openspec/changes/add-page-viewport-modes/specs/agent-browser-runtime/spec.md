## ADDED Requirements

### Requirement: Per-tab device emulation over the existing debugger attachment

The runtime SHALL apply viewport modes to a tab through the debugger attachment it already uses for browser tools. It SHALL NOT use a new permission or a DevTools window.

- **Di động and Tablet:** these SHALL set the mode's CSS width, the tab's current content height, a mobile device-metrics flag and the mode's device pixel ratio. They SHALL enable touch emulation, deliver mouse input as touch, and set a user agent and user-agent client hints of the Chrome engine's own family for that device class.
- **PC:** this SHALL set a 1280 CSS px layout width. When the tab is narrower it SHALL scale the rendering down, and it SHALL never scale up. It SHALL leave touch and the user agent untouched.
- **Vừa cửa sổ:** this SHALL clear every override it set.
- **Failure:** if any step fails, the runtime SHALL clear all overrides and report the failure. A tab SHALL never be left partly emulated.

#### Scenario: Mobile on a wide window

- **WHEN** Di động is applied to a tab whose content area is 1020×780
- **THEN** the page sees a 390×780 viewport with touch input and a phone user agent

#### Scenario: PC in a narrow window

- **WHEN** PC is applied to a tab whose content area is 1020 px wide
- **THEN** the page lays out at 1280 px and is rendered at about 80 % so its whole width is visible

#### Scenario: A failed step

- **WHEN** one of the emulation commands is refused
- **THEN** no override remains on the tab and the panel receives the failure reason

### Requirement: Emulation lifetime is per tab and follows the debugger session

A viewport mode SHALL apply only to the tab it was set on. It SHALL persist across navigations in that tab and follow window resizes. It SHALL end when the operator selects Vừa cửa sổ, when the tab closes, or when the debugger detaches for any reason. The runtime SHALL keep the per-tab mode where a service-worker restart can read it. The runtime SHALL discard any stored mode that has no live debugger attachment behind it.

#### Scenario: Following a link

- **WHEN** a tab in Tablet mode navigates to another page
- **THEN** the new page also renders in Tablet mode

#### Scenario: Resizing the window

- **WHEN** the window of a tab in Di động mode is resized
- **THEN** the emulated height, and for PC the scale, are recomputed for the new size

#### Scenario: A new tab

- **WHEN** the operator opens a new tab while another tab is in Di động mode
- **THEN** the new tab renders normally

### Requirement: Browser tools stay truthful on an emulated tab

On a tab with an active viewport mode, screenshots and page reads SHALL describe the emulated viewport, and pointer coordinates SHALL be in that viewport's CSS pixels. `tabs_context_mcp` SHALL name each tab's active mode. `resize_window` SHALL state that emulation holds the page width when it acts on an emulated tab. The agent SHALL NOT be able to change a tab's viewport mode through any tool in this change.

#### Scenario: A screenshot of a mobile-emulated tab

- **WHEN** a run takes a screenshot of a tab in Di động mode
- **THEN** the image and its reported viewport are the 390 px emulated viewport

#### Scenario: Resizing an emulated tab

- **WHEN** a run calls `resize_window` on a tab in Tablet mode
- **THEN** the result states that the page stays 768 px wide while Tablet is active

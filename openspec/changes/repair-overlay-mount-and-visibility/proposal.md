## Why

The remote-control overlay does not appear at all. Running a real agent against a page produces no cursor, no status bar and no Stop button, and no error anywhere — the page simply looks untouched. The operator therefore has a run driving their browser with zero on-page evidence that it is happening, which is the exact state the "Visible agent pointer and control status" requirement exists to prevent.

This is not one bug. Every mechanism that decides whether the layer is on screen defaults to **hidden**, and each one can fail silently, so several independent faults converge on one indistinguishable symptom. Adversarial review corrected an earlier overstatement here: none of the faults found by reading code is on its own sufficient to blank an entire run, and the most likely single cause (RC7 - `chrome.tabs.sendMessage` possibly resolving instead of rejecting, which would skip the injection retry entirely) cannot be settled without a live run. **Task 0.1 is therefore a gate, not a step:** one instrumented run must name the fault before sections 1-6 are implemented. The previous session already added console diagnostics to `pointer-overlay.js` and `background.js` precisely because the failure was unobservable — that is itself evidence the mount/visibility layer is not structured to be diagnosable.

`alibaba/page-agent` solves the same problem with an inverted structure: its `SimulatorMask` mounts once, unconditionally, in its constructor, and visibility is a single explicit state toggled by `show()` / `hide()` / `dispose()`. This change adopts that structure for Browzy's overlay while keeping Browzy's own state machine, its `pointer-events: none` invariant, and every existing safety assertion.

**Baseline is the current working tree, not `HEAD` (918f71c).** The uncommitted work in `extension/overlay/pointer-overlay.js` and `extension/background.js` — the disposer that replaces the `__browzyOverlayLoaded` bail-out, the `sendResponse` acknowledgement, `CAPTURE_HIDE_MAX_AGE_MS`, the parked-cursor state, the `[browzy-overlay]` / `[browzy-overlay-bg]` delivery logging — is **kept** and is the state this proposal describes changes against. Nothing below re-proposes work already present there.

## What Changes

- **The overlay mounts eagerly on script load** instead of lazily inside the first delivered message. `attach()` stops being reachable only from `handleOverlayEvent()`. A page that has the script always has the node, so "not injected", "injected but no run tracked" and "tracked but hidden" become three distinguishable states rather than one blank page.
- **A single authority decides visibility.** `paintOverlay()` becomes the only writer of the host's on-screen state, driven by one boolean on the render model. `setCapturedHidden()` stops writing `host.style.visibility` out of band; it records capture state and requests a repaint like every other input.
- **BREAKING (internal contract):** `computeRenderModel()` gains `capturedHidden` as an input and `visible` as an output field. The capture flag stops being a `paintOverlay()` argument applied after the model was computed.
- **The capture hide becomes a correlated, self-expiring lease.** `browzyOverlayCapture` carries a `captureId` and a `maxMs`; the overlay hides for that lease and un-hides on the matching `show`, on expiry, or on a newer `captureId`. A lost `show` costs one bounded interval instead of the rest of the run; a reordered `hide`/`show` pair is rejected by id instead of leaving the layer hidden over a live run.
- **New: the overlay host is excluded from DOM extraction.** The host node gains `data-browzy-overlay` awareness in the extraction path, so `read_page`, `get_page_text` and `find` never report the overlay's own markup as page content. Today nothing excludes it.
- **New: the run-start raise works for an unscoped run.** `startOverlayForRun()` currently returns at its first line whenever `tabScope` is the string `"any"` — the value produced whenever the panel bound no page context. It gains the tab-group resolution path `addGroupTabsToOverlayRun()` already implements, so an unscoped run raises the overlay on the tabs the operator's group actually holds.
- **The cursor is interpolated rather than teleported.** Position becomes a target that a `requestAnimationFrame` loop eases toward, so a pointer that jumps between sparse action-events reads as movement instead of a rendering glitch.
- **New: the operator's input to page content is blocked while a run holds the page.** Trusted mouse, pointer, wheel, touch and keyboard input the operator aims at the page is suppressed for as long as the run is live, so their stray click cannot race the agent mid-action. The page's own scripts are unaffected — only trusted events are suppressed. The overlay's own Stop and Open-panel controls stay usable throughout, browser-level control (closing the tab, switching tabs, the omnibox, the side panel) is untouched, the block lifts while the run waits for the operator's approval, and it ends within 3 seconds of the run ending by the same heartbeat that clears every other overlay state. See design D6 and D8.
- **New: the lock is visible.** While input is blocked, the page's cursor becomes `wait`, and the status bar says the page is locked. Without this the operator cannot tell a blocked click from a frozen page. See design D10.
- **New: an ambient glow around the viewport edges.** page-agent's atmospheric layer, written directly in CSS rather than imported, weighted to the edges so it does not blink across the page's content at screenshot cadence. See design D11.
- **The agent cursor is drawn at page-agent's size** — roughly 72px against the current 26px — with the label offset, hot-spot translation and click ripples retuned to match. See design D9.
- **Adopted in shape, not in mechanism, from page-agent.** The blocking behaviour is `SimulatorMask`'s, but its implementation is not portable here: it sets `pointer-events: auto` on a full-viewport wrapper and swallows events by hit-test, which works only because page-agent dispatches straight at a resolved element. Browzy dispatches CDP synthetic input at viewport coordinates, so that wrapper would swallow the agent's own clicks. See design D6.

## Capabilities

### New Capabilities

None. This restores and hardens behaviour an existing capability already requires.

### Modified Capabilities

- `browser-assistant-panel`: the "Visible agent pointer and control status" requirement gains behaviour it does not currently state — that indication of active control does not depend on the run having named a tab in advance, that the layer is never left hidden by a lost or reordered capture message, that pointer motion between dispatched actions is drawn as motion, that the overlay's own markup is never reported as page content by a read or extraction, and that the operator's input to page content is blocked for the duration of a run while the overlay's own controls, browser-level control and the approval pause all remain reachable, and while the page's own scripts keep working.

## Impact

**Code**

- `extension/overlay/pointer-overlay.js` — sections 1, 2 and 3. `computeRenderModel()` gains the capture input and the `visible` output; `attach()` is called at load; `setCapturedHidden()` stops writing the DOM; a cursor-easing loop is added; the capture lease is tracked by id; capture-phase input blockers gated on `actionInFlight` are added, and the `pagehide` and dispose teardown paths are corrected; a `cursor: wait` style element is appended to the page while blocking is in force and removed on every path that ends it; an edge-weighted ambient glow joins the existing frame layers; the cursor's size, label offset and ripple geometry are retuned. Section 1's other pure functions keep their current signatures.
- `extension/background.js` — `startOverlayForRun()` gains the unscoped path; `requestOverlayHide()` / `requestOverlayShow()` gain the `captureId` / `maxMs` correlation; no change to the dispatch path — blocking reads the action-event stream the overlay already receives.
- `extension/content.js` — the extraction path excludes any node carrying `data-browzy-overlay`.
- `test/overlay-pointer.test.mjs`, `test/overlay-background-bridge.test.mjs` — new coverage for eager mount, single visibility authority, the capture lease, cursor easing, the unscoped raise, input blocking and the wait cursor. Every existing *safety* assertion is kept; two implementation-shape regexes that D3 necessarily invalidates (`overlay-pointer.test.mjs:133-134`) are updated rather than kept.

**Invariants this change must not break** (each asserted by a test that passes today)

- classic script, no top-level `import` / `export` — injected via `chrome.scripting.executeScript`, and `manifest.json` has no `web_accessible_resources`
- named top-level function declarations inside the IIFE, so `test/_extract.mjs` can pull each pure function out of the shipped file
- `pointer-events: none` everywhere except the deliberate Stop and Open-panel controls
- heartbeat expiry within 3s of the last signal (`HEARTBEAT_MAX_AGE_MS` 2700 + a 250ms check interval)
- a `keepalive` refreshes liveness only — it never moves the cursor, invents a click, or inflates the step count
- teardown on run end, companion loss, debugger detach and document replacement
- no Allow/Deny control on the overlay (archived `2026-09-07-redesign-remote-control-overlay` design D6): the agent's own clicks are dispatched through CDP `Input.dispatchMouseEvent`, carry `isTrusted === true`, and land on whatever occupies the coordinate — closed shadow roots included. The waiting state keeps "Open panel" and nothing else.

**Not affected**

No host-side change (`host/**`), no action-event schema change, no protocol version change, no manifest change, no new permission. `tabScope` keeps its current meaning and default; this change reads it, it does not redefine it.

**Considered and rejected**

- **CDP `Input.setIgnoreInputEvents` as the blocking mechanism.** It also drops the extension's own synthetic input, so the agent would block itself. Verified against Chromium source for Chrome 116 (the extension's floor) through current `main`. See design D6.
- **`ai-motion`, the npm package page-agent renders its ambient layer with.** `extension/` has no build step — `package-extension.sh` copies the directory verbatim and every file is a classic script injected as-is, so an npm dependency means introducing a bundler for the extension, far outside "change the control layer". The *effect* is kept: the glow is written directly into the overlay's own CSS instead (design D11). It is weighted to the viewport edges rather than covering the page, because the overlay is hidden around every screenshot and the agent screenshots on nearly every step — a full-viewport layer would blink across the content continuously. page-agent does not hit this because it does not screenshot.
- **Porting page-agent's `RemotePageController`.** `packages/extension/src/agent/RemotePageController.{ts,background.ts,content.ts}` is only a message bridge from the agent through the service worker to the content script. Browzy already has that bridge. Nothing there is portable; everything worth taking lives in `SimulatorMask`, and it is taken by D1, D3, D5, D8 and D9.

**Open question for the operator**

The four faults below are each verified in code and each independently sufficient to produce "nothing appears". Which one the operator actually hit was not determined from a live run — the extension was not driven under instrumentation for this diagnosis. The change closes all four rather than picking one, so this does not block implementation, but a single live run with the page console filtered to `browzy-overlay` would confirm which path was in force and is worth doing before or during implementation.

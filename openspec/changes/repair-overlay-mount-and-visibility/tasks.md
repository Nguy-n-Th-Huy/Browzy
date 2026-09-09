# Tasks

Baseline is the **current working tree**, not `HEAD`. The uncommitted overlay work already present in `extension/overlay/pointer-overlay.js` and `extension/background.js` is kept; nothing below re-does it.

Scope is exactly five files: `extension/overlay/pointer-overlay.js`, `extension/background.js`, `extension/content.js`, `test/overlay-pointer.test.mjs`, `test/overlay-background-bridge.test.mjs`. Nothing else may be edited or deleted. No host-side file, no manifest, no schema.

Structural constraints that hold for every task: classic script, no top-level `import`/`export`; named top-level function declarations inside the IIFE so `test/_extract.mjs` can reach them; `paintOverlay()` stays the only function that touches the DOM; `pointer-events: none` everywhere except the Stop and Open-panel controls.

Tests run individually with `node test/<file>.test.mjs` — there is no root `package.json`.

## 0. GATE - name the live fault before changing behaviour

- [ ] 0.1 Load the unpacked extension, run one real agent task against an ordinary page, and record the page console filtered to `browzy-overlay` plus the service-worker console filtered to `browzy-overlay-bg`. Then read the result against this discriminator:
  - SW says `delivered` **and** the page console has no `[browzy-overlay] script loaded` -> **RC7**: `chrome.tabs.sendMessage` resolved instead of rejecting, so the injection retry never ran. Fix that first; it is one line and it may be the whole bug.
  - Page says `paint: hidden for a screenshot` and it persists beyond 2s -> the capture path, **RC3**.
  - Page says `paint: heartbeat expired` while the SW keeps sending keepalives -> the message path.
  - Page says `paint: no host node` -> **RC5**.
  - No `[browzy-overlay-bg]` line at all for the driven tab -> **RC1**, the raise never happened.
  ← (verify: this task GATES sections 1-6. None of RC1-RC6 is on its own sufficient to blank a run — that claim was withdrawn after review — so implementing all of them without knowing which one fired would be closing six defects while possibly leaving the real one open. Record the verdict in the change before writing code; if it names nothing on this list, revise design.md rather than proceeding.)
  **NOT DONE — requires a real browser run, which this implementation session cannot perform.** RC7 is closed STRUCTURALLY instead (see `sendOverlayMessage()`/`isOverlayAck()` in `extension/background.js`): a reply that is not exactly `{ok:true}` is now treated as undelivered and falls through to inject-then-retry, correct under either Chrome resolve/reject semantics, covered by a dedicated regression block in `test/overlay-background-bridge.test.mjs` ("RC7: a resolved-but-unacknowledged reply..."). This closes the gate structurally so sections 1-11 could proceed without the live verdict; the live run itself is still the operator's outstanding step (see task 12.1).

## 1. Mount eagerly (RC5)

- [x] 1.1 Call `attach()` once as the IIFE runs, immediately after the existing `logOverlayMessage("script loaded", ...)` line.
- [x] 1.2 Leave `handleOverlayEvent()`'s own `attach()` call in place — its `if (refs) return` guard already makes it a no-op — and leave the heartbeat's document-replacement recovery (`refs = null; attach()`) untouched.
- [x] 1.3 Confirm the eagerly mounted node draws nothing: with no event ever delivered, the host is present in the document and the render model reports not visible. ← (verify: a mounted overlay must never be the reason a page claims it is under control; the node's presence and the run's liveness are independent facts and only the second one may reveal it)

## 2. One visibility authority (RC2, RC4)

- [x] 2.1 Extend `computeRenderModel()` to `(state, nowMs, maxAgeMs, capturedHidden)` and add a `visible` field to the model it returns, derived from `active` and the capture flag. Keep the existing `active` field and every other field unchanged.
- [x] 2.2 Remove `paintOverlay()`'s `capturedHidden` parameter; it reads `renderModel.visible` instead. `paintOverlay()` becomes the only writer of the host's on-screen state.
- [x] 2.3 Rewrite `setCapturedHidden()` to record capture state and request a repaint only — it must not write `host.style.visibility` or any other DOM property.
- [x] 2.4 Give `scheduleRepaint()` a synchronous path used only by the capture case, so a hide is on screen before `requestOverlayHide()` resolves on the background side. The normal event path keeps its coalescing scheduler. ← (verify: a capture-driven hide takes effect without waiting for an animation frame — the reason the working tree bypassed the scheduler in the first place — while still going through the single writer from 2.2; a frame of exposure here means the overlay lands in a real screenshot)
- [x] 2.5 Update `lastPaintVerdict` to read the model's own fields rather than re-deriving the three reasons. The four verdicts (`no host node`, heartbeat expired, hidden for a capture, visible) must remain distinguishable in the log.

## 3. Correlated, self-expiring capture lease (RC3)

- [x] 3.1 In `extension/background.js`, make `requestOverlayHide(tabId)` mint a `captureId` and send `{ type: "browzyOverlayCapture", phase: "hide", captureId, maxMs }`; `requestOverlayShow(tabId)` sends `{ phase: "show", captureId }` for the id its own hide minted. Keep the existing `overlayHideInFlight` ordering and the `OVERLAY_HIDE_WAIT_MS` race bound.
- [x] 3.2 In the overlay, track `{ captureId, hiddenAt }`. Un-hide on a `show` whose id matches, on `hiddenAt + maxMs` elapsing, or on a `hide` carrying a newer id. A `show` for an unknown or already-retired id is a silent no-op.
- [x] 3.3 Treat a `hide` with no `captureId` (an older background) as an anonymous lease that only expiry clears — the current behaviour, preserved. `CAPTURE_HIDE_MAX_AGE_MS` stays the default when `maxMs` is absent.
- [x] 3.4 Confirm the reorder case: a `hide` delivered *after* its own `show` (the injection-first path the working tree documents) leaves the overlay visible, not hidden. ← (verify: this is the exact failure the working tree's comment describes as leaving `present:true, vis:hidden` over a live run for the rest of its life; a passing test here is the regression net for it)

## 4. Exclude the overlay from extraction (D4)

- [x] 4.1 In `extension/content.js`, skip any node carrying `data-browzy-overlay` (and its subtree) in the extraction path used by `read_page`, `get_page_text` and `find`.
- [x] 4.2 Confirm the exclusion is by attribute, not by tag name, id or class — the host's other attributes are not a contract. ← (verify: with the overlay mounted and visible, a page read returns none of its markup, text or control labels; an overlay that shows up in a read corrupts the agent's own view of the page it is drawing on)

## 5. Cursor easing (RC6)

- [x] 5.1 Add a pure easing step function (named, top-level, extractable) that takes current position, target position and a factor and returns the next position, snapping when the remaining distance falls below the threshold.
- [x] 5.2 Drive it from a `requestAnimationFrame` loop that reads `renderModel.cursor` as the target and writes the drawn position. The drawn position is not state: `reduceOverlayState()` and `computeRenderModel()` never read it.
- [x] 5.3 Stop the loop when the model is not visible, and on teardown and heartbeat expiry — do not ease the cursor to a resting place when there is no run left to attribute the motion to.
- [x] 5.4 Leave the parked state (`.is-parked`) positioned by CSS. Entering or leaving parked is a state change, not a movement to interpolate.
- [x] 5.5 Confirm the click ripple and the action label still fire at the dispatched coordinate, never at an interpolated one, and still only on a real `phase: "down"` in `pointer.points[]`. ← (verify: the eased path deliberately passes through coordinates the agent never dispatched — drawing a pointer there is honest, drawing anything that asserts an action there is a fabrication the module's own header forbids)

## 6. Raise the overlay for an unscoped run (RC1)

- [x] 6.1 In `startOverlayForRun()`, keep the `runId` guard but fall through to `addGroupTabsToOverlayRun(runId)` when `tabScope` is not a non-empty array, and raise on whatever it resolves.
- [x] 6.2 Leave `tabScope`'s meaning, its default and every producer of it untouched — no host-side edit, no `sidepanel.js` edit.
- [x] 6.3 Confirm a run whose group resolves to no scriptable tab raises nothing and still falls back to the first action-event carrying a `tabId`. ← (verify: the overlay must appear on the pages the run actually holds and on no others; a group-derived raise that marks an unrelated tab is worse than the blank page this change is fixing)

## 7. Block the operator's input while a run holds the page (D8)

- [x] 7.1 Register capture-phase listeners on `window` with `{ capture: true, passive: false }` for `pointerdown`, `pointerup`, `pointermove`, `mousedown`, `mouseup`, `click`, `auxclick`, `dblclick`, `contextmenu`, `wheel`, `keydown`, `keypress`, `keyup`, `beforeinput`, `touchstart`, `touchmove`, `touchend`, `paste` and `drop`, suppressing each with `preventDefault()` + `stopImmediatePropagation()`. ← (verify: `passive: false` is not optional — `wheel` and `touch*` on `window` are passive by default in Chrome and `preventDefault()` is ignored on a passive listener, so a default registration blocks no scrolling at all; and pointer events must be present, because suppressing `mousedown` alone leaves React and every other pointer-event library fully interactive)
- [x] 7.2 Suppress only when `event.isTrusted === true`. Untrusted page-generated events pass untouched — including `extension/content.js:776`'s own `target.click()` in `setFormValue`. ← (verify: without this the overlay silently breaks the page's own scripts and the extension's own form filling; trusted covers both the operator and CDP-injected input, which is exactly the cut needed)
- [x] 7.3 Keep the overlay `pointer-events: none`. Blocking is by listener only — no `pointer-events: auto` wrapper, no hit-testing layer.
- [x] 7.4 Exempt any event whose `target` is the overlay host node, plus `Tab` / `Shift+Tab` keydowns. ← (verify: the host exemption is the operator's pointer route to Stop and the `Tab` exemption is their keyboard route — with `keydown` suppressed on page targets, focus cannot otherwise cross from page content into the shadow root, leaving a keyboard-only operator with no way to stop the run)
- [x] 7.5 Gate suppression on `state.actionInFlight === false`, reading the field the reducer already maintains from real `start`/`progress`/`complete` events. Do NOT add a `browzyOverlayInput` lease, and do not put any message on the dispatch path. ← (verify: the pass-through window must equal the action's real duration — a `type` action is a per-character CDP loop that can exceed ten seconds — which is exactly what `actionInFlight` gives and what a fixed `maxMs` lease cannot)
- [x] 7.6 Treat `actionInFlight` as still true for the mouse-ack window after a scroll action settles, so Brave's late-applied `mouseWheel` is not suppressed. See `extension/background.js:2617-2633,2661-2676`.
- [x] 7.7 When a trusted event is suppressed and an action `start` for this run arrives within a short window afterwards, report that suppression to the service worker, and have background attach it to that action's outcome as a warning. ← (verify: `hitNote`/`probeHit` run BEFORE dispatch (`background.js:3545-3571`) and `outcome.status` comes from `deriveOutcomeStatus(hitNote)` (`:3585`), so a swallowed click otherwise reports `success` and the model proceeds believing it clicked — this task is the only thing standing between the residual delivery race and a silent wrong result)
- [x] 7.8 Evaluate the block predicate with `isHeartbeatExpired(Date.now(), ...)` at event time. Never read a cached `active` boolean. ← (verify: a cached boolean outlives the timer that would refresh it, which is precisely what makes the `pagehide` path below able to strand a page)
- [x] 7.9 Require `state.runId != null` to block. Legacy MCP actions carry no `runId` yet still raise the overlay (`background.js:1168`); without this they would lock the page in 3-second windows with no run and no teardown.
- [x] 7.10 Scope blocking to the tabs in `overlayRunTabs` — the same set the overlay draws on, which via `addGroupTabsToOverlayRun()` includes the operator's other grouped tabs. This is accepted, not overlooked.
- [x] 7.11 Lift blocking while `pendingApproval` is set, and restore it when the approval resolves or clears.
- [x] 7.12 Fix `pagehide` (`pointer-overlay.js:1063-1065`): it must remove the window listeners and the D10 style element and hide the host, not only clear the heartbeat timer. ← (verify: on a bfcache restore the document returns with listeners and style intact and no timer left to expire anything — a page locked with a wait cursor and nothing to release it, which is the hostage-page failure this design refuses everywhere else)
- [x] 7.13 Invert the order in `window.__browzyOverlayDispose` (`:1054-1061`): DOM and timer cleanup first, `chrome.runtime.onMessage.removeListener` last in its own `try`. ← (verify: after an extension reload the `chrome.*` call throws on an invalidated context and the caller swallows it (`:60-64`), so everything after it today — `clearInterval`, host removal, and now listener and style removal — never runs)

## 8. Make the lock visible (D10)

- [x] 8.1 While blocking is in force, append a `<style>` element to the document whose rule is `*, *::before, *::after { cursor: wait !important }`, carrying `data-browzy-overlay` so D4's extraction exclusion covers it. ← (verify: `cursor` is inherited, not cascaded — a bare `html { cursor: wait }` loses to any descendant rule, and `a { cursor: pointer }` is on nearly every page, so the universal selector is what makes the signal actually appear) It sets the cursor and nothing else — no color, layout, visibility or `user-select`.
- [x] 8.2 Bind the wait cursor to `active && runId && !pendingApproval` — the same condition as blocking — and NOT to the agent's action state, which would flip the system cursor several times a second during a click burst. Remove the element on every path that ends blocking: approval pending, heartbeat expiry, teardown, `window.__browzyOverlayDispose` (see 7.13), and `pagehide` (see 7.12). Assert removal per path, not at one call site. ← (verify: a leftover style element leaves the operator's page showing a wait cursor after the run is over — the same hostage-page class of failure this design refuses everywhere else; walk each path in design.md's invariant list and confirm the node is gone)
- [x] 8.3 Add a locked state to the status bar text, so the lock is stated in words as well as by the cursor.
- [x] 8.4 Fix `[hidden]` on the bar and Stop: `.browzy-badge { display: flex }` (`:518`) and `.browzy-stop { display: inline-flex }` (`:543`) override the UA `[hidden] { display: none }` rule, so `badgeEl.hidden` / `stopButtonEl.hidden` (`:831`, `:849`) currently do nothing in a browser. Add `.browzy-badge[hidden], .browzy-stop[hidden] { display: none }` and a structural CSS assertion. ← (verify: D8 makes the visible state of Stop load-bearing — it is the operator's escape hatch — and today it is painted in the idle and waiting states where `overlay-pointer.test.mjs:552,604` assert it hidden)
- [x] 8.5 Confirm the style element is the only page-style mutation in the change — the overlay touches nothing else outside its own host and shadow root.

## 9. Ambient glow (D11)

- [x] 9.1 Add the glow to `OVERLAY_CSS` as its own layer inside the existing host — gradient and transform only, no npm dependency, no build step.
- [x] 9.2 Weight it to the viewport edges with an inward falloff, leaving the content region fully transparent. ← (verify: the overlay is hidden around every screenshot and the agent screenshots nearly every step, so a layer covering the content would blink across what the operator is reading on every step; the edge weighting is what makes that blink tolerable rather than constant)
- [x] 9.3 Keep it `pointer-events: none`, stack it below the cursor, ripples and status bar, and bind its visibility to the same `visible` field from task 2.1 so it appears and clears with the run.
- [x] 9.4 Under `@media (prefers-reduced-motion: reduce)`, stop its animation while the static glow remains — the same degradation the swept edge already uses.

## 10. Draw the cursor at page-agent's size (D9)

- [x] 10.1 Introduce the cursor size as a CSS variable and set it to ~72px, redrawing `CURSOR_SVG` at that scale.
- [x] 10.2 Retune the hot-spot correction (currently `transform: translate(-4px,-3px)`) so the arrow tip still sits exactly on the dispatched coordinate. ← (verify: this is the one measurement that silently falsifies every drawn position if it is missed — the cursor would point somewhere the agent never clicked, which the module's own header forbids)
- [x] 10.3 Retune the label offset (currently `left: 21px; top: 20px`) so it clears the larger arrow.
- [x] 10.4 Retune the two click ripples (currently 66px with `left/top: -33px`) to stay proportionate to the new cursor.
- [x] 10.5 Flip the label to the other side of the arrow when it would overflow the right or bottom viewport edge.

## 11. Tests

- [x] 11.1 Keep every existing *safety* assertion in `test/overlay-pointer.test.mjs`, `test/overlay-background-bridge.test.mjs` and `test/overlay-companion-sender.test.mjs` passing: no top-level import/export, `pointer-events: none` except the deliberate controls, heartbeat expiry ≤3s, keepalive semantics (no cursor move, no invented click, no step-count inflation), teardown on run end / companion loss / debugger detach / document replacement, reduced motion, and no grant-or-deny control in the waiting state. Two implementation-shape regexes that D3 necessarily invalidates — `overlay-pointer.test.mjs:133` and `:134` — are updated to the new shape rather than kept.
- [x] 11.2 Add coverage for eager mount: the host node exists with no event delivered, and the model reports not visible.
- [x] 11.3 Add coverage for the single visibility authority: `computeRenderModel()` returns `visible` correctly across active / inactive × captured / not captured, and `setCapturedHidden()` writes no DOM property.
- [x] 11.4 Add coverage for the capture lease: matching `show` un-hides; expiry un-hides; a newer `hide` supersedes; a stale or unknown `show` is a no-op; a `hide` arriving after its own `show` leaves the overlay visible.
- [x] 11.5 Add coverage for the easing step function: it converges toward the target, snaps at the threshold, and is a pure function of its arguments.
- [x] 11.6 Add coverage in `test/overlay-background-bridge.test.mjs` for the unscoped raise: `tabScope: "any"` reaches the group-resolution path, an explicit array still raises exactly those tabs, and neither path raises a tab outside the run.
- [x] 11.7 Update the tests that pass `capturedHidden` into `paintOverlay()` to set it on the model instead. The assertions themselves — hidden during capture, overlay state untouched by capture — do not change.
- [x] 11.9 Declare every new module-level variable (blocker state, rAF handle, capture-lease state) INSIDE the span the wiring test slices, `var state = {` through the `requestRender` closing (`overlay-pointer.test.mjs:505-513`); anything outside it is a `ReferenceError` at test time. Extend the fake `window` to record `addEventListener` calls and to provide `requestAnimationFrame` (`:498-503`).
- [x] 11.10 Add coverage for the input block: a user event on page content is suppressed; an event whose `target` is the overlay host is not; blocking is off when the overlay is not active; blocking is off while `pendingApproval` is set.
- [x] 11.11 Cover the `actionInFlight` gate and the exemptions by extracting the block predicate as a named pure function and the handler as a named function; assert registration options (`capture`/`passive`) structurally against the shipped source, since they cannot be observed from the fake DOM.
- [x] 11.12 Cover the suppression report (7.7) structurally in `test/overlay-background-bridge.test.mjs`: the bridge test cannot execute `handleToolRequest` (see its own header at `:10-15`), so assert that the report reaches the action's outcome by unit-testing the named helper plus an order check at `background.js:4924-4946`. ← (verify: 7.7 is what keeps a swallowed click from reporting `success`; a test that only proves the message shape and not that it reaches the outcome leaves the silent-failure path untested)
- [x] 11.13 Cover the cursor geometry as a constants check — the hot-spot offset against the SVG's own tip coordinates, and the label-flip threshold — not as a layout assertion, which needs a real browser.
- [x] 11.14 Implement D4 inline where the extraction actually runs — add `[data-browzy-overlay]` to the removal list at `content.js:376` and a `closest()` check at `:619` — not as a new helper: `getPageText` is compiled in `registry-borrowed-tab-live-extraction.test.mjs:200-212` with only `elementMap/history/location/window/document` in scope, so a new helper would be a `ReferenceError` there.
- [x] 11.15 Add coverage for the wait-cursor style element: it is present while blocking and absent after each of the paths in task 8.2; it carries `data-browzy-overlay`; and it declares nothing but `cursor`.
- [x] 11.16 Add coverage for the ambient glow: it is `pointer-events: none`, its content region is transparent, it is bound to the same `visible` field as the rest, and its animation stops while its static form remains under `prefers-reduced-motion`.
- [x] 11.17 Keep any CSS text inside an extracted function brace-balanced — `_extract.mjs` counts braces inside strings (`:16-27`).
- [x] 11.18 Run every suite that reads `extension/background.js` or `extension/content.js` through `_extract.mjs` and confirm all pass: `overlay-pointer`, `overlay-background-bridge`, `overlay-companion-sender`, `handlers`, `action-events-emission`, `tab-group-inheritance`, `extraction-honesty`, `registry-borrowed-tab-scope`, `registry-borrowed-tab-live-extraction`, `navigate-url-scheme`. ← (verify: `_extract.mjs` pulls functions out of the shipped source by name, so renaming or deleting one breaks a suite that never mentions this change; `computeRenderModel()`'s signature change and the `content.js` edit both sit on that fault line)

## 12. Confirm the fix live

- [ ] 12.1 Repeat 0.1 against the changed extension: run one real agent task, and confirm the controlled page shows the cursor, the status bar and a working Stop button from the start of the run, that the layer survives a run that screenshots on every step, and that the console verdict reads `visible` rather than any of the three hidden reasons, that your own clicks and typing on the page do nothing while the run is live, that the page's Stop button still responds, and that the page accepts your input again within 3 seconds of the run ending with no wait cursor left behind, that the wait cursor and the bar's locked state both appear while locked, that your scrolling and your typing are both actually blocked (not just clicks), that the page's own scripts still run, and that the ambient glow reads as atmosphere rather than as flicker across a run that screenshots on every step. ← (verify: the operator-reported symptom was "nothing appears at all"; only a live run closes it, and passing unit tests did not catch it the first time)

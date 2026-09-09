## Context

`extension/overlay/pointer-overlay.js` is a classic (non-module) script injected with `chrome.scripting.executeScript`, mounted into a **closed** shadow root, written as one IIFE with named top-level function declarations. That structure is load-bearing: `test/_extract.mjs` pulls each pure function out of the shipped file by brace-matching and unit-tests it in plain Node, with no bundler and no browser. Renaming or inlining a function removes it from test reach.

The layer is a spectator on the action-event stream (`extension/events/action-events.js`), relayed by `extension/background.js`. It never invents a pointer position, a click, an active state or an approval decision that a real dispatched event did not report. That rule survives this change unchanged.

The reference for the new structure is `alibaba/page-agent`, specifically `packages/page-controller/src/mask/SimulatorMask.ts` and its two stylesheets. It solves the same problem — draw an agent's pointer over a page it is driving — with an inverted lifecycle: mount once in the constructor, toggle one class, dispose explicitly. Paths cited below are paths in that repository.

**The faults this change closes**, each verified in the current working tree. An earlier draft called each one "independently sufficient to produce a blank page"; adversarial review disproved that, and the claim is withdrawn. RC1 delays, RC3's worst case is a 2s blank per capture (the working tree already orders `show` behind its own `hide` and bounds a lost `show` at `CAPTURE_HIDE_MAX_AGE_MS`), RC4's two writers reconverge within one 250ms tick, RC5 is diagnosability rather than behaviour, and RC6 is cosmetic. They are real defects and worth closing, but **which one produced the operator's blank page is not established** — see RC7 and task 0.1, which is a gate, not a step.

| Id | Fault | Verified at |
|----|-------|-------------|
| RC1 | The run-start raise is a no-op for an unscoped run: `startOverlayForRun()` returns at `if (!runId \|\| !Array.isArray(tabScope) \|\| tabScope.length === 0) return`, and `tabScope` is the string `"any"` whenever the panel bound no page context. **Corrected after review:** this is narrower than first written. `page-context.js` binds the active tab on `start()` and re-binds in `captureForSend()`, so `sidepanel.js:1618` normally sends `[tabId]`; `"any"` is the cleared-chip / no-active-tab / no-`pageContext` case. And even then the first tool call carrying `args.tabId` raises the overlay through `forwardActionEventToOverlay`. **RC1 delays the raise; it does not blank the run.** | `extension/background.js:1272-1285`, `extension/sidepanel/page-context.js:132-148,238-252`, `extension/sidepanel/sidepanel.js:1618`, `extension/background.js:930,1162-1168`, `host/agent/session/run.js:40,84` |
| RC2 | Hidden is the default of every failure branch. `createOverlayHost()` sets `host.style.visibility = "hidden"` at creation, and `paintOverlay()` early-returns with `visibility = "hidden"` whenever `!renderModel.active`. `active` derives from `lastEventAt` within `HEARTBEAT_MAX_AGE_MS`, which depends on the keepalive, which depends on RC1. | `extension/overlay/pointer-overlay.js`, `createOverlayHost()` / `paintOverlay()` |
| RC3 | The capture suppression is two uncorrelated messages. `requestOverlayHide()` and `requestOverlayShow()` are separate `sendOverlayMessage` calls with no shared id; a lost `show`, or a `hide` that lands after its own `show` because it had to inject first, leaves the layer hidden over a live run. The working tree's `CAPTURE_HIDE_MAX_AGE_MS` bounds the damage but does not remove either failure. | `extension/background.js:2352,2357`, called at `~2412` and in the `finally` at `~2585` |
| RC4 | Two writers own one property. `paintOverlay()` writes `host.style.visibility` every 250ms off the heartbeat; `setCapturedHidden()` writes the same property out of band, deliberately bypassing the render scheduler. Last writer wins, and neither reads the other's intent. | `extension/overlay/pointer-overlay.js`, `paintOverlay()` / `setCapturedHidden()` |
| RC5 | Mount is lazy and conditional. `attach()` is reachable only from `handleOverlayEvent()`, so if message delivery is what is broken the node is never created — making "not injected", "no run tracked" and "tracked but hidden" one indistinguishable blank page. | `extension/overlay/pointer-overlay.js`, `handleOverlayEvent()` |
| RC6 | The cursor teleports. `paintOverlay()` writes `left`/`top` straight from the event coordinates, so between sparse action-events the pointer jumps across the viewport with nothing in between. | `extension/overlay/pointer-overlay.js`, `paintOverlay()` |
| RC7 | **Candidate, unverified — the most likely single cause of the reported symptom.** Both the working tree and this design rest on the assumption that `chrome.tabs.sendMessage` *rejects* when no listener answers. If it instead resolves `undefined`, `sendOverlayMessage()` takes its success branch, `logOverlayDelivery(tabId, "delivered")` fires, and the injection retry **never runs** — so a document without the overlay never gets one, silently, while the service-worker log claims delivery. This cannot be settled by reading this repo. Its signature is unmistakable at runtime: `[browzy-overlay-bg] tab N: delivered` with no `[browzy-overlay] script loaded` in the page console. | `extension/background.js:1096-1127`, `extension/overlay/pointer-overlay.js:987-999` |

## Goals / Non-Goals

**Goals**

- Make the layer's on-screen state a function of one value computed in one place, so a failure names itself instead of looking like an untouched page.
- Close RC1–RC6 at their causes, not by adding another fallback on top of them.
- Keep section 1 a set of pure, extractable functions. (An earlier draft said `paintOverlay()` is "the only function that touches the DOM". That was never true - `createOverlayHost()`, `attach()` and `setCapturedHidden()` all do - and D5 adds another writer deliberately. The real invariant is narrower and is stated in D5: exactly one writer per property.)

**Non-Goals**

- Not a visual redesign. The Aurora palette, the swept edge, the cursor label, the bottom-centre status bar and the three bar states all stay exactly as the archived `2026-09-07-redesign-remote-control-overlay` settled them. The cursor's *size* changes (D9) and nothing else about the visual language does.
- Not a new escape hatch. Blocking is designed so the controls that already exist stay sufficient — no keyboard shortcut, no `chrome.commands`, no manifest edit.
- Not a rewrite of the state machine. `reduceOverlayState()` keeps its signature and its semantics.
- No change to how actions are dispatched, timed or ordered; the overlay stays off the dispatch path.
- No change to `tabScope`'s meaning, its default, or who sets it. This change reads it.
- No host-side change, no schema change, no manifest change.

## Decisions

### D1. Mount eagerly at script load; `attach()` leaves the message path

`attach()` is called once as the IIFE runs, next to the existing `logOverlayMessage("script loaded", ...)`. `handleOverlayEvent()` keeps calling it, which stays a no-op because of the existing `if (refs) return`.

*Pattern:* `SimulatorMask`'s constructor ends with `document.body.appendChild(this.wrapper)` — the node exists from construction, before any event, and `show()` only flips `.visible`.

*Closes:* RC5. A page carrying the script always carries the node, so `document.querySelector('[data-browzy-overlay]')` distinguishes "script never ran" from "script ran, run not active" — which today are the same blank page.

*Why this is safe:* the node is created with no visible state and `paintOverlay()`'s own gate (D2) is what reveals it. A mounted-but-inactive overlay draws nothing, exactly as an unmounted one did. The existing document-replacement recovery in the heartbeat (`refs = null; attach()`) already proves an out-of-band `attach()` never spuriously claims a run is active: the next repaint still runs the model against the same state.

*Alternative rejected:* mounting on the first heartbeat tick. It is 250ms of the same ambiguity for no gain, and it leaves `attach()`'s trigger implicit.

### D2. One authority for visibility: it is a field on the render model

`computeRenderModel(state, now, maxAgeMs, capturedHidden)` gains the capture flag as an input and returns `visible` alongside `active`. `paintOverlay()` becomes the only writer of the host's on-screen state and writes it from that one field. `setCapturedHidden()` records the capture lease and calls `scheduleRepaint()`; it no longer touches the DOM.

*Pattern:* `SimulatorMask` has exactly one visibility expression — `.wrapper { display: none }` / `.wrapper.visible { display: block }` in `SimulatorMask.module.css` — and one writer, `show()`/`hide()`.

*Closes:* RC2 and RC4. There is no second writer to race, and "hidden" stops being the fall-through of an early return: the model states which of `active` / `captured` / `visible` is in force, and the existing `lastPaintVerdict` logging reads that field instead of re-deriving it.

*Consequence to respect:* the working tree's `setCapturedHidden()` deliberately bypasses the render scheduler, because `requestOverlayHide()` is race-bounded on the background side and visibility must be correct by the time it resolves. Routing it through `requestRender` would reintroduce a frame of exposure inside a screenshot. So `scheduleRepaint()` gains a synchronous-paint path used only by the capture case: same single writer, no frame delay. This is the one place ordering matters more than coalescing, and it is why the capture flag becomes a model input rather than a second DOM write.

*Test consequence:* `paintOverlay()`'s `capturedHidden` parameter is removed. Existing tests that pass it are updated to set it on the model instead — the assertion (hidden during capture, state untouched) is unchanged.

### D3. The capture suppression is a correlated, self-expiring lease

`browzyOverlayCapture` carries `{ phase, captureId, maxMs }`. The overlay records `{ captureId, hiddenAt }`. It un-hides on a `show` whose `captureId` matches, on `hiddenAt + maxMs` elapsing, or on a `hide` with a newer `captureId` superseding the current one. A `show` for an unknown or already-superseded id is a silent no-op.

*`maxMs` comes from background's own bound, not a constant.* A capture is hide-wait (<=150ms) + paint settle (<=500ms) + evaluate + capture, plus a blank-retry recapture (`background.js:2434-2441,2524-2539`), which on a heavy page can exceed the working tree's 2000ms `CAPTURE_HIDE_MAX_AGE_MS` - the overlay would then un-hide *into* the retry capture. Background mints the lease, so it sends the bound it actually intends to spend.

*Closes:* RC3 at both its failure modes — a lost `show` costs `maxMs` instead of the run, and a `hide` that lands after its own `show` no longer wins, because that `show` already retired its id.

*Why not page-agent's marking pattern here:* `SimulatorMask` keeps itself out of the agent's view by carrying `data-browser-use-ignore` / `data-page-agent-ignore` (`SimulatorMask.ts:28-29`, `Panel.ts:394-395`) and letting the extraction pipeline skip it — no message, no round trip, no ordering hazard. That does not transfer to screenshots: Browzy captures via CDP `Page.captureScreenshot`, which rasterises the composited frame, and no DOM attribute can exclude a node from the compositor. The layer genuinely must be hidden. The lease is therefore the root-cause fix available at this boundary, and it is a bounded-lease design rather than the elimination of the round trip — stated here so a later reader does not mistake it for the marking pattern.

*Where the marking pattern does transfer:* see D4.

### D4. The overlay host is excluded from DOM extraction by marking

The host node already carries `data-browzy-overlay="1"`. Nothing reads it: `extension/content.js` has no reference to it, so `read_page`, `get_page_text` and `find` can report the overlay's own node as page content. The extraction path learns to skip any subtree carrying that attribute.

*Pattern:* directly `SimulatorMask.ts:28-29` and `Panel.ts:394-395` — the overlay declares itself not-content, and the reader honours it.

*Scope note:* the shadow root is closed, so the overlay's inner markup is already unreachable; this closes the host element itself and any future light-DOM sibling. It is included because it is the half of page-agent's ignore pattern that genuinely applies, and because an overlay that appears in a read is a way for the layer to corrupt the agent's own view of the page it is drawing on.

### D5. The cursor eases toward a target on `requestAnimationFrame`

`state.cursor` becomes the *target*. A rAF loop moves the drawn position toward it — the drawn position is not state and is never read by the reducer or the model. The loop snaps to the target when the remaining distance falls below a small threshold, and stops when the layer is not visible.

*Pattern:* `SimulatorMask.#moveCursorToTarget()` — a permanent rAF loop, `new = current + (target - current) * 0.2`, snap when the axis distance is under 2px, with `setCursorPosition(x, y)` only ever writing the target.

*Closes:* RC6.

*Truthfulness constraint, and it is the reason this needs stating:* the eased path passes through coordinates the agent never dispatched. Drawing a *pointer* there is honest — a physical pointer also passes through coordinates nothing was clicked at — but drawing anything that asserts an action there is not. So the click ripple stays bound to a real `phase: "down"` in `pointer.points[]` and fires at the dispatched coordinate, never at an interpolated one; the action label follows the same rule it already does. A `teardown` or heartbeat expiry stops the loop rather than easing the cursor to a resting place, because there is no run left to attribute the motion to.

*Resolving the two-writer conflict, which an earlier draft left open.* `paintOverlay()` writes `cursorEl.style.left/top` today on every event **and** on every 250ms heartbeat tick (`pointer-overlay.js:821-825`, `:972-985`). If the rAF loop also wrote those properties, the heartbeat would snap the cursor to the target four times a second and the easing would be visibly defeated. So ownership is split explicitly: **`paintOverlay()` publishes the target and stops writing `left`/`top`; the rAF loop is the sole writer of those two properties.** Every other property `paintOverlay()` writes is unchanged and still exclusively its.

*Accepted consequence:* the click ripple is positioned on the same paint (`:824-825`) and therefore appears at the dispatched coordinate while the eased cursor is still travelling toward it. That is the correct trade: the ripple marks where the click actually landed, and moving it to the cursor's interpolated position would put a claimed action at a coordinate nothing was dispatched at - the fabrication this module's header forbids.

*Interaction with the parked state:* the working tree's `.is-parked` cursor is positioned by CSS, not by inline `left`/`top`. Easing applies only to a real pointer position; entering or leaving parked is a state change, not a movement to interpolate.

### D6. Input blocking is adopted, but at neither of the two obvious layers

> **Naming note.** The archived `2026-09-07-redesign-remote-control-overlay` design also has a decision "D6" (no grant control on the controlled page), and `pointer-overlay.js:42-49` cites it by that letter. That decision still stands and is untouched. Cite it as *archived D6*; the D6 below is this change's own.

Blocking the operator's input while the agent drives is a product requirement (see D8). This decision records the two mechanisms that look right and are not, so neither is reintroduced.

**Not page-agent's mechanism — a hit-testing wrapper.** `SimulatorMask` gives its wrapper `pointer-events: auto` and calls `stopPropagation()` + `preventDefault()` on click, mousedown, mouseup, mousemove, wheel, keydown and keyup, opening a hole only on a `PageAgent::EnablePassThrough` event. That works for page-agent because it dispatches straight at a resolved element — `packages/page-controller/src/actions.ts` calls `target.dispatchEvent(new PointerEvent(...))` and `target.click()`, never a hit test. Browzy dispatches CDP `Input.dispatchMouseEvent` at viewport coordinates, and a hit test lands on whatever occupies that coordinate. A capturing wrapper at `z-index: 2147483647` sits in front of every target the agent is aiming at, so the agent would swallow its own clicks. Browzy's `pointer-events: none` invariant therefore stands, and is still asserted by its existing test.

**Not CDP `Input.setIgnoreInputEvents` either — it blocks our own input too.** This looked like the correct primitive and is not. `InputHandler::DispatchMouseEvent` calls `InjectMouseEvent()`, which calls `widget_host_->ForwardMouseEvent(...)` — the same ordinary `RenderWidgetHostImpl::Forward*` entry points the ignore flag guards with an unconditional `if (IsIgnoringWebInputEvents(event)) return;`. The event carries no "came from DevTools" bit, and although Chromium ≥128 added a `WebInputEventAuditCallback` slot that could exempt injected events, `content/browser/devtools/protocol/input_handler.cc` passes `std::nullopt` — "ignore everything" — with no way for a CDP client to change it. Verified at tags `116.0.5845.97` (this extension's `minimum_chrome_version`), `120.0.6099.109`, `128.0.6613.113` and `main`: the mechanism was refactored from a bool to a refcounted scoped token, but the drop semantics never changed.

Sources: [`input_handler.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/input_handler.cc), [`render_widget_host_impl.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/renderer_host/render_widget_host_impl.cc), [`web_contents.h`](https://raw.githubusercontent.com/chromium/chromium/main/content/public/browser/web_contents.h).

Two properties of that flag are worth recording even though it is rejected, because they are what a future reader will want to re-check before proposing it again: it is scoped to one tab's `WebContents` (the omnibox, tab strip and a separately hosted extension side panel are unaffected), and it is released on `Input.disable` or on any session teardown — `DevToolsSession::Dispose()` calls `Disable()` on every handler — so a detach cannot strand a tab input-dead. Those are good properties. They do not rescue it: an agent that cannot click is not a lesser problem than an operator who can.

*The remaining layer is the page's own event pipeline, which is where D8 goes.*

### D7. The unscoped run raises through the tab group it already resolves

`startOverlayForRun()` keeps its guard on `runId`, but when `tabScope` is not an array it falls through to `addGroupTabsToOverlayRun(runId)` — the function that already exists, already skips pages no extension may script, and is already called on every keepalive tick — and raises on whatever that resolves.

*Closes:* RC1, without redefining `tabScope`. An unscoped run really is holding the operator's tab group; the group is the honest answer to "which pages is this run on", and it is the same answer the keepalive path already gives one second later. This change makes the run's opening consistent with its middle, rather than inventing a tab.

*Consequence:* a run whose group resolves to nothing still raises nothing, and still falls back to the first action-event carrying a `tabId`. That is correct — there is no page to mark.

### D8. Operator input is blocked by capture-phase listeners, gated on the run's own action state

Both hit-testing (D6, first half) and the browser-level flag (D6, second half) are out. What remains is the page's own event pipeline, reached from the overlay script itself.

**What is suppressed.** Capture-phase listeners registered on `window` for `pointerdown`, `pointerup`, `pointermove`, `mousedown`, `mouseup`, `click`, `auxclick`, `dblclick`, `contextmenu`, `wheel`, `keydown`, `keypress`, `keyup`, `beforeinput`, `touchstart`, `touchmove`, `touchend`, `paste` and `drop`, each suppressed with `preventDefault()` + `stopImmediatePropagation()`.

Three registration details are load-bearing, and an earlier draft got all three wrong:

- **`{ capture: true, passive: false }` is mandatory.** `wheel` and `touch*` listeners on `window` are passive by default in Chrome, and `preventDefault()` on a passive listener is ignored. Registered the default way, operator scrolling is not blocked at all.
- **Pointer events must be in the list.** Suppressing `mousedown` does not suppress `pointerdown`; React and most current libraries listen to pointer events, so a mouse-only list leaves the page fully interactive for them.
- **`beforeinput`, `keypress` and `paste` must be in the list.** IME composition inserts text regardless of a `keydown` `preventDefault()`, and paste is not a key event at all.

**Only trusted events are suppressed.** The handler returns immediately unless `event.isTrusted === true`. Page-internal synthetic events - a framework's own `el.dispatchEvent(...)`, and `extension/content.js:776`'s own `target.click()` in `setFormValue` - are untrusted and must pass, or the overlay silently breaks the page's own behaviour and the extension's own form filling. Operator input and CDP-injected input are both trusted, so this filter separates "the page's scripts" from "a human or the agent", which is exactly the cut needed.

**Exemption 1 - the overlay's own controls.** An event whose `target` is the overlay host node is always let through. The shadow root is closed, so an event inside it is retargeted to the host, which makes one identity comparison cover the whole overlay. This keeps Stop and Open panel usable while the page is locked, and is why this change needs no `chrome.commands` shortcut and no manifest edit.

*Known limitation, solved rather than merely noted:* with `keydown` suppressed on page targets, `Tab` cannot move focus from page content into the shadow root, so a keyboard-only operator could not reach Stop. `Tab` and `Shift+Tab` are therefore exempted - they move focus and nothing else, so letting them through costs nothing and restores the keyboard route to Stop.

**Exemption 2 - the agent is acting.** The overlay suppresses only while `state.actionInFlight` is false.

This replaces the pass-through lease an earlier draft specified. That lease was a new `browzyOverlayInput` message pair, awaited before every dispatch, with a `maxMs` expiry - and adversarial review found it broken in three independent ways:

1. Its `maxMs` could not cover a real action. `type` awaits `rawKeyDown` + `insertText` + `keyUp` + a 10ms sleep **per character** (`extension/background.js:3737-3760`), so 300 characters is over ten seconds, and any single CDP command may take `CDP_TIMEOUT_MS = 20000` (`:1969`). A lease expiring mid-action means the blocker eats the agent's own remaining input.
2. Its fail-open was silent, not visible. The draft claimed a swallowed action "is reported as a failure through the existing action-event path". It is not: `hitNote`/`probeHit` run **before** dispatch (`:3545-3571`, comment "Probe BEFORE dispatching") and `outcome.status` is `deriveOutcomeStatus(hitNote)` (`:3585`, `:908-912`), so a swallowed click still reports `success` and the model proceeds believing it clicked.
3. It put an awaited message round trip on the dispatch path, which every other decision here is careful to stay off.

`actionInFlight` has none of those properties. It is already in the overlay's state, set from the real `start`/`progress` events and cleared on `complete`/`error` (`extension/overlay/pointer-overlay.js:191-200,288-328`), so the pass-through window is *exactly* the action's own duration however long that is, no new message exists to lose, and nothing is added to the dispatch path.

*The residual race, and how it is made non-silent.* `emitActionStart()` runs synchronously before `await handler(args)` (`background.js:4924`), so `start` is **emitted** before any CDP command. But it is **delivered** by `chrome.tabs.sendMessage` while the dispatch goes out over `chrome.debugger.sendCommand` - two independent async paths with no ordering guarantee. In the click path the dispatch is preceded by the pre-dispatch probe, itself a full `Runtime.evaluate` round trip (`:3545-3571`), which gives the message a large head start; other paths have no such buffer. So the race is small but real, and its failure mode is the silent one from (2) above. It is closed by detection rather than by pretending it cannot happen: when the blocker suppresses a **trusted** event and an action `start` for this run arrives within a short window afterwards, the overlay reports that suppression to the service worker, and background attaches it to that action's outcome as a warning. The agent then sees "this click may not have landed" instead of `success`.

*Brave's late wheel:* `sendMouseEvent` returns for `mouseWheel` after a bounded race rather than a real acknowledgement, and the file documents that Brave never acks a wheel and applies it late (`background.js:2617-2633,2661-2676`). The wheel can therefore arrive after `complete` cleared `actionInFlight`, and be suppressed. Scroll actions keep a tail: `actionInFlight` is treated as still true for the ack window after a scroll action settles.

*Alternative rejected:* delaying every dispatch until the overlay acknowledges. That is the lease again, with its cost and its expiry problem, to close a race that detection closes for free.

**Lifetime.** Suppression is in force only while the overlay is active, and the predicate calls `isHeartbeatExpired(Date.now(), ...)` **at event time** - never a cached boolean, because a cached one survives the timer that would have refreshed it (see the `pagehide` hazard below). Run end, Stop, companion loss, debugger detach, tab removal or the keepalive simply stopping all release the page within 3 seconds.

**Teardown is the dangerous part, and two existing paths are broken for it:**

- `pagehide` currently only clears the heartbeat timer (`pointer-overlay.js:1063-1065`). On a bfcache restore the document comes back with the window listeners registered, the D10 style element present, and no timer to expire anything. `pagehide` must remove the listeners and the style element and hide the host, not just stop the clock.
- `window.__browzyOverlayDispose` calls `chrome.runtime.onMessage.removeListener` **first** (`:1054-1061`). After an extension reload that context is invalidated, the call throws, the caller's `try/catch` swallows it (`:60-64`), and everything after it - `clearInterval`, host removal, and now the listener and style-element removals - never runs. The order must invert: DOM and timer cleanup first, `chrome.*` last in its own `try`.

**Scope.** The tabs the run holds - the `overlayRunTabs` set the overlay already draws on. Note the consequence, which is a deliberate acceptance and not an oversight: `addGroupTabsToOverlayRun()` (`:1205-1224`) puts every tab in the operator's group into that set, so a grouped tab the agent has not touched is also locked. That matches "the run holds these pages", which is what group membership means here.

**Gated on a real run.** Blocking requires `state.runId != null`. Legacy MCP actions carry no `runId` but still raise the overlay (`background.js:1168`), and without this gate they would lock the page in 3-second windows with no run, no `run_started` and no teardown to end them.

**Lifted while an approval is pending.** A run blocked on the operator's decision needs that operator to be able to read the page - scroll it, hover it, look at what is about to be submitted - before allowing or denying. Locking the page during the one moment its content matters most would make the approval decision less informed, which defeats the point of asking.

**A caveat that belongs in the product's own words, not only here.** This is a guard against the operator's stray click, not an enforcement boundary. A page that registered its own capture-phase listener on `window` before the overlay was injected can call `stopImmediatePropagation()` first and never reach it. The spec states blocking as behaviour, never as a guarantee.

### D9. The cursor is drawn at page-agent's size

`--cursor-size` goes to roughly 72px, against the 26px `CURSOR_SVG` currently draws. page-agent's `cursor.module.css` uses `var(--cursor-size, 75px)`; the value here is that, rounded to the nearest even size that keeps the existing SVG's proportions intact.

Three measurements move with it, and none of them scale linearly, so each is retuned rather than multiplied: the label's `left: 21px; top: 20px` offset (it must clear the larger arrow), the hot-spot correction `transform: translate(-4px, -3px)` (the tip must still sit on the dispatched coordinate — this is the one that silently makes every drawn position wrong if it is missed), and the two 66px ripples with their `left/top: -33px` centring.

*Viewport edges:* at 72px with a label beside it, a cursor near the right or bottom edge can push its label off-screen. The label flips to the other side of the arrow when it would overflow.

*Consequence accepted:* a 72px cursor covers noticeably more of the page than a 26px one. It remains `pointer-events: none`, so it never blocks anything — and under D8 the operator is not clicking through it anyway.

### D10. The lock announces itself through the system cursor

A lock with no visible sign is worse than no lock: the operator clicks, nothing happens, and they cannot tell "blocked" from "page frozen". page-agent solves this with `cursor: wait` on its full-viewport wrapper (`SimulatorMask.module.css`), which works because that wrapper hit-tests.

Browzy's overlay is `pointer-events: none` and must stay that way (D6), so it never receives the pointer and cannot set the cursor for it. The cursor is therefore set on the page itself: while blocking is in force, the overlay appends a `<style>` element to the document and removes it the moment blocking ends.

**The selector matters, and an earlier draft got it wrong.** `cursor` is inherited, not cascaded onto descendants: a document-level `html { cursor: wait }` loses to any page rule on a descendant, and `a { cursor: pointer }` is on nearly every page. The rule must be `*, *::before, *::after { cursor: wait !important }`. Even then it loses to a page's own `!important` cursor, does not cross into iframes, and reaches shadow roots only by inheritance - so this is a strong signal, not a total one, which is consistent with what D8 says about blocking generally. The overlay's own `.browzy-stop { cursor: pointer }` (`pointer-overlay.js:547`) lives inside the overlay's shadow root and correctly survives.

**Bound to the run, not to the action.** The wait cursor follows `active && runId && !pendingApproval` - the same condition as blocking itself - and specifically **not** the agent's action state. Tying it to D8's pass-through would flip the system cursor wait -> normal -> wait around every dispatched action, several times a second during a click burst. The pass-through exists for the agent; it is not an invitation to the operator.

*This is the only place in this change where the overlay mutates the page's own styling*, and it is a deliberate, narrow exception. The constraints that make it safe:

- The style element carries `data-browzy-overlay`, so D4's extraction exclusion already covers it.
- It is removed on every path that ends blocking — approval pending, heartbeat expiry, teardown, `window.__browzyOverlayDispose`, and `pagehide` (both of the last two are themselves broken today; see D8's teardown notes). A leftover node means a page stuck showing a wait cursor, which is exactly the "hostage tab" class of failure this design refuses everywhere else, so removal is asserted per path rather than in one place.
- It sets the cursor and nothing else. No color, no layout, no visibility, no `user-select`.

*Alternative rejected:* announcing the lock only on the status bar. It is already the right place for the *words* (and the bar does gain a lock state — see tasks), but the bar is at the bottom of the viewport while the operator's attention is wherever they just clicked. The cursor is the only affordance that is guaranteed to be where they are looking.

*Alternative rejected:* `pointer-events: auto` on a transparent wrapper purely to own the cursor. That is the hit-testing layer D6 rules out — it would swallow the agent's CDP clicks.

### D11. The ambient glow is written here, not imported

The operator asked for page-agent's ambient layer. What page-agent renders is the `ai-motion` `Motion` element — a themed animated field mounted behind the mask, faded in on `show()` and out on `hide()`, with `isPageDark()` choosing its mode.

**The package cannot ship, but the effect can.** `extension/` has no build step: `package-extension.sh` copies the directory verbatim and every file is a classic script injected as-is, so an npm dependency would mean introducing a bundler for the extension. That objection is to `ai-motion` specifically, not to the effect — the glow is a gradient and a transform, and it is written directly into `OVERLAY_CSS` alongside the existing swept edge, costing no dependency and no build.

**Edge-weighted, not full-viewport, and that is the whole design.** A layer that tints the entire page would blink off and on continuously: the overlay is hidden around *every* screenshot and the agent screenshots on nearly every step. page-agent never hits this because it does not screenshot. So the glow is weighted to the viewport edges — a soft inward falloff that reinforces the existing frame and reads as an atmosphere around the page rather than a film over it. Its content region stays fully transparent, so a capture cycle removes and restores light at the borders instead of dimming and undimming everything the operator is reading.

*Constraints:* `pointer-events: none` like every other layer; it sits below the cursor, the ripples and the status bar and above nothing else; it is bound to the same `visible` field as the rest (D2), so it appears and clears with the run; and under `prefers-reduced-motion` its animation stops while the static glow remains, matching how the swept edge already degrades (archived D4).

*Theme:* page-agent picks light or dark from `isPageDark()`. The glow here is additive light at low opacity, which reads on both light and dark pages without sampling the page, so no equivalent probe is introduced.

## Risks / Trade-offs

- **Eager mount puts a node on every page the script is injected into, run or no run.** → It is one empty `div` with a closed shadow root, `pointer-events: none`, drawing nothing until the model says visible. The script is only injected into tabs the bridge already targets, so this adds no new pages. D4 keeps it out of extraction results.
- **A permanent rAF loop while the overlay is up.** → Compositor-only transform on a fixed layer, and the loop stops when the layer is not visible or the run ends, so it is bounded by the same 3s heartbeat as everything else.
- **The eased cursor lags the dispatched coordinate.** → By design, and bounded by the easing factor; the click ripple and action label remain pinned to dispatched coordinates, so nothing that asserts an action is ever drawn late or in the wrong place. The lag is visible on a long jump and is the price of the motion reading as motion.
- **`computeRenderModel()`'s signature changes.** → It is called from exactly two places (`scheduleRepaint()` and the `window.__browzyOverlay` debug hook) plus the tests, all in this change's scope. The tests are the regression net; `_extract.mjs` will fail loudly if the declaration is renamed rather than extended.
- **The capture lease's `maxMs` is a tuning value.** → Too short and it un-hides inside a slow capture, polluting the image; too long and a lost `show` costs more blank time. The working tree already picked 2000ms against a capture round trip typically well under a second; the lease keeps that number and adds correlation, so the trade-off is unchanged and only the reorder failure is removed.
- **A page that blocks the operator's input is a page they have partly lost.** → Mitigated at four levels, in order of how fast they act: the overlay's own Stop button stays live (D8 exemption 1); browser-level control is never touched, so the tab can be closed, switched away from, or navigated from the omnibox at any moment; the "Browzy is debugging this browser" infobar's Cancel detaches the debugger; and the block releases itself within 3s of the run going quiet. The residual risk is a run that is genuinely alive and genuinely holding the page — which is the state the operator asked to be locked out of.
- **A page's own script can call `stopImmediatePropagation()` first if it registered a capture listener on `window` earlier.** → The overlay is injected after `document_idle` on a page that may already have such a listener, so blocking is best-effort against a hostile or unusual page, not a security boundary. It is an ergonomic guard against the operator's stray click, and must not be described in the spec or the UI as a guarantee.
- **The pass-through lease adds one message round trip in front of every dispatched action.** → Measured against a CDP round trip that the same code path already awaits, this is small; but it is on the dispatch path, which every other part of this change is careful to stay off. It is here because a lock the agent cannot open is not a lock, it is a bug. The fail-open rule bounds the worst case to "as slow as it is today, plus one failed message".
- **Three green test suites say very little about what is on screen.** Review found a pre-existing example: `.browzy-badge { display: flex }` (`pointer-overlay.js:518`) and `.browzy-stop { display: inline-flex }` (`:543`) override the UA `[hidden] { display: none }` rule, so `badgeEl.hidden` / `stopButtonEl.hidden` (`:831`, `:849`) do nothing in a real browser - Stop is painted in the idle and waiting states where `overlay-pointer.test.mjs:552,604` assert it hidden. It is not a cause of the blank page, but it is proof that this change's own test tasks must not be read as visual verification, and task 12.1 is the only step that is. The fix (`.browzy-badge[hidden], .browzy-stop[hidden] { display: none }`) is in scope because D8 depends on Stop's visible state being real.
- **The wait-cursor style element is the one page mutation in this change, and a leftover one is a visibly broken page.** → Removal is a task per teardown path, not a single call site, and it is on the live-run checklist. The blast radius if it does leak is bounded: a wait cursor, no layout or interaction effect, cleared by any navigation.
- **The ambient glow still blinks at screenshot cadence.** → Reduced, not eliminated. Weighting it to the edges keeps the blink out of the region the operator is reading, and it blinks in step with the swept frame that already does, so it adds no new rhythm. If it still reads as flicker in the live run, the honest fix is to lower its amplitude, not to hide the capture.
- **A 72px cursor hides more of the page.** → Accepted per D9, and the label flips at the viewport edges so it does not add its own overflow.
- **Which of RC1–RC6 the operator actually hit is not established from a live run.** → All six are closed, so implementation is not blocked. But the diagnosis is code-verified rather than instrumented, and a run with the page console filtered to `browzy-overlay` (the working tree already emits `script loaded`, `host node created`, `paint: <verdict>` and `[browzy-overlay-bg] tab N: <outcome>`) would confirm it. Task 0.1 does this.

## Migration Plan

None required. The message layer stays backward-tolerant in both directions: an older injected overlay ignores the new `captureId`/`maxMs` fields and behaves exactly as it does today, and a newer overlay treats a `hide` with no `captureId` as an anonymous lease that only expiry can clear — which is the current behaviour. `browzyOverlayInput` is likewise additive: an older overlay does not recognise it and simply never blocks, and a newer overlay that never receives one blocks nothing, because blocking is only in force while the overlay is active and a background that does not send leases is a background that also drives nothing. The visual layer is replaced on next extension reload. No stored state, no persisted format, no host-side coordination. Rollback is reverting three source files.

## Open Questions

None blocking. The one unresolved fact — which fault the operator's own run hit — is recorded as a risk above and as task 0.1, and does not change any decision here, because every path is closed regardless of the answer.

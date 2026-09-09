## Why

The remote-control overlay tells the operator that an agent is driving their page, but it currently does so badly. A solid 2px terracotta ring with a 22px inset glow reads as an error banner rather than a live session; the status badge hops between viewport corners as the cursor moves, so the one control that matters (Stop) is never where the eye last left it; and the cursor is an unlabelled arrow that says neither who is moving it nor what it is doing. On a page the operator did not expect to be driven, "something is wrong here" is exactly the wrong message.

A design direction ("Aurora") was explored across four artboards and settled with the operator. This change implements it, and closes one gap the design work exposed: the overlay has no way to know a run is blocked waiting for the operator's approval, because `approval_request` travels as its own envelope and never reaches the overlay bridge.

## What Changes

- **BREAKING (visual only, no API):** the overlay's entire visual layer is replaced. The terracotta palette (`#C4785B`) is dropped in favour of a cyan/violet pair; every existing measurement in `OVERLAY_CSS` changes.
- **Edge treatment**: the static inset glow becomes a conic-gradient band that sweeps the viewport edge on a 7s cycle, over a permanent low-opacity ring so the outline never breaks, plus four corner brackets. Under `prefers-reduced-motion` the sweep stops and the brackets plus static ring are what remain — the reduced-motion path stops being "no feedback at all".
- **Cursor**: gains a name tag reading `Browzy` plus the action in flight, derived from the `action.type` the event already carries. Three states — acting, dragging, idle.
- **Click feedback**: the single 28px ring becomes two 66px ripples offset by 0.45s, which reads as one beat rather than a flicker that is easy to miss.
- **Status bar**: **BREAKING (behaviour):** the badge stops following the cursor between viewport corners and anchors to bottom-centre. `computeBadgeCorner()` and every corner-selection path are removed. The bar gains a session step count and elapsed time, both derived from events already delivered.
- **New: an approval-pending state on the overlay.** A `approval_request` observer is added alongside the existing `stream_event` observer in `handleAgentMessage()`, delivering over the existing `sendOverlayMessage` path. The overlay shows what is waiting and that the operator must act — **display only**. See the decision below.
- **Deliberately NOT added: Allow/Deny buttons on the overlay.** The settled design drew them; implementation drops them, and this is the one place this change departs from the design. Reason, verified in code rather than assumed: the agent's own clicks are dispatched through CDP `Input.dispatchMouseEvent` (`extension/background.js:2107`), which is browser-level synthetic input — it carries `isTrusted === true` and it lands on whatever occupies the coordinate, closed shadow roots included. The overlay host sits at `z-index: 2147483647`. An Allow button on that surface would therefore be inside the pointer reach of the very agent asking for permission, and no `isTrusted` check can tell that click apart from the operator's. Approval stays in the side panel, which the agent cannot reach; the overlay routes the operator there.

## Capabilities

### New Capabilities

None. This changes how an existing capability behaves, not what the product can do.

### Modified Capabilities

- `browser-assistant-panel`: the "Visible agent pointer and control status" requirement gains behaviour it does not currently state — that the control indicator holds a fixed position rather than tracking the cursor, that the cursor identifies the agent and its current action, that a reduced-motion viewer still gets a persistent static indication, and that a run blocked on approval is visible on the controlled page without the approval decision itself being takeable there.

## Impact

**Code**

- `extension/overlay/pointer-overlay.js` — the bulk of the change. `OVERLAY_CSS`, `CURSOR_SVG`, `createOverlayHost()`, `paintOverlay()`, `computeRenderModel()` and `reduceOverlayState()` are all touched; `computeBadgeCorner()` is deleted.
- `extension/background.js` — one added observer in `handleAgentMessage()`, reusing `sendOverlayMessage`. No new channel, no change to `forwardActionEventToOverlay` / `startOverlayKeepalive` / `teardownOverlayForRun` / `teardownAllOverlays`.
- `test/overlay-pointer.test.mjs`, `test/overlay-background-bridge.test.mjs` — updated for the new visual layer and the approval channel. Every existing safety assertion is kept: they are the regression net for the invariants below.

**Invariants this change must not break** (each is asserted by a test that exists today)

- classic script, no top-level `import`/`export` — the file is injected with `chrome.scripting.executeScript`
- `pointer-events: none` everywhere except the deliberate controls; the overlay never swallows a page click
- heartbeat expiry within 3s of the last signal (`HEARTBEAT_MAX_AGE_MS` 2700 + 250ms check interval)
- a `keepalive` refreshes liveness only — it never moves the cursor or invents a click
- teardown on run end, companion loss, debugger detach, document replacement
- `capturedHidden` hides the overlay around a screenshot without touching state

**Known, unchanged, out of scope**

The existing Stop button is reachable by the agent's own CDP clicks for the same reason the Allow button would be. Unlike Allow, that is harmless — an agent stopping itself costs nothing and undoes nothing — so it is recorded here rather than fixed.

**Not affected**

No host-side change (`host/**`), no protocol version change, no manifest change, no new permission.

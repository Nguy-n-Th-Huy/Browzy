# Proposal: The Locked Page Answers No Operator Input

## Why

Seen live by the operator: while a run holds the controlled page (the overlay shows "Trang đang bị khoá" and the wait cursor), the page no longer accepts clicks — but the operator's pointer still **hovers** page content: buttons light up, hover-only menus and tooltips open, the page is half-usable exactly where the lock exists to prevent interference. Blocking trusted events cannot fix this: CSS `:hover` and hover menus are decided by the browser's hit-testing, not by JS events, so suppressing `mousemove`/`mouseover` in capture phase changes nothing about them.

## What Changes

- **A full-viewport input shield, active exactly while the page is locked for the operator**: one element inside the overlay's shadow root (above page content, below the indicator's own controls) that takes the pointer so hit-testing never reaches the page — no hover state, no tooltip, no hover-only menu, no click, no wheel scroll, no text selection or drag. It carries the same wait cursor the page-level lock already shows, so the operator learns from looking.
- **One predicate, two enforcement layers**: the shield activates under the same `shouldBlockInput()` truth the event suppression already uses — a run holds the page, the heartbeat is fresh, no approval is waiting, and no action of the agent's own is in flight (nor a scroll tail). The agent's own dispatched input therefore always reaches the page; the approval window stays readable; the keyboard suppression already in place is unchanged.
- **Unchanged**: the host stays `pointer-events:none` (the shield is the one deliberate exception, and only for page content while locked), the cursor/frame/glow layers stay non-interactive, Stop/Open-panel stay operable, screenshots keep hiding the whole layer, and teardown removes the shield with the host.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `browser-assistant-panel`: adds "A locked page answers no operator pointer input" (the suppression requirement with its scenarios).

## Impact

- **Extension**: `extension/overlay/pointer-overlay.js` (the shield element + its CSS + the predicate wiring in the paint path), `test/overlay-pointer.test.mjs`.
- **User-visible**: while locked, moving the mouse over the page shows nothing happening — the wait cursor and the indicator are the only live surface.

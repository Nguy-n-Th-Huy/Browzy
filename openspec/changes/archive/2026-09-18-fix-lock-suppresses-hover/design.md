# Design: The Locked Page Answers No Operator Input

## Context

- The overlay's input blocking (`pointer-overlay.js`): `shouldBlockInput(state, nowMs, maxAgeMs, scrollTailUntilMs)` — true iff a run holds the page (`runId` set), the heartbeat is fresh, no approval is pending, and nothing of the agent's own is in flight (actionInFlight/scroll tail exempted, because CDP-dispatched input is trusted and must not be swallowed). `handleBlockableEvent` applies it to capture-phase listeners; the page-level wait cursor and the badge's "Trang đang bị khoá" follow the broader `locked` render flag.
- **Why events are not enough**: `:hover`, tooltips and hover menus are hit-test driven; suppressing `mousemove`/`mouseover` does not stop them. The only way to keep the pointer off page content is for something else to win hit-testing.
- The overlay already owns the stacking space: host under `document.documentElement`, closed shadow root, layers at the extreme z-index range; the badge's Stop/Open-panel buttons are the only interactive elements.

## Goals / Non-Goals

**Goals:** while the page is locked for the operator, page content answers NO pointer interaction of the operator's — hover included; the operator still sees the lock (wait cursor, badge) and can still reach Stop/Open-panel; the agent's own dispatches are never affected.

**Non-Goals:** no change to the keyboard suppression, the heartbeat, the approvals flow, the cursor rendering, or the page-level wait-cursor style; no change to when the lock applies (the predicate is reused, not redefined).

## Decisions

### 1. One shield element, toggled by the existing predicate

`createOverlayHost` gains `shieldEl` (`.browzy-shield`, `position:fixed; inset:0`, transparent, `cursor:wait`, `z-index:2147483644` — above realistic page content and the decorative layers' role, below the badge at 2147483647 so the indicator's own controls keep winning hit-testing). Its default is `pointer-events:none`; `.is-active` flips it to `auto`.

The paint path sets it from the SAME call the event suppression makes: `setInputShieldActive(shouldBlockInput(state, now, HEARTBEAT_MAX_AGE_MS, scrollTailUntil))`. One truth table, two enforcement layers (the listeners stay as defence in depth — keyboard, and any pointer event that races the class toggle). The 250 ms repaint plus the per-event repaint already cover every transition: heartbeat expiry, start/complete events, the scroll tail's deadline, approvals, teardown.

- *Alternatives rejected*: blocking `mouseover`/`mouseenter` events (cannot stop `:hover`/tooltips — the bug); making the whole host `pointer-events:auto` (would permanently intercept page input and break the untouched "the host never intercepts" invariant); hiding page content or blurring it (destroys the operator's ability to read the page during approvals).

### 2. The wait cursor rides the shield

While the shield is up, the pointer sits over it — so `cursor:wait` on the shield itself keeps the "the page is locked" lesson the page-level style provided, including on elements whose own CSS sets a different cursor.

### 3. The agent always keeps the page

`shouldBlockInput`'s exemptions carry over verbatim: in-flight action and scroll tail → shield off; pending approval → shield off (the operator must be able to read and scroll the page being asked about); heartbeat expired or no run → shield off. A shot aimed at the agent's own dispatch is therefore impossible, and the lock's residual race window is exactly what it already was for events.

### 4. The wheel needs the event layer too (shipped during implementation, evidenced)

Hit-testing alone does not stop a wheel: Chrome's scroll chain starts at the hit-tested node and runs up to the document, so a wheel over the shield still scrolled the page (measured: 500 px), and `overflow:hidden` on the shield did not help (500 px) while a non-passive `preventDefault` did (0 px). Every event inside the closed shadow root retargets to the host, which the blockable-event handler already exempts so the overlay's own controls stay usable — so the exemption is now skipped for the two scroll gestures while the predicate says blocked (`blocked && (wheel || touchmove)`); clicks and keys keep it, which is what leaves Stop and Open-panel clickable. Both layers consult the same `shouldBlockInput` truth, so the agent's in-flight input and the scroll tail remain untouched (verified: the agent's own wheel scrolls while the shield is off).

## Risks / Trade-offs

- **[An operator event in the instant between an action's `start` and the class toggle]** → the same window that exists today for events (task 7.5/7.6); the shield re-arms on the next repaint, and the class toggle runs on the same render pass as the cursor.
- **[A page that pins a stacking context above 2147483644]** → the shield would lose hit-testing there; the event suppression still covers it, exactly as today.
- **[Sites that read `:hover` for layout]** → that is the point of the lock: nothing on the page should react until the run ends.
- **[Top-layer content (a `<dialog>`/popover/fullscreen surface) renders above every z-index, the shield included]** → such a surface can still take the operator's hover; the overlay's own cursor sits under the same ceiling, the case is rare, and the event layer still suppresses its clicks. Documented, not fixable from the extension side.
- **[Classic scrollbar drag and touch tap-to-click have no harness coverage yet]** → measured behavior for wheel/click/touch-cancel is proven; a residual gap is noted for a later pass rather than silently claimed.

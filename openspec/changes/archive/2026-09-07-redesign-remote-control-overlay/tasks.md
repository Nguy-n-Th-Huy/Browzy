# Tasks

Scope is exactly four files: `extension/overlay/pointer-overlay.js`, `extension/background.js`, `test/overlay-pointer.test.mjs`, `test/overlay-background-bridge.test.mjs`. Nothing else may be edited or deleted.

Measurements come from `plans/design-remote-state/Main.dc.html` and `Anatomy.dc.html`. Those are mockups — transfer the numbers, not the markup.

## 1. Palette and edge treatment

- [x] 1.1 Replace the terracotta values in `OVERLAY_CSS` with the two-hue pair: cyan `oklch(0.74 0.19 215)`, violet `oklch(0.74 0.19 300)`. No `#C4785B` remains anywhere in the file.
- [x] 1.2 Replace `.browzy-frame`'s inset box-shadow with two stacked layers: a rotating conic-gradient masked to a 2px ring (7s linear), and beneath it a static ring at 22% opacity that never animates.
- [x] 1.3 Add four corner brackets (34×34, stroke 2, round caps) as elements in `createOverlayHost()`, positioned 10px from each viewport corner.
- [x] 1.4 Under `@media (prefers-reduced-motion: reduce)`, stop the sweep only — the static ring and the brackets keep painting. ← (verify: a reduced-motion viewer still has a persistent, visible indication of active control for the whole run; this is the failure mode the old design had and the spec now forbids)

## 2. Cursor and its label

- [x] 2.1 Redraw `CURSOR_SVG` at 26×26 with a cyan→violet gradient fill, `#08080c` stroke at 1.4, and a `drop-shadow(0 3px 10px rgba(0,0,0,.5))` on the wrapper.
- [x] 2.2 Add a label element offset +21x/+20y from the cursor point: radius 8, `#08080c` ground, violet border at 40%, carrying the name `Browzy`, a state dot, and the action text.
- [x] 2.3 Add an `action.type` → label map and resolve it in `computeRenderModel()`. Cover every `ACTION_TYPES` value from `extension/events/action-events.js`.
- [x] 2.4 Render three cursor states: acting (pulsing cyan dot), dragging (solid violet dot, violet cursor fill), idle (grey, reduced opacity).
- [x] 2.5 An event whose `action.type` is outside `POINTER_ACTION_TYPES` must not produce an action label at the last known cursor position — it falls back to the idle wording. ← (verify: a `read` or `script` event does not make the cursor claim it clicked something; the module's "never fabricate pointer motion" rule extends to the label)

## 3. Click feedback

- [x] 3.1 Replace `.browzy-click-ring` (28×28) with two ripples: 66×66, stroke 1.5, one cyan and one violet, 1.4s cycle, the second offset by 0.45s.
- [x] 3.2 Keep both ripples `pointer-events: none` and confirm the ripple is still driven only by a real `phase: "down"` in `pointer.points[]`.

## 4. Status bar

- [x] 4.1 Delete `computeBadgeCorner()` and its call site; stop writing `data-corner` in `paintOverlay()`.
- [x] 4.2 Anchor the bar at `left: 50%; bottom: 26px; transform: translateX(-50%)`; height 46, radius 999, ground `rgba(10,10,15,.92)`, violet border at 34%, entrance 420ms `cubic-bezier(.2,0,0,1)`.
- [x] 4.3 Build the bar's content: live dot, `BROWZY`, current action text, a stroked trace path in place of a spinner, step count and elapsed time, Stop.
- [x] 4.4 Count steps on `kind === "start"` and capture `timing.startedAt` from the first event, both in `reduceOverlayState()`; format them in `computeRenderModel()`.
- [x] 4.5 Confirm a `keepalive` still changes nothing but `lastEventAt` — not the step count, not the start time, not the cursor, not the click. ← (verify: the keepalive branch was added so the indicator survives thinking time; it must not inflate the step count the operator reads)
- [x] 4.6 Render the three bar states: running (cyan), waiting-for-approval (amber), idle (grey, no Stop). ← (verify: all three reachable from real state, and the waiting state carries no control that grants or denies — spec: "Blocked-on-approval is visible on the controlled page")

## 5. Approval channel

- [x] 5.1 In `handleAgentMessage()`, add an observer beside the existing `stream_event` teardown observer: on `approval_request` send `{type: "browzyOverlayApproval", phase: "pending", requestId, action, target}` to the run's tabs via `sendOverlayMessage`; on `approval_decision` send `{phase: "resolved", requestId}`.
- [x] 5.2 Leave `forwardActionEventToOverlay`, `startOverlayKeepalive`, `stopOverlayKeepalive`, `teardownOverlayForRun`, `teardownAllOverlays` and the verbatim relay to panel ports untouched.
- [x] 5.3 Handle `browzyOverlayApproval` in the overlay's message listener; store `pendingApproval` in state, refreshing `lastEventAt` without touching `cursor` or `clickAt`.
- [x] 5.4 Clear `pendingApproval` on the matching `requestId`, on teardown, and on heartbeat expiry. A `resolved` for an unknown id is a silent no-op.
- [x] 5.5 Give the waiting state an "Open panel" control — and no other control. No Allow, no Deny. ← (verify: design.md D6 and the spec forbid a grant control here because the agent's CDP clicks carry `isTrusted: true` and reach any coordinate including the closed shadow root; the design mockups DO show Allow/Deny, so this task exists to be deliberately not done)

## 6. Tests

- [x] 6.1 Keep every existing safety assertion in `test/overlay-pointer.test.mjs` passing: no top-level import/export, `pointer-events: none` except the deliberate controls, heartbeat expiry ≤3s, keepalive semantics, teardown, reduced-motion.
- [x] 6.2 Replace the `computeBadgeCorner` block with its inverse: pointer movement leaves the indicator's position unchanged.
- [x] 6.3 Add coverage: cursor label per `action.type` including the non-pointer fallback; three cursor states; three bar states; step count and elapsed time; brackets surviving reduced motion.
- [x] 6.4 Add coverage in `test/overlay-background-bridge.test.mjs` for the approval observer both ways, and that it does not disturb the verbatim panel relay.
- [x] 6.5 Assert the waiting state renders no grant/deny control. ← (verify: this is the regression net for the one place implementation deliberately departs from the settled design — without it, a later "fix the mockup mismatch" silently reintroduces the hole)
- [x] 6.6 Run both suites plus the other suites that read `extension/background.js` through `_extract.mjs` (`handlers`, `action-events-emission`, `tab-group-inheritance`, `extraction-honesty`, `registry-borrowed-tab-scope`, `navigate-url-scheme`) and confirm all pass. ← (verify: `_extract.mjs` pulls functions out of the shipped source by name — deleting or renaming one breaks a suite that never mentions this change)

## Context

See `proposal.md` — Why, for motivation. What shapes the approach:

`extension/overlay/pointer-overlay.js` is a classic (non-module) script injected with `chrome.scripting.executeScript`, mounted into a **closed** shadow root, and structured as one IIFE with named top-level function declarations. That structure is load-bearing, not stylistic: `test/_extract.mjs` pulls each function out of the shipped file by brace-matching and unit-tests it in plain Node, with no bundler and no browser. Renaming or inlining a function removes it from test reach.

The overlay is driven entirely by the action-event stream (`extension/events/action-events.js`). Every event already carries `kind` (`start`/`progress`/`complete`/`error`), `action.type` (one of 13 values), `timing.startedAt`, and — for pointer-capable action types only — `pointer.points[]`. The module's own header states the rule the new label must not break: it never invents a pointer position, a click, or an active state that a real dispatched event did not report.

Two signals reach the overlay today: the action stream (`browzyOverlayEvent`), and a periodic `keepalive` of the same shape added so the indicator survives the seconds while the model is thinking. Approval is the gap — `approval_request` is its own envelope type on the companion channel and is relayed verbatim to panel ports; nothing observes it for the overlay.

The design artboards (`plans/design-remote-state/Main.dc.html`, `Anatomy.dc.html`) are the visual source of truth for measurements. They are mockups, not the shipped file — the numbers transfer, the markup does not.

## Goals / Non-Goals

**Goals**

- Replace the visual layer without touching the state machine's contract: `reduceOverlayState()` stays a pure `(state, event, now) -> state`, `computeRenderModel()` stays a pure `(state, now, maxAge) -> model`, and `paintOverlay()` stays the only function that touches the DOM.
- Every new visible fact (action label, step count, elapsed time) derives from data the event stream already delivers. No new field on the action event.
- Add the approval signal on the existing bridge, with the same lifetime guarantees as every other overlay state.

**Non-Goals**

- No change to how actions are dispatched, timed, or ordered. The overlay is a spectator; nothing here may sit on the dispatch path.
- No change to the panel's approval card. The overlay reports; the panel decides.
- No change to the action-event schema, the protocol version, the manifest, or any host-side file.
- Not fixing the agent's ability to click the overlay's own Stop button (see proposal — Known, unchanged, out of scope).

## Decisions

### D1. The action label is a lookup over `action.type`, not new event data

`ACTION_TYPES` already distinguishes `click`, `drag`, `type`, `scroll`, `hover`, `read`, `find`, `open_page`, `script`, `wait`, `capture`, `other`. The label is a static map from those to display strings, applied in `computeRenderModel()`.

*Alternative rejected:* adding a human-readable `label` to the event at emission. It would put presentation text on the dispatch path (which the events module deliberately keeps free of it) and would have to be localised at the wrong layer.

*Consequence to respect:* `POINTER_ACTION_TYPES` is the set that may carry a pointer. For a `read`/`script`/`capture` event the cursor does not move, so the label must NOT claim an action at that position — it falls back to the idle wording. This is the spec's "no action name is shown for a read" scenario, and it is why the map is consulted in the render model (which knows whether a cursor position exists) rather than in the reducer.

### D2. Step count and elapsed time are accumulated in the reducer

`reduceOverlayState()` increments a counter on `kind === "start"` and records `startedAt` from the first event it sees. Both live in state; the render model formats them.

*Alternative rejected:* deriving from `seq`. `seq` is per-`streamKey` and counts every event kind, so it would report a number the operator cannot reconcile with the panel's own step list.

*Consequence:* a `keepalive` must not touch either. It already reaches a dedicated branch that copies state and refreshes only `lastEventAt`; the counter and start timestamp are copied along with everything else, unchanged.

### D3. The status bar anchors; `computeBadgeCorner()` is deleted, not neutered

The function is removed and its call site with it. `paintOverlay()` stops writing `data-corner`, and the CSS positions the bar at `left: 50%; bottom: 26px; transform: translateX(-50%)`.

*Alternative rejected:* keeping the function and always returning one corner. It leaves a tested-but-dead code path that reads as intentional, and the existing test asserting corner selection would keep passing while describing behaviour the product no longer has.

*Test consequence:* the existing `computeBadgeCorner` test block is deleted, not adapted. Its replacement asserts the opposite property — that pointer movement does not move the indicator.

### D4. The sweeping edge degrades to the brackets, and the brackets are markup

The sweep is a rotating conic-gradient masked to a 2px ring. `prefers-reduced-motion` stops the rotation only; the static ring and the four corner brackets are ordinary elements with no animation, so they survive.

*Alternative rejected:* hiding the whole edge under reduced motion. That is the current behaviour's failure mode restated — a viewer who asked for less motion would get no indication that their page is being driven, which the spec now forbids.

*Constraint:* the mask is `linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)` on a `border: 2px solid transparent` box. It paints only the border band, so the sweep cannot tint page content, and the layer stays `pointer-events: none`.

### D5. Approval rides the existing bridge as a third message type

`handleAgentMessage()` gains an observer next to the existing `stream_event` teardown observer. On `approval_request` it sends `{type: "browzyOverlayApproval", phase: "pending", requestId, action, target}` to that run's tabs via `sendOverlayMessage`; on `approval_decision` it sends `{phase: "resolved", requestId}`. Delivery is fire-and-forget, exactly like the action stream — the observer reads the envelope and does not alter what gets relayed to panel ports.

*Alternative rejected:* a second port or a new envelope type. The bridge, the tab-tracking map (`overlayRunTabs`), and the injection-retry logic already exist and are tested; a parallel path would duplicate all three.

*Reducer treatment:* approval is state, not an action. It sets `pendingApproval` and refreshes `lastEventAt` (a pending approval is proof the run is alive), and clears on the matching `requestId`, on teardown, and on any decision for the run. It never touches `cursor` or `clickAt` — a run waiting for permission has not moved the pointer.

*Ordering:* a `resolved` for an unknown or already-cleared `requestId` is a no-op, not an error. Panel and overlay both observe the same decision, and the panel's own path may clear first.

### D6. No grant control on the controlled page

Stated as a requirement in the spec delta; the reasoning is verified against `extension/background.js:2107`. Recording it here so a later reader does not restore the buttons from the design artboards, which do show them.

The overlay's waiting state carries an "Open panel" control instead. That control is reachable by the agent for the same reason Allow would be — and is harmless for the same reason Stop is: opening a panel grants nothing.

## Risks / Trade-offs

- **The design artboards show Allow/Deny; the implementation omits them.** → Recorded in the proposal, in the spec as a normative prohibition with its reason, and in D6. Anyone diffing mockup against product finds the reason before rebuilding it.
- **`conic-gradient` + `mask-composite` support.** → Chromium 120+ supports both unprefixed; the extension's floor is Chrome 116 (`manifest.json`), so `-webkit-mask` is written alongside `mask`. If the mask fails entirely the ring paints as a filled rectangle over the page — so the static ring and brackets carry the non-animated indication independently, and the swept layer is additive.
- **A permanent CSS animation on every controlled page.** → One compositor-only transform on a fixed layer, paused under `prefers-reduced-motion`. It runs only while the overlay is active, which is bounded by the same 3s heartbeat as everything else.
- **Approval state outliving its run.** → It shares `lastEventAt` with every other state, so heartbeat expiry clears it. Teardown clears it explicitly. Covered by a spec scenario and a test.
- **The step counter drifting from the panel's timeline.** → Both count `kind === "start"`, but the overlay starts counting when it is first injected, which can be after the run's first action on a tab it did not yet occupy. The count is presented as activity on this page, not as the run's total. If that proves confusing, the honest fix is to label it, not to synthesise a total the overlay cannot know.

## Migration Plan

None required. Purely additive at the message layer (an unknown `browzyOverlayApproval` is ignored by an older injected overlay, and an older background simply never sends it), and the visual layer is replaced wholesale on next extension reload. No stored state, no persisted format, no host-side coordination. Rollback is reverting the two source files.

## Open Questions

None. The one open design question — whether the controlled page may carry a grant control — is resolved in D6 and normative in the spec, because leaving it open would change both the task breakdown and the spec.

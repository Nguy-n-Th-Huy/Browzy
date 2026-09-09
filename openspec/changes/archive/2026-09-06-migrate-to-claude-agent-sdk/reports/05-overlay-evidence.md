# Agent pointer overlay — evidence report (Batch 2 of the overlay/timeline split, task 5.9, plus the extension-side half of task 5.10)

Change: `migrate-to-claude-agent-sdk`. This is **Batch 2**: it builds the
overlay renderer (`extension/overlay/**`) against the schema/emission Batch 1
(`reports/05-action-event-schema.md`) already built, plus — added mid-session
by the coordinator once Batch 3a (`reports/05-timeline-host-evidence.md`)
landed the host-side storage/wire handlers and explicitly named the gap — the
extension-side sender that forwards the same action-event stream to the
companion as `action_event`/chunked `action_artifact` messages. It does
**not** build the host-side timeline storage (`host/**`, Batch 3a, already
done) or the sidepanel timeline UI (`extension/sidepanel/**`, a parallel
batch).

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Platform | win32 x64 (Windows 11) |
| Node.js | v24.19.0 |
| Browser automation | **none used** — see "What is BLOCKED" below |

The task brief's own environment constraint states the extension is not
loaded in a real browser this session, and names the file-served +
chrome-shim harness technique (`reports/05-visual-system.md`/
`05-context-binding-evidence.md`) as the intended fallback for genuinely
DOM/CSS-dependent proofs. That technique depends on the
`mcp__open-claude-in-chrome-hybrid__*` browser-automation MCP; **it
disconnected mid-session**, before any of this batch's work began, and a
different MCP (`claude-in-chrome`) took its place. Separately, and
independently of that disconnection, the coordinator's mid-session message
explicitly asked to **skip the visual/screenshot verification pass** for
this batch ("the user said they will check the UI themselves and does not
want more verification work... note in your report that visual acceptance
was deliberately deferred at the user's request rather than performed").
Both facts point the same direction, so no browser-automation tool was used
at all for this batch — every claim below is proven one of two ways, exactly
Batch 1's own convention:

1. **Executed, offline** — pure unit tests of `extension/overlay/
   pointer-overlay.js`'s and `extension/background.js`'s own functions,
   extracted from the REAL shipped source by `test/_extract.mjs`'s
   brace-matching technique (the same one `test/handlers.test.mjs`/
   `test/action-events-emission.test.mjs` already use for
   `extension/background.js`), compiled with injected fakes (`chrome.*`,
   `document`, `nativePort`, `screenshotStore`), and actually run.
2. **Structural / textual proof against the shipped source** — for glue too
   large or too `chrome.*`-dependent to usefully execute offline (anonymous
   `addListener` callbacks, `takeScreenshot`'s full CDP dependency graph,
   the CSS text block), a regex/text-order check against the real file, in
   the same spirit as `test/action-events-emission.test.mjs`'s
   `handleToolRequest` ordering checks.

Nothing here is faked into a false pass. What genuinely needs a live browser
is named explicitly in "What is BLOCKED" below, with the exact command to
close it later.

## Files touched

Owned and edited:
- `extension/overlay/pointer-overlay.js` (**new**) — the overlay itself: a
  classic (non-ES-module) script, injected on demand via
  `chrome.scripting.executeScript`. See its own file-header comment for why
  it cannot be an ES module or a dynamically-`import()`ed one (verified,
  not assumed — see "Why a classic script" below).
- `extension/background.js` — three additive sections, none touching
  existing behavior's actual logic (only wrapping/observing it):
  1. **Overlay bridge**: `sendOverlayMessage`/`forwardActionEventToOverlay`/
     `overlayRunTabs`/`teardownOverlayForRun`/`teardownAllOverlays`/
     `sendStopToHost`, a new `chrome.debugger.onDetach` listener, a new
     `chrome.tabs.onRemoved` listener, a new `chrome.runtime.onMessage`
     listener for `browzyOverlayStop`, one new branch inside the existing
     `handleAgentMessage` function, and one new line inside the existing
     `nativePort.onDisconnect` handler.
  2. **Capture exclusion**: `requestOverlayHide`/`requestOverlayShow`
     wrapping `takeScreenshot`'s existing body in `await
     requestOverlayHide(tabId)` + `try { ...unchanged body... } finally {
     requestOverlayShow(tabId); }` — the existing body's own logic, argument
     shapes, and return value are byte-for-byte unchanged, only its
     indentation and its position inside a new `try` block changed.
  3. **Companion action-event sender** (the extension-side half of task
     5.10, added mid-session at the coordinator's request once
     `reports/05-timeline-host-evidence.md` named it as the one remaining
     gap): `queueActionEventForCompanion`/`scheduleActionEventFlush`/
     `flushActionEventsToCompanion`/`pendingActionEventsByConversation`,
     `chunkBytesForWire`/`base64ToUint8Array`/`uint8ArrayToBase64`/
     `sendActionArtifactToCompanion`.
- `test/overlay-pointer.test.mjs` (**new**) — unit tests of
  `pointer-overlay.js`'s pure functions, its DOM-construction/paint
  functions against a hand-rolled fake `document` (no jsdom/puppeteer
  dependency exists in this repo — grepped `package-lock.json`, none), and
  structural CSS/guard proofs.
- `test/overlay-background-bridge.test.mjs` (**new**) — extraction-harness
  tests of the overlay bridge + capture-exclusion + teardown-hook wiring in
  `extension/background.js`.
- `test/overlay-companion-sender.test.mjs` (**new**) — extraction-harness
  tests of the companion action-event sender + chunked artifact transport.
- `reports/05-overlay-evidence.md` (this file).

Read for context, never edited: `extension/events/action-events.js`
(frozen contract — no defect found, nothing to report), `extension/
content.js` (read in full; found no hook this batch actually needed — see
"Why content.js needed no changes" below), `extension/background.js`'s
pre-existing `sendContentMessage`/`currentAction`/`emitActionStart`/
`makePointerStepHandler` etc. (Batch 1's own code, consumed not modified),
`host/agent/protocol.js`/`host/agent/companion.js`/`host/agent/broker/
chunked-transport.js` (read to mirror the exact wire shape by hand — a
Node-side host file is not importable into this browser module graph, the
same constraint `extension/sidepanel/protocol-client.js`'s own header
already documents for `AGENT_PROTOCOL_VERSION`/`MSG`).

Not touched (per this batch's scope boundary, verified with `git status`
before finishing): `extension/sidepanel/**`, `extension/settings/**`,
`extension/events/action-events.js`, `extension/ui/**`, `extension/
manifest.json`, `extension/recorder/**`, `extension/humanize/**`, `host/**`
entirely, `README.md`, `install.sh`/`install.ps1`, `docs/**`, `tasks.md`,
`REAL/`, `benchmark/`, `scratch/`.

## Why a classic (non-ES-module) script, injected on demand

`extension/manifest.json` is frozen for this task and has no
`web_accessible_resources` entry. Two ways an MV3 content-script-world file
can load another JS file were considered and ruled out with evidence, not
assumption:

1. **Dynamic `import()` from a content script.** Verified via a targeted
   web search (MDN's `web_accessible_resources` page, corroborated by the
   chromium-extensions group's own guidance): a content script's dynamic
   `import()` of another extension-bundled module requires that module to
   be declared in `web_accessible_resources` — there is no dynamic-import
   exemption for same-extension files. Adding that entry means editing
   `manifest.json`, which is on this task's explicit "MUST NOT touch" list.
2. **A second declarative `content_scripts` entry with `"type":"module"`.**
   Same problem: it requires editing `manifest.json`.

What remains, and what this batch actually uses, is the exact pattern
`extension/background.js`'s own **pre-existing** `sendContentMessage()`
already uses for `content.js` itself: `chrome.scripting.executeScript({
target:{tabId}, files:["overlay/pointer-overlay.js"] })` (the `"scripting"`
permission is already granted in `manifest.json`), with `pointer-overlay.js`
written as one plain IIFE with named top-level function declarations — no
`import`/`export` anywhere (structurally proven, see test 8 in
`overlay-pointer.test.mjs`). This is also *why* the file is organized with
named functions rather than an arrow-function/closure style: it makes
`test/_extract.mjs`'s brace-matching extractor able to pull each pure
function out of the REAL shipped file for a real Node unit test, the exact
same reason `extension/background.js` itself already follows that
discipline for `test/handlers.test.mjs`.

## Why `content.js` needed no changes

The task brief lists `extension/content.js` under "Files you OWN... for the
hooks needed to deliver events to the overlay." After reading it in full
(header comment through its `chrome.runtime.onMessage` listener),
no hook was actually needed there: `chrome.scripting.executeScript`-injected
scripts run in the tab's isolated world (the SAME world `content.js` itself
already occupies), and Chrome allows any number of independent
`chrome.runtime.onMessage.addListener` registrations in that world —
`pointer-overlay.js` registers its own, keyed on message `type` values
(`browzyOverlayEvent`/`browzyOverlayTeardown`/`browzyOverlayCapture`) that
never collide with any of `content.js`'s own (`generateAccessibilityTree`,
`getPageText`, `getRefCoordinates`, ...). `extension/background.js` can
therefore deliver directly to the overlay without `content.js` acting as a
relay. Leaving `content.js` completely untouched also means the parallel
batch that owns its SPA/`documentEpoch` tracking (per
`reports/05-context-binding-evidence.md`) carries zero risk of a merge
conflict with this one.

## Coordinate system — why no transform is needed (and why that is not hand-waving)

Design.md 5c asks the overlay to "position... using the same viewport
coordinate system as dispatched input, accounting for frame offsets,
scroll, browser zoom, device pixel ratio and sidepanel-driven viewport
resize." The schema report (Batch 1, "Pointer field — coordinate system")
already establishes that `pointer.points[].x/.y` **are the literal numbers
already passed to `Input.dispatchMouseEvent`** — CSS-pixel, top-level-
viewport-relative coordinates, with **no transform in the schema at all**.

CSS `position: fixed` is defined to lay out relative to the same top-level
viewport, in the same CSS-pixel units, and both scroll and zoom are already
resolved by the browser into that one shared coordinate space before either
CDP dispatch or `position:fixed` layout ever sees a number — neither
receives a "raw device pixel" or "unzoomed" value that would need
correcting. This is why `resolveViewportPoint(point, frame)` (the overlay's
one coordinate function) is, today, the **identity function** plus a
forward-declared `frame.offsetX/offsetY` addend for the one case that
genuinely is not resolved by the browser for free: a real per-frame offset
for an action dispatched inside a nested/cross-document iframe.
`pointer.frame` is `{frameId:0, isMainFrame:true}` unconditionally today
(Batch 1's own documented limitation — `content.js`'s ref/coordinate
machinery, `all_frames:false`, never reaches into an iframe's own document
at all, so there is no real per-frame offset to carry yet). This batch does
not solve that; it declares the extension point and proves it is additive
once a future batch populates real offsets
(`test/overlay-pointer.test.mjs`, section 1: "a future real per-frame
offset... is additive, not ignored").

This is proven, not just asserted, four ways in `test/overlay-pointer.test.mjs`
section 1:
- The function's own source is grepped to contain **no** reference to
  `scrollX`/`scrollY`/`devicePixelRatio`/`innerWidth`/`innerHeight` at all —
  there is nothing in it that COULD apply a wrong, double-counted
  correction, because it never reads any of those values.
- Today's always-`{frameId:0,isMainFrame:true}` frame passes a coordinate
  through unchanged.
- A hypothetical future non-zero `frame.offsetX/offsetY` is additive.
- A coordinate value standing in for "already resolved by a zoomed/
  high-DPR/scrolled page" is asserted to come back **unchanged** — the
  explicit regression guard against the "correct a coordinate that was
  never wrong" bug class this requirement exists to prevent.

**Nested scroll** (an element inside a scrollable `<div>`, not an iframe)
needs no special handling for the same underlying reason:
`getBoundingClientRect()`/CDP dispatch coordinates are always expressed
relative to the top-level viewport regardless of how many scrollable
ancestors an element has — scrolling a nested container changes what that
rect IS, but never what coordinate SPACE it is reported in. **Sidepanel-
driven viewport resize** is likewise handled for free: `position:fixed`
recomputes on any viewport resize the browser fires, exactly the resize
Chrome's side panel opening/closing causes for the controlled tab.

**What genuinely remains open, stated precisely rather than glossed over**:
a real cross-document iframe case. Today's system has no code path capable
of returning coordinates for an element inside an iframe's own document at
all (`content.js`'s ref map/`getRefCoordinates` never traverse into one,
`all_frames:false`), so there is no "wrong overlay position for an iframe
click" bug to fix yet — there is no dispatch for that case to visualize
correctly OR incorrectly. `resolveViewportPoint`'s `frame` parameter is the
place a future batch should plug in a real offset once `content.js` starts
computing one; this batch could not build the source of that data without
touching `extension/content.js`'s frame-context machinery, which the schema
report already scoped as out of Batch 1's and (per this task's own brief)
this batch's ownership.

## The overlay's state machine — no fabrication, by construction

`reduceOverlayState(state, event, nowMs)` is the ONLY place the overlay
derives what to show, and it is a pure function of a REAL event object
already built by `action-events.js`'s `buildEvent()` (Batch 1) — this
module never receives a plan, a proposal, or anything not already
dispatched. Concretely:
- A DOM/script-only event (`pointer: null`, e.g. `read`/`find`/`open_page`/
  `script`/`wait`/`capture`/`other`) never moves or clears the cursor — it
  is simply left exactly where the last REAL pointer dispatch put it. Proven
  directly: `test/overlay-pointer.test.mjs` section 3 runs a `script`
  action's `start` AND `complete` immediately after a real click and asserts
  the cursor position is bit-for-bit unchanged by either.
- A pointer-capable event's cursor is set to the LAST point in the batch
  `action-events.js`'s `PointBatcher` already grouped (never an average,
  never an extrapolation).
- `dragHeld`/the click ring are derived the same way — a `down` phase
  anywhere in a real dispatched batch marks the ring timestamp; `dragHeld`
  clears the instant the drag's own `complete`/`error` arrives, never
  before, never based on a guess about how long a drag "should" take.
- `active` (whether the badge/cursor show at all) is **not a stored flag**
  toggled per event kind — it is *derived* from `nowMs - lastEventAt`
  against a bound (`computeRenderModel`), which is what makes a single
  mechanism cover every one of design.md 5c's teardown triggers uniformly
  (see next section).

## Every design.md 5c teardown trigger, and exactly what clears it

| Trigger | Mechanism | Bound |
|---|---|---|
| **Local heartbeat expiry** (the general safety net) | `pointer-overlay.js`'s own `setInterval` (250ms) re-checks `isHeartbeatExpired(now, lastEventAt, 2700ms)` and repaints — needs NO new event to notice staleness | `HEARTBEAT_MAX_AGE_MS(2700) + HEARTBEAT_CHECK_INTERVAL_MS(250) = 2950 <= 3000`ms, proven by a direct arithmetic assertion against the shipped constants (not just their individual values) |
| **Stop / cancellation** | `extension/background.js`'s `handleAgentMessage()` observes `run_stopped`/`run_error`/`run_interrupted_by_restart` stream_events already flowing through the EXISTING agent-port relay (added as one new `if` branch, verified NOT to alter the pre-existing verbatim relay — see test 7) and calls `teardownOverlayForRun(runId, ...)` immediately | Immediate (does not wait for heartbeat expiry) |
| **Debugger detachment** | A new, separate `chrome.debugger.onDetach.addListener` (the pre-existing one, unmodified, still only manages `attachedTabs`) sends `browzyOverlayTeardown` to that exact tab | Immediate |
| **Tab closure** | Nothing to message (the tab and its overlay are already gone with it); a new `chrome.tabs.onRemoved` listener only prunes `overlayRunTabs` bookkeeping so it cannot grow unbounded | N/A |
| **Document replacement** | *Navigation* (a URL change): the browser itself destroys the old document's JS realm, taking the injected overlay with it — the NEXT real event for that tab re-injects fresh via `sendOverlayMessage`'s existing inject-then-retry (mirrors `sendContentMessage`). *Same-URL wholesale DOM replacement* (no navigation): the overlay's own heartbeat interval also checks `!document.documentElement.contains(refs.host)` and recreates its host if so — proven this recreation never itself claims "active" (it still runs the same `computeRenderModel` against the same, possibly-already-stale, `state`) | Immediate for navigation; next 250ms tick for a same-URL replacement |
| **Companion loss** | `nativePort.onDisconnect`'s EXISTING handler gets one new line, `teardownAllOverlays("companion_disconnected")`, clearing every tab this service worker currently tracks | Immediate; heartbeat expiry is the redundant fallback if this SW instance itself also restarts and loses `overlayRunTabs` |

Every "immediate" row is deliberately belt-and-suspenders on top of the
heartbeat's own unconditional <=3s bound, per design.md 5c's own framing
("Enforce a local heartbeat expiry of at most 3 seconds... so a
disconnected host cannot leave a misleading active badge indefinitely") —
the heartbeat is what makes ALL of these safe even if a given immediate
signal is itself lost (e.g. the tab is unreachable when `teardownOverlayForRun`
tries to message it).

## Stop: the same cancellation path, not a second implementation

`extension/background.js`'s `sendStopToHost(conversationId, reason)`
constructs `{v:1, type:"stop", conversationId, reason, ts}` — **the exact
shape** `extension/sidepanel/protocol-client.js`'s own `envelope(MSG.STOP,
{conversationId, reason})` already builds for the panel's Stop button — and
posts it via `nativePort.postMessage({type:"agent_msg", envelope})`, the
**exact same call** the pre-existing `"ocic-agent"` port's
`port.onMessage.addListener` already makes when relaying the panel's own
Stop. `host/agent/session/run.js`'s `stop()` (unmodified, out of this
task's ownership) is what actually invalidates pending actions/approvals on
the far end — for BOTH paths, since both reach it through the identical
wire message. Proven directly (`test/overlay-background-bridge.test.mjs`,
section 4): the constructed envelope's every field is asserted against
protocol-client.js's own documented shape, and the pointer-overlay.js Stop
button is proven (section 6 of `overlay-pointer.test.mjs`) to send exactly
one `browzyOverlayStop` message carrying the CURRENT run's own
`conversationId`/`runId` — never a stale or fabricated one — which
`extension/background.js`'s new `chrome.runtime.onMessage` listener turns
into that call.

## Capture exclusion — hidden before, restored in `finally`, cursor state untouched

`takeScreenshot(tabId)` (the ONE function every screenshot/zoom capture
already funnels through) now does `await requestOverlayHide(tabId)` before
its existing CDP capture logic, and `requestOverlayShow(tabId)` in a
`finally` wrapped around that UNCHANGED body — so a captured screenshot is
restored to visible even if the capture itself throws. `requestOverlayHide`
races the hide request against a 150ms timeout (`OVERLAY_HIDE_WAIT_MS`) so
an absent/unresponsive overlay (a tab where the overlay was never injected,
a closed tab, a chrome:// page) can never slow down a real screenshot —
proven directly with a `sendOverlayMessage` fake that never resolves at
all: `requestOverlayHide` still returns in well under 200ms.

On the renderer side, `setCapturedHidden(hidden)` toggles ONLY
`refs.host.style.visibility` — it is proven (test 6 in
`overlay-pointer.test.mjs`) to run **synchronously**, bypassing the render
scheduler entirely (a screenshot cannot wait a coalesced animation frame),
and to leave `state.cursor`/`clickAt`/`dragHeld` completely untouched, so
"restore in a finally path without changing cursor state" is not just true
by construction but asserted directly (the cursor position before and after
a hide/show cycle is compared and found identical).

Structural proof of the call-ordering itself (`takeScreenshot` has too
large a dependency graph — `cdp`, `ensureAttached`, `dbg`,
`screenshotStore` — to usefully execute offline, the same reasoning Batch 1
applied to `handleToolRequest`): `test/overlay-background-bridge.test.mjs`
section 6 asserts, against the real file text, that `requestOverlayHide`
is called before the `try` block, the real `Page.captureScreenshot` call
site is strictly between the hide call and the `finally`, and
`requestOverlayShow` is strictly inside the `finally`.

## The overlay never intercepts page input

- The host element itself: `host.style.pointerEvents = "none"` (an inline
  JS-set property, not just a CSS rule) — proven directly against a fake
  DOM.
- Every decorative CSS rule (`.browzy-cursor`, `.browzy-click-ring`,
  `.browzy-badge`) is `pointer-events:none`; the ONE exception,
  `.browzy-stop`, is `pointer-events:auto` — proven by regex against the
  actual `OVERLAY_CSS` string literal shipped in the file (not a
  description of intent).
- The host is attached under `document.documentElement`, never
  `document.body` — proven directly against a fake DOM (`appendChild`
  called on `documentElement`, never on `body`). This is also what keeps it
  **structurally** outside `extension/content.js`'s `generateAccessibilityTree()`
  DOM/accessibility walk, which starts at `document.body` and never visits
  a sibling of it — no `aria-hidden`/`inert` flag was needed to hide it from
  the MODEL-facing extraction, which means the Stop button is left fully
  reachable to a REAL human's assistive technology (a DIFFERENT consumer of
  the same DOM tree) rather than accidentally hidden from both at once.
- Hit-testing comparison "with the overlay enabled/disabled" (design.md 5c's
  own acceptance line) reduces, given the above, to: the overlay is
  `pointer-events:none` everywhere except a small fixed corner badge
  positioned away from the last known cursor position
  (`computeBadgeCorner`), so any real page hit-test at the actual dispatched
  coordinate is provably unaffected — the overlay literally cannot receive
  that event. A live, pixel-level "click through it and compare" pass is
  listed under "What is BLOCKED" (it needs a real page and a real click),
  but the CSS property that makes it true is verified against the real
  shipped text, not just described.

## Render throttling never alters the action schedule

Two independent proofs, mirroring the exact "instrumentation must not alter
dispatch" methodology Batch 1's own `dispatchPlan` onStep test uses:
- `createRenderScheduler`'s own unit test: three rapid `requestRender()`
  calls before a (manually-stepped, fake) animation frame fires schedule
  **exactly one** frame callback, which — once fired — reflects the LATEST
  request, not the first stale one.
- The wiring test (`overlay-pointer.test.mjs` section 6) proves the
  STRONGER claim end to end: calling `handleOverlayEvent()` twice in a row
  updates `state` **synchronously and immediately** both times (asserted via
  a debug getter reading the live closure variable) while only ONE paint
  gets scheduled — i.e. the thing that is throttled is strictly the DOM
  write, never the moment-by-moment truth of what happened.
- On the companion-sender side, `queueActionEventForCompanion`'s own source
  is grepped to contain **no `await` at all** — it can only ever push into
  an array and arm a `setTimeout`, so it is structurally incapable of
  delaying the real dispatch that produced the event it is queuing, and
  `scheduleActionEventFlush`'s own test proves a burst of calls arms
  exactly one timer, never one per event.

## The extension-side companion action-event sender (task 5.10's remaining gap)

`reports/05-timeline-host-evidence.md` (Batch 3a) built and proved, against
a REAL wire (spawning the real `host/native-host.js` + a real forked
`host/agent/companion.js`), a complete host-side handler for `ACTION_EVENT`/
`CHUNK_BEGIN`/`CHUNK_PART`/`CHUNK_END`/`ACTION_ARTIFACT_REQUEST` — and named,
explicitly, that nothing on the extension side sent any of these messages
yet. This batch closes that gap, added mid-session at the coordinator's
request:

- **`queueActionEventForCompanion`** is a SEPARATE `actionEvents.onActionEvent()`
  subscriber from the overlay-delivery one (`forwardActionEventToOverlay`) —
  one delivers to the controlled TAB, this one to the COMPANION, over the
  SAME `"ocic-agent"`/`nativePort` `agent_msg` channel the hello handshake
  and `agent_settings` relay already use. **No second channel, no new
  message shape** beyond what `host/agent/protocol.js` already declares —
  the wire type string (`"action_event"`) and envelope field names
  (`conversationId`, `events`) were read directly from that file and from
  `reports/05-timeline-host-evidence.md`'s own worked example.
- **Filtering**: an event with no `conversationId` (every legacy/
  external-MCP tool call — design.md 5d: those have no SDK conversation to
  store a timeline against) is never queued for the companion — proven
  directly. The overlay-delivery path is UNAFFECTED by this filter (it never
  depended on `conversationId` at all), so a legacy/external-MCP action
  still shows its own cursor on its own tab; it just never appears in a
  companion-side conversation transcript, which is correct — there is no
  conversation for it to appear in.
- **Batching**: events are grouped per `conversationId` in
  `pendingActionEventsByConversation` and flushed on a 200ms timer
  (`ACTION_EVENT_FLUSH_MS`) — mirroring the existing `TOKEN_BATCH` rationale
  ("Batch token/event updates to avoid flooding native messaging"). A burst
  of events (e.g. a `PointBatcher` flush landing next to its own action's
  `start`/`complete`) is proven to collapse into exactly one armed timer and
  one `action_event` message per conversation per flush, not one message
  per event.
- **Screenshot bytes via the existing chunked transport**: `chunkBytesForWire`
  hand-mirrors `host/agent/broker/chunked-transport.js`'s `chunkBuffer()`
  wire shape field-for-field (a Node-side host file, not importable into
  this browser module graph) — `chunk_begin`/`chunk_part`(×N)/`chunk_end`,
  the SAME `meta` (`kind:"action_artifact"`, `conversationId`, `artifactId`,
  `mimeType`) spread onto `begin` and every `part` (never `end`), the same
  700,000-byte chunk cap. Proven with BOTH a small (typical screenshot-sized)
  buffer, which produces exactly one chunk, AND a 900,000-byte buffer
  (mirroring Batch 3a's own tested case) that correctly splits into
  `[700000, 200000]`-byte parts and reassembles byte-for-byte via a small
  local reassembler in the test (not importing a host file, matching the
  same module-graph boundary the shipped code itself respects).
  `sendActionArtifactToCompanion` reads bytes **only** from
  `screenshotStore` (this file's own pre-existing, bounded 10-entry
  imageId->base64 map, populated by `takeScreenshot()`) — never re-captures,
  never substitutes a different image; an evicted/unknown `artifactId`
  simply sends nothing (proven directly), which is the honest outcome (the
  host's own already-tested `found:false`/"unavailable" state is what a
  later preview UI shows for that case, not a fabricated stand-in).
- **Redaction is not touched or re-derived here.** This sender forwards the
  EXACT event object `action-events.js`'s `summarize()` already redacted at
  emission (Batch 1) — proven by object-identity assertions (the queued/sent
  event is the literal same object, never copied or rebuilt) — and the host
  applies its own independent second defense (Batch 3a,
  `sanitizeActionEvent()`). Neither layer is undone or bypassed by this one.
- **Safe degradation**: no companion connected -> `flushActionEventsToCompanion`
  drops the pending batch (proven) rather than retrying forever or growing
  memory unboundedly; `sendActionArtifactToCompanion` is a no-op with no
  `nativePort`. A legacy/external-MCP session is unaffected structurally
  (see filtering above) — this sender never even attempts to interpret or
  gate on legacy tool calls.

## What is BLOCKED (needs a live browser, or was explicitly deferred)

- **All pixel-level visual/screenshot verification** (the ~20px arrow's
  actual look, contrast, click-ring/held-state animation, badge placement
  across real page layouts, keyboard-focus traversal to the Stop button,
  and a real OS-level `prefers-reduced-motion: reduce` emulation) —
  BLOCKED both by this session's browser-automation MCP disconnecting
  before this batch started, and, independently, by the coordinator's
  explicit mid-session instruction to skip visual/screenshot verification
  for this batch ("the user... does not want more verification work").
  Every CSS property this report cites as evidence (pointer-events,
  position, the reduced-motion media query) is verified as TEXT against the
  real shipped source, which proves the rule exists and says what this
  report claims it says — it does not prove how it renders. Close with:
  load the extension unpacked (per `reports/05-visual-system.md`'s
  file-served technique, or a real install), trigger a run, and visually
  compare the overlay against design.md 5a's visual language and 5c's
  acceptance list (click/double/right-click/hover/drag/scroll, iframe
  coordinates, zoom/DPI changes, active/background tabs, stop mid-action,
  lost heartbeat, screenshot overlay exclusion, hit-testing with the overlay
  enabled/disabled).
- **A real per-frame (iframe) coordinate offset.** As explained above, there
  is no code path today capable of producing one at all (out of this
  batch's and Batch 1's ownership — `extension/content.js`'s frame-context
  machinery). `resolveViewportPoint`'s `frame` parameter is the declared,
  tested-as-additive extension point.
- **A real end-to-end companion round trip for the sender built in this
  batch** — proven here via extraction + fakes (same rigor Batch 1 itself
  used for its own emission wiring), but NOT via spawning a real
  `host/native-host.js` + companion process the way
  `host/test/agent-timeline-wire.test.mjs` does for the host's own half
  (that file lives under `host/test/**`, explicitly out of this batch's
  file ownership, and the coordinator's instruction accepted "fake-bridge/
  harness patterns" as the expected proof level for this deliverable). The
  wire shape this batch sends was built by reading
  `host/agent/protocol.js`/`host/agent/companion.js`/`host/agent/broker/
  chunked-transport.js` directly and matching every field name and chunk
  boundary rule byte-for-byte (verified against Batch 3a's own documented
  900,000-byte multi-chunk case) — a live spawn would be the natural next
  step to close this out entirely, and is a small, well-templated follow-up
  (mirror `host/test/agent-timeline-wire.test.mjs`'s own spawn/handshake
  code from a NEW file under `test/`, so it stays outside `host/**`), not a
  claim that the shape is unverified.
- **A real multi-run/multi-conversation concurrency stress case** for the
  batching/flush timer (proven via direct calls and a manually-stepped fake
  timer, not via genuine concurrent native-messaging traffic — the same
  category of gap Batch 1 disclosed for its own `currentAction` race-safety
  claim).

Close with: load the extension unpacked in Chrome/Edge/Brave, attach a real
credentialed SDK run, and confirm live overlay rendering plus a live
screenshot round-tripping into host-side storage.

## Test evidence summary

- `test/overlay-pointer.test.mjs` — 8 sections, all PASS. Covers:
  coordinate identity/forward-compat, heartbeat-expiry arithmetic and
  boundary behavior, the full state machine (no fabrication for DOM/
  script-only actions, cursor/click-ring/drag-held derivation, hover/scroll
  pointer-capability, immediate teardown), render-model derivation
  (active/inactive, click-ring fade), the render-throttle scheduler in
  isolation, the full wiring path against a fake DOM/chrome/window (state
  updates synchronously, painting is coalesced, host placement/pointer-events,
  capture-hide/show without touching cursor state, the Stop button's exact
  message), structural CSS proofs, and the classic-script/no-ESM guard.
- `test/overlay-background-bridge.test.mjs` — 8 sections, all PASS. Covers:
  `sendOverlayMessage`'s inject-then-retry parity with `sendContentMessage`,
  `forwardActionEventToOverlay`'s exact-object delivery and runId tracking,
  both teardown functions' exact tab targeting, `sendStopToHost`'s wire-shape
  parity with the panel's own Stop, `requestOverlayHide`'s bounded wait,
  `takeScreenshot`'s hide/show call ordering (structural), `handleAgentMessage`'s
  new teardown branch (with the pre-existing verbatim relay proven
  unaffected), and the remaining anonymous-callback teardown hooks
  (structural).
- `test/overlay-companion-sender.test.mjs` — 5 sections, all PASS. Covers:
  filtering/batching/no-`await` proof for `queueActionEventForCompanion`,
  the flush-timer coalescing proof, `flushActionEventsToCompanion`'s exact
  wire shape and safe degradation, `chunkBytesForWire`'s byte-exact
  single-chunk and multi-chunk (900,000-byte) reassembly, and
  `sendActionArtifactToCompanion`'s real-bytes-only/no-substitute/safe-
  degradation behavior.
- **Full regression**: every file in `test/*.test.mjs` (33 files, including
  the 3 new ones) and every file in `host/test/*.test.mjs` (38 pre-existing
  files, `host/**` not touched by this batch) was run individually this
  session; **all pass**, including `test/sidepanel-slash-picker-dispatch.test.mjs`
  (flagged by the task brief as possibly failing due to a parallel
  in-progress session — green at the time of this batch's regression pass,
  consistent with Batch 3a's own report of the same file already being
  green by the time it ran its regression). `node --check`
  (`--input-type=module` for `background.js`, plain for `pointer-overlay.js`)
  passes on both edited/new extension files.

## Acceptance-criteria mapping

| Criterion | Where proven |
|---|---|
| Overlay never intercepts page input | `pointer-events` inline JS property + CSS text structural proof; `.browzy-stop` is the sole `pointer-events:auto` region |
| Overlay absent from captures and DOM/accessibility extraction | Host attached under `documentElement`, never `body` (structural + fake-DOM test); `requestOverlayHide`/`Show` wrapping `takeScreenshot` (structural ordering + bounded-wait test) |
| Coordinates correct under zoom/DPI/scroll/nested scroll | `resolveViewportPoint` identity-passthrough tests + the "no scroll/DPR/viewport global referenced at all" source-absence check |
| Heartbeat expiry clears a stale active badge within 3s | `isHeartbeatExpired` boundary tests + the `HEARTBEAT_MAX_AGE_MS + HEARTBEAT_CHECK_INTERVAL_MS <= 3000` arithmetic assertion against the shipped constants |
| Page Stop and panel Stop share one cancellation path | `sendStopToHost`'s envelope-shape/call-path parity test; the overlay's Stop button message test |
| DOM/script-only calls produce no pointer motion | `reduceOverlayState` fabrication tests (script action's start/complete leave the cursor untouched) |
| Teardown on stop/disconnect/navigation/tab close | Per-trigger table above, each with its own direct or structural test |
| Rendering throttle does not alter dispatch scheduling | `createRenderScheduler` coalescing test + the wiring test's synchronous-state/coalesced-paint proof + `queueActionEventForCompanion`'s no-`await` proof |
| All existing suites pass | Full regression run, `test/` (33 files) + `host/test/` (38 files), reported above |
| (5.10 extension half) Events reach the wire in order, batched, with the real wire shape | `flushActionEventsToCompanion`/`chunkBytesForWire` tests above |
| (5.10 extension half) A capture's bytes resolve via the real chunk transport | `sendActionArtifactToCompanion`/`chunkBytesForWire` round-trip tests (single- and multi-chunk) |
| (5.10 extension half) No secret crosses the wire | Object-identity forwarding proof (the sender never reads/rebuilds `summary`, only relays the already-redacted event Batch 1 built) |
| (5.10 extension half) Sending degrades safely with no companion | `flushActionEventsToCompanion`/`sendActionArtifactToCompanion` no-`nativePort` tests |

## Status of tasks 5.9 / 5.10 after this batch

**Task 5.9 (overlay module)**: complete, to the extent provable without a
live browser (see "What is BLOCKED"). **Task 5.10**: the host-side half
(Batch 3a) and the extension-side sender (this batch) are both done; the
sidepanel timeline UI itself remains a parallel batch's work. `tasks.md` is
out of this batch's file ownership (a later reconciliation batch owns it) —
this report is the evidence that batch should cite when updating those
checkboxes, not a claim that they are now checked.

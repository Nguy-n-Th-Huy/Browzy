// Agent pointer overlay — design.md decision 5c / task 5.9, redesigned per
// openspec/changes/redesign-remote-control-overlay (the "Aurora" direction),
// then repaired per openspec/changes/repair-overlay-mount-and-visibility
// (eager mount, single visibility authority, correlated capture lease,
// cursor easing, unscoped-run raise, extraction exclusion, operator-input
// blocking, the wait cursor, the ambient glow, the larger cursor).
//
// Renders the agent's cursor and an active-control notice (with a Stop
// button) on the page the agent is actually controlling. Driven ENTIRELY by
// the action-event stream extension/events/action-events.js already emits
// in-process inside the service worker (Batch 1 of this split), plus the
// approval-request/decision bridge extension/background.js relays alongside
// it; this file never invents a pointer position, a click, an "active"
// state, or an approval decision that a real dispatched/relayed event did
// not already report.
//
// WHY THIS IS A CLASSIC (non-module) SCRIPT, NOT AN ES MODULE:
// extension/manifest.json is frozen for this task (owned by a different
// batch) and has no `web_accessible_resources` entry, and Chrome requires a
// dynamic `import()` from a content script to be declared there (verified:
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources
// and the chromium-extensions group's own guidance on the topic) — so this
// file is injected the exact same way `extension/content.js` already is
// (`chrome.scripting.executeScript({ target:{tabId}, files:[...] })`, the
// SAME retry-after-inject shape `sendContentMessage()` in
// extension/background.js already uses), and is written as one big IIFE
// with named top-level function declarations for exactly one reason: so
// `test/_extract.mjs`'s brace-matching extractor (the SAME technique
// test/handlers.test.mjs and test/action-events-emission.test.mjs already
// use for extension/background.js) can pull each pure function out of THIS
// REAL SHIPPED FILE and unit-test it in plain Node, without a bundler, a
// second copy of the logic, or a real browser.
//
// SECTIONS BELOW:
//   1. Pure geometry/state/scheduling functions (no chrome.*, no DOM) —
//      extractable and unit-tested directly.
//   2. DOM construction + paint (touches `document`) — unit-tested against
//      a minimal hand-rolled DOM fake, matching the rest of this codebase's
//      testing convention (no jsdom/puppeteer dependency exists here).
//   3. Messaging + lifecycle wiring — thin glue, proven structurally
//      (call-order regex checks on the shipped source) rather than executed,
//      the same way extension/background.js's own `handleToolRequest` is
//      proven (too much of a live dependency graph — chrome.tabs,
//      chrome.scripting, chrome.runtime — to usefully execute offline).
//
// DELIBERATELY NOT HERE: an Allow/Deny control for the approval-pending
// state. See design.md decision D6 and the "waiting" bar state below —
// the agent's own clicks are dispatched via CDP Input.dispatchMouseEvent
// (extension/background.js), which is browser-level synthetic input: it
// carries isTrusted===true and lands on whatever occupies the coordinate,
// closed shadow roots included. A grant control on this surface would sit
// inside the pointer reach of the very agent asking for the grant. The
// waiting state gets an "Open panel" control and nothing else.
//
// ONE WRITER PER PROPERTY (design.md "Goals", correcting an earlier draft
// that claimed paintOverlay() is the only function that touches the DOM —
// that was never true: createOverlayHost(), attach() and setCapturedHidden()
// all did, and this revision adds setWaitCursorActive() and
// paintCursorPosition() deliberately). The real invariant, held throughout
// this file: exactly one function ever writes a given DOM property.
// paintOverlay() owns everything except host.style.left/top (owned solely by
// the cursor-easing loop's paintCursorPosition(), so the coalesced paint and
// the per-frame easing never fight over the same two properties) and the
// page-level wait-cursor <style> element (owned solely by
// setWaitCursorActive()).

(function () {
  // Same reasoning as extension/content.js's own disposer — see the long note
  // there. A plain "already loaded, bail" guard survives an extension reload
  // (the flag lives on the page's isolated-world `window`, the listener does
  // not), so after every reload this document could never get a working
  // overlay again: the newly injected copy returned at this line, and the page
  // being driven showed no cursor, no badge and no Stop button for the rest of
  // its life. Disposing instead handles both a live double-injection and a
  // dead predecessor.
  try {
    window.__browzyOverlayDispose?.();
  } catch {
    // Old context already invalidated — nothing to tear down.
  }
  window.__browzyOverlayLoaded = true;

  // === 1. Pure functions ===================================================

  // Local heartbeat expiry (design.md 5c: "Enforce a local heartbeat expiry
  // of at most 3 seconds for visible active state, so a disconnected host
  // cannot leave a misleading active badge indefinitely.") The overlay
  // re-checks this on its OWN timer (see HEARTBEAT_CHECK_INTERVAL_MS below)
  // — it does not wait for a new event to notice staleness, because the
  // whole point is to cover the case where NO new event ever arrives again
  // (a dead companion, a crashed service worker, a lost native-messaging
  // connection). MAX_AGE + CHECK_INTERVAL is kept under 3000ms so the worst
  // observed staleness (an expiry that happens right after a check just
  // ran) never exceeds the "at most 3 seconds" bound.
  var HEARTBEAT_MAX_AGE_MS = 2700;
  var HEARTBEAT_CHECK_INTERVAL_MS = 250;
  // Two 66px ripples (task 3.1) run a 1.4s cycle each, the second offset by
  // 0.45s — the visible click feedback window has to outlive both, or the
  // second ripple gets cut off mid-fade. 1400 + 450 = 1850.
  var CLICK_RING_DURATION_MS = 1850;
  // Same reasoning as the heartbeat expiry above, applied to the OTHER thing
  // that can hide this layer. extension/background.js hides the overlay around
  // a screenshot and restores it in a `finally` — but that restore is one
  // fire-and-forget message, and a message can be lost outright (injection
  // refused mid-navigation, tab busy, service worker torn down between the two
  // halves). A lost restore left the overlay permanently invisible on a run
  // that was still going: alive, receiving events, drawing nothing. So the hide
  // expires on this side too. Generous next to a screenshot round trip
  // (typically well under a second) so it never un-hides during a real capture
  // and pollutes the image; short enough that a lost restore costs the operator
  // a moment of blank, not the rest of the run. This is the DEFAULT — a real
  // capture lease's own `maxMs` (design.md D3) overrides it per-lease, because
  // background knows the real worst-case budget it intends to spend.
  var CAPTURE_HIDE_MAX_AGE_MS = 2000;

  // design.md D5: the cursor eases toward its target rather than teleporting.
  // 0.2 per frame is page-agent's own SimulatorMask factor — fast enough to
  // read as "arriving", slow enough to read as travel, not a snap. 2px is
  // the distance under which the remaining gap is imperceptible, so the loop
  // snaps rather than crawling asymptotically forever.
  var CURSOR_EASE_FACTOR = 0.2;
  var CURSOR_SNAP_PX = 2;

  // design.md D9/task 10.5: how close to the right/bottom viewport edge the
  // cursor's dispatched coordinate must be before its label flips to the
  // other side of the arrow, so it never overflows off-screen. Threshold
  // constants (not a real layout measurement — this file never touches a
  // real browser in its own tests).
  var CURSOR_LABEL_FLIP_MARGIN_X = 200;
  var CURSOR_LABEL_FLIP_MARGIN_Y = 60;

  // design.md D8's residual-race detector (task 7.7): how long after a
  // trusted event was suppressed a `start` for the same run may still count
  // as "this suppression may have eaten that action's own dispatch". Short —
  // this is closing a race between two independent async paths
  // (chrome.tabs.sendMessage and chrome.debugger.sendCommand) that is
  // ordinarily won by a wide margin, not a general-purpose grace window.
  var INPUT_SUPPRESSION_REPORT_WINDOW_MS = 500;
  // design.md D8 / task 7.6: Brave never acknowledges a mouseWheel and
  // applies it late (extension/background.js:2617-2633,2661-2676), so a
  // scroll action's OWN dispatch can still be landing after this overlay's
  // `actionInFlight` already cleared on `complete`. A short tail past a
  // scroll's own settle keeps that trailing wheel event from being
  // suppressed as if it were an unrelated operator scroll.
  var SCROLL_ACK_TAIL_MS = 300;

  // Action-label lookup (design.md D1): a static map from action.type to
  // display strings, applied in computeRenderModel() — never new data on
  // the event itself. Covers every extension/events/action-events.js
  // ACTION_TYPES value (this file cannot import that module — see the
  // classic-script note above — so the taxonomy is duplicated here as
  // plain string keys, not re-derived).
  var ACTION_LABELS = {
    open_page: "Đang mở trang",
    read: "Đang đọc trang",
    find: "Đang tìm nội dung",
    click: "Đang nhấp",
    hover: "Đang di chuột",
    scroll: "Đang cuộn trang",
    type: "Đang nhập nội dung",
    wait: "Đang chờ",
    drag: "Đang kéo",
    capture: "Đang chụp trang",
    script: "Đang chạy script",
    other: "Đang thao tác"
  };
  var IDLE_ACTION_LABEL = "Đang nghĩ…";

  // Task 7.7 (openspec/changes/add-permission-modes-and-threat-signals): the
  // controlled tab's current risk category, straight from the host's
  // `tab_risk_update` event (reports/wave2h-events.md), forwarded here the
  // same way an approval signal already is — a `{kind:"riskUpdate", tabId,
  // category}` synthetic event (see reduceOverlayState's own comment on it).
  // This chip is advisory-only, exactly like the category itself is on the
  // host: it never gates anything, never blocks the Stop/Open-panel
  // controls, and offers no acknowledge/dismiss action of its own. Per spec
  // ("uncategorized... distinguishable from a category of low risk") the
  // three categories get three DISTINCT labels — "uncategorized" is never
  // collapsed into "low" here.
  var RISK_LABELS = {
    uncategorized: "Chưa phân loại",
    low: "Rủi ro thấp",
    elevated: "Rủi ro cao"
  };
  var DEFAULT_RISK_CATEGORY = "uncategorized";

  // The action types that may legitimately carry a pointer position (mirrors
  // action-events.js's own POINTER_ACTION_TYPES). Only these get a cursor
  // label naming the action (design.md D1 "Consequence" / task 2.5) — a
  // read/script/capture/type/etc. never moved the pointer, so the cursor's
  // OWN label falls back to the idle wording even while the bar's action
  // label (above) still reports what is really happening.
  var POINTER_ACTION_TYPES = { click: true, hover: true, scroll: true, drag: true };
  var CURSOR_ACTION_LABELS = { click: "click", hover: "di chuột", scroll: "cuộn", drag: "kéo" };
  var CURSOR_IDLE_LABEL = "đang nghĩ";

  // design.md D8: capture-phase listeners registered on `window`, suppressing
  // trusted input to the page's own content while a run holds it. `{capture:
  // true, passive:false}` is mandatory for every entry here — see
  // handleBlockableEvent()'s own header for why.
  var BLOCKABLE_EVENT_TYPES = [
    "pointerdown", "pointerup", "pointermove",
    "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu",
    "wheel",
    "keydown", "keypress", "keyup", "beforeinput",
    "touchstart", "touchmove", "touchend",
    "paste", "drop"
  ];

  // design.md D10: the wait-cursor style rule, appended to (and removed from)
  // the PAGE's own document — the one deliberate exception to this overlay
  // never touching the page's own styling (see setWaitCursorActive()).
  // Universal, not `html`, because `cursor` is inherited, not cascaded: a
  // bare `html{cursor:wait}` loses to any page rule on a descendant
  // (`a{cursor:pointer}` is on nearly every page).
  var WAIT_CURSOR_CSS = "*, *::before, *::after { cursor: wait !important; }";

  /** True once `nowMs - lastEventAtMs` exceeds `maxAgeMs`, or immediately if
   * no event has ever been recorded (`lastEventAtMs == null`) — a freshly
   * created overlay with no real dispatch yet is never shown as active. */
  function isHeartbeatExpired(nowMs, lastEventAtMs, maxAgeMs) {
    if (lastEventAtMs === null || lastEventAtMs === undefined) return true;
    return nowMs - lastEventAtMs > maxAgeMs;
  }

  /** Is the capture-hide still in force? Deliberately the same shape as
   * isHeartbeatExpired above: a hide with no timestamp is not in force at all,
   * and one older than the bound has outlived any real capture, so the restore
   * that should have cleared it is never coming. */
  function isCaptureHideInForce(nowMs, hiddenAtMs, maxAgeMs) {
    if (hiddenAtMs === null || hiddenAtMs === undefined) return false;
    return nowMs - hiddenAtMs <= maxAgeMs;
  }

  /** Apply a pointer point's OWN frame offset (design.md 5c / the schema
   * report's "Pointer field — coordinate system, frame limitation" section).
   * `event.pointer.points[].x/.y` already ARE the exact CSS-pixel
   * viewport-relative coordinates dispatched via CDP — the same coordinate
   * space `position: fixed` uses — so scroll, zoom and device-pixel-ratio
   * need NO transform here at all (the browser already resolves all three
   * into that one shared coordinate space for both `position: fixed`
   * layout and CDP input dispatch). The one genuinely open case is a real
   * per-frame offset for an action inside a nested/iframe document —
   * `pointer.frame` is `{frameId:0, isMainFrame:true}` today (no offset
   * ever populated by extension/background.js/content.js yet, per the
   * schema report), so this function is the forward-declared extension
   * point: it adds `frame.offsetX`/`frame.offsetY` when a future batch
   * starts populating them, and is the identity function until then. */
  function resolveViewportPoint(point, frame) {
    var offsetX = (frame && typeof frame.offsetX === "number") ? frame.offsetX : 0;
    var offsetY = (frame && typeof frame.offsetY === "number") ? frame.offsetY : 0;
    return { x: point.x + offsetX, y: point.y + offsetY };
  }

  /** One easing step toward a target position (design.md D5, page-agent's
   * SimulatorMask.#moveCursorToTarget: `new = current + (target-current)*factor`,
   * snap once the remaining distance on both axes is under `snapPx`). Pure —
   * takes the current drawn position, the target, and the tuning, returns
   * the next drawn position; never reads a clock or writes anything. `null`
   * `current` (nothing drawn yet) or `null` `target` (nothing to draw)
   * resolve to an immediate jump/absence rather than easing from nowhere. */
  function easeTowardTarget(current, target, factor, snapPx) {
    if (!target) return null;
    if (!current) return { x: target.x, y: target.y };
    var dx = target.x - current.x;
    var dy = target.y - current.y;
    if (Math.abs(dx) < snapPx && Math.abs(dy) < snapPx) return { x: target.x, y: target.y };
    return { x: current.x + dx * factor, y: current.y + dy * factor };
  }

  /** design.md D8: should a TRUSTED event aimed at page content be blocked
   * right now? Pure — every input is a value the caller already has, never a
   * clock or DOM read of its own, so it is testable exactly like
   * isHeartbeatExpired above. The exemptions that do NOT belong here (the
   * overlay's own controls, Tab/Shift+Tab, untrustedness) are the caller's
   * job — this function only answers "is the run in a state where the
   * operator's input to the PAGE should be suppressed at all". */
  function shouldBlockInput(state, nowMs, maxAgeMs, scrollTailUntilMs) {
    if (state.runId === null || state.runId === undefined) return false; // task 7.9 — no run, nothing to guard
    if (isHeartbeatExpired(nowMs, state.lastEventAt, maxAgeMs)) return false; // task 7.8 — evaluated fresh, never a cached boolean
    if (state.pendingApproval) return false; // task 7.11 — lifted while the operator must be able to read the page
    var scrollTailActive = typeof scrollTailUntilMs === "number" && nowMs < scrollTailUntilMs;
    if (state.actionInFlight || scrollTailActive) return false; // task 7.5/7.6 — the agent itself is (or just was) acting
    return true;
  }

  /** The overlay's own state machine. Pure: given the previous state, one
   * REAL action-event (or a local `{kind:"teardown"}` synthetic event — see
   * "Messaging wiring" below), and `nowMs`, returns the next state. Never
   * reads a clock other than the `nowMs` it is given, so it is fully
   * deterministic and testable.
   *
   * `active` is deliberately NOT a field stored here — it is a DERIVED
   * value (see computeRenderModel below), computed from `lastEventAt`
   * against the CURRENT clock at paint/render time, not toggled per event.
   * This is what makes heartbeat expiry uniform across every cause design.md
   * 5c lists (stop, cancellation, debugger detach, tab close, document
   * replacement, companion loss): ALL of them are, from this module's own
   * point of view, simply "no more real events arrive" — a single
   * mechanism covers every one of them as a fallback, even the ones that
   * ALSO get a more immediate, explicit teardown message from
   * extension/background.js (see that file's `teardownOverlayForRun`).
   *
   * design.md D2/D5 add two more pieces of state, both derived only from
   * data the event stream already carries: `stepCount`/`startedAt` (a
   * counter on every `kind==="start"` and the first event's own
   * `timing.startedAt`), and `pendingApproval` (set/cleared by the new
   * `kind==="approval"` synthetic event extension/background.js's approval
   * bridge produces — see section 3 below).
   *
   * `actionInFlight`: true from the moment a real `start`/`progress` event
   * is seen until the matching `complete`/`error` settles it — this, not
   * `lastActionType` alone, is what computeRenderModel() must consult to
   * decide whether the CURSOR may still claim an action. `lastActionType`
   * is deliberately never cleared (the bar's "what happened most recently"
   * label and the step counter both still want it after the action ends),
   * but that means it is NOT a safe proxy for "is something in flight right
   * now" — a `keepalive` (nothing dispatched) arrives on the same 1s timer
   * whether or not an action is currently open, so it cannot be read as
   * "settle" either. `actionInFlight` is the one field that exists only to
   * answer that question, set/cleared exclusively by real start/progress/
   * complete/error events, and left untouched by keepalive/approval (both
   * copy it through unchanged, like every other field they do not own).
   */
  function reduceOverlayState(state, event, nowMs) {
    if (event && event.kind === "keepalive") {
      // The run is still going, but nothing was dispatched. Refresh the
      // liveness clock and change NOTHING else — no cursor move, no click,
      // no step count, no start time, no pending approval.
      //
      // This exists because the overlay used to go dark whenever the model
      // was thinking: actions arrive in bursts seconds apart, the heartbeat
      // expires in under three, and the page looked unattended in exactly
      // the gaps where the operator most needs to see that it is not. The
      // expiry itself is untouched and still does its job — the moment the
      // service worker, the companion, or the run stops, the keepalives stop
      // with them and the overlay clears on its own within the same bound.
      var alive = {};
      for (var k in state) if (Object.prototype.hasOwnProperty.call(state, k)) alive[k] = state[k];
      alive.lastEventAt = nowMs;
      if (event.runId !== undefined) alive.runId = event.runId;
      if (event.conversationId !== undefined) alive.conversationId = event.conversationId;
      if (event.tabId !== undefined) alive.tabId = event.tabId;
      return alive;
    }
    if (event && event.kind === "approval") {
      // A pending/resolved approval signal (design.md D5) — state, not a
      // dispatched action. Refreshes liveness like every other real signal
      // (a pending approval is proof the run is alive), but NEVER touches
      // cursor/clickAt/dragHeld/stepCount/startedAt/lastActionType: a run
      // waiting for permission has not moved the pointer or dispatched
      // anything new.
      var withApproval = {};
      for (var ak in state) if (Object.prototype.hasOwnProperty.call(state, ak)) withApproval[ak] = state[ak];
      withApproval.lastEventAt = nowMs;
      if (event.phase === "pending") {
        withApproval.pendingApproval = { requestId: event.requestId, action: event.action, target: event.target };
      } else if (event.phase === "resolved") {
        // A resolved decision for an unknown/already-cleared requestId is a
        // silent no-op (design.md D5 "Ordering") — the panel and this
        // overlay both observe the same decision, and the panel's own path
        // may clear it first.
        if (state.pendingApproval && state.pendingApproval.requestId === event.requestId) {
          withApproval.pendingApproval = null;
        }
      }
      return withApproval;
    }
    if (event && event.kind === "riskUpdate") {
      // Task 7.7: the controlled tab's risk category, per the host's
      // `tab_risk_update` (relayed the same way an approval signal is —
      // see this function's own header). State about the PAGE, not a
      // dispatched action: refreshes liveness like `keepalive`/`approval`
      // (a real signal proves the run is alive), never touches cursor/
      // click/drag/step/start. An unrecognized category value is dropped
      // rather than accepted verbatim — this module must never render a
      // category the host did not actually report.
      var withRisk = {};
      for (var rk in state) if (Object.prototype.hasOwnProperty.call(state, rk)) withRisk[rk] = state[rk];
      withRisk.lastEventAt = nowMs;
      if (event.tabId !== undefined) withRisk.tabId = event.tabId;
      if (event.category === "uncategorized" || event.category === "low" || event.category === "elevated") {
        withRisk.riskCategory = event.category;
      }
      return withRisk;
    }
    if (!event || event.kind === "teardown") {
      // Hard, immediate clear — used for the explicit signals
      // extension/background.js can detect right away (run_stopped,
      // debugger detach, companion disconnect). lastEventAt=null makes
      // isHeartbeatExpired() return true on the very next check, with no
      // need to wait out the timer. A pending approval never outlives the
      // run that raised it (spec: "Blocked-on-approval is visible on the
      // controlled page" — "A stale waiting state cannot persist").
      return {
        lastEventAt: null,
        cursor: state.cursor,
        clickAt: null,
        dragHeld: false,
        runId: state.runId,
        conversationId: state.conversationId,
        tabId: state.tabId,
        lastActionType: null,
        stepCount: state.stepCount,
        startedAt: state.startedAt,
        pendingApproval: null,
        actionInFlight: false,
        // Task 7.7: the risk category is a fact about the PAGE, not the run
        // — teardown clears run-scoped state (pendingApproval, motion) but a
        // real navigation-driven reset arrives as its own `riskUpdate` event
        // (host: "uncategorized right after a navigation"), never inferred
        // here from a run ending.
        riskCategory: state.riskCategory
      };
    }
    var next = {
      lastEventAt: nowMs,
      cursor: state.cursor,
      clickAt: state.clickAt,
      dragHeld: state.dragHeld,
      runId: event.runId !== undefined ? event.runId : state.runId,
      conversationId: event.conversationId !== undefined ? event.conversationId : state.conversationId,
      tabId: event.tabId !== undefined ? event.tabId : state.tabId,
      lastActionType: (event.action && event.action.type) || state.lastActionType,
      stepCount: state.stepCount || 0,
      // design.md D2: "records startedAt from the first event it sees" —
      // captured once, from whichever real event reaches this branch first.
      startedAt: (state.startedAt === null || state.startedAt === undefined)
        ? ((event.timing && typeof event.timing.startedAt === "number") ? event.timing.startedAt : nowMs)
        : state.startedAt,
      pendingApproval: state.pendingApproval || null,
      actionInFlight: state.actionInFlight || false,
      // Task 7.7: an ordinary dispatched action never carries or changes a
      // risk category — only a real `riskUpdate` event (handled above) does.
      riskCategory: state.riskCategory
    };
    if (event.kind === "start") {
      next.stepCount = (state.stepCount || 0) + 1;
      next.actionInFlight = true;
    }
    // Only a `progress` event ever carries `pointer` (buildEvent() in
    // action-events.js enforces this at the source) — and ONLY for a
    // pointer-capable action.type (click/hover/scroll/drag). A DOM/
    // script-only action (read/find/open_page/script/wait/capture/other)
    // never reaches this branch, so this module never fabricates a cursor
    // position for one — it simply leaves `cursor` exactly as it already
    // was (the last REAL dispatched position), which is the honest choice:
    // the pointer did not move, so the rendered cursor should not move
    // either.
    if (event.pointer && Array.isArray(event.pointer.points) && event.pointer.points.length) {
      var points = event.pointer.points;
      var last = points[points.length - 1];
      next.cursor = resolveViewportPoint(last, event.pointer.frame);
      var hadDown = false;
      for (var i = 0; i < points.length; i++) {
        if (points[i].phase === "down") { hadDown = true; break; }
      }
      if (hadDown) next.clickAt = nowMs;
      next.dragHeld = next.lastActionType === "drag";
      // A real dispatched pointer sample is, by definition, an action in
      // flight — covers the case where this overlay attaches mid-action and
      // sees a `progress` before ever seeing that action's own `start`.
      next.actionInFlight = true;
    } else if (event.kind === "complete" || event.kind === "error") {
      // A drag's own `complete`/`error` always ends the held state, even if
      // (for a drag that dispatched zero intermediate move samples before
      // settling) no pointer branch ever ran for this particular event.
      next.dragHeld = false;
      // The action has settled. `lastActionType` deliberately stays set (the
      // bar's label and step counter still want it), but nothing is in
      // flight any more — the cursor must stop claiming otherwise, for
      // exactly as long as this holds, even across any number of keepalives
      // that follow before the next real `start` (spec: "a period with no
      // action in flight" must be a real, reachable cursor state).
      next.actionInFlight = false;
    }
    return next;
  }

  /** Turn a state snapshot into exactly what should be painted right now —
   * the ONLY place `nowMs` is compared against `lastEventAt`/`clickAt`, so
   * heartbeat expiry and click-ring fade-out both "just happen" on the next
   * paint tick with no separate timer bookkeeping inside the state
   * machine. Also the ONLY place the action-label map (design.md D1) and
   * the pointer-capable check (task 2.5) are consulted — this function
   * knows whether a cursor position exists, which is what decides whether
   * the cursor's OWN label may claim the current action.
   *
   * design.md D2: `capturedHidden` is now an INPUT (not a paintOverlay()
   * argument applied after the fact), and `visible` is an OUTPUT alongside
   * `active` — the single field paintOverlay() reads to decide the host's
   * on-screen state. `locked` (design.md D10) is the same condition D8's
   * input-blocking uses, minus the action-in-flight gate: the wait cursor
   * must NOT flip on and off with every dispatched action. */
  function computeRenderModel(state, nowMs, maxAgeMs, capturedHidden) {
    var maxAge = typeof maxAgeMs === "number" ? maxAgeMs : HEARTBEAT_MAX_AGE_MS;
    var active = !isHeartbeatExpired(nowMs, state.lastEventAt, maxAge);
    if (!active) {
      return {
        active: false,
        visible: false,
        locked: false,
        cursor: null,
        clickRing: false,
        dragHeld: false,
        badge: false,
        frame: false,
        cursorState: "idle",
        cursorLabel: CURSOR_IDLE_LABEL,
        barState: "idle",
        actionLabel: IDLE_ACTION_LABEL,
        approval: null,
        stepCount: 0,
        elapsedLabel: "",
        // Task 7.7: nothing is shown while inactive — same reasoning as
        // every other field in this branch (an expired heartbeat means
        // nothing here should claim to reflect the live page any more).
        riskCategory: null,
        riskLabel: ""
      };
    }
    var clickRing = state.clickAt !== null && state.clickAt !== undefined && (nowMs - state.clickAt) < CLICK_RING_DURATION_MS;
    var dragHeld = !!state.dragHeld;
    var lastType = state.lastActionType;
    var isPointerType = !!(lastType && POINTER_ACTION_TYPES[lastType]);
    // The cursor may claim an action ONLY while one is actually in flight
    // (state.actionInFlight, cleared by reduceOverlayState on
    // complete/error) — `lastActionType` alone is never enough, because it
    // is deliberately never cleared once an action settles (the bar's own
    // label and the step counter still need it). Without this gate the
    // cursor would keep pulsing "click"/"cuộn"/etc. for the rest of the run,
    // including the long gaps where only keepalives arrive and nothing is
    // being dispatched — the exact fabricated-active-state failure this
    // file's own header forbids.
    var inFlight = !!state.actionInFlight;
    var cursorState = dragHeld ? "dragging" : ((isPointerType && inFlight) ? "acting" : "idle");
    var cursorLabel = (isPointerType && inFlight) ? (CURSOR_ACTION_LABELS[lastType] || CURSOR_IDLE_LABEL) : CURSOR_IDLE_LABEL;
    var actionLabel = (lastType && ACTION_LABELS[lastType]) || IDLE_ACTION_LABEL;

    // Bar state (design.md / task 4.6): waiting takes priority over running
    // — a run can be mid-action when the approval fires, and the operator
    // needs to see the block, not the action that triggered it. "idle"
    // covers the narrow window before this attach has seen its first real
    // action (only keepalives so far), matching the "thinking" wording the
    // cursor already uses in that same state.
    var approval = null;
    var barState = "idle";
    if (state.pendingApproval) {
      barState = "waiting";
      approval = {
        requestId: state.pendingApproval.requestId,
        action: state.pendingApproval.action,
        target: state.pendingApproval.target
      };
    } else if (lastType) {
      barState = "running";
    }

    var elapsedLabel = "";
    if (typeof state.startedAt === "number") {
      var elapsedSec = Math.max(0, Math.floor((nowMs - state.startedAt) / 1000));
      elapsedLabel = elapsedSec < 60 ? (elapsedSec + "s") : (Math.floor(elapsedSec / 60) + "m " + (elapsedSec % 60) + "s");
    }

    // design.md D10: bound to the SAME condition D8 blocks input on, minus
    // the action-in-flight gate — a run genuinely holding the page is
    // locked whether or not it happens to be mid-dispatch right now.
    var locked = !!state.runId && !state.pendingApproval;

    // Task 7.7: the controlled tab's current risk category. Defaults to
    // "uncategorized" (never fabricated as "low") whenever this attach has
    // not yet seen a real `riskUpdate` — the SAME distinction the host's own
    // TabRiskRegistry makes (spec: "uncategorized... distinguishable from a
    // category of low risk"), and the same honest default this legitimately
    // shows right after a navigation, before any new content has been read.
    var riskCategory = (state.riskCategory === "low" || state.riskCategory === "elevated")
      ? state.riskCategory
      : DEFAULT_RISK_CATEGORY;
    var riskLabel = RISK_LABELS[riskCategory];

    return {
      active: true,
      visible: !capturedHidden,
      locked: locked,
      cursor: state.cursor,
      clickRing: clickRing,
      dragHeld: dragHeld,
      // Shown for the whole session, independent of whether a pointer
      // position is known yet: a run that has so far only read the page is
      // still a run driving it.
      badge: true,
      frame: true,
      cursorState: cursorState,
      cursorLabel: cursorLabel,
      barState: barState,
      actionLabel: actionLabel,
      approval: approval,
      stepCount: state.stepCount || 0,
      elapsedLabel: elapsedLabel,
      riskCategory: riskCategory,
      riskLabel: riskLabel
    };
  }

  /** Coalesce many rapid render requests into at most one call per animation
   * frame (design.md 5c: "Throttle rendering without changing the action
   * schedule"). This wraps ONLY the paint step — every caller in section 3
   * below updates `state` synchronously, immediately, on every real event;
   * this scheduler only ever delays the (expensive, visual-only) DOM write
   * that reflects the CURRENT state, never the state update itself and
   * never anything upstream of it (dispatch already happened before the
   * event object even existed — see action-events.js's own header). A
   * caller that requests twice before a frame fires gets exactly one
   * scheduled callback, which reads whatever is current at flush time —
   * proven in test/overlay-pointer.test.mjs with a manually-stepped fake
   * `scheduleFrame`. */
  function createRenderScheduler(scheduleFrame) {
    var scheduled = false;
    return function requestRender(renderNow) {
      if (scheduled) return;
      scheduled = true;
      scheduleFrame(function () {
        scheduled = false;
        renderNow();
      });
    };
  }

  // === 2. DOM construction + paint =========================================

  var OVERLAY_CSS =
    ":host{all:initial;--browzy-cyan:oklch(0.74 0.19 215);--browzy-violet:oklch(0.74 0.19 300);" +
    "--browzy-cursor-size:72px;}" +
    // ---- Cursor ------------------------------------------------------------
    ".browzy-cursor{position:fixed;left:0;top:0;width:var(--browzy-cursor-size);" +
    "height:var(--browzy-cursor-size);pointer-events:none;z-index:2147483647;" +
    "transform:translate(-11px,-9px);filter:drop-shadow(0 3px 10px rgba(0,0,0,.5));" +
    "opacity:0;transition:opacity 120ms ease;}" +
    ".browzy-cursor svg{display:block;width:100%;height:100%;}" +
    ".browzy-cursor-inner{position:relative;opacity:1;width:100%;height:100%;}" +
    // Idle used to render the cursor at half opacity in flat grey, which on a
    // light page read as "there is no cursor at all" — the operator could not
    // tell a run holding their page from no run. Idle is still visibly calmer
    // than acting (no ring, muted label), but it stays a cursor you can see.
    ".browzy-cursor[data-state='idle'] .browzy-cursor-inner{opacity:.85;}" +
    ".browzy-cursor-fill{fill:url(#browzyCursorGrad);}" +
    ".browzy-cursor[data-state='dragging'] .browzy-cursor-fill{fill:var(--browzy-violet);}" +
    ".browzy-cursor[data-state='idle'] .browzy-cursor-fill{fill:oklch(0.72 0.09 258);}" +
    // Parked: this tab is part of the run but the pointer has never been here,
    // so there is no real position to draw at. Anchored to the status bar
    // rather than floated over the page, precisely so it cannot be mistaken
    // for the agent pointing at something on this page.
    ".browzy-cursor.is-parked{left:50%;top:auto;bottom:68px;transform:translate(-50%,0);opacity:1;}" +
    ".browzy-cursor-label{position:absolute;left:58px;top:55px;display:flex;align-items:center;gap:7px;" +
    "padding:5px 11px 5px 9px;border-radius:8px;background:#08080c;" +
    "border:1px solid color-mix(in oklch,var(--browzy-violet) 40%,transparent);" +
    "white-space:nowrap;pointer-events:none;}" +
    // design.md D9: at 72px, a cursor near the right/bottom viewport edge can
    // push its label off-screen — the label flips to the other side of the
    // arrow rather than overflowing (task 10.5).
    ".browzy-cursor.is-label-flip-x .browzy-cursor-label{left:auto;right:14px;}" +
    ".browzy-cursor.is-label-flip-y .browzy-cursor-label{top:auto;bottom:14px;}" +
    ".browzy-cursor-dot{width:6px;height:6px;border-radius:50%;background:#4a4a5a;flex:none;}" +
    ".browzy-cursor[data-state='acting'] .browzy-cursor-dot{background:var(--browzy-cyan);animation:browzy-blip 1.2s ease-in-out infinite;}" +
    ".browzy-cursor[data-state='dragging'] .browzy-cursor-dot{background:var(--browzy-violet);}" +
    ".browzy-cursor-name{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:11px;font-weight:500;color:#e8e6f2;}" +
    ".browzy-cursor[data-state='idle'] .browzy-cursor-name{color:#8d8aa0;}" +
    ".browzy-cursor-sep{width:1px;height:11px;background:#2a2a35;flex:none;}" +
    ".browzy-cursor-action{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:11px;color:#8d8aa0;}" +
    ".browzy-cursor[data-state='idle'] .browzy-cursor-action{color:#6f6c82;}" +
    // ---- Click feedback: two ripples, offset 0.45s (task 3.1/3.2) ---------
    // design.md D9: retuned alongside the larger cursor (96px, proportionate
    // but not linearly scaled — a linear 2.77x ripple would be enormous).
    ".browzy-click-ring{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;" +
    "z-index:2147483646;display:none;}" +
    ".browzy-click-ring.is-active{display:block;}" +
    ".browzy-ripple{position:absolute;left:-48px;top:-48px;width:96px;height:96px;border-radius:50%;pointer-events:none;}" +
    ".browzy-ripple-a{border:1.5px solid var(--browzy-cyan);animation:browzy-ripple 1.4s cubic-bezier(.2,0,0,1);}" +
    ".browzy-ripple-b{border:1.5px solid var(--browzy-violet);animation:browzy-ripple 1.4s cubic-bezier(.2,0,0,1) .45s;}" +
    // ---- Ambient glow: edge-weighted, additive, bound to `visible` (D11) --
    // Never full-viewport — the overlay hides around EVERY screenshot and
    // the agent screenshots on nearly every step, so a layer covering the
    // content would blink across what the operator is reading continuously.
    // Weighted to the edges instead: the content region stays fully
    // transparent, so a capture cycle only removes/restores light at the
    // borders.
    ".browzy-glow{position:fixed;inset:0;pointer-events:none;z-index:2147483643;opacity:0;" +
    "transition:opacity 200ms ease;" +
    "background:" +
    "radial-gradient(ellipse 60% 40% at top,color-mix(in oklch,var(--browzy-cyan) 14%,transparent) 0%,transparent 70%)," +
    "radial-gradient(ellipse 60% 40% at bottom,color-mix(in oklch,var(--browzy-violet) 14%,transparent) 0%,transparent 70%)," +
    "radial-gradient(ellipse 40% 60% at left,color-mix(in oklch,var(--browzy-cyan) 10%,transparent) 0%,transparent 70%)," +
    "radial-gradient(ellipse 40% 60% at right,color-mix(in oklch,var(--browzy-violet) 10%,transparent) 0%,transparent 70%);}" +
    ".browzy-glow.is-active{opacity:1;animation:browzy-glow-breathe 5s ease-in-out infinite;}" +
    // ---- The remote-control frame: sweep + static ring + corners ----------
    // A masked conic-gradient sweep that travels the viewport edge (task
    // 1.2), a permanent low-opacity ring beneath it so the outline never
    // breaks, and four static corner brackets (task 1.3) — the two pieces
    // that survive prefers-reduced-motion (task 1.4). pointer-events:none
    // throughout, so this layer can never intercept a page click.
    ".browzy-frame{position:fixed;inset:0;pointer-events:none;z-index:2147483645;" +
    "opacity:0;transition:opacity 160ms ease;}" +
    ".browzy-frame.is-active{opacity:1;}" +
    ".browzy-frame-mask{position:absolute;inset:0;overflow:hidden;pointer-events:none;" +
    "-webkit-mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);" +
    "mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);" +
    "mask-composite:exclude;border:2px solid transparent;box-sizing:border-box;}" +
    ".browzy-frame-sweep{position:absolute;inset:-50%;pointer-events:none;" +
    "background:conic-gradient(from 0deg,transparent 0deg,transparent 26deg," +
    "var(--browzy-cyan) 62deg,var(--browzy-violet) 118deg,transparent 168deg,transparent 206deg," +
    "var(--browzy-violet) 242deg,var(--browzy-cyan) 298deg,transparent 344deg);" +
    "animation:browzy-sweep 7s linear infinite;}" +
    ".browzy-frame-ring{position:absolute;inset:0;pointer-events:none;" +
    "box-shadow:inset 0 0 0 2px color-mix(in oklch,var(--browzy-violet) 22%,transparent);}" +
    ".browzy-corners{position:absolute;inset:0;pointer-events:none;}" +
    ".browzy-corner{position:absolute;pointer-events:none;}" +
    ".browzy-corner-tl{top:10px;left:10px;}" +
    ".browzy-corner-tr{top:10px;right:10px;}" +
    ".browzy-corner-bl{bottom:10px;left:10px;}" +
    ".browzy-corner-br{bottom:10px;right:10px;}" +
    // ---- Status bar: anchored bottom-center (task 4.2), never a corner ----
    ".browzy-badge{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);" +
    "display:flex;align-items:center;gap:0;height:46px;box-sizing:border-box;" +
    "padding:7px 7px 7px 16px;border-radius:999px;background:rgba(10,10,15,.92);" +
    "border:1px solid color-mix(in oklch,var(--browzy-violet) 34%,transparent);" +
    "box-shadow:0 16px 44px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.03) inset;" +
    "font:13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e8e6f2;" +
    "pointer-events:none;z-index:2147483647;animation:browzy-rise-in 420ms cubic-bezier(.2,0,0,1) both;}" +
    // task 8.4: the UA `[hidden]{display:none}` rule loses to this element's
    // own `display:flex` — without this override, `badgeEl.hidden = true`
    // (idle/waiting states) painted nothing yet still occupied nothing
    // visually distinct from "shown", which is real in a browser even though
    // no test using the fake DOM's own `.hidden` property could ever catch
    // it (design.md "Risks" section).
    ".browzy-badge[hidden]{display:none;}" +
    ".browzy-badge[data-state='waiting']{border-color:oklch(0.74 0.15 85 / .5);}" +
    ".browzy-badge[data-state='idle']{border-color:#24242e;padding:7px 16px;}" +
    ".browzy-badge-dot-wrap{position:relative;display:flex;width:9px;height:9px;margin-right:12px;flex:none;}" +
    ".browzy-badge-dot{position:absolute;inset:0;border-radius:50%;background:#4a4a5a;}" +
    ".browzy-badge-dot-ring{position:absolute;inset:-5px;border-radius:50%;border:1px solid transparent;}" +
    ".browzy-badge[data-state='running'] .browzy-badge-dot{background:var(--browzy-cyan);animation:browzy-breathe 1.9s ease-in-out infinite;}" +
    ".browzy-badge[data-state='running'] .browzy-badge-dot-ring{border-color:color-mix(in oklch,var(--browzy-cyan) 45%,transparent);}" +
    ".browzy-badge[data-state='waiting'] .browzy-badge-dot{background:oklch(0.78 0.15 85);}" +
    ".browzy-badge-name{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;" +
    "font-size:11px;font-weight:700;letter-spacing:.16em;color:#e8e6f2;flex:none;}" +
    ".browzy-badge[data-state='idle'] .browzy-badge-name{color:#8d8aa0;}" +
    // Task 7.7: the risk chip — a plain label, never interactive
    // (pointer-events already off on the whole badge except its two real
    // buttons), colored by data-level so "uncategorized"/"low"/"elevated"
    // are visually distinct, never collapsed into one look.
    ".browzy-risk{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;" +
    "font-size:10.5px;font-weight:600;letter-spacing:.04em;white-space:nowrap;" +
    "padding:2px 8px;border-radius:999px;border:1px solid #35354a;color:#8d8aa0;}" +
    ".browzy-risk[data-level='low']{border-color:color-mix(in oklch,var(--browzy-cyan) 45%,transparent);color:#bfe9e6;}" +
    ".browzy-risk[data-level='elevated']{border-color:oklch(0.74 0.15 85 / .7);color:oklch(0.86 0.13 85);" +
    "background:color-mix(in oklch,oklch(0.74 0.15 85) 14%,transparent);}" +
    ".browzy-badge-sep{width:1px;height:16px;margin:0 14px;background:#24242e;flex:none;}" +
    ".browzy-badge-text{font-size:13.5px;color:#b9b6c8;white-space:nowrap;}" +
    ".browzy-badge[data-state='waiting'] .browzy-badge-text{color:#e8e2c8;}" +
    ".browzy-badge[data-state='idle'] .browzy-badge-text{color:#8d8aa0;}" +
    ".browzy-badge-trace{margin:0 14px;flex:none;line-height:0;}" +
    ".browzy-badge-trace-path{animation:browzy-trace 1.1s linear infinite;}" +
    ".browzy-badge-stats{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;" +
    "font-size:11px;color:#6f6c82;white-space:nowrap;flex:none;}" +
    ".browzy-stop{pointer-events:auto;display:inline-flex;align-items:center;gap:7px;" +
    "height:32px;padding:0 15px;border:1px solid color-mix(in oklch,var(--browzy-violet) 42%,transparent);" +
    "border-radius:999px;background:color-mix(in oklch,var(--browzy-violet) 15%,transparent);" +
    "color:#f0eefa;font:600 13px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
    "cursor:pointer;flex:none;}" +
    ".browzy-stop[hidden]{display:none;}" +
    ".browzy-stop:focus-visible{outline:2px solid var(--browzy-cyan);outline-offset:2px;}" +
    // The ONLY other interactive control this overlay ever renders — routes
    // to the panel, never grants or denies anything itself (design.md D6 /
    // spec: "Blocked-on-approval is visible on the controlled page").
    ".browzy-open-panel{pointer-events:auto;height:32px;padding:0 15px;border:0;" +
    "border-radius:999px;background:oklch(0.78 0.15 85);color:#171204;" +
    "font:600 13px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;cursor:pointer;flex:none;}" +
    ".browzy-open-panel[hidden]{display:none;}" +
    ".browzy-open-panel:focus-visible{outline:2px solid #fff;outline-offset:2px;}" +
    "@keyframes browzy-sweep{to{transform:rotate(1turn);}}" +
    "@keyframes browzy-ripple{from{transform:scale(.35);opacity:.9;}to{transform:scale(1);opacity:0;}}" +
    "@keyframes browzy-blip{50%{opacity:.35;transform:scale(.82);}}" +
    "@keyframes browzy-breathe{50%{opacity:.55;}}" +
    "@keyframes browzy-glow-breathe{50%{opacity:.6;}}" +
    "@keyframes browzy-rise-in{from{opacity:0;transform:translateY(6px);}}" +
    "@keyframes browzy-trace{to{stroke-dashoffset:-34;}}" +
    "@media (prefers-reduced-motion:reduce){" +
    ".browzy-cursor,.browzy-frame,.browzy-glow{transition:none;}" +
    ".browzy-frame-sweep{animation:none;}" +
    ".browzy-glow{animation:none!important;}" +
    ".browzy-cursor-dot,.browzy-badge-dot,.browzy-ripple-a,.browzy-ripple-b,.browzy-badge-trace-path{animation:none!important;}}";

  var CURSOR_SVG =
    '<svg viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="browzy-cursor-fill" d="M4 3.2 20.4 12.1 13.2 13.6 10.4 20.6z" ' +
    'stroke="#08080c" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<defs><linearGradient id="browzyCursorGrad" x1="4" y1="3" x2="18" y2="20">' +
    '<stop stop-color="oklch(0.86 0.13 215)"/><stop offset="1" stop-color="oklch(0.70 0.20 300)"/></linearGradient></defs>' +
    "</svg>";

  // Four static corner brackets (task 1.3): 34x34, stroke 2, round caps,
  // positioned 10px from each viewport corner via the .browzy-corner-*
  // classes above. Never animated — this and .browzy-frame-ring are what
  // remain under prefers-reduced-motion (task 1.4).
  var CORNER_SVGS =
    '<svg class="browzy-corner browzy-corner-tl" width="34" height="34" viewBox="0 0 34 34" fill="none">' +
    '<path d="M1 12V1h11" stroke="url(#browzyCornerA)" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<svg class="browzy-corner browzy-corner-tr" width="34" height="34" viewBox="0 0 34 34" fill="none">' +
    '<path d="M33 12V1H22" stroke="url(#browzyCornerA)" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<svg class="browzy-corner browzy-corner-bl" width="34" height="34" viewBox="0 0 34 34" fill="none">' +
    '<path d="M1 22v11h11" stroke="url(#browzyCornerB)" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<svg class="browzy-corner browzy-corner-br" width="34" height="34" viewBox="0 0 34 34" fill="none">' +
    '<path d="M33 22v11H22" stroke="url(#browzyCornerB)" stroke-width="2" stroke-linecap="round"/></svg>' +
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
    '<linearGradient id="browzyCornerA" x1="1" y1="12" x2="12" y2="1">' +
    '<stop stop-color="oklch(0.74 0.19 215)"/><stop offset="1" stop-color="oklch(0.74 0.19 300)"/></linearGradient>' +
    '<linearGradient id="browzyCornerB" x1="1" y1="22" x2="12" y2="33">' +
    '<stop stop-color="oklch(0.74 0.19 300)"/><stop offset="1" stop-color="oklch(0.74 0.19 215)"/></linearGradient>' +
    "</defs></svg>";

  // A stroked trace path in place of a spinner (task 4.3) — shown only in
  // the "running" bar state.
  var BADGE_TRACE_SVG =
    '<svg width="52" height="16" viewBox="0 0 52 16" fill="none">' +
    '<path class="browzy-badge-trace-path" d="M0 8h9l3-5 4 10 3.5-7 3 3H26l3-4 4 8 3-6 2.5 2H52" ' +
    'stroke="url(#browzyTraceGrad)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 3"/>' +
    '<defs><linearGradient id="browzyTraceGrad" x1="0" y1="8" x2="52" y2="8">' +
    '<stop stop-color="oklch(0.74 0.19 215)"/><stop offset="1" stop-color="oklch(0.74 0.19 300)"/></linearGradient></defs>' +
    "</svg>";

  /** Build the overlay's isolated DOM: a `position:fixed` host attached to
   * `document.documentElement` (NOT `document.body`) with a closed shadow
   * root. Two independent reasons for living outside `<body>`:
   *   1. extension/content.js's `generateAccessibilityTree()`/model-facing
   *      DOM walk starts at `document.body` and never visits a sibling of
   *      `<body>` — so this host is structurally unreachable by the SAME
   *      extraction the model reads, with no extra "hide from AI" flag
   *      needed (design.md 5c: "Keep product elements out of DOM/
   *      accessibility extraction"). `find()`'s own walk does NOT start at
   *      body, though — see extension/content.js's `data-browzy-overlay`
   *      exclusion (design.md D4) for that path.
   *   2. It is NOT hidden from a REAL screen reader (no `aria-hidden`/
   *      `inert` here) — the Stop/Open-panel controls stay genuinely
   *      keyboard/AT reachable for a human, which is a DIFFERENT consumer
   *      than the model-facing tree in (1).
   * `pointer-events:none` on the cursor/ring/frame/glow/badge (see
   * OVERLAY_CSS) plus `pointer-events:auto` on ONLY the Stop and Open-panel
   * buttons is what keeps this layer out of page hit-testing (design.md 5c:
   * "isolated fixed overlay layer with pointer-events disabled for the
   * cursor and decoration... Stop button as the sole interactive region") —
   * extended by this change to the ONE additional deliberate control the
   * waiting-for-approval state adds (never a grant/deny control: see the
   * file header and design.md D6).
   */
  function createOverlayHost(doc) {
    var host = doc.createElement("div");
    host.setAttribute("data-browzy-overlay", "1");
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.pointerEvents = "none";
    host.style.zIndex = "2147483647";
    host.style.visibility = "hidden";
    var shadow = host.attachShadow({ mode: "closed" });
    var style = doc.createElement("style");
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);

    // 0. The ambient glow (design.md D11) — sits below everything else, so
    // it is appended first.
    var glowEl = doc.createElement("div");
    glowEl.className = "browzy-glow";

    // 1. The remote-control frame (task 1.2/1.3/1.4).
    var frameEl = doc.createElement("div");
    frameEl.className = "browzy-frame";
    var frameMaskEl = doc.createElement("div");
    frameMaskEl.className = "browzy-frame-mask";
    var frameSweepEl = doc.createElement("div");
    frameSweepEl.className = "browzy-frame-sweep";
    frameMaskEl.appendChild(frameSweepEl);
    var frameRingEl = doc.createElement("div");
    frameRingEl.className = "browzy-frame-ring";
    var cornersEl = doc.createElement("div");
    cornersEl.className = "browzy-corners";
    cornersEl.innerHTML = CORNER_SVGS;
    frameEl.appendChild(frameMaskEl);
    frameEl.appendChild(frameRingEl);
    frameEl.appendChild(cornersEl);

    // 2. The cursor: gradient fill, name tag, action label (task 2.1/2.2).
    var cursorEl = doc.createElement("div");
    cursorEl.className = "browzy-cursor";
    cursorEl.setAttribute("data-state", "idle");
    var cursorInnerEl = doc.createElement("div");
    cursorInnerEl.className = "browzy-cursor-inner";
    cursorInnerEl.innerHTML = CURSOR_SVG;
    var cursorLabelEl = doc.createElement("div");
    cursorLabelEl.className = "browzy-cursor-label";
    var cursorDotEl = doc.createElement("span");
    cursorDotEl.className = "browzy-cursor-dot";
    var cursorNameEl = doc.createElement("span");
    cursorNameEl.className = "browzy-cursor-name";
    cursorNameEl.textContent = "Browzy";
    var cursorSepEl = doc.createElement("span");
    cursorSepEl.className = "browzy-cursor-sep";
    var cursorActionEl = doc.createElement("span");
    cursorActionEl.className = "browzy-cursor-action";
    cursorLabelEl.appendChild(cursorDotEl);
    cursorLabelEl.appendChild(cursorNameEl);
    cursorLabelEl.appendChild(cursorSepEl);
    cursorLabelEl.appendChild(cursorActionEl);
    cursorInnerEl.appendChild(cursorLabelEl);
    cursorEl.appendChild(cursorInnerEl);

    // 3. Click feedback: two ripples offset 0.45s (task 3.1/3.2) — driven
    // only by paintOverlay toggling `.is-active`, itself driven only by a
    // real `phase:"down"` reaching reduceOverlayState.
    var ringEl = doc.createElement("div");
    ringEl.className = "browzy-click-ring";
    var rippleAEl = doc.createElement("span");
    rippleAEl.className = "browzy-ripple browzy-ripple-a";
    var rippleBEl = doc.createElement("span");
    rippleBEl.className = "browzy-ripple browzy-ripple-b";
    ringEl.appendChild(rippleAEl);
    ringEl.appendChild(rippleBEl);

    // 4. The status bar: anchored bottom-center (task 4.2), three states
    // (task 4.6) — running/waiting/idle — with NO grant/deny control ever
    // (task 5.5 / design.md D6 / spec "Blocked-on-approval is visible on
    // the controlled page").
    var badgeEl = doc.createElement("div");
    badgeEl.className = "browzy-badge";
    badgeEl.setAttribute("role", "status");
    badgeEl.setAttribute("data-state", "idle");
    badgeEl.hidden = true;

    var dotWrapEl = doc.createElement("span");
    dotWrapEl.className = "browzy-badge-dot-wrap";
    var dotEl = doc.createElement("span");
    dotEl.className = "browzy-badge-dot";
    var dotRingEl = doc.createElement("span");
    dotRingEl.className = "browzy-badge-dot-ring";
    dotWrapEl.appendChild(dotEl);
    dotWrapEl.appendChild(dotRingEl);

    var nameEl = doc.createElement("span");
    nameEl.className = "browzy-badge-name";
    nameEl.textContent = "BROWZY";

    // Task 7.7: the controlled tab's risk category chip — advisory only, no
    // acknowledge/dismiss control of any kind (see this file's header note
    // on RISK_LABELS for why). Sits right after the brand name so it is
    // visible for the whole time the badge itself is, independent of the
    // running/waiting/idle bar state below.
    var riskSepEl = doc.createElement("span");
    riskSepEl.className = "browzy-badge-sep";
    var riskEl = doc.createElement("span");
    riskEl.className = "browzy-risk";
    riskEl.setAttribute("data-level", "uncategorized");

    var sep1El = doc.createElement("span");
    sep1El.className = "browzy-badge-sep";

    var textEl = doc.createElement("span");
    textEl.className = "browzy-badge-text";

    var traceEl = doc.createElement("div");
    traceEl.className = "browzy-badge-trace";
    traceEl.innerHTML = BADGE_TRACE_SVG;

    var sep2El = doc.createElement("span");
    sep2El.className = "browzy-badge-sep";

    var statsEl = doc.createElement("span");
    statsEl.className = "browzy-badge-stats";

    var sep3El = doc.createElement("span");
    sep3El.className = "browzy-badge-sep";

    var stopButtonEl = doc.createElement("button");
    stopButtonEl.type = "button";
    stopButtonEl.className = "browzy-stop";
    stopButtonEl.textContent = "Dừng";
    stopButtonEl.setAttribute("aria-label", "Dừng — dừng agent đang điều khiển trang này");

    // The waiting state's ONLY control (task 5.5). It never grants or
    // denies the pending action itself — it only asks background.js to
    // route the operator to the panel, where the decision is actually
    // made. See the file header for why an Allow/Deny control cannot live
    // on this surface at all.
    var openPanelButtonEl = doc.createElement("button");
    openPanelButtonEl.type = "button";
    openPanelButtonEl.className = "browzy-open-panel";
    openPanelButtonEl.textContent = "Mở panel";
    openPanelButtonEl.setAttribute(
      "aria-label",
      "Mở panel — xem và quyết định yêu cầu cấp quyền trong panel, không thể duyệt tại đây"
    );

    badgeEl.appendChild(dotWrapEl);
    badgeEl.appendChild(nameEl);
    badgeEl.appendChild(riskSepEl);
    badgeEl.appendChild(riskEl);
    badgeEl.appendChild(sep1El);
    badgeEl.appendChild(textEl);
    badgeEl.appendChild(traceEl);
    badgeEl.appendChild(sep2El);
    badgeEl.appendChild(statsEl);
    badgeEl.appendChild(sep3El);
    badgeEl.appendChild(stopButtonEl);
    badgeEl.appendChild(openPanelButtonEl);

    shadow.appendChild(glowEl);
    shadow.appendChild(frameEl);
    shadow.appendChild(cursorEl);
    shadow.appendChild(ringEl);
    shadow.appendChild(badgeEl);

    var parent = doc.documentElement || doc.body;
    parent.appendChild(host);

    return {
      host: host,
      shadow: shadow,
      glowEl: glowEl,
      frameEl: frameEl,
      cursorEl: cursorEl,
      cursorActionEl: cursorActionEl,
      ringEl: ringEl,
      badgeEl: badgeEl,
      riskEl: riskEl,
      textEl: textEl,
      traceEl: traceEl,
      sep2El: sep2El,
      statsEl: statsEl,
      sep3El: sep3El,
      stopButtonEl: stopButtonEl,
      openPanelButtonEl: openPanelButtonEl
    };
  }

  /** Apply one render model to the real DOM refs. Never reads a clock or
   * event itself — every decision was already made by computeRenderModel.
   * design.md D2: `renderModel.visible` is the SOLE source of the host's
   * on-screen state — this function no longer takes a `capturedHidden`
   * argument; the model already folded that in.
   *
   * Owns every DOM property EXCEPT `cursorEl.style.left/top` (design.md D5:
   * the cursor-easing loop's paintCursorPosition() is the sole writer of
   * those two, so the coalesced paint and the per-frame easing never race
   * over the same properties) and the page-level wait-cursor style element
   * (design.md D10: setWaitCursorActive() owns that alone). */
  function paintOverlay(refs, renderModel, viewportWidth, viewportHeight) {
    if (!refs) return;
    refs.host.style.visibility = renderModel.visible ? "visible" : "hidden";
    if (refs.glowEl && refs.glowEl.classList) refs.glowEl.classList.toggle("is-active", !!renderModel.visible);
    if (!renderModel.active) return;
    if (refs.frameEl && refs.frameEl.classList) refs.frameEl.classList.toggle("is-active", !!renderModel.frame);

    var parked = !renderModel.cursor;
    if (refs.cursorEl.classList) refs.cursorEl.classList.toggle("is-parked", parked);
    if (parked) {
      // No real pointer position on this tab — it belongs to the run (it is in
      // the operator's tab group) but has never been acted on. The
      // .is-parked rule anchors the cursor to the status bar; the drawn
      // left/top (owned by paintCursorPosition, not here) is blanked there,
      // not by this function.
      refs.cursorEl.style.opacity = "";
      if (refs.cursorEl.classList) {
        refs.cursorEl.classList.remove("is-label-flip-x");
        refs.cursorEl.classList.remove("is-label-flip-y");
      }
    } else {
      refs.cursorEl.style.opacity = "1";
      refs.ringEl.style.left = renderModel.cursor.x + "px";
      refs.ringEl.style.top = renderModel.cursor.y + "px";
      // design.md D9/task 10.5: flip the label rather than let it overflow
      // the viewport near the right/bottom edge. Threshold constants, not a
      // real layout measurement — this file never touches a real browser in
      // its own tests (see test/overlay-pointer.test.mjs's header).
      if (refs.cursorEl.classList && typeof viewportWidth === "number" && typeof viewportHeight === "number") {
        refs.cursorEl.classList.toggle("is-label-flip-x", (viewportWidth - renderModel.cursor.x) < CURSOR_LABEL_FLIP_MARGIN_X);
        refs.cursorEl.classList.toggle("is-label-flip-y", (viewportHeight - renderModel.cursor.y) < CURSOR_LABEL_FLIP_MARGIN_Y);
      }
    }
    refs.cursorEl.setAttribute("data-state", renderModel.cursorState);
    if (refs.cursorActionEl) refs.cursorActionEl.textContent = renderModel.cursorLabel;
    if (refs.ringEl.classList) refs.ringEl.classList.toggle("is-active", !!renderModel.clickRing);

    refs.badgeEl.hidden = !renderModel.badge;
    refs.badgeEl.setAttribute("data-state", renderModel.barState);
    refs.badgeEl.setAttribute("data-locked", renderModel.locked ? "1" : "0");

    // Task 7.7: the risk chip — always reflects renderModel.riskCategory
    // (never a control, never hidden independently of the badge itself).
    if (refs.riskEl) {
      refs.riskEl.setAttribute("data-level", renderModel.riskCategory || "uncategorized");
      refs.riskEl.textContent = renderModel.riskLabel || "";
    }

    if (refs.textEl) {
      // design.md D10 / task 8.3: the lock is stated in words too, not only
      // via the system cursor — but never while "waiting", which already
      // shows the approval text AND is definitionally never locked at the
      // same time (locked requires !pendingApproval).
      if (renderModel.barState === "waiting") {
        refs.textEl.textContent = "Chờ bạn duyệt: " + ((renderModel.approval && renderModel.approval.action) || "");
      } else if (renderModel.locked) {
        refs.textEl.textContent = renderModel.actionLabel + " · Trang đang bị khoá";
      } else {
        refs.textEl.textContent = renderModel.actionLabel;
      }
    }

    var running = renderModel.barState === "running";
    var waiting = renderModel.barState === "waiting";
    if (refs.traceEl) refs.traceEl.hidden = !running;
    if (refs.sep2El) refs.sep2El.hidden = !running;
    if (refs.statsEl) {
      refs.statsEl.hidden = !running;
      refs.statsEl.textContent = renderModel.stepCount + " thao tác · " + renderModel.elapsedLabel;
    }
    if (refs.sep3El) refs.sep3El.hidden = !(running || waiting);
    if (refs.stopButtonEl) refs.stopButtonEl.hidden = !running;
    // The waiting state's ONLY control (task 5.5) — never an Allow/Deny.
    if (refs.openPanelButtonEl) refs.openPanelButtonEl.hidden = !waiting;
  }

  /** design.md D5: the SOLE writer of `cursorEl.style.left/top`. Called only
   * from the cursor-easing loop (section 3), never from paintOverlay above —
   * see that function's own header for why the split exists. Blanks the
   * inline position for the parked state (anchored by CSS instead, task
   * 5.4) rather than writing a fabricated coordinate. */
  function paintCursorPosition(refs, drawn, renderModel) {
    if (!refs || !refs.cursorEl) return;
    if (!renderModel.cursor || !drawn) {
      refs.cursorEl.style.left = "";
      refs.cursorEl.style.top = "";
      return;
    }
    refs.cursorEl.style.left = drawn.x + "px";
    refs.cursorEl.style.top = drawn.y + "px";
  }

  // === 3. Messaging + lifecycle wiring (thin glue — see file header) ======

  var state = {
    lastEventAt: null,
    cursor: null,
    clickAt: null,
    dragHeld: false,
    runId: null,
    conversationId: null,
    tabId: null,
    lastActionType: null,
    stepCount: 0,
    startedAt: null,
    pendingApproval: null,
    actionInFlight: false,
    riskCategory: null
  };
  var refs = null;
  // design.md D3: the capture lease this layer currently honours, if any.
  // `capturedHiddenAt` is a timestamp (not a boolean) so the hide can expire
  // on its own; `capturedCaptureId` correlates it to the hide/show pair that
  // opened it (null = an anonymous, pre-change-shaped lease); `capturedMaxMs`
  // is THIS lease's own expiry bound, set from the hide message itself
  // (background mints it — see design.md D3's "maxMs comes from background's
  // own bound, not a constant"); `retiredCaptureId` is the id of the most
  // recently processed `show` — a `hide` for that SAME id arriving late
  // (the exact reorder RC3 exists to close) is rejected rather than
  // re-hiding a lease its own show already closed. Equality, not `<=`: this
  // overlay outlives the service worker, and a restarted service worker's
  // own capture-id counter resets to 0, so an ordering comparison across a
  // restart would reject every hide forever.
  var capturedHiddenAt = null;
  var capturedCaptureId = null;
  var capturedMaxMs = CAPTURE_HIDE_MAX_AGE_MS;
  var retiredCaptureId = null;
  // design.md D5: the cursor's currently DRAWN position — the target of the
  // easing loop, never read by reduceOverlayState/computeRenderModel (only
  // `state.cursor`, the real dispatched target, is). `cursorRafHandle` is
  // the in-flight requestAnimationFrame id, or null when the loop is not
  // currently scheduled.
  var drawnCursor = null;
  var cursorRafHandle = null;
  // design.md D8/task 7.6: the mouse-ack tail after a scroll action settles,
  // during which a trailing (Brave-delayed) wheel event is still treated as
  // the agent's own, not the operator's.
  var scrollTailUntil = null;
  // design.md D8/task 7.7: when a TRUSTED event was last suppressed, so a
  // `start` for this run arriving shortly after can be correlated back to
  // it and reported as a possible swallowed dispatch.
  var lastSuppressedAt = null;
  // design.md D10: the page-level wait-cursor <style> element, or null when
  // not currently locked. The one node this file ever adds outside its own
  // host/shadow root — see setWaitCursorActive()'s own header.
  var waitCursorStyleEl = null;
  // What the last paint decided, so the next one only speaks up when the
  // answer CHANGES. Painting runs every 250ms off the heartbeat; logging each
  // one would make the console useless.
  var lastPaintVerdict = "";
  var requestRender = createRenderScheduler(
    typeof window.requestAnimationFrame === "function"
      ? function (fn) { window.requestAnimationFrame(fn); }
      : function (fn) { setTimeout(fn, 16); }
  );

  function attach() {
    if (refs) return;
    refs = createOverlayHost(document);
    console.log("[browzy-overlay] host node created");
    refs.stopButtonEl.addEventListener("click", function () {
      try {
        chrome.runtime.sendMessage({
          type: "browzyOverlayStop",
          conversationId: state.conversationId,
          runId: state.runId,
          reason: "user_stop"
        });
      } catch (e) {
        // Messaging can legitimately fail (extension context invalidated on
        // reload) — the panel keeps its own Stop either way (design.md 5c:
        // "Overlay failure does not pretend control is visible... retain
        // Stop there.").
      }
    });
    refs.openPanelButtonEl.addEventListener("click", function () {
      try {
        chrome.runtime.sendMessage({
          type: "browzyOverlayOpenPanel",
          conversationId: state.conversationId,
          runId: state.runId,
          requestId: state.pendingApproval && state.pendingApproval.requestId
        });
      } catch (e) {
        // Same failure mode as Stop above — this control only ever asks the
        // operator to go look at the panel (design.md D6); it never takes
        // the approval decision itself, so a failed message costs nothing
        // beyond "nothing happened".
      }
    });
  }

  /** design.md D10: the ONE deliberate exception to this file never touching
   * the page's own styling — while blocking is in force, the page's own
   * cursor must read "wait" so the operator learns the page is locked from
   * looking rather than from a click that silently does nothing (this
   * overlay stays `pointer-events:none` throughout, D6, so it can never set
   * the cursor by receiving the pointer itself). Sole writer of this
   * element, in either direction. Sets `cursor` and nothing else — no
   * color, layout, visibility or `user-select`. */
  function setWaitCursorActive(active) {
    if (active) {
      if (waitCursorStyleEl) return;
      waitCursorStyleEl = document.createElement("style");
      waitCursorStyleEl.setAttribute("data-browzy-overlay", "1");
      waitCursorStyleEl.textContent = WAIT_CURSOR_CSS;
      (document.head || document.documentElement).appendChild(waitCursorStyleEl);
      return;
    }
    if (waitCursorStyleEl && waitCursorStyleEl.parentNode) {
      waitCursorStyleEl.parentNode.removeChild(waitCursorStyleEl);
    }
    waitCursorStyleEl = null;
  }

  /** design.md D5: stop the cursor-easing loop. Cancels the pending frame
   * only — callers decide separately whether `drawnCursor` should survive
   * (a capture hide: yes, resume from here) or be dropped (teardown/expiry:
   * no run left to attribute the motion to, task 5.3). */
  function stopCursorAnimation() {
    if (cursorRafHandle !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(cursorRafHandle);
    }
    cursorRafHandle = null;
  }

  /** design.md D5: the permanent (while visible) requestAnimationFrame loop.
   * Re-derives the render model itself each frame — same reasoning as the
   * heartbeat timer re-checking staleness on its own clock (task 7.8's
   * "never read a cached boolean" applies here too) — rather than trusting
   * whatever the last event-driven paint happened to compute, which could
   * be stale by the time this frame runs. */
  function stepCursorAnimation() {
    var now = Date.now();
    var hidden = isCaptureHideInForce(now, capturedHiddenAt, capturedMaxMs);
    var model = computeRenderModel(state, now, HEARTBEAT_MAX_AGE_MS, hidden);
    if (!model.active) {
      // No run left to attribute the motion to (task 5.3) — stop outright
      // and drop the drawn position so a later, unrelated run does not
      // resume an easing trail from a stale coordinate.
      cursorRafHandle = null;
      drawnCursor = null;
      return;
    }
    if (!model.visible) {
      // Hidden for a capture only — the run is still live and the drawn
      // position still means something, it just is not painted right now.
      // Stop the loop but KEEP drawnCursor so easing resumes from here once
      // the lease clears, rather than snapping on every capture cycle.
      cursorRafHandle = null;
      return;
    }
    drawnCursor = easeTowardTarget(drawnCursor, model.cursor, CURSOR_EASE_FACTOR, CURSOR_SNAP_PX);
    paintCursorPosition(refs, drawnCursor, model);
    cursorRafHandle = window.requestAnimationFrame(stepCursorAnimation);
  }

  /** (Re)start the cursor-easing loop if it is not already running. Safe to
   * call on every paint — a no-op once a frame is already scheduled. */
  function ensureCursorAnimation() {
    if (cursorRafHandle !== null) return;
    if (typeof window.requestAnimationFrame !== "function") return;
    cursorRafHandle = window.requestAnimationFrame(stepCursorAnimation);
  }

  /** design.md D8: the capture-phase listener for every entry in
   * BLOCKABLE_EVENT_TYPES. Three exemptions, each load-bearing and each
   * checked BEFORE the block predicate:
   *   1. Untrusted (`isTrusted !== true`) — a page's own script-generated
   *      event, INCLUDING extension/content.js's own `target.click()` in
   *      setFormValue, must pass untouched (task 7.2) or this file silently
   *      breaks the page's own behaviour and the extension's own form
   *      filling.
   *   2. The overlay's own host — the shadow root is closed, so an event
   *      dispatched inside it is retargeted to the host at this boundary,
   *      making one identity check cover the whole overlay (task 7.4). This
   *      is what keeps Stop/Open-panel usable while the page is locked.
   *   3. `Tab`/`Shift+Tab` keydowns — with `keydown` suppressed on page
   *      targets, focus could not otherwise cross from page content into
   *      the shadow root, stranding a keyboard-only operator with no way to
   *      reach Stop (task 7.4).
   * Everything else is decided by the pure shouldBlockInput() predicate. */
  function handleBlockableEvent(event) {
    if (!event || event.isTrusted !== true) return;
    if (refs && event.target === refs.host) return;
    if (event.type === "keydown" && event.key === "Tab") return;
    if (!shouldBlockInput(state, Date.now(), HEARTBEAT_MAX_AGE_MS, scrollTailUntil)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    lastSuppressedAt = Date.now();
  }

  function registerInputBlockers() {
    for (var i = 0; i < BLOCKABLE_EVENT_TYPES.length; i++) {
      window.addEventListener(BLOCKABLE_EVENT_TYPES[i], handleBlockableEvent, { capture: true, passive: false });
    }
  }

  function removeInputBlockers() {
    for (var i = 0; i < BLOCKABLE_EVENT_TYPES.length; i++) {
      window.removeEventListener(BLOCKABLE_EVENT_TYPES[i], handleBlockableEvent, { capture: true });
    }
  }

  /** design.md D8's residual-race report (task 7.7): tell background a
   * trusted event was suppressed right before this run's own `start`
   * arrived — the signature of the delivery race where the agent's own CDP
   * dispatch outran the `start` message that would have kept
   * `actionInFlight` true through it. background.js attaches this to that
   * action's own outcome as a warning (never a silent `success`) — see its
   * `attachSuppressionWarning()`. */
  function reportSuppressedInput(runId, tabId, ts) {
    try {
      chrome.runtime.sendMessage({ type: "browzyOverlayInputSuppressed", runId: runId, tabId: tabId, ts: ts });
    } catch (e) {
      // Same failure mode as every other overlay-initiated message — a lost
      // report costs the warning, never the agent's own action.
    }
  }

  function paintNow() {
    var now = Date.now();
    var hidden = isCaptureHideInForce(now, capturedHiddenAt, capturedMaxMs);
    var model = computeRenderModel(state, now, HEARTBEAT_MAX_AGE_MS, hidden);
    // The three independent reasons this layer can end up drawing nothing —
    // no host node, an expired heartbeat, or a capture-hide that was never
    // restored — are indistinguishable on screen: the page just looks
    // untouched. Naming which one is in force is the only way to tell "the
    // overlay is broken" from "the overlay is correctly staying out of a
    // screenshot" without guessing. Read from the model's own fields
    // (design.md D2), not re-derived from a second hidden computation.
    var verdict = !refs
      ? "no host node"
      : !model.active
      ? "heartbeat expired (no event for " + HEARTBEAT_MAX_AGE_MS + "ms)"
      : !model.visible
      ? "hidden for a screenshot"
      : "visible (cursor " + (model.cursor ? "at " + model.cursor.x + "," + model.cursor.y : "parked") + ")";
    if (verdict !== lastPaintVerdict) {
      lastPaintVerdict = verdict;
      console.log("[browzy-overlay] paint: " + verdict);
    }
    paintOverlay(refs, model, window.innerWidth, window.innerHeight);
    setWaitCursorActive(!!model.locked);
    if (!model.active) {
      stopCursorAnimation();
      drawnCursor = null;
    } else if (!model.visible) {
      stopCursorAnimation();
    } else {
      ensureCursorAnimation();
    }
  }

  function scheduleRepaint() {
    requestRender(paintNow);
  }

  /** Handle one REAL action-event (or the local teardown/approval signal) —
   * updates `state` SYNCHRONOUSLY and immediately (never inside the render
   * scheduler), then asks for a coalesced repaint. This ordering is the
   * concrete proof that throttling the paint never throttles the actual
   * event handling: `state` already reflects event N the instant this
   * function returns, regardless of how many animation frames are still
   * pending. */
  function handleOverlayEvent(event) {
    attach();
    var now = Date.now();
    state = reduceOverlayState(state, event, now);
    // design.md D8/task 7.7: a `start` arriving shortly after a suppression
    // may be the agent's own dispatch that this overlay just swallowed —
    // report it once, then clear the flag so it cannot be double-reported
    // against a later, unrelated start.
    if (event && event.kind === "start" && lastSuppressedAt !== null && (now - lastSuppressedAt) <= INPUT_SUPPRESSION_REPORT_WINDOW_MS) {
      reportSuppressedInput(state.runId, state.tabId, lastSuppressedAt);
      lastSuppressedAt = null;
    }
    // design.md D8/task 7.6: a scroll action's own trailing wheel event can
    // still be arriving after `complete` (Brave never acks mouseWheel) —
    // keep the pass-through open a short tail past settle.
    if (event && event.kind === "complete" && event.action && event.action.type === "scroll") {
      scrollTailUntil = now + SCROLL_ACK_TAIL_MS;
    }
    scheduleRepaint();
  }

  /** Record whether this layer is hidden for an in-flight capture, and
   * repaint SYNCHRONOUSLY (design.md D2's "Consequence to respect": a
   * capture-driven hide must be on screen before requestOverlayHide()
   * resolves on the background side, not merely queued for the next frame —
   * routing it through requestRender would reintroduce a frame of exposure
   * inside a screenshot). Never writes a DOM property itself — paintNow()
   * -> paintOverlay() is still the only writer of host.style.visibility. */
  function setCapturedHidden(hidden) {
    capturedHiddenAt = hidden ? Date.now() : null;
    paintNow();
  }

  /** design.md D3: correlate one `browzyOverlayCapture` message against the
   * lease currently in force.
   *   - A `hide` always opens/replaces the lease — EXCEPT when its own id
   *     was already retired by a `show` that arrived first (the exact
   *     reorder RC3 exists to close: the hide had to inject the overlay
   *     first, so its delivery outlived the show sent right after it).
   *   - A `show` only closes the lease when its id matches the one
   *     currently in force. An id-less (anonymous) lease — an older
   *     background that never sends `captureId` at all — is closed by
   *     expiry alone (task 3.3): an id-less show cannot be trusted to
   *     belong to it. */
  function handleCaptureMessage(phase, captureId, maxMs) {
    var id = typeof captureId === "number" ? captureId : null;
    if (phase === "hide") {
      if (id !== null && id === retiredCaptureId) return;
      capturedCaptureId = id;
      capturedMaxMs = (typeof maxMs === "number" && maxMs > 0) ? maxMs : CAPTURE_HIDE_MAX_AGE_MS;
      setCapturedHidden(true);
      return;
    }
    if (phase === "show") {
      if (id !== null) retiredCaptureId = id;
      if (capturedHiddenAt === null) return;
      if (capturedCaptureId === null) return;
      if (capturedCaptureId !== id) return;
      setCapturedHidden(false);
    }
  }

  var heartbeatTimer = setInterval(function () {
    if (refs && document.documentElement && !document.documentElement.contains(refs.host)) {
      // Our own node vanished without a navigation (a same-URL wholesale
      // document replacement) — design.md 5c: "document replacement...
      // clear stale overlays." Recreate fresh rather than silently going
      // dark; a NEW attach() never claims a run is active on its own — the
      // very next repaint still runs computeRenderModel() against the same
      // `state`, so if that state is already stale (heartbeat expired) the
      // recreated host is drawn hidden anyway, not spuriously "active".
      refs = null;
      attach();
    }
    scheduleRepaint();
  }, HEARTBEAT_CHECK_INTERVAL_MS);

  // ALWAYS answers, for every message, before returning. chrome.tabs.sendMessage
  // on the sender side (sendOverlayMessage() in extension/background.js) is a
  // promise: a listener that returns without calling sendResponse lets the port
  // close unanswered, and the promise REJECTS even though this listener already
  // handled the event perfectly. That rejection is indistinguishable, on the
  // sender side, from "this document has no overlay" — so it drove the
  // inject-then-retry path on every single message, re-delivering each
  // action-event a second time (the injection itself is a no-op thanks to the
  // __browzyOverlayLoaded guard at the top of this file, so the SAME listener
  // answered twice) and paying one wasted chrome.scripting.executeScript per
  // event and per keepalive tick. The acknowledgement below is what keeps
  // "sendMessage rejected" meaning what the sender assumes it means: this
  // document genuinely has no overlay yet. It is also what makes background's
  // own RC7 fix (design.md/task 0.1(b): treat a reply that is not
  // `{ok:true}` as undelivered) correct regardless of which
  // resolve-vs-reject behaviour a given Chrome build actually has for a
  // message with no listener — this listener always sends the real
  // acknowledgement, so the sender's check is meaningful either way.
  // Diagnostics for "the overlay never appeared" (page console, filter
  // "browzy-overlay"). Deliberately one line per DISTINCT event kind, not one
  // per message: keepalives arrive on a timer and would bury everything else.
  var loggedKinds = Object.create(null);
  function logOverlayMessage(kind, detail) {
    if (loggedKinds[kind]) return;
    loggedKinds[kind] = true;
    console.log("[browzy-overlay] " + kind + (detail ? " — " + detail : ""));
  }
  logOverlayMessage("script loaded", location.href);
  // design.md D1: mount eagerly, right here, rather than waiting for the
  // first delivered message (handleOverlayEvent()'s own attach() call stays
  // — its `if (refs) return` guard already makes it a no-op — as does the
  // heartbeat's document-replacement recovery). A page carrying this script
  // now always carries the host node, so "not injected", "injected but no
  // run tracked" and "tracked but hidden" are three distinguishable states
  // instead of one blank page.
  attach();
  registerInputBlockers();

  const onOverlayMessage = function (msg, _sender, sendResponse) {
    if (!msg) return;
    if (msg.type === "browzyOverlayEvent" && msg.event) {
      logOverlayMessage(
        "event: " + (msg.event.kind || "?"),
        "run " + (msg.event.runId || "?") + ", pointer " + (msg.event.pointer ? "yes" : "no")
      );
      handleOverlayEvent(msg.event);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "browzyOverlayTeardown") {
      console.log("[browzy-overlay] teardown — " + (msg.reason || "no reason given"));
      handleOverlayEvent({ kind: "teardown" });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "browzyOverlayCapture") {
      handleCaptureMessage(msg.phase, msg.captureId, msg.maxMs);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "browzyOverlayApproval") {
      // design.md D5 / task 5.3: extension/background.js's approval bridge
      // relays this alongside the action-event stream, through the SAME
      // sendOverlayMessage path — no second channel on this side either.
      handleOverlayEvent({
        kind: "approval",
        phase: msg.phase,
        requestId: msg.requestId,
        action: msg.action,
        target: msg.target
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "browzyOverlayRisk") {
      // Task 7.7: the SAME relay shape as browzyOverlayApproval above — a
      // future extension/background.js bridge forwards the host's
      // `tab_risk_update` (reports/wave2h-events.md) through this one
      // additional message type, over the SAME sendOverlayMessage path as
      // every other overlay message. This file's own job stops at handling
      // it once it arrives; wiring background.js to actually send it is
      // tracked separately (that file is out of this change's file scope
      // for this wave).
      handleOverlayEvent({ kind: "riskUpdate", tabId: msg.tabId, category: msg.category });
      sendResponse({ ok: true });
      return;
    }
  };
  chrome.runtime.onMessage.addListener(onOverlayMessage);

  /** Tear this copy down completely so a newer injection can take over: drop
   * the listener, stop the heartbeat, and remove the host node — otherwise the
   * old, unreachable overlay would sit on the page forever, frozen at whatever
   * it last drew.
   *
   * design.md D8 (task 7.13): DOM/timer cleanup runs FIRST, `chrome.*` LAST
   * in its own try. After an extension reload, `chrome.runtime.onMessage.
   * removeListener` throws on the invalidated context — this file's caller
   * (the try/catch at the very top) swallows that — so with the OLD
   * ordering everything AFTER that call (clearInterval, host removal, and
   * now the input-blocker/wait-cursor removal) never ran, leaving a page
   * permanently locked with a wait cursor and no way to release it. */
  window.__browzyOverlayDispose = function () {
    console.log("[browzy-overlay] disposing this copy (a newer injection is taking over)");
    clearInterval(heartbeatTimer);
    stopCursorAnimation();
    drawnCursor = null;
    removeInputBlockers();
    setWaitCursorActive(false);
    if (refs && refs.host && refs.host.parentNode) refs.host.parentNode.removeChild(refs.host);
    refs = null;
    window.__browzyOverlayLoaded = false;
    try {
      chrome.runtime.onMessage.removeListener(onOverlayMessage);
    } catch (e) {
      // Context can already be invalidated (extension reload) — everything
      // above already ran regardless, which is the fix.
    }
  };

  // design.md D8 (task 7.12): on a bfcache restore the document comes back
  // with the window listeners and the wait-cursor style element exactly as
  // they were at pagehide time, but the OLD code here only cleared the
  // heartbeat timer — leaving a page locked with no timer left to expire
  // anything, the exact hostage-page failure this design refuses
  // everywhere else. Remove the listeners, the style element, and hide the
  // host, not only stop the clock.
  window.addEventListener("pagehide", function () {
    clearInterval(heartbeatTimer);
    stopCursorAnimation();
    drawnCursor = null;
    removeInputBlockers();
    setWaitCursorActive(false);
    if (refs && refs.host) refs.host.style.visibility = "hidden";
  });

  // Debug/QA hook only — mirrors the existing window.__browzyPanelDebug /
  // window.__unblockedChrome convention elsewhere in this codebase. Exposes
  // no secret: only the same overlay state already visible on screen.
  window.__browzyOverlay = {
    getState: function () { return state; },
    getRenderModel: function () {
      var now = Date.now();
      return computeRenderModel(state, now, HEARTBEAT_MAX_AGE_MS, isCaptureHideInForce(now, capturedHiddenAt, capturedMaxMs));
    }
  };
})();

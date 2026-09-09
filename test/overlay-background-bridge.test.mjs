// Tests for the extension/background.js hooks that deliver the action-event
// stream to the agent pointer overlay (design.md 5c / task 5.9) — the
// injection/messaging bridge, capture-exclusion hide/show wrapping around
// takeScreenshot(), the shared Stop cancellation path, and every teardown
// signal (debugger detach, tab close, companion disconnect, run lifecycle).
//
// Same extraction technique test/handlers.test.mjs and
// test/action-events-emission.test.mjs already use for extension/
// background.js (test/_extract.mjs's brace-matching extractor): named
// functions are extracted and compiled with injected fakes; glue too large
// to usefully execute (anonymous addListener callbacks, the full
// handleToolRequest/takeScreenshot dependency graph) is proven structurally
// against the REAL shipped source text instead, exactly like Batch 1's own
// test/action-events-emission.test.mjs does for handleToolRequest's call
// ordering.

import fs from "node:fs";
import path from "node:path";
import { extractFunction, compile, BACKGROUND, ROOT } from "./_extract.mjs";

const CONTENT = path.join(ROOT, "extension", "content.js");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const SRC = fs.readFileSync(BACKGROUND, "utf8");

// Every handleAgentMessage harness below shares this: run_started raises the
// overlay through startOverlayForRun, which is async because it awaits the tab
// group query that widens the overlay to every tab in the group.
const startOverlayCalls = [];

// =============================================================================
// 1. sendOverlayMessage: try sendMessage, inject-then-retry on failure —
//    the EXACT shape sendContentMessage() already uses for content.js, so a
//    fresh/never-injected document "just works" without this module tracking
//    document identity at all.
// =============================================================================
console.log("== sendOverlayMessage: lazy inject-then-retry, same shape as sendContentMessage ==");
{
  function buildHarness({ sendMessageBehavior, executeScriptBehavior }) {
    const calls = [];
    const chrome = {
      tabs: {
        sendMessage: async (tabId, msg) => {
          calls.push({ fn: "sendMessage", tabId, msg });
          return sendMessageBehavior(calls.filter((c) => c.fn === "sendMessage").length);
        }
      },
      scripting: {
        executeScript: async (opts) => {
          calls.push({ fn: "executeScript", opts });
          return executeScriptBehavior();
        }
      }
    };
    // logOverlayDelivery is the console breadcrumb every delivery outcome
    // leaves behind (the failure paths below are all swallowed by callers, so
    // without it "the overlay never appeared" produces no evidence anywhere).
    // Recorded here so the outcomes stay assertable.
    const logged = [];
    const sendOverlayMessage = compile(
      [extractFunction("isOverlayAck"), extractFunction("sendOverlayMessage")].join("\n\n"),
      {
        chrome,
        OVERLAY_SCRIPT_FILES: ["overlay/pointer-overlay.js"],
        logOverlayDelivery: (tabId, outcome, detail) => logged.push({ tabId, outcome, detail })
      },
      "sendOverlayMessage"
    );
    return { sendOverlayMessage, calls, logged };
  }

  {
    const h = buildHarness({ sendMessageBehavior: () => ({ ok: true }), executeScriptBehavior: () => {} });
    const result = await h.sendOverlayMessage(7, { type: "browzyOverlayEvent" });
    ok(result && result.ok === true, "a tab that already has the overlay injected just gets the message delivered");
    ok(h.calls.length === 1 && h.calls[0].fn === "sendMessage", "no injection attempted when the first try succeeds");
  }

  {
    const h = buildHarness({
      sendMessageBehavior: (n) => { if (n === 1) throw new Error("Receiving end does not exist"); return { ok: true }; },
      executeScriptBehavior: () => {}
    });
    const result = await h.sendOverlayMessage(7, { type: "browzyOverlayEvent" });
    ok(result && result.ok === true, "a first-time (or freshly navigated) tab still gets the message after one inject+retry");
    ok(h.calls.length === 3 && h.calls[0].fn === "sendMessage" && h.calls[1].fn === "executeScript" && h.calls[2].fn === "sendMessage",
       "order: try send, inject on failure, retry send exactly once");
    ok(h.calls[1].opts.target.tabId === 7 && Array.isArray(h.calls[1].opts.files) && h.calls[1].opts.files.includes("overlay/pointer-overlay.js"),
       "injects the REAL overlay script file into the REAL target tab");
  }

  {
    const h = buildHarness({
      sendMessageBehavior: () => { throw new Error("no receiver"); },
      executeScriptBehavior: () => { throw new Error("cannot access chrome:// URL"); }
    });
    const result = await h.sendOverlayMessage(9, { type: "browzyOverlayEvent" });
    ok(result === undefined, "a tab that genuinely cannot host the overlay (chrome://, Web Store, closed) resolves quietly to undefined — never throws, never claims success");
    ok(h.logged.length === 1 && h.logged[0].tabId === 9 && h.logged[0].outcome === "injection refused",
       "  ...and says so in the service worker console, so a missing overlay is diagnosable at all");
  }

  // =============================================================================
  // RC7 (design.md / task 0.1(b)): whether chrome.tabs.sendMessage REJECTS or
  // resolves `undefined` when no listener answers is not settled by reading
  // this codebase. If a given Chrome build RESOLVES instead of rejecting,
  // the OLD sendOverlayMessage would take its success branch on a message
  // NOTHING answered — logging "delivered" and never running the injection
  // retry, so a document with no overlay silently never got one. This is
  // the regression net for that fix: a resolved-but-unacknowledged reply
  // (the exact shape a no-listener resolve would produce) must be treated
  // as undelivered and fall through to inject-then-retry, exactly like a
  // rejection does.
  // =============================================================================
  console.log("\n== RC7: a resolved-but-unacknowledged reply is treated as undelivered, not as success ==");
  {
    const h = buildHarness({
      // Never throws — simulates the Chrome semantics where sendMessage
      // resolves `undefined` instead of rejecting when nothing answers.
      sendMessageBehavior: (n) => (n === 1 ? undefined : { ok: true }),
      executeScriptBehavior: () => {}
    });
    const result = await h.sendOverlayMessage(11, { type: "browzyOverlayEvent" });
    ok(result && result.ok === true, "the SECOND try (after injection) succeeds, so delivery still completes correctly under this Chrome semantics too");
    ok(h.calls.length === 3 && h.calls[0].fn === "sendMessage" && h.calls[1].fn === "executeScript" && h.calls[2].fn === "sendMessage",
       "a resolved-but-empty first reply still drives the SAME inject-then-retry path a rejection would — RC7's whole point");
  }
  {
    const h2 = buildHarness({
      sendMessageBehavior: () => undefined, // never acknowledges, ever — genuinely no overlay
      executeScriptBehavior: () => {}
    });
    const result = await h2.sendOverlayMessage(12, { type: "browzyOverlayEvent" });
    ok(result === undefined, "a reply that is never a real acknowledgement — even after injecting — never claims delivery");
    ok(h2.logged.some((l) => l.outcome === "injected but unreachable"), "...and says so in the console rather than the false 'delivered' outcome RC7 describes");
  }
  {
    // A reply shaped like something else entirely (not even resolving to an
    // object) must not be mistaken for an acknowledgement either.
    const h3 = buildHarness({ sendMessageBehavior: (n) => (n === 1 ? "ok" : { ok: true }), executeScriptBehavior: () => {} });
    const result = await h3.sendOverlayMessage(13, { type: "browzyOverlayEvent" });
    ok(result && result.ok === true, "a non-{ok:true} first reply (e.g. a bare truthy value) is also treated as undelivered and retried");
    ok(h3.calls.length === 3, "...via the same inject-then-retry path");
  }
}

// =============================================================================
// 2. forwardActionEventToOverlay: tracks runId->tabIds, delivers the EXACT
//    real event object (never a copy/derivation) to the right tab, and
//    ignores an event with no tabId at all.
// =============================================================================
console.log("\n== forwardActionEventToOverlay: exact event, correct tab, runId tracking ==");
{
  const delivered = [];
  const overlayRunTabs = new Map();
  const sendOverlayMessage = async (tabId, msg) => { delivered.push({ tabId, msg }); };
  const keptAlive = [];
  const startOverlayKeepalive = (runId) => keptAlive.push(runId);
  const forwardActionEventToOverlay = compile(
    extractFunction("forwardActionEventToOverlay"),
    { overlayRunTabs, sendOverlayMessage, startOverlayKeepalive },
    "forwardActionEventToOverlay"
  );

  const evt1 = { kind: "start", runId: "run_1", tabId: 42, action: { type: "click" } };
  forwardActionEventToOverlay(evt1);
  ok(delivered.length === 1 && delivered[0].tabId === 42, "delivered to the event's own tabId");
  ok(delivered[0].msg.type === "browzyOverlayEvent" && delivered[0].msg.event === evt1, "the EXACT same event object is forwarded — never copied, derived, or re-summarized");
  ok(overlayRunTabs.get("run_1") && overlayRunTabs.get("run_1").has(42), "runId->tabId tracked for later teardown targeting");
  ok(keptAlive[0] === "run_1", "and the run's keepalive is started, so the overlay does not go dark while the model thinks between actions");

  delivered.length = 0;
  const noTab = { kind: "start", runId: "run_2", tabId: null, action: { type: "other" } };
  forwardActionEventToOverlay(noTab);
  ok(delivered.length === 0, "an event with no tabId, on a run with no overlay anywhere yet, is never forwarded (nothing to show it on)");
  ok(!overlayRunTabs.has("run_2"), "and it never invents a tab for that run");

  // ...but a tool that names no tab (tabs_create_mcp, update_plan,
  // switch_browser) still happens DURING the run, on a page the operator is
  // still being driven on. Dropping it left that step with no signal and — far
  // worse — no keepalive, so a slow tabless step expired the overlay and the
  // page went dark mid-run.
  delivered.length = 0;
  keptAlive.length = 0;
  overlayRunTabs.set("run_3", new Set([11, 12]));
  const tabless = { kind: "start", runId: "run_3", tabId: null, action: { type: "other" } };
  forwardActionEventToOverlay(tabless);
  ok(delivered.length === 2 && delivered.every((d) => d.msg.event === tabless), "a tabless event mid-run reaches the tabs that run is already known to be showing an overlay on");
  ok(delivered.map((d) => d.tabId).sort().join() === "11,12", "  ...those tabs and only those — learned from earlier real events, never guessed");
  ok(keptAlive[0] === "run_3", "  ...and it keeps the overlay alive across the step");
  ok(tabless.tabId === null, "  ...while the event object itself stays honestly tabless for every other consumer");

  // A legacy/external-MCP event (no runId at all) still delivers to its tab —
  // the overlay bridge does not depend on a run existing, only the
  // companion-forwarding sender (tested separately) does.
  delivered.length = 0;
  forwardActionEventToOverlay({ kind: "start", runId: null, tabId: 5, action: { type: "click" } });
  ok(delivered.length === 1 && delivered[0].tabId === 5, "a legacy/external-MCP event (no runId) is still shown on its own tab");
}

// =============================================================================
// 3. teardownOverlayForRun / teardownAllOverlays: message exactly the right
//    tabs, and only those, and forget the run afterward.
// =============================================================================
console.log("\n== teardownOverlayForRun / teardownAllOverlays ==");
{
  const sent = [];
  const sendOverlayMessage = async (tabId, msg) => { sent.push({ tabId, msg }); };
  const overlayRunTabs = new Map([
    ["run_a", new Set([1, 2])],
    ["run_b", new Set([3])]
  ]);
  // The keepalive must stop with the run, or a stale timer would keep the
  // overlay looking alive on a page nothing is driving any more.
  const stopped = [];
  const teardownOverlayForRun = compile(
    extractFunction("teardownOverlayForRun"),
    { overlayRunTabs, sendOverlayMessage, stopOverlayKeepalive: (runId) => stopped.push(runId) },
    "teardownOverlayForRun"
  );
  teardownOverlayForRun("run_a", "run_stopped");
  ok(stopped[0] === "run_a", "tearing a run down stops its keepalive first, so no timer outlives the run");
  ok(sent.length === 2 && sent.every((s) => s.msg.type === "browzyOverlayTeardown" && s.msg.reason === "run_stopped"), "teardown sent to exactly run_a's two tabs, with the real reason");
  ok(new Set(sent.map((s) => s.tabId)).size === 2 && [1, 2].every((t) => sent.some((s) => s.tabId === t)), "tabs 1 and 2 only");
  ok(!overlayRunTabs.has("run_a") && overlayRunTabs.has("run_b"), "run_a forgotten, run_b (a different, still-active run) untouched");

  sent.length = 0;
  const overlayRunTabs2 = new Map([["run_c", new Set([9])], ["run_d", new Set([9, 10])]]);
  let allStopped = false;
  const teardownAllOverlays = compile(
    extractFunction("teardownAllOverlays"),
    { overlayRunTabs: overlayRunTabs2, sendOverlayMessage, stopAllOverlayKeepalives: () => { allStopped = true; } },
    "teardownAllOverlays"
  );
  teardownAllOverlays("companion_disconnected");
  ok(allStopped, "losing the companion stops every keepalive, not just the messaging");
  ok(new Set(sent.map((s) => s.tabId)).size === 2 && [9, 10].every((t) => sent.some((s) => s.tabId === t)),
     "companion loss tears down every tracked tab across EVERY run (tab 9 shared by two runs is only notified once each, tab 10 once)");
  ok(overlayRunTabs2.size === 0, "every run forgotten after a full companion-loss teardown");
}

// =============================================================================
// 4. sendStopToHost: builds the IDENTICAL wire envelope shape the panel's
//    own Stop uses (extension/sidepanel/protocol-client.js's envelope():
//    {v, type, conversationId, reason, ts}) and posts it through the
//    IDENTICAL nativePort.postMessage({type:"agent_msg", envelope}) call —
//    this IS "the same cancellation path", not a re-implementation.
// =============================================================================
console.log("\n== sendStopToHost: identical wire shape/path as the panel's own Stop ==");
{
  const posted = [];
  const nativePort = { postMessage: (m) => posted.push(m) };
  const sendStopToHost = compile(extractFunction("sendStopToHost"), { nativePort, AGENT_PROTOCOL_VERSION: 1 }, "sendStopToHost");
  const result = sendStopToHost("conv_1", "user_stop");
  ok(result === true, "reports success when a companion is connected");
  ok(posted.length === 1 && posted[0].type === "agent_msg", "posted as an agent_msg — the SAME envelope wrapper the ocic-agent port relay already uses (see extension/background.js's onConnect handler: nativePort.postMessage(msg) where msg={type:\"agent_msg\",envelope})");
  const env = posted[0].envelope;
  ok(env.v === 1 && env.type === "stop" && env.conversationId === "conv_1" && env.reason === "user_stop" && typeof env.ts === "number",
     "envelope shape exactly matches protocol-client.js's own envelope(MSG.STOP,{conversationId,reason}) -> {v,type,conversationId,reason,ts}");

  const noPort = compile(extractFunction("sendStopToHost"), { nativePort: null, AGENT_PROTOCOL_VERSION: 1 }, "sendStopToHost");
  ok(noPort("conv_1", "user_stop") === false, "no companion connected -> false, never throws, never silently pretends success");

  const noConv = compile(extractFunction("sendStopToHost"), { nativePort, AGENT_PROTOCOL_VERSION: 1 }, "sendStopToHost");
  ok(noConv(null, "user_stop") === false, "no conversationId -> false — never sends a stop for an unknown target");
}

// =============================================================================
// 5. requestOverlayHide: bounded wait — an unresponsive/absent overlay must
//    NEVER slow down a real screenshot capture.
// =============================================================================
console.log("\n== requestOverlayHide: bounded wait, never blocks capture on a slow/absent overlay ==");
{
  let neverResolves = new Promise(() => {}); // simulates a tab with no receiving overlay at all
  const sent = [];
  const sendOverlayMessage = async (tabId, msg) => { sent.push(msg); return neverResolves; };
  const requestOverlayHide = compile(
    extractFunction("requestOverlayHide"),
    {
      sendOverlayMessage, OVERLAY_HIDE_WAIT_MS: 20, overlayHideInFlight: new Map(),
      overlayCaptureIdCounter: 0, overlayHideCaptureId: new Map(), OVERLAY_CAPTURE_LEASE_MS: 4000
    },
    "requestOverlayHide"
  );
  const start = Date.now();
  await requestOverlayHide(7);
  const elapsed = Date.now() - start;
  ok(elapsed < 200, `resolved via its own bounded timeout rather than hanging on an overlay that never responds (took ${elapsed}ms)`);
  // design.md D3: the hide mints its own captureId and sends the maxMs
  // bound background itself intends to spend on this capture.
  ok(sent.length === 1 && typeof sent[0].captureId === "number", "requestOverlayHide() mints a captureId and sends it with the hide (design.md D3)");
  ok(sent[0].phase === "hide" && sent[0].maxMs === 4000, "...and sends background's OWN expiry bound, not a constant the overlay has to guess");
}

// =============================================================================
// 5b. ...but bounding the CAPTURE's wait must not unorder the two messages.
//     When the hide has to inject the overlay first — a fresh document, which
//     is exactly what a click that navigated just produced — delivery outlives
//     that bound. The capture finishes, the show goes out, and the hide lands
//     LAST: the overlay is then parked at visibility:hidden on a run that is
//     still going, and nothing but another capture ever writes that flag again.
// =============================================================================
console.log("\n== requestOverlayShow: ordered behind its own hide, never racing it ==");
{
  const sent = [];
  let releaseHide;
  const overlayHideInFlight = new Map();
  const overlayHideCaptureId = new Map();
  const sendOverlayMessage = (tabId, msg) => {
    sent.push(msg);
    // The hide is the slow one here — it is the call that has to inject.
    return msg.phase === "hide" ? new Promise((r) => { releaseHide = r; }) : Promise.resolve();
  };
  const deps = {
    sendOverlayMessage, OVERLAY_HIDE_WAIT_MS: 20, overlayHideInFlight,
    overlayCaptureIdCounter: 0, overlayHideCaptureId, OVERLAY_CAPTURE_LEASE_MS: 4000
  };
  const src = extractFunction("requestOverlayHide") + "\n" + extractFunction("requestOverlayShow");
  const { requestOverlayHide, requestOverlayShow } = compile(src, deps, "{ requestOverlayHide, requestOverlayShow }");

  await requestOverlayHide(7);
  ok(sent.map((m) => m.phase).join() === "hide", "the capture proceeds after the bounded wait, with the hide still in flight");
  const mintedId = sent[0].captureId;
  ok(typeof mintedId === "number", "the hide minted a real captureId");

  requestOverlayShow(7);                       // capture finished; restore requested
  await new Promise((r) => setTimeout(r, 30));
  ok(sent.map((m) => m.phase).join() === "hide", "the show is NOT sent while its own hide is still undelivered");

  releaseHide();
  await new Promise((r) => setTimeout(r, 10));
  ok(sent.map((m) => m.phase).join() === "hide,show", "it goes out once the hide lands — so the overlay always ends a capture visible");
  ok(sent[1].captureId === mintedId, "requestOverlayShow() sends the SAME captureId its own hide minted, not an anonymous or freshly-minted one (design.md D3)");
  ok(!overlayHideInFlight.has(7), "and the per-tab handle is dropped, so nothing accumulates across captures");
  ok(!overlayHideCaptureId.has(7), "...and the per-tab captureId correlation is dropped too");
}

// =============================================================================
// 6. Structural: takeScreenshot hides the overlay BEFORE capturing and shows
//    it again in a `finally` (so it is restored even if the capture throws),
//    without this test having to execute the full CDP dependency graph.
// =============================================================================
console.log("\n== structural: takeScreenshot hide-before / show-in-finally ordering ==");
{
  // Matched on the name alone: takeScreenshot has taken an options argument
  // since zoom became a real crop, and pinning the whole parameter list here
  // made this ordering test fail for a reason that has nothing to do with
  // ordering.
  const fnStart = SRC.indexOf("async function takeScreenshot(");
  ok(fnStart !== -1, "takeScreenshot found in the shipped source");
  const hideIdx = SRC.indexOf("await requestOverlayHide(tabId);", fnStart);
  const tryIdx = SRC.indexOf("try {", fnStart);
  const finallyIdx = SRC.indexOf("} finally {", fnStart);
  const showIdx = SRC.indexOf("requestOverlayShow(tabId);", fnStart);
  const captureIdx = SRC.indexOf('cdp(tabId, "Page.captureScreenshot"', fnStart);
  ok(hideIdx !== -1 && tryIdx !== -1 && finallyIdx !== -1 && showIdx !== -1 && captureIdx !== -1, "all expected call sites present");
  ok(hideIdx < tryIdx && tryIdx < captureIdx, "the overlay is asked to hide BEFORE the try block that does the real CDP capture");
  ok(finallyIdx < showIdx, "requestOverlayShow is inside the finally block — restored even if capture throws");
  ok(captureIdx > hideIdx && captureIdx < finallyIdx, "the actual capture happens strictly between hide and the finally-restore");
}

// =============================================================================
// 7. Structural: handleAgentMessage observes run-lifecycle stream_events and
//    tears down that run's overlay — WITHOUT altering the verbatim relay to
//    agentPorts that already existed (a regression on the pre-existing
//    behavior this task must not touch).
// =============================================================================
console.log("\n== handleAgentMessage: overlay teardown hook, relay untouched ==");
{
  const teardownCalls = [];
  const approvalCalls = [];
  const agentPorts = new Set();
  const relayed = [];
  agentPorts.add({ postMessage: (m) => relayed.push(m) });
  const agentSettingsRelay = { handleReply: () => false };
  const deps = {
    agentSettingsRelay,
    agentPorts,
    dbg: () => {},
    teardownOverlayForRun: (runId, reason) => teardownCalls.push({ runId, reason }),
    startOverlayForRun: (runId, tabScope) => {
      startOverlayCalls.push({ runId, tabScope });
      return Promise.resolve();
    },
    forwardApprovalToOverlay: (runId, message) => approvalCalls.push({ runId, message }),
    OVERLAY_TEARDOWN_RUN_EVENTS: new Set(["run_stopped", "run_error", "run_interrupted_by_restart"])
  };
  // agentHandshakeState/agentHandshakeDetail are module-level `let`s
  // handleAgentMessage assigns — provide real mutable bindings via `let` in
  // the compiled source itself (declared alongside, not injected) so the
  // extracted function's assignments behave exactly as in the shipped file.
  const src = "let agentHandshakeState = \"pending\";\nlet agentHandshakeDetail = null;\n" + extractFunction("handleAgentMessage");
  const handleAgentMessage = compile(src, deps, "handleAgentMessage");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_x", event: { type: "run_stopped", reason: "user_stop" } });
  ok(teardownCalls.length === 1 && teardownCalls[0].runId === "run_x" && teardownCalls[0].reason === "run_stopped",
     "run_stopped triggers an immediate overlay teardown for that run");
  ok(relayed.length === 1, "the envelope is STILL relayed verbatim to agentPorts exactly as before this addition");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_y", event: { type: "run_error" } });
  ok(teardownCalls.length === 2 && teardownCalls[1].runId === "run_y", "run_error also triggers teardown");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_z", event: { type: "run_interrupted_by_restart" } });
  ok(teardownCalls.length === 3 && teardownCalls[2].runId === "run_z", "run_interrupted_by_restart also triggers teardown");

  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_w", event: { type: "run_started" } });
  ok(teardownCalls.length === 3, "an UNRELATED run lifecycle event (run_started) never triggers a teardown");
  ok(startOverlayCalls.length === 1 && startOverlayCalls[0].runId === "run_w",
     "run_started instead raises that run's overlay, before any tool has named a tab");

  handleAgentMessage({ type: "hello_ack" });
  ok(teardownCalls.length === 3, "a non-stream_event envelope is never mistaken for a teardown signal");
  ok(approvalCalls.length === 0, "none of the above ever touch the approval bridge — it is a separate observer");
}

// =============================================================================
// 7b. Structural: handleAgentMessage's NEW approval-bridge observer
//     (design.md D5 / task 5.1) — approval_request (a stream_event) and
//     approval_decision (its own top-level envelope) both reach
//     forwardApprovalToOverlay with the right shape, and the verbatim relay
//     to agentPorts is untouched either way.
// =============================================================================
console.log("\n== handleAgentMessage: approval bridge observer, relay untouched ==");
{
  const approvalCalls = [];
  const teardownCalls = [];
  const agentPorts = new Set();
  const relayed = [];
  agentPorts.add({ postMessage: (m) => relayed.push(m) });
  const agentSettingsRelay = { handleReply: () => false };
  const deps = {
    agentSettingsRelay,
    agentPorts,
    dbg: () => {},
    teardownOverlayForRun: (runId, reason) => teardownCalls.push({ runId, reason }),
    startOverlayForRun: (runId, tabScope) => {
      startOverlayCalls.push({ runId, tabScope });
      return Promise.resolve();
    },
    forwardApprovalToOverlay: (runId, message) => approvalCalls.push({ runId, message }),
    OVERLAY_TEARDOWN_RUN_EVENTS: new Set(["run_stopped", "run_error", "run_interrupted_by_restart"])
  };
  const src = "let agentHandshakeState = \"pending\";\nlet agentHandshakeDetail = null;\n" + extractFunction("handleAgentMessage");
  const handleAgentMessage = compile(src, deps, "handleAgentMessage");

  handleAgentMessage({
    type: "stream_event", conversationId: "c1", runId: "run_a",
    event: { type: "approval_request", requestId: "req_1", action: "computer click (submit-type control)", target: { tabId: 42 }, ts: 123 }
  });
  ok(approvalCalls.length === 1 && approvalCalls[0].runId === "run_a", "an approval_request stream_event reaches forwardApprovalToOverlay for the right run");
  ok(approvalCalls[0].message.type === "browzyOverlayApproval" && approvalCalls[0].message.phase === "pending",
     "...as a browzyOverlayApproval message in the pending phase");
  ok(approvalCalls[0].message.requestId === "req_1" && approvalCalls[0].message.action === "computer click (submit-type control)" &&
     approvalCalls[0].message.target && approvalCalls[0].message.target.tabId === 42,
     "...carrying the EXACT requestId/action/target the host sent, never a derived summary");
  ok(relayed.length === 1, "the approval_request envelope is STILL relayed verbatim to agentPorts");
  ok(teardownCalls.length === 0, "an approval_request never triggers a teardown — it is a different observer entirely");

  handleAgentMessage({ type: "approval_decision", conversationId: "c1", runId: "run_a", requestId: "req_1", acknowledged: true });
  ok(approvalCalls.length === 2 && approvalCalls[1].runId === "run_a", "an approval_decision (its own top-level envelope, not nested in a stream_event) also reaches forwardApprovalToOverlay");
  ok(approvalCalls[1].message.type === "browzyOverlayApproval" && approvalCalls[1].message.phase === "resolved" && approvalCalls[1].message.requestId === "req_1",
     "...as a browzyOverlayApproval message in the resolved phase, carrying the same requestId");
  ok(!("action" in approvalCalls[1].message) && !("target" in approvalCalls[1].message),
     "a resolved message never carries action/target — nothing new to report beyond 'this requestId is no longer pending'");
  ok(relayed.length === 2, "the approval_decision envelope is ALSO relayed verbatim to agentPorts, exactly like every other envelope");

  // Neither observer fires for an unrelated envelope, or without a runId.
  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_b", event: { type: "run_started" } });
  ok(approvalCalls.length === 2, "an unrelated stream_event kind never touches the approval bridge");
  handleAgentMessage({ type: "stream_event", conversationId: "c1", event: { type: "approval_request", requestId: "req_2", action: "x", target: null } });
  ok(approvalCalls.length === 2, "an approval_request with no runId at all is never forwarded — there is no run to target");
  handleAgentMessage({ type: "approval_decision", conversationId: "c1", requestId: "req_2" });
  ok(approvalCalls.length === 2, "an approval_decision with no runId is likewise never forwarded");
}

// =============================================================================
// 7c. Regression net for the ONE place this change deliberately departs from
//     the settled design (task 6.5): the approval bridge only ever builds a
//     pending/resolved message for the overlay to render a WAITING state —
//     it never constructs, sends, or references an Allow/Deny/grant control.
//     The design mockups draw Allow/Deny; this file must not.
// =============================================================================
console.log("\n== approval bridge: no grant/deny control anywhere in what background.js sends ==");
{
  const approvalCalls = [];
  const agentPorts = new Set();
  const agentSettingsRelay = { handleReply: () => false };
  const deps = {
    agentSettingsRelay,
    agentPorts,
    dbg: () => {},
    teardownOverlayForRun: () => {},
    forwardApprovalToOverlay: (runId, message) => approvalCalls.push({ runId, message }),
    OVERLAY_TEARDOWN_RUN_EVENTS: new Set(["run_stopped", "run_error", "run_interrupted_by_restart"])
  };
  const src = "let agentHandshakeState = \"pending\";\nlet agentHandshakeDetail = null;\n" + extractFunction("handleAgentMessage");
  const handleAgentMessage = compile(src, deps, "handleAgentMessage");

  handleAgentMessage({
    type: "stream_event", conversationId: "c1", runId: "run_a",
    event: { type: "approval_request", requestId: "req_1", action: "computer click (submit-type control)", target: { tabId: 42 }, ts: 1 }
  });
  handleAgentMessage({ type: "approval_decision", conversationId: "c1", runId: "run_a", requestId: "req_1" });

  ok(approvalCalls.length === 2, "both the pending and resolved messages were built");
  for (const call of approvalCalls) {
    const keys = Object.keys(call.message);
    ok(!keys.some((k) => /allow|deny|grant|decision/i.test(k)),
       `the ${call.message.phase} message's own keys never include a grant/deny field (got: ${keys.join(", ")})`);
    ok(!/allow|deny|grant/i.test(JSON.stringify(call.message)),
       `the ${call.message.phase} message's serialized content never mentions allow/deny/grant at all`);
  }
  // Nothing in the shipped source constructs a browzyOverlayApproval message
  // with any decision-taking field, anywhere — not just in the two calls
  // this test happened to trigger.
  ok(!/browzyOverlayApproval[\s\S]{0,400}(allow|deny|grant)/i.test(SRC),
     "the shipped source never pairs the approval message type with an allow/deny/grant field, structurally");
}

// =============================================================================
// 8. Structural: the remaining teardown hooks that are anonymous
//    addListener callbacks (too small/glue-like to extract by name, exactly
//    like Batch 1 treats several of background.js's own call sites) — proven
//    by their literal presence and correct wiring in the shipped source.
// =============================================================================
console.log("\n== structural: debugger detach / tab removal / companion disconnect teardown hooks ==");
{
  ok(/chrome\.debugger\.onDetach\.addListener\(\(source\) => \{\s*\n\s*sendOverlayMessage\(source\.tabId, \{ type: "browzyOverlayTeardown", reason: "debugger_detached" \}\)/.test(SRC),
     "debugger detachment sends a teardown for that exact tab");
  ok(/chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{\s*\n\s*for \(const \[runId, tabs\] of overlayRunTabs\)/.test(SRC),
     "tab removal prunes that tabId out of every tracked run's tab set");
  ok(/agentSettingsRelay\.handleDisconnect\("native_host_disconnected"\);\s*\n\s*\/\/ Overlay bridge[\s\S]{0,300}teardownAllOverlays\("companion_disconnected"\);/.test(SRC),
     "native port disconnect (companion loss) tears down every tracked overlay, right in the existing onDisconnect handler");
  // The pre-existing chrome.debugger.onDetach listener (attachedTabs
  // bookkeeping) must still be present, unmodified, alongside the new one —
  // two separate addListener calls, never a merged/replaced one.
  const detachListenerCount = (SRC.match(/chrome\.debugger\.onDetach\.addListener/g) || []).length;
  ok(detachListenerCount === 2, `exactly two onDetach listeners registered (the pre-existing attachedTabs cleanup, unmodified, plus this task's new overlay teardown) — got ${detachListenerCount}`);
}

// =============================================================================
// 9. browzyOverlayOpenPanel listener (Finding 1 fix): the overlay's
//    Open-panel button used to send a message NOTHING in background.js
//    listened for — an inert control that was, while a run was blocked on
//    approval, the operator's ONLY reachable control on the page. This
//    listener (mirroring the browzyOverlayStop listener immediately above
//    it in the shipped source) is what makes it real: it calls
//    chrome.sidePanel.open() — Chrome's own documented content-script ->
//    service-worker pattern for opening the side panel from a button click
//    — with no `await` ahead of the call, which is required for the user
//    gesture Chrome curries through chrome.runtime.sendMessage to still be
//    spendable by the time this listener runs. It never touches the
//    approval decision itself (design.md D6) — only routes to the panel.
// =============================================================================
console.log("\n== browzyOverlayOpenPanel: the Open-panel button actually opens the side panel (Finding 1) ==");
{
  const match = SRC.match(/chrome\.runtime\.onMessage\.addListener\(\(msg, sender\) => \{\n([\s\S]*?)\n\}\);/);
  ok(!!match, "a dedicated browzyOverlayOpenPanel listener is registered as its own addListener call");
  const body = match ? match[1] : "";
  ok(/msg\.type !== "browzyOverlayOpenPanel"/.test(body), "gated on the exact message type the overlay's Open-panel button sends");
  ok(/chrome\.sidePanel\.open\(/.test(body), "it actually calls chrome.sidePanel.open() — the button is no longer inert");
  const openCallIdx = body.indexOf("chrome.sidePanel.open(");
  ok(openCallIdx !== -1 && !/\bawait\b/.test(body.slice(0, openCallIdx)),
     "chrome.sidePanel.open() is reached with no `await` (or other async wait) ahead of it in the SAME listener body — required to still be able to spend the user gesture Chrome curries through runtime.sendMessage from the content script's click");
  ok(!/allow|deny|grant|approv/i.test(body), "the listener never touches an approval decision anywhere in its own body — it only routes to the panel (design.md D6)");

  // Behavioral proof: compile the REAL extracted callback body (not a
  // rewritten copy) and run it against fake chrome/sender shapes.
  function makeListener(fakeChrome) {
    return compile(`function listener(msg, sender) {\n${body}\n}`, { chrome: fakeChrome }, "listener");
  }

  const openCalls = [];
  const fakeChrome = { sidePanel: { open: (opts) => { openCalls.push(opts); return { catch: () => {} }; } } };
  const listener = makeListener(fakeChrome);

  listener({ type: "browzyOverlayOpenPanel" }, { tab: { id: 7, windowId: 42 } });
  ok(openCalls.length === 1 && openCalls[0].tabId === 7, "a real message from a tab opens the side panel for that EXACT tab");
  // Tab-scoped, deliberately. A panel opened with { windowId } is window-scoped
  // and ignores per-tab setOptions({enabled}) — it would stay on screen over
  // tabs the group rule has already disabled, which is exactly the bug that
  // made "close the panel outside the group" appear not to work at all.
  ok(openCalls[0].windowId === undefined, "...and NOT for the window, which would ignore the per-tab enable/disable the group rule depends on");

  openCalls.length = 0;
  listener({ type: "browzyOverlayOpenPanel" }, { tab: { windowId: 42 } });
  ok(openCalls.length === 1 && openCalls[0].windowId === 42, "a sender with no tab id still falls back to the window rather than doing nothing");

  openCalls.length = 0;
  listener({ type: "browzyOverlayOpenPanel" }, { tab: null });
  ok(openCalls.length === 0, "no sender.tab at all -> never calls sidePanel.open (nothing to target)");

  openCalls.length = 0;
  listener({ type: "browzyOverlayOpenPanel" }, { tab: { windowId: null } });
  ok(openCalls.length === 0, "a tab with no windowId -> never calls sidePanel.open");

  openCalls.length = 0;
  listener({ type: "browzyOverlayStop" }, { tab: { windowId: 42 } });
  ok(openCalls.length === 0, "an unrelated message type (e.g. browzyOverlayStop) is ignored entirely by this listener");

  // A Chromium fork / policy-restricted build with no chrome.sidePanel
  // namespace at all must never throw — it silently does nothing, exactly
  // like the pre-existing hasSidePanel feature-detection elsewhere in this
  // file treats the same condition.
  const listenerNoSidePanel = makeListener({ sidePanel: undefined });
  let threw = false;
  try { listenerNoSidePanel({ type: "browzyOverlayOpenPanel" }, { tab: { windowId: 42 } }); } catch { threw = true; }
  ok(!threw, "a browser reporting no chrome.sidePanel namespace at all never throws — it silently does nothing");
}

// =============================================================================
// 10. startOverlayForRun: RC1 (design.md D7) — an unscoped run raises through
//     the SAME tab-group resolution the keepalive path already implements,
//     an explicit array still raises exactly those tabs (plus the group),
//     and a run whose group resolves to nothing raises nothing.
// =============================================================================
console.log("\n== startOverlayForRun: unscoped run raises through the tab group (RC1, design.md D7) ==");
{
  function buildOverlayHarness({ groupTabs, tabGroupIdValue }) {
    const sent = [];
    const sendOverlayMessage = async (tabId, msg) => { sent.push({ tabId, msg }); };
    const overlayRunTabs = new Map();
    const overlayKeepaliveTimers = new Map();
    const fakeSetInterval = (fn) => ({ fn }); // never actually fires — this test only checks the SYNCHRONOUS raise
    const fakeClearInterval = () => {};
    const chrome = { tabs: { query: async () => groupTabs } };
    const deps = {
      sendOverlayMessage, overlayRunTabs, overlayKeepaliveTimers,
      OVERLAY_KEEPALIVE_INTERVAL_MS: 1000,
      tabGroupId: tabGroupIdValue,
      chrome,
      setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
      isUnscriptableUrl: (url) => /^chrome:/i.test(url || "")
    };
    const src = [
      extractFunction("addGroupTabsToOverlayRun"),
      extractFunction("sendOverlayKeepalive"),
      extractFunction("startOverlayKeepalive"),
      extractFunction("stopOverlayKeepalive"),
      extractFunction("startOverlayForRun")
    ].join("\n\n");
    const { startOverlayForRun } = compile(src, deps, "({ startOverlayForRun })");
    return { startOverlayForRun, sent, overlayRunTabs };
  }

  {
    const H = buildOverlayHarness({ groupTabs: [{ id: 21 }, { id: 22 }], tabGroupIdValue: 99 });
    await H.startOverlayForRun("run_u", "any");
    ok(H.overlayRunTabs.get("run_u") && [...H.overlayRunTabs.get("run_u")].sort().join() === "21,22",
       "an unscoped run (tabScope \"any\") raises through the group-resolution path, exactly on the tabs the group holds (task 6.1)");
    ok(H.sent.length === 2 && H.sent.every((s) => s.msg.type === "browzyOverlayEvent" && s.msg.event.kind === "keepalive"),
       "...sent immediately as a keepalive on every group tab, not waiting for the first dispatched tool to happen to carry one");
  }

  {
    const H = buildOverlayHarness({ groupTabs: [{ id: 21 }], tabGroupIdValue: 99 });
    await H.startOverlayForRun("run_s", [42]);
    ok([...H.overlayRunTabs.get("run_s")].sort().join() === "21,42",
       "an explicit tabScope array still raises exactly those tabs — PLUS the group it also resolves, consistent with what the keepalive path does a second later");
  }

  {
    const H = buildOverlayHarness({ groupTabs: [], tabGroupIdValue: null });
    await H.startOverlayForRun("run_none", "any");
    ok(!H.overlayRunTabs.has("run_none") || H.overlayRunTabs.get("run_none").size === 0, "a run whose group resolves to no scriptable tab raises nothing (task 6.3)");
    ok(H.sent.length === 0, "...no tab outside the run is ever marked");
  }

  {
    // isUnscriptableUrl's own exclusion still applies through this path —
    // a page no extension may script is never added just because it sits
    // in the operator's tab group.
    const H = buildOverlayHarness({ groupTabs: [{ id: 21, url: "chrome://extensions" }, { id: 22, url: "https://example.com" }], tabGroupIdValue: 99 });
    await H.startOverlayForRun("run_scr", "any");
    ok([...H.overlayRunTabs.get("run_scr")].sort().join() === "22", "a page no extension may script is excluded even though it sits in the group");
  }
}

// =============================================================================
// 11. attachSuppressionWarning (task 7.7/11.12): the residual delivery-race
//     detector's report actually reaches the currently-open action's own
//     outcome — this bridge test cannot execute handleToolRequest itself
//     (see this file's own header), so the helper is unit-tested directly
//     against the SAME currentAction/currentActionExtras module-level slot
//     handleToolRequest assigns, plus a structural order check confirming
//     that slot really is populated before the handler dispatches and
//     cleared only after it settles.
// =============================================================================
console.log("\n== attachSuppressionWarning: the suppression report reaches the action's own outcome (task 7.7) ==");
{
  const actionEventsStub = { OUTCOME_STATUSES: { SUCCESS: "success", ERROR: "error", UNKNOWN: "unknown" } };
  function buildHarness() {
    const src = "let currentAction = null;\nlet currentActionExtras = null;\n" + extractFunction("attachSuppressionWarning");
    return compile(
      src,
      { actionEvents: actionEventsStub, INPUT_SUPPRESSION_ATTACH_WINDOW_MS: 1500 },
      "({ attachSuppressionWarning, set current(v){ currentAction = v.action; currentActionExtras = v.extras; }, get extras(){ return currentActionExtras; } })"
    );
  }

  {
    const H = buildHarness();
    H.current = { action: { runId: "run_a", actionId: "a1" }, extras: { artifactId: null, outcomeStatus: null, outcomeDetail: null } };
    const attached = H.attachSuppressionWarning("run_a", 7, Date.now());
    ok(attached === true, "a suppression report for the SAME run currently open attaches a warning");
    ok(H.extras.outcomeStatus === "unknown", "...flips outcomeStatus away from a bare success (the exact thing standing between the delivery race and a silent wrong result)");
    ok(typeof H.extras.outcomeDetail === "string" && H.extras.outcomeDetail.length > 0, "...with a real, human-readable detail, not a blank flag nobody reads");
  }
  {
    const H = buildHarness();
    H.current = { action: { runId: "run_a" }, extras: { outcomeStatus: null } };
    ok(H.attachSuppressionWarning("run_b", 7, Date.now()) === false, "a report for a DIFFERENT run than the one currently open never attaches — never misattributes a warning");
    ok(H.extras.outcomeStatus === null, "...leaving the actually-open action's outcome untouched");
  }
  {
    const H = buildHarness();
    H.current = { action: null, extras: null };
    ok(H.attachSuppressionWarning("run_a", 7, Date.now()) === false, "no action currently open at all -> false, never throws");
  }
  {
    const H = buildHarness();
    H.current = { action: { runId: "run_a" }, extras: { outcomeStatus: null } };
    ok(H.attachSuppressionWarning("run_a", 7, Date.now() - 60000) === false, "a report far outside the attach window is rejected — this is a delivery-race detector, not a general-purpose grace period");
    ok(H.extras.outcomeStatus === null, "...and it never touches the outcome when rejected");
  }
}

console.log("\n== structural: attachSuppressionWarning reads the SAME slot handleToolRequest assigns before the handler runs ==");
{
  const startIdx = SRC.indexOf("actionCtx = emitActionStart(tool, args, meta);");
  const currentActionIdx = SRC.indexOf("currentAction = actionCtx;", startIdx);
  const currentExtrasIdx = SRC.indexOf("currentActionExtras = actionExtras;", startIdx);
  const handlerIdx = SRC.indexOf("result = await handler(args);", startIdx);
  const finallyClearActionIdx = SRC.indexOf("if (currentAction === actionCtx) currentAction = null;", startIdx);
  ok(startIdx !== -1 && currentActionIdx !== -1 && currentExtrasIdx !== -1 && handlerIdx !== -1 && finallyClearActionIdx !== -1,
     "all expected call sites present in handleToolRequest (background.js:4924-4946)");
  ok(currentActionIdx < handlerIdx && currentExtrasIdx < handlerIdx,
     "currentAction/currentActionExtras are assigned BEFORE `handler(args)` runs — so a suppression report arriving DURING dispatch has something real to attach to");
  ok(handlerIdx < finallyClearActionIdx,
     "...and cleared only in the `finally` AFTER the handler settles — a report arriving anywhere during the actual dispatch window reaches the right action");
  ok(/chrome\.runtime\.onMessage\.addListener\(\(msg\) => \{\s*\n\s*if \(!msg \|\| msg\.type !== "browzyOverlayInputSuppressed"\) return;/.test(SRC),
     "the browzyOverlayInputSuppressed listener is registered as its own (msg)-only addListener call, never merged into the Open-panel listener's (msg, sender) one above it");
}

// =============================================================================
// 12. Structural: extension/content.js excludes the overlay's own host from
//     extraction (design.md D4 / task 4.1-4.2, 11.14). Implemented INLINE
//     at the two real extraction sites, not as a new helper — getPageText()
//     is compiled in test/registry-borrowed-tab-live-extraction.test.mjs
//     with only elementMap/history/location/window/document in scope, so a
//     new helper referenced from there would be a ReferenceError.
// =============================================================================
console.log("\n== structural: content.js excludes [data-browzy-overlay] from extraction (design.md D4) ==");
{
  const contentSrc = fs.readFileSync(CONTENT, "utf8");
  ok(/querySelectorAll\("script, style, noscript, template, svg, \[data-browzy-overlay\]"\)/.test(contentSrc),
     "getPageText()'s cleanText() removal list includes [data-browzy-overlay] — the overlay's own subtree is stripped from any extracted text, by attribute rather than tag/id/class (task 4.2)");
  ok(/el\.closest\("\[data-browzy-overlay\]"\)\) continue;/.test(contentSrc),
     "findElements() skips any node inside [data-browzy-overlay] — the overlay host itself IS reachable by collectAll(document)'s own querySelectorAll(\"*\"), unlike getPageText()'s document.body-rooted walk");
  // Task 11.14's own ReferenceError concern: no new top-level helper
  // function was introduced for this — both exclusions are inline at their
  // real call sites.
  ok(!/function isBrowzyOverlayNode/.test(contentSrc) && !/function excludeOverlay/.test(contentSrc),
     "no new helper function was introduced for this exclusion — it is inline at the two real extraction sites (task 11.14)");
}

console.log(fail === 0 ? "\nALL OVERLAY BACKGROUND BRIDGE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

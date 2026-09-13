// Tests for the extension/background.js bridge that forwards the host's
// `tab_risk_update` (openspec/changes/add-permission-modes-and-threat-signals/
// reports/wave2h-events.md) to the agent pointer overlay on the tab it names
// — closing task 7.7's last hop (extension/overlay/pointer-overlay.js already
// accepts the `browzyOverlayRisk` message this produces; this file proves the
// relay that actually sends it).
//
// Same extraction technique test/overlay-background-bridge.test.mjs already
// uses for extension/background.js (test/_extract.mjs's brace-matching
// extractor): named functions are extracted and compiled with injected fakes.

import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// =============================================================================
// 1. forwardRiskUpdateToOverlay: routes to the EXACT tab the event names,
//    forwards only category (never signals/matchedText), never fabricates.
// =============================================================================
console.log("== forwardRiskUpdateToOverlay: exact tab, category only, no fabrication ==");
{
  const sent = [];
  const sendOverlayMessage = (tabId, msg) => { sent.push({ tabId, msg }); return Promise.resolve({ ok: true }); };
  const forwardRiskUpdateToOverlay = compile(
    extractFunction("forwardRiskUpdateToOverlay"),
    { sendOverlayMessage },
    "forwardRiskUpdateToOverlay"
  );

  forwardRiskUpdateToOverlay({
    type: "tab_risk_update",
    tabId: 42,
    category: "elevated",
    signals: [{ kind: "injection_finding", severity: "elevated", label: "Prompt injection detected", ts: 1, matchedText: "ignore all previous instructions" }]
  });
  ok(sent.length === 1 && sent[0].tabId === 42, "delivered to the EXACT tab the event named");
  ok(sent[0].msg.type === "browzyOverlayRisk", "uses the message type pointer-overlay.js's onOverlayMessage already accepts");
  ok(sent[0].msg.category === "elevated", "forwards the host's real category verbatim");
  ok(!("signals" in sent[0].msg) && !("matchedText" in sent[0].msg), "signals/matchedText (page-authored quoted data) are never sent — the chip has no use for them");

  sent.length = 0;
  forwardRiskUpdateToOverlay({ type: "tab_risk_update", tabId: 42, category: "uncategorized", signals: [] });
  ok(sent.length === 1 && sent[0].msg.category === "uncategorized",
     "a reset back to uncategorized after navigation is relayed too, so a stale elevated chip clears rather than sticking");

  sent.length = 0;
  forwardRiskUpdateToOverlay({ type: "tab_risk_update", tabId: null, category: "low", signals: [] });
  ok(sent.length === 0, "an event with no numeric tabId is dropped rather than guessed at (never routed to 'whatever tab is active')");

  sent.length = 0;
  forwardRiskUpdateToOverlay(null);
  ok(sent.length === 0, "a missing event never throws");
}

// =============================================================================
// 2. forwardRiskUpdateToOverlay: a relay failure (no overlay mounted, tab
//    gone) is tolerated silently — never throws, never rejects unhandled.
// =============================================================================
console.log("\n== forwardRiskUpdateToOverlay: relay failure tolerated silently ==");
{
  const sendOverlayMessage = () => Promise.reject(new Error("no receiving end"));
  const forwardRiskUpdateToOverlay = compile(
    extractFunction("forwardRiskUpdateToOverlay"),
    { sendOverlayMessage },
    "forwardRiskUpdateToOverlay"
  );
  let threw = false;
  try {
    forwardRiskUpdateToOverlay({ type: "tab_risk_update", tabId: 99, category: "low", signals: [] });
    // Give the rejected promise a tick to surface as an unhandled rejection
    // if the .catch(() => {}) were ever missing.
    await new Promise((r) => setTimeout(r, 10));
  } catch {
    threw = true;
  }
  ok(!threw, "a tab that is gone / has no mounted overlay never throws out of the relay");
}

// =============================================================================
// 3. handleAgentMessage: observes `tab_risk_update` stream_events and calls
//    the risk bridge — without altering the verbatim relay to agentPorts.
// =============================================================================
console.log("\n== handleAgentMessage: tab_risk_update hook, relay untouched ==");
{
  const riskCalls = [];
  const relayed = [];
  const agentPorts = new Set();
  agentPorts.add({ postMessage: (m) => relayed.push(m) });
  const agentSettingsRelay = { handleReply: () => false };
  const deps = {
    agentSettingsRelay,
    agentPorts,
    dbg: () => {},
    teardownOverlayForRun: () => {},
    startOverlayForRun: () => Promise.resolve(),
    forwardApprovalToOverlay: () => {},
    forwardRiskUpdateToOverlay: (event) => riskCalls.push(event),
    OVERLAY_TEARDOWN_RUN_EVENTS: new Set(["run_stopped", "run_error", "run_interrupted_by_restart"]),
    activeAgentRuns: new Map()
  };
  const src = "let agentHandshakeState = \"pending\";\nlet agentHandshakeDetail = null;\n" + extractFunction("handleAgentMessage");
  const handleAgentMessage = compile(src, deps, "handleAgentMessage");

  const event = { type: "tab_risk_update", tabId: 7, category: "elevated", signals: [] };
  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_x", event });
  ok(riskCalls.length === 1 && riskCalls[0] === event, "the exact inner event is handed to the risk bridge, unmodified");
  ok(relayed.length === 1 && relayed[0].envelope.event === event, "the envelope is still relayed verbatim to agentPorts exactly as before this hook");

  riskCalls.length = 0;
  relayed.length = 0;
  handleAgentMessage({ type: "stream_event", conversationId: "c1", runId: "run_x", event: { type: "run_started", tabScope: [] } });
  ok(riskCalls.length === 0, "an unrelated stream_event type never invokes the risk bridge");
  ok(relayed.length === 1, "...and is still relayed as before");
}

if (fail) {
  console.error(`\n${fail} assertion(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll overlay-risk-relay assertions passed.");
}

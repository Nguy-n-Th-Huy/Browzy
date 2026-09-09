#!/usr/bin/env node
// The reported problem: on a machine where the companion was never installed,
// the panel showed "Đang kết nối" for the life of the browser and the service
// worker retried connectNative() four times a second forever. Chrome had
// already said exactly what was wrong — `chrome.runtime.lastError` reads
// "Specified native messaging host not found." — but that message went only to
// a debug log, so a missing setup step was indistinguishable from a companion
// that was merely slow to start.
//
// Covered here, at the three layers the fix touches:
//   1. extension/background.js — classification of Chrome's own wording,
//      backoff for an absent host, and the envelope sent to open panels.
//      Proven structurally (regex over the shipped source), the same technique
//      test/handlers.test.mjs and test/overlay-background-bridge.test.mjs use:
//      connectNative/lastError cannot be executed offline.
//   2. extension/sidepanel/protocol-client.js — the new reason must reach
//      HANDSHAKE.ERROR, executed for real against the module.
//   3. extension/sidepanel/panel-controller.js — the no-conversation path must
//      stop collapsing a handshake error into CONNECTING. This is the case
//      that actually matters: a fresh machine has no conversation open.
//
// Run: node test/companion-missing-notice.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HANDSHAKE } from "../extension/sidepanel/protocol-client.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

let failures = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

// --- 1. background.js: classification, backoff, broadcast -------------------

console.log("== background: Chrome's own 'host not found' wording is classified, not just logged ==");
{
  const src = read("extension/background.js");

  ok(
    /NATIVE_HOST_ABSENT_PATTERNS\s*=\s*\[[^\]]*"not found"[^\]]*\]/.test(src),
    "the absent-host patterns include Chrome's \"not found\" wording"
  );
  ok(
    /NATIVE_HOST_ABSENT_PATTERNS\s*=\s*\[[^\]]*"forbidden"[^\]]*\]/.test(src),
    "...and \"forbidden\", the allowed_origins mismatch, which has the same answer for the operator"
  );
  ok(
    /function isNativeHostAbsent\([\s\S]*?toLowerCase\(\)/.test(src),
    "the match is case-insensitive, so a capitalisation change in Chrome does not silently break it"
  );

  // The whole point: lastError must feed the classifier, not only dbg().
  const disconnectBody = src.slice(src.indexOf("nativePort.onDisconnect.addListener"), src.indexOf("startHeartbeat();"));
  ok(
    /setCompanionMissing\(\s*isNativeHostAbsent\(\s*err/.test(disconnectBody),
    "the disconnect handler feeds lastError into the classifier (previously it reached only the debug log)"
  );

  ok(
    /setCompanionMissing\(false, null\);[\s\S]{0,200}startHeartbeat\(\)/.test(src),
    "a port that actually opens clears the missing state, so a freshly installed companion is not still reported missing"
  );

  // Backoff: the 250ms floor must survive for an installed host.
  ok(
    /NATIVE_RETRY_MIN_MS\s*=\s*250/.test(src),
    "the fast retry floor for an installed host is unchanged at 250ms"
  );
  ok(
    /if \(companionMissing\) nativeRetryDelayMs = Math\.min\(nativeRetryDelayMs \* 2, NATIVE_RETRY_MAX_MS\)/.test(src),
    "the delay grows ONLY while the companion is known absent — an installed host keeps reconnecting fast"
  );
  ok(
    !/setTimeout\(connectNativeHost, 250\)/.test(src),
    "no hardcoded 250ms reconnect remains; every path goes through the backoff scheduler"
  );
  ok(
    /nativeRetryDelayMs = NATIVE_RETRY_MIN_MS;/.test(src),
    "the delay resets when the companion comes back, rather than staying at the backed-off value"
  );

  // The panel must be told, and told only on a change.
  const setterBody = src.slice(src.indexOf("function setCompanionMissing"), src.indexOf("function scheduleNativeReconnect"));
  ok(
    /if \(companionMissing === missing\) return;/.test(setterBody),
    "the state is broadcast only when it CHANGES, so a backing-off loop does not spam open panels"
  );
  ok(
    /reason: "companion_not_installed"/.test(setterBody),
    "the envelope carries a reason specific enough for the panel to name the missing step"
  );
  ok(
    /for \(const port of agentPorts\)/.test(setterBody),
    "it reaches every open panel port, not just the one that happened to ask"
  );
}

// --- 2. protocol-client: the reason must become a handshake error ----------

console.log("== protocol-client: companion_not_installed becomes a handshake error ==");
{
  // A transport that lets the test push envelopes in as if the service worker
  // sent them. Only the surface ProtocolClient actually uses.
  function fakeTransport() {
    const listeners = [];
    return {
      postMessage() {},
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      disconnect() {},
      deliver(envelope) {
        for (const fn of listeners) fn({ type: "agent_msg", envelope });
      }
    };
  }

  const t = fakeTransport();
  // Imported lazily so a construction-signature change fails loudly here
  // rather than at import time for the whole file.
  const { ProtocolClient } = await import("../extension/sidepanel/protocol-client.js");
  const client = new ProtocolClient({ createTransport: () => t });
  client.connect();

  ok(client.handshakeState() === HANDSHAKE.PENDING, "a fresh client starts pending");

  t.deliver({ v: 1, type: "error", reason: "companion_not_installed", ts: Date.now() });
  ok(client.handshakeState() === HANDSHAKE.ERROR, "companion_not_installed puts the handshake into ERROR");
  ok(
    client.handshakeDetail() === "companion_not_installed",
    "the specific reason is preserved as the detail, not flattened to a generic error"
  );

  // The pre-existing sibling reason must keep working.
  const t2 = fakeTransport();
  const client2 = new ProtocolClient({ createTransport: () => t2 });
  client2.connect();
  t2.deliver({ v: 1, type: "error", reason: "native_host_unavailable", ts: Date.now() });
  ok(client2.handshakeState() === HANDSHAKE.ERROR, "native_host_unavailable still becomes ERROR (unchanged behaviour)");

  // A conversation-scoped error must NOT be mistaken for a connection one.
  const t3 = fakeTransport();
  const client3 = new ProtocolClient({ createTransport: () => t3 });
  client3.connect();
  t3.deliver({ v: 1, type: "error", conversationId: "c1", reason: "companion_not_installed", ts: Date.now() });
  ok(
    client3.handshakeState() === HANDSHAKE.PENDING,
    "an error carrying a conversationId is a per-run error and never touches the handshake"
  );
}

// --- 3. panel-controller: the no-conversation path must not say "connecting" -

console.log("== panel-controller: a handshake error is not collapsed into CONNECTING ==");
{
  function panelWith(handshake) {
    return new PanelController({
      protocolClient: {
        handshakeState: () => handshake,
        onEnvelope: () => () => {},
        onHandshakeChange: () => () => {},
        onDisconnect: () => () => {}
      },
      historyStore: { list: async () => [], promptsFor: async () => [] },
      profileCache: { read: async () => null }
    });
  }

  // This is the exact state of a fresh machine: companion missing, and no
  // conversation open, because opening one requires the companion.
  ok(
    panelWith("error").currentPhase() === RUN_PHASE.ERROR,
    "with no conversation open, a handshake error reports ERROR — the case that was reported as \"connecting forever\""
  );
  ok(
    panelWith("version_mismatch").currentPhase() === RUN_PHASE.ERROR,
    "a version mismatch with no conversation open also reports ERROR rather than connecting"
  );
  ok(
    panelWith("pending").currentPhase() === RUN_PHASE.CONNECTING,
    "a genuinely pending handshake still reports CONNECTING — the fix must not turn a normal startup into an error"
  );
  ok(
    panelWith("ok").currentPhase() === RUN_PHASE.EMPTY,
    "a healthy connection with no conversation is still EMPTY"
  );
}

// --- 4. sidepanel.js: the operator is told what to do ----------------------

console.log("== sidepanel: the pill names the missing step and says how to fix it ==");
{
  const src = read("extension/sidepanel/sidepanel.js");
  ok(
    /companion_not_installed:\s*"Chưa cài companion"/.test(src),
    "the error pill says the companion is not installed, not the generic \"Lỗi kết nối\""
  );
  ok(
    /install\.ps1[\s\S]{0,80}install\.sh/.test(src),
    "the tooltip names the actual command to run, on both Windows and macOS/Linux"
  );
  ok(
    /handshakeDetail\(\)/.test(src),
    "the label is driven by the real handshake detail, not by a guess from the phase alone"
  );
}

console.log(failures === 0 ? "\nALL COMPANION-MISSING NOTICE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

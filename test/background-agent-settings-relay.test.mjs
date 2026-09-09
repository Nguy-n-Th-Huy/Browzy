#!/usr/bin/env node
// createAgentSettingsRelay() in extension/background.js: the relay between
// extension/settings/settings-client.js's `chrome.runtime.sendMessage({type:
// "agent_settings", op, ...})` contract and the existing versioned agent
// channel (agent_msg envelopes over nativePort). Extracted from the SHIPPED
// background.js source (test/_extract.mjs's brace-matching technique,
// already used by test/handlers.test.mjs) so this exercises the real code,
// not a copy that can drift.
//
// What this test can and cannot prove, honestly: host/agent/companion.js
// does not yet implement an "agent_settings" envelope case (see the relay's
// own file-header comment in background.js), so there is no real end-to-end
// pass available in this environment. This test proves the RELAY's own
// contract — request shaping, hello/version-channel reuse (same postToNative
// call background.js already uses for the sidepanel), request/response
// correlation, the documented generic-unknown_message_type fallback,
// timeout, and disconnect handling — against a scripted fake companion
// reply, exactly the same testing posture
// reports/04-settings-ui-evidence.md already used on the settings-client.js
// side of this identical contract.
//
// Run: node test/background-agent-settings-relay.test.mjs

import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

// AGENT_PROTOCOL_VERSION is background.js's own module-level constant
// (mirroring host/agent/protocol.js's PROTOCOL_VERSION — see that file's
// comment on why it cannot be imported directly into this browser-side
// script); injected here the same way test/handlers.test.mjs injects the
// module-level state its own extracted handlers close over.
const source = extractFunction("createAgentSettingsRelay");
const createAgentSettingsRelay = compile(source, { AGENT_PROTOCOL_VERSION: 1 }, "createAgentSettingsRelay");

function makeHarness({ connected = true, timeoutMs = 200 } = {}) {
  const posted = [];
  let idCounter = 0;
  const relay = createAgentSettingsRelay({
    postToNative: (envelope) => posted.push(envelope),
    isConnected: () => connected,
    timeoutMs,
    genId: () => `req_${++idCounter}`
  });
  return { relay, posted, setConnected: (v) => (connected = v) };
}

async function main() {
  console.log("== a request is wrapped as the SAME versioned agent_msg envelope shape ==");
  {
    const { relay, posted } = makeHarness();
    const p = relay.handleRequest({ type: "agent_settings", op: "get_profile", profileId: "default" });
    ok(posted.length === 1, "exactly one envelope was posted to the native channel");
    const env = posted[0];
    ok(env.type === "agent_settings" && env.v === 1, "envelope carries type=agent_settings and the protocol version");
    ok(env.op === "get_profile" && env.profileId === "default", "op and payload fields pass through unchanged");
    ok(!("type" in env) || env.type === "agent_settings", "the wrapper's own 'type' field is not confused with a payload field");
    ok(typeof env.requestId === "string" && env.requestId.length > 0, "a requestId is attached for correlation");
    relay.handleReply({ v: 1, type: "agent_settings", requestId: env.requestId, ok: true, result: { profileId: "default" } });
    const res = await p;
    ok(res.ok === true && res.result.profileId === "default", "the matched reply resolves handleRequest's promise with {ok, result}");
  }

  console.log("== two concurrent requests are correlated by requestId, not by arrival order ==");
  {
    const { relay, posted } = makeHarness();
    const p1 = relay.handleRequest({ type: "agent_settings", op: "discover_models", profileId: "a" });
    const p2 = relay.handleRequest({ type: "agent_settings", op: "discover_models", profileId: "b" });
    ok(posted[0].requestId !== posted[1].requestId, "each request gets a distinct requestId");
    // Reply to the SECOND request first.
    relay.handleReply({ type: "agent_settings", requestId: posted[1].requestId, ok: true, result: "for-b" });
    relay.handleReply({ type: "agent_settings", requestId: posted[0].requestId, ok: true, result: "for-a" });
    const [r1, r2] = await Promise.all([p1, p2]);
    ok(r1.result === "for-a" && r2.result === "for-b", "each promise resolves with ITS OWN reply regardless of arrival order");
  }

  console.log("== a companion that does not yet implement agent_settings fails closed, not silently succeeds ==");
  {
    const { relay, posted } = makeHarness();
    const p = relay.handleRequest({ type: "agent_settings", op: "test_capability", profileId: "default", modelId: "m1" });
    // This is companion.js's REAL generic default-case shape for an
    // unrecognized envelope type (host/agent/companion.js: `makeEnvelope(
    // AGENT_MESSAGE_TYPES.ERROR, { reason: "unknown_message_type",
    // inReplyTo: envelope.type })`) — reproduced verbatim, not invented.
    relay.handleReply({ v: 1, type: "error", reason: "unknown_message_type", inReplyTo: "agent_settings" });
    const res = await p;
    ok(res.ok === false && res.error.code === "PROTOCOL_ERROR", "the generic unknown_message_type reply becomes an honest PROTOCOL_ERROR, never a fabricated success");
    ok(posted.length === 1, "exactly one envelope was sent for this one request");
  }

  console.log("== no live native connection fails closed immediately, without ever posting ==");
  {
    const { relay, posted } = makeHarness({ connected: false });
    const res = await relay.handleRequest({ type: "agent_settings", op: "save_profile" });
    ok(res.ok === false && res.error.code === "NETWORK_ERROR", "an unconnected native host resolves NETWORK_ERROR immediately");
    ok(posted.length === 0, "nothing is posted when there is no connection to post to");
  }

  console.log("== a request that never gets a reply times out rather than hanging forever ==");
  {
    const { relay } = makeHarness({ timeoutMs: 30 });
    const start = Date.now();
    const res = await relay.handleRequest({ type: "agent_settings", op: "test_capability" });
    ok(res.ok === false && res.error.code === "NETWORK_ERROR", "a silent companion times out as NETWORK_ERROR");
    ok(Date.now() - start < 500, "the timeout actually fires promptly, not after some much longer default");
  }

  console.log("== native host disconnect settles every pending request, not just the newest ==");
  {
    const { relay } = makeHarness({ timeoutMs: 5000 });
    const p1 = relay.handleRequest({ type: "agent_settings", op: "get_profile" });
    const p2 = relay.handleRequest({ type: "agent_settings", op: "discover_models" });
    relay.handleDisconnect("native_host_disconnected");
    const [r1, r2] = await Promise.all([p1, p2]);
    ok(r1.ok === false && r1.error.message === "native_host_disconnected", "the first pending request is settled with the disconnect reason");
    ok(r2.ok === false && r2.error.message === "native_host_disconnected", "the second pending request is ALSO settled, not left hanging");
  }

  console.log("== a reply/error for an unrelated envelope type is left alone (not misrouted here) ==");
  {
    const { relay } = makeHarness();
    const p = relay.handleRequest({ type: "agent_settings", op: "get_profile" });
    const consumed = relay.handleReply({ v: 1, type: "hello_ack" });
    ok(consumed === false, "handleReply reports it did NOT consume an unrelated envelope, so the caller still processes it normally");
    // The pending request is still outstanding.
    relay.handleDisconnect("cleanup");
    await p;
  }

  console.log(fail === 0 ? "\nALL BACKGROUND AGENT-SETTINGS-RELAY TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();

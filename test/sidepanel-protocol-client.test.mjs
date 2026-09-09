#!/usr/bin/env node
// protocol-client.js: envelope shaping, handshake state, connect/disconnect
// against a fake chrome.runtime.Port-shaped transport. No chrome.* API used.
//
// Run: node test/sidepanel-protocol-client.test.mjs

import { ProtocolClient, MSG, HANDSHAKE, AGENT_PROTOCOL_VERSION } from "../extension/sidepanel/protocol-client.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

// A fake chrome.runtime.Port: records everything posted, and lets the test
// inject an incoming message / a disconnect.
function fakePort() {
  const port = {
    sent: [],
    _msgListeners: [],
    _disconnectListeners: [],
    postMessage(msg) {
      port.sent.push(msg);
    },
    onMessage: { addListener: (fn) => port._msgListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port._disconnectListeners.push(fn) },
    disconnect() {
      for (const fn of port._disconnectListeners) fn();
    },
    // test helpers
    deliver(envelope) {
      for (const fn of port._msgListeners) fn({ type: "agent_msg", envelope });
    }
  };
  return port;
}

console.log("== connect/send/receive basic envelope shaping ==");
{
  let created = null;
  const client = new ProtocolClient({ createTransport: () => (created = fakePort()) });
  ok(client.handshakeState() === HANDSHAKE.PENDING, "starts pending");
  client.connect();
  ok(!!created, "createTransport was called on connect()");
  ok(client.isConnected(), "isConnected() true after connect");

  client.sendHello({ installationId: "inst1", connectionId: "conn1" });
  const sentHello = created.sent[0];
  ok(sentHello.type === "agent_msg" && sentHello.envelope.type === MSG.HELLO, "hello is wrapped as agent_msg");
  ok(sentHello.envelope.v === AGENT_PROTOCOL_VERSION, "hello carries the protocol version");
  ok(sentHello.envelope.installationId === "inst1" && sentHello.envelope.connectionId === "conn1", "hello carries identity fields");

  let handshakeEvents = [];
  client.onHandshakeChange((state, detail) => handshakeEvents.push({ state, detail }));
  created.deliver({ v: 1, type: "hello_ack" });
  ok(client.handshakeState() === HANDSHAKE.OK, "hello_ack moves handshake to ok");
  ok(handshakeEvents.length === 1 && handshakeEvents[0].state === "ok", "handshake-change listener fired with ok");
}

console.log("== version mismatch fails closed ==");
{
  const client = new ProtocolClient({ createTransport: fakePort });
  client.connect();
  const port = client._port;
  port.deliver({ v: 1, type: "version_mismatch", reason: "unsupported_version", requested: 99 });
  ok(client.handshakeState() === HANDSHAKE.VERSION_MISMATCH, "version_mismatch sets that exact handshake state");
  ok(client.handshakeDetail() === "unsupported_version", "the rejection reason is exposed");
}

console.log("== native_host_unavailable surfaces as a connection error, not silently ignored ==");
{
  const client = new ProtocolClient({ createTransport: fakePort });
  client.connect();
  client._port.deliver({ v: 1, type: "error", reason: "native_host_unavailable" });
  ok(client.handshakeState() === HANDSHAKE.ERROR, "native_host_unavailable becomes an error handshake state");
}

console.log("== every helper produces the exact envelope type/fields the real companion.js expects ==");
{
  const client = new ProtocolClient({ createTransport: fakePort });
  client.connect();
  const port = client._port;
  port.sent.length = 0;

  client.newConversation({ source: "toolbar" });
  ok(port.sent[0].envelope.type === MSG.NEW && port.sent[0].envelope.meta.source === "toolbar", "newConversation() sends NEW with meta");

  client.resumeConversation("conv_1", 42);
  const resumeEnv = port.sent[1].envelope;
  ok(resumeEnv.type === MSG.RESUME && resumeEnv.conversationId === "conv_1" && resumeEnv.afterSeq === 42, "resumeConversation() sends RESUME with conversationId/afterSeq");

  client.start({ conversationId: "conv_1", profileId: "p1", modelId: "m1", tabScope: "any", prompt: "hi" });
  const startEnv = port.sent[2].envelope;
  ok(
    startEnv.type === MSG.START &&
      startEnv.conversationId === "conv_1" &&
      startEnv.profileId === "p1" &&
      startEnv.modelId === "m1" &&
      startEnv.prompt === "hi",
    "start() sends every field _handleStart destructures"
  );

  client.stop({ conversationId: "conv_1", reason: "user_stop" });
  ok(port.sent[3].envelope.type === MSG.STOP && port.sent[3].envelope.reason === "user_stop", "stop() sends STOP with reason");

  client.approvalDecision({ conversationId: "conv_1", decision: "approve", action: "navigate", target: { url: "https://x" }, ttlMs: 5000 });
  const apprEnv = port.sent[4].envelope;
  ok(
    apprEnv.type === MSG.APPROVAL_DECISION && apprEnv.decision === "approve" && apprEnv.action === "navigate" && apprEnv.target.url === "https://x",
    "approvalDecision() sends exactly the fields _handleApprovalDecision reads"
  );
}

console.log("== enhancePrompt() sends the exact envelope shape for both ops, and replies route through onEnvelope ==");
{
  const client = new ProtocolClient({ createTransport: fakePort });
  client.connect();
  const port = client._port;
  port.sent.length = 0;

  client.enhancePrompt({ requestId: "req1", op: "generate", prompt: "make this clearer", profileId: "p1", modelId: "m1" });
  const genEnv = port.sent[0].envelope;
  ok(genEnv.type === MSG.ENHANCE_PROMPT, "generate op uses the enhance_prompt type");
  ok(genEnv.v === AGENT_PROTOCOL_VERSION, "carries the protocol version");
  ok(
    genEnv.requestId === "req1" && genEnv.op === "generate" && genEnv.prompt === "make this clearer" && genEnv.profileId === "p1" && genEnv.modelId === "m1",
    "generate op carries requestId/op/prompt/profileId/modelId exactly as _handleEnhancePrompt destructures them"
  );

  client.enhancePrompt({ requestId: "req1", op: "cancel" });
  const cancelEnv = port.sent[1].envelope;
  ok(cancelEnv.type === MSG.ENHANCE_PROMPT && cancelEnv.requestId === "req1" && cancelEnv.op === "cancel", "cancel op carries requestId + op only");
  ok(!("prompt" in cancelEnv) && !("profileId" in cancelEnv) && !("modelId" in cancelEnv), "cancel omits prompt/profileId/modelId entirely, not as null");

  let received = [];
  client.onEnvelope((env) => received.push(env));
  port.deliver({ v: 1, type: MSG.ENHANCE_PROMPT, requestId: "req1", ok: true, result: { text: "a clearer draft" } });
  ok(received.length === 1 && received[0].type === MSG.ENHANCE_PROMPT && received[0].ok === true, "a success reply routes through onEnvelope like every other reply");
  ok(received[0].result.text === "a clearer draft", "carrying the rewritten text");

  port.deliver({ v: 1, type: MSG.ENHANCE_PROMPT, requestId: "req1", ok: false, error: { code: "GENERATION_FAILED", message: "boom" } });
  ok(received.length === 2 && received[1].ok === false && received[1].error.code === "GENERATION_FAILED", "a failure reply routes through onEnvelope too, with its code intact");

  // An older companion answering unknown_message_type for this request —
  // sidepanel.js maps this (by inReplyTo, since this ERROR carries no
  // requestId) to a "companion needs updating" state.
  port.deliver({ v: 1, type: "error", reason: "unknown_message_type", inReplyTo: MSG.ENHANCE_PROMPT });
  ok(received.length === 3 && received[2].type === "error" && received[2].inReplyTo === MSG.ENHANCE_PROMPT, "an unknown_message_type error naming enhance_prompt also reaches onEnvelope");
}

console.log("== disconnect resets handshake and notifies listeners; malformed messages are ignored, not thrown ==");
{
  const client = new ProtocolClient({ createTransport: fakePort });
  client.connect();
  const port = client._port;
  port.deliver({ v: 1, type: "hello_ack" });
  let disconnected = 0;
  client.onDisconnect(() => disconnected++);
  port.disconnect();
  ok(!client.isConnected(), "isConnected() false after disconnect");
  ok(client.handshakeState() === HANDSHAKE.PENDING, "handshake resets to pending on disconnect");
  ok(disconnected === 1, "onDisconnect listener fired exactly once");

  // Reconnect and prove malformed/foreign messages never throw.
  client.connect();
  let threw = false;
  try {
    client._port.deliver(null);
    for (const fn of client._port._msgListeners) fn({ not: "agent_msg" });
    for (const fn of client._port._msgListeners) fn(undefined);
  } catch {
    threw = true;
  }
  ok(!threw, "malformed/foreign port messages are ignored rather than throwing");
}

console.log(fail === 0 ? "\nALL SIDEPANEL PROTOCOL-CLIENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

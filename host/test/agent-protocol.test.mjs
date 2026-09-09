#!/usr/bin/env node
//
// host/agent/protocol.js: version handshake fails closed, envelope framing.
//
// Run: node host/test/agent-protocol.test.mjs

import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  AGENT_MESSAGE_TYPES,
  validateHello,
  versionMismatchEnvelope,
  helloAckEnvelope,
  wrapAgentMessage,
  unwrapAgentMessage,
  makeEnvelope,
  isKnownMessageType
} from "../agent/protocol.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nAgent protocol\n");

test("a hello at the current version is accepted", () => {
  const result = validateHello(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  assert(result.ok === true, "expected ok");
  assert(result.version === PROTOCOL_VERSION, "expected negotiated version to be current");
});

test("an unsupported (future) version fails closed", () => {
  const result = validateHello({ v: PROTOCOL_VERSION + 999, type: "hello" });
  assert(result.ok === false, "expected rejection");
  assert(result.reason === "unsupported_version", `expected unsupported_version, got ${result.reason}`);
  assert(result.requested === PROTOCOL_VERSION + 999, "should echo the requested version");
});

test("a missing version fails closed rather than defaulting", () => {
  const result = validateHello({ type: "hello" });
  assert(result.ok === false, "expected rejection");
  assert(result.reason === "missing_version", `got ${result.reason}`);
});

test("a non-integer version fails closed", () => {
  const result = validateHello({ v: "1", type: "hello" });
  assert(result.ok === false, "a string version must not coerce to a number and pass");
});

test("a malformed envelope fails closed, not throws", () => {
  const result = validateHello(null);
  assert(result.ok === false && result.reason === "malformed_hello", "expected malformed_hello");
});

test("a non-hello envelope is rejected by validateHello", () => {
  const result = validateHello({ v: PROTOCOL_VERSION, type: "start" });
  assert(result.ok === false && result.reason === "not_a_hello", "expected not_a_hello");
});

test("versionMismatchEnvelope names every version this build actually supports", () => {
  const env = versionMismatchEnvelope("unsupported_version", { requested: 999 });
  assert(env.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "wrong type");
  assert(Array.isArray(env.supported) && env.supported.length === SUPPORTED_PROTOCOL_VERSIONS.length, "supported list mismatch");
  assert(env.requested === 999, "should echo requested");
});

test("helloAckEnvelope carries the current protocol version", () => {
  const env = helloAckEnvelope();
  assert(env.v === PROTOCOL_VERSION, "hello_ack must carry the negotiated/current version");
  assert(env.type === AGENT_MESSAGE_TYPES.HELLO_ACK, "wrong type");
});

test("wrap/unwrap round-trips an envelope through the native-messaging wrapper", () => {
  const envelope = makeEnvelope(AGENT_MESSAGE_TYPES.STOP, { conversationId: "conv_1" });
  const wire = wrapAgentMessage(envelope);
  assert(wire.type === "agent_msg", "wire wrapper type must be agent_msg (native-host.js keys off this)");
  const back = unwrapAgentMessage(wire);
  assert(back.type === AGENT_MESSAGE_TYPES.STOP && back.conversationId === "conv_1", "round trip lost data");
});

test("unwrapAgentMessage rejects a non-agent_msg native message instead of guessing", () => {
  assert(unwrapAgentMessage({ type: "tool_request", id: "1" }) === null, "must not unwrap an unrelated message type");
  assert(unwrapAgentMessage({ type: "agent_msg" }) === null, "must not unwrap a wrapper with no envelope");
  assert(unwrapAgentMessage(null) === null, "must not throw on null");
});

test("every AGENT_MESSAGE_TYPES value is recognized by isKnownMessageType", () => {
  for (const t of Object.values(AGENT_MESSAGE_TYPES)) {
    assert(isKnownMessageType(t), `${t} should be known`);
  }
  assert(!isKnownMessageType("totally_made_up"), "an unrecognized type must not be known");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

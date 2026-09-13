#!/usr/bin/env node
// createAgentSettingsRelay() in extension/background.js: the relay between
// extension/settings/settings-client.js's `chrome.runtime.sendMessage({type:
// "agent_settings", op, ...})` contract and the existing versioned agent
// channel (agent_msg envelopes over nativePort). Extracted from the SHIPPED
// background.js source (test/_extract.mjs's brace-matching technique,
// already used by test/handlers.test.mjs) so this exercises the real code,
// not a copy that can drift.
//
// What this test can and cannot prove, honestly: this is a scripted-fake
// companion, not a real end-to-end pass — the host half (host/agent/
// companion.js's agent_settings op cases) is covered separately by
// host/test/agent-settings-relay.test.mjs and
// host/test/permission-mode-companion-wiring.test.mjs. This test proves the
// RELAY's own contract — request shaping, hello/version-channel reuse (same
// postToNative call background.js already uses for the sidepanel),
// request/response correlation, the documented generic-unknown_message_type
// fallback, timeout, and disconnect handling — against a scripted fake
// companion reply, exactly the same testing posture
// reports/04-settings-ui-evidence.md already used on the settings-client.js
// side of this identical contract.
//
// PLUS the allowlist drift guard: the final test block reads the REAL op
// strings out of every shipped agent_settings client (both permissions-
// client.js and both skills-client.js twins included) and drives the real
// relay with each — a client gaining an op the allowlist does not carry
// fails this suite instead of silently dying in a user's browser.
//
// Run: node test/background-agent-settings-relay.test.mjs

import fs from "node:fs";
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

  console.log("== an op outside the relay's allowlist is rejected locally, never forwarded ==");
  {
    // The relay's fail-closed gate (extension/background.js's `ops` Set). An
    // allowlisted-but-invented op string would otherwise be forwarded
    // straight to the host's native channel, making the settings surface an
    // open proxy for whatever op name any extension page invents.
    const { relay, posted } = makeHarness();
    const res = await relay.handleRequest({ type: "agent_settings", op: "chatgpt_refresh_token", profileId: "default" });
    ok(res.ok === false && res.error.code === "PROTOCOL_ERROR", "an un-allowlisted op resolves PROTOCOL_ERROR, never a fabricated success");
    ok(/unknown agent_settings op/.test(res.error.message || "") && res.error.message.includes("chatgpt_refresh_token"),
      "the rejection names the op it refused");
    ok(posted.length === 0, "nothing was posted to the native channel for a rejected op");

    // The gate must be per-op, not a one-way latch: the NEXT, allowlisted op
    // still goes through normally.
    const p = relay.handleRequest({ type: "agent_settings", op: "get_profile", profileId: "default" });
    ok(posted.length === 1, "an allowlisted op after a rejection is forwarded as usual");
    relay.handleReply({ v: 1, type: "agent_settings", requestId: posted[0].requestId, ok: true, result: { profileId: "default" } });
    const okRes = await p;
    ok(okRes.ok === true, "the allowlisted op resolves from its own reply");
  }

  console.log("== every one of the six ChatGPT subscription ops is allowlisted ==");
  {
    // The newest op names (add-chatgpt-subscription-provider task 5.2) must
    // each be forwarded — a typo or an omission here would make the settings
    // page's ChatGPT sign-in fail with a local PROTOCOL_ERROR.
    const sixOps = [
      "set_provider_type",
      "chatgpt_sign_in_start",
      "chatgpt_device_start",
      "chatgpt_sign_in_status",
      "chatgpt_sign_in_cancel",
      "chatgpt_sign_out"
    ];
    const { relay, posted } = makeHarness();
    const pending = sixOps.map((op, i) =>
      relay.handleRequest({ type: "agent_settings", op, ...(op === "chatgpt_sign_in_status" || op === "chatgpt_sign_in_cancel" ? { signInId: `s${i}` } : { profileId: "default" }) })
    );
    ok(posted.length === sixOps.length, `all six new ops were forwarded (${posted.length}/${sixOps.length})`);
    ok(posted.every((env, i) => env.op === sixOps[i]), "each forwarded envelope carries its own op name unchanged");
    posted.forEach((env) => relay.handleReply({ v: 1, type: "agent_settings", requestId: env.requestId, ok: true, result: {} }));
    const responses = await Promise.all(pending);
    ok(responses.every((r) => r.ok === true), "none of the six resolved with the local PROTOCOL_ERROR rejection");
  }

  console.log("== every permission-family op is allowlisted (sidepanel badge + settings > permissions page) ==");
  {
    // add-permission-modes-and-threat-signals task 7.1: these ops arrived
    // AFTER the allowlist gate was written. Omitted, every call resolved
    // locally with the unknown-op PROTOCOL_ERROR — the sidepanel's mode menu
    // then rendered EMPTY (its single load attempt fails silently and is
    // never retried), so clicking the "Auto" trigger opened a blank popover,
    // and the settings page's remembered-site revocation was equally dead.
    // This pins the allowlist entries so that live regression cannot come
    // back.
    const permissionOps = ["get_permission_state", "set_permission_mode", "revoke_site_entry", "revoke_all_site_entries"];
    const { relay, posted } = makeHarness();
    const pending = permissionOps.map((op) =>
      relay.handleRequest({ type: "agent_settings", op, ...(op === "set_permission_mode" ? { mode: "manual" } : {}) })
    );
    ok(posted.length === permissionOps.length, `all ${permissionOps.length} permission-family ops were forwarded (${posted.length}/${permissionOps.length})`);
    ok(posted.every((env, i) => env.op === permissionOps[i]), "each forwarded envelope carries its own op name unchanged");
    ok(posted[1].mode === "manual", "set_permission_mode's payload rides along unchanged");
    posted.forEach((env) => relay.handleReply({ v: 1, type: "agent_settings", requestId: env.requestId, ok: true, result: {} }));
    const responses = await Promise.all(pending);
    ok(responses.every((r) => r.ok === true), "none resolved with the local PROTOCOL_ERROR rejection");
  }

  console.log("== the skills op family and get_advertised_commands are allowlisted (both skills clients) ==");
  {
    // Both extension/{sidepanel,settings}/skills-client.js twins send these
    // over the same relay; the same allowlist-gate omission that killed the
    // permission-mode ops would kill every skills read/author/enable op with
    // a local PROTOCOL_ERROR — the Skills UI would never list anything.
    const skillsOps = [
      "skills_list",
      "skills_read_source",
      "skills_author",
      "skills_enable",
      "skills_disable",
      "skills_remove",
      "skills_set_invocation_flags",
      "get_advertised_commands"
    ];
    const { relay, posted } = makeHarness();
    const pending = skillsOps.map((op) => relay.handleRequest({ type: "agent_settings", op }));
    ok(posted.length === skillsOps.length, `all ${skillsOps.length} skills-family ops were forwarded (${posted.length}/${skillsOps.length})`);
    ok(posted.every((env, i) => env.op === skillsOps[i]), "each forwarded envelope carries its own op name unchanged");
    posted.forEach((env) => relay.handleReply({ v: 1, type: "agent_settings", requestId: env.requestId, ok: true, result: {} }));
    const responses = await Promise.all(pending);
    ok(responses.every((r) => r.ok === true), "none resolved with the local PROTOCOL_ERROR rejection");
  }

  console.log("== drift guard: every op any shipped agent_settings client sends is allowlisted ==");
  {
    // The guard reads the REAL client sources — not a hand-maintained list —
    // and drives the REAL relay with every op string they send. This is the
    // general form of the permission/skills regressions pinned above: an op
    // family that updates its client but not the allowlist fails HERE, in a
    // plain Node run, instead of resolving with a local PROTOCOL_ERROR in a
    // user's browser (the "click Auto, nothing opens" class of bug).
    const clientFiles = [
      "../extension/settings/settings-client.js",
      "../extension/settings/permissions-client.js",
      "../extension/sidepanel/permissions-client.js",
      "../extension/settings/skills-client.js",
      "../extension/sidepanel/skills-client.js"
    ];
    const sentOps = new Set();
    for (const rel of clientFiles) {
      const src = fs.readFileSync(new URL(rel, import.meta.url), "utf8");
      for (const m of src.matchAll(/(?:call|sendMessage)\(\s*["']([a-z_]+)["']/g)) sentOps.add(m[1]);
      for (const m of src.matchAll(/op:\s*["']([a-z_]+)["']/g)) sentOps.add(m[1]);
    }
    ok(sentOps.size >= 20, `the guard found the op strings in the shipped client sources (${sentOps.size} distinct ops) — a vacuous pass is impossible`);
    const { relay, posted } = makeHarness();
    const pending = [...sentOps].map((op) => relay.handleRequest({ type: "agent_settings", op }));
    const rejected = [...sentOps].filter((op) => !posted.some((env) => env.op === op));
    ok(rejected.length === 0, `every op sent by a shipped client is allowlisted — missing: ${rejected.join(", ") || "(none)"}`);
    posted.forEach((env) => relay.handleReply({ v: 1, type: "agent_settings", requestId: env.requestId, ok: true, result: {} }));
    const responses = await Promise.all(pending);
    ok(responses.every((r) => r.ok === true), "none of the client-sent ops resolved with the local PROTOCOL_ERROR rejection");
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

#!/usr/bin/env node
//
// LIVE ChatGPT-subscription coverage for the loopback gateway
// (host/agent/chatgpt/gateway.js + upstream-client.js), guarded behind an
// explicit opt-in env var so the offline suite never depends on a signed-in
// ChatGPT account existing on the machine. This file makes NO network call
// and reads NO credential unless OCIC_RUN_LIVE_CHATGPT_TESTS=1 is set.
//
// This does NOT sign in or store anything itself. It consumes whatever
// `chatgpt` profile is ALREADY signed in through the real production path
// (extension settings -> agent_settings ops -> host/agent/chatgpt/auth.js,
// whose credential lives in the OS credential store under
// `browzy-in-chrome/chatgpt/<profileId>`). Seed one first: configure a
// profile's provider type as `chatgpt` and complete a sign-in from the
// settings page, then:
//
//   OCIC_RUN_LIVE_CHATGPT_TESTS=1 node host/test/chatgpt-live.test.mjs
//
// What it proves against the real backend, end to end:
//   1. a run snapshot's SDK environment carries the loopback gateway URL and
//      a gateway token — never a ChatGPT token;
//   2. one streamed tool round trip with an image through the gateway:
//      message_start -> tool_use (an 80-character tool name shortened
//      upstream and restored for the client) -> input_json_delta ->
//      message_delta stop_reason=tool_use -> message_stop;
//   3. the tool result carrying a text + base64-image array is accepted on
//      the next turn and the turn completes;
//   4. the run token is revoked when the run ends (a subsequent request with
//      it gets 401 authentication_error).
//
// Requests here are small but real and count against the account's ChatGPT
// usage limit, exactly like the settings connection test.
//
// runStreamedToolRoundTrip() is exported so this file's own request/assertion
// logic can be smoke-tested offline against the real gateway pointed at a
// mock upstream, without a live account or any change to the live target.

import { pathToFileURL } from "node:url";

const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
const LIVE = process.env.OCIC_RUN_LIVE_CHATGPT_TESTS === "1";

// 80 characters: over the 64-character cap, so the translator must shorten it
// upstream and the reverse map must restore it in the streamed response.
export const LONG_TOOL_NAME = `live_${"x".repeat(70)}_tool`;
if (LONG_TOOL_NAME.length !== 80) throw new Error(`expected an 80-character tool name, got ${LONG_TOOL_NAME.length}`);

/** POST one Anthropic Messages request to the gateway, streaming, and return
 * the parsed SSE frames in arrival order (each `data` JSON-decoded). */
async function streamGateway(baseUrl, apiKey, body) {
  const { createSSEParser } = await import("../agent/chatgpt/translate-stream.js");
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const frames = createSSEParser()
    .push(text)
    .map((frame) => {
      // createSSEParser() returns `data` as the raw field text (it is a
      // generic SSE line parser, not a JSON one) — decode it here.
      let data;
      try {
        data = JSON.parse(frame.data);
      } catch {
        data = frame.data;
      }
      return { event: frame.event, data };
    });
  return { status: res.status, frames, raw: text };
}

function framesOfType(frames, name) {
  return frames.filter((f) => f.event === name).map((f) => f.data);
}

function inputJsonDeltas(frames) {
  return frames
    .filter((f) => f.event === "content_block_delta" && f.data.delta && f.data.delta.type === "input_json_delta")
    .map((f) => f.data.delta.partial_json);
}

/**
 * One streamed tool round trip with an image through the gateway, followed by
 * a tool result carrying a text + base64-image array. Throws on the first
 * violated expectation; returns the observed tool-call id/arguments.
 *
 * `model` is the model the gateway is expected to rewrite the request to.
 * @param {{ baseUrl: string, apiKey: string, model: string, visionProbePngBase64: string }} params
 */
export async function runStreamedToolRoundTrip({ baseUrl, apiKey, model, visionProbePngBase64 }) {
  const tools = [
    {
      name: LONG_TOOL_NAME,
      description: "Report a two-word description of the attached image. Call this tool exactly once.",
      input_schema: { type: "object", properties: { image_description: { type: "string" } } }
    }
  ];
  const imageAndPrompt = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: visionProbePngBase64 } },
    { type: "text", text: "Call the tool with a two-word description of the colour and shape in this image." }
  ];

  // Turn 1 — the tool call itself. `model` is deliberately a model the
  // gateway is NOT bound to: it must rewrite the request to the bound model.
  const first = await streamGateway(baseUrl, apiKey, {
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    system: "You are a terse test assistant.",
    tools,
    tool_choice: { type: "tool", name: LONG_TOOL_NAME },
    messages: [{ role: "user", content: imageAndPrompt }],
    stream: true
  });
  if (first.status !== 200) throw new Error(`gateway answered HTTP ${first.status}: ${JSON.stringify(first.raw.slice(0, 400))}`);
  if (framesOfType(first.frames, "error").length > 0) {
    throw new Error(`upstream returned an error mid-stream: ${JSON.stringify(framesOfType(first.frames, "error"))}`);
  }
  if (framesOfType(first.frames, "message_start").length !== 1) throw new Error("exactly one message_start expected");

  const starts = framesOfType(first.frames, "content_block_start");
  const toolStart = starts.find((f) => f.content_block && f.content_block.type === "tool_use");
  if (!toolStart) throw new Error(`the model did not call the tool: ${JSON.stringify(starts)}`);
  if (toolStart.content_block.name !== LONG_TOOL_NAME) {
    throw new Error(`the original tool name must be restored (shortening is upstream-only), got ${toolStart.content_block.name}`);
  }
  if (!toolStart.content_block.id) throw new Error("the tool_use block must carry the upstream call id");

  const partialJson = inputJsonDeltas(first.frames).join("");
  if (!partialJson) throw new Error("the tool call must stream input_json_delta arguments");
  const stop = framesOfType(first.frames, "message_delta").at(-1);
  if (!stop || !stop.delta || stop.delta.stop_reason !== "tool_use") {
    throw new Error(`expected stop_reason tool_use, got ${JSON.stringify(stop)}`);
  }
  if (framesOfType(first.frames, "message_stop").length !== 1) throw new Error("the stream must end with message_stop");

  let parsedInput;
  try {
    parsedInput = JSON.parse(partialJson);
  } catch {
    parsedInput = {};
  }

  // Turn 2 — the tool result (text + base64 image array) must be accepted and
  // the turn must complete.
  const second = await streamGateway(baseUrl, apiKey, {
    model,
    max_tokens: 256,
    system: "You are a terse test assistant.",
    tools,
    messages: [
      { role: "user", content: imageAndPrompt },
      { role: "assistant", content: [{ type: "tool_use", id: toolStart.content_block.id, name: LONG_TOOL_NAME, input: parsedInput }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolStart.content_block.id,
            content: [
              { type: "text", text: "The tool recorded the image." },
              { type: "image", source: { type: "base64", media_type: "image/png", data: visionProbePngBase64 } }
            ]
          }
        ]
      }
    ],
    stream: true
  });
  if (second.status !== 200) throw new Error(`gateway answered HTTP ${second.status}: ${JSON.stringify(second.raw.slice(0, 400))}`);
  if (framesOfType(second.frames, "error").length > 0) {
    throw new Error(`upstream returned an error mid-stream: ${JSON.stringify(framesOfType(second.frames, "error"))}`);
  }
  const stop2 = framesOfType(second.frames, "message_delta").at(-1);
  if (!stop2 || !stop2.delta || !["end_turn", "max_tokens"].includes(stop2.delta.stop_reason)) {
    throw new Error(`expected the turn to complete after the image-bearing tool result, got ${JSON.stringify(stop2)}`);
  }
  if (framesOfType(second.frames, "message_stop").length !== 1) throw new Error("the stream must end with message_stop");

  return { toolUseId: toolStart.content_block.id, argumentsJson: partialJson };
}

async function runLiveChecks() {
  // Imported only when actually running live, so an unset env var truly means
  // "no work, no network, no credential read" — not merely "no assertions".
  const { loadProfile, snapshotForRun } = await import("../agent/settings/profile.js");
  const { VISION_PROBE_PNG_BASE64 } = await import("../agent/settings/capability-test.js");

  const results = [];
  async function check(name, fn) {
    const startedAt = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  PASS  ${name} (${Date.now() - startedAt}ms)`);
    } catch (err) {
      results.push({ name, ok: false, err: err.message });
      console.log(`  FAIL  ${name} (${Date.now() - startedAt}ms) — ${err.message}\n${err.stack}`);
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  console.log("\nLIVE ChatGPT subscription coverage (real backend, real signed-in account)\n");

  const profile = await loadProfile();
  if (!profile || profile.providerType !== "chatgpt" || profile.chatgptSessionState !== "signed_in" || !profile.hasCredential) {
    console.log(
      "No signed-in chatgpt profile is configured (switch a profile's provider type to chatgpt and sign in from the settings page first). Skipping."
    );
    return { passed: 0, total: 0, skipped: true };
  }
  const model = profile.defaultModelId;
  assert(model, "the chatgpt profile has no default model to test");

  await check("the run snapshot points the SDK at the loopback gateway with a gateway token, never a ChatGPT token", async () => {
    const snapshot = await snapshotForRun(profile.profileId, model);
    try {
      assert(Object.keys(snapshot.env).sort().join(",") === "ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL",
        `the SDK environment must carry ONLY the gateway URL and token, got ${JSON.stringify(Object.keys(snapshot.env))}`);
      assert(snapshot.env.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:"), snapshot.env.ANTHROPIC_BASE_URL);
      assert(typeof snapshot.env.ANTHROPIC_API_KEY === "string" && snapshot.env.ANTHROPIC_API_KEY.length >= 43,
        "the gateway token must be a real random token");
      assert(snapshot.model === model, `the snapshot must bind the profile's model, got ${snapshot.model}`);
    } finally {
      snapshot.releaseGatewayToken();
    }
  });

  const snapshot = await snapshotForRun(profile.profileId, model);
  const baseUrl = snapshot.env.ANTHROPIC_BASE_URL;
  const apiKey = snapshot.env.ANTHROPIC_API_KEY;

  await check("one streamed tool round trip with an image, and its image-bearing tool result, both complete", async () => {
    await runStreamedToolRoundTrip({ baseUrl, apiKey, model, visionProbePngBase64: VISION_PROBE_PNG_BASE64 });
  });

  await check("the run token is revoked when the run ends", async () => {
    snapshot.releaseGatewayToken();
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    });
    assert(res.status === 401, `expected HTTP 401 after the run token was released, got ${res.status}`);
    const body = await res.json();
    assert(body.error && body.error.type === "authentication_error", JSON.stringify(body));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
      "\n"
  );
  return { passed: results.length - failed.length, total: results.length, skipped: false };
}

if (!LIVE) {
  console.log(
    "chatgpt-live.test.mjs: skipped (set OCIC_RUN_LIVE_CHATGPT_TESTS=1 with a signed-in chatgpt profile already configured to run this)"
  );
  if (IS_MAIN) process.exit(0);
} else {
  const { passed, total, skipped } = await runLiveChecks();
  if (IS_MAIN && !skipped) process.exit(passed === total ? 0 : 1);
}

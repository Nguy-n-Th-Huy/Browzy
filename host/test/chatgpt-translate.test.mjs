#!/usr/bin/env node
// Coverage for the ChatGPT translator modules (host/agent/chatgpt/
// translate-request.js, translate-stream.js, upstream-errors.js): every
// Anthropic->Codex request mapping and rejection the spec names, the tool
// name shortening round trip, the reasoning-effort rules, the dropped
// sampling fields, the Codex->Anthropic stream fixtures (text, thinking with
// signature, split tool-call argument deltas, incomplete, content filter,
// failed), non-stream/stream parity, the SSE line parser's chunk-boundary
// handling, and the full upstream error mapping table.
//
// Run: node host/test/chatgpt-translate.test.mjs

import {
  ChatGPTTranslationError,
  buildToolNameMap,
  shortenToolName,
  translateAnthropicRequestToCodex
} from "../agent/chatgpt/translate-request.js";
import {
  accumulateNonStreamMessage,
  createCodexStreamState,
  createSSEParser,
  feedCodexEvent,
  serializeAnthropicSSEEvent
} from "../agent/chatgpt/translate-stream.js";
import { mapUpstreamError } from "../agent/chatgpt/upstream-errors.js";

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

function eventsByType(events, type) {
  return events.filter((e) => e.data && e.data.type === type);
}

function blockStarts(events) {
  return eventsByType(events, "content_block_start");
}

// ===========================================================================
// translateAnthropicRequestToCodex
// ===========================================================================

console.log("\n== system -> developer message ==");
{
  const { body } = translateAnthropicRequestToCodex(
    { system: "be helpful", messages: [] },
    { model: "gpt-5.6-terra" }
  );
  ok(body.input[0].type === "message" && body.input[0].role === "developer", "a string system becomes a developer message");
  ok(body.input[0].content[0].type === "input_text" && body.input[0].content[0].text === "be helpful", "carrying the text as input_text");
}
{
  const { body } = translateAnthropicRequestToCodex(
    { system: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }], messages: [] },
    { model: "m" }
  );
  ok(body.input[0].role === "developer" && body.input[0].content.length === 2, "an array system joins every text block into one developer message");
}
{
  const { body } = translateAnthropicRequestToCodex({ system: "", messages: [] }, { model: "m" });
  ok(body.input.length === 0, "an empty system produces no developer message at all");
}

console.log("\n== system-role MESSAGES are remapped to developer (the Codex backend rejects role: \"system\") ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        { role: "user", content: "hello" },
        { role: "system", content: "remember: be terse" },
        { role: "assistant", content: "ok" }
      ]
    },
    { model: "m" }
  );
  ok(
    body.input.every((item) => item.role !== "system"),
    "no input message keeps role \"system\""
  );
  const remapped = body.input.find((item) => item.content && item.content.some((c) => c.text === "remember: be terse"));
  ok(remapped && remapped.role === "developer", "a system-role message becomes a developer message in place");
  ok(
    body.input[0].role === "user" && body.input[body.input.length - 1].role === "assistant",
    "user/assistant roles are untouched and ordering is preserved"
  );
  const { body: body2 } = translateAnthropicRequestToCodex(
    { messages: [{ role: "system", content: [{ type: "text", text: "blocks-form reminder" }] }] },
    { model: "m" }
  );
  ok(
    body2.input[0].role === "developer" && body2.input[0].content[0].text === "blocks-form reminder",
    "the block-content form of a system message also becomes developer text"
  );
}

console.log("\n== user/assistant text ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" }
      ]
    },
    { model: "m" }
  );
  ok(body.input[0].content[0].type === "input_text", "user text becomes input_text");
  ok(body.input[1].content[0].type === "output_text", "assistant text becomes output_text");
}

console.log("\n== images: base64 and URL ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]
        }
      ]
    },
    { model: "m" }
  );
  const block = body.input[0].content[0];
  ok(block.type === "input_image" && block.image_url === "data:image/png;base64,QUJD", "a base64 image becomes a data: URL input_image");
}
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }]
    },
    { model: "m" }
  );
  ok(body.input[0].content[0].image_url === "https://example.com/a.png", "a URL image is forwarded as-is, not dropped (deliberate difference from CLIProxyAPI)");
}

console.log("\n== base64 PDF document ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0" } }]
        }
      ]
    },
    { model: "m" }
  );
  const block = body.input[0].content[0];
  ok(block.type === "input_file" && block.file_data === "data:application/pdf;base64,JVBERi0" && block.filename === "document.pdf", "a base64 PDF becomes input_file with a data: URL and a filename");
}
{
  let threw = null;
  try {
    translateAnthropicRequestToCodex(
      { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "text/plain", data: "eA==" } }] }] },
      { model: "m" }
    );
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof ChatGPTTranslationError && threw.status === 400, "a non-PDF document fails loudly rather than being silently dropped");
}

console.log("\n== unsupported content block => 400 naming the type ==");
{
  let threw = null;
  try {
    translateAnthropicRequestToCodex(
      { messages: [{ role: "user", content: [{ type: "container_upload", foo: 1 }] }] },
      { model: "m" }
    );
  } catch (err) {
    threw = err;
  }
  ok(
    threw instanceof ChatGPTTranslationError && threw.status === 400 && threw.anthropicErrorType === "invalid_request_error" && threw.blockType === "container_upload",
    "an unknown block type throws a 400 invalid_request_error naming exactly that type, and nothing upstream would be sent"
  );
}

console.log("\n== tool_use / tool_result (screenshot scenario) ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "screenshot", input: { region: "full" } }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "captured" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Zm9v" } }
              ]
            }
          ]
        }
      ]
    },
    { model: "m" }
  );
  const functionCall = body.input[0];
  ok(functionCall.type === "function_call" && functionCall.call_id === "call_1", "tool_use becomes function_call with the same id as call_id");
  ok(functionCall.name === "screenshot" && functionCall.arguments === JSON.stringify({ region: "full" }), "name and JSON-serialized input carried through");

  const output = body.input[1];
  ok(output.type === "function_call_output" && output.call_id === "call_1", "tool_result becomes function_call_output on the same call_id");
  ok(
    Array.isArray(output.output) && output.output[0].type === "input_text" && output.output[0].text === "captured" && output.output[1].type === "input_image" && output.output[1].image_url === "data:image/jpeg;base64,Zm9v",
    "output is an input_text item followed by an input_image item with a data:image/jpeg;base64,... URL, in order"
  );
}

console.log("\n== tool_result is_error => leading 'Tool error:' item ==");
{
  const { body } = translateAnthropicRequestToCodex(
    { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", is_error: true, content: "boom" }] }] },
    { model: "m" }
  );
  const output = body.input[0].output;
  ok(
    Array.isArray(output) && output[0].type === "input_text" && output[0].text === "Tool error:" && output[1].text === "boom",
    "a string is_error tool_result gets a leading 'Tool error:' input_text item ahead of the original text"
  );
}
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c2", is_error: true, content: [{ type: "text", text: "nope" }] }]
        }
      ]
    },
    { model: "m" }
  );
  const output = body.input[0].output;
  ok(output[0].text === "Tool error:" && output[1].text === "nope", "an array-content is_error tool_result also gets the leading marker item, ahead of its own items");
}
{
  const { body } = translateAnthropicRequestToCodex(
    { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c3", content: "fine" }] }] },
    { model: "m" }
  );
  ok(body.input[0].output === "fine", "a non-error string tool_result stays a plain string output, not wrapped in an array");
}

console.log("\n== thinking: gateway signature round trip, other signatures omitted ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "reasoning...", signature: "brzcx1.abc123" }] }
      ]
    },
    { model: "m" }
  );
  ok(body.input[0].type === "reasoning" && body.input[0].encrypted_content === "abc123", "a gateway-issued (brzcx1.) signature becomes a reasoning item carrying the stripped encrypted content");
}
{
  const { body } = translateAnthropicRequestToCodex(
    { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "someoneelse.xyz" }] }] },
    { model: "m" }
  );
  ok(body.input.length === 0, "a thinking block signed by anyone else is omitted, never replayed upstream as this gateway's own");
}
{
  const { body } = translateAnthropicRequestToCodex(
    { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] }] },
    { model: "m" }
  );
  ok(body.input.length === 0, "redacted_thinking is always omitted");
}

console.log("\n== cache_control is stripped ==");
{
  const { body } = translateAnthropicRequestToCodex(
    { messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] },
    { model: "m" }
  );
  ok(JSON.stringify(body).includes("cache_control") === false, "cache_control never appears anywhere in the translated body");
}

console.log("\n== dropped sampling fields ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      max_tokens: 1024,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ["END"],
      metadata: { user_id: "u1" },
      messages: [{ role: "user", content: "hi" }]
    },
    { model: "m" }
  );
  const keys = Object.keys(body);
  for (const forbidden of ["max_tokens", "max_output_tokens", "temperature", "top_p", "stop", "previous_response_id", "metadata", "user"]) {
    ok(!keys.includes(forbidden), `${forbidden} never reaches the upstream body`);
  }
}

console.log("\n== upstream body allowlist ==");
{
  const { body } = translateAnthropicRequestToCodex(
    { messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", input_schema: { type: "object" } }] },
    { model: "gpt-5.6-terra", promptCacheKey: "conv-1" }
  );
  const allowed = new Set([
    "model",
    "instructions",
    "input",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "store",
    "stream",
    "include",
    "prompt_cache_key"
  ]);
  ok(Object.keys(body).every((k) => allowed.has(k)), "every top-level key in the built body is on the allowlist");
  ok(body.model === "gpt-5.6-terra" && body.instructions === "" && body.store === false && body.stream === true, "model/instructions/store/stream are exactly what the spec requires");
  ok(Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content"), "include carries reasoning.encrypted_content");
  ok(body.prompt_cache_key === "conv-1", "prompt_cache_key is copied through verbatim");
}
{
  const { body } = translateAnthropicRequestToCodex({ messages: [{ role: "user", content: "hi" }] }, { model: "m" });
  ok(!("tools" in body) && !("tool_choice" in body), "tools/tool_choice are omitted entirely when the request has no tools");
}

console.log("\n== tool name shortening round trip ==");
{
  const longName = "x".repeat(80);
  const map = buildToolNameMap([longName]);
  const short = map.get(longName);
  ok(short.length <= 64, "an 80-character name is shortened to at most 64 characters");
  ok(short.startsWith("x".repeat(58) + "_"), "the shortened name keeps the first 58 characters plus an underscore");
  ok(shortenToolName(longName, map) === short, "shortenToolName resolves the same value from the map");

  const { body, toolNameMap } = translateAnthropicRequestToCodex(
    {
      tools: [{ name: longName, input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: longName, input: {} }] }]
    },
    { model: "m" }
  );
  ok(body.tools[0].name === short && body.tools[0].name.length <= 64, "the tool declaration itself uses the shortened name");
  ok(body.input[0].name === short, "the tool_use -> function_call also uses the shortened name");
  ok(toolNameMap.get(longName) === short, "the returned toolNameMap records the same mapping used to build the body");

  // Restoring it is translate-stream's job (reverse map); exercised below in the streamed tool-call scenario.
}
{
  // Two distinct names, engineered (by brute force, not by construction) to
  // share both their first 58 characters and their 5-character SHA-256
  // prefix, so their shortened candidates would otherwise be byte-for-byte
  // identical. buildToolNameMap must still disambiguate them with a suffix.
  const nameA = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy_000050";
  const nameB = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy_00007b";
  const bareCandidate = shortenToolName(nameA, undefined);
  ok(shortenToolName(nameB, undefined) === bareCandidate, "sanity check: the two names really do produce an identical bare candidate outside a map");

  const map = buildToolNameMap([nameA, nameB]);
  const shortA = map.get(nameA);
  const shortB = map.get(nameB);
  ok(shortA === bareCandidate, "the first name to claim the candidate keeps it unchanged");
  ok(shortB !== shortA && shortB.length <= 64, "the second name gets a distinct, still <=64-character, collision-suffixed name");
}

console.log("\n== tool_choice mapping ==");
{
  const tools = [{ name: "search", input_schema: { type: "object" } }];
  const cases = [
    [undefined, "auto"],
    [{ type: "auto" }, "auto"],
    [{ type: "any" }, "required"],
    [{ type: "none" }, "none"]
  ];
  for (const [choice, expected] of cases) {
    const { body } = translateAnthropicRequestToCodex({ tools, tool_choice: choice, messages: [] }, { model: "m" });
    ok(body.tool_choice === expected, `tool_choice ${JSON.stringify(choice)} maps to ${JSON.stringify(expected)}`);
  }
  {
    const { body } = translateAnthropicRequestToCodex({ tools, tool_choice: { type: "tool", name: "search" }, messages: [] }, { model: "m" });
    ok(body.tool_choice.type === "function" && body.tool_choice.name === "search", "a named tool_choice maps to {type:'function', name}");
  }
}

console.log("\n== web_search server tool ==");
{
  const { body } = translateAnthropicRequestToCodex(
    { tools: [{ type: "web_search_20250305", name: "web_search" }], messages: [] },
    { model: "m" }
  );
  ok(JSON.stringify(body.tools[0]) === JSON.stringify({ type: "web_search" }), "the web-search server tool becomes exactly {type:'web_search'}");
}
{
  const { body } = translateAnthropicRequestToCodex(
    {
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: []
    },
    { model: "m" }
  );
  ok(body.tool_choice.type === "web_search", "tool_choice naming the web-search tool also maps to {type:'web_search'}");
}

console.log("\n== disable_parallel_tool_use ==");
{
  const tools = [{ name: "t", input_schema: { type: "object" } }];
  const a = translateAnthropicRequestToCodex({ tools, messages: [] }, { model: "m" });
  ok(a.body.parallel_tool_calls === true, "parallel_tool_calls defaults to true");
  const b = translateAnthropicRequestToCodex({ tools, tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages: [] }, { model: "m" });
  ok(b.body.parallel_tool_calls === false, "disable_parallel_tool_use:true maps to parallel_tool_calls:false");
}

console.log("\n== function tool schema: strict:false, $schema/$id stripped ==");
{
  const { body } = translateAnthropicRequestToCodex(
    {
      tools: [{ name: "t", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", $id: "x", type: "object", properties: { a: { type: "string" } } } }],
      messages: []
    },
    { model: "m" }
  );
  const tool = body.tools[0];
  ok(tool.strict === false, "function tools are always strict:false");
  ok(!("$schema" in tool.parameters) && !("$id" in tool.parameters), "$schema and $id are stripped from parameters");
  ok(tool.parameters.properties.a.type === "string", "the rest of the schema is preserved");
}

console.log("\n== reasoning effort rules ==");
{
  const cases = [
    [{ output_config: { effort: "HIGH" } }, "high"],
    [{ thinking: { type: "enabled", budget_tokens: 3999 } }, "low"],
    [{ thinking: { type: "enabled", budget_tokens: 4000 } }, "medium"],
    [{ thinking: { type: "enabled", budget_tokens: 15999 } }, "medium"],
    [{ thinking: { type: "enabled", budget_tokens: 16000 } }, "high"],
    [{}, "medium"],
    [{ thinking: { type: "disabled" } }, "medium"]
  ];
  for (const [extra, expected] of cases) {
    const { body } = translateAnthropicRequestToCodex({ ...extra, messages: [] }, { model: "m" });
    ok(body.reasoning.effort === expected, `${JSON.stringify(extra)} -> effort ${expected}`);
    ok(body.reasoning.summary === "auto", "summary is always 'auto'");
  }
}

// ===========================================================================
// SSE line parser
// ===========================================================================

console.log("\n== SSE line parser ==");
{
  const parser = createSSEParser();
  const frames = parser.push('event: message\ndata: {"a":1}\n\n');
  ok(frames.length === 1 && frames[0].event === "message" && frames[0].data === '{"a":1}', "a single complete frame in one chunk parses cleanly");
}
{
  const parser = createSSEParser();
  const frames = parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
  ok(frames.length === 2 && frames[0].data === '{"a":1}' && frames[1].data === '{"b":2}', "two frames in one chunk both parse, in order");
  ok(frames[0].event === "message", "a frame with no explicit event: line defaults to 'message'");
}
{
  const parser = createSSEParser();
  const whole = 'data: {"line1":true}\ndata: {"line2":true}\n\n';
  ok(parser.push(whole.slice(0, 10)).length === 0, "a chunk that ends mid-line yields no frame yet");
  const rest = parser.push(whole.slice(10));
  ok(rest.length === 1 && rest[0].data === '{"line1":true}\n{"line2":true}', "multi-line data: fields join with \\n once the frame completes, even split across chunks");
}
{
  const parser = createSSEParser();
  // Split in the middle of a multi-byte UTF-8 character (é = 0xC3 0xA9).
  const text = 'data: {"t":"café"}\n\n';
  const bytes = Buffer.from(text, "utf8");
  const mid = 12;
  const frames = [...parser.push(bytes.subarray(0, mid)), ...parser.push(bytes.subarray(mid))];
  ok(frames.length === 1 && JSON.parse(frames[0].data).t === "café", "a chunk boundary inside a multi-byte character still reassembles correctly");
}
{
  const parser = createSSEParser();
  const frames = parser.push(": this is a comment\nevent: ping\ndata: {}\n\n");
  ok(frames.length === 1 && frames[0].event === "ping", "comment lines are ignored, event: lines are honoured");
}

console.log("\n== SSE serializer ==");
{
  const wire = serializeAnthropicSSEEvent("message_stop", { type: "message_stop" });
  ok(wire === 'event: message_stop\ndata: {"type":"message_stop"}\n\n', "serializes to event:/data: lines terminated by a blank line");
}

// ===========================================================================
// Codex -> Anthropic stream state machine
// ===========================================================================

console.log("\n== stream: text ==");
{
  const state = createCodexStreamState();
  const all = [];
  const feed = (data) => all.push(...feedCodexEvent(state, { data }));

  feed({ type: "response.created", response: { id: "resp_1", model: "gpt-5.6-terra" } });
  feed({ type: "response.output_text.delta", delta: "Hello" });
  feed({ type: "response.output_text.delta", delta: ", world" });
  feed({
    type: "response.completed",
    response: { id: "resp_1", model: "gpt-5.6-terra", output: [], usage: { input_tokens: 10, output_tokens: 5 } }
  });

  ok(all[0].event === "message_start" && all[0].data.message.id === "resp_1", "message_start carries the response id");
  const starts = blockStarts(all);
  ok(starts.length === 1 && starts[0].data.content_block.type === "text", "exactly one text content block is opened");
  const deltas = eventsByType(all, "content_block_delta").filter((e) => e.data.delta.type === "text_delta");
  ok(deltas.map((d) => d.data.delta.text).join("") === "Hello, world", "text deltas concatenate to the full text");
  ok(eventsByType(all, "content_block_stop").length === 1, "the text block is closed exactly once");
  const delta = eventsByType(all, "message_delta")[0];
  ok(delta.data.delta.stop_reason === "end_turn", "a plain completed response with no tool call stops at end_turn");
  ok(delta.data.usage.input_tokens === 10 && delta.data.usage.output_tokens === 5, "usage is reported from response.usage");
  ok(eventsByType(all, "message_stop").length === 1, "message_stop is emitted once, last");
}

console.log("\n== stream: thinking + signature ==");
{
  const state = createCodexStreamState();
  const all = [];
  const feed = (data) => all.push(...feedCodexEvent(state, { data }));

  feed({ type: "response.created", response: { id: "r2", model: "m" } });
  feed({ type: "response.reasoning_summary_part.added" });
  feed({ type: "response.reasoning_summary_text.delta", delta: "thinking step one" });
  feed({ type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "opaque-blob" } });
  feed({ type: "response.output_text.delta", delta: "answer" });
  feed({ type: "response.completed", response: { id: "r2", model: "m", output: [], usage: {} } });

  const thinkingStart = blockStarts(all).find((e) => e.data.content_block.type === "thinking");
  ok(Boolean(thinkingStart), "a thinking content block is opened");
  const thinkingDelta = eventsByType(all, "content_block_delta").find((e) => e.data.delta.type === "thinking_delta");
  ok(thinkingDelta && thinkingDelta.data.delta.thinking === "thinking step one", "thinking_delta carries the reasoning summary text");
  const sigDelta = eventsByType(all, "content_block_delta").find((e) => e.data.delta.type === "signature_delta");
  ok(sigDelta && sigDelta.data.delta.signature === "brzcx1.opaque-blob", "the closing signature_delta wraps the reasoning item's encrypted_content behind the brzcx1. prefix");

  const textStart = blockStarts(all).find((e) => e.data.content_block.type === "text");
  ok(thinkingStart.data.index < textStart.data.index, "the thinking block is closed and indexed before the text block opens");
}

console.log("\n== stream: tool call with split argument deltas + name restored ==");
{
  const longName = "z".repeat(80);
  const { toolNameMap } = translateAnthropicRequestToCodex(
    { tools: [{ name: longName, input_schema: { type: "object" } }], messages: [] },
    { model: "m" }
  );
  const shortName = toolNameMap.get(longName);

  const state = createCodexStreamState({ toolNameMap });
  const all = [];
  const feed = (data) => all.push(...feedCodexEvent(state, { data }));

  feed({ type: "response.created", response: { id: "r3", model: "m" } });
  feed({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", call_id: "call_9", name: shortName }
  });
  feed({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"re' });
  feed({ type: "response.function_call_arguments.delta", output_index: 0, delta: 'gion":' });
  feed({ type: "response.function_call_arguments.delta", output_index: 0, delta: '"full"}' });
  feed({
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", call_id: "call_9", name: shortName, arguments: '{"region":"full"}' }
  });
  feed({
    type: "response.completed",
    response: { id: "r3", model: "m", output: [], usage: {} }
  });

  const toolStart = blockStarts(all).find((e) => e.data.content_block.type === "tool_use");
  ok(Boolean(toolStart), "a tool_use content block is opened");
  ok(toolStart.data.content_block.name === longName, "the client receives the original (unshortened) tool name, restored via the reverse map");
  ok(toolStart.data.content_block.id === "call_9", "the tool_use id is the call_id");

  const argDeltas = eventsByType(all, "content_block_delta").filter((e) => e.data.delta.type === "input_json_delta");
  ok(argDeltas.map((d) => d.data.delta.partial_json).join("") === '{"region":"full"}', "concatenating every input_json_delta reproduces the full arguments JSON");

  ok(eventsByType(all, "content_block_stop").some((e) => e.data.index === toolStart.data.index), "the tool_use block is closed");
  const delta = eventsByType(all, "message_delta")[0];
  ok(delta.data.delta.stop_reason === "tool_use", "emitting any function call forces stop_reason tool_use");
}

console.log("\n== stream: incomplete (max_output_tokens) ==");
{
  const state = createCodexStreamState();
  const all = [];
  feedCodexEvent(state, { data: { type: "response.created", response: { id: "r4", model: "m" } } });
  all.push(
    ...feedCodexEvent(state, {
      data: {
        type: "response.incomplete",
        response: { id: "r4", model: "m", output: [], incomplete_details: { reason: "max_output_tokens" }, usage: {} }
      }
    })
  );
  const delta = eventsByType(all, "message_delta")[0];
  ok(delta.data.delta.stop_reason === "max_tokens", "an incomplete response with reason max_output_tokens maps to stop_reason max_tokens");
}

console.log("\n== stream: content_filter => refusal ==");
{
  const state = createCodexStreamState();
  const all = [];
  feedCodexEvent(state, { data: { type: "response.created", response: { id: "r5", model: "m" } } });
  all.push(
    ...feedCodexEvent(state, {
      data: {
        type: "response.incomplete",
        response: { id: "r5", model: "m", output: [], incomplete_details: { reason: "content_filter" }, usage: {} }
      }
    })
  );
  const delta = eventsByType(all, "message_delta")[0];
  ok(delta.data.delta.stop_reason === "refusal", "reason content_filter maps to stop_reason refusal");
}

console.log("\n== stream: failed / error events become Anthropic error events ==");
{
  const state = createCodexStreamState();
  const events = feedCodexEvent(state, { data: { type: "error", error: { type: "authentication_error", message: "bad token" } } });
  ok(events.length === 1 && events[0].event === "error" && events[0].data.error.type === "authentication_error", "an 'error' event becomes an Anthropic error event with the mapped type");
}
{
  const state = createCodexStreamState();
  const events = feedCodexEvent(state, {
    data: { type: "response.failed", response: { error: { type: "usage_limit_reached", resets_in_seconds: 60 } } }
  });
  ok(events.length === 1 && events[0].event === "error" && events[0].data.error.type === "rate_limit_error", "a response.failed usage_limit_reached becomes a rate_limit_error Anthropic error event");
}

console.log("\n== stream: cache_read_input_tokens usage ==");
{
  const state = createCodexStreamState();
  feedCodexEvent(state, { data: { type: "response.created", response: { id: "r6", model: "m" } } });
  const events = feedCodexEvent(state, {
    data: {
      type: "response.completed",
      response: {
        id: "r6",
        model: "m",
        output: [],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } }
      }
    }
  });
  const delta = eventsByType(events, "message_delta")[0];
  ok(delta.data.usage.input_tokens === 60, "cached tokens are subtracted out of input_tokens");
  ok(delta.data.usage.cache_read_input_tokens === 40, "cache_read_input_tokens reports the cached count separately");
}

// ===========================================================================
// Non-stream parity
// ===========================================================================

console.log("\n== non-stream accumulator: text, parity with stream ==");
{
  const frames = [
    { data: { type: "response.created", response: { id: "r7", model: "m" } } },
    { data: { type: "response.output_text.delta", delta: "hi" } },
    {
      data: {
        type: "response.completed",
        response: {
          id: "r7",
          model: "m",
          output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
          usage: { input_tokens: 3, output_tokens: 1 }
        }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames);
  ok("message" in result, "a normal completed turn returns { message }");
  ok(result.message.content[0].type === "text" && result.message.content[0].text === "hi", "the non-stream message carries the same text the stream would have delivered");
  ok(result.message.stop_reason === "end_turn", "same stop_reason rule as the stream path");
  ok(result.message.usage.input_tokens === 3 && result.message.usage.output_tokens === 1, "same usage shape as the stream path");
}

console.log("\n== non-stream accumulator: tool call with restored name ==");
{
  const longName = "w".repeat(70);
  const { toolNameMap } = translateAnthropicRequestToCodex(
    { tools: [{ name: longName, input_schema: { type: "object" } }], messages: [] },
    { model: "m" }
  );
  const shortName = toolNameMap.get(longName);
  const frames = [
    {
      data: {
        type: "response.completed",
        response: {
          id: "r8",
          model: "m",
          output: [{ type: "function_call", call_id: "c1", name: shortName, arguments: '{"x":1}' }],
          usage: {}
        }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames, { toolNameMap });
  const block = result.message.content[0];
  ok(block.type === "tool_use" && block.name === longName && block.id === "c1", "the reconstructed tool_use restores the original long name");
  ok(block.input.x === 1, "arguments JSON is parsed back into the input object");
  ok(result.message.stop_reason === "tool_use", "a tool call in the output forces stop_reason tool_use in the non-stream path too");
}

console.log("\n== non-stream accumulator: reasoning with signature ==");
{
  const frames = [
    {
      data: {
        type: "response.completed",
        response: {
          id: "r9",
          model: "m",
          output: [{ type: "reasoning", summary: [{ text: "because" }], encrypted_content: "blob" }],
          usage: {}
        }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames);
  const block = result.message.content[0];
  ok(block.type === "thinking" && block.thinking === "because" && block.signature === "brzcx1.blob", "the non-stream thinking block carries the same brzcx1.-prefixed signature the stream path would emit");
}

console.log("\n== non-stream accumulator: empty completed output falls back to output_item.done items ==");
{
  // Real upstream shape: response.completed's response.output is an empty
  // array even though the turn delivered one message item via
  // response.output_item.done.
  const frames = [
    { data: { type: "response.created", response: { id: "r10", model: "m" } } },
    { data: { type: "response.output_text.delta", delta: "hi" } },
    { data: { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "hi" }] } } },
    {
      data: {
        type: "response.completed",
        response: { id: "r10", model: "m", output: [], usage: { input_tokens: 3, output_tokens: 1 } }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames);
  ok("message" in result, "a completed turn with an empty terminal output still returns { message }");
  ok(result.message.content.length === 1 && result.message.content[0].type === "text" && result.message.content[0].text === "hi", "the message item delivered via output_item.done becomes the text block, even though response.output was empty");
  ok(result.message.stop_reason === "end_turn", "stop_reason is still computed correctly from the (empty-output) terminal response");
}

console.log("\n== non-stream accumulator: reasoning + message via output_item.done, empty completed output ==");
{
  const frames = [
    { data: { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ text: "because" }], encrypted_content: "blob" } } },
    { data: { type: "response.output_item.done", output_index: 1, item: { type: "message", content: [{ type: "output_text", text: "answer" }] } } },
    {
      data: {
        type: "response.completed",
        response: { id: "r11", model: "m", output: [], usage: {} }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames);
  ok(result.message.content.length === 2, "both the reasoning and message items surface as content blocks");
  ok(result.message.content[0].type === "thinking" && result.message.content[0].thinking === "because" && result.message.content[0].signature === "brzcx1.blob", "the reasoning item becomes a thinking block with its signature, sourced from output_item.done");
  ok(result.message.content[1].type === "text" && result.message.content[1].text === "answer", "the message item becomes a text block, in arrival order after the reasoning block");
}

console.log("\n== non-stream accumulator: function_call via output_item.done, empty completed output ==");
{
  const longName = "v".repeat(70);
  const { toolNameMap } = translateAnthropicRequestToCodex(
    { tools: [{ name: longName, input_schema: { type: "object" } }], messages: [] },
    { model: "m" }
  );
  const shortName = toolNameMap.get(longName);
  const frames = [
    { data: { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "c9", name: shortName, arguments: '{"q":"weather"}' } } },
    {
      data: {
        type: "response.completed",
        response: { id: "r12", model: "m", output: [], usage: {} }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames, { toolNameMap });
  const block = result.message.content[0];
  ok(block.type === "tool_use" && block.name === longName && block.id === "c9", "a function_call delivered only via output_item.done (empty terminal output) still becomes a tool_use block with the restored name");
  ok(block.input.q === "weather", "its arguments are parsed the same way as the non-empty-output path");
  ok(result.message.stop_reason === "tool_use", "stop_reason is tool_use even though the terminal response.output was empty");
}

console.log("\n== non-stream accumulator: non-empty completed output still wins over output_item.done ==");
{
  // If the terminal event ever DOES carry a non-empty output (current/other
  // upstream behavior), it must still be used as-is rather than the
  // output_item.done collection — output_item.done here deliberately
  // disagrees with the terminal output to prove precedence.
  const frames = [
    { data: { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "stale" }] } } },
    {
      data: {
        type: "response.completed",
        response: {
          id: "r13",
          model: "m",
          output: [{ type: "message", content: [{ type: "output_text", text: "authoritative" }] }],
          usage: {}
        }
      }
    }
  ];
  const result = accumulateNonStreamMessage(frames);
  ok(result.message.content.length === 1 && result.message.content[0].text === "authoritative", "a non-empty terminal response.output is used verbatim, ignoring the (disagreeing) output_item.done collection");
}

console.log("\n== non-stream accumulator: failed/error terminal ==");
{
  const frames = [{ data: { type: "error", error: { type: "authentication_error", message: "no" } } }];
  const result = accumulateNonStreamMessage(frames);
  ok("error" in result && result.error.status === 401, "a terminal error frame surfaces through the same mapUpstreamError table, not a fabricated message");
}
{
  let threw = null;
  try {
    accumulateNonStreamMessage([{ data: { type: "response.created", response: {} } }]);
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error, "frames with no terminal event at all throw rather than silently returning nothing");
}

// ===========================================================================
// Upstream error mapping table
// ===========================================================================

console.log("\n== upstream error mapping: full table ==");
{
  const r = mapUpstreamError({ httpStatus: 401, body: { error: { message: "invalid_grant" } } });
  ok(r.status === 401 && r.anthropicErrorBody.error.type === "authentication_error", "401 -> authentication_error");
  ok(r.authFailed === true && r.sessionExpired === true, "401 flags the caller that the session should be treated as expired");
}
{
  const r = mapUpstreamError({ httpStatus: 429, body: { error: { type: "usage_limit_reached", resets_in_seconds: 1800 } } });
  ok(r.status === 429 && r.anthropicErrorBody.error.type === "rate_limit_error", "usage_limit_reached -> 429 rate_limit_error");
  ok(r.headers["retry-after"] === "1800", "retry-after comes from resets_in_seconds");
  ok(r.anthropicErrorBody.error.message.toLowerCase().includes("usage limit"), "the message names the ChatGPT usage limit");
}
{
  const fixedNow = () => new Date(1_000_000 * 1000);
  const r = mapUpstreamError(
    { httpStatus: 429, body: { error: { type: "usage_limit_reached", resets_at: 1_000_900 } } },
    { now: fixedNow }
  );
  ok(r.headers["retry-after"] === "900", "retry-after is computed from resets_at relative to the injected clock");
}
{
  const r = mapUpstreamError({ httpStatus: 429, body: { error: { message: "slow down" } } });
  ok(r.status === 429 && r.anthropicErrorBody.error.type === "rate_limit_error" && !("retry-after" in r.headers), "a plain 429 (not usage_limit_reached) is still rate_limit_error, with no retry-after fabricated");
}
{
  const r = mapUpstreamError({ httpStatus: 400, body: { error: { code: "context_length_exceeded", message: "too big" } } });
  ok(r.status === 400 && r.anthropicErrorBody.error.message.includes("prompt is too long"), "context_length_exceeded -> 400 whose message contains 'prompt is too long'");
}
{
  const r = mapUpstreamError({ httpStatus: 400, body: { error: { message: "the request exceeds the model's context window" } } });
  ok(r.status === 400 && r.anthropicErrorBody.error.message.includes("prompt is too long"), "context-length detected from message text alone also maps correctly");
}
{
  const r = mapUpstreamError({ httpStatus: 404, body: { error: { message: "model not found" } } });
  ok(r.status === 400 && r.anthropicErrorBody.error.type === "invalid_request_error" && r.anthropicErrorBody.error.message === "model not found", "other 4xx -> 400 invalid_request_error carrying the upstream message verbatim");
}
{
  const r = mapUpstreamError({ httpStatus: 503, body: { error: { message: "down for maintenance" } } });
  ok(r.status === 529 && r.anthropicErrorBody.error.type === "overloaded_error", "5xx -> 529 overloaded_error");
}
{
  const r = mapUpstreamError({ httpStatus: 429, body: { error: { message: "the model is at capacity, please retry" } } });
  ok(r.status === 529, "a capacity message overrides even a 429 status to 529 overloaded_error");
}
{
  const r = mapUpstreamError({ networkError: true, message: "ECONNRESET" });
  ok(r.status === 502 && r.anthropicErrorBody.error.type === "api_error", "a network failure -> 502 api_error");
}
{
  const r = mapUpstreamError({ streamEventType: "error", streamEventBody: { type: "error", error: { type: "authentication_error", message: "expired" } } });
  ok(r.status === 401 && r.authFailed === true, "an in-stream (200 OK) 'error' event with error.type authentication_error is still classified as 401");
}
{
  const r = mapUpstreamError({
    streamEventType: "response.failed",
    streamEventBody: { type: "response.failed", response: { error: { type: "usage_limit_reached", resets_in_seconds: 30 } } }
  });
  ok(r.status === 429 && r.headers["retry-after"] === "30", "an in-stream response.failed usage_limit_reached is classified the same as an out-of-band 429");
}
{
  const r = mapUpstreamError({ streamEventType: "response.failed", streamEventBody: { type: "response.failed", response: { error: { message: "context length exceeded" } } } });
  ok(r.status === 400 && r.anthropicErrorBody.error.message.includes("prompt is too long"), "an in-stream context-length failure maps the same way as an HTTP-level one");
}
{
  // The guarantee here is structural, not incidental: mapUpstreamError's
  // input shape (httpStatus/body, streamEventType/streamEventBody,
  // networkError/message) never carries an Authorization header or token,
  // so there is no field it could copy one out of. This just documents that
  // the module's only string inputs (the upstream error message) pass
  // through untouched, never augmented with anything from elsewhere.
  const r = mapUpstreamError({ httpStatus: 400, body: { error: { message: "harmless upstream message" } } });
  ok(r.anthropicErrorBody.error.message === "harmless upstream message", "the mapped message is exactly the upstream message, nothing appended or substituted from elsewhere");
}

console.log(fail === 0 ? "\nALL CHATGPT TRANSLATE TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);

// Codex `responses` SSE stream -> Anthropic Messages SSE stream, plus a
// non-stream accumulator built on the same event shapes. Pure module: no I/O,
// no network. Also exports a generic SSE line parser and an Anthropic SSE
// serializer, so the gateway (a later batch) can wire
// `bytes -> parser -> JSON.parse -> state machine -> serializer -> bytes`
// without re-implementing framing.
//
// Ported (event sequencing and stop-reason/usage mapping only, not the
// wire-cloaking bits) from router-for-me/CLIProxyAPI @ ac02da6 (MIT),
// internal/translator/codex/claude/codex_claude_response.go.

import { mapUpstreamError } from "./upstream-errors.js";

// Kept identical to translate-request.js's constant (duplicated rather than
// imported, so this module has no dependency beyond upstream-errors.js).
const REASONING_SIGNATURE_PREFIX = "brzcx1.";

// ---------------------------------------------------------------------------
// SSE line parser (bytes/text chunks -> {event, data} frames)
// ---------------------------------------------------------------------------

/**
 * A minimal, spec-shaped Server-Sent-Events parser: `event:`/`data:` fields,
 * `:`-prefixed comments and `id:`/`retry:` ignored, multi-line `data:`
 * joined with `\n`, one frame emitted per blank-line-terminated block. Feed
 * it chunks as they arrive (a chunk may split a line, or even a multi-byte
 * UTF-8 character, in half) and it holds the remainder until the next push.
 *
 * @returns {{ push(chunk: string | Uint8Array): Array<{ event: string, data: string }> }}
 */
export function createSSEParser() {
  let buffer = "";
  let eventName;
  let dataLines = [];
  let sawAnyField = false;

  const resetFrame = () => {
    eventName = undefined;
    dataLines = [];
    sawAnyField = false;
  };
  resetFrame();

  function push(chunk) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const frames = [];
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        if (sawAnyField) frames.push({ event: eventName || "message", data: dataLines.join("\n") });
        resetFrame();
        continue;
      }
      if (line.startsWith(":")) continue; // comment line

      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") {
        eventName = value;
        sawAnyField = true;
      } else if (field === "data") {
        dataLines.push(value);
        sawAnyField = true;
      }
      // id / retry / anything else: not needed by this gateway, ignored.
    }
    return frames;
  }

  return { push };
}

/** Serialize one Anthropic SSE event: `event: <name>\ndata: <json>\n\n`. */
export function serializeAnthropicSSEEvent(eventName, data) {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Codex -> Anthropic stream state machine
// ---------------------------------------------------------------------------

/**
 * @param {{ toolNameMap?: Map<string, string> }} [options] The map returned
 *   by `translateAnthropicRequestToCodex` for this same request/turn, so a
 *   `function_call` naming a shortened tool can restore the caller's
 *   original (possibly >64 character) name.
 */
export function createCodexStreamState({ toolNameMap } = {}) {
  const reverseToolNameMap = new Map();
  if (toolNameMap) {
    for (const [original, short] of toolNameMap.entries()) reverseToolNameMap.set(short, original);
  }
  return {
    blockIndex: 0,
    textBlockOpen: false,
    hasTextDelta: false,
    thinkingBlockOpen: false,
    thinkingSignature: "",
    thinkingSummarySeen: false,
    hasEmittedToolUse: false,
    functionCalls: new Map(), // correlation key -> call record
    functionCallQueue: [],
    activeFunctionCall: null,
    reverseToolNameMap
  };
}

function newCallRecord() {
  return {
    callId: "",
    name: "",
    blockIndex: -1,
    arguments: "",
    emittedLength: 0,
    hasDelta: false,
    started: false,
    done: false,
    closed: false
  };
}

function callKeys(codexEvent) {
  const keys = [];
  const item = codexEvent.item;
  if (codexEvent.output_index !== undefined) keys.push(`output:${codexEvent.output_index}`);
  if (item && item.call_id) keys.push(`call:${item.call_id}`);
  if (codexEvent.call_id) keys.push(`call:${codexEvent.call_id}`);
  if (item && item.id) keys.push(`item:${item.id}`);
  if (codexEvent.item_id) keys.push(`item:${codexEvent.item_id}`);
  return keys;
}

function findCall(state, keys) {
  for (const key of keys) {
    const call = state.functionCalls.get(key);
    if (call) return call;
  }
  return null;
}

function recordAliases(state, call, keys) {
  for (const key of keys) state.functionCalls.set(key, call);
}

function getOrCreateCall(state, codexEvent) {
  const keys = callKeys(codexEvent);
  let call = findCall(state, keys);
  if (!call) {
    call = newCallRecord();
    state.functionCallQueue.push(call);
  }
  recordAliases(state, call, keys);
  return call;
}

function updateArguments(call, args, isDelta) {
  if (!call || !args) return;
  if (isDelta) {
    call.arguments += args;
    call.hasDelta = true;
    return;
  }
  if (!call.hasDelta) {
    call.arguments = args;
    return;
  }
  if (args.startsWith(call.arguments)) call.arguments = args;
}

function emit(events, name, data) {
  events.push({ event: name, data });
}

function startTextBlock(state, events) {
  if (state.textBlockOpen) return;
  emit(events, "content_block_start", {
    type: "content_block_start",
    index: state.blockIndex,
    content_block: { type: "text", text: "" }
  });
  state.textBlockOpen = true;
}

function stopTextBlock(state, events) {
  if (!state.textBlockOpen) return;
  emit(events, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
  state.textBlockOpen = false;
  state.blockIndex += 1;
}

function startThinkingBlock(state, events) {
  if (state.thinkingBlockOpen) return;
  emit(events, "content_block_start", {
    type: "content_block_start",
    index: state.blockIndex,
    content_block: { type: "thinking", thinking: "" }
  });
  state.thinkingBlockOpen = true;
}

function appendThinkingDelta(state, events, text) {
  if (!text) return;
  emit(events, "content_block_delta", {
    type: "content_block_delta",
    index: state.blockIndex,
    delta: { type: "thinking_delta", thinking: text }
  });
}

function finalizeThinkingBlock(state, events) {
  if (!state.thinkingBlockOpen) return;
  if (state.thinkingSignature) {
    emit(events, "content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "signature_delta", signature: state.thinkingSignature }
    });
  }
  emit(events, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
  state.blockIndex += 1;
  state.thinkingBlockOpen = false;
}

function signatureFor(encryptedContent) {
  return encryptedContent ? REASONING_SIGNATURE_PREFIX + encryptedContent : "";
}

function appendFunctionCallStart(state, events, call) {
  const name = state.reverseToolNameMap.get(call.name) || call.name;
  emit(events, "content_block_start", {
    type: "content_block_start",
    index: call.blockIndex,
    content_block: { type: "tool_use", id: call.callId, name, input: {} }
  });
}

function appendFunctionCallDelta(events, call, partialJson) {
  emit(events, "content_block_delta", {
    type: "content_block_delta",
    index: call.blockIndex,
    delta: { type: "input_json_delta", partial_json: partialJson }
  });
}

function appendFunctionCallStop(events, call) {
  emit(events, "content_block_stop", { type: "content_block_stop", index: call.blockIndex });
}

function flushBufferedArguments(state, events, call) {
  if (state.activeFunctionCall !== call || !call.started || call.closed) return;
  if (call.emittedLength >= call.arguments.length) return;
  appendFunctionCallDelta(events, call, call.arguments.slice(call.emittedLength));
  call.emittedLength = call.arguments.length;
}

function drainFunctionCallQueue(state, events) {
  for (;;) {
    const active = state.activeFunctionCall;
    if (active) {
      flushBufferedArguments(state, events, active);
      if (!active.done) return;
      appendFunctionCallStop(events, active);
      if (state.blockIndex <= active.blockIndex) state.blockIndex = active.blockIndex + 1;
      active.closed = true;
      state.activeFunctionCall = null;
      const idx = state.functionCallQueue.indexOf(active);
      if (idx !== -1) state.functionCallQueue.splice(idx, 1);
    }

    while (state.functionCallQueue.length > 0 && state.functionCallQueue[0].closed) {
      state.functionCallQueue.shift();
    }
    if (state.functionCallQueue.length === 0) return;

    const next = state.functionCallQueue[0];
    if (!next.name) return; // wait until upstream has told us the tool name

    next.blockIndex = state.blockIndex;
    appendFunctionCallStart(state, events, next);
    next.started = true;
    state.activeFunctionCall = next;
    state.hasEmittedToolUse = true;
    flushBufferedArguments(state, events, next);
  }
}

function computeStopReason(response, hasEmittedToolUse) {
  if (hasEmittedToolUse) return "tool_use";
  const reason = response.incomplete_details && response.incomplete_details.reason;
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}

function computeUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  const cached = (usage.input_tokens_details && usage.input_tokens_details.cached_tokens) || 0;
  let inputTokens = usage.input_tokens || 0;
  if (cached > 0) inputTokens = Math.max(0, inputTokens - cached);
  const result = { input_tokens: inputTokens, output_tokens: usage.output_tokens || 0 };
  if (cached > 0) result.cache_read_input_tokens = cached;
  return result;
}

function drainTerminalFunctionCalls(state, events, response) {
  const output = Array.isArray(response.output) ? response.output : [];
  output.forEach((item, index) => {
    if (item.type !== "function_call") return;
    const keys = callKeys({ item, output_index: item.output_index !== undefined ? item.output_index : index });
    let call = findCall(state, keys);
    if (!call) {
      call = newCallRecord();
      state.functionCallQueue.push(call);
    }
    recordAliases(state, call, keys);
    if (item.call_id) call.callId = item.call_id;
    if (item.name) call.name = item.name;
    updateArguments(call, item.arguments || "", false);
    call.done = true;
  });

  state.functionCallQueue = state.functionCallQueue.filter((call) => !call.closed && call.name);
  drainFunctionCallQueue(state, events);
}

/**
 * Feed one parsed Codex SSE frame (`{ event, data }`, with `data` already
 * JSON.parse()'d into the Codex event object) through the state machine.
 * Returns the Anthropic SSE frames (same `{ event, data }` shape, `data` a
 * plain object ready for `serializeAnthropicSSEEvent`) this Codex event
 * produces, in order — zero, one, or several.
 *
 * @param {ReturnType<typeof createCodexStreamState>} state
 * @param {{ event?: string, data: Record<string, any> }} frame
 * @returns {Array<{ event: string, data: object }>}
 */
export function feedCodexEvent(state, frame) {
  const codexEvent = frame && typeof frame === "object" && "data" in frame ? frame.data : frame;
  const events = [];
  const type = codexEvent && codexEvent.type;

  switch (type) {
    case "response.created": {
      const response = codexEvent.response || {};
      emit(events, "message_start", {
        type: "message_start",
        message: {
          id: response.id || "",
          type: "message",
          role: "assistant",
          model: response.model || "",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });
      break;
    }

    case "response.reasoning_summary_part.added": {
      stopTextBlock(state, events);
      // One Codex reasoning item can carry several summary parts; keep one
      // thinking block open across all of them so only the item's final
      // encrypted_content is ever emitted as a signature.
      if (state.thinkingBlockOpen) {
        appendThinkingDelta(state, events, "\n\n");
      } else {
        startThinkingBlock(state, events);
      }
      state.thinkingSummarySeen = true;
      break;
    }

    case "response.reasoning_summary_text.delta": {
      stopTextBlock(state, events);
      startThinkingBlock(state, events);
      appendThinkingDelta(state, events, codexEvent.delta || "");
      break;
    }

    case "response.reasoning_summary_part.done":
      break; // stays open until output_item.done delivers encrypted_content

    case "response.output_text.delta": {
      state.hasTextDelta = true;
      finalizeThinkingBlock(state, events);
      startTextBlock(state, events);
      emit(events, "content_block_delta", {
        type: "content_block_delta",
        index: state.blockIndex,
        delta: { type: "text_delta", text: codexEvent.delta || "" }
      });
      break;
    }

    case "response.output_item.added": {
      const item = codexEvent.item || {};
      if (item.type === "function_call") {
        finalizeThinkingBlock(state, events);
        stopTextBlock(state, events);
        const call = getOrCreateCall(state, codexEvent);
        if (item.call_id) call.callId = item.call_id;
        if (item.name) call.name = item.name;
        drainFunctionCallQueue(state, events);
      } else if (item.type === "reasoning") {
        stopTextBlock(state, events);
        finalizeThinkingBlock(state, events); // a prior never-finalized item must not leak into this one
        state.thinkingSummarySeen = false;
        // A pre-content snapshot only; output_item.done's value is authoritative.
        state.thinkingSignature = signatureFor(item.encrypted_content);
      }
      break;
    }

    case "response.output_item.done": {
      const item = codexEvent.item || {};
      if (item.type === "function_call") {
        finalizeThinkingBlock(state, events);
        stopTextBlock(state, events);
        const call = getOrCreateCall(state, codexEvent);
        if (item.call_id) call.callId = item.call_id;
        if (item.name) call.name = item.name;
        updateArguments(call, item.arguments || "", false);
        call.done = true;
        drainFunctionCallQueue(state, events);
      } else if (item.type === "reasoning") {
        stopTextBlock(state, events);
        if (item.encrypted_content) state.thinkingSignature = signatureFor(item.encrypted_content);
        if (state.thinkingSummarySeen) {
          finalizeThinkingBlock(state, events);
        } else if (state.thinkingSignature) {
          // Signature with no visible summary text: still surface a (near-empty) thinking block.
          startThinkingBlock(state, events);
          finalizeThinkingBlock(state, events);
        }
        state.thinkingSignature = "";
        state.thinkingSummarySeen = false;
      } else if (item.type === "message" && !state.hasTextDelta) {
        const text = Array.isArray(item.content)
          ? item.content
              .filter((part) => part.type === "output_text")
              .map((part) => part.text || "")
              .join("")
          : "";
        if (text) {
          finalizeThinkingBlock(state, events);
          startTextBlock(state, events);
          emit(events, "content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: { type: "text_delta", text }
          });
          stopTextBlock(state, events);
          state.hasTextDelta = true;
        }
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      const call = getOrCreateCall(state, codexEvent);
      updateArguments(call, codexEvent.delta || "", true);
      flushBufferedArguments(state, events, call);
      break;
    }

    case "response.function_call_arguments.done": {
      const call = getOrCreateCall(state, codexEvent);
      updateArguments(call, codexEvent.arguments || "", false);
      flushBufferedArguments(state, events, call);
      break;
    }

    case "response.completed":
    case "response.incomplete": {
      finalizeThinkingBlock(state, events);
      stopTextBlock(state, events);
      const response = codexEvent.response || {};
      drainTerminalFunctionCalls(state, events, response);
      finalizeThinkingBlock(state, events);
      stopTextBlock(state, events);

      emit(events, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: computeStopReason(response, state.hasEmittedToolUse), stop_sequence: null },
        usage: computeUsage(response.usage)
      });
      emit(events, "message_stop", { type: "message_stop" });
      break;
    }

    case "error":
    case "response.failed": {
      const mapped = mapUpstreamError({ streamEventType: type, streamEventBody: codexEvent });
      emit(events, "error", mapped.anthropicErrorBody);
      break;
    }

    default:
      break;
  }

  return events;
}

// ---------------------------------------------------------------------------
// Non-stream accumulator (same event shapes, one final Anthropic message)
// ---------------------------------------------------------------------------

function reasoningSummaryText(item) {
  if (!Array.isArray(item.summary)) return "";
  return item.summary.map((part) => (part && typeof part === "object" ? part.text || "" : String(part))).join("");
}

function toolUseInput(argumentsJSON) {
  if (!argumentsJSON) return {};
  try {
    const parsed = JSON.parse(argumentsJSON);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Accumulate a whole turn's worth of parsed Codex SSE frames into one
 * Anthropic message object (spec: "Non-streaming requests SHALL return the
 * same content as one Anthropic message object").
 *
 * Invariant: the terminal `response.completed`/`response.incomplete` event's
 * own `response.output` is NOT reliably populated — real upstream traffic
 * has been observed to send an empty `output: []` on `response.completed`
 * for both a plain text reply and a reasoning + web_search reply, with the
 * turn's actual content having already arrived as a sequence of
 * `response.output_item.done` events (one per item: message, reasoning,
 * function_call, ...). This accumulator therefore collects every
 * `output_item.done` frame's `item`, in arrival order and deduped by
 * `output_index` when present, and uses that collection as the output list
 * whenever the terminal event's own `output` is empty or missing. When the
 * terminal `output` is non-empty it is used as-is (unchanged behavior) —
 * matching how the streaming path's own terminal-event handling
 * (`drainTerminalFunctionCalls`) treats a non-empty `response.output` as
 * authoritative for anything a delta might have missed.
 *
 * @param {Array<{ event?: string, data: Record<string, any> }>} frames
 * @param {{ toolNameMap?: Map<string, string> }} [options]
 * @returns {{ message: object } | { error: ReturnType<typeof mapUpstreamError> }}
 */
export function accumulateNonStreamMessage(frames, { toolNameMap } = {}) {
  const reverseToolNameMap = new Map();
  if (toolNameMap) {
    for (const [original, short] of toolNameMap.entries()) reverseToolNameMap.set(short, original);
  }

  let terminal = null;
  const doneItemOrder = [];
  const doneItemsByKey = new Map();
  let doneItemSeq = 0;
  for (const frame of frames || []) {
    const data = frame && typeof frame === "object" && "data" in frame ? frame.data : frame;
    if (!data || typeof data !== "object") continue;
    if (data.type === "response.output_item.done" && data.item) {
      const key = data.output_index !== undefined ? `index:${data.output_index}` : `seq:${doneItemSeq++}`;
      if (!doneItemsByKey.has(key)) doneItemOrder.push(key);
      doneItemsByKey.set(key, data.item);
    }
    if (
      data.type === "response.completed" ||
      data.type === "response.incomplete" ||
      data.type === "response.failed" ||
      data.type === "error"
    ) {
      terminal = data;
    }
  }

  if (!terminal) {
    throw new Error("no terminal Codex event (response.completed/incomplete/failed, or error) in the given frames");
  }

  if (terminal.type === "error" || terminal.type === "response.failed") {
    return { error: mapUpstreamError({ streamEventType: terminal.type, streamEventBody: terminal }) };
  }

  const response = terminal.response || {};
  const terminalOutput = Array.isArray(response.output) ? response.output : [];
  const output = terminalOutput.length > 0 ? terminalOutput : doneItemOrder.map((key) => doneItemsByKey.get(key));
  const content = [];
  let hasToolCall = false;

  for (const item of output) {
    if (item.type === "reasoning") {
      const summaryText = reasoningSummaryText(item);
      const signature = signatureFor(item.encrypted_content);
      if (summaryText || signature) {
        const block = { type: "thinking", thinking: summaryText };
        if (signature) block.signature = signature;
        content.push(block);
      }
    } else if (item.type === "message") {
      const text = Array.isArray(item.content)
        ? item.content
            .filter((part) => part.type === "output_text")
            .map((part) => part.text || "")
            .join("")
        : "";
      if (text) content.push({ type: "text", text });
    } else if (item.type === "function_call") {
      hasToolCall = true;
      content.push({
        type: "tool_use",
        id: item.call_id || "",
        name: reverseToolNameMap.get(item.name) || item.name,
        input: toolUseInput(item.arguments)
      });
    }
  }

  return {
    message: {
      id: response.id || "",
      type: "message",
      role: "assistant",
      model: response.model || "",
      content,
      stop_reason: computeStopReason(response, hasToolCall),
      stop_sequence: null,
      usage: computeUsage(response.usage)
    }
  };
}

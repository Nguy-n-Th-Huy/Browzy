// Anthropic Messages request body -> Codex `responses` request body.
//
// Pure module: no I/O, no network, no chrome/secret access. Everything this
// file needs arrives as plain data (the parsed Anthropic request body plus
// the bound model and a caller-computed prompt cache key) and everything it
// produces is plain data (the Codex body plus the tool-name map used to
// restore names in responses). Fixtures drive its tests.
//
// Ported (structure and field mapping only, not the wire-cloaking bits) from
// router-for-me/CLIProxyAPI @ ac02da6 (MIT),
// internal/translator/codex/claude/codex_claude_request.go. Differences are
// deliberate (design.md decision 4): URL images are forwarded instead of
// dropped, an unknown content block type fails the request instead of being
// silently skipped, `tool_result.is_error` becomes a leading "Tool error:"
// item instead of being lost, and no tool is ever injected that the caller
// did not request.

import { createHash } from "node:crypto";

const TOOL_NAME_LIMIT = 64;
const SHORT_NAME_PREFIX_LEN = 58; // + "_" + 5 hex chars == 64

const KNOWN_MESSAGE_BLOCK_TYPES = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "image",
  "document",
  "tool_use",
  "tool_result"
]);

// Only a signature carrying this prefix was issued by this gateway. See
// design.md decision 4: a signature of another origin must never be replayed
// upstream as if it were this gateway's own encrypted content.
export const REASONING_SIGNATURE_PREFIX = "brzcx1.";

/**
 * Thrown when a message content block type is not one this gateway knows how
 * to translate. Maps 1:1 to the spec's "Unsupported block" scenario: HTTP 400
 * `invalid_request_error` naming the offending type, nothing sent upstream.
 */
export class ChatGPTTranslationError extends Error {
  /** @param {string} blockType @param {{ message?: string }} [opts] */
  constructor(blockType, opts = {}) {
    super(opts.message || `unsupported content block type: ${String(blockType)}`);
    this.name = "ChatGPTTranslationError";
    this.status = 400;
    this.anthropicErrorType = "invalid_request_error";
    this.blockType = blockType;
  }
}

// ---------------------------------------------------------------------------
// Deterministic tool-name shortening
// ---------------------------------------------------------------------------

function shortNameCandidate(name) {
  if (name.length <= TOOL_NAME_LIMIT) return name;
  const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 5);
  return `${name.slice(0, SHORT_NAME_PREFIX_LEN)}_${hash}`;
}

function withCollisionSuffix(candidate, used) {
  if (!used.has(candidate)) return candidate;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const allowed = Math.max(0, TOOL_NAME_LIMIT - suffix.length);
    const attempt = (candidate.length > allowed ? candidate.slice(0, allowed) : candidate) + suffix;
    if (!used.has(attempt)) return attempt;
  }
}

/**
 * Build a deterministic original-name -> upstream-safe-name map for one
 * request's tool list. Names at or under the limit keep their identity (and
 * claim it first, so a shortened name can never collide with a literal short
 * name already in the list); names over the limit become their first 58
 * characters plus `_` and a 5-character hash of the full original name, with
 * a numeric collision suffix if two names still land on the same candidate.
 *
 * @param {string[]} names
 * @returns {Map<string, string>} original -> shortened
 */
export function buildToolNameMap(names) {
  const used = new Set();
  for (const name of names) {
    if (name.length <= TOOL_NAME_LIMIT) used.add(name);
  }
  const map = new Map();
  for (const name of names) {
    if (map.has(name)) continue;
    if (name.length <= TOOL_NAME_LIMIT) {
      map.set(name, name);
      continue;
    }
    const candidate = withCollisionSuffix(shortNameCandidate(name), used);
    used.add(candidate);
    map.set(name, candidate);
  }
  return map;
}

/** Look up (or, for a name outside the map, compute) the upstream-safe name. */
export function shortenToolName(name, toolNameMap) {
  if (toolNameMap && toolNameMap.has(name)) return toolNameMap.get(name);
  return shortNameCandidate(name);
}

function isWebSearchToolType(type) {
  return typeof type === "string" && type.startsWith("web_search");
}

// ---------------------------------------------------------------------------
// Content block translation
// ---------------------------------------------------------------------------

function imageDataURL(block) {
  const source = block.source || {};
  if (source.type === "base64") {
    const mediaType = source.media_type || "application/octet-stream";
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === "url") {
    return source.url;
  }
  throw new ChatGPTTranslationError("image", {
    message: `unsupported image source type: ${String(source.type)}`
  });
}

function documentDataURL(block) {
  const source = block.source || {};
  const mediaType = String(source.media_type || "");
  if (source.type === "base64" && mediaType.toLowerCase() === "application/pdf") {
    return `data:${mediaType};base64,${source.data}`;
  }
  // Non-goal (design.md): document types beyond base64 PDF. Fail loudly
  // rather than silently dropping content the caller expects to be sent.
  throw new ChatGPTTranslationError("document", {
    message: "only base64 application/pdf documents are supported"
  });
}

function translateToolResultOutput(block) {
  const isError = block.is_error === true;
  const content = block.content;

  if (content === undefined || typeof content === "string") {
    const text = typeof content === "string" ? content : "";
    if (!isError) return text;
    return [
      { type: "input_text", text: "Tool error:" },
      { type: "input_text", text }
    ];
  }

  if (Array.isArray(content)) {
    const items = content.map((part) => {
      if (part.type === "text") return { type: "input_text", text: part.text || "" };
      if (part.type === "image") return { type: "input_image", image_url: imageDataURL(part) };
      throw new ChatGPTTranslationError(part.type, {
        message: `unsupported tool_result content block type: ${String(part.type)}`
      });
    });
    if (isError) items.unshift({ type: "input_text", text: "Tool error:" });
    return items;
  }

  throw new ChatGPTTranslationError("tool_result", { message: "unsupported tool_result content shape" });
}

function translateSystem(system) {
  const texts = [];
  if (typeof system === "string") {
    if (system !== "") texts.push(system);
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && block.type === "text" && typeof block.text === "string" && block.text !== "") {
        texts.push(block.text);
      }
    }
  }
  if (texts.length === 0) return null;
  return {
    type: "message",
    role: "developer",
    content: texts.map((text) => ({ type: "input_text", text }))
  };
}

function translateMessages(messages, toolNameMap) {
  const items = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message.role;
    const content = message.content;

    if (typeof content === "string") {
      if (content !== "") {
        items.push({
          type: "message",
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text: content }]
        });
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    let pending = [];
    const flush = () => {
      if (pending.length > 0) {
        items.push({ type: "message", role, content: pending });
        pending = [];
      }
    };

    for (const block of content) {
      const type = block && block.type;
      if (!KNOWN_MESSAGE_BLOCK_TYPES.has(type)) {
        throw new ChatGPTTranslationError(type);
      }

      switch (type) {
        case "text":
          pending.push({ type: role === "assistant" ? "output_text" : "input_text", text: block.text || "" });
          break;
        case "image":
          pending.push({ type: "input_image", image_url: imageDataURL(block) });
          break;
        case "document":
          pending.push({ type: "input_file", file_data: documentDataURL(block), filename: "document.pdf" });
          break;
        case "thinking": {
          if (role !== "assistant") break;
          const signature = typeof block.signature === "string" ? block.signature : "";
          if (!signature.startsWith(REASONING_SIGNATURE_PREFIX)) break; // not gateway-issued: omitted
          flush();
          items.push({
            type: "reasoning",
            summary: [],
            content: null,
            encrypted_content: signature.slice(REASONING_SIGNATURE_PREFIX.length)
          });
          break;
        }
        case "redacted_thinking":
          break; // always omitted, never round-tripped upstream
        case "tool_use":
          flush();
          items.push({
            type: "function_call",
            call_id: block.id,
            name: shortenToolName(block.name, toolNameMap),
            arguments: JSON.stringify(block.input === undefined ? {} : block.input)
          });
          break;
        case "tool_result":
          flush();
          items.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: translateToolResultOutput(block)
          });
          break;
        default:
          break;
      }
      // cache_control (when present on any block) is simply never read above,
      // which is what "removed" means for a builder that only copies fields
      // it explicitly knows about.
    }
    flush();
  }

  return items;
}

// ---------------------------------------------------------------------------
// Tools, tool_choice, reasoning effort
// ---------------------------------------------------------------------------

function normalizeParameters(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$schema;
  delete clone.$id;
  return clone;
}

function mapTool(tool, toolNameMap) {
  if (isWebSearchToolType(tool.type)) {
    return { type: "web_search" };
  }
  const mapped = {
    type: "function",
    name: shortenToolName(tool.name, toolNameMap),
    parameters: normalizeParameters(tool.input_schema),
    strict: false
  };
  if (typeof tool.description === "string") mapped.description = tool.description;
  return mapped;
}

function mapToolChoice(toolChoice, toolNameMap, webSearchToolNames) {
  if (!toolChoice) return "auto";
  const type = typeof toolChoice === "string" ? toolChoice : toolChoice.type;

  switch (type) {
    case "auto":
    case undefined:
    case "":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const name = toolChoice.name;
      if (webSearchToolNames.has(name)) return { type: "web_search" };
      const short = shortenToolName(name, toolNameMap);
      if (!short) return "auto";
      return { type: "function", name: short };
    }
    default:
      return "auto";
  }
}

function computeParallelToolCalls(request) {
  const toolChoice = request.tool_choice;
  const disabled = Boolean(toolChoice && toolChoice.disable_parallel_tool_use === true);
  return !disabled;
}

function computeReasoningEffort(request) {
  const outputEffort =
    request.output_config && typeof request.output_config.effort === "string"
      ? request.output_config.effort.trim().toLowerCase()
      : "";
  if (outputEffort) return outputEffort;

  const thinking = request.thinking;
  if (thinking && typeof thinking === "object" && thinking.type === "enabled") {
    const budget = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined;
    if (typeof budget === "number") {
      if (budget < 4000) return "low";
      if (budget < 16000) return "medium";
      return "high";
    }
  }

  return "medium";
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Translate one Anthropic Messages request body into a Codex `responses`
 * request body, built strictly from an allowlist of fields (design.md
 * decision 7 / spec "Upstream Codex request": nothing else is ever
 * forwarded, so an unrecognised Anthropic field — including every dropped
 * sampling field — simply never reaches the constructed body).
 *
 * @param {Record<string, any>} request Parsed Anthropic Messages request body.
 * @param {{ model: string, promptCacheKey?: string }} params `model` is the
 *   run's bound model (never the model id named in the request body); `promptCacheKey`
 *   is computed by the caller (from the conversation id) and copied through verbatim.
 * @returns {{ body: Record<string, any>, toolNameMap: Map<string, string> }}
 * @throws {ChatGPTTranslationError} for any content block type this gateway does not translate.
 */
export function translateAnthropicRequestToCodex(request, { model, promptCacheKey } = {}) {
  const toolList = Array.isArray(request.tools) ? request.tools : null;
  const toolNameMap = buildToolNameMap((toolList || []).map((tool) => tool.name).filter(Boolean));
  const webSearchToolNames = new Set(
    (toolList || []).filter((tool) => isWebSearchToolType(tool.type) && tool.name).map((tool) => tool.name)
  );

  const input = [];
  const developerMessage = translateSystem(request.system);
  if (developerMessage) input.push(developerMessage);
  input.push(...translateMessages(request.messages, toolNameMap));

  const body = {
    model,
    instructions: "",
    input,
    // Set unconditionally (matches the reference translator): tool_choice
    // itself is meaningless without tools and is only added below.
    parallel_tool_calls: computeParallelToolCalls(request),
    reasoning: { effort: computeReasoningEffort(request), summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"]
  };

  if (toolList) {
    body.tools = toolList.map((tool) => mapTool(tool, toolNameMap));
    body.tool_choice = mapToolChoice(request.tool_choice, toolNameMap, webSearchToolNames);
  }

  if (promptCacheKey !== undefined) body.prompt_cache_key = promptCacheKey;

  return { body, toolNameMap };
}

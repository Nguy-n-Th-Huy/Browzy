// Standalone Anthropic Messages API agent loop (no chrome APIs, no DOM).
// Pure ESM: runs in the sidepanel, the service worker, or plain Node.
// The caller injects `executeTool(name, input)` — Browzy wires that to
// background.js's handleToolRequest; the captured Claude-in-Chrome toolset
// (computer / navigate / ...) drops into `tools` + `systemPrompt` untouched.
//
// Wire shape per turn:
//   POST {baseUrl}/v1/messages { model, system, messages, tools, betas? }
//   - text blocks            -> forwarded via onEvent({type:"text",...})
//   - tool_use blocks        -> executeTool() -> appended as tool_result
//   - stop_reason end_turn   -> run() resolves with the full transcript
// Executor failures become is_error tool_results (never throw the loop).
// Transport failures (401/429/5xx/network) throw — the caller surfaces them.

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_ITERATIONS = 25;

export class AgentLoopError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "AgentLoopError";
    this.code = code;
    this.status = status ?? null;
  }
}

export function createAgentLoop({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model,
  systemPrompt = "",
  tools = [],
  betas = [],
  maxIterations = DEFAULT_MAX_ITERATIONS,
  executeTool,
  onEvent = () => {},
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new AgentLoopError("NO_API_KEY", "Missing Anthropic API key.");
  if (!model) throw new AgentLoopError("NO_MODEL", "Missing model id.");
  if (typeof executeTool !== "function") {
    throw new AgentLoopError("NO_EXECUTOR", "Missing executeTool(name, input) handler.");
  }

  const endpoint = String(baseUrl).replace(/\/+$/, "") + "/v1/messages";

  async function callApi(messages) {
    const body = { model, max_tokens: 4096, messages };
    if (systemPrompt) body.system = systemPrompt;
    if (tools.length) body.tools = tools;
    if (betas.length) body.betas = betas;

    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new AgentLoopError("NETWORK_ERROR", "API request failed: " + (e?.message || e));
    }
    if (res.status === 401 || res.status === 403) {
      throw new AgentLoopError("AUTH_FAILED", "API key rejected (HTTP " + res.status + ").", res.status);
    }
    if (res.status === 429) {
      throw new AgentLoopError("RATE_LIMITED", "Rate limited (HTTP 429).", 429);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentLoopError("API_ERROR", "API error HTTP " + res.status + ": " + text.slice(0, 300), res.status);
    }
    return res.json();
  }

  async function run(initialMessages) {
    const messages = initialMessages.map((m) => ({
      role: m.role,
      content: Array.isArray(m.content) ? [...m.content] : m.content,
    }));
    const transcript = [...messages];

    for (let i = 0; i < maxIterations; i++) {
      const data = await callApi(messages);
      const blocks = data.content || [];
      messages.push({ role: "assistant", content: blocks });
      transcript.push({ role: "assistant", content: blocks });

      const toolUses = blocks.filter((b) => b && b.type === "tool_use");
      for (const b of blocks) {
        if (b?.type === "text") onEvent({ type: "text", text: b.text || "" });
      }

      if (!toolUses.length || data.stop_reason === "end_turn") {
        onEvent({ type: "done", stopReason: data.stop_reason || "end_turn" });
        return { transcript, stopReason: data.stop_reason || "end_turn" };
      }

      const results = [];
      for (const tu of toolUses) {
        onEvent({ type: "tool_start", id: tu.id, name: tu.name, input: tu.input });
        try {
          const output = await executeTool(tu.name, tu.input || {});
          results.push({ type: "tool_result", tool_use_id: tu.id, content: toResultContent(output) });
          onEvent({ type: "tool_end", id: tu.id, name: tu.name, ok: true });
        } catch (e) {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: "Tool error: " + (e?.message || String(e)) }],
            is_error: true,
          });
          onEvent({ type: "tool_end", id: tu.id, name: tu.name, ok: false, error: e?.message || String(e) });
        }
      }
      messages.push({ role: "user", content: results });
      transcript.push({ role: "user", content: results });
    }
    onEvent({ type: "done", stopReason: "max_iterations" });
    return { transcript, stopReason: "max_iterations" };
  }

  return { run, endpoint };
}

function toResultContent(output) {
  if (typeof output === "string") return [{ type: "text", text: output }];
  if (Array.isArray(output)) return output;
  return [{ type: "text", text: JSON.stringify(output ?? null) }];
}

// Smoke test for extension/agent/loop.js — mocked transport, no network.
import { createAgentLoop, AgentLoopError } from "./loop.js";

let failures = 0;
function ok(cond, name) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures++;
}

// Scripted transport: turn 1 asks for a tool, turn 2 ends.
const script = [
  {
    status: 200,
    ok: true,
    json: async () => ({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me look. " },
        { type: "tool_use", id: "tu_1", name: "computer", input: { action: "screenshot" } },
      ],
    }),
  },
  {
    status: 200,
    ok: true,
    json: async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I see a login page." }],
    }),
  },
];
const seen = [];
async function mockFetch(url, opts) {
  seen.push({ url, body: JSON.parse(opts.body) });
  return script[Math.min(seen.length - 1, script.length - 1)];
}

const events = [];
const loop = createAgentLoop({
  apiKey: "test-key",
  model: "claude-sonnet-4-5",
  systemPrompt: "Be terse.",
  tools: [{ name: "computer", input_schema: { type: "object" } }],
  betas: ["computer-use-2025-01-24"],
  executeTool: async (name, input) => ({ name, got: input, shot: true }),
  onEvent: (e) => events.push(e),
  fetchImpl: mockFetch,
});

const { transcript, stopReason } = await loop.run([
  { role: "user", content: "What's on screen?" },
]);

ok(stopReason === "end_turn", "ends on end_turn");
ok(transcript.length === 4, "transcript has 4 messages (user/asst/user/asst), got " + transcript.length);
ok(transcript[2].content[0].type === "tool_result", "tool result fed back");
ok(transcript[2].content[0].tool_use_id === "tu_1", "tool_use id wired");
ok(seen[0].url === "https://api.anthropic.com/v1/messages", "hits messages endpoint");
ok(seen[0].body.system === "Be terse.", "system prompt sent");
ok(seen[0].body.betas.includes("computer-use-2025-01-24"), "betas sent");
ok(events.some((e) => e.type === "tool_start" && e.name === "computer"), "tool_start emitted");
ok(events.filter((e) => e.type === "text").join(" ").length > 0, "text events emitted");

// 401 surfaces as AUTH_FAILED.
const badLoop = createAgentLoop({
  apiKey: "dead",
  model: "m",
  executeTool: async () => ({}),
  fetchImpl: async () => ({ status: 401, ok: false }),
});
try {
  await badLoop.run([{ role: "user", content: "hi" }]);
  ok(false, "401 throws");
} catch (e) {
  ok(e instanceof AgentLoopError && e.code === "AUTH_FAILED", "401 -> AUTH_FAILED");
}

// Executor failure becomes is_error result, loop survives.
const errLoop = createAgentLoop({
  apiKey: "k",
  model: "m",
  executeTool: async () => { throw new Error("boom"); },
  fetchImpl: (() => {
    let n = 0;
    return async () => (++n === 1
      ? { status: 200, ok: true, json: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t9", name: "x", input: {} }] }) }
      : { status: 200, ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "recovered" }] }) });
  })(),
});
const r2 = await errLoop.run([{ role: "user", content: "go" }]);
ok(r2.transcript[2].content[0].is_error === true, "executor error -> is_error result");

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("loop smoke: all green");

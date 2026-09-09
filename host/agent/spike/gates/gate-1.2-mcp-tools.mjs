// Gate 1.2 — application-owned in-process SDK MCP tools calling the current
// browser runtime; no user MCP registration, no inherited MCP config, no
// proprietary Chrome integration.
//
// Fully offline. Uses a scratch, unreachable pipe so nothing here can ever
// reach a real running browser bridge on this machine.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_RUNTIME_SRC = path.join(HERE, "..", "..", "..", "tool-runtime.js");

export async function run() {
  const evidence = [];
  const fail = (msg) => {
    evidence.push(`FAIL: ${msg}`);
    throw new Error(msg);
  };

  // Isolated scratch pipe: set BEFORE the dynamic import so tool-runtime.js's
  // module-load-time getPipePath() picks it up (see adapter.mjs header note).
  process.env.OCIC_PIPE =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ocic-spike-1.2-${process.pid}`
      : `/tmp/ocic-spike-1.2-${process.pid}.sock`;

  const adapter = await import("../lib/adapter.mjs");
  const { TOOLS } = await import("../../../tool-definitions.js");

  await adapter.initRuntime();
  evidence.push(`tool-runtime.init() joined scratch pipe ${process.env.OCIC_PIPE} (unreachable — proves isolation from any real browser bridge)`);

  const server = adapter.createBrowserMcpServer();
  evidence.push(`createSdkMcpServer() -> { type: ${JSON.stringify(server.type)}, name: ${JSON.stringify(server.name)} }`);
  if (server.type !== "sdk") fail(`expected server.type "sdk", got ${JSON.stringify(server.type)}`);
  if (server.name !== adapter.SDK_MCP_SERVER_NAME) fail("server name mismatch");

  const inst = server.instance;
  const registeredNames = Object.keys(inst._registeredTools).sort();
  const registryNames = TOOLS.map((t) => t.name).sort();
  evidence.push(`registered SDK tools: ${registeredNames.length}, registry (host/tool-definitions.js): ${registryNames.length}`);
  if (JSON.stringify(registeredNames) !== JSON.stringify(registryNames)) {
    fail(
      `adapter tool set does not exactly match host/tool-definitions.js TOOLS.\n  registered: ${registeredNames.join(", ")}\n  registry:   ${registryNames.join(", ")}`
    );
  }
  evidence.push("PASS: every tool in host/tool-definitions.js is registered on the SDK server, and nothing extra was added");

  // Real end-to-end call: reach the ACTUAL tool-runtime.js through the SDK's
  // own MCP request-validation/dispatch code path (validateToolInput +
  // executeToolHandler, the same methods @modelcontextprotocol/sdk's
  // McpServer uses for a live tools/call request). No browser is attached on
  // this scratch pipe, so the real (not mocked) answer is "not connected" —
  // that is itself the proof the call reached the real runtime rather than a
  // stub, because that exact string comes from tool-runtime.js's own
  // NO_BRIDGE_ERROR constant.
  const ctxTool = inst._registeredTools["tabs_context_mcp"];
  const args = await inst.validateToolInput(ctxTool, {}, "tabs_context_mcp");
  const result = await inst.executeToolHandler(ctxTool, args, {});
  const text = result?.content?.[0]?.text ?? "";
  evidence.push(`tabs_context_mcp() through the SDK tool path -> ${JSON.stringify(text)}`);
  if (!/not connected/i.test(text)) {
    fail(`expected the real tool-runtime.js "not connected" error, got: ${text}`);
  }
  evidence.push("PASS: the SDK tool call reached the real host/tool-runtime.js (verified against its NO_BRIDGE_ERROR text), not a stub");

  // No proprietary Chrome integration / no `claude mcp add` step: this
  // adapter never touches ~/.claude.json, ~/.claude/mcp*.json, or any CLI
  // MCP registration file — it only builds an in-memory server object and
  // passes it through query() options. Prove by source inspection: the
  // adapter and tool-runtime.js never reference an MCP config path or the
  // proprietary "chrome" integration name.
  const adapterSrc = readFileSync(path.join(HERE, "..", "lib", "adapter.mjs"), "utf-8");
  const runtimeSrc = readFileSync(TOOL_RUNTIME_SRC, "utf-8");
  const forbidden = [".claude.json", "claude mcp add", "chrome-integration", "claude_chrome"];
  for (const needle of forbidden) {
    if (adapterSrc.includes(needle) || runtimeSrc.includes(needle)) {
      fail(`found forbidden reference "${needle}" in adapter or tool-runtime source`);
    }
  }
  evidence.push(`PASS: no reference to ${forbidden.join(", ")} in the adapter or host/tool-runtime.js source`);

  adapter.shutdownRuntime();
  evidence.push("tool-runtime.shutdown() called cleanly");

  return { id: "1.2", title: "In-process SDK MCP tools, no user MCP setup", status: "PASS", evidence };
}

import { runAsCli } from "../lib/cli-runner.mjs";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAsCli(run);
}

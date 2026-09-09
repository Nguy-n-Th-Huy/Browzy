// Application-owned in-process SDK MCP tool adapter.
//
// Wraps the EXISTING browser runtime (host/tool-runtime.js +
// host/tool-definitions.js) as official Claude Agent SDK custom tools, using
// the documented `tool()` + `createSdkMcpServer()` APIs (see design.md
// decision 2). This file does not reimplement or modify tool-runtime.js /
// tool-definitions.js: it is a thin bridge from the SDK's in-process MCP
// surface to the existing `callTool(name, args)` contract, mirroring the
// exact registration loop host/mcp-server.js already uses for the stdio MCP
// front-end (same name/description/paramShape/handler shape).
//
// Spike-only. Not imported by any product entry point — native-host.js,
// mcp-server.js and codemode/common.js are unmodified and untouched.
//
// IMPORTANT (isolation): tool-runtime.js reads its pipe path once, at module
// load time, via endpoint.js's `getPipePath()` (which honors the
// OCIC_PIPE env override). Because ESM static imports are hoisted and the
// whole dependency graph is evaluated before the importing module's own
// top-level statements run, a caller that wants an isolated scratch pipe
// MUST set `process.env.OCIC_PIPE` and only THEN `await import()` this
// module dynamically — never via a static top-level `import`. Every gate
// script in this spike follows that rule; see gate.mjs.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { init, callTool, shutdown, coerceArgs } from "../../../tool-runtime.js";
import { TOOLS } from "../../../tool-definitions.js";

export const SDK_MCP_SERVER_NAME = "browzy-in-chrome-browser";

/**
 * Build one SdkMcpToolDefinition per entry in the existing tool registry
 * (host/tool-definitions.js TOOLS — see design.md's registry note for the
 * authoritative count and how it differs from the README). Each definition
 * forwards straight to the existing callTool(name, args); no new validation,
 * aliasing, or business logic is introduced here.
 */
export function buildSdkTools() {
  return TOOLS.map((t) =>
    tool(t.name, t.description, t.paramShape, async (args) => {
      const coerced = coerceArgs({ ...(args ?? {}) });
      return callTool(t.name, coerced);
    })
  );
}

/**
 * Create the in-process SDK MCP server exposing the full existing browser
 * tool registry via the official createSdkMcpServer() API. The caller is
 * responsible for calling initRuntime() before issuing any query() that uses
 * this server, and shutdownRuntime() when done.
 */
export function createBrowserMcpServer() {
  return createSdkMcpServer({
    name: SDK_MCP_SERVER_NAME,
    version: "1.0.0-spike",
    tools: buildSdkTools()
  });
}

export async function initRuntime() {
  await init();
}

export function shutdownRuntime() {
  shutdown();
}

/**
 * Names of every tool exposed through the adapter, for cross-checking against
 * the authoritative registry (host/tool-definitions.js TOOLS) in gates.
 */
export function adapterToolNames() {
  return TOOLS.map((t) => t.name);
}

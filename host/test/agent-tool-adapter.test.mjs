#!/usr/bin/env node
//
// The production SDK browser-tool adapter (host/agent/tools/adapter.js):
// productionizes the spike's gate 1.2 proof (all 26 registry tools
// registered 1:1 via the real tool()/createSdkMcpServer() SDK APIs) by
// adding the unconditional handler-side authorization design.md decision 2
// requires. This exercises the REAL SDK tool objects' handler functions
// (not a reimplementation of them), with a fake ToolBridge/Run so no live
// browser or API key is needed.
//
// Run: node host/test/agent-tool-adapter.test.mjs

import { TOOLS } from "../tool-definitions.js";
import { buildSdkTools, adapterToolNames, KNOWN_TOOL_NAMES } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import { HOST_DROPPED_ERROR } from "../tool-runtime.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
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

async function makeRun({ tabScope = "any", callTool } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_1", lease, approvals, tabScope });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: callTool || (async (name, args) => ({ content: [{ type: "text", text: `ok:${name}` }] })),
    shutdown: () => {}
  });
  return { run, toolBridge, lease };
}

console.log("\nProduction SDK tool adapter\n");

await test("every registry tool (26) is registered on the SDK server, byte-identical to host/tool-definitions.js", async () => {
  const { run, toolBridge } = await makeRun();
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const registered = adapterToolNames();
  assert(registered.length === TOOLS.length, `expected ${TOOLS.length} tools, adapter names list has ${registered.length}`);
  assert(sdkTools.length === TOOLS.length, `expected ${TOOLS.length} SDK tool objects, got ${sdkTools.length}`);
  const registeredNames = new Set(sdkTools.map((t) => t.name));
  for (const t of TOOLS) assert(registeredNames.has(t.name), `${t.name} missing from the adapter`);
  assert(registeredNames.size === TOOLS.length, "no duplicate/extra tool registered");
  assert(KNOWN_TOOL_NAMES.size === TOOLS.length, "KNOWN_TOOL_NAMES must match the registry exactly");
});

await test("a real SDK tool call reaches the underlying toolBridge (not a stub) and returns its content", async () => {
  let sawCall = null;
  const { run, toolBridge } = await makeRun({
    callTool: async (name, args) => {
      sawCall = { name, args };
      return { content: [{ type: "text", text: "real dispatch reached" }] };
    }
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const navigate = sdkTools.find((t) => t.name === "navigate");
  assert(navigate, "navigate tool must exist");
  const result = await navigate.handler({ url: "https://example.com" });
  assert(sawCall && sawCall.name === "navigate", "the underlying callTool must actually be invoked");
  assert(result.content[0].text === "real dispatch reached", "the SDK tool must return the real content, unmodified");
});

await test("an out-of-scope tab is rejected inside the handler even though nothing 'preapproved' it differently", async () => {
  const { run, toolBridge } = await makeRun({ tabScope: [1, 2] });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const navigate = sdkTools.find((t) => t.name === "navigate");
  const result = await navigate.handler({ url: "https://example.com", tabId: 999 });
  assert(result.isError === true, "an out-of-scope call must be flagged as an error result");
  assert(/rejected/.test(result.content[0].text), "the rejection must be visible in the tool result text");
});

await test("a call after stop is rejected inside the handler, never reaching the tool bridge", async () => {
  let dispatched = false;
  const { run, toolBridge } = await makeRun({ callTool: async () => ((dispatched = true), { content: [] }) });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  run.stop("user_stop");
  const getConfig = sdkTools.find((t) => t.name === "get_config");
  const result = await getConfig.handler({});
  assert(result.isError === true, "a call after stop must be rejected");
  assert(!dispatched, "the tool bridge must never be reached once the run has stopped");
});

await test("a lost-response outcome (HOST_DROPPED_ERROR shape) is recorded on the run as result-unknown", async () => {
  const { run, toolBridge } = await makeRun({
    callTool: async () => ({ content: [{ type: "text", text: `Error: ${HOST_DROPPED_ERROR}` }] })
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const computer = sdkTools.find((t) => t.name === "computer");
  await computer.handler({ action: "screenshot" });
  assert(run.unknownResults().length === 1, "the run must record this dispatch as result-unknown");
});

await test("upload_image without a tab in scope is rejected before dispatch", async () => {
  const { run, toolBridge } = await makeRun({ tabScope: [5] });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const upload = sdkTools.find((t) => t.name === "upload_image");
  const result = await upload.handler({ imageId: "img_1", tabId: 42, ref: "ref_1" });
  assert(result.isError === true, "upload_image outside tab scope must be rejected");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

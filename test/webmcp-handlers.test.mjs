// Handler-level tests for the two WebMCP page-tool operations
// (webmcp_list_tools, webmcp_call_tool) added to extension/background.js's
// toolHandlers by openspec/changes/consume-webmcp-page-tools. Runs the
// SHIPPED handler bodies (via test/_extract.mjs's extractMethod, the same
// brace-matching extraction test/handlers.test.mjs:52 already establishes)
// against a faked per-tab table and a faked callWebmcpTool, so this exercises
// the real dispatch/error-handling logic without a browser or a real page.
//
// What this file does NOT cover (see design.md's own "Risks / Trade-offs" —
// "CI has no Chrome, so the end-to-end path has no automated coverage"): the
// actual document.modelContext interaction in extension/webmcp/detect-main.js
// and the postMessage bridge in extension/webmcp/relay-isolated.js. Those
// need a real Chrome build with the WebMCP origin trial (or the
// chrome://flags/#enable-webmcp-testing flag) and are exercised manually
// against test/fixtures/webmcp/ — see the change report.
import { extractMethod } from "./_extract.mjs";
let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const src = ["webmcp_list_tools", "webmcp_call_tool"]
  .map((m) => `const H_${m} = { ${extractMethod(m)} };`)
  .join("\n\n");

// Builds a fresh pair of handlers against a fresh table/mock/group state for
// each test case, so cases cannot leak state into one another.
function build({ inGroup = () => true, table = new Map(), callWebmcpTool } = {}) {
  const calls = []; // every callWebmcpTool invocation, in order — proves (or disproves) "no page code invoked"
  const isInGroup = async (tabId) => inGroup(tabId);
  const withTimeout = (p) => p; // no real timing needed for handler-level logic
  const WEBMCP_CALL_TIMEOUT_MS = 20000;
  const mockCallWebmcpTool =
    callWebmcpTool ||
    (async () => {
      throw new Error("callWebmcpTool should not have been called in this test case");
    });
  const wrappedCallWebmcpTool = async (tabId, name, toolArgs) => {
    calls.push({ tabId, name, toolArgs });
    return mockCallWebmcpTool(tabId, name, toolArgs);
  };
  const mk = new Function(
    "isInGroup",
    "webmcpTabTools",
    "withTimeout",
    "WEBMCP_CALL_TIMEOUT_MS",
    "callWebmcpTool",
    src + "; return { H_webmcp_list_tools, H_webmcp_call_tool };"
  );
  const H = mk(isInGroup, table, withTimeout, WEBMCP_CALL_TIMEOUT_MS, wrappedCallWebmcpTool);
  return { H, calls, table };
}

function text(result) {
  return result && result.content && result.content[0] && result.content[0].text;
}

console.log("== webmcp_list_tools: a populated tab lists its tools ==");
{
  const table = new Map([
    [
      100,
      {
        origin: "https://example.com",
        tools: [
          { name: "search_catalog", description: "Search the site catalog", inputSchema: { type: "object" } }
        ],
        executeToolAvailable: true
      }
    ]
  ]);
  const { H } = build({ table });
  const r = await H.H_webmcp_list_tools.webmcp_list_tools({ tabId: 100 });
  const t = text(r);
  ok(/search_catalog/.test(t), `lists the registered tool's name (got: ${t})`);
  ok(/example\.com/.test(t), "includes the page's origin");
  ok(/PAGE-SUPPLIED/.test(t), "labels the content as page-supplied, per the untrusted-content requirement");
}

console.log("== webmcp_list_tools: an unknown/no-state tab returns an empty list, not an error ==");
{
  const { H } = build({ table: new Map() }); // isInGroup defaults to true — tab exists, just no page-tool state yet
  const r = await H.H_webmcp_list_tools.webmcp_list_tools({ tabId: 999 });
  const t = text(r);
  ok(!!t, "a result is returned (no throw)");
  ok(/No page-declared WebMCP tools/.test(t), `explains the empty state rather than erroring (got: ${t})`);
}

console.log("== webmcp_list_tools: a tab outside the MCP group is refused, not silently listed ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "x", description: "", inputSchema: {} }], executeToolAvailable: false }]]);
  const { H } = build({ table, inGroup: () => false });
  const r = await H.H_webmcp_list_tools.webmcp_list_tools({ tabId: 100 });
  ok(/not in the MCP group/.test(text(r)), "refuses an out-of-group tab, matching every other tab-scoped handler");
}

console.log("== webmcp_call_tool: an unregistered tool name errors and invokes no page code ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "search_catalog", description: "", inputSchema: {} }], executeToolAvailable: true }]]);
  const { H, calls } = build({ table });
  const r = await H.H_webmcp_call_tool.webmcp_call_tool({ tabId: 100, name: "not_a_real_tool", toolArgs: {} });
  const t = text(r);
  ok(/has not registered a page-declared tool named "not_a_real_tool"/.test(t), `explains the unknown tool (got: ${t})`);
  ok(/No page code was invoked/.test(t), "states plainly that no page code ran");
  ok(calls.length === 0, "callWebmcpTool (the only path that reaches the page) was never called");
}

console.log("== webmcp_call_tool: a successful call carries its via: marker ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "search_catalog", description: "", inputSchema: {} }], executeToolAvailable: true }]]);
  const { H, calls } = build({
    table,
    callWebmcpTool: async () => ({ ok: true, via: "executeTool", result: { hits: 3 } })
  });
  const r = await H.H_webmcp_call_tool.webmcp_call_tool({ tabId: 100, name: "search_catalog", toolArgs: { q: "socks" } });
  const t = text(r);
  ok(calls.length === 1, "callWebmcpTool was invoked exactly once for a known tool");
  ok(calls[0].name === "search_catalog" && calls[0].tabId === 100, "dispatched with the right tab and tool name");
  ok(/via: executeTool/.test(t), `success result names the executeTool path (got: ${t})`);
  ok(/PAGE-SUPPLIED|Page-supplied/.test(t), "labels the result as page-supplied");
  ok(/"hits": 3/.test(t), "carries the page tool's actual result");
}

console.log("== webmcp_call_tool: the captured-callback fallback path is named too ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "search_catalog", description: "", inputSchema: {} }], executeToolAvailable: false }]]);
  const { H } = build({
    table,
    callWebmcpTool: async () => ({ ok: true, via: "captured-callback", result: "ok" })
  });
  const r = await H.H_webmcp_call_tool.webmcp_call_tool({ tabId: 100, name: "search_catalog" });
  ok(/via: captured-callback/.test(text(r)), "success result names the captured-callback fallback path");
}

console.log("== webmcp_call_tool: a page-side failure is reported with its reason and via ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "search_catalog", description: "", inputSchema: {} }], executeToolAvailable: true }]]);
  const { H } = build({
    table,
    callWebmcpTool: async () => ({ ok: false, via: "executeTool", error: "boom: catalog service unavailable" })
  });
  const r = await H.H_webmcp_call_tool.webmcp_call_tool({ tabId: 100, name: "search_catalog", toolArgs: {} });
  const t = text(r);
  ok(/failed/.test(t) && /via: executeTool/.test(t), `reports failure with the known via (got: ${t})`);
  ok(/boom: catalog service unavailable/.test(t), "carries the actual failure reason, not a generic message");
}

console.log("== webmcp_call_tool: a call that never reached the page reports honestly, not a fabricated via ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "search_catalog", description: "", inputSchema: {} }], executeToolAvailable: true }]]);
  const { H } = build({
    table,
    callWebmcpTool: async () => {
      throw new Error("no WebMCP relay is reachable in tab 100 (disconnected port)");
    }
  });
  const r = await H.H_webmcp_call_tool.webmcp_call_tool({ tabId: 100, name: "search_catalog", toolArgs: {} });
  const t = text(r);
  ok(/could not reach the page/.test(t), `distinguishes "never reached the page" from a page-side failure (got: ${t})`);
  ok(!/via:/.test(t), "does not invent a via marker for a call that never reached the page");
}

console.log("== webmcp_call_tool: a tab outside the MCP group is refused, not silently called ==");
{
  const table = new Map([[100, { origin: "https://example.com", tools: [{ name: "search_catalog", description: "", inputSchema: {} }], executeToolAvailable: true }]]);
  const { H, calls } = build({ table, inGroup: () => false });
  const r = await H.H_webmcp_call_tool.webmcp_call_tool({ tabId: 100, name: "search_catalog", toolArgs: {} });
  ok(/not in the MCP group/.test(text(r)), "refuses an out-of-group tab before ever looking at its tool table");
  ok(calls.length === 0, "no page code invoked for an out-of-group tab either");
}

console.log(fail === 0 ? "\nALL WEBMCP HANDLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

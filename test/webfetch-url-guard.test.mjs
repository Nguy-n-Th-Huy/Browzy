// Tests for the WebFetch URL guard: the pure classifier
// (host/agent/policy/webfetch-url-guard.js), its wiring into `canUseTool`
// (host/agent/policy/can-use-tool.js), and the query-options.js shape that
// makes WebSearch/WebFetch/Task available while keeping WebFetch out of
// auto-approval so every call actually reaches the guard.
//
// Run: node test/webfetch-url-guard.test.mjs

import { classifyWebFetchUrl } from "../host/agent/policy/webfetch-url-guard.js";
import { createCanUseTool, RequestIdTracker } from "../host/agent/policy/can-use-tool.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { Run } from "../host/agent/session/run.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { buildIsolatedOptions, HIGH_RISK_BUILTINS } from "../host/agent/tools/query-options.js";
import { createBrowserMcpServer, SDK_MCP_SERVER_NAME } from "../host/agent/tools/adapter.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";
import { TOOLS } from "../host/tool-definitions.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// ============================================================================
// classifyWebFetchUrl() — one assertion per deny rule, plus ordinary allows
// ============================================================================

console.log("== classifyWebFetchUrl(): scheme ==");
ok(classifyWebFetchUrl("file:///etc/passwd").allowed === false, "file: scheme denied");
ok(classifyWebFetchUrl("data:text/html,hi").allowed === false, "data: scheme denied");
ok(classifyWebFetchUrl("ftp://example.com/file").allowed === false, "ftp: scheme denied");
ok(classifyWebFetchUrl("http://example.com").allowed === true, "http: scheme allowed");
ok(classifyWebFetchUrl("https://example.com").allowed === true, "https: scheme allowed");

console.log("== classifyWebFetchUrl(): loopback ==");
ok(classifyWebFetchUrl("http://localhost/").allowed === false, "localhost denied");
ok(classifyWebFetchUrl("http://localhost:8080/admin").allowed === false, "localhost:8080/admin denied (the realistic prompt-injection case)");
ok(classifyWebFetchUrl("http://127.0.0.1/").allowed === false, "127.0.0.1 denied");
ok(classifyWebFetchUrl("http://127.255.255.255/").allowed === false, "127.255.255.255 (still 127.0.0.0/8) denied");
ok(classifyWebFetchUrl("http://[::1]/").allowed === false, "::1 (IPv6 loopback) denied");
ok(classifyWebFetchUrl("http://0.0.0.0/").allowed === false, "0.0.0.0 denied");

console.log("== classifyWebFetchUrl(): private IPv4 ==");
ok(classifyWebFetchUrl("http://10.0.0.1/").allowed === false, "10.0.0.0/8 denied");
ok(classifyWebFetchUrl("http://10.255.255.255/").allowed === false, "10.255.255.255 denied");
ok(classifyWebFetchUrl("http://192.168.1.1/").allowed === false, "192.168.0.0/16 denied");
ok(classifyWebFetchUrl("http://172.16.0.1/").allowed === false, "172.16.0.1 (start of 172.16.0.0/12) denied");
ok(classifyWebFetchUrl("http://172.31.255.255/").allowed === false, "172.31.255.255 (end of 172.16.0.0/12) denied");
ok(classifyWebFetchUrl("http://172.32.0.1/").allowed === true, "172.32.0.1 is OUTSIDE 172.16.0.0/12 and must be allowed — the exact boundary the brief calls out");
ok(classifyWebFetchUrl("http://172.15.255.255/").allowed === true, "172.15.255.255 is just below the 172.16 boundary and must be allowed");

console.log("== classifyWebFetchUrl(): link-local / metadata endpoint ==");
ok(classifyWebFetchUrl("http://169.254.169.254/").allowed === false, "169.254.169.254 (cloud metadata endpoint) denied");
ok(classifyWebFetchUrl("http://169.254.1.1/").allowed === false, "169.254.0.0/16 denied");
ok(classifyWebFetchUrl("http://[fe80::1]/").allowed === false, "fe80::/10 (IPv6 link-local) denied");

console.log("== classifyWebFetchUrl(): IPv6 unique-local ==");
ok(classifyWebFetchUrl("http://[fc00::1]/").allowed === false, "fc00::/7 (fc..) denied");
ok(classifyWebFetchUrl("http://[fd12:3456::1]/").allowed === false, "fc00::/7 (fd..) denied");

console.log("== classifyWebFetchUrl(): .local / .internal hostnames ==");
ok(classifyWebFetchUrl("http://printer.local/").allowed === false, ".local hostname denied");
ok(classifyWebFetchUrl("http://service.internal/").allowed === false, ".internal hostname denied");
ok(classifyWebFetchUrl("http://api.internal.example.com/").allowed === true, "a hostname merely CONTAINING .internal (not ending in it) is allowed");

console.log("== classifyWebFetchUrl(): bare hostname (no dot) ==");
ok(classifyWebFetchUrl("http://intranet/").allowed === false, "bare hostname with no dot denied");
ok(classifyWebFetchUrl("http://payroll/").allowed === false, "another bare hostname denied");

console.log("== classifyWebFetchUrl(): unparseable ==");
ok(classifyWebFetchUrl("not a url at all").allowed === false, "unparseable string denied");
ok(classifyWebFetchUrl("http://").allowed === false, "empty authority denied");
ok(classifyWebFetchUrl("").allowed === false, "empty string denied");

console.log("== classifyWebFetchUrl(): ordinary public URLs allowed ==");
ok(classifyWebFetchUrl("https://www.example.com/path?query=1").allowed === true, "ordinary https URL allowed");
ok(classifyWebFetchUrl("http://example.com").allowed === true, "ordinary http URL allowed");
ok(classifyWebFetchUrl("https://api.anthropic.com/v1/messages").allowed === true, "a realistic public API host is allowed");
ok(classifyWebFetchUrl("https://8.8.8.8/").allowed === true, "a public IPv4 literal is allowed");

// ============================================================================
// canUseTool: WebFetch branch
// ============================================================================

function makeRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry({ defaultTtlMs: 200 });
  return new Run({ conversationId: "conv_webfetch_guard", lease, approvals, tabScope });
}

console.log("\n== canUseTool(): WebFetch to a private URL is denied locally ==");
{
  const run = makeRun();
  await run.begin();
  const tracker = new RequestIdTracker();
  const emitted = [];
  run._onEvent = (e) => emitted.push(e);
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });

  const result = await canUseTool({
    toolName: "WebFetch",
    toolUseID: "req_wf_private",
    input: { url: "http://localhost:8080/admin", prompt: "read it" }
  });

  ok(result.behavior === "deny", `a private-URL WebFetch call must be denied, got: ${JSON.stringify(result)}`);
  ok(typeof result.message === "string" && result.message.length > 0, "the denial carries a human-legible reason");
  ok(!emitted.some((e) => e.type === "approval_request"), "NO approval_request event was emitted for a locally-decided WebFetch denial");
  ok(tracker.size() === 0, "no panel decision was ever awaited (the tracker has nothing pending)");
}

console.log("== canUseTool(): WebFetch to a public URL is allowed ==");
{
  const run = makeRun();
  await run.begin();
  const tracker = new RequestIdTracker();
  const emitted = [];
  run._onEvent = (e) => emitted.push(e);
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });

  const result = await canUseTool({
    toolName: "WebFetch",
    toolUseID: "req_wf_public",
    input: { url: "https://example.com/", prompt: "read it" }
  });

  ok(result.behavior === "allow", `a public-URL WebFetch call must be allowed, got: ${JSON.stringify(result)}`);
  ok(!emitted.some((e) => e.type === "approval_request"), "NO approval_request event was emitted for an allowed WebFetch call either");
  ok(tracker.size() === 0, "no panel decision was ever awaited for the allow path");
}

console.log("== canUseTool(): a non-WebFetch send-class call still goes through the existing approval path unchanged ==");
{
  const run = makeRun({ tabScope: [42] });
  await run.begin();
  const tracker = new RequestIdTracker();
  const emitted = [];
  run._onEvent = (e) => emitted.push(e);
  const canUseTool = createCanUseTool({ run, approvals: run.approvals, requestIdTracker: tracker });

  const promise = canUseTool({
    toolName: "computer",
    toolUseID: "req_send_class",
    input: { action: "click", description: "submit the form", tabId: 42 }
  });

  await new Promise((r) => setTimeout(r, 5));
  ok(tracker.has("req_send_class"), "a send-class call is still routed through the approval tracker (unchanged behavior)");
  ok(emitted.some((e) => e.type === "approval_request" && e.requestId === "req_send_class"), "an approval_request event IS still emitted for a genuine send-class call");

  const entry = tracker.take("req_send_class");
  entry.resolver({ decision: "approve" });
  const result = await promise;
  ok(result.behavior === "allow" || result.behavior === "deny", "the send-class path still resolves through the normal approve/deny machinery");
}

// ============================================================================
// query-options.js shape
// ============================================================================

console.log("\n== query-options.js: WebSearch/WebFetch/Task availability and auto-approval shape ==");

async function makeOptionsRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_webfetch_shape", lease, approvals, tabScope });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `ok:${name}` }] }),
    shutdown: () => {}
  });
  return { run, toolBridge };
}

function fakeSnapshot() {
  return { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } };
}
function fakeSkills() {
  return {
    cwd: "/scratch/conv-webfetch-shape",
    configDir: "/scratch/conv-webfetch-shape/claude-config",
    pluginDir: "/scratch/conv-webfetch-shape/skills-plugin",
    allowedSkillNames: [],
    skillOverrides: {}
  };
}

{
  // 26 preserved-baseline + 2 post-baseline WebMCP page-tool additions
  // (openspec/changes/consume-webmcp-page-tools) = 28.
  ok(TOOLS.length === 28, `sanity: expected the known 28-entry registry (26 preserved + 2 post-baseline), got ${TOOLS.length}`);
  const { run, toolBridge } = await makeOptionsRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
  const options = buildIsolatedOptions({ mcpServer, serverName: SDK_MCP_SERVER_NAME, snapshot: fakeSnapshot(), skills: fakeSkills() });

  ok(options.tools.includes("WebSearch"), "WebSearch is in tools (available)");
  ok(options.tools.includes("WebFetch"), "WebFetch is in tools (available)");
  ok(options.tools.includes("Task"), "Task is in tools (available)");

  ok(options.allowedTools.includes("WebSearch"), "WebSearch is in allowedTools (auto-approved)");
  ok(options.allowedTools.includes("Task"), "Task is in allowedTools (auto-approved)");
  ok(!options.allowedTools.includes("WebFetch"), "WebFetch is NOT in allowedTools — every call must route through canUseTool's URL guard");

  ok(HIGH_RISK_BUILTINS.length === 4, `HIGH_RISK_BUILTINS must now be exactly the 4 filesystem/execution tools, got ${JSON.stringify(HIGH_RISK_BUILTINS)}`);
  for (const risky of ["Bash", "Write", "Edit", "NotebookEdit"]) {
    ok(HIGH_RISK_BUILTINS.includes(risky), `${risky} is still in HIGH_RISK_BUILTINS`);
    ok(options.disallowedTools.includes(risky), `${risky} is still in disallowedTools`);
  }
  for (const noLongerRisky of ["WebSearch", "WebFetch", "Task"]) {
    ok(!HIGH_RISK_BUILTINS.includes(noLongerRisky), `${noLongerRisky} must no longer be in HIGH_RISK_BUILTINS`);
    ok(!options.disallowedTools.includes(noLongerRisky), `${noLongerRisky} must no longer be in disallowedTools`);
  }
}


// ---------------------------------------------------------------------------
// PreToolUse hook. Separate from canUseTool on purpose: hooks run FIRST in the
// SDK's permission pipeline and a hook deny holds even under a blanket
// permission mode, so this is the layer that survives someone later
// auto-approving WebFetch. The return SHAPE is the fragile part — the older
// `{decision:"block"}` form is deprecated, and a wrong shape yields a hook that
// runs, throws nothing, and blocks nothing.
// ---------------------------------------------------------------------------
{
  const { createWebFetchPreToolUseHook, readWebFetchUrl } = await import("../host/agent/policy/webfetch-url-guard.js");

  const hook = createWebFetchPreToolUseHook();
  const pre = (toolInput, extra = {}) =>
    hook({ hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: toolInput, ...extra });

  console.log("\n== PreToolUse hook: deny shape ==");
  const denied = await pre({ url: "http://127.0.0.1:8080/admin" });
  ok(!!denied.hookSpecificOutput, "a denial answers with hookSpecificOutput, not the deprecated decision/reason pair");
  ok(denied.hookSpecificOutput.permissionDecision === "deny", "permissionDecision is exactly 'deny'");
  ok(denied.hookSpecificOutput.hookEventName === "PreToolUse", "hookEventName is echoed inside hookSpecificOutput, where the SDK reads it");
  ok(typeof denied.hookSpecificOutput.permissionDecisionReason === "string" && denied.hookSpecificOutput.permissionDecisionReason.length > 0,
    "a reason is supplied — the SDK shows it to the model so it can stop retrying");
  ok(denied.decision === undefined && denied.reason === undefined, "the deprecated decision/reason fields are not emitted");

  console.log("\n== PreToolUse hook: allow is neutral, not an override ==");
  const allowed = await pre({ url: "https://example.com/docs" });
  ok(Object.keys(allowed).length === 0,
    "an ordinary URL returns {} — neutral, letting the normal permission flow proceed rather than force-approving it");

  console.log("\n== PreToolUse hook: fails closed ==");
  ok((await pre({})).hookSpecificOutput.permissionDecision === "deny", "a call with no readable url is denied, never allowed by default");
  ok((await pre(undefined)).hookSpecificOutput.permissionDecision === "deny", "a missing tool_input is denied");
  ok((await hook(undefined)).hookSpecificOutput.permissionDecision === "deny", "a malformed hook input is denied rather than thrown");
  ok((await pre({ url: "file:///etc/passwd" })).hookSpecificOutput.permissionDecision === "deny", "a non-http scheme is denied");

  console.log("\n== PreToolUse hook: a subagent denial is observable ==");
  const lines = [];
  const logged = createWebFetchPreToolUseHook({ log: (l) => lines.push(l) });
  await logged({ hook_event_name: "PreToolUse", tool_input: { url: "http://10.0.0.5/" }, agent_id: "sub_42" });
  ok(lines.length === 1 && lines[0].includes("sub_42"),
    "a denial inside a subagent records its agent_id — the only runtime evidence that parent-registered hooks reach Task subagents, which the SDK docs imply but never state outright");

  console.log("\n== both layers read the call identically ==");
  ok(readWebFetchUrl({ url: "https://a.test" }) === "https://a.test", "readWebFetchUrl reads the documented field");
  ok(readWebFetchUrl({ uri: "https://b.test" }) === "https://b.test", "...and the obvious alternates, since the field name is unverified against the pinned SDK types");
  ok(readWebFetchUrl({}) === "", "an unreadable shape yields empty, which the classifier denies — fail closed, not open");
}


console.log(fail === 0 ? "ALL WEBFETCH URL GUARD TESTS PASSED" : fail + " FAILED");
process.exit(fail ? 1 : 0);

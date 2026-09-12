#!/usr/bin/env node
//
// Task 9.1 (design.md section 8): send/submit-class classifier tests.
//   - isSendClassCall() narrows only `computer` and `javascript_tool`
//   - Reuses (does not duplicate) isMutatingCall()'s existing table —
//     a non-send call still executes with no prompt
//   - Every other browser tool stays in `allowedTools` unchanged
//   - computer and javascript_tool stay AVAILABLE in `tools` but are absent
//     from `allowedTools` (auto-approval) so every one of their calls reaches
//     `canUseTool`
//
// Run: node test/send-class-classifier.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../host/tool-definitions.js";
import {
  isSendClassCall,
  isMutatingCall
} from "../host/agent/tools/mapping.js";
import {
  createBrowserMcpServer,
  SDK_MCP_SERVER_NAME
} from "../host/agent/tools/adapter.js";
import {
  buildIsolatedOptions
} from "../host/agent/tools/query-options.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { Run } from "../host/agent/session/run.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function makeRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_sendclass_static", lease, approvals, tabScope });
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
    cwd: "/scratch/send-class-test",
    configDir: "/scratch/send-class-test/claude-config",
    pluginDir: "/scratch/send-class-test/skills-plugin",
    allowedSkillNames: [],
    skillOverrides: {}
  };
}

console.log("\nTask 9.1 — send/submit-class classifier\n");

await test("only computer and javascript_tool can return true from isSendClassCall — every other tool returns false", async () => {
  for (const t of TOOLS) {
    if (t.name !== "computer" && t.name !== "javascript_tool") {
      assert(isSendClassCall(t.name, { script: "x", action: "click" }) === false, `${t.name} must not be gated as send-class`);
    }
  }
});

await test("a non-click non-key computer action is not send-class — typing fill, scrolling, hovering, screenshot stay automatic", async () => {
  for (const action of ["screenshot", "zoom", "scroll", "scroll_to", "wait", "type", "drag", "hover"]) {
    assert(isSendClassCall("computer", { action }) === false, `computer ${action} must not be send-class`);
  }
});

await test("a plain click on a non-submit control is NOT send-class (still executes with no prompt)", async () => {
  assert(isSendClassCall("computer", { action: "click" }) === false, "plain click with no target hint must not be send-class");
  assert(isSendClassCall("computer", { action: "click" }, { tagName: "button", attributes: { type: "button" } }) === false, "click on button type=button is not send-class");
  assert(isSendClassCall("computer", { action: "click" }, { tagName: "a", attributes: {} }) === false, "click on a link is not send-class");
});

await test("a click on a submit-type control (English) IS send-class", async () => {
  assert(isSendClassCall("computer", { action: "click" }, { tagName: "input", attributes: { type: "submit" } }) === true, "click on <input type=submit> is send-class");
  assert(isSendClassCall("computer", { action: "click" }, { tagName: "button", attributes: { type: "submit" } }) === true, "click on <button type=submit> is send-class");
});

await test("a click on a submit-type control whose accessible name matches a localized (Vietnamese) submit keyword IS send-class", async () => {
  for (const kw of ["gửi", "xác nhận", "thanh toán", "đặt hàng"]) {
    assert(
      isSendClassCall("computer", { action: "click" }, { accessibleName: kw, tagName: "button", attributes: {} }) === true,
      `click on a button whose accessible name is "${kw}" must be send-class`
    );
  }
});

await test("a click on a submit-type control whose accessible name matches an English submit keyword IS send-class", async () => {
  for (const kw of ["submit", "send", "pay", "confirm", "checkout", "place order"]) {
    assert(
      isSendClassCall("computer", { action: "click" }, { accessibleName: kw, tagName: "button", attributes: {} }) === true,
      `click on a button whose accessible name is "${kw}" must be send-class`
    );
  }
});

await test("a key event Enter/Space on a submit-type control IS send-class", async () => {
  assert(isSendClassCall("computer", { action: "key", text: "Enter" }, { tagName: "button", attributes: { type: "submit" } }) === true, "key Enter on <button type=submit> is send-class");
  assert(isSendClassCall("computer", { action: "key", text: "Enter" }, { tagName: "a", attributes: {} }) === false, "key Enter on a link is not send-class");
});

await test("a javascript_tool script that calls .submit() IS send-class", async () => {
  assert(isSendClassCall("javascript_tool", { script: "document.querySelector('form').submit();" }) === true, ".submit() is send-class");
  assert(isSendClassCall("javascript_tool", { script: "const f = document.forms[0]; f.submit();" }) === true, ".submit() via variable is send-class");
});

await test("a javascript_tool script that dispatches a submit event IS send-class", async () => {
  assert(isSendClassCall("javascript_tool", { script: "form.dispatchEvent(new Event('submit'))" }) === true, "new Event('submit') dispatch is send-class");
  assert(isSendClassCall("javascript_tool", { script: "form.dispatchEvent(new SubmitEvent())" }) === true, "new SubmitEvent() dispatch is send-class");
});

await test("a javascript_tool script that calls requestSubmit() IS send-class", async () => {
  assert(isSendClassCall("javascript_tool", { script: "form.requestSubmit()" }) === true, "requestSubmit() is send-class");
});

await test("a javascript_tool script that mutates nothing but reads elements is NOT send-class", async () => {
  assert(isSendClassCall("javascript_tool", { script: "[...document.querySelectorAll('a')].slice(0, 20)" }) === false, "querySelectorAll slice is not send-class");
  assert(isSendClassCall("javascript_tool", { script: "document.title" }) === false, "read-only property access is not send-class");
  assert(isSendClassCall("javascript_tool", { script: "document.querySelector('.content').textContent" }) === false, "textContent read is not send-class");
});

await test("isMutatingCall() table is unchanged by 9.1 (non-send computer calls are still mutating, just not send-class)", async () => {
  // The classifier narrows, never replaces. A click on a non-submit control
  // is mutating (isMutatingCall=true) but NOT send-class (isSendClassCall=false).
  assert(isMutatingCall("computer", { action: "click" }) === true, "non-submit click is still mutating");
  assert(isSendClassCall("computer", { action: "click" }) === false, "non-submit click is not send-class");
  // A submit click is BOTH mutating AND send-class.
  assert(isMutatingCall("computer", { action: "click" }) === true);
  assert(isSendClassCall("computer", { action: "click" }, { tagName: "button", attributes: { type: "submit" } }) === true);
});

await test("query-options.js keeps `computer` and `javascript_tool` in `tools` (availability)", async () => {
  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
  const options = buildIsolatedOptions({ mcpServer, serverName: SDK_MCP_SERVER_NAME, snapshot: fakeSnapshot(), skills: fakeSkills() });
  assert(options.tools.includes(`mcp__${SDK_MCP_SERVER_NAME}__computer`), "`computer` must remain available in tools");
  assert(options.tools.includes(`mcp__${SDK_MCP_SERVER_NAME}__javascript_tool`), "`javascript_tool` must remain available in tools");
});

await test("query-options.js excludes `computer` and `javascript_tool` from `allowedTools` (task 9.1)", async () => {
  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
  const options = buildIsolatedOptions({ mcpServer, serverName: SDK_MCP_SERVER_NAME, snapshot: fakeSnapshot(), skills: fakeSkills() });
  assert(!options.allowedTools.includes(`mcp__${SDK_MCP_SERVER_NAME}__computer`), "`computer` must NOT be in allowedTools (task 9.1 — routed through canUseTool)");
  assert(!options.allowedTools.includes(`mcp__${SDK_MCP_SERVER_NAME}__javascript_tool`), "`javascript_tool` must NOT be in allowedTools (task 9.1)");
});

await test("query-options.js keeps every other (always-automatic) browser tool in `allowedTools` unchanged — task 9.1 says so", async () => {
  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
  const options = buildIsolatedOptions({ mcpServer, serverName: SDK_MCP_SERVER_NAME, snapshot: fakeSnapshot(), skills: fakeSkills() });
  // add-browser-batch-tool adds `browser_batch` to this excluded set for the
  // SAME reason `computer`/`javascript_tool` are there: a batch is one call
  // whose items can each be send/submit-class, and the gate must see the
  // items rather than auto-approving the whole tool. It therefore joins the
  // excluded set here instead of the always-automatic set this assertion
  // sweeps — the assertion's contract (every ALWAYS-AUTOMATIC tool stays
  // auto-approved) is unchanged and still enforced for all the others.
  const sendClassToolNames = new Set(["computer", "javascript_tool", "browser_batch"]);
  for (const t of TOOLS) {
    if (sendClassToolNames.has(t.name)) continue;
    const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${t.name}`;
    assert(options.allowedTools.includes(qualified), `${t.name} must remain in allowedTools (unchanged)`);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

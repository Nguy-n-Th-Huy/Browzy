import assert from "node:assert/strict";
import { extractFunction, compile } from "./_extract.mjs";
import { normalizeMonitorTarget, observedJsonSource, getMonitorSource, collectObservedResponses } from "../extension/page-monitor.js";
import { TOOLS } from "../host/tool-definitions.js";
import { sdkFacingDescription } from "../host/agent/tools/mapping.js";
import { renderBrowserAutomationSystemPrompt } from "../host/agent/tools/query-options.js";
import { NEXT_ACTION } from "../host/agent/jev/questions.js";
import { NEXT_STEP } from "../host/agent/jev/text-helper.js";

const target = normalizeMonitorTarget({
  identifier: "IB2600123456-00",
  url: "https://muasamcong.mpi.gov.vn/api/notice"
});
const body = JSON.stringify({ data: [{ id: "IB2600123456-00", status: "open" }] });
const record = {
  requestId: "req-1",
  url: target.url,
  method: "GET",
  responseBodyReady: false,
  timestamp: 1
};
const records = new Map([[7, [record]]]);
const calls = [];

const readObservedJsonResponses = compile(extractFunction("readObservedJsonResponses"), {
  ensureAttached: async () => calls.push("attach"),
  ensureDomain: async (_tabId, domain) => calls.push(`${domain}.enable`),
  networkRequests: records,
  networkByRequestId: new Map([[7, new Map([[record.requestId, record]])]]),
  getMonitorSource,
  observedJsonSource,
  collectObservedResponses,
  sleep: async () => {},
  cdp: async (_tabId, method, params) => {
    calls.push(method);
    if (method === "Page.reload") {
      const refreshed = { ...record, requestId: "req-after-reload", responseBodyReady: true, timestamp: 2 };
      records.set(7, [refreshed]);
      return {};
    }
    if (method === "Network.getResponseBody") return { body };
    throw new Error(`unexpected CDP method ${method}`);
  }
}, "readObservedJsonResponses");

const captured = await readObservedJsonResponses(7, target);
assert.equal(captured.length, 1, "a loaded tab is automatically reloaded when no completed body was observed");
assert.equal(captured[0].fields.id, target.identifier, "the matching identifier is selected from the captured JSON");
assert.ok(calls.includes("Page.reload"), "capture uses a bounded automatic reload instead of manual DevTools copying");
assert.ok(calls.includes("Network.getResponseBody"), "capture retrieves the response body through CDP");

const mscTool = TOOLS.find((tool) => tool.name === "page_monitor");
assert.ok(mscTool && /rendered DOM\/text snapshot, with optional observed JSON as a fallback/i.test(mscTool.description));
assert.match(sdkFacingDescription(mscTool), /Do not ask the user to open DevTools/i);
assert.match(sdkFacingDescription(mscTool), /After navigating to a requested detail page, call page_monitor directly with action=save/i);
assert.match(sdkFacingDescription(mscTool), /no page_monitor panel, webpage input, or on-page log/i);
assert.match(sdkFacingDescription(mscTool), /ok=true with action=save and status=saved confirms/i);
assert.match(renderBrowserAutomationSystemPrompt("browzy"), /never ask the user to copy JSON from DevTools/i);
assert.match(renderBrowserAutomationSystemPrompt("browzy"), /after you navigate to the requested detail page call mcp__browzy__page_monitor directly with action "save"/i);
assert.match(renderBrowserAutomationSystemPrompt("browzy"), /no visible page_monitor panel, webpage input, or on-page log/i);
assert.match(NEXT_ACTION, /call page_monitor with action=save directly after navigation/i);
assert.match(NEXT_ACTION, /ok=true\/action=save\/status=saved succeeds/i);
assert.match(NEXT_STEP, /Never ask for DevTools copying/i);

const pageMonitorReply = compile(extractFunction("pageMonitorReply"), {}, "pageMonitorReply");
const savedReply = pageMonitorReply({ ok: true, action: "save", status: "saved" });
assert.equal(savedReply.isError, undefined, "a successful save result is usable evidence");
assert.deepEqual(JSON.parse(savedReply.content[0].text), { ok: true, action: "save", status: "saved" });
const failedReply = pageMonitorReply({ ok: false, reason: "observed_json_response_not_found" });
assert.equal(failedReply.isError, true, "automatic capture failure is a structured tool error");
assert.equal(JSON.parse(failedReply.content[0].text).ok, false, "failure evidence remains structured JSON");

console.log("page-monitor capture tests passed");

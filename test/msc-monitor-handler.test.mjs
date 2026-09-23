import assert from "node:assert/strict";
import { extractMethod, compile } from "./_extract.mjs";
import {
  DEFAULT_INTERVAL_DAYS,
  DOM_TEXT_SOURCE,
  diffMonitorFields,
  normalizeMonitorTarget,
  selectObservedResponse
} from "../extension/page-monitor.js";

const replies = [];
const monitor = {
  id: "msc_test",
  kind: "TBMT",
  target: { identifier: "IB2600123456-00", url: null },
  intervalDays: 7,
  lastCheckedAt: new Date(Date.now() - 1000).toISOString(),
  baseline: { fields: { status: "open" } }
};
let responseCalls = 0;
const store = {
  async list() { return [{ id: monitor.id, intervalDays: monitor.intervalDays }]; },
  async find() { return monitor; },
  async save(input) { return { ...monitor, target: input.target, intervalDays: input.intervalDays, baseline: { fields: input.response.fields } }; },
  async recordCheck(id, result) { monitor.lastCheckedAt = result.checkedAt; monitor.lastResult = result; return monitor; },
  async delete(id) { return id === monitor.id; }
};

const handler = compile(`const H = { ${extractMethod("page_monitor")} };`, {
  isInGroup: async () => true,
  pageMonitorReply(value) { replies.push(value); return { content: [{ type: "text", text: JSON.stringify(value) }] }; },
  pageMonitorStore: store,
  normalizeMonitorTarget,
  readPageMonitorSnapshot: async () => null,
  DOM_TEXT_SOURCE,
  readObservedJsonResponses: async () => { responseCalls++; return [{ url: "https://example.test/api/record", fields: { status: "closed" }, body: "record-42", timestamp: Date.now() }]; },
  selectObservedResponse,
  diffMonitorFields,
  DEFAULT_INTERVAL_DAYS,
  getMonitorSource: () => ({ id: "observed_json", matches: () => true, normalize: () => ({}) }),
  observedJsonSource: { id: "observed_json" }
}, "H.page_monitor");

const notDue = JSON.parse((await handler({ tabId: 7, action: "check", monitorId: monitor.id })).content[0].text);
assert.equal(notDue.status, "not_due");
assert.equal(responseCalls, 0, "interval gating must avoid network/body reads");

const saved = JSON.parse((await handler({ tabId: 7, action: "save", identifier: monitor.target.identifier, kind: "TBMT", intervalDays: 1 })).content[0].text);
assert.equal(saved.status, "saved");
assert.equal(responseCalls, 1);

const deleted = JSON.parse((await handler({ tabId: 7, action: "delete", monitorId: monitor.id })).content[0].text);
assert.equal(deleted.deleted, true);
assert.equal(replies.length, 3);
console.log("page-monitor handler compatibility tests passed");

import assert from "node:assert/strict";
import {
  PageMonitorStore,
  collectObservedResponses,
  diffMonitorFields,
  normalizeObservedJsonResponse,
  normalizeMonitorTarget,
  selectObservedResponse,
  getMonitorSource,
  mscSource
} from "../extension/page-monitor.js";

const target = normalizeMonitorTarget({ identifier: "record-42", kind: "record" });

const body = JSON.stringify({
  data: [
    { id: "record-42", title: "  First value  ", budget: 1200, timestamp: "request-noise" },
    { id: "other-record", title: "Other record", budget: 99 }
  ],
  page: 1,
  pageSize: 20
});

const normalized = normalizeObservedJsonResponse(body, target);
assert.deepEqual(normalized.fields, {
  budget: 1200,
  id: "record-42",
  title: "First value"
});
assert.equal(normalized.matchedPath, "$.data[0]");

const diff = diffMonitorFields(
  { status: "open", budget: 1200, nested: { old: true }, list: ["a", "b"] },
  { status: "closed", budget: 1300, nested: { added: "x" }, list: ["b", "c"], extra: 1 }
);
assert.equal(diff.summary.total, 7);
assert.deepEqual(diff.changed.map((entry) => entry.path), ["budget", "list[0]", "list[1]", "status"]);
assert.deepEqual(diff.added.map((entry) => entry.path), ["extra", "nested.added"]);
assert.deepEqual(diff.removed.map((entry) => entry.path), ["nested.old"]);

assert.equal(selectObservedResponse([
  { url: "https://example.test/api/other", body, fields: {}, timestamp: 2 },
  { url: "https://example.test/api/record-42", body, fields: normalized.fields, timestamp: 1 }
], { ...target, url: "https://example.test/api/record-42" }).url,
"https://example.test/api/record-42");

const captured = await collectObservedResponses([
  { requestId: "1", url: "https://example.test/api/record", timestamp: 1 },
  { requestId: "2", url: "https://other.test/api/record", timestamp: 2 }
], async (record) => ({ body: record.requestId === "1" ? body : "{}" } ), target);
assert.equal(captured.length, 1);
assert.equal(captured[0].fields.id, "record-42");

assert.throws(() => normalizeMonitorTarget({ identifier: "record-42", url: "ftp://example.test/record" }), /http or https/);
assert.equal(getMonitorSource({ url: "https://muasamcong.mpi.gov.vn/record" }), mscSource);

const data = new Map();
const storage = {
  async get(key) { return { [key]: data.get(key) }; },
  async set(value) { for (const [key, item] of Object.entries(value)) data.set(key, item); }
};
const store = new PageMonitorStore(storage);
const saved = await store.save({ target, response: { url: "https://example.test/api/record", matchedPath: "$.data[0]", fields: normalized.fields }, intervalDays: 7, now: new Date("2026-09-20T00:00:00Z") });
assert.match(saved.id, /^page_/);
assert.equal((await store.list())[0].intervalDays, 7);
const checked = await store.recordCheck(saved.id, { status: "changed", diff: { summary: { total: 1 } } }, new Date("2026-09-27T00:00:00Z"));
assert.equal(checked.lastResult.status, "changed");
assert.equal((await store.list())[0].dueAt, "2026-10-04T00:00:00.000Z");
assert.equal(await store.delete(saved.id), true);
assert.equal((await store.list()).length, 0);

console.log("page-monitor compatibility tests passed");

import assert from "node:assert/strict";
import {
  DOM_TEXT_SOURCE,
  OBSERVED_JSON_SOURCE,
  PAGE_MONITOR_STORAGE_KEY,
  PageMonitorStore,
  collectObservedResponses,
  createTextSourceAdapter,
  diffMonitorFields,
  domTextSource,
  normalizeMonitorTarget,
  normalizeObservedJsonResponse,
  selectObservedResponse
} from "../extension/page-monitor.js";

const target = normalizeMonitorTarget({ identifier: "record-42", url: "https://example.test/api/items" });
const body = JSON.stringify({ data: [{ id: "record-42", title: "  First value  ", timestamp: "request-noise" }] });
const normalized = normalizeObservedJsonResponse(body, target);
assert.deepEqual(normalized.fields, { id: "record-42", title: "First value" });
assert.equal(normalized.matchedPath, "$.data[0]");

const captured = await collectObservedResponses([
  { requestId: "1", url: "https://example.test/api/items", timestamp: 1 },
  { requestId: "2", url: "https://other.test/api/items", timestamp: 2 }
], async (record) => ({ body: record.requestId === "1" ? body : "{}" }), target);
assert.equal(captured.length, 1);
assert.equal(captured[0].source, OBSERVED_JSON_SOURCE);
assert.equal(selectObservedResponse(captured, target).url, "https://example.test/api/items");

const diff = diffMonitorFields({ status: "open", nested: { old: true } }, { status: "closed", nested: { added: "x" } });
assert.equal(diff.summary.total, 3);

assert.equal(domTextSource.id, DOM_TEXT_SOURCE);
assert.deepEqual(domTextSource.normalize("  text from the page  ").fields, { text: "text from the page" });
const customTextSource = createTextSourceAdapter({ id: "custom_text", matches: () => true });
const text = await collectObservedResponses(
  [{ url: "https://example.test/page", timestamp: 3 }],
  async () => ({ body: "  DOM text  " }),
  normalizeMonitorTarget({ url: "https://example.test/page" }),
  customTextSource
);
assert.deepEqual(text[0].fields, { text: "DOM text" });

const data = new Map();
const storage = {
  async get(key) { return { [key]: data.get(key) }; },
  async set(value) { for (const [key, item] of Object.entries(value)) data.set(key, item); }
};
const store = new PageMonitorStore(storage);
const saved = await store.save({ target, response: { url: captured[0].url, matchedPath: captured[0].matchedPath, fields: captured[0].fields, source: OBSERVED_JSON_SOURCE }, now: new Date("2026-09-20T00:00:00Z") });
assert.match(saved.id, /^page_/);
assert.equal(saved.source, OBSERVED_JSON_SOURCE);
assert.equal(saved.target.source, OBSERVED_JSON_SOURCE);
assert.ok(data.has(PAGE_MONITOR_STORAGE_KEY));
assert.equal((await store.list())[0].source, OBSERVED_JSON_SOURCE);

// A generic identifier-only target (no URL, no MSC-style pattern match) must
// still resolve to a stable identity key so it can be saved and found again.
const genericTarget = normalizeMonitorTarget({ identifier: "record-42" });
const genericSaved = await store.save({
  target: genericTarget,
  response: { url: null, matchedPath: "$", fields: { text: "record-42 detail" }, source: DOM_TEXT_SOURCE },
  now: new Date("2026-09-20T00:00:00Z")
});
assert.match(genericSaved.id, /^page_/);
const foundGeneric = await store.find({ target: genericTarget });
assert.equal(foundGeneric.id, genericSaved.id);

console.log("page-monitor tests passed");

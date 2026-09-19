#!/usr/bin/env node
//
// The `page_snapshots` tool: all five actions end-to-end through the factory,
// with an injected tool() stand-in and a scratch-rooted store, plus the wiring
// proof that the tool is both REGISTERED and VISIBLE in companion.js.
//
// Every guard is asserted as an `isError` RESULT naming a reason — never as a
// thrown error — because a thrown error would abort the run instead of letting
// the model adapt. The compare path is exercised with the REAL DocumentStore on
// the scratch root, so "the report is written through the existing document
// path" is proven by the bytes on disk, not by a call log.
//
// Run: node host/test/page-snapshots-tool.test.mjs
//      (also runnable as `node --test test/page-snapshots-tool.test.mjs`)

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-snap-tool-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

const { createPageSnapshotsTool, PAGE_SNAPSHOTS_TOOL_NAME } = await import("../agent/tools/page-snapshots.js");
const { SnapshotStore, urlHash } = await import("../agent/snapshots/store.js");
const { DocumentStore, DocumentLimitError } = await import("../agent/documents/store.js");
const { snapshotsRoot, snapshotUrlDir, conversationDocumentsDir } = await import("../agent/storage/paths.js");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/** A tool() stand-in: records the registration and exposes the handler. */
function fakeToolFactory() {
  const captured = {};
  const factory = (name, description, paramShape, handler) => {
    captured.name = name;
    captured.description = description;
    captured.paramShape = paramShape;
    captured.handler = handler;
    return { name, description, handler };
  };
  return { factory, captured };
}

/** A Run stand-in that only collects emitted events. */
function fakeRun(runId = "run_snap_1") {
  const emitted = [];
  return { runId, emitted, emit: (e) => emitted.push(e) };
}

const BASE_CLOCK = Date.parse("2026-09-18T10:00:00.000Z");
function tickingClock() {
  let tick = 0;
  return () => BASE_CLOCK + tick++ * 1000;
}

let conversationCounter = 0;
function freshConversation() {
  conversationCounter += 1;
  return `conv_snap_${conversationCounter}`;
}

/** Build the tool and return a call helper over its captured handler. */
async function buildTool({ reportStore } = {}) {
  const { factory, captured } = fakeToolFactory();
  const run = fakeRun();
  await createPageSnapshotsTool({
    run,
    conversationId: freshConversation(),
    toolFactory: factory,
    now: tickingClock(),
    ...(reportStore ? { reportStore } : {})
  });
  const call = async (args) => {
    let result;
    try {
      result = await captured.handler(args);
    } catch (err) {
      throw new Error(`the handler THREW instead of returning an error result: ${err.message}`);
    }
    return {
      ok: result.isError !== true,
      text: result.content[0].text,
      isError: result.isError === true
    };
  };
  return { captured, run, call };
}

/** The tool's own error text always carries the reason in parentheses. */
function assertReason(result, reason) {
  assert(result.ok === false, `expected an error result, got: ${result.text}`);
  assert(result.text.includes(`(${reason})`), `expected reason ${reason} in: ${result.text}`);
}

function savedPath(text) {
  const match = /at (.+?)\. (?:Compare|Its)/.exec(text);
  assert(match, `could not find the stored path in: ${text}`);
  return match[1];
}

// --- registration ---------------------------------------------------------

await test("the tool registers under its exported name with the five actions", async () => {
  const { captured } = await buildTool();
  assert(captured.name === PAGE_SNAPSHOTS_TOOL_NAME, `registered as ${captured.name}`);
  assert(captured.description.includes("save") && captured.description.includes("compare"), "the description names the actions");
  // The model must not be able to name a conversation (that binding is the
  // host's), and the tool must never be handed a browser/page handle.
  assert(!("conversationId" in captured.paramShape), "no conversation id parameter");
  assert(!("tabId" in captured.paramShape), "no tab handle: this tool reads no page");
  const action = captured.paramShape.action;
  for (const name of ["save", "list", "get", "delete", "compare"]) {
    assert(action.parse(name) === name, `action ${name} must be accepted`);
  }
  let rejected = false;
  try {
    action.parse("explode");
  } catch {
    rejected = true;
  }
  assert(rejected, "an unknown action must be rejected by the declared shape");
});

await test("companion.js both registers the tool and names it in extraToolNames", async () => {
  // The documented invisible-tool trap: a tool registered on the MCP server
  // without its name in extraToolNames is callable by nobody. Both sites are
  // asserted here because nothing else in the suite can drive a live run.
  const source = fs.readFileSync(path.join(REPO_ROOT, "host", "agent", "companion.js"), "utf8");
  assert(
    /import \{[^}]*PAGE_SNAPSHOTS_TOOL_NAME[^}]*\} from "\.\/tools\/page-snapshots\.js"/.test(source),
    "the tool's name constant must be imported"
  );
  const extraTools = /extraTools: \[([^\]]*)\]/.exec(source);
  assert(extraTools && extraTools[1].includes("pageSnapshotsTool"), `extraTools must list the tool: ${extraTools && extraTools[1]}`);
  const extraToolNames = /extraToolNames: \[([^\]]*)\]/.exec(source);
  assert(
    extraToolNames && extraToolNames[1].includes("PAGE_SNAPSHOTS_TOOL_NAME"),
    `extraToolNames must name the tool: ${extraToolNames && extraToolNames[1]}`
  );
  assert(/snapshotStore/.test(source), "the companion must carry the injectable snapshotStore");
});

// --- save -----------------------------------------------------------------

await test("save writes the snapshot, emits metadata only, and returns path + timestamp", async () => {
  const { run, call } = await buildTool();
  const url = "https://vi.example.com/save";
  const result = await call({
    action: "save",
    name: "Giá vàng",
    url,
    title: "Giá vàng hôm nay",
    fields: { buy: 89_000_000, sell: 91_000_000 },
    viewport: "1280x800"
  });
  assert(result.ok, `save failed: ${result.text}`);
  const filePath = savedPath(result.text);
  assert(filePath.startsWith(snapshotUrlDir(urlHash(url))), `path was outside the URL directory: ${filePath}`);
  assert(fs.existsSync(filePath), "the snapshot really is on disk");
  const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert(result.text.includes(record.timestamp), `the capture time is returned: ${result.text}`);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.timestamp), `ISO 8601 UTC: ${record.timestamp}`);

  assert(record.name === "Giá vàng" && record.url === url && record.title === "Giá vàng hôm nay", "identity stored");
  assert(record.fields.buy === 89_000_000, "the fields the caller supplied are stored verbatim");
  assert(record.metadata.runId === "run_snap_1", "the run is recorded");
  assert(record.metadata.viewport === "1280x800", "the viewport is recorded when supplied");

  assert(run.emitted.length === 1 && run.emitted[0].type === "snapshot_saved", `event: ${JSON.stringify(run.emitted)}`);
  const event = run.emitted[0];
  assert(event.path === filePath && event.timestamp === record.timestamp, "the event carries the capture identity");
  assert(!("fields" in event), "the event must not carry the field payload");
});

await test("save rejects a hostile name, a bad URL, and unusable fields without writing", async () => {
  const { call } = await buildTool();
  const url = "https://vi.example.com/guards";
  const before = fs.existsSync(snapshotsRoot()) ? fs.readdirSync(snapshotsRoot()).length : 0;

  assertReason(await call({ action: "save", name: "", url, fields: {} }), "empty_name");
  assertReason(await call({ action: "save", name: "../../etc/passwd", url, fields: {} }), "unsafe_name");
  assertReason(await call({ action: "save", name: "a/b", url, fields: {} }), "unsafe_name");
  assertReason(await call({ action: "save", name: "x".repeat(500), url, fields: {} }), "name_too_long");
  assertReason(await call({ action: "save", name: "ok", url: "", fields: {} }), "missing_url");
  assertReason(await call({ action: "save", name: "ok", url: "not a url", fields: {} }), "invalid_url");
  assertReason(await call({ action: "save", name: "ok", url, fields: [1, 2, 3] }), "invalid_fields");
  assertReason(await call({ action: "save", name: "ok", url, fields: { big: "x".repeat(2 * 1024 * 1024) } }), "fields_too_large");
  assertReason(await call({ action: "save", name: "ok", url, fields: { bad: undefined } }), "fields_not_serializable");

  assert(!fs.existsSync(snapshotUrlDir(urlHash(url))), "no rejected save created the URL directory");
  assert((fs.existsSync(snapshotsRoot()) ? fs.readdirSync(snapshotsRoot()).length : 0) === before, "no directory was added");
});

await test("a storage failure is named and the comparison tool still answers", async () => {
  const { call } = await buildTool();
  const url = "https://vi.example.com/storage";
  fs.writeFileSync(snapshotUrlDir(urlHash(url)), "blocking file", "utf8");
  const result = await call({ action: "save", name: "ok", url, fields: { a: 1 } });
  assertReason(result, "storage_failed");
});

// --- list / get / delete --------------------------------------------------

await test("list reports entries, states its filters, and tolerates an empty store", async () => {
  const { call } = await buildTool();
  const previousRoot = process.env.OCIC_AGENT_HOME;
  process.env.OCIC_AGENT_HOME = path.join(scratchRoot, "root-trong");
  try {
    const empty = await call({ action: "list" });
    assert(empty.ok && /none stored/.test(empty.text), `empty listing: ${empty.text}`);
  } finally {
    process.env.OCIC_AGENT_HOME = previousRoot;
  }

  const url = "https://vi.example.com/list";
  await call({ action: "save", name: "Sáng", url, fields: { v: 1 } });
  await call({ action: "save", name: "Chiều", url, fields: { v: 2 } });
  await call({ action: "save", name: "Khác", url: "https://vi.example.com/list/khac", fields: { v: 3 } });

  const all = await call({ action: "list" });
  assert(all.ok, `unfiltered listing failed: ${all.text}`);
  for (const name of ["Sáng", "Chiều", "Khác"]) {
    assert(all.text.includes(`"${name}"`), `unfiltered listing must include ${name}: ${all.text}`);
  }
  const filtered = await call({ action: "list", url, namePattern: "Chiều" });
  assert(filtered.ok, `filtered listing failed: ${filtered.text}`);
  assert(filtered.text.includes("1 snapshot") && filtered.text.includes("Chiều"), `filtered listing: ${filtered.text}`);
  assert(!filtered.text.includes("Sáng"), "only the match is listed");
  assert(filtered.text.includes(`filter: url=${JSON.stringify(url)}, namePattern="Chiều"`), `the filter is stated: ${filtered.text}`);
  assert(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(filtered.text), `the capture time is listed: ${filtered.text}`);
});

await test("get returns the full record and names the reason when it cannot", async () => {
  const { call } = await buildTool();
  const url = "https://vi.example.com/get";
  await call({ action: "save", name: "Có", url, title: "T", fields: { a: { deep: [1, 2] } } });
  const got = await call({ action: "get", name: "Có", url });
  assert(got.ok, `get failed: ${got.text}`);
  const record = JSON.parse(got.text.slice(got.text.indexOf("{")));
  assert(record.fields.a.deep[1] === 2, "the full record round-trips");
  assert(record.metadata.conversationId.startsWith("conv_snap_"), "the capture conversation is recorded");

  assertReason(await call({ action: "get", name: "Không có", url }), "not_found");
  assertReason(await call({ action: "get", name: "Có" }), "missing_url");
  assertReason(await call({ action: "get", name: "Có", url: "https://vi.example.com/get-khac" }), "not_found");

  const broken = path.join(snapshotUrlDir(urlHash(url)), "hong-2026-09-18T09-00-00-000Z.json");
  fs.writeFileSync(broken, "{ not json", "utf8");
  const corrupt = await call({ action: "get", path: broken });
  assertReason(corrupt, "invalid_json");
  assert(corrupt.text.includes("hong-2026-09-18T09-00-00-000Z.json"), `the failing file must be named: ${corrupt.text}`);

  assertReason(await call({ action: "get", path: path.join(scratchRoot, "outside.json") }), "unsafe_path");
  assertReason(await call({ action: "get", path: broken }), "invalid_json");
});

await test("delete removes one snapshot, prunes the directory, and refuses anything else", async () => {
  const { call } = await buildTool();
  const url = "https://vi.example.com/delete";
  await call({ action: "save", name: "Một", url, fields: { v: 1 } });
  const second = await call({ action: "save", name: "Hai", url, fields: { v: 2 } });
  const dir = snapshotUrlDir(urlHash(url));
  assert(fs.existsSync(dir), "the URL directory exists first");

  assertReason(await call({ action: "delete", name: "Hai", url: "https://vi.example.com/delete-khac" }), "not_found");
  assertReason(await call({ action: "delete", path: path.join(scratchRoot, "outside.json") }), "unsafe_path");

  const removed = await call({ action: "delete", name: "Hai", url });
  assert(removed.ok && /Deleted snapshot/.test(removed.text), `delete failed: ${removed.text}`);
  assert(!removed.text.includes("now removed"), "the directory still holds a sibling");
  assert(fs.existsSync(dir), "the directory survives while a snapshot remains");

  const last = await call({ action: "delete", name: "Một", url });
  assert(last.ok && last.text.includes("now removed"), `the emptied directory must be pruned: ${last.text}`);
  assert(!fs.existsSync(dir), "the directory is gone");
  assert(second.ok, "the earlier save succeeded");
});

// --- compare --------------------------------------------------------------

async function seedTwoSnapshots(call, url, { baselineFields, currentFields }) {
  const first = await call({ action: "save", name: "baseline", url, title: "Trang", fields: baselineFields });
  const second = await call({ action: "save", name: "current", url, title: "Trang", fields: currentFields });
  assert(first.ok && second.ok, `seeding failed: ${first.text} / ${second.text}`);
  return { baselinePath: savedPath(first.text), currentPath: savedPath(second.text) };
}

await test("compare returns both report forms and names the document it wrote", async () => {
  const conversationId = freshConversation();
  const { factory, captured } = fakeToolFactory();
  const run = fakeRun();
  const documentStore = new DocumentStore();
  await createPageSnapshotsTool({ run, conversationId, toolFactory: factory, now: tickingClock(), reportStore: documentStore });
  const call = async (args) => {
    const result = await captured.handler(args);
    return { ok: result.isError !== true, text: result.content[0].text };
  };

  const url = "https://vi.example.com/so-sanh";
  const { baselinePath, currentPath } = await seedTwoSnapshots(call, url, {
    baselineFields: { price: 100, tags: ["a", "b"], removed: "x" },
    currentFields: { price: 120, tags: ["b", "a"], added: true }
  });

  const result = await call({
    action: "compare",
    baseline: { name: "baseline", url },
    current: { path: currentPath }
  });
  assert(result.ok, `compare failed: ${result.text}`);
  assert(result.text.includes("## Added") && result.text.includes("## Removed") && result.text.includes("## Changed"), "markdown sections");
  assert(result.text.includes("--- json report ---"), "the JSON form is returned in the same call");
  const json = JSON.parse(result.text.slice(result.text.indexOf("--- json report ---") + "--- json report ---".length));
  assert(json.baseline.name === "baseline" && json.current.name === "current", "both identities are in the JSON form");
  assert(json.baseline.timestamp && json.current.timestamp, "both capture times are carried");
  assert(json.current.timestamp > json.baseline.timestamp, `captures are ordered in time: ${json.baseline.timestamp} → ${json.current.timestamp}`);
  assert(json.summary.added === 1 && json.summary.removed === 1 && json.summary.changed === 1 && json.summary.reordered === 1, `summary: ${JSON.stringify(json.summary)}`);
  assert(json.comparison.baselinePath === baselinePath, "the JSON form names the baseline file");
  assert(json.comparison.currentPath === currentPath, "and the current file");

  const documentId = json.document && json.document.documentId;
  assert(documentId, `the created document must be named: ${JSON.stringify(json.document)}`);
  assert(result.text.includes(documentId), "the result names the created document");
  const stored = documentStore.read(conversationId, documentId);
  assert(stored.found === true, "the report document really exists on disk");
  assert(stored.buffer.toString("utf8").includes("`price`"), "the stored document is the markdown report");
  assert(fs.existsSync(conversationDocumentsDir(conversationId)), "it went through the conversation's documents directory");

  const compared = run.emitted.filter((event) => event.type === "snapshot_compared");
  assert(compared.length === 1, "one comparison event");
  assert(compared[0].summary.total === 4 && compared[0].documentId === documentId, `event: ${JSON.stringify(compared[0])}`);
  assert(!("fields" in compared[0]) && !("markdown" in compared[0]), "the event carries no payload");
});

await test("compare can skip the document, and reports no changes honestly", async () => {
  const conversationId = freshConversation();
  const { factory, captured } = fakeToolFactory();
  await createPageSnapshotsTool({
    run: fakeRun(),
    conversationId,
    toolFactory: factory,
    now: tickingClock()
  });
  const call = async (args) => {
    const result = await captured.handler(args);
    return { ok: result.isError !== true, text: result.content[0].text };
  };
  const url = "https://vi.example.com/khong-doi";
  await seedTwoSnapshots(call, url, { baselineFields: { a: 1 }, currentFields: { a: 1 } });

  const result = await call({
    action: "compare",
    baseline: { name: "baseline", url },
    current: { name: "current", url },
    writeReport: false
  });
  assert(result.ok, `compare failed: ${result.text}`);
  assert(result.text.includes("No changes detected"), `must report no changes: ${result.text}`);
  assert(!/saved as the document/.test(result.text), "no document was written");
  assert(!fs.existsSync(conversationDocumentsDir(conversationId)), "and no documents directory was created");
  const json = JSON.parse(result.text.slice(result.text.indexOf("--- json report ---") + "--- json report ---".length));
  assert(json.summary.total === 0 && json.added.length === 0 && json.removed.length === 0 && json.changed.length === 0, "every list is empty");
});

await test("a failed document write never fails the comparison", async () => {
  const failingStore = {
    write: async () => {
      throw new DocumentLimitError("source_too_large", "content is 3000000 bytes, over the 2097152-byte limit");
    }
  };
  const { call } = await buildTool({ reportStore: failingStore });
  const url = "https://vi.example.com/ghi-loi";
  await seedTwoSnapshots(call, url, { baselineFields: { a: 1 }, currentFields: { a: 2 } });

  const result = await call({ action: "compare", baseline: { name: "baseline", url }, current: { name: "current", url } });
  assert(result.ok, `the comparison must still succeed: ${result.text}`);
  assert(result.text.includes("could NOT be saved as a document") && result.text.includes("source_too_large"), result.text);
  const json = JSON.parse(result.text.slice(result.text.indexOf("--- json report ---") + "--- json report ---".length));
  assert(json.summary.total === 1 && json.changed[0].path === "a", "the diff is still returned");
  assert(json.document.error === "source_too_large", "the JSON form notes the document failure");
});

await test("compare names WHICH side failed, and never presents a partial report", async () => {
  const { call } = await buildTool();
  const url = "https://vi.example.com/thieu";
  await seedTwoSnapshots(call, url, { baselineFields: { a: 1 }, currentFields: { a: 2 } });

  const missingBaseline = await call({ action: "compare", baseline: { name: "khong-co", url }, current: { name: "current", url } });
  assertReason(missingBaseline, "baseline_not_found");
  assert(missingBaseline.text.includes("baseline"), "the failing side is named");

  const missingCurrent = await call({ action: "compare", baseline: { name: "baseline", url }, current: { name: "khong-co", url } });
  assertReason(missingCurrent, "current_not_found");

  const noRefs = await call({ action: "compare" });
  assertReason(noRefs, "missing_baseline");

  const outside = await call({ action: "compare", baseline: { path: path.join(scratchRoot, "outside.json") }, current: { name: "current", url } });
  assertReason(outside, "baseline_unsafe_path");
  assert(!outside.text.includes("--- json report ---"), "no partial report is presented");
});

await test("compare uses the newest capture when a name alone is given", async () => {
  const { call } = await buildTool();
  const url = "https://vi.example.com/moi-nhat";
  await call({ action: "save", name: "theo dõi", url, fields: { v: 1 } });
  await call({ action: "save", name: "theo dõi", url, fields: { v: 2 } });
  await call({ action: "save", name: "khác", url, fields: { v: 9 } });

  const result = await call({ action: "compare", baseline: { name: "theo dõi", url }, current: { name: "khác", url }, writeReport: false });
  assert(result.ok, `compare failed: ${result.text}`);
  const json = JSON.parse(result.text.slice(result.text.indexOf("--- json report ---") + "--- json report ---".length));
  assert(json.baseline.fields === undefined, "the report carries identity, not the whole record");
  assert(json.changed[0].old === 2 && json.changed[0].new === 9, `the NEWEST capture is the baseline: ${JSON.stringify(json.changed)}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

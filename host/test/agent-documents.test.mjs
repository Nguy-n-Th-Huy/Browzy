#!/usr/bin/env node
//
// Agent-created documents: the store's guards, the create_document tool's
// handler, and the companion's document_request / document_list_request wire
// replies.
//
// Everything here runs against the REAL modules on a scratch OCIC_AGENT_HOME —
// no live browser, no native-messaging pipe, no SDK. The tool is built with an
// injected tool() factory (the same technique agent-tool-adapter.test.mjs uses
// for the browser tools) so the handler can be called directly and its emitted
// event inspected, without a real query() run.
//
// Run: node host/test/agent-documents.test.mjs

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-documents-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

const { DocumentStore, DocumentLimitError, slugifyTitle, MAX_SOURCE_BYTES, MAX_DOCUMENTS_PER_CONVERSATION } = await import(
  "../agent/documents/store.js"
);
const { DOCUMENT_FORMATS, renderDocument } = await import("../agent/documents/render/index.js");
const { createCreateDocumentTool, CREATE_DOCUMENT_TOOL_NAME } = await import("../agent/tools/create-document.js");
const { conversationDocumentsDir, conversationDir } = await import("../agent/storage/paths.js");

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
async function rejects(fn, reason) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof DocumentLimitError, `expected DocumentLimitError, got ${err.name}: ${err.message}`);
    assert(err.reason === reason, `expected reason ${reason}, got ${err.reason}`);
    return err;
  }
  throw new Error(`expected a rejection with reason ${reason}, but the call resolved`);
}

let convCounter = 0;
function freshConversation() {
  convCounter += 1;
  return `conv_doc_${convCounter}`;
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
function fakeRun(runId = "run_doc_1") {
  const emitted = [];
  return { runId, emitted, emit: (e) => emitted.push(e) };
}

// --- slug -----------------------------------------------------------------

await test("slugifyTitle strips diacritics and never yields a path segment", () => {
  assert(slugifyTitle("Phân tích dauthau asia") === "phan-tich-dauthau-asia", "vietnamese title");
  assert(slugifyTitle("Đầu tư 2026") === "dau-tu-2026", "đ maps to d");
  assert(slugifyTitle("../../etc/passwd") === "etc-passwd", "traversal characters are dropped");
  assert(slugifyTitle("  ...  ") === "document", "a title with no slug characters falls back");
  assert(slugifyTitle("日本語だけ") === "document", "a title the slug alphabet cannot represent falls back");
  assert(slugifyTitle("x".repeat(500)).length <= 80, "slug is bounded");
});

// --- store: the happy path ------------------------------------------------

await test("write() stores bytes plus a metadata sidecar inside the conversation", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();
  const record = await store.write({
    conversationId,
    title: "Phân tích dauthau asia",
    format: "md",
    content: "# Tiêu đề\n\nnội dung\n"
  });

  assert(record.fileName === "phan-tich-dauthau-asia.md", `filename was ${record.fileName}`);
  assert(record.format === "md" && record.mimeType === "text/markdown", "format metadata");
  assert(record.byteLength > 0, "byte length recorded");
  assert(record.title === "Phân tích dauthau asia", "the real title survives verbatim in metadata");

  const dir = conversationDocumentsDir(conversationId);
  const names = fs.readdirSync(dir).sort();
  assert(names.length === 2, `expected a data+sidecar pair, got ${names.join(",")}`);
  // The ON-DISK name is the host-minted id, never the model's title — the
  // title only ever influences the DOWNLOAD filename.
  assert(names.every((n) => n.startsWith(record.documentId)), "both files are named by the host-minted id");

  const read = store.read(conversationId, record.documentId);
  assert(read.found === true, "stored document reads back");
  assert(read.buffer.toString("utf8") === "# Tiêu đề\n\nnội dung\n", "bytes round-trip");
  assert(read.fileName === record.fileName, "read carries the metadata");
});

await test("list() returns records oldest-first and survives a corrupt sidecar", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();
  const a = await store.write({ conversationId, title: "First", content: "a" });
  const b = await store.write({ conversationId, title: "Second", content: "b" });
  fs.writeFileSync(path.join(conversationDocumentsDir(conversationId), "broken.json"), "{not json", "utf8");

  const listed = store.list(conversationId);
  assert(listed.length === 2, `expected 2 records, got ${listed.length}`);
  assert(listed[0].documentId === a.documentId && listed[1].documentId === b.documentId, "ordered oldest first");
});

await test("list() on a conversation with no documents is empty, never a throw", () => {
  assert(new DocumentStore().list(freshConversation()).length === 0);
});

// --- store: the guards ----------------------------------------------------

await test("a title full of path characters cannot escape the documents directory", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();
  const record = await store.write({ conversationId, title: "../../../../etc/passwd", content: "x" });
  const dir = conversationDocumentsDir(conversationId);
  const written = fs.readdirSync(dir);
  assert(written.length === 2, "the write landed as a normal pair");
  // Nothing was created anywhere above the conversation's own directory.
  const parentEntries = fs.readdirSync(path.dirname(conversationDir(conversationId)));
  assert(!parentEntries.includes("etc"), "no directory was created outside the conversation");
  assert(record.fileName === "etc-passwd.md", `download name was ${record.fileName}`);
});

await test("oversized, empty, and unsupported input is rejected without writing", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();

  await rejects(() => store.write({ conversationId, title: "", content: "x" }), "missing_title");
  await rejects(() => store.write({ conversationId, title: "T", content: "" }), "empty_content");
  await rejects(() => store.write({ conversationId, title: "T", format: "exe", content: "x" }), "unsupported_format");
  await rejects(
    () => store.write({ conversationId, title: "T", content: "x".repeat(MAX_SOURCE_BYTES + 1) }),
    "source_too_large"
  );

  // Not one of those four attempts may leave a file behind.
  let entries = [];
  try {
    entries = fs.readdirSync(conversationDocumentsDir(conversationId));
  } catch {}
  assert(entries.length === 0, `a rejected write left files behind: ${entries.join(",")}`);
});

await test("the per-conversation document count is capped", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();
  for (let i = 0; i < MAX_DOCUMENTS_PER_CONVERSATION; i += 1) {
    await store.write({ conversationId, title: `Doc ${i}`, content: "x" });
  }
  await rejects(() => store.write({ conversationId, title: "One too many", content: "x" }), "too_many_documents");
});

await test("read() of an unknown or gutted document reports found:false with a reason", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();
  assert(store.read(conversationId, "nope").found === false, "unknown id");
  assert(store.read(conversationId, "nope").reason === "not_found", "unknown id reason");

  const record = await store.write({ conversationId, title: "Gone soon", content: "x" });
  fs.rmSync(path.join(conversationDocumentsDir(conversationId), `${record.documentId}.md`));
  const gutted = store.read(conversationId, record.documentId);
  assert(gutted.found === false && gutted.reason === "bytes_missing", `expected bytes_missing, got ${gutted.reason}`);
});

// --- text format rendering ------------------------------------------------

await test("json content must actually be JSON; html fragments get a document wrapper", async () => {
  const store = new DocumentStore();
  const conversationId = freshConversation();

  let threw = false;
  try {
    await store.write({ conversationId, title: "Bad json", format: "json", content: "not json at all" });
  } catch (err) {
    threw = true;
    assert(/not valid JSON/.test(err.message), `unexpected message: ${err.message}`);
  }
  assert(threw, "invalid JSON must be rejected, not stored under a .json name");

  const wrapped = await renderDocument("html", "<p>hi</p>", { title: "A & B" });
  const text = wrapped.toString("utf8");
  assert(text.startsWith("<!doctype html>"), "fragment was wrapped");
  assert(text.includes("<title>A &amp; B</title>"), "the title is escaped into the wrapper");

  const passthrough = await renderDocument("html", "<html><body>x</body></html>", { title: "t" });
  assert(!passthrough.toString("utf8").startsWith("<!doctype html>\n<html lang"), "a full document is not double-wrapped");
});

await test("every declared format has an extension, a mime type and a label", () => {
  for (const [key, spec] of Object.entries(DOCUMENT_FORMATS)) {
    assert(spec.ext && spec.mimeType && spec.label, `format ${key} is incompletely declared`);
    assert(typeof spec.binary === "boolean", `format ${key} does not declare binary-ness`);
  }
});

// --- the tool -------------------------------------------------------------

await test("the tool writes the document and emits metadata only", async () => {
  const { factory, captured } = fakeToolFactory();
  const run = fakeRun();
  const conversationId = freshConversation();
  await createCreateDocumentTool({ run, conversationId, toolFactory: factory, now: () => 1234 });

  assert(captured.name === CREATE_DOCUMENT_TOOL_NAME, `registered as ${captured.name}`);
  assert(!("conversationId" in captured.paramShape), "the model must not be able to name a conversation");

  const result = await captured.handler({ title: "Báo cáo tuần", content: "# Tuần 1\n", format: "md" });
  assert(result.isError !== true, `tool errored: ${JSON.stringify(result)}`);

  assert(run.emitted.length === 1, "exactly one event emitted");
  const event = run.emitted[0];
  assert(event.type === "document_created", `event type was ${event.type}`);
  assert(event.title === "Báo cáo tuần" && event.format === "md", "event carries card metadata");
  assert(event.byteLength > 0 && event.fileName === "bao-cao-tuan.md", "event carries filename and size");
  // The whole point of fetching bytes on demand: they are NOT on the event.
  assert(!("content" in event) && !("buffer" in event) && !("bytes" in event), "the event must not carry bytes");

  const stored = new DocumentStore().read(conversationId, event.documentId);
  assert(stored.found === true && stored.buffer.toString("utf8") === "# Tuần 1\n", "the file is really on disk");
});

await test("a rejected tool call reports the reason and emits nothing", async () => {
  const { factory, captured } = fakeToolFactory();
  const run = fakeRun();
  await createCreateDocumentTool({ run, conversationId: freshConversation(), toolFactory: factory });

  const result = await captured.handler({ title: "T", content: "", format: "md" });
  assert(result.isError === true, "an empty document must be an error result");
  assert(/empty_content/.test(result.content[0].text), `reason missing from: ${result.content[0].text}`);
  assert(run.emitted.length === 0, "a failed write must not emit a card event");
});

await test("the tool is bound to its own conversation, not to anything in args", async () => {
  const { factory, captured } = fakeToolFactory();
  const mine = freshConversation();
  const other = freshConversation();
  await createCreateDocumentTool({ run: fakeRun(), conversationId: mine, toolFactory: factory });

  // Even if a model invents a conversationId argument, it is ignored: the
  // document lands in the bound conversation.
  const result = await captured.handler({ title: "Leak attempt", content: "x", conversationId: other });
  assert(result.isError !== true, "the call itself succeeds");
  assert(new DocumentStore().list(other).length === 0, "nothing was written to the other conversation");
  assert(new DocumentStore().list(mine).length === 1, "the document landed in the bound conversation");
});

// --- lifetime -------------------------------------------------------------

await test("deleting a conversation takes its documents with it", async () => {
  // The lifetime promise the spec makes: a document lives exactly as long as
  // its conversation. Asserted against the real SessionManager rather than by
  // reading that its rmSync covers the directory.
  const { SessionManager } = await import("../agent/session/manager.js");
  const { TranscriptStore } = await import("../agent/storage/transcript-store.js");
  const manager = new SessionManager({ store: new TranscriptStore() });
  const conversationId = manager.newConversation();

  const store = new DocumentStore();
  const record = await store.write({ conversationId, title: "Sẽ bị xoá", content: "x" });
  assert(store.read(conversationId, record.documentId).found === true, "the document exists first");
  assert(fs.existsSync(conversationDocumentsDir(conversationId)), "the documents directory exists first");

  manager.deleteConversation(conversationId);
  assert(!fs.existsSync(conversationDocumentsDir(conversationId)), "the documents directory outlived its conversation");
  const gone = store.read(conversationId, record.documentId);
  assert(gone.found === false, "the document is still readable after its conversation was deleted");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

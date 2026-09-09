#!/usr/bin/env node
// The panel half of agent-created documents: the chunk reassembler, the fetch
// client's request/reply correlation, the document_created transcript item,
// and the format -> representation routing.
//
// The reassembler is exercised against the REAL host chunker
// (host/agent/broker/chunked-transport.js) rather than a hand-written
// envelope: the two ends of that wire only agree if one is tested against the
// other's actual output.
//
// Run: node test/sidepanel-documents.test.mjs

import { chunkBuffer, flattenChunkedMessage } from "../host/agent/broker/chunked-transport.js";
import { ChunkReassembler } from "../extension/sidepanel/chunk-reassembler.js";
import { DocumentsClient } from "../extension/sidepanel/documents-client.js";
import { ConversationModel } from "../extension/sidepanel/conversation-model.js";
import { parseCsv, rowsToMarkdownTable, sheetsToMarkdown, slidesToMarkdown, FORMAT_LABELS, EXTRACTED_PREVIEW_FORMATS } from "../extension/sidepanel/document-viewer.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

// `atob` exists in the panel and in modern Node; the reassembler uses it.
if (typeof globalThis.atob !== "function") {
  globalThis.atob = (b64) => Buffer.from(b64, "base64").toString("binary");
}

console.log("== chunk reassembly against the real host chunker ==");
{
  const original = Buffer.alloc(1_500_000);
  for (let i = 0; i < original.length; i += 1) original[i] = (i * 31) % 256;
  const sequence = flattenChunkedMessage(
    chunkBuffer(original, { meta: { kind: "document_bytes", documentId: "d1", fileName: "a.md", mimeType: "text/markdown" } })
  );
  ok(sequence.length > 3, `a 1.5 MB document really chunks (${sequence.length} envelopes)`);

  const reassembler = new ChunkReassembler();
  let result = null;
  for (const part of sequence) result = reassembler.receive(part);
  ok(result && result.done, "the sequence completes");
  ok(result.bytes.length === original.length, "assembled length matches");
  ok(Buffer.compare(Buffer.from(result.bytes), original) === 0, "assembled bytes are identical");
  ok(result.meta.fileName === "a.md" && result.meta.mimeType === "text/markdown", "begin metadata travels with the bytes");
}

console.log("== a damaged sequence is rejected, never partially accepted ==");
{
  const original = Buffer.from("nội dung tài liệu", "utf8");
  const build = () => flattenChunkedMessage(chunkBuffer(original, { maxChunkBytes: 4, meta: { kind: "document_bytes" } }));

  const threw = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  ok(
    threw(() => {
      const r = new ChunkReassembler();
      const seq = build();
      for (const part of seq.filter((p) => p.type !== "chunk_part" || p.index !== 1)) r.receive(part);
    }),
    "a missing part is rejected at chunk_end"
  );

  ok(
    threw(() => {
      const r = new ChunkReassembler();
      const seq = build();
      r.receive(seq[0]);
      r.receive(seq[1]);
      r.receive(seq[1]);
    }),
    "a duplicated part index is rejected"
  );

  ok(
    threw(() => {
      const r = new ChunkReassembler();
      const seq = build();
      r.receive({ ...seq[0], expiresAt: Date.now() - 1 });
    }),
    "an already-expired sequence is rejected"
  );

  ok(
    threw(() => {
      const r = new ChunkReassembler();
      const seq = build();
      r.receive(seq[0]);
      r.receive({ ...seq[1], size: 999 });
    }),
    "a part whose declared size disagrees with its payload is rejected"
  );

  ok(
    threw(() => {
      new ChunkReassembler().receive({ type: "chunk_part", chunkId: "x", index: 0, total: 1, size: 0, dataB64: "" });
    }),
    "a part arriving before its begin is rejected"
  );
}

console.log("== the fetch client correlates replies and caches bytes ==");
{
  const sent = [];
  const client = new DocumentsClient({ send: (req) => sent.push(req), requestIdMint: () => "req_1" });
  const promise = client.fetch({ conversationId: "c1", documentId: "d1" });
  ok(sent.length === 1 && sent[0].documentId === "d1", "a request went out for the document");

  const bytes = Buffer.from("# Báo cáo\n", "utf8");
  for (const part of flattenChunkedMessage(
    chunkBuffer(bytes, { meta: { kind: "document_bytes", documentId: "d1", requestId: "req_1", fileName: "bao-cao.md", format: "md", mimeType: "text/markdown" } })
  )) {
    client.handleEnvelope(part);
  }
  const result = await promise;
  ok(result.found === true, "the fetch resolves as found");
  ok(Buffer.from(result.bytes).toString("utf8") === "# Báo cáo\n", "the bytes are the document");
  ok(result.meta.fileName === "bao-cao.md" && result.meta.format === "md", "metadata came off the begin envelope");

  const before = sent.length;
  const again = await client.fetch({ conversationId: "c1", documentId: "d1" });
  ok(sent.length === before, "a second fetch of the same document sends no second request");
  ok(again.found === true, "the cached fetch still resolves found");
}

console.log("== an unavailable document resolves explicitly, never hangs ==");
{
  const client = new DocumentsClient({ send: () => {}, requestIdMint: () => "req_2" });
  const promise = client.fetch({ conversationId: "c1", documentId: "gone" });
  client.handleEnvelope({ type: "document", requestId: "req_2", found: false, reason: "bytes_missing" });
  const result = await promise;
  ok(result.found === false && result.reason === "bytes_missing", "the reason reaches the caller");

  const other = new DocumentsClient({ send: () => {}, requestIdMint: () => "req_3" });
  ok(other.handleEnvelope({ type: "chunk_begin", kind: "action_artifact_reply", chunkId: "z" }) === false,
    "a chunk sequence belonging to something else is not consumed");
  ok(other.handleEnvelope({ type: "stream_event" }) === false, "an unrelated envelope is not consumed");
}

console.log("== a broken transfer fails the fetch rather than yielding a partial file ==");
{
  const client = new DocumentsClient({ send: () => {}, requestIdMint: () => "req_4" });
  const promise = client.fetch({ conversationId: "c1", documentId: "d2" });
  const seq = flattenChunkedMessage(
    chunkBuffer(Buffer.from("abcdefghij"), { maxChunkBytes: 4, meta: { kind: "document_bytes", documentId: "d2", requestId: "req_4" } })
  );
  client.handleEnvelope(seq[0]);
  client.handleEnvelope(seq[1]);
  client.handleEnvelope(seq[seq.length - 1]); // chunk_end with parts missing
  const result = await promise;
  ok(result.found === false && /transfer_failed/.test(result.reason), `a short sequence fails the fetch (${result.reason})`);
}

console.log("== document_created becomes a card on the turn that produced it ==");
{
  const model = new ConversationModel("c1");
  model.applyEvent({ type: "run_created", runId: "r1" });
  const event = {
    type: "document_created",
    runId: "r1",
    documentId: "d1",
    title: "Phân tích dauthau asia",
    fileName: "phan-tich-dauthau-asia.md",
    format: "md",
    mimeType: "text/markdown",
    byteLength: 4096
  };
  model.applyEvent(event);
  const turn = model.items.find((i) => i.documents && i.documents.length);
  ok(!!turn, "the card is attached to the turn, not pushed as a loose item");
  ok(turn.documents[0].title === "Phân tích dauthau asia", "the title survives");
  ok(turn.documents[0].byteLength === 4096, "the size survives");
  ok(!("content" in turn.documents[0]) && !("bytes" in turn.documents[0]), "no bytes are held in the transcript");

  // A reconnect replays the same event; the card must not double.
  model.applyEvent(event);
  ok(turn.documents.length === 1, "a replayed event does not duplicate the card");
}

console.log("== format routing and conversions ==");
{
  ok(FORMAT_LABELS.docx === "DOCX" && FORMAT_LABELS.md === "MD", "formats carry display labels");
  ok(EXTRACTED_PREVIEW_FORMATS.has("pptx"), "pptx is declared as an extracted preview");
  ok(!EXTRACTED_PREVIEW_FORMATS.has("pdf"), "pdf is a real render, not an extraction");

  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n');
  ok(rows.length === 2, `two rows parsed, got ${rows.length}`);
  ok(rows[1][0] === "x, y", `a quoted field keeps its comma: ${rows[1][0]}`);
  ok(rows[1][1] === 'he said "hi"', `a doubled quote unescapes: ${rows[1][1]}`);

  const multiline = parseCsv('a,b\n"line1\nline2",c\n');
  ok(multiline[1][0] === "line1\nline2", "a newline inside quotes stays inside the field");

  const table = rowsToMarkdownTable(["a", "b"], [["1"], ["2", "3"]]);
  ok(table.split("\n").length === 4, "header, delimiter and two rows");
  ok(table.includes("| 1 |  |"), `a short row is padded, not shifted: ${table}`);

  ok(sheetsToMarkdown([{ name: "S1", rows: [["h"], ["v"]] }]).includes("## S1"), "each sheet gets a heading");
  ok(sheetsToMarkdown([{ name: "Trống", rows: [] }]).includes("_(trống)_"), "an empty sheet says so");
  ok(slidesToMarkdown([{ title: "T", bullets: ["a"] }]).includes("## Slide 1 — T"), "slides become an outline");
}

console.log(fail === 0 ? "\nALL SIDEPANEL DOCUMENT TESTS PASSED\n" : `\n${fail} FAILURES\n`);
process.exit(fail ? 1 : 0);

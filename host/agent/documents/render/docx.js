// Markdown -> Word (.docx), using the `docx` package.
//
// Loaded lazily by render/index.js: a conversation that never asks for a Word
// document never loads this module or its dependency.

import { parseMarkdownBlocks, parseInlineRuns } from "./markdown-ast.js";

export async function markdownToDocx(source, meta = {}) {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, WidthType, AlignmentType } =
    await import("docx");

  const blocks = parseMarkdownBlocks(source);
  const children = [];

  // The document opens with its own title, so the file is self-describing when
  // opened outside the panel — the card's title is otherwise nowhere in it.
  // Skipped when the content already opens with that same title as its top
  // heading, which is the common case: a model writing a report starts it with
  // "# <title>", and adding the title again put it in the file twice.
  const opensWithTitle =
    meta.title &&
    blocks[0] &&
    blocks[0].type === "heading" &&
    blocks[0].level === 1 &&
    normalizeTitle(blocks[0].text) === normalizeTitle(meta.title);
  if (meta.title && !opensWithTitle) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: String(meta.title), bold: true })]
      })
    );
  }

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        children.push(
          new Paragraph({
            // The enum keys are HEADING_1..HEADING_6 — built from the level
            // directly, never from a derived display name, because a lookup
            // that misses would silently flatten every heading to level 1.
            heading: HeadingLevel[`HEADING_${Math.min(Math.max(block.level, 1), 6)}`],
            children: runsFor(block.text, TextRun)
          })
        );
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runsFor(block.text, TextRun) }));
        break;
      case "list":
        for (const item of block.items) {
          children.push(
            new Paragraph({
              children: runsFor(item.text, TextRun),
              bullet: block.ordered ? undefined : { level: Math.min(item.depth, 4) },
              numbering: block.ordered ? { reference: "ordered-list", level: Math.min(item.depth, 4) } : undefined
            })
          );
        }
        break;
      case "table":
        children.push(buildTable(block, { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, AlignmentType }));
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          children.push(new Paragraph({ children: [new TextRun({ text: line, font: "Consolas", size: 20 })] }));
        }
        break;
      case "hr":
        children.push(new Paragraph({ text: "", border: { bottom: { style: "single", size: 6, space: 1 } } }));
        break;
      default:
        break;
    }
  }

  const doc = new Document({
    title: meta.title ? String(meta.title) : undefined,
    numbering: {
      config: [
        {
          reference: "ordered-list",
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: "decimal",
            text: `%${level + 1}.`,
            alignment: "start"
          }))
        }
      ]
    },
    sections: [{ properties: {}, children: children.length ? children : [new Paragraph({ text: "" })] }]
  });
  return Packer.toBuffer(doc);
}

/** Compare a heading against a title ignoring case, spacing and inline marks. */
function normalizeTitle(text) {
  return String(text ?? "")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function runsFor(text, TextRun) {
  return parseInlineRuns(text).map(
    (run) =>
      new TextRun({
        text: run.text,
        // Declared only when true: passing an explicit `false` makes the
        // library emit <w:b w:val="false"/> on every single run. That is valid
        // OOXML, but it is also exactly the shape a reader treating presence
        // as truth misreads as bold — so do not write it at all.
        ...(run.bold ? { bold: true } : {}),
        ...(run.italic ? { italics: true } : {}),
        ...(run.code ? { font: "Consolas" } : {})
      })
  );
}

function buildTable(block, ctx) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType } = ctx;
  const rows = [];
  const cell = (text, bold) =>
    new TableCell({
      children: [
        new Paragraph({
          children: parseInlineRuns(text).map(
            (run) =>
              new TextRun({
                text: run.text,
                ...(bold || run.bold ? { bold: true } : {}),
                ...(run.italic ? { italics: true } : {})
              })
          )
        })
      ]
    });

  rows.push(new TableRow({ children: block.header.map((h) => cell(h, true)), tableHeader: true }));
  const width = block.header.length;
  for (const row of block.rows) {
    // Ragged rows are padded rather than dropped: a table cell the model
    // omitted should show as empty, not silently shorten the row.
    const cells = [];
    for (let i = 0; i < width; i += 1) cells.push(cell(row[i] ?? "", false));
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

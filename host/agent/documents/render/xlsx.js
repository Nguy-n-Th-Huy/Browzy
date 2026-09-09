// Markdown -> Excel (.xlsx), using `exceljs`.
//
// `exceljs` rather than npm's `xlsx`: the SheetJS package published to npm
// (0.18.5) has been unmaintained since the project moved to its own CDN, and
// its prototype-pollution advisory is only fixed in versions npm does not
// carry. `exceljs` is MIT, actively published to npm, and covers both the
// write path here and a read path if one is ever needed host-side.
//
// The shape a spreadsheet is made from: every markdown TABLE in the source
// becomes a worksheet. A source with no table at all still produces a valid
// workbook — a single "Document" sheet holding the text, one block per row —
// rather than failing, because a run that picked the wrong format should still
// hand the operator something openable.

import { parseMarkdownBlocks, inlineToPlainText } from "./markdown-ast.js";

export async function markdownToXlsx(source, meta = {}) {
  const ExcelJS = (await import("exceljs")).default ?? (await import("exceljs"));
  const blocks = parseMarkdownBlocks(source);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  if (meta.title) workbook.title = String(meta.title);

  const tables = blocks.filter((b) => b.type === "table");
  if (tables.length) {
    // A table is named by the nearest heading above it, so a multi-table
    // report becomes a workbook whose tabs are readable rather than
    // "Sheet1..Sheet4".
    const names = sheetNamesFor(blocks, tables);
    tables.forEach((table, index) => {
      const sheet = workbook.addWorksheet(names[index]);
      const header = table.header.map(inlineToPlainText);
      sheet.addRow(header);
      sheet.getRow(1).font = { bold: true };
      for (const row of table.rows) {
        const cells = [];
        for (let i = 0; i < header.length; i += 1) cells.push(coerceCell(row[i] ?? ""));
        sheet.addRow(cells);
      }
      sheet.columns.forEach((column, i) => {
        const longest = Math.max(String(header[i] ?? "").length, ...table.rows.map((r) => String(r[i] ?? "").length));
        column.width = Math.min(Math.max(longest + 2, 10), 60);
      });
    });
  } else {
    const sheet = workbook.addWorksheet(sanitizeSheetName(meta.title || "Document"));
    for (const block of blocks) {
      if (block.type === "list") {
        for (const item of block.items) sheet.addRow([inlineToPlainText(item.text)]);
      } else if (block.type === "code") {
        for (const line of block.text.split("\n")) sheet.addRow([line]);
      } else if (block.type === "heading" || block.type === "paragraph") {
        const row = sheet.addRow([inlineToPlainText(block.text)]);
        if (block.type === "heading") row.font = { bold: true };
      }
    }
    sheet.getColumn(1).width = 80;
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Numbers stay numbers.
 *
 * A markdown table of figures is the main reason a run picks xlsx at all; if
 * every cell arrived as text the operator could not sum a column. Only a cell
 * that is ENTIRELY a plain number is converted — anything with a unit, a
 * currency symbol, or a thousands separator stays text rather than being
 * silently reinterpreted.
 */
function coerceCell(raw) {
  const text = inlineToPlainText(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function sheetNamesFor(blocks, tables) {
  const names = [];
  let heading = null;
  let index = 0;
  for (const block of blocks) {
    if (block.type === "heading") heading = inlineToPlainText(block.text);
    if (block.type === "table") {
      index += 1;
      names.push(uniqueName(sanitizeSheetName(heading || `Bảng ${index}`), names));
    }
  }
  while (names.length < tables.length) names.push(uniqueName("Sheet", names));
  return names;
}

/** Excel rejects these characters in a sheet name and caps it at 31 chars. */
function sanitizeSheetName(name) {
  const cleaned = String(name)
    .replace(/[\\/*?:[\]]/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || "Sheet";
}

function uniqueName(name, taken) {
  if (!taken.includes(name)) return name;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${name.slice(0, 28)} ${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${name.slice(0, 27)} ${Date.now() % 1000}`;
}

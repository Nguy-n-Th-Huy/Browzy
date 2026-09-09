// Excel (.xlsx) -> one row matrix per worksheet.
//
// The parts that matter: `xl/workbook.xml` names the sheets in order,
// `xl/_rels/workbook.xml.rels` maps each sheet to its part, `xl/sharedStrings.xml`
// holds the deduplicated text, and each `xl/worksheets/sheetN.xml` holds the
// cells. A cell's `t` attribute says how to read its `v`: "s" is an index into
// the shared strings, "inlineStr" carries its own text, anything else is a
// literal (a number, usually).
//
// Cell references are honoured rather than assumed sequential: Excel omits
// empty cells entirely, so reading `r="C2"` is what keeps a column of values
// under the right header when a row has a gap in it.

import { openContainer, entryText, parseXml, descendantsNamed, attr, naturalCompare } from "./ooxml.js";

/**
 * @returns {Promise<Array<{name: string, rows: string[][]}>>}
 */
export async function xlsxToSheets(bytes) {
  const entries = openContainer(bytes);
  const shared = readSharedStrings(entries);
  const sheets = [];

  for (const sheet of listSheets(entries)) {
    const xml = entryText(entries, sheet.path);
    if (!xml) continue;
    sheets.push({ name: sheet.name, rows: readSheetRows(parseXml(xml), shared) });
  }
  if (!sheets.length) throw new Error("không tìm thấy worksheet nào trong tệp");
  return sheets;
}

function readSharedStrings(entries) {
  const xml = entryText(entries, "xl/sharedStrings.xml");
  if (!xml) return [];
  const doc = parseXml(xml);
  // One shared string is an <si> holding either a single <t> or several runs,
  // each with its own <t>; joining every descendant <t> covers both.
  return descendantsNamed(doc.documentElement, "si").map((si) =>
    descendantsNamed(si, "t")
      .map((t) => t.textContent || "")
      .join("")
  );
}

/**
 * Sheet name -> part path, in workbook order.
 *
 * Falls back to the raw worksheet parts when the relationship map cannot be
 * read: a sheet shown as "Sheet1" is far better than no preview at all.
 */
function listSheets(entries) {
  const workbookXml = entryText(entries, "xl/workbook.xml");
  const relsXml = entryText(entries, "xl/_rels/workbook.xml.rels");
  if (workbookXml && relsXml) {
    const relations = new Map();
    for (const rel of descendantsNamed(parseXml(relsXml).documentElement, "Relationship")) {
      relations.set(attr(rel, "Id"), attr(rel, "Target"));
    }
    const out = [];
    for (const sheet of descendantsNamed(parseXml(workbookXml).documentElement, "sheet")) {
      const target = relations.get(attr(sheet, "id"));
      if (!target) continue;
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      out.push({ name: attr(sheet, "name") || "Sheet", path });
    }
    if (out.length) return out;
  }
  return Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort(naturalCompare)
    .map((path, index) => ({ name: `Sheet${index + 1}`, path }));
}

function readSheetRows(doc, shared) {
  const rows = [];
  let width = 0;
  for (const row of descendantsNamed(doc.documentElement, "row")) {
    const cells = [];
    for (const cell of descendantsNamed(row, "c")) {
      const index = columnIndex(attr(cell, "r"));
      const value = readCell(cell, shared);
      const at = index >= 0 ? index : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    width = Math.max(width, cells.length);
    rows.push(cells);
  }
  // Ragged rows are padded so every row has the header's width — a gap must
  // read as an empty cell, not shift the columns after it.
  for (const row of rows) {
    while (row.length < width) row.push("");
  }
  return rows;
}

function readCell(cell, shared) {
  const type = attr(cell, "t");
  if (type === "inlineStr") {
    return descendantsNamed(cell, "t")
      .map((t) => t.textContent || "")
      .join("");
  }
  const valueNode = descendantsNamed(cell, "v")[0];
  const raw = valueNode ? valueNode.textContent || "" : "";
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) && shared[index] !== undefined ? shared[index] : "";
  }
  return raw;
}

/** "C2" -> 2 (zero-based column). Returns -1 when the reference is absent. */
export function columnIndex(reference) {
  if (!reference) return -1;
  const letters = /^([A-Z]+)/.exec(String(reference).toUpperCase());
  if (!letters) return -1;
  let index = 0;
  for (const char of letters[1]) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

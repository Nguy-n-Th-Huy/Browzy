// Markdown -> PDF, using `pdf-lib` with an embedded Unicode font.
//
// The font is not optional. pdf-lib's StandardFonts are WinAnsi-encoded, which
// has no code points for Vietnamese (or Greek, Cyrillic, Central European…)
// — embedding one would make `pdf-lib` throw on the very first "ế". So this
// module embeds DejaVu Sans through `@pdf-lib/fontkit`, which covers Latin
// Extended Additional and therefore the whole Vietnamese alphabet. That is
// what the ~1.4 MB of font files in the host package buy.
//
// Layout is deliberately plain: one column, wrapped text, headings a size up,
// bullets indented, tables as fixed-width columns. This is a readable
// printable of a markdown document, not a typesetting engine.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseMarkdownBlocks, inlineToPlainText } from "./markdown-ast.js";

const require = createRequire(import.meta.url);

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points
const MARGIN = 56;
const BODY_SIZE = 11;
const LINE_GAP = 1.45;

export async function markdownToPdf(source, meta = {}) {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  if (meta.title) pdf.setTitle(String(meta.title));

  const regular = await pdf.embedFont(fs.readFileSync(fontPath("DejaVuSans.ttf")), { subset: true });
  const bold = await pdf.embedFont(fs.readFileSync(fontPath("DejaVuSans-Bold.ttf")), { subset: true });

  const layout = {
    pdf,
    rgb,
    regular,
    bold,
    page: null,
    y: 0
  };
  newPage(layout);

  const blocks = parseMarkdownBlocks(source);
  // Skipped when the content already opens with that same title as its top
  // heading — the common case, since a model writing a report starts it with
  // "# <title>". Printing both put the title on the page twice.
  const opensWithTitle =
    meta.title &&
    blocks[0] &&
    blocks[0].type === "heading" &&
    blocks[0].level === 1 &&
    normalizeTitle(blocks[0].text) === normalizeTitle(meta.title);
  if (meta.title && !opensWithTitle) {
    drawWrapped(layout, String(meta.title), { font: bold, size: 20, gapAfter: 10 });
  }

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        drawWrapped(layout, inlineToPlainText(block.text), {
          font: bold,
          size: Math.max(12, 19 - block.level * 2),
          gapBefore: 8,
          gapAfter: 4
        });
        break;
      case "paragraph":
        drawWrapped(layout, inlineToPlainText(block.text), { font: regular, size: BODY_SIZE, gapAfter: 6 });
        break;
      case "list":
        for (const item of block.items) {
          drawWrapped(layout, `• ${inlineToPlainText(item.text)}`, {
            font: regular,
            size: BODY_SIZE,
            indent: 14 + item.depth * 14,
            gapAfter: 2
          });
        }
        layout.y -= 4;
        break;
      case "code":
        for (const line of block.text.split("\n")) {
          drawWrapped(layout, line, { font: regular, size: 9.5, indent: 12, gapAfter: 1, color: [0.25, 0.25, 0.3] });
        }
        layout.y -= 6;
        break;
      case "table":
        drawTable(layout, block);
        break;
      case "hr":
        drawRule(layout);
        break;
      default:
        break;
    }
  }

  return Buffer.from(await pdf.save());
}

/** Compare a heading against a title ignoring case, spacing and inline marks. */
function normalizeTitle(text) {
  return String(text ?? "")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fontPath(file) {
  // Resolved through the package's own entry so the path holds wherever the
  // host package is installed, rather than assuming a node_modules layout.
  const pkg = require.resolve("dejavu-fonts-ttf/package.json");
  return path.join(path.dirname(pkg), "ttf", file);
}

function newPage(layout) {
  layout.page = layout.pdf.addPage([PAGE.width, PAGE.height]);
  layout.y = PAGE.height - MARGIN;
}

function ensureRoom(layout, needed) {
  if (layout.y - needed < MARGIN) newPage(layout);
}

function drawWrapped(layout, text, opts) {
  const { font, size, indent = 0, gapBefore = 0, gapAfter = 0, color } = opts;
  layout.y -= gapBefore;
  const maxWidth = PAGE.width - MARGIN * 2 - indent;
  for (const line of wrapLines(text, font, size, maxWidth)) {
    ensureRoom(layout, size * LINE_GAP);
    layout.page.drawText(line, {
      x: MARGIN + indent,
      y: layout.y - size,
      size,
      font,
      color: color ? layout.rgb(color[0], color[1], color[2]) : layout.rgb(0.1, 0.1, 0.12)
    });
    layout.y -= size * LINE_GAP;
  }
  layout.y -= gapAfter;
}

function drawRule(layout) {
  ensureRoom(layout, 12);
  layout.page.drawLine({
    start: { x: MARGIN, y: layout.y - 4 },
    end: { x: PAGE.width - MARGIN, y: layout.y - 4 },
    thickness: 0.6,
    color: layout.rgb(0.75, 0.75, 0.78)
  });
  layout.y -= 14;
}

function drawTable(layout, block) {
  const columns = block.header.length || 1;
  const available = PAGE.width - MARGIN * 2;
  const columnWidth = available / columns;
  const size = 9.5;

  const drawRow = (cells, font) => {
    // Every cell is wrapped independently; the row is as tall as its tallest
    // cell, so a long cell never overprints its neighbour.
    const wrapped = [];
    for (let i = 0; i < columns; i += 1) {
      wrapped.push(wrapLines(inlineToPlainText(cells[i] ?? ""), font, size, columnWidth - 8));
    }
    const height = Math.max(...wrapped.map((w) => w.length)) * size * LINE_GAP + 4;
    ensureRoom(layout, height);
    const top = layout.y;
    for (let i = 0; i < columns; i += 1) {
      let y = top;
      for (const line of wrapped[i]) {
        layout.page.drawText(line, {
          x: MARGIN + i * columnWidth + 2,
          y: y - size,
          size,
          font,
          color: layout.rgb(0.1, 0.1, 0.12)
        });
        y -= size * LINE_GAP;
      }
    }
    layout.y = top - height;
  };

  drawRow(block.header, layout.bold);
  drawRule(layout);
  for (const row of block.rows) drawRow(row, layout.regular);
  layout.y -= 6;
}

/**
 * Greedy word wrap against the embedded font's real metrics.
 *
 * A single word longer than the line (a URL, a long identifier) is broken by
 * character rather than allowed to overflow the page margin.
 */
function wrapLines(text, font, size, maxWidth) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }
    let chunk = "";
    for (const char of word) {
      if (font.widthOfTextAtSize(chunk + char, size) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines;
}

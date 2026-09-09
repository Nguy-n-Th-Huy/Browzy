// A deliberately small Markdown block parser, host-side.
//
// Why not a library: the four generators in this directory need the same
// handful of block shapes — headings, paragraphs, bullet/number lists, GFM
// pipe tables, fenced code, rules — and nothing else. A full CommonMark
// implementation would bring a large dependency and an HTML intermediate that
// every generator would then have to parse back out of. This produces the
// block list directly.
//
// It intentionally mirrors what extension/sidepanel/markdown-lite.js supports
// on the panel side, so what an operator previews and what lands in a .docx
// come from the same understanding of the source. The two are separate files
// because they run in separate processes with different outputs (this one
// yields data, that one yields escaped HTML) — the shared thing is the subset,
// not the code.

/**
 * Parse markdown into a flat list of blocks.
 *
 * @param {string} source
 * @returns {Array<object>} blocks: {type: "heading"|"paragraph"|"list"|"table"|"code"|"hr", ...}
 */
export function parseMarkdownBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code: nothing inside is interpreted.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || "";
      const body = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (or fall off the end)
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // GFM pipe table: a header row followed by a delimiter row. Checked
    // before lists and paragraphs because a table row can start with anything.
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(alignmentOf);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    const listItem = matchListItem(line);
    if (listItem) {
      const ordered = listItem.ordered;
      const items = [];
      while (i < lines.length) {
        const m = matchListItem(lines[i]);
        if (!m || m.ordered !== ordered) break;
        items.push({ text: m.text, depth: m.depth });
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !startsAnotherBlock(lines, i)) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    else i += 1; // defensive: never spin on a line no branch consumed
  }

  return blocks;
}

/**
 * Split one line of markdown into styled runs.
 *
 * Supports the same inline subset the panel renders: `code`, **bold**,
 * *italic*, and [text](url) — which becomes "text (url)", since none of the
 * generated formats here carry a clickable link uniformly.
 *
 * @returns {Array<{text: string, bold?: boolean, italic?: boolean, code?: boolean}>}
 */
export function parseInlineRuns(text) {
  const source = String(text ?? "").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => `${label} (${url})`);
  const runs = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) runs.push({ text: source.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith("**") || token.startsWith("__")) runs.push({ text: token.slice(2, -2), bold: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    last = pattern.lastIndex;
  }
  if (last < source.length) runs.push({ text: source.slice(last) });
  return runs.length ? runs : [{ text: "" }];
}

/** The plain text of a line, with inline markers removed. */
export function inlineToPlainText(text) {
  return parseInlineRuns(text)
    .map((r) => r.text)
    .join("");
}

function startsAnotherBlock(lines, i) {
  const line = lines[i];
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^```/.test(line)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (matchListItem(line)) return true;
  if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) return true;
  return false;
}

function matchListItem(line) {
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return { ordered: false, depth: Math.floor(bullet[1].length / 2), text: bullet[2].trim() };
  const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
  if (numbered) return { ordered: true, depth: Math.floor(numbered[1].length / 2), text: numbered[2].trim() };
  return null;
}

function isTableDelimiter(line) {
  return typeof line === "string" && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function alignmentOf(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

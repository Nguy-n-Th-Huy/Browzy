// Word (.docx) -> a structured block list, then HTML (Preview) or Markdown.
//
// Reads `word/document.xml` directly. A Word body is a flat sequence of `w:p`
// (paragraph) and `w:tbl` (table) elements; a paragraph's style name says
// whether it is a heading, and its `w:r` runs carry the bold/italic flags. That
// is the whole structure these two tabs need.

import { openContainer, entryText, parseXml, childrenNamed, descendantsNamed, attr, escapeHtml, previewDocument } from "./ooxml.js";

/**
 * @returns {Array<object>} blocks: {type:"heading",level,runs} |
 *   {type:"paragraph",runs} | {type:"list",ordered,items} |
 *   {type:"table",header,rows}
 */
export function docxToBlocks(bytes) {
  const entries = openContainer(bytes);
  const xml = entryText(entries, "word/document.xml");
  if (!xml) throw new Error("không tìm thấy word/document.xml trong tệp");
  const doc = parseXml(xml);
  const body = doc.getElementsByTagName("*");
  let bodyNode = null;
  for (const node of body) {
    if (node.localName === "body") {
      bodyNode = node;
      break;
    }
  }
  if (!bodyNode) return [];

  const blocks = [];
  for (const node of bodyNode.children) {
    if (node.localName === "p") {
      const block = paragraphBlock(node);
      if (!block) continue;
      // Consecutive list paragraphs are merged into one list block so the
      // markdown and the HTML both come out as a single list rather than a
      // run of one-item lists.
      const previous = blocks[blocks.length - 1];
      if (block.type === "listItem") {
        if (previous && previous.type === "list" && previous.ordered === block.ordered) {
          previous.items.push({ runs: block.runs, depth: block.depth });
        } else {
          blocks.push({ type: "list", ordered: block.ordered, items: [{ runs: block.runs, depth: block.depth }] });
        }
        continue;
      }
      blocks.push(block);
    } else if (node.localName === "tbl") {
      blocks.push(tableBlock(node));
    }
  }
  return blocks;
}

function paragraphBlock(node) {
  const runs = runsOf(node);
  const properties = childrenNamed(node, "pPr")[0] || null;
  const styleName = properties ? (childrenNamed(properties, "pStyle")[0] && attr(childrenNamed(properties, "pStyle")[0], "val")) || "" : "";
  const numbering = properties ? childrenNamed(properties, "numPr")[0] : null;

  if (numbering) {
    const levelNode = childrenNamed(numbering, "ilvl")[0];
    const depth = levelNode ? Number(attr(levelNode, "val") || 0) : 0;
    // Word records "which numbering definition" rather than "ordered or not",
    // and resolving numbering.xml to tell a bullet from a number is a large
    // amount of machinery for a distinction the reader can see anyway. The
    // list is rendered unordered unless the style name says otherwise.
    return { type: "listItem", ordered: /number|ordered/i.test(styleName), depth, runs };
  }

  const headingMatch = /^Heading(\d)$/i.exec(styleName) || /^Title$/i.test(styleName) && ["", "1"];
  if (headingMatch) {
    const level = Math.min(Number(headingMatch[1] || 1), 6);
    if (!runs.some((r) => r.text.trim())) return null;
    return { type: "heading", level, runs };
  }

  if (!runs.some((r) => r.text.trim())) return null;
  return { type: "paragraph", runs };
}

function runsOf(node) {
  const runs = [];
  for (const run of descendantsNamed(node, "r")) {
    const properties = childrenNamed(run, "rPr")[0] || null;
    const bold = toggleOn(properties, "b");
    const italic = toggleOn(properties, "i");
    let text = "";
    for (const child of run.children) {
      if (child.localName === "t") text += child.textContent || "";
      else if (child.localName === "tab") text += "\t";
      else if (child.localName === "br") text += "\n";
    }
    if (text) runs.push({ text, bold, italic });
  }
  return runs;
}

/**
 * Read one OOXML toggle property (`w:b`, `w:i`).
 *
 * Presence alone does NOT mean "on": the schema lets a producer write
 * `<w:b w:val="false"/>` to switch a toggle OFF against an inherited style,
 * and the `docx` package this project generates with does exactly that on
 * every run. Treating presence as truth made every character of a generated
 * document come out bold AND italic.
 */
function toggleOn(properties, localName) {
  if (!properties) return false;
  const node = childrenNamed(properties, localName)[0];
  if (!node) return false;
  const value = attr(node, "val");
  if (value === null || value === undefined) return true;
  return !/^(0|false|off)$/i.test(value.trim());
}

function tableBlock(node) {
  const rows = [];
  for (const row of childrenNamed(node, "tr")) {
    const cells = [];
    for (const cell of childrenNamed(row, "tc")) {
      const text = childrenNamed(cell, "p")
        .map((p) => runsOf(p).map((r) => r.text).join(""))
        .join(" ")
        .trim();
      cells.push(text);
    }
    rows.push(cells);
  }
  if (!rows.length) return { type: "table", header: [], rows: [] };
  return { type: "table", header: rows[0], rows: rows.slice(1) };
}

/** Preview: semantic HTML for the sandboxed frame. Every run is escaped. */
export async function docxToHtml(bytes, { dark = false } = {}) {
  const blocks = docxToBlocks(bytes);
  const html = blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
          return `<h${block.level}>${runsToHtml(block.runs)}</h${block.level}>`;
        case "paragraph":
          return `<p>${runsToHtml(block.runs)}</p>`;
        case "list": {
          const tag = block.ordered ? "ol" : "ul";
          return `<${tag}>${block.items.map((i) => `<li>${runsToHtml(i.runs)}</li>`).join("")}</${tag}>`;
        }
        case "table":
          return tableHtml(block);
        default:
          return "";
      }
    })
    .join("\n");
  return previewDocument(html, { dark });
}

function runsToHtml(runs) {
  return runs
    .map((run) => {
      let html = escapeHtml(run.text).replace(/\n/g, "<br>");
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      return html;
    })
    .join("");
}

function tableHtml(block) {
  const head = `<thead><tr>${block.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>`;
  const body = block.rows
    .map((row) => {
      const cells = [];
      for (let i = 0; i < block.header.length; i += 1) cells.push(`<td>${escapeHtml(row[i] ?? "")}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

/** Markdown tab: the document's content as text the operator can copy. */
export async function docxToMarkdown(bytes) {
  const blocks = docxToBlocks(bytes);
  const out = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(block.level)} ${runsToMarkdown(block.runs)}`);
        break;
      case "paragraph":
        out.push(runsToMarkdown(block.runs));
        break;
      case "list":
        out.push(
          block.items
            .map((item, index) => `${"  ".repeat(item.depth)}${block.ordered ? `${index + 1}.` : "-"} ${runsToMarkdown(item.runs)}`)
            .join("\n")
        );
        break;
      case "table": {
        const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
        const lines = [`| ${block.header.map(cell).join(" | ")} |`, `| ${block.header.map(() => "---").join(" | ")} |`];
        for (const row of block.rows) {
          const cells = [];
          for (let i = 0; i < block.header.length; i += 1) cells.push(cell(row[i] ?? ""));
          lines.push(`| ${cells.join(" | ")} |`);
        }
        out.push(lines.join("\n"));
        break;
      }
      default:
        break;
    }
  }
  return out.join("\n\n");
}

function runsToMarkdown(runs) {
  return runs
    .map((run) => {
      const text = run.text.replace(/\n/g, " ");
      if (run.bold && run.italic) return `***${text}***`;
      if (run.bold) return `**${text}**`;
      if (run.italic) return `*${text}*`;
      return text;
    })
    .join("");
}

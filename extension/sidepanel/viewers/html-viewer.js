// HTML -> Markdown, for the Markdown tab of an `html` document.
//
// Why not `turndown`: its published build is UMD, which does not import
// cleanly as an ES module in the panel's module graph, and the whole job here
// is one depth-first walk over a document the browser has already parsed.
// 90 lines beats a vendored dependency and a wrapper to make it loadable.
//
// The document is parsed with `DOMParser` as "text/html", which builds a tree
// WITHOUT running anything: scripts do not execute, inline handlers do not
// bind, and no network request is made for images or stylesheets. Only
// textContent and tag names are read out of it. The parsed tree is never
// inserted anywhere — it exists only to be walked.

const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg"]);

export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
  const body = doc.body || doc.documentElement;
  if (!body) return "";
  const blocks = [];
  walkBlocks(body, blocks);
  return blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .join("\n\n");
}

function walkBlocks(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = child.textContent.replace(/\s+/g, " ").trim();
      if (text) out.push(text);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;

    if (/^h[1-6]$/.test(tag)) {
      out.push(`${"#".repeat(Number(tag[1]))} ${inline(child)}`);
    } else if (tag === "p") {
      out.push(inline(child));
    } else if (tag === "br") {
      // A lone <br> between blocks carries no content of its own.
    } else if (tag === "hr") {
      out.push("---");
    } else if (tag === "pre") {
      out.push(`\`\`\`\n${child.textContent.replace(/```/g, "\\`\\`\\`")}\n\`\`\``);
    } else if (tag === "blockquote") {
      const inner = [];
      walkBlocks(child, inner);
      out.push(inner.join("\n\n").split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (tag === "ul" || tag === "ol") {
      out.push(listMarkdown(child, tag === "ol", 0));
    } else if (tag === "table") {
      out.push(tableMarkdown(child));
    } else {
      walkBlocks(child, out);
    }
  }
}

function listMarkdown(list, ordered, depth) {
  const lines = [];
  let index = 0;
  for (const item of list.children) {
    if (item.tagName.toLowerCase() !== "li") continue;
    index += 1;
    const nested = [];
    let text = "";
    for (const child of item.childNodes) {
      const tag = child.nodeType === 1 ? child.tagName.toLowerCase() : "";
      if (tag === "ul" || tag === "ol") nested.push(listMarkdown(child, tag === "ol", depth + 1));
      else text += inlineNode(child);
    }
    lines.push(`${"  ".repeat(depth)}${ordered ? `${index}.` : "-"} ${text.replace(/\s+/g, " ").trim()}`);
    lines.push(...nested);
  }
  return lines.join("\n");
}

function tableMarkdown(table) {
  const rows = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells = [];
    for (const cell of tr.children) {
      const tag = cell.tagName.toLowerCase();
      if (tag === "th" || tag === "td") cells.push(inline(cell).replace(/\|/g, "\\|"));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return "";
  const [header, ...rest] = rows;
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rest) {
    const cells = [];
    for (let i = 0; i < header.length; i += 1) cells.push(row[i] ?? "");
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function inline(node) {
  let out = "";
  for (const child of node.childNodes) out += inlineNode(child);
  return out.replace(/[ \t]+/g, " ").trim();
}

function inlineNode(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return "";
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "code") return `\`${node.textContent}\``;
  if (tag === "strong" || tag === "b") return `**${inline(node)}**`;
  if (tag === "em" || tag === "i") return `*${inline(node)}*`;
  if (tag === "a") {
    const href = node.getAttribute("href") || "";
    const text = inline(node);
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "img") {
    const alt = node.getAttribute("alt") || "hình ảnh";
    return `![${alt}]`;
  }
  return inline(node);
}

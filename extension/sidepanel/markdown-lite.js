// A deliberately small, SAFE Markdown renderer for assistant text and
// tool-result previews.
//
// Why not a library: extension/ui/prose.css already styles headings, lists,
// quotes, code blocks, tables, links and rules, but no markdown-to-HTML
// conversion utility ships in the shared extension/ui/** layer (checked —
// icons.js/theme.js/behaviors.js do not provide one). Pulling in a
// third-party parser would be a far bigger surface to security-review than
// this file's actual need.
//
// Why this matters for SAFETY, not just formatting: assistant text and
// especially tool-result content can contain literal webpage text (e.g.
// get_page_text/read_page results) or a model's verbatim quoting of hostile
// page content. That content is DATA, never HTML, and must never be
// inserted as innerHTML unescaped — this module escapes every character of
// input before applying any formatting, so no `<script>`, no tag, no
// attribute injection is possible even if a page (or the model quoting it)
// contains one verbatim. See design.md decision 5: "User messages and
// page/tool content remain distinctly typed... code enforces scope."
//
// Supported: ATX headings, thematic breaks, fenced ``` code blocks
// (language-tagged; nothing inside a fence is ever interpreted as markdown),
// GFM pipe tables, ordered/unordered lists including nesting, blockquotes
// (recursively rendered), paragraphs, and inline `code`, **bold**, *italic*
// and [links](url).
//
// Deliberately NOT supported: raw HTML passthrough, reference links, images,
// setext headings, footnotes. Those render as plain escaped text — under-
// formatting is safe; guessing wrong about intent is not.

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Placeholder fencing for inline spans the emphasis passes must not re-parse.
// Written as an escape sequence, never as a literal control byte in this file.
const HOLD = "\u0000";
const HOLD_PATTERN = /\u0000(\d+)\u0000/g;

// Only these schemes ever become a clickable href. Checked against the
// ALREADY-ESCAPED url (escaping cannot introduce or disguise a scheme — it
// only rewrites & < > " '), so `javascript:`, `data:` and every other scheme
// fall through to being rendered as ordinary text instead.
const SAFE_LINK_SCHEME = /^(https?:\/\/|mailto:)/i;

/**
 * Apply inline formatting to ALREADY-ESCAPED text.
 *
 * Inline code and links are lifted out into placeholders before the
 * bold/italic passes run, so a `*` inside a code span or a URL cannot be
 * mistaken for emphasis and tear the generated markup apart.
 *
 * @param {string} escapedText
 * @returns {string}
 */
function renderInline(escapedText) {
  const held = [];
  const hold = (html) => {
    held.push(html);
    // A NUL byte cannot survive escapeHtml() into the text this runs on, so
    // the marker is unforgeable from user or page content.
    return `${HOLD}${held.length - 1}${HOLD}`;
  };

  let out = escapedText;
  out = out.replace(/`([^`]+)`/g, (_m, code) => hold(`<code>${code}</code>`));
  out = out.replace(/\[([^\]\n]*)\]\(([^()\s]+)\)/g, (whole, label, url) =>
    SAFE_LINK_SCHEME.test(url)
      ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`)
      : whole
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  return out.replace(HOLD_PATTERN, (_m, i) => held[Number(i)]);
}

/** One raw line: escaped, then inline-formatted. */
const line = (raw) => renderInline(escapeHtml(raw));

/**
 * A GFM pipe table needs a header row and a delimiter row directly under it
 * (`| --- | :--: |`). Both are required: a lone line with pipes in it is
 * ordinary prose, not a table.
 */
function isTableDelimiter(text) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(text) && text.includes("-");
}

/** Split `| a | b |` into cells, dropping the optional outer pipes. */
function splitRow(text) {
  return text.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * List-item leader: `- `, `* `, `+ ` or `1. `. Returns the item's indent
 * width and content, which is what nesting is decided from.
 */
function matchListItem(text) {
  const m = text.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
  if (!m) return null;
  return { indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), content: m[3] };
}

/**
 * Render one run of consecutive list lines, nesting by indent width. A
 * deeper item opens a sub-list inside the current `<li>`; a shallower one
 * closes back out to the matching level.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function renderList(lines) {
  let html = "";
  const open = []; // stack of { indent, tag }
  for (const raw of lines) {
    const item = matchListItem(raw);
    if (!item) {
      // A wrapped continuation line of the item above.
      if (open.length) html = html.replace(/<\/li>$/, `<br>${line(raw.trim())}</li>`);
      continue;
    }
    const tag = item.ordered ? "ol" : "ul";
    while (open.length > 1 && item.indent < open[open.length - 1].indent) {
      html += `</${open.pop().tag}></li>`;
    }
    if (!open.length || item.indent > open[open.length - 1].indent) {
      // Nest the new list INSIDE the item above it, so the sub-list belongs
      // to its parent rather than sitting as a sibling of the whole list.
      if (open.length) html = html.replace(/<\/li>$/, "");
      open.push({ indent: item.indent, tag });
      html += `<${tag}>`;
    } else if (open[open.length - 1].tag !== tag) {
      // The marker changed at this depth: close this list and open the other
      // kind rather than putting an <li> in the wrong container.
      html += `</${open.pop().tag}><${tag}>`;
      open.push({ indent: item.indent, tag });
    }
    html += `<li>${line(item.content)}</li>`;
  }
  while (open.length) {
    html += `</${open.pop().tag}>`;
    if (open.length) html += "</li>";
  }
  return html;
}

/**
 * Render the non-fenced part of a document, line by line.
 * @param {string[]} lines
 * @returns {string}
 */
function renderBlocks(lines) {
  const out = [];
  const paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(line).join("<br>")}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const raw = lines[i];

    if (!raw.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${line(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushParagraph();
      out.push("<hr>");
      i++;
      continue;
    }

    // Table: this line, plus a delimiter line directly below it.
    if (raw.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      const headers = splitRow(raw);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        body.push(splitRow(lines[i]));
        i++;
      }
      const head = `<thead><tr>${headers.map((c) => `<th>${line(c)}</th>`).join("")}</tr></thead>`;
      const rows = body
        .map((cells) => {
          // Pad or trim every row to the header's width, so one ragged row
          // cannot shift the whole column layout.
          const padded = Array.from({ length: headers.length }, (_, n) => cells[n] ?? "");
          return `<tr>${padded.map((c) => `<td>${line(c)}</td>`).join("")}</tr>`;
        })
        .join("");
      // .table-wrap is what prose.css scrolls a wide table inside, so the
      // panel itself never scrolls sideways.
      out.push(`<div class="table-wrap"><table>${head}${rows ? `<tbody>${rows}</tbody>` : ""}</table></div>`);
      continue;
    }

    if (/^\s*>/.test(raw)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (quoted.length && lines[i].trim()))) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      // Recursive, so a quote can hold a list, a heading or a table.
      out.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    if (matchListItem(raw)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && lines[i].trim() && (matchListItem(lines[i]) || items.length)) {
        items.push(lines[i]);
        i++;
      }
      out.push(renderList(items));
      continue;
    }

    paragraph.push(raw);
    i++;
  }

  flushParagraph();
  return out.join("\n");
}

/**
 * @param {string} text - raw, UNTRUSTED text (assistant output or a tool
 *   result preview). Never pre-escaped by the caller — this function owns
 *   escaping entirely.
 * @returns {string} safe HTML fragment.
 */
export function renderMarkdownLite(text) {
  const src = String(text ?? "");
  if (!src) return "";

  const lines = src.split("\n");
  const out = [];
  let pending = [];
  let i = 0;

  while (i < lines.length) {
    const fence = lines[i].match(/^\s*```([a-zA-Z0-9_+-]*)\s*$/);
    if (!fence) {
      pending.push(lines[i]);
      i++;
      continue;
    }
    // A fence wins over every other construct: its contents are code, and
    // nothing inside it is parsed as markdown.
    if (pending.length) out.push(renderBlocks(pending));
    pending = [];
    const lang = fence[1];
    const code = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
      code.push(lines[i]);
      i++;
    }
    i++; // consume the closing fence, or run off the end on an unclosed one
    out.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  if (pending.length) out.push(renderBlocks(pending));

  return out.filter(Boolean).join("\n");
}

/** Plain-text-only rendering (no inline formatting at all) for places that
 * must never risk even the minimal inline markup above — e.g. a permission
 * card's target, which is a concrete action/value that must be shown
 * verbatim. */
export function renderPlainEscaped(text) {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

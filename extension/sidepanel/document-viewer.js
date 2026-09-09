// What a document looks like in the panel's detail view.
//
// Two representations exist for EVERY format — Preview and Markdown — and
// this module is the only place that decides how each format produces them.
// It returns descriptions, not DOM: sidepanel.js owns the document, this file
// owns the mapping, and the mapping is what a test can assert without a
// browser.
//
// SAFETY, which is the whole reason the return shape is a tagged union rather
// than an HTML string: document content originates from model output and,
// transitively, from page content the model may have quoted. It is DATA.
//
//   - `{ kind: "markdown", text }`  -> rendered by markdown-lite.js, which
//     escapes every character before formatting, so it is safe in the panel's
//     own DOM. This is the ONLY kind allowed there.
//   - `{ kind: "text", text }`      -> inserted as a text node, never parsed.
//   - `{ kind: "table", header, rows }` -> built with createElement/textContent.
//   - `{ kind: "html", html }`      -> NEVER touches the panel DOM. sidepanel.js
//     puts it in an <iframe sandbox srcdoc> with neither allow-scripts nor
//     allow-same-origin, so an injected <script> cannot run and cannot reach
//     the panel, chrome.*, or storage.
//   - `{ kind: "pdf", bytes }`      -> rendered to canvases by the lazily
//     loaded pdf.js viewer.
//   - `{ kind: "unavailable", reason }` -> an honest failure, never a stand-in.
//
// Every viewer library is loaded by dynamic import() at the moment a document
// of that format is first opened. A session that never opens a PDF never pays
// for pdf.js.

export const FORMAT_LABELS = Object.freeze({
  md: "MD",
  txt: "TXT",
  csv: "CSV",
  html: "HTML",
  json: "JSON",
  docx: "DOCX",
  xlsx: "XLSX",
  pptx: "PPTX",
  pdf: "PDF"
});

/** Formats whose Preview is an extraction rather than a faithful render.
 * The UI says so rather than presenting the extraction as the document. */
export const EXTRACTED_PREVIEW_FORMATS = new Set(["pptx"]);

const decoder = new TextDecoder("utf-8");

function decode(bytes) {
  return decoder.decode(bytes);
}

/**
 * The Preview representation of one document.
 *
 * @param {string} format
 * @param {Uint8Array} bytes
 * @param {{title?: string}} [meta]
 * @returns {Promise<object>} one of the tagged shapes described above
 */
export async function buildPreview(format, bytes, meta = {}) {
  try {
    switch (format) {
      case "md":
        return { kind: "markdown", text: decode(bytes) };
      case "txt":
        return { kind: "text", text: decode(bytes) };
      case "json":
        return { kind: "text", text: prettyJson(decode(bytes)) };
      case "csv":
        return csvToTable(decode(bytes));
      case "html":
        return { kind: "html", html: decode(bytes) };
      case "docx": {
        const { docxToHtml } = await import("./viewers/docx-viewer.js");
        return { kind: "html", html: await docxToHtml(bytes, { dark: meta.dark }) };
      }
      case "xlsx": {
        const [{ xlsxToSheets }, { previewDocument, escapeHtml }] = await Promise.all([
          import("./viewers/xlsx-viewer.js"),
          import("./viewers/ooxml.js")
        ]);
        const sheets = await xlsxToSheets(bytes);
        const html = sheets
          .map((sheet) => {
            const [header = [], ...rows] = sheet.rows;
            const head = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
            const body = rows
              .map((row) => `<tr>${header.map((_, i) => `<td>${escapeHtml(row[i] ?? "")}</td>`).join("")}</tr>`)
              .join("");
            return `<div class="sheet-name">${escapeHtml(sheet.name)}</div><table><thead>${head}</thead><tbody>${body}</tbody></table>`;
          })
          .join("");
        return { kind: "html", html: previewDocument(html, { dark: meta.dark }) };
      }
      case "pptx": {
        const [{ pptxToSlides }, { previewDocument, escapeHtml }] = await Promise.all([
          import("./viewers/pptx-viewer.js"),
          import("./viewers/ooxml.js")
        ]);
        const slides = await pptxToSlides(bytes);
        const html = slides
          .map((slide, index) => {
            const bullets = slide.bullets
              .map((b, i) => `<li style="margin-left:${(slide.levels[i] || 0) * 14}px">${escapeHtml(b)}</li>`)
              .join("");
            const title = escapeHtml(slide.title || `Slide ${index + 1}`);
            return `<div class="slide"><div class="slide-title">${index + 1}. ${title}</div><ul>${bullets}</ul></div>`;
          })
          .join("");
        return { kind: "html", html: previewDocument(html, { dark: meta.dark }) };
      }
      case "pdf":
        return { kind: "pdf", bytes };
      default:
        return { kind: "unavailable", reason: `không hỗ trợ xem định dạng ${format}` };
    }
  } catch (err) {
    return { kind: "unavailable", reason: err.message || "không đọc được tài liệu" };
  }
}

/**
 * The Markdown representation of one document.
 *
 * For a text format this is the source. For a binary format it is what the
 * document says, extracted — the tab is there so the operator can read, copy
 * and search the content of a Word or PDF file as text, which is exactly what
 * a rendered preview does not allow.
 *
 * @returns {Promise<{kind: "markdown"|"unavailable", text?: string, reason?: string}>}
 */
export async function buildMarkdown(format, bytes, meta = {}) {
  try {
    switch (format) {
      case "md":
        return { kind: "markdown", text: decode(bytes) };
      case "txt":
        return { kind: "markdown", text: fence(decode(bytes)) };
      case "json":
        return { kind: "markdown", text: fence(prettyJson(decode(bytes)), "json") };
      case "csv":
        return { kind: "markdown", text: csvToMarkdownTable(decode(bytes)) };
      case "html": {
        const { htmlToMarkdown } = await import("./viewers/html-viewer.js");
        return { kind: "markdown", text: htmlToMarkdown(decode(bytes)) };
      }
      case "docx": {
        const { docxToMarkdown } = await import("./viewers/docx-viewer.js");
        return { kind: "markdown", text: await docxToMarkdown(bytes) };
      }
      case "xlsx": {
        const { xlsxToSheets } = await import("./viewers/xlsx-viewer.js");
        return { kind: "markdown", text: sheetsToMarkdown(await xlsxToSheets(bytes)) };
      }
      case "pptx": {
        const { pptxToSlides } = await import("./viewers/pptx-viewer.js");
        return { kind: "markdown", text: slidesToMarkdown(await pptxToSlides(bytes)) };
      }
      case "pdf": {
        const { pdfToText } = await import("./viewers/pdf-viewer.js");
        return { kind: "markdown", text: await pdfToText(bytes) };
      }
      default:
        return { kind: "unavailable", reason: `không hỗ trợ định dạng ${format}` };
    }
  } catch (err) {
    return { kind: "unavailable", reason: err.message || "không đọc được tài liệu" };
  }
}

// --- shared conversions ----------------------------------------------------

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // A file whose bytes are not valid JSON is shown as it is, not as an
    // error: the operator asked to see the document, not to validate it.
    return text;
  }
}

function fence(text, lang = "") {
  return `\`\`\`${lang}\n${text.replace(/```/g, "\\`\\`\\`")}\n\`\`\``;
}

/**
 * RFC 4180 CSV -> rows.
 *
 * Written out rather than split on commas because a quoted field may contain
 * the delimiter, a doubled quote, or a newline — all three of which the host's
 * own writer produces, so a naive split would mangle exactly the files this
 * project generates.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const source = String(text ?? "").replace(/\r\n/g, "\n");

  while (i < source.length) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToTable(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { kind: "text", text: "" };
  return { kind: "table", header: rows[0], rows: rows.slice(1) };
}

function csvToMarkdownTable(text) {
  const rows = parseCsv(text);
  if (!rows.length) return "";
  return rowsToMarkdownTable(rows[0], rows.slice(1));
}

/** GFM pipe table. Cell text is escaped for `|` only — the rest is content. */
export function rowsToMarkdownTable(header, rows) {
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|");
  const lines = [
    `| ${header.map(cell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows) {
    const cells = [];
    for (let i = 0; i < header.length; i += 1) cells.push(cell(row[i] ?? ""));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

export function sheetsToMarkdown(sheets) {
  return sheets
    .map((sheet) => {
      if (!sheet.rows.length) return `## ${sheet.name}\n\n_(trống)_`;
      const [header, ...rest] = sheet.rows;
      return `## ${sheet.name}\n\n${rowsToMarkdownTable(header, rest)}`;
    })
    .join("\n\n");
}

export function slidesToMarkdown(slides) {
  return slides
    .map((slide, index) => {
      const heading = `## Slide ${index + 1}${slide.title ? ` — ${slide.title}` : ""}`;
      const body = slide.bullets.map((b) => `- ${b}`).join("\n");
      return body ? `${heading}\n\n${body}` : heading;
    })
    .join("\n\n");
}

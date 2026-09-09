// The format registry and the single entry point that turns a run's source
// text into the bytes of a document.
//
// One table, one function: every part of the system that needs to know what a
// format is called, what extension it gets, what MIME type it carries, or how
// its bytes are produced reads it from here. The panel's viewer has its own
// mirror of the format list (it must, it runs in another process) but the
// authority for what `create_document` will accept is this file.
//
// The tool asks the model for Markdown whatever the format, so `md` and
// `txt` are stored as written while `csv`, `html` and `json` are converted in
// render/text.js — a `.csv` full of pipe characters would not be a
// spreadsheet. The binary formats (docx, xlsx, pptx, pdf) are generated from
// the same markdown source by the modules in this directory, each of which
// loads its generator library lazily: a conversation that only ever produces
// markdown never pays to load `docx`, `exceljs`, `pptxgenjs` or `pdf-lib`.

import { markdownToCsv, markdownToHtml } from "./text.js";

export const DOCUMENT_FORMATS = Object.freeze({
  md: { ext: "md", mimeType: "text/markdown", label: "MD", binary: false },
  txt: { ext: "txt", mimeType: "text/plain", label: "TXT", binary: false },
  csv: { ext: "csv", mimeType: "text/csv", label: "CSV", binary: false },
  html: { ext: "html", mimeType: "text/html", label: "HTML", binary: false },
  json: { ext: "json", mimeType: "application/json", label: "JSON", binary: false },
  docx: {
    ext: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "DOCX",
    binary: true
  },
  xlsx: {
    ext: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "XLSX",
    binary: true
  },
  pptx: {
    ext: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PPTX",
    binary: true
  },
  pdf: { ext: "pdf", mimeType: "application/pdf", label: "PDF", binary: true }
});

export function isSupportedFormat(format) {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_FORMATS, format);
}

/**
 * Produce the bytes of one document.
 *
 * @param {string} format - a key of DOCUMENT_FORMATS
 * @param {string} source - the run's content, written as markdown for every
 *   format; `json` is the one exception and must be JSON
 * @param {{title: string}} meta
 * @returns {Promise<Buffer>}
 */
export async function renderDocument(format, source, meta) {
  const spec = DOCUMENT_FORMATS[format];
  if (!spec) throw new Error(`unsupported format: ${format}`);
  if (!spec.binary) return Buffer.from(normalizeTextSource(format, source, meta), "utf8");

  // Lazy per-format import: the generator libraries are only loaded when a
  // run actually asks for that format.
  switch (format) {
    case "docx": {
      const { markdownToDocx } = await import("./docx.js");
      return markdownToDocx(source, meta);
    }
    case "xlsx": {
      const { markdownToXlsx } = await import("./xlsx.js");
      return markdownToXlsx(source, meta);
    }
    case "pptx": {
      const { markdownToPptx } = await import("./pptx.js");
      return markdownToPptx(source, meta);
    }
    case "pdf": {
      const { markdownToPdf } = await import("./pdf.js");
      return markdownToPdf(source, meta);
    }
    default:
      throw new Error(`no generator for format: ${format}`);
  }
}

/**
 * The text formats.
 *
 * `md` and `txt` are their own source and are stored verbatim. The other three
 * are not: the tool asks the model for Markdown in every case, so a `.csv` or
 * an `.html` has to be CONVERTED or the stored file would not match the
 * extension it was given — see render/text.js. `json` is re-serialized after a
 * parse, so a `.json` file is always valid JSON; a run that sends prose under
 * that format gets a rejection here rather than an operator getting a file no
 * parser accepts.
 */
function normalizeTextSource(format, source, meta) {
  if (format === "json") {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (err) {
      throw new Error(`content is not valid JSON: ${err.message}`);
    }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (format === "csv") return markdownToCsv(source);
  if (format === "html") return markdownToHtml(source, meta);
  return source.endsWith("\n") ? source : `${source}\n`;
}

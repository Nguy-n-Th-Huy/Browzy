// Per-conversation store for documents a RUN produced for the operator —
// the backing half of the `create_document` tool and of the panel's document
// card.
//
// Why this exists at all instead of letting the model write files: `Bash`,
// `Write`, `Edit` and `NotebookEdit` are in HIGH_RISK_BUILTINS
// (host/agent/tools/query-options.js) and stay there. Arbitrary filesystem
// writes remain disabled; this module is the ONE narrow, application-owned
// path by which a run can put bytes somewhere the operator can read them, and
// every part of the destination is chosen here, never by the model:
//
//   - the directory is always conversationDocumentsDir(conversationId);
//   - the id is minted here with crypto.randomUUID(), never model-supplied
//     (a model-supplied id could address another conversation's record);
//   - the filename is a slug derived from the title, bounded to a safe
//     character set, so no title can contribute a path segment, a `..`, a
//     leading dot, or a device name.
//
// Each document is stored as a pair: `<docId>.<ext>` holding the bytes and
// `<docId>.json` holding the metadata the panel's card is rebuilt from. The
// metadata sidecar is what makes a card survive a panel reload without the
// bytes ever being replayed through the event stream.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { conversationDocumentsDir, ensureDir, assertSafeId } from "../storage/paths.js";
import { DOCUMENT_FORMATS, isSupportedFormat, renderDocument } from "./render/index.js";

// Guards. All of these REJECT rather than truncate: a silently shortened
// report is worse than a failed tool call, because the model would go on to
// describe content the operator never received.
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024; // what the model may send
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // matches the attachment ceiling
export const MAX_DOCUMENTS_PER_CONVERSATION = 50;
export const MAX_TITLE_LENGTH = 200;
const MAX_SLUG_LENGTH = 80;

export class DocumentLimitError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "DocumentLimitError";
    this.reason = reason;
  }
}

/**
 * Derive a filesystem-safe slug from a human title.
 *
 * Deliberately lossy and ASCII-only: the slug is a FILENAME, not the title.
 * The real title is preserved verbatim in the metadata sidecar and is what
 * the card shows, so nothing readable is lost by being strict here. Vietnamese
 * (and any other) diacritics are decomposed and stripped rather than dropped
 * wholesale, so "Phân tích dauthau asia" stays recognizable as
 * "phan-tich-dauthau-asia" instead of collapsing to "document".
 */
export function slugifyTitle(title) {
  const normalized = String(title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  // Empty (a title made entirely of characters the slug alphabet drops, e.g.
  // CJK or emoji) falls back to a fixed name — never to the raw title.
  return slug || "document";
}

export class DocumentStore {
  /**
   * @param {object} [deps]
   * @param {() => string} [deps.idMint] - injectable id factory for tests
   * @param {() => number} [deps.now] - injectable clock for tests
   */
  constructor({ idMint = () => crypto.randomUUID(), now = Date.now } = {}) {
    this._idMint = idMint;
    this._now = now;
  }

  dir(conversationId) {
    return conversationDocumentsDir(conversationId);
  }

  /**
   * Write one document. Returns the metadata record (never the bytes — the
   * caller emits this shape as a `document_created` event, and bytes are
   * fetched separately on demand).
   *
   * @param {object} input
   * @param {string} input.conversationId
   * @param {string} input.title - human title, shown on the card
   * @param {string} [input.format] - one of DOCUMENT_FORMATS; defaults to "md"
   * @param {string} input.content - markdown (or the format's own source text)
   * @param {string} [input.runId] - recorded for provenance only
   */
  async write({ conversationId, title, format = "md", content, runId = null }) {
    assertSafeId(conversationId, "conversationId");

    if (!isSupportedFormat(format)) {
      throw new DocumentLimitError(
        "unsupported_format",
        `unsupported format ${JSON.stringify(format)}; supported: ${Object.keys(DOCUMENT_FORMATS).join(", ")}`
      );
    }
    const cleanTitle = String(title ?? "").trim().slice(0, MAX_TITLE_LENGTH);
    if (!cleanTitle) throw new DocumentLimitError("missing_title", "title is required");

    const source = String(content ?? "");
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (!sourceBytes) throw new DocumentLimitError("empty_content", "content is empty");
    if (sourceBytes > MAX_SOURCE_BYTES) {
      throw new DocumentLimitError(
        "source_too_large",
        `content is ${sourceBytes} bytes, over the ${MAX_SOURCE_BYTES}-byte limit`
      );
    }

    const dir = this.dir(conversationId);
    if (this.list(conversationId).length >= MAX_DOCUMENTS_PER_CONVERSATION) {
      throw new DocumentLimitError(
        "too_many_documents",
        `conversation already holds ${MAX_DOCUMENTS_PER_CONVERSATION} documents`
      );
    }

    const spec = DOCUMENT_FORMATS[format];
    const buffer = await renderDocument(format, source, { title: cleanTitle });
    if (buffer.length > MAX_OUTPUT_BYTES) {
      throw new DocumentLimitError(
        "output_too_large",
        `generated file is ${buffer.length} bytes, over the ${MAX_OUTPUT_BYTES}-byte limit`
      );
    }

    const documentId = this._idMint();
    assertSafeId(documentId, "documentId");
    const slug = slugifyTitle(cleanTitle);
    const record = {
      documentId,
      conversationId,
      title: cleanTitle,
      fileName: `${slug}.${spec.ext}`,
      format,
      mimeType: spec.mimeType,
      byteLength: buffer.length,
      createdAt: this._now(),
      runId
    };

    ensureDir(dir);
    // Bytes first, sidecar second: a crash between the two leaves an orphan
    // data file (invisible to list(), swept with the conversation) rather
    // than a metadata record whose card points at nothing.
    fs.writeFileSync(this._dataPath(conversationId, documentId, spec.ext), buffer);
    fs.writeFileSync(this._metaPath(conversationId, documentId), JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  /** All document records for a conversation, oldest first. Never throws. */
  list(conversationId) {
    let names;
    try {
      names = fs.readdirSync(this.dir(conversationId));
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir(conversationId), name), "utf8"));
        if (parsed && parsed.documentId) records.push(parsed);
      } catch {
        // A corrupt sidecar hides one document; it must never break the list.
      }
    }
    records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return records;
  }

  /** One document's metadata, or null. */
  readMeta(conversationId, documentId) {
    try {
      assertSafeId(conversationId, "conversationId");
      assertSafeId(documentId, "documentId");
      const parsed = JSON.parse(fs.readFileSync(this._metaPath(conversationId, documentId), "utf8"));
      return parsed && parsed.documentId ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * One document's bytes plus its metadata.
   *
   * Mirrors the action-artifact store's found/not-found contract: a deleted or
   * never-written document reports `found:false` with a reason, so the panel
   * can render the card as unavailable rather than showing a substitute or
   * throwing.
   */
  read(conversationId, documentId) {
    const meta = this.readMeta(conversationId, documentId);
    if (!meta) return { found: false, reason: "not_found" };
    const spec = DOCUMENT_FORMATS[meta.format];
    if (!spec) return { found: false, reason: "unsupported_format" };
    try {
      const buffer = fs.readFileSync(this._dataPath(conversationId, documentId, spec.ext));
      return { found: true, buffer, ...meta };
    } catch {
      return { found: false, reason: "bytes_missing" };
    }
  }

  _metaPath(conversationId, documentId) {
    return path.join(this.dir(conversationId), `${documentId}.json`);
  }

  _dataPath(conversationId, documentId, ext) {
    return path.join(this.dir(conversationId), `${documentId}.${ext}`);
  }
}

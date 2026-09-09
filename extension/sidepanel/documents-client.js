// Fetching the bytes of an agent-created document, on demand.
//
// The transcript's document card carries metadata only — title, format, size —
// because that is all the `document_created` stream event ever carries. The
// bytes are asked for exactly when the operator opens or downloads a card, and
// this module is the round trip that does it:
//
//   document_request { conversationId, documentId, requestId }
//     -> host reads the file, replies with a chunk_begin / chunk_part* /
//        chunk_end sequence (kind: "document_bytes"), OR a single
//        `document` envelope with found:false when it cannot be read
//     -> chunk-reassembler.js validates and joins the parts
//     -> a Blob, cached under the document id
//
// Concurrency is real here: the operator can open one card while another is
// still downloading, so every in-flight request has its own reassembler keyed
// by the sequence's own chunkId. Nothing is shared between transfers.
//
// A failed fetch resolves to an explicit `{ found: false, reason }` rather
// than throwing past the caller: the card's job is to render "unavailable"
// with a reason, and a rejected promise that nobody caught would leave it
// spinning instead.

import { ChunkReassembler } from "./chunk-reassembler.js";

const FETCH_TIMEOUT_MS = 60_000;

export class DocumentsClient {
  /**
   * @param {object} deps
   * @param {(envelope: object) => void} deps.send - posts one agent envelope
   *   (the panel's ProtocolClient.documentRequest, bound by the caller)
   * @param {() => number} [deps.now]
   * @param {() => string} [deps.requestIdMint]
   */
  constructor({ send, now = Date.now, requestIdMint } = {}) {
    if (typeof send !== "function") throw new Error("DocumentsClient requires a send function");
    this._send = send;
    this._now = now;
    this._mint = requestIdMint || (() => `doc_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`);
    this._pending = new Map(); // requestId -> { resolve, timer, documentId }
    this._sequences = new Map(); // chunkId -> { requestId, reassembler }
    // Bytes already fetched in this panel session, keyed by document id.
    // Opening a card and then downloading it is the common path and must not
    // cost two transfers of the same file.
    this._cache = new Map(); // documentId -> { bytes, meta }
  }

  /**
   * @returns {Promise<{found: true, bytes: Uint8Array, meta: object} | {found: false, reason: string}>}
   */
  fetch({ conversationId, documentId }) {
    if (!conversationId || !documentId) return Promise.resolve({ found: false, reason: "missing_id" });
    const cached = this._cache.get(documentId);
    if (cached) return Promise.resolve({ found: true, ...cached });

    const requestId = this._mint();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(requestId)) return;
        this._pending.delete(requestId);
        this._dropSequencesFor(requestId);
        resolve({ found: false, reason: "timeout" });
      }, FETCH_TIMEOUT_MS);

      this._pending.set(requestId, { resolve, timer, documentId });
      try {
        this._send({ conversationId, documentId, requestId });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(requestId);
        resolve({ found: false, reason: "send_failed" });
      }
    });
  }

  /**
   * Feed one agent envelope. Returns true when the envelope belonged to a
   * document transfer (so the caller knows it was consumed), false otherwise.
   */
  handleEnvelope(env) {
    if (!env || typeof env !== "object") return false;

    if (env.type === "document") {
      const pending = this._pending.get(env.requestId);
      if (!pending) return false;
      this._settle(env.requestId, { found: false, reason: env.reason || "not_found" });
      return true;
    }

    if (env.type === "chunk_begin") {
      if (env.kind !== "document_bytes") return false;
      if (!this._pending.has(env.requestId)) return false;
      const reassembler = new ChunkReassembler({ now: this._now });
      this._sequences.set(env.chunkId, { requestId: env.requestId, reassembler });
      this._feed(env.chunkId, env);
      return true;
    }

    if (env.type === "chunk_part" || env.type === "chunk_end") {
      if (!this._sequences.has(env.chunkId)) return false;
      this._feed(env.chunkId, env);
      return true;
    }

    return false;
  }

  _feed(chunkId, env) {
    const entry = this._sequences.get(chunkId);
    if (!entry) return;
    let result;
    try {
      result = entry.reassembler.receive(env);
    } catch (err) {
      // A rejected sequence is a failed fetch, never a partial file.
      this._sequences.delete(chunkId);
      this._settle(entry.requestId, { found: false, reason: `transfer_failed: ${err.message}` });
      return;
    }
    if (!result.done) return;

    this._sequences.delete(chunkId);
    const pending = this._pending.get(entry.requestId);
    const meta = {
      documentId: result.meta.documentId,
      title: result.meta.title,
      fileName: result.meta.fileName,
      format: result.meta.format,
      mimeType: result.meta.mimeType,
      byteLength: result.bytes.length
    };
    if (meta.documentId) this._cache.set(meta.documentId, { bytes: result.bytes, meta });
    if (pending) this._settle(entry.requestId, { found: true, bytes: result.bytes, meta });
  }

  _settle(requestId, value) {
    const pending = this._pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pending.delete(requestId);
    this._dropSequencesFor(requestId);
    pending.resolve(value);
  }

  _dropSequencesFor(requestId) {
    for (const [chunkId, entry] of this._sequences) {
      if (entry.requestId === requestId) this._sequences.delete(chunkId);
    }
  }

  /** Forget cached bytes (a conversation being deleted, or memory pressure). */
  clearCache() {
    this._cache.clear();
  }
}

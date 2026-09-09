// Bounded binary chunk transport for large tool results (screenshots,
// recording artifacts) over native messaging.
//
// Chrome's native-messaging channel has a real, documented message-size
// ceiling (historically 1MB in the extension->host direction; hosts must not
// assume an arbitrarily large JSON blob "just fits" — design.md decision 1:
// "Chunk binary results below the native-messaging message limit... Test
// large screenshots and recordings rather than assuming arbitrary JSON
// fits."). This module is the chunker/reassembler used on both ends of that
// transport; native-host.js and the companion pass whole Buffers through it
// instead of writing one oversized native message.
//
// Every chunk carries the fields the spec calls out explicitly: chunk id,
// index, total, size, and an expiry — so a reassembler can reject a stale,
// truncated, or tampered sequence instead of silently waiting forever or
// concatenating the wrong bytes.

import crypto from "node:crypto";

// Comfortably under the ~1MB native-messaging ceiling once JSON + base64
// overhead (4/3 expansion) is accounted for: 700_000 raw bytes -> ~933KB of
// base64 text, plus a small envelope, safely under 1MB.
export const DEFAULT_MAX_CHUNK_BYTES = 700_000;
export const DEFAULT_CHUNK_TTL_MS = 60_000;

export function newChunkId() {
  return crypto.randomBytes(12).toString("hex");
}

/**
 * Split a Buffer/Uint8Array into a bounded sequence of chunk envelopes.
 * Returns an array starting with one CHUNK_BEGIN-shaped descriptor followed
 * by CHUNK_PART entries and a final CHUNK_END marker, so a receiver can
 * validate the announced total up front and detect a short sequence.
 */
export function chunkBuffer(buffer, opts = {}) {
  const maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  const ttlMs = opts.ttlMs ?? DEFAULT_CHUNK_TTL_MS;
  if (!(buffer instanceof Uint8Array)) {
    throw new Error("chunkBuffer requires a Buffer/Uint8Array");
  }
  if (maxChunkBytes <= 0) throw new Error("maxChunkBytes must be positive");

  const chunkId = opts.chunkId || newChunkId();
  const expiresAt = Date.now() + ttlMs;
  const total = Math.max(1, Math.ceil(buffer.length / maxChunkBytes));
  const parts = [];
  for (let i = 0; i < total; i++) {
    const start = i * maxChunkBytes;
    const slice = buffer.subarray(start, Math.min(start + maxChunkBytes, buffer.length));
    parts.push({
      type: "chunk_part",
      chunkId,
      index: i,
      total,
      size: slice.length,
      expiresAt,
      dataB64: Buffer.from(slice).toString("base64"),
      ...(opts.meta || {})
    });
  }
  return {
    begin: { type: "chunk_begin", chunkId, total, totalBytes: buffer.length, expiresAt, ...(opts.meta || {}) },
    parts,
    end: { type: "chunk_end", chunkId, total, expiresAt }
  };
}

export function flattenChunkedMessage(chunked) {
  return [chunked.begin, ...chunked.parts, chunked.end];
}

/**
 * Reassembles one chunk sequence at a time. A fresh instance per logical
 * transfer keeps this trivial to test and impossible to cross-contaminate
 * between unrelated transfers sharing a transport.
 */
export class ChunkReassembler {
  constructor(opts = {}) {
    this.maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    this._state = null; // { chunkId, total, totalBytes, expiresAt, received: Map<index, Buffer> }
  }

  _expired(expiresAt) {
    return typeof expiresAt === "number" && Date.now() > expiresAt;
  }

  /**
   * Feed one envelope (chunk_begin | chunk_part | chunk_end). Returns:
   *  - { done: false } while still assembling
   *  - { done: true, buffer } once chunk_end validates a complete sequence
   * Throws on any validation failure (size over bound, id/total mismatch,
   * expiry, out-of-range index, duplicate/missing part) — callers should
   * treat a throw as a rejected transfer, never a partial success.
   */
  receive(envelope) {
    if (!envelope || typeof envelope !== "object") throw new Error("malformed chunk envelope");

    if (envelope.type === "chunk_begin") {
      if (this._expired(envelope.expiresAt)) throw new Error("chunk sequence already expired");
      if (!Number.isInteger(envelope.total) || envelope.total <= 0) {
        throw new Error("chunk_begin: invalid total");
      }
      this._state = {
        chunkId: envelope.chunkId,
        total: envelope.total,
        totalBytes: envelope.totalBytes,
        expiresAt: envelope.expiresAt,
        received: new Map()
      };
      return { done: false };
    }

    if (envelope.type === "chunk_part") {
      if (!this._state) throw new Error("chunk_part received before chunk_begin");
      if (envelope.chunkId !== this._state.chunkId) throw new Error("chunk_part id mismatch");
      if (this._expired(envelope.expiresAt) || this._expired(this._state.expiresAt)) {
        throw new Error("chunk sequence expired");
      }
      if (!Number.isInteger(envelope.index) || envelope.index < 0 || envelope.index >= this._state.total) {
        throw new Error("chunk_part: index out of range");
      }
      if (envelope.total !== this._state.total) throw new Error("chunk_part: total mismatch");
      if (typeof envelope.size !== "number" || envelope.size < 0 || envelope.size > this.maxChunkBytes) {
        throw new Error(`chunk_part: size ${envelope.size} exceeds bound ${this.maxChunkBytes}`);
      }
      const buf = Buffer.from(String(envelope.dataB64 || ""), "base64");
      if (buf.length !== envelope.size) throw new Error("chunk_part: declared size does not match payload");
      if (this._state.received.has(envelope.index)) throw new Error("chunk_part: duplicate index");
      this._state.received.set(envelope.index, buf);
      return { done: false };
    }

    if (envelope.type === "chunk_end") {
      if (!this._state) throw new Error("chunk_end received before chunk_begin");
      if (envelope.chunkId !== this._state.chunkId) throw new Error("chunk_end id mismatch");
      if (this._expired(envelope.expiresAt) || this._expired(this._state.expiresAt)) {
        throw new Error("chunk sequence expired");
      }
      if (this._state.received.size !== this._state.total) {
        throw new Error(
          `chunk_end: expected ${this._state.total} parts, received ${this._state.received.size}`
        );
      }
      const ordered = [];
      for (let i = 0; i < this._state.total; i++) {
        const part = this._state.received.get(i);
        if (!part) throw new Error(`chunk_end: missing part ${i}`);
        ordered.push(part);
      }
      const buffer = Buffer.concat(ordered);
      if (typeof this._state.totalBytes === "number" && buffer.length !== this._state.totalBytes) {
        throw new Error("chunk_end: assembled size does not match announced totalBytes");
      }
      this._state = null;
      return { done: true, buffer };
    }

    throw new Error(`unknown chunk envelope type: ${envelope.type}`);
  }
}

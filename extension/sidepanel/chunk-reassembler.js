// The panel's half of host/agent/broker/chunked-transport.js.
//
// The host has always been able to reply to a byte request with a chunked
// sequence (companion.js's `{ multi: [...] }` replies), but nothing in the
// extension ever consumed one — `extension/background.js` only implements the
// SENDING half (`chunkBytesForWire`). This module is the missing receiver.
//
// It lives in the panel rather than in background.js on purpose. The
// background worker relays every agent envelope verbatim, including
// `chunk_*`, so the panel can assemble the bytes where they are actually
// used. Assembling in the worker would mean holding a multi-megabyte buffer
// AND its base64 form there, then finding a way to move binary data across
// `chrome.runtime` messaging, which is JSON — a `Uint8Array` sent that way
// arrives as an index-keyed object, not as bytes.
//
// The validation mirrors the host reassembler exactly, and for the same
// reason: a stale, duplicated, out-of-order, short or oversized sequence must
// be REJECTED, never silently turned into a corrupt file the operator would
// then download and blame on the model.

// Must match host/agent/broker/chunked-transport.js's DEFAULT_MAX_CHUNK_BYTES.
// A part larger than this is refused rather than trusted: the bound is what
// keeps one hostile or buggy envelope from allocating without limit.
export const MAX_CHUNK_BYTES = 700000;

export class ChunkReassembler {
  constructor({ maxChunkBytes = MAX_CHUNK_BYTES, now = Date.now } = {}) {
    this.maxChunkBytes = maxChunkBytes;
    this._now = now;
    this._state = null;
  }

  _expired(expiresAt) {
    return typeof expiresAt === "number" && this._now() > expiresAt;
  }

  /**
   * Feed one envelope (chunk_begin | chunk_part | chunk_end).
   *
   * @returns {{done: false} | {done: true, bytes: Uint8Array, meta: object}}
   * @throws on any validation failure — a throw means the transfer is
   *   rejected, never partially accepted.
   */
  receive(envelope) {
    if (!envelope || typeof envelope !== "object") throw new Error("malformed chunk envelope");

    if (envelope.type === "chunk_begin") {
      if (this._expired(envelope.expiresAt)) throw new Error("chunk sequence already expired");
      if (!Number.isInteger(envelope.total) || envelope.total <= 0) throw new Error("chunk_begin: invalid total");
      this._state = {
        chunkId: envelope.chunkId,
        total: envelope.total,
        totalBytes: envelope.totalBytes,
        expiresAt: envelope.expiresAt,
        // Everything the host attached as `meta` travels on the begin
        // envelope — filename, mime type, format — so the receiver can name
        // and type the assembled bytes without a second round trip.
        meta: envelope,
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
      if (this._state.received.has(envelope.index)) throw new Error("chunk_part: duplicate index");
      const bytes = base64ToBytes(String(envelope.dataB64 || ""));
      if (bytes.length !== envelope.size) throw new Error("chunk_part: declared size does not match payload");
      this._state.received.set(envelope.index, bytes);
      return { done: false };
    }

    if (envelope.type === "chunk_end") {
      if (!this._state) throw new Error("chunk_end received before chunk_begin");
      if (envelope.chunkId !== this._state.chunkId) throw new Error("chunk_end id mismatch");
      if (this._expired(envelope.expiresAt) || this._expired(this._state.expiresAt)) {
        throw new Error("chunk sequence expired");
      }
      if (this._state.received.size !== this._state.total) {
        throw new Error(`chunk_end: expected ${this._state.total} parts, received ${this._state.received.size}`);
      }
      let length = 0;
      for (let i = 0; i < this._state.total; i += 1) {
        const part = this._state.received.get(i);
        if (!part) throw new Error(`chunk_end: missing part ${i}`);
        length += part.length;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (let i = 0; i < this._state.total; i += 1) {
        const part = this._state.received.get(i);
        bytes.set(part, offset);
        offset += part.length;
      }
      if (typeof this._state.totalBytes === "number" && bytes.length !== this._state.totalBytes) {
        throw new Error("chunk_end: assembled size does not match announced totalBytes");
      }
      const meta = this._state.meta;
      this._state = null;
      return { done: true, bytes, meta };
    }

    throw new Error(`unknown chunk envelope type: ${envelope.type}`);
  }

  /** Drop any partial state (a request that timed out or was superseded). */
  reset() {
    this._state = null;
  }
}

/**
 * base64 -> bytes.
 *
 * `atob` yields a binary string; each code unit is one byte. Written as an
 * explicit loop rather than `Uint8Array.from(s, c => c.charCodeAt(0))` because
 * the loop is measurably cheaper on the multi-megabyte strings a large
 * document produces, and this runs on the panel's own thread.
 */
export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

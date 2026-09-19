import { ChunkReassembler } from "./chunk-reassembler.js";

// Historical bytes only. Identity is checked at both request and chunk begin;
// neither this client nor its caller has any browser capture capability.
export class ArtifactClient {
  constructor({ send, timeoutMs = 15000 } = {}) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequences = new Map();
  }
  fetch({ conversationId, artifactId }) {
    if (!conversationId || !artifactId) return Promise.resolve({ found: false, reason: "missing_id" });
    if (this.pending.size >= 4) return Promise.resolve({ found: false, reason: "busy" });
    const requestId = `artifact_${crypto.randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.settle(requestId, { found: false, reason: "timeout" }), this.timeoutMs);
      this.pending.set(requestId, { conversationId, artifactId, resolve, timer });
      try { this.send({ conversationId, artifactId, requestId }); }
      catch { this.settle(requestId, { found: false, reason: "send_failed" }); }
    });
  }
  handleEnvelope(env) {
    if (env?.type === "action_artifact") {
      const p = this.pending.get(env.requestId);
      if (!p || env.conversationId !== p.conversationId || env.artifactId !== p.artifactId) return false;
      this.settle(env.requestId, { found: false, reason: env.reason || "not_found" });
      return true;
    }
    if (env?.type === "chunk_begin" && env.kind === "action_artifact_reply") {
      const p = this.pending.get(env.requestId);
      if (!p) return false;
      if (env.conversationId !== p.conversationId || env.artifactId !== p.artifactId || !["image/jpeg", "image/png", "image/webp"].includes(env.mimeType) || !Number.isInteger(env.totalBytes) || env.totalBytes < 1 || env.totalBytes > 16 * 1024 * 1024 || !Number.isInteger(env.total) || env.total < 1 || env.total > 128 || this.sequences.has(env.chunkId) || [...this.sequences.values()].some(s => s.requestId === env.requestId)) {
        this.settle(env.requestId, { found: false, reason: "invalid_artifact" });
        return true;
      }
      this.sequences.set(env.chunkId, { requestId: env.requestId, mimeType: env.mimeType, totalBytes: env.totalBytes, receivedBytes: 0, receiver: new ChunkReassembler() });
    }
    const seq = this.sequences.get(env?.chunkId);
    if (!seq) return false;
    try {
      if (env.type === "chunk_part") {
        seq.receivedBytes += env.size;
        if (!Number.isFinite(seq.receivedBytes) || seq.receivedBytes > seq.totalBytes || typeof env.dataB64 !== "string" || env.dataB64.length > 940000) throw new Error("oversized artifact");
      }
      const result = seq.receiver.receive(env);
      if (result.done) this.settle(seq.requestId, { found: true, bytes: result.bytes, mimeType: seq.mimeType });
    } catch { this.settle(seq.requestId, { found: false, reason: "transfer_failed" }); }
    return true;
  }
  settle(id, value) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    for (const [key, seq] of this.sequences) if (seq.requestId === id) this.sequences.delete(key);
    p.resolve(value);
  }
  disconnect() {
    for (const id of this.pending.keys()) this.settle(id, { found: false, reason: "disconnected" });
  }
}

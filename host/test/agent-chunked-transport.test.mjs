#!/usr/bin/env node
//
// host/agent/broker/chunked-transport.js: bounded binary chunk transport.
//
// Exercises the acceptance-criteria item "chunked large-payload transport"
// with an actually large payload (several MB — a real screenshot/recording
// size class), not a token-sized stand-in, per design.md's "Test large
// screenshots and recordings rather than assuming arbitrary JSON fits."
//
// Run: node host/test/agent-chunked-transport.test.mjs

import crypto from "node:crypto";
import {
  chunkBuffer,
  flattenChunkedMessage,
  ChunkReassembler,
  DEFAULT_MAX_CHUNK_BYTES
} from "../agent/broker/chunked-transport.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nChunked binary transport\n");

test("a 5MB payload (real screenshot/recording size class) round-trips exactly", () => {
  const payload = crypto.randomBytes(5 * 1024 * 1024);
  const chunked = chunkBuffer(payload);
  assert(chunked.parts.length > 1, "a 5MB payload must actually be split into more than one part");

  const reassembler = new ChunkReassembler();
  let done = null;
  for (const envelope of flattenChunkedMessage(chunked)) {
    const outcome = reassembler.receive(envelope);
    if (outcome.done) done = outcome;
  }
  assert(done, "chunk_end must complete the sequence");
  assert(Buffer.compare(done.buffer, payload) === 0, "reassembled buffer must exactly equal the original");
});

test("every individual wire envelope stays under the native-messaging bound", () => {
  const payload = crypto.randomBytes(3 * 1024 * 1024 + 777); // not a clean multiple
  const chunked = chunkBuffer(payload, { maxChunkBytes: 200_000 });
  for (const envelope of flattenChunkedMessage(chunked)) {
    const wireSize = Buffer.byteLength(JSON.stringify(envelope), "utf-8");
    assert(wireSize < 1_000_000, `one wire envelope was ${wireSize} bytes — over the ~1MB native-messaging ceiling`);
  }
});

test("default chunk size stays comfortably under the 1MB native-messaging ceiling", () => {
  assert(DEFAULT_MAX_CHUNK_BYTES < 1_000_000, "default should leave headroom for base64 expansion + JSON envelope");
});

test("a chunk_part larger than the configured bound is rejected", () => {
  const reassembler = new ChunkReassembler({ maxChunkBytes: 10 });
  reassembler.receive({ type: "chunk_begin", chunkId: "x", total: 1, totalBytes: 20, expiresAt: Date.now() + 10_000 });
  let threw = false;
  try {
    reassembler.receive({
      type: "chunk_part",
      chunkId: "x",
      index: 0,
      total: 1,
      size: 20,
      expiresAt: Date.now() + 10_000,
      dataB64: Buffer.alloc(20).toString("base64")
    });
  } catch {
    threw = true;
  }
  assert(threw, "an oversized chunk_part must be rejected, not silently accepted");
});

test("a mismatched chunkId is rejected", () => {
  const reassembler = new ChunkReassembler();
  reassembler.receive({ type: "chunk_begin", chunkId: "a", total: 1, totalBytes: 1, expiresAt: Date.now() + 10_000 });
  let threw = false;
  try {
    reassembler.receive({
      type: "chunk_part",
      chunkId: "b",
      index: 0,
      total: 1,
      size: 1,
      expiresAt: Date.now() + 10_000,
      dataB64: Buffer.from([1]).toString("base64")
    });
  } catch {
    threw = true;
  }
  assert(threw, "a chunk_part for a different chunkId must be rejected");
});

test("a total mismatch between chunk_begin and a part is rejected", () => {
  const reassembler = new ChunkReassembler();
  reassembler.receive({ type: "chunk_begin", chunkId: "x", total: 2, totalBytes: 2, expiresAt: Date.now() + 10_000 });
  let threw = false;
  try {
    reassembler.receive({
      type: "chunk_part",
      chunkId: "x",
      index: 0,
      total: 3, // lies about the total
      size: 1,
      expiresAt: Date.now() + 10_000,
      dataB64: Buffer.from([1]).toString("base64")
    });
  } catch {
    threw = true;
  }
  assert(threw, "a declared total mismatch must be rejected");
});

test("an expired chunk sequence is rejected, never silently completed", () => {
  const chunked = chunkBuffer(Buffer.from("hello world"), { ttlMs: -1 }); // already expired
  const reassembler = new ChunkReassembler();
  let threw = false;
  try {
    reassembler.receive(chunked.begin);
  } catch {
    threw = true;
  }
  assert(threw, "an already-expired chunk_begin must be rejected up front");
});

test("chunk_end before every part arrives is rejected, not padded with zeros", () => {
  const chunked = chunkBuffer(crypto.randomBytes(2_000_000), { maxChunkBytes: 500_000 });
  assert(chunked.parts.length >= 4, "sanity: expected multiple parts");
  const reassembler = new ChunkReassembler();
  reassembler.receive(chunked.begin);
  reassembler.receive(chunked.parts[0]); // only the first part
  let threw = false;
  try {
    reassembler.receive(chunked.end);
  } catch {
    threw = true;
  }
  assert(threw, "chunk_end with missing parts must be rejected");
});

test("a duplicate index is rejected rather than silently overwriting", () => {
  const chunked = chunkBuffer(crypto.randomBytes(1_500_000), { maxChunkBytes: 500_000 });
  const reassembler = new ChunkReassembler();
  reassembler.receive(chunked.begin);
  reassembler.receive(chunked.parts[0]);
  let threw = false;
  try {
    reassembler.receive(chunked.parts[0]); // same index again
  } catch {
    threw = true;
  }
  assert(threw, "a duplicate chunk index must be rejected");
});

test("a declared size that does not match the actual payload bytes is rejected", () => {
  const reassembler = new ChunkReassembler();
  reassembler.receive({ type: "chunk_begin", chunkId: "x", total: 1, totalBytes: 3, expiresAt: Date.now() + 10_000 });
  let threw = false;
  try {
    reassembler.receive({
      type: "chunk_part",
      chunkId: "x",
      index: 0,
      total: 1,
      size: 999, // lies about size vs actual payload
      expiresAt: Date.now() + 10_000,
      dataB64: Buffer.from([1, 2, 3]).toString("base64")
    });
  } catch {
    threw = true;
  }
  assert(threw, "a declared/actual size mismatch must be rejected");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

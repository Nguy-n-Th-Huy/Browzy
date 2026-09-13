// Unit tests for extension/recorder/gif-encoder.js, exercising the SHIPPED
// file via test/_extract.mjs (never a copy). Plain Node, no browser.
//
// The LZW decoder below lives in THIS test file only: it exists to prove the
// shipped encoder's output decodes back to the input indices. It is not part
// of the product and never ships to the extension.
import { extractFunction, compile } from "./_extract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENCODER = path.join(__dirname, "..", "extension", "recorder", "gif-encoder.js");

const src = [
  "gifLevels",
  "gifBuildPalette",
  "gifQuantizeIndex",
  "gifQuantizeFrame",
  "gifDrawMarker",
  "gifLzwCompress",
  "gifU16LE",
  "gifEncodeGif",
].map((n) => extractFunction(n, ENCODER)).join("\n\n");

const enc = compile(
  src,
  {},
  "{ gifLevels, gifBuildPalette, gifQuantizeIndex, gifQuantizeFrame, gifDrawMarker, gifLzwCompress, gifU16LE, gifEncodeGif }"
);

// --- test-side GIF LZW decoder --------------------------------------------
// Implements the GIF89a convention that real decoders implement, so a
// round-trip here means a real decoder can read the file. A decoder is
// permanently one add behind the encoder: it widens when its own table
// reaches 1<<size, which is the same moment the encoder's next free code
// reaches (1<<size)+1. Do NOT re-pair this to whatever the encoder happens
// to do — that hides a malformed stream instead of catching it. The
// authority is an outside decoder: `ffmpeg -i out.gif` must decode without
// reporting "LZW decode failed".
function lzwDecode(minCodeSize, stream) {
  // Reassemble sub-blocks (stream includes the terminating zero).
  const raw = [];
  let i = 0;
  for (;;) {
    const n = stream[i++];
    if (n === 0) break;
    for (let j = 0; j < n; j++) raw.push(stream[i++]);
  }
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let pos = 0;
  let cur = 0;
  let bits = 0;
  const read = (size) => {
    while (bits < size) {
      if (pos >= raw.length) throw new Error("lzwDecode: truncated stream");
      cur |= raw[pos++] << bits;
      bits += 8;
    }
    const v = cur & ((1 << size) - 1);
    cur >>= size;
    bits -= size;
    return v;
  };
  let table = [];
  let codeSize = 0;
  let available = 0;
  const reset = () => {
    table = [];
    for (let k = 0; k < clear; k++) table[k] = [k];
    codeSize = minCodeSize + 1;
    available = eoi + 1;
  };
  reset();
  const out = [];
  let prev = null;
  for (;;) {
    const code = read(codeSize);
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (code < table.length && table[code] !== undefined) {
      entry = table[code];
    } else if (code === available && prev !== null) {
      entry = prev.concat(prev[0]);
    } else {
      throw new Error(`lzwDecode: bad code ${code} (available=${available})`);
    }
    for (const v of entry) out.push(v);
    if (prev !== null) {
      table[available++] = prev.concat(entry[0]);
      if (available === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

const eq = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);

console.log("== palette ==");
{
  const pal = enc.gifBuildPalette();
  ok(pal.count === 216, `216-entry palette (got ${pal.count})`);
  ok(pal.table.length === 768, `768-byte global table (got ${pal.table.length})`);
  ok(pal.table[0] === 0 && pal.table[1] === 0 && pal.table[2] === 0, "index 0 is black");
  const last = 215 * 3;
  ok(pal.table[last] === 255 && pal.table[last + 1] === 255 && pal.table[last + 2] === 255, "index 215 is white");
  ok(pal.table[216 * 3] === 0 && pal.table[767] === 0, "padding entries are zero");
}

console.log("== quantizer ==");
{
  ok(enc.gifQuantizeIndex(0, 0, 0) === 0, "black -> 0");
  ok(enc.gifQuantizeIndex(255, 255, 255) === 215, "white -> 215");
  ok(enc.gifQuantizeIndex(255, 0, 0) === 5 * 36, "pure red -> r=5 plane");
  ok(enc.gifQuantizeIndex(300, -20, 128) === enc.gifQuantizeIndex(255, 0, 153), "out-of-range clamps");
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 10, 10, 10, 0]);
  const idx = enc.gifQuantizeFrame(rgba, 3, 1);
  ok(idx.length === 3 && idx[0] === 180 && idx[1] === 0, `frame quantizes per pixel (got ${[...idx]})`);
}

console.log("== marker ==");
{
  const w = 40;
  const h = 40;
  const px = new Uint8ClampedArray(w * h * 4);
  const n = enc.gifDrawMarker(px, w, h, 20, 20);
  ok(n > 0, `marker paints pixels (n=${n})`);
  const at = (x, y) => [px[(y * w + x) * 4], px[(y * w + x) * 4 + 1], px[(y * w + x) * 4 + 2]];
  const ring = at(20 + 13, 20);
  ok(ring[0] === 255 && ring[1] === 140 && ring[2] === 0, `ring pixel is orange (got ${ring})`);
  const center = at(20, 20);
  ok(center[0] === 255 && center[1] === 140, "center dot painted");
  const far = at(0, 0);
  ok(far[0] === 0 && far[1] === 0 && far[2] === 0, "distant pixel untouched");
  const px2 = new Uint8ClampedArray(w * h * 4);
  const n2 = enc.gifDrawMarker(px2, w, h, -50, -50);
  ok(n2 === 0, "fully off-frame marker paints nothing and does not throw");
  const px3 = new Uint8ClampedArray(w * h * 4);
  const n3 = enc.gifDrawMarker(px3, w, h, 1, 1);
  ok(n3 > 0, "edge-clipped marker still paints without throwing");
}

console.log("== LZW round-trip ==");
{
  const cases = {
    flat: new Uint8Array(200).fill(7),
    ramp: Uint8Array.from({ length: 512 }, (_, i) => i % 216),
    randomish: Uint8Array.from({ length: 1000 }, (_, i) => (i * 7919 + 13) % 216),
    // Long enough to exhaust the 12-bit table and force a clear mid-stream.
    long: Uint8Array.from({ length: 30000 }, (_, i) => (i * 104729 + 7) % 216),
  };
  for (const [name, input] of Object.entries(cases)) {
    const stream = enc.gifLzwCompress(8, input);
    ok(stream[stream.length - 1] === 0, `${name}: stream ends with the zero terminator`);
    const back = lzwDecode(8, stream);
    ok(eq(back, [...input]), `${name}: decodes back to the input (${input.length} indices)`);
  }
}

console.log("== GIF structure ==");
{
  const w = 4;
  const h = 3;
  const f1 = new Uint8Array(w * h).fill(0);
  const f2 = new Uint8Array(w * h).fill(215);
  const gif = enc.gifEncodeGif(w, h, [
    { indices: f1, delayCs: 10 },
    { indices: f2, delayCs: 25 },
  ], 0);
  const magic = String.fromCharCode(...gif.slice(0, 6));
  ok(magic === "GIF89a", `magic is GIF89a (got ${magic})`);
  ok(gif[gif.length - 1] === 0x3b, "ends with the trailer byte");
  ok(gif[6] === 4 && gif[8] === 3, "logical screen size matches");
  ok(gif[10] === 0xf7, "packed field promises a 256-entry global table");
  const head = String.fromCharCode(...gif.slice(0, 900));
  ok(head.includes("NETSCAPE2.0"), "loop extension present");
  // Frame 1 delay (10cs) and frame 2 delay (25cs) appear as GCE delay words.
  const delays = [];
  for (let i = 0; i < gif.length - 8; i++) {
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) {
      delays.push(gif[i + 4] | (gif[i + 5] << 8));
    }
  }
  ok(eq(delays, [10, 25]), `per-frame delays preserved (got ${delays})`);
  // Decode frame 1's image data back to indices.
  let p = 13 + 768;
  const skipExt = () => {
    if (gif[p] === 0x21 && gif[p + 1] === 0xff) {
      p += 2;
      const appLen = gif[p++];
      p += appLen;
      for (;;) {
        const n = gif[p++];
        if (n === 0) break;
        p += n;
      }
    }
  };
  skipExt();
  // First GCE + descriptor.
  p += 8;
  p += 10;
  const minCode = gif[p++];
  const blocks = [];
  for (;;) {
    const n = gif[p++];
    if (n === 0) break;
    for (let j = 0; j < n; j++) blocks.push(gif[p++]);
  }
  // Re-wrap the raw data bytes into a sub-block stream (with terminator)
  // for the decoder.
  const wrapped = [];
  for (let i = 0; i < blocks.length; i += 255) {
    const n = Math.min(255, blocks.length - i);
    wrapped.push(n);
    for (let j = 0; j < n; j++) wrapped.push(blocks[i + j]);
  }
  wrapped.push(0);
  const back = lzwDecode(minCode, wrapped);
  ok(eq(back, [...f1]), "frame 1 image data decodes to its indices");
}

console.log(fail === 0 ? "\nALL GIF ENCODER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);

// Minimal GIF89a encoder over typed arrays, for the gif_creator path.
//
// Loaded as a CLASSIC script (extension/recorder/offscreen.html loads this
// before offscreen.js), so every function here is a top-level `function`
// declaration with no imports/exports: the offscreen module reads them off
// globalThis (it has canvas + Image; the service worker has neither), and
// test/gif-encoder.test.mjs pulls them out of THIS shipped file with
// test/_extract.mjs's brace matcher and runs them under plain Node.
//
// Scope is deliberately one narrow format: a single global palette (uniform
// 6x6x6), LZW-compressed full frames, a loop block, per-frame delays. No
// local palettes, no interlacing, no transparency, no extensions beyond
// NETSCAPE2.0 looping and the per-frame Graphic Control Extension that
// carries the delay. Anything outside that is out of scope by design.

// Uniform 6-level ramp shared by the palette and the quantizer.
function gifLevels() {
  return [0, 51, 102, 153, 204, 255];
}

// The single global palette: 216 uniform colors in r-major order, padded
// with black to the 256 slots the Logical Screen Descriptor promises.
// Returns { table: Uint8Array(768), count: 216 }.
function gifBuildPalette() {
  const levels = gifLevels();
  const table = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        table[i++] = levels[r];
        table[i++] = levels[g];
        table[i++] = levels[b];
      }
    }
  }
  return { table, count: 216 };
}

// Nearest uniform palette index for one RGB triple. Pure arithmetic, so the
// offscreen path and any future caller quantize identically.
function gifQuantizeIndex(r, g, b) {
  const q = (v) => {
    const n = Math.round(v / 51);
    return n < 0 ? 0 : n > 5 ? 5 : n;
  };
  return q(r) * 36 + q(g) * 6 + q(b);
}

// Map one RGBA frame to palette indices. Alpha is ignored: screencast JPEGs
// are opaque, and canvas ImageData for them is too.
function gifQuantizeFrame(rgba, width, height) {
  const out = new Uint8Array(width * height);
  for (let p = 0, n = 0; p < rgba.length && n < out.length; p += 4, n++) {
    out[n] = gifQuantizeIndex(rgba[p], rgba[p + 1], rgba[p + 2]);
  }
  return out;
}

// Paint a click marker into RGBA pixels in place: an orange ring plus a
// filled center dot, clipped to the frame. Coordinates are floats; they are
// rounded once, here. Returns the number of pixels painted (0 when the
// position is entirely outside the frame — the caller draws nothing then).
function gifDrawMarker(pixels, width, height, x, y, radius, thickness) {
  const r = radius === undefined ? 13 : radius;
  const t = thickness === undefined ? 3 : thickness;
  const cx = Math.round(x);
  const cy = Math.round(y);
  const MR = 255;
  const MG = 140;
  const MB = 0;
  let painted = 0;
  const put = (px, py) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const o = (py * width + px) * 4;
    pixels[o] = MR;
    pixels[o + 1] = MG;
    pixels[o + 2] = MB;
    pixels[o + 3] = 255;
    painted++;
  };
  const half = t / 2;
  for (let py = cy - r - t; py <= cy + r + t; py++) {
    for (let px = cx - r - t; px <= cx + r + t; px++) {
      const d = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
      if (Math.abs(d - r) <= half) put(px, py);
    }
  }
  for (let py = cy - 3; py <= cy + 3; py++) {
    for (let px = cx - 3; px <= cx + 3; px++) {
      const d = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
      if (d <= 3) put(px, py);
    }
  }
  return painted;
}

// GIF-variant LZW compression (early code-size change, clear on exhaustion).
// Returns the image-data sub-block stream INCLUDING the terminating zero
// byte, ready to splice after the LZW minimum-code-size byte.
function gifLzwCompress(minCodeSize, indices) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = [];
  let cur = 0;
  let bits = 0;
  const emit = (code, size) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>= 8;
      bits -= 8;
    }
  };
  let codeSize = minCodeSize + 1;
  emit(clear, codeSize);
  const dict = new Map();
  let next = eoi + 1;
  let prefix = indices.length > 0 ? indices[0] : clear;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    if (dict.has(key)) {
      prefix = dict.get(key);
      continue;
    }
    emit(prefix, codeSize);
    if (next < 4096) {
      dict.set(key, next);
      next++;
      // Widen only once a code that NEEDS the extra bit can actually be
      // emitted. Codes are emitted before the add that follows them, so at
      // width w the largest emittable code is (1<<w)-1 and the table may
      // fill to exactly 1<<w while still emitting at w bits; the next add
      // after that is the first code requiring w+1.
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    } else {
      emit(clear, codeSize);
      dict.clear();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix, codeSize);
  emit(eoi, codeSize);
  if (bits > 0) out.push(cur & 255);
  const blocked = [];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocked.push(n);
    for (let j = 0; j < n; j++) blocked.push(out[i + j]);
  }
  blocked.push(0);
  return Uint8Array.from(blocked);
}

function gifU16LE(v) {
  return [v & 255, (v >> 8) & 255];
}

// Assemble one animated GIF. frames: [{ indices: Uint8Array(w*h),
// delayCs: number }]. loop: 0 loops forever, n repeats n times.
// Returns the complete file bytes.
function gifEncodeGif(width, height, frames, loop) {
  const pal = gifBuildPalette();
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
  bytes.push(...gifU16LE(width), ...gifU16LE(height));
  // GCT flag + 8-bit color resolution + no sort + GCT size 256 (2^(7+1)).
  bytes.push(0xf7, 0x00, 0x00);
  for (let i = 0; i < pal.table.length; i++) bytes.push(pal.table[i]);
  // NETSCAPE2.0 looping extension.
  const loopCount = loop === undefined ? 0 : loop;
  bytes.push(0x21, 0xff, 0x0b);
  const app = "NETSCAPE2.0";
  for (let i = 0; i < app.length; i++) bytes.push(app.charCodeAt(i));
  bytes.push(0x03, 0x01, ...gifU16LE(loopCount), 0x00);
  for (const f of frames) {
    const delay = Math.max(2, Math.round(f.delayCs || 10));
    // Graphic Control Extension: disposal "do not dispose", no transparency.
    bytes.push(0x21, 0xf9, 0x04, 0x04, ...gifU16LE(delay), 0x00, 0x00);
    // Image Descriptor: full frame, no local table, non-interlaced.
    bytes.push(0x2c, ...gifU16LE(0), ...gifU16LE(0), ...gifU16LE(width), ...gifU16LE(height), 0x00);
    bytes.push(8);
    const data = gifLzwCompress(8, f.indices);
    for (let i = 0; i < data.length; i++) bytes.push(data[i]);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

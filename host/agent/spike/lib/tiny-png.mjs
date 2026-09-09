// A minimal, dependency-free PNG encoder for the live vision gate (1.3).
//
// This project has no image library (no sharp/canvas/pngjs/jimp — checked
// before writing this). Gate 1.3's live vision sub-test needs a real,
// randomized image to send to the live provider (there is no live browser to
// take a real screenshot from — see gate-1.3-vision.mjs for exactly which
// half is live and which is harnessed). A flat-color shape on a flat
// background is simple enough to rasterize by hand and encode as an
// uncompressed-filter, truecolor (color type 2) PNG using only Node's
// built-in `zlib` (`deflateSync` for the IDAT stream, `crc32` — available
// since Node 21 — for chunk CRCs). No new dependency, no new npm package.

import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0;
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * @param {{ width: number, height: number, background: [number,number,number],
 *   shape: "circle"|"square", shapeColor: [number,number,number] }} opts
 * @returns {Buffer} a valid PNG file (color type 2 / truecolor, 8-bit, filter type None)
 */
export function encodeSolidShapePng({ width, height, background, shape, shapeColor }) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.32;
  const half = Math.min(width, height) * 0.3;

  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      let color = background;
      if (shape === "circle") {
        const dx = x - cx + 0.5;
        const dy = y - cy + 0.5;
        if (dx * dx + dy * dy <= radius * radius) color = shapeColor;
      } else {
        if (Math.abs(x - cx + 0.5) <= half && Math.abs(y - cy + 0.5) <= half) color = shapeColor;
      }
      raw[offset++] = color[0];
      raw[offset++] = color[1];
      raw[offset++] = color[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Named colors chosen to be unambiguous to both a vision model and a human — no two are close in hue. */
export const NAMED_COLORS = {
  red: [214, 39, 40],
  green: [44, 160, 44],
  blue: [31, 87, 194],
  yellow: [219, 189, 26],
  purple: [148, 62, 189],
  orange: [230, 126, 34]
};
export const SHAPES = ["circle", "square"];

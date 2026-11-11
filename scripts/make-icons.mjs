// Rasterizes the LitePaseo mark into the PNG icons PWAs need (no image dependencies).
// Usage: node scripts/make-icons.mjs   → writes public/icons/*.png
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(size, rgba) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Inside test for a rounded rectangle centred at (0.5, 0.5) with half-size h and radius r. */
const inRounded = (x, y, h, r) => {
  const dx = Math.max(Math.abs(x - 0.5) - (h - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (h - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const GREEN = [31, 122, 77];
const LIGHT = [92, 196, 143];
const PAPER = [246, 248, 245];
const BACKDROP = [24, 27, 26];

/**
 * The mark: a green gradient tile with a soft inner square. `full` paints edge to edge
 * (maskable: platforms crop to their own shape); otherwise the tile has rounded corners.
 */
function render(size, { full = false, scale = 1 } = {}) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let color = null;
          const tileHalf = 0.5 * scale;
          if (full || inRounded(x, y, tileHalf, 0.225 * scale)) {
            color = mix(GREEN, LIGHT, Math.min(1, Math.max(0, (x + (1 - y)) / 2)));
            if (inRounded(x, y, 0.21 * scale, 0.08 * scale)) color = mix(PAPER, color, 0.08);
          }
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      out[i] = alpha ? Math.round(r / (a / 255)) : BACKDROP[0];
      out[i + 1] = alpha ? Math.round(g / (a / 255)) : BACKDROP[1];
      out[i + 2] = alpha ? Math.round(b / (a / 255)) : BACKDROP[2];
      out[i + 3] = Math.round(alpha);
    }
  return png(size, out);
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", render(192));
writeFileSync("public/icons/icon-512.png", render(512));
// Maskable icons keep the mark inside the 80% safe zone and fill the canvas.
writeFileSync("public/icons/maskable-512.png", render(512, { full: true, scale: 0.8 }));
// iOS ignores transparency on home-screen icons; it applies its own rounding.
writeFileSync("public/icons/apple-touch-icon.png", render(180, { full: true, scale: 1 }));
writeFileSync("public/icons/badge-96.png", render(96));
console.log("icons written to public/icons");

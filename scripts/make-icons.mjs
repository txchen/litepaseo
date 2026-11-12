// Rasterizes public/icons/mark.svg (and badge.svg) into the PNG icons PWAs need, with the
// headless Chromium the browser tests already install. Usage: node scripts/make-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

const mark = readFileSync("public/icons/mark.svg", "utf8");
const badge = readFileSync("public/icons/badge.svg", "utf8");
const defs = mark.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? "";
const glyph = mark.match(/<g transform[\s\S]*?<\/g>/)?.[0] ?? "";
// Full-bleed variants: platforms crop maskable icons to their own shape and iOS rounds its own.
const fullBleed = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" fill="url(#bg)"/>` +
  `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${glyph}</g></svg>`;

// Tab icons with a status dot, as Paseo does: blue while an agent works, amber when one needs
// you, green when a finished turn is unread. The ring cuts the dot out of the tile.
const withDot = (color) =>
  mark.replace("</svg>", `<circle cx="404" cy="404" r="96" fill="${color}" stroke="#101118" stroke-width="36"/></svg>`);
const targets = [
  ["favicon-64.png", 64, mark],
  ["favicon-running-64.png", 64, withDot("#3b82f6")],
  ["favicon-attention-64.png", 64, withDot("#f59e0b")],
  ["favicon-unread-64.png", 64, withDot("#22c55e")],
  ["icon-192.png", 192, mark],
  ["icon-512.png", 512, mark],
  ["maskable-512.png", 512, fullBleed(0.8)],
  ["apple-touch-icon.png", 180, fullBleed(0.9)],
  // Notification badge: white on transparent (Android tints it).
  ["badge-96.png", 96, badge],
];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [name, size, svg] of targets) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    writeFileSync(`public/icons/${name}`, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log("wrote", name);
  }
} finally {
  await browser.close();
}

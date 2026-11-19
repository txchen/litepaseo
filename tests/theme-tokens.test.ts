import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const web = new URL("../src/web/", import.meta.url).pathname;
const tokens = readFileSync(join(web, "styles/tokens.css"), "utf8");

/** The declarations of the first block opened by `opener`, comments dropped, in source order. */
function block(css: string, opener: string): string[] {
  const start = css.indexOf(opener);
  assert.ok(start >= 0, `missing ${opener}`);
  const body = css.slice(start + opener.length, css.indexOf("}", start));
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

test("the explicit dark theme and the system dark theme set the same tokens", () => {
  const explicit = block(tokens, ':root[data-theme="dark"] {');
  const system = block(tokens, ':root:not([data-theme="light"]) {');
  assert.ok(explicit.length > 30);
  assert.deepEqual(system, explicit);
});

test("palettes only set tokens the stylesheet defines, and every token is used", () => {
  const defined = new Set(block(tokens, ":root {").map((d) => d.slice(0, d.indexOf(":"))).filter((n) => n.startsWith("--")));
  const theme = readFileSync(join(web, "theme.ts"), "utf8");
  for (const [, name] of theme.matchAll(/"(--[a-z0-9-]+)":/g)) assert.ok(defined.has(name), `${name} is set by a palette but not defined`);

  let sources = "";
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(css|vue|ts)$/.test(entry.name)) sources += readFileSync(path, "utf8");
    }
  };
  walk(web);
  // Used from CSS through var(), or read by script (motion-clock.ts, the theme-color sync).
  for (const name of defined) assert.match(sources, new RegExp(`var\\(${name}[,)]|"${name}"`), `${name} is defined but never used`);
});

test("the stylesheet entry imports every area file, tokens first", () => {
  const entry = readFileSync(join(web, "style.css"), "utf8");
  const imports = [...entry.matchAll(/@import "\.\/styles\/([a-z-]+\.css)";/g)].map((m) => m[1]);
  assert.equal(imports[0], "tokens.css");
  assert.deepEqual([...imports].sort(), readdirSync(join(web, "styles")).filter((f) => f.endsWith(".css")).sort());
  for (const file of imports) assert.ok(existsSync(join(web, "styles", file)));
});

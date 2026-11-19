import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inlineScriptHashes } from "../src/server/app.ts";

test("the CSP admits exactly the inline theme boot script of index.html", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const body = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(body?.includes("litepaseo-theme"), "index.html pins the theme before first paint");
  const root = new URL("..", import.meta.url).pathname;
  assert.deepEqual(inlineScriptHashes(root), [`'sha256-${createHash("sha256").update(body!).digest("base64")}'`]);
});

test("a missing or script-free index.html adds no script sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "litepaseo-csp-"));
  try {
    assert.deepEqual(inlineScriptHashes(dir), []);
    writeFileSync(join(dir, "index.html"), '<script type="module" src="/a.js"></script>');
    assert.deepEqual(inlineScriptHashes(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { highlight, languageFor, MAX_HIGHLIGHT } from "../src/web/highlight.ts";

test("highlighting: fence tags and file paths pick a grammar; output is escaped", () => {
  assert.equal(languageFor("ts"), "ts");
  assert.equal(languageFor("src/web/App.vue"), "vue");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("Makefile"), "makefile");
  assert.equal(languageFor("notes.txt"), null);
  assert.equal(languageFor(""), null);
  const html = highlight('const x = "<b>";', "ts")!;
  assert.match(html, /<span class="hljs-keyword">const<\/span>/);
  assert.ok(html.includes("&lt;b&gt;") && !html.includes("<b>"));
  assert.equal(highlight("plain", null), null);
  assert.equal(highlight("x".repeat(MAX_HIGHLIGHT + 1), "ts"), null);
});

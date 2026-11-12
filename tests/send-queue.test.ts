import test from "node:test";
import assert from "node:assert/strict";
import { SendQueue } from "../src/web/send-queue.ts";
import { highlight, languageFor, MAX_HIGHLIGHT } from "../src/web/highlight.ts";

test("send queue keeps order, pauses at a refused message, and empties per agent", () => {
  const queue = new SendQueue();
  const message = (id: string) => ({ id, text: id, attachments: [] });
  queue.add("a", message("1"));
  queue.add("a", message("2"));
  queue.add("b", message("3"));
  assert.equal(queue.size, 3);
  assert.equal(queue.next("a")?.id, "1");
  const first = queue.take("a", "1")!;
  assert.equal(queue.next("a")?.id, "2");
  // Refused: back at the head, and dispatch waits for the reader.
  queue.unshift("a", { ...first, error: "Not sent" });
  assert.deepEqual(queue.get("a").map(m => m.id), ["1", "2"]);
  assert.equal(queue.next("a"), null);
  assert.equal(queue.take("a", "missing"), null);
  queue.take("a", "1");
  queue.take("a", "2");
  assert.deepEqual(queue.keys(), ["b"]);
  queue.clear();
  assert.equal(queue.size, 0);
});

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

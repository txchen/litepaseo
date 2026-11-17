import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Options = { body: string; renotify: boolean; silent?: boolean; requireInteraction: boolean; tag: string; data: { url: string; events?: unknown[] } };
type Merge = (previous: unknown[], message: Record<string, unknown>) => { title: string; options: Options };

function loadMerge(): Merge {
  const self: Record<string, unknown> = { addEventListener() {} };
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
  return self.mergeNotification as Merge;
}

const push = (session: string, kind: string, detail: string, conversation = session) => ({
  title: `repo · ${kind}`,
  body: `${detail} — MacBook`,
  tag: "project:h:repo",
  url: `/?session=${session}`,
  kind,
  badge: 0,
  session,
  project: "repo",
  conversation,
  detail,
  host: "MacBook",
});

test("pushes for one project merge into one notification, one line per conversation", () => {
  const merge = loadMerge();
  const first = merge([], push("a", "turn-done", "Fixed the bug."));
  assert.equal(first.title, "repo · turn-done");
  assert.equal(first.options.body, "Fixed the bug. — MacBook");
  assert.equal(first.options.renotify, true, "the project's first event alerts");

  const second = merge(first.options.data.events!, push("b", "turn-done", "Added docs.", "Docs"));
  assert.equal(second.title, "repo · 2 conversations, updates");
  assert.equal(second.options.body, "Finished · Docs: Added docs.\nFinished · a: Fixed the bug.\n— MacBook");
  assert.deepEqual([second.options.renotify, second.options.silent], [false, true], "later turn ends update silently");

  const third = merge(second.options.data.events!, push("a", "attention", "The agent asks: Which branch?", "Fix"));
  assert.equal(third.title, "repo · 2 conversations, 1 needs input");
  assert.equal(third.options.body, "Needs input · Fix: The agent asks: Which branch?\nFinished · Docs: Added docs.\n— MacBook", "a conversation keeps only its latest event");
  assert.deepEqual([third.options.renotify, third.options.requireInteraction], [true, true], "needing the user always alerts");

  const fourth = merge(third.options.data.events!, push("c", "turn-done", "Done."));
  assert.equal(fourth.options.data.url, "/?session=a", "tapping opens the conversation that waits for you");
});

test("long merges are capped and test pushes are left alone", () => {
  const merge = loadMerge();
  let events: unknown[] = [];
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) events = merge(events, push(id, "turn-done", "ok")).options.data.events!;
  const last = merge(events, push("h", "turn-done", "ok"));
  assert.match(last.options.body, /\n\+3 more\n— MacBook$/);
  const tested = merge([], { title: "LitePaseo notifications work", body: "hi", tag: "litepaseo-test", url: "/", kind: "test", badge: 0 });
  assert.deepEqual([tested.title, tested.options.body, tested.options.renotify], ["LitePaseo notifications work", "hi", true]);
});

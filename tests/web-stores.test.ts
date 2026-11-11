import test from "node:test";
import assert from "node:assert/strict";
import { DirectoryStore } from "../src/web/directory-store.ts";
import { TimelineStore } from "../src/web/timeline-store.ts";
import type { AgentSummary } from "../src/shared/wire.ts";

const summary = (key: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  key,
  hostId: key.split(":")[0],
  id: key.split(":")[1],
  title: key,
  status: "idle",
  provider: "codex",
  cwd: "/",
  project: "p",
  projectKey: null,
  activityAt: 0,
  attention: false,
  state: "done",
  unread: false,
  lastError: null,
  pendingPermissions: [],
  ...extra,
});

test("DirectoryStore keeps most-recent-first order under deltas", () => {
  const store = new DirectoryStore();
  store.apply({
    type: "snapshot",
    generation: "g",
    seq: 3,
    agents: [summary("h:a", { activityAt: 1 }), summary("h:b", { activityAt: 2 }), summary("h:c", { activityAt: 3 })],
  });
  assert.deepEqual(store.range(0, 10).map((a) => a.id), ["c", "b", "a"]);
  store.apply({
    type: "changes",
    generation: "g",
    seq: 5,
    changes: [
      { key: "h:a", value: summary("h:a", { activityAt: 1, attention: true }) },
      { key: "h:b", value: summary("h:b", { activityAt: 2, status: "running" }) },
      { key: "h:c", value: null },
    ],
  });
  assert.deepEqual(store.range(0, 10).map((a) => a.id), ["b", "a"]);
  assert.equal(store.get("h:c"), undefined);
  const version = store.version.value;
  store.apply({ type: "changes", generation: "other", seq: 9, changes: [{ key: "h:a", value: null }] });
  assert.equal(store.version.value, version, "changes for another BFF generation are ignored");
  assert.equal(store.seq, 5);
});

test("DirectoryStore applies a change in O(log n) even with a large directory", () => {
  const store = new DirectoryStore();
  const agents = Array.from({ length: 50_000 }, (_, i) => summary("h:" + i, { activityAt: i }));
  store.apply({ type: "snapshot", generation: "g", seq: 1, agents });
  const started = performance.now();
  for (let i = 0; i < 20_000; i++)
    store.apply({
      type: "changes",
      generation: "g",
      seq: i + 2,
      changes: [{ key: "h:" + (i % 50_000), value: summary("h:" + (i % 50_000), { activityAt: 100_000 + i }) }],
    });
  assert.ok(performance.now() - started < 1000, "20k changes over 50k agents must not scale linearly");
  assert.equal(store.range(0, 1)[0].id, "19999");
  assert.equal(store.size, 50_000);
});

test("TimelineStore: appends update only the row; inserts and prepends change membership", () => {
  const store = new TimelineStore();
  const row = (seqStart: number, text: string) => ({
    seqStart,
    seqEnd: seqStart,
    timestamp: "t",
    provider: "codex",
    item: { type: "assistant_message", text },
  });
  store.apply([{ type: "reset", epoch: "e", rows: [row(5, "a"), row(7, "b")], hasOlder: true, startCursor: { epoch: "e", seq: 5 } }]);
  const membership = store.membership.value;
  const lastRef = store.rows[1].row;
  store.apply([{ type: "append", seqStart: 7, seqEnd: 9, timestamp: "t2", text: "cd" }]);
  assert.equal(store.membership.value, membership, "an append must not re-render the list");
  assert.equal(lastRef.value.item.text, "bcd");
  assert.equal(lastRef.value.seqEnd, 9);
  store.apply([{ type: "upsert", row: row(6, "mid") }]);
  assert.deepEqual(store.rows.map((r) => r.seqStart), [5, 6, 7]);
  assert.equal(store.membership.value, membership + 1);
  assert.equal(
    store.prepend({ epoch: "e", rows: [row(1, "old"), row(5, "dup")], hasOlder: false, startCursor: null }),
    1,
  );
  assert.deepEqual(store.rows.map((r) => r.seqStart), [1, 5, 6, 7]);
  assert.equal(store.rows[1].row.value.item.text, "a", "prepend never overwrites live rows");
  assert.equal(store.prepend({ epoch: "old", rows: [row(0, "x")], hasOlder: false, startCursor: null }), 0);
});

test("renderMarkdown escapes all input and only emits safe links", async () => {
  const { renderMarkdown } = await import("../src/web/markdown.ts");
  const html = renderMarkdown(
    [
      "# Title",
      "<img src=x onerror=alert(1)> **bold** and `<b>code</b>`",
      "[ok](https://example.com) [bad](javascript:alert(1)) https://auto.link/x.",
      "",
      "```js",
      "const a = '<script>';",
      "```",
      "- [x] done",
      "- item",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n"),
  );
  assert.ok(!/<img|<script|<b>|href="javascript/.test(html), html);
  assert.ok(html.includes("<h3>Title</h3>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>&lt;b&gt;code&lt;/b&gt;</code>"));
  assert.ok(html.includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>'));
  assert.ok(html.includes('href="https://auto.link/x"'));
  assert.ok(html.includes("const a = &#39;&lt;script&gt;&#39;;"));
  assert.ok(html.includes('class="check done"'));
  assert.ok(html.includes("<th>a</th>") && html.includes("<td>2</td>"));
});

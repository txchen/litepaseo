import test from "node:test";
import assert from "node:assert/strict";
import { DirectoryStore } from "../src/web/directory-store.ts";
import { TimelineStore } from "../src/web/timeline-store.ts";
import type { AgentSummary, TimelineRow } from "../src/shared/wire.ts";

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
  workspaceId: null,
  attention: false,
  state: "done",
  unread: false,
  lastError: null,
  pendingPermissions: [],
  ...extra,
});

test("DirectoryStore keeps most-recent-first order under deltas", () => {
  const store = new DirectoryStore<AgentSummary>();
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
  const store = new DirectoryStore<AgentSummary>();
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

test("TimelineStore: appends update only the row; inserts change membership", () => {
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
});

test("TimelineStore: a reset of the same conversation keeps unchanged rows, so they do not render again", () => {
  const store = new TimelineStore();
  const row = (seqStart: number, text: string, seqEnd = seqStart): TimelineRow => ({
    seqStart, seqEnd, timestamp: "t", provider: "codex", item: { type: "assistant_message", text },
  });
  const reset = (epoch: string, rows: TimelineRow[]) =>
    store.apply([{ type: "reset", epoch, rows, hasOlder: false, startCursor: null }]);
  reset("e", [row(1, "a"), row(2, "b"), row(3, "c")]);
  const [first, second, third] = store.rows;
  const thirdRow = third.row;
  // Away meanwhile: row 3 grew, row 4 arrived, row 1 left the server's window.
  reset("e", [row(2, "b"), row(3, "cd", 5), row(6, "new")]);
  assert.deepEqual(store.rows.map((r) => r.seqStart), [2, 3, 6]);
  assert.equal(store.rows[0], second, "an unchanged row keeps its ref");
  assert.equal(store.rows[1], third, "a changed row is updated in place");
  assert.equal(thirdRow.value.item.text, "cd");
  assert.equal(thirdRow.value.seqEnd, 5);
  assert.equal(store.rows.indexOf(first), -1, "a row the server no longer sends is dropped");
  // The same rows with different content (a server-side image, say) are not kept as they were.
  reset("e", [{ ...row(2, "b"), item: { type: "assistant_message", text: "b", images: ["x"] } }, row(3, "cd", 5), row(6, "new")]);
  assert.equal(store.rows[0], second);
  assert.deepEqual(second.row.value.item, { type: "assistant_message", text: "b", images: ["x"] });
  // A rewound conversation (new epoch) starts over.
  reset("e2", [row(2, "b")]);
  assert.notEqual(store.rows[0], second, "another epoch never reuses rows");
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

test("renderMarkdown keeps links and images intact through later formatting", async () => {
  const { renderMarkdown } = await import("../src/web/markdown.ts");
  const p = (html: string) => html.replace(/^<p>|<\/p>$/g, "");
  const ext = 'target="_blank" rel="noopener noreferrer"';

  // URLs with emphasis markers are not mangled, in links or as bare autolinks.
  assert.equal(p(renderMarkdown("[init](https://example.com/__init__/x~~y~~)")), `<a href="https://example.com/__init__/x~~y~~" ${ext}>init</a>`);
  assert.equal(p(renderMarkdown("see https://example.com/__init__.py and *this*")), `see <a href="https://example.com/__init__.py" ${ext}>https://example.com/__init__.py</a> and <em>this</em>`);
  assert.equal(p(renderMarkdown("https://x.dev/a_b_c*d*")), `<a href="https://x.dev/a_b_c*d*" ${ext}>https://x.dev/a_b_c*d*</a>`);

  // A URL in a title, alt text or label never becomes markup inside the tag.
  const titled = p(renderMarkdown('[docs](https://a.dev "x https://evil.dev/ onmouseover=alert(1)")'));
  assert.equal(titled, `<a href="https://a.dev" title="x https://evil.dev/ onmouseover=alert(1)" ${ext}>docs</a>`);
  const image = p(renderMarkdown("![shot https://evil.dev/ __x__](/api/hosts/h/image?path=a.png)"));
  assert.equal(image, '<img src="/api/hosts/h/image?path=a.png" alt="shot https://evil.dev/ __x__" loading="lazy" decoding="async">');
  assert.equal(p(renderMarkdown("[see https://b.dev](https://a.dev)")), `<a href="https://a.dev" ${ext}>see https://b.dev</a>`, "no anchor nested in an anchor");
  // Labels still take emphasis, and an image may be a link.
  assert.equal(p(renderMarkdown("[**bold** _it_](https://a.dev)")), `<a href="https://a.dev" ${ext}><strong>bold</strong> <em>it</em></a>`);
  assert.match(renderMarkdown("[![a](/api/hosts/h/i.png)](https://a.dev)"), /<a href="https:\/\/a.dev"[^>]*><img src="\/api\/hosts\/h\/i.png"/);
  // Emphasis around a link wraps the whole element.
  assert.equal(p(renderMarkdown("**[a](https://a.dev)**")), `<strong><a href="https://a.dev" ${ext}>a</a></strong>`);

  // Entities in hrefs are escaped once, not twice.
  assert.equal(p(renderMarkdown("[q](https://a.dev/?a=1&b='x')")), `<a href="https://a.dev/?a=1&amp;b=&#39;x&#39;" ${ext}>q</a>`);

  // Forged placeholders and attribute breakouts stay inert text.
  for (const attack of ["\u00000\u0000 [a](https://a.dev)", '[x](https://a.dev"onmouseover="alert(1))', "[x](javascript:alert(1)) <script>", '![x" onerror="alert(1)](/api/hosts/h/a.png)']) {
    const html = renderMarkdown(attack);
    assert.doesNotMatch(html, /\u0000|<script|href="javascript|" onerror=|"onmouseover=/, attack);
    for (const tag of html.match(/<[^>]+>/g) ?? []) assert.match(tag, /^<\/?[a-z]+(\s[a-z-]+="[^"<>]*")*\s*\/?>$/, `well-formed tag in ${attack}: ${tag}`);
  }
});

test("newId returns RFC 4122 v4 UUIDs, also where randomUUID is missing (plain-http LAN)", async () => {
  const { newId } = await import("../src/web/id.ts");
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(newId(), UUID);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const real = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: real.getRandomValues.bind(real) } });
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, UUID);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    assert.match(newId(), UUID);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

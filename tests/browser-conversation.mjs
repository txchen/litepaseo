// Production-build browser checks for the conversation view: syntax-highlighted code blocks,
// the queue above the composer while a turn runs, history that pages itself in both
// directions as the reader scrolls (no "show earlier/newer" clicks), returning to live, the
// Paseo-style turn footer, rewind to a user message, and the prompt outline rail.
import { chromium } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:net";

const directory = mkdtempSync(join(tmpdir(), "lp-conv-"));
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const env = { ...process.env, LITEPASEO_DATA_DIR: directory, LITEPASEO_PORT: String(port) };
const run = (c) => execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), c], { env, encoding: "utf8", timeout: 15000 });

const TOTAL = 400, LIVE = 200, START = Date.parse("2026-01-05T10:00:00Z");
// One line of thinking, too long for the row: shown with an ellipsis, it must still open.
const LONG_THOUGHT = "Considering whether the cache layer should be invalidated per workspace " + "or per agent, ".repeat(12) + "END_OF_THOUGHT";
// Two rows per turn: the question (odd seq) and its answer 75 s later.
const row = (seq) => ({
  seqStart: seq, seqEnd: seq === TOTAL ? TOTAL + 2 : seq, timestamp: new Date(START + seq * 75_000).toISOString(), provider: "claude",
  turnId: `turn-${Math.ceil(seq / 2)}`,
  item: seq === TOTAL - 2 ? { type: "reasoning", text: LONG_THOUGHT }
    : seq % 2
    ? { type: "user_message", text: `question ${seq}`, messageId: `msg-${seq}`, ...(seq === TOTAL - 1 ? { imageUrls: ["/fixture-image.png"] } : {}) }
    : { type: "assistant_message", text: seq === TOTAL
      ? "Final answer\n\n```ts\nconst answer: number = 42; // the answer\n```\n\n![Agent diagram](/code/app/docs/diagram.png) ![Flow](docs/flow.svg) ![Lost](/tmp/lost.png)\n\nSee [the report](/code/app/docs/report.md), [the handler](src/server.ts#L120-L122), [the report source](docs/report.md:3), [the docs folder](docs/) and [the spec](/tmp/spec.md)."
      : `answer ${seq}\n\nA second paragraph so that rows have some height.` },
});
const sse = (...events) => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
});

let browser;
try {
  run("start");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let status = "running", seq = 1, diffFailure = false, provider = "claude", rejectNextSend = false, timelineDelay = 0, serverVersion = null;
  const queue = [];
  const messages = [], pages = [], rewinds = [], fileReads = [];
  const agent = () => ({
    key: "alpha:a1", hostId: "alpha", id: "a1", workspaceId: "w1", title: "Long conversation",
    status, turnActive: status === "running", provider, deliveryModes: provider === "claude" ? ["queue", "steer", "interrupt"] : ["queue", "interrupt"], model: "claude-opus-5-5", rewind: ["conversation", "files", "both"],
    cwd: "/code/app", project: "app", projectKey: null,
    activityAt: 1, attention: false, state: status === "running" ? "running" : "done", unread: false,
    lastError: null, pendingPermissions: [],
  });
  const workspace = { key: "alpha:w1", hostId: "alpha", id: "w1", name: "Long conversation", title: null, project: "app",
    projectKey: "app", rootPath: "/code/app", directory: "/code/app", kind: "local_checkout", branch: "main",
    pinnedAt: 0, activityAt: 1, state: "running", attention: false, unread: false };
  // Every reconnect answers with a fresh snapshot of the current agent state.
  await page.route("**/api/stream**", (route) => route.fulfill(sse(
    { type: "hosts", hosts: [{ id: "alpha", label: "Alpha", state: "connected" }], ...(serverVersion ? { version: serverVersion } : {}) },
    { type: "workspaces-snapshot", generation: "wgen", seq: 1, workspaces: [workspace] },
    { type: "snapshot", generation: "gen", seq: ++seq, agents: [agent()] },
  )));
  await page.route("**/api/usage**", (route) => route.fulfill({ json: { fetchedAt: new Date().toISOString(), unavailableHosts: [], accounts: [] } }));
  await page.route("**/api/hosts**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p.endsWith("/timeline/stream")) {
      if (timelineDelay) await new Promise((r) => setTimeout(r, timelineDelay));
      const rows = [];
      for (let s = TOTAL - LIVE + 1; s <= TOTAL; s++) rows.push(row(s));
      return route.fulfill(sse({ type: "ops", ops: [{ type: "reset", epoch: "e1", hasOlder: true,
        startCursor: { epoch: "e1", seq: TOTAL - LIVE + 1 }, rows }] }));
    }
    if (p.endsWith("/timeline/prompts")) {
      const prompts = [];
      for (let s = 1; s <= TOTAL; s += 2) prompts.push({ seq: s, preview: `question ${s}` });
      return route.fulfill({ json: { epoch: "e1", prompts } });
    }
    if (p.endsWith("/rewind")) {
      rewinds.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (p.endsWith("/timeline")) {
      const cursor = JSON.parse(url.searchParams.get("cursor"));
      pages.push(cursor.seq);
      const rows = [];
      for (let s = Math.max(1, cursor.seq - 100); s < cursor.seq; s++) rows.push(row(s));
      return route.fulfill({ json: { epoch: "e1", hasOlder: rows[0]?.seqStart > 1, startCursor: null, rows } });
    }
    if (p.endsWith("/queue/stream")) return route.fulfill(sse([...queue]));
    if (p.endsWith("/queue")) {
      if (route.request().method() === "POST") {
        queue.push({ ...route.request().postDataJSON(), attachmentNames: [] });
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: queue });
    }
    if (p.includes("/queue/")) {
      const id = p.split("/queue/")[1].split("/")[0];
      const index = queue.findIndex(m => m.id === id);
      if (route.request().method() === "PATCH") queue[index].text = route.request().postDataJSON().text;
      else {
        const [message] = queue.splice(index, 1);
        if (p.endsWith("/send")) messages.push({ ...message, behavior: "interrupt" });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (p.endsWith("/fs/list")) {
      const dir = url.searchParams.get("path");
      const entries = dir === "." ? [{ name: "docs", path: "docs", kind: "directory", size: 0 }, { name: "src", path: "src", kind: "directory", size: 0 }]
        : dir === "docs" ? [{ name: "report.md", path: "docs/report.md", kind: "file", size: 9 }] : [];
      return route.fulfill({ json: { path: dir, entries } });
    }
    if (p.endsWith("/fs/read")) {
      fileReads.push(url.searchParams.get("path"));
      if (url.searchParams.get("path").endsWith(".ts")) {
        const text = Array.from({ length: 300 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
        return route.fulfill({ json: { path: url.searchParams.get("path"), kind: "text", mime: "text/typescript", size: text.length, text } });
      }
      return route.fulfill({ json: { path: url.searchParams.get("path"), kind: "text", mime: "text/markdown", size: 9, text: "# Report\n\nSee [the notes](notes/a.md#intro) and [the parent](../../shared.md).\n\n![Chart](img/chart.png)\n" } });
    }
    if (p.endsWith("/changes") && diffFailure) return route.fulfill({ status: 409, json: {error: "Host unavailable"} });
    if (p.endsWith("/changes")) return route.fulfill({ json: { files: [{ path: "src/example.ts", additions: 1, deletions: 0, hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ type: "add", content: "const changed = true;" }] }] }] } });
    if (p.endsWith("/search") && url.searchParams.get("q") === "merged") return route.fulfill({json: {epoch: "e1", locations: [{seq: 401, role: "assistant"}], nextCursor: null}});
    if (p.endsWith("/search")) return route.fulfill({ json: { epoch: "e1", locations: [{ seq: url.searchParams.has("cursor") ? 21 : 301, role: "user", count: 1 }], nextCursor: url.searchParams.has("cursor") ? null : 42 } });
    if (p.endsWith("/messages/status")) return route.fulfill({ json: { confirmed: [] } });
    if (p.endsWith("/messages")) {
      if (rejectNextSend) {
        rejectNextSend = false;
        return route.fulfill({ status: 409, json: { error: "Message not sent. Choose Queue or Interrupt.", delivery: "not-sent" } });
      }
      messages.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "acknowledged" } });
    }
    if (p.endsWith("/attachments/capabilities")) return route.fulfill({ json: { images: true, files: true, maxBytes: 8 << 20 } });
    if (p.endsWith("/config")) return route.fulfill({ json: { models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", thinking: [] }], modes: [], features: [] } });
    return route.fulfill({ json: {} });
  });

  await page.route("**/api/hosts/alpha/fs/raw?**", route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="100%" height="100%" fill="#408080"/></svg>'}));
  await page.route("**/api/hosts/alpha/agents/a1/image?**", route => route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600"><rect width="100%" height="100%" fill="#408080"/></svg>'}));
  await page.route("**/fixture-image.png*", route => {
    const shape = new URL(route.request().url()).searchParams.get('shape');
    const [width,height] = shape === 'tall' ? [600,2400] : shape === 'wide' ? [2400,400] : [1600,1600];
    return route.fulfill({contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#408080"/><text x="20" y="40">Top</text><text x="20" y="${height-20}">Bottom</text></svg>`});
  });
  /** The marked lines start at `line`, span `count` rows, and are scrolled into view. */
  const expectLineMark = async (line, count) => {
    const mark = page.locator(".file-view .line-mark");
    await mark.waitFor();
    const box = await mark.evaluate((el) => {
      const gutter = el.parentElement.querySelector(".code-gutter");
      const lineHeight = parseFloat(getComputedStyle(gutter).lineHeight);
      const body = el.closest(".file-body").getBoundingClientRect(), rect = el.getBoundingClientRect();
      return { row: (el.offsetTop - parseFloat(getComputedStyle(gutter).paddingTop)) / lineHeight + 1, rows: el.offsetHeight / lineHeight,
        visible: rect.top >= body.top && rect.bottom <= body.bottom };
    });
    assert.deepEqual(box, { row: line, rows: count, visible: true });
  };
  const presenceReports = [];
  await page.route("**/api/presence", async route => {
    presenceReports.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByLabel("Server access token").fill(readFileSync(join(directory, "token"), "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const initialPresence = page.waitForResponse(response => response.url().endsWith("/api/presence") && response.ok());
  await page.locator("button.session", { hasText: "Long conversation" }).click();

  // Foreground viewing is reported independently of the open timeline stream.
  await initialPresence;
  assert.equal(presenceReports.at(-1).key, "alpha:a1");
  const hiddenReport = page.waitForRequest(request => request.url().endsWith("/api/presence") && request.postDataJSON().key === null);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await hiddenReport;
  const foregroundReport = page.waitForRequest(request => request.url().endsWith("/api/presence") && request.postDataJSON().key === "alpha:a1");
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await foregroundReport;

  // 1. Code blocks are highlighted (highlight.js token spans inside the Markstream message).
  const code = page.locator(".markstream-vue pre.code[data-language=ts]");
  await code.waitFor();
  assert.match(await code.textContent(), /const answer: number = 42;/);
  assert.equal(await code.locator(".hljs-keyword", { hasText: "const" }).count(), 1);
  assert.equal(await code.locator(".hljs-comment").count(), 1);
  assert.notEqual(
    await code.locator(".hljs-keyword").first().evaluate((el) => getComputedStyle(el).color),
    await code.evaluate((el) => getComputedStyle(el).color),
    "keywords are colored",
  );

  const agentImage = page.locator('.prose img[alt="Agent diagram"]');
  await agentImage.waitFor();
  await agentImage.evaluate(img => img.decode());
  await agentImage.click();
  await page.getByRole('dialog',{name:'Image',exact:true}).waitFor();
  await page.keyboard.press('Escape');

  // Local file links never point at a missing page: workspace files open in a tab (new tabs use
  // the same deep link), paths outside the workspace are copied instead.
  const reportLink = page.locator(".prose a", { hasText: /^the report$/ });
  assert.equal(await reportLink.getAttribute("href"), "/?session=alpha%3Aa1&file=docs%2Freport.md");
  await reportLink.click();
  await page.locator(".file-view .file-bar-path", { hasText: "docs/report.md" }).waitFor();
  assert.deepEqual(fileReads, ["docs/report.md"]);
  // Relative links in an open Markdown file resolve against its own directory.
  const notesLink = page.locator(".file-markdown a", { hasText: "the notes" });
  assert.equal(await notesLink.getAttribute("href"), "/?session=alpha%3Aa1&file=docs%2Fnotes%2Fa.md");
  const chart = page.locator('.file-markdown img[alt="Chart"]');
  await chart.waitFor();
  assert.equal(await chart.getAttribute("src"), "/api/hosts/alpha/fs/raw?cwd=%2Fcode%2Fapp&path=docs%2Fimg%2Fchart.png");
  await page.waitForFunction(() => document.querySelector('.file-markdown img[alt="Chart"]')?.naturalWidth > 0);
  await page.locator(".file-markdown a", { hasText: "the parent" }).click();
  await page.locator(".file-link-notice", { hasText: "/shared.md" }).waitFor();
  await notesLink.click();
  await page.locator(".file-view .file-bar-path", { hasText: "docs/notes/a.md" }).waitFor();
  assert.deepEqual(fileReads, ["docs/report.md", "docs/notes/a.md"]);
  assert.equal(new URL(page.url()).pathname, "/");
  await page.getByRole("button", { name: "Close docs/notes/a.md", exact: true }).click();
  await page.getByRole("button", { name: "Close docs/report.md", exact: true }).click();
  // A link to lines opens the file scrolled to them, with the lines marked.
  const handlerLink = page.locator(".prose a", { hasText: "the handler" });
  assert.equal(await handlerLink.getAttribute("href"), "/?session=alpha%3Aa1&file=src%2Fserver.ts&line=120-122");
  await handlerLink.click();
  await expectLineMark(120, 3);
  // Back on the tab later: where the reader left it, not the jump again.
  const fileBody = page.locator(".file-view .file-body");
  await fileBody.evaluate((el) => (el.scrollTop = 1000));
  const conversationTab = page.locator(".agent-tabs button", { hasText: "Long conversation" });
  await conversationTab.click();
  await page.locator(".agent-tabs .file-tab", { hasText: "server.ts" }).click();
  await page.locator(".file-view .line-mark").waitFor();
  await page.waitForTimeout(50);
  assert.equal(await fileBody.evaluate((el) => el.scrollTop), 1000);
  // Markdown opened at a line shows its source once; the reader's switch back to rendered stays.
  await conversationTab.click();
  await page.locator(".prose a", { hasText: "the report source" }).click();
  await expectLineMark(3, 1);
  await page.getByRole("button", { name: "Show rendered" }).click();
  await page.locator(".file-markdown").waitFor();
  await page.locator(".agent-tabs .file-tab", { hasText: "server.ts" }).click();
  await page.locator(".agent-tabs .file-tab", { hasText: "report.md" }).click();
  await page.locator(".file-markdown").waitFor();
  assert.equal(await page.locator(".file-view .code-gutter").count(), 0);
  await page.getByRole("button", { name: "Close docs/report.md", exact: true }).click();
  await page.getByRole("button", { name: "Close src/server.ts", exact: true }).click();
  // A directory link shows the directory in the Files panel.
  await page.locator(".prose a", { hasText: "the docs folder" }).click();
  await page.locator('.tree-row.chosen[data-path="docs"]').waitFor();
  await page.locator('.tree-row[data-path="docs/report.md"]').waitFor();
  await page.locator('.head-tool[aria-label="Files"]').click();
  await page.locator(".prose a", { hasText: "the spec" }).click();
  await page.locator(".composer-notice", { hasText: "/tmp/spec.md" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");

  assert.equal(await agentImage.getAttribute("src"), "/api/hosts/alpha/agents/a1/image?path=%2Fcode%2Fapp%2Fdocs%2Fdiagram.png");
  // SVG never renders inline (it opens in a tab); raster images anywhere on the host's machine,
  // even outside the workspace, load through the host.
  assert.equal(await page.locator(".prose a", { hasText: "Flow" }).getAttribute("href"), "/?session=alpha%3Aa1&file=docs%2Fflow.svg");
  assert.equal(await page.locator('.prose img[alt="Lost"]').getAttribute("src"), "/api/hosts/alpha/agents/a1/image?path=%2Ftmp%2Flost.png");
  assert.equal(await page.locator(".prose img").count(), 2);

  const attachedImage = page.locator(".user-images img");
  await attachedImage.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector(".user-images img")?.naturalWidth > 0);
  await attachedImage.click();
  await page.getByRole("dialog", { name: "Image", exact: true }).waitFor();
  await page.keyboard.press("Escape");

  // Square and tall previews must scroll to both ends, with a reachable close button.
  for (const [width,height,shape] of [[1280,720,'square'],[390,844,'tall'],[844,390,'square'],[390,844,'wide']]) {
    await page.setViewportSize({width,height});
    await attachedImage.evaluate(async (img, shape) => { img.src = '/fixture-image.png?shape=' + shape; await img.decode(); },shape);
    await attachedImage.click();
    const preview = page.getByRole('dialog',{name:'Image',exact:true});
    await preview.locator('img').evaluate(img => img.decode());
    const before = await preview.evaluate(el => ({height:el.clientHeight,scrollHeight:el.scrollHeight,top:el.querySelector('img').getBoundingClientRect().top}));
    assert.ok(before.top >= 0,'the top is reachable without negative scrolling');
    if (shape !== 'wide') {
      assert.ok(before.scrollHeight > before.height,'large images have a real scroll range');
      await page.mouse.move(width / 2, height / 2);
      await page.mouse.wheel(0, 250);
      await page.waitForFunction(() => document.querySelector('.lightbox').scrollTop > 0);
      await preview.focus();
      await page.keyboard.press('Home');
      await page.waitForFunction(() => document.querySelector('.lightbox').scrollTop === 0);
      await page.keyboard.press('End');
      await page.waitForFunction(() => { const el=document.querySelector('.lightbox'); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; });
      const bottom = await preview.locator('img').evaluate(el => el.getBoundingClientRect().bottom);
      assert.ok(bottom <= height,'image bottom is reachable');
    }
    const point = await preview.locator('img').evaluate(el => { const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:(Math.max(r.top,0)+Math.min(r.bottom,innerHeight))/2}; });
    await page.mouse.click(point.x,point.y);
    assert.equal(await preview.count(),1,'clicking the image does not dismiss the preview');
    const close = preview.getByRole('button',{name:'Close image'});
    const box = await close.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= height,'close stays on screen');
    await page.keyboard.press('n');
    assert.equal(await page.getByRole('dialog', {name:'New session',exact:true}).count(),0,'preview does not trigger background shortcuts');
    await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(el => document.activeElement === el),true);
    await close.click();
    assert.equal(await preview.count(),0);
  }
  await page.setViewportSize({width:1280,height:900});

  // 1b. A single long line of thinking is cut off on screen, so it opens to show all of it.
  const thought = page.locator(".row-reasoning").last();
  assert.ok(await thought.locator(".line-text").evaluate((el) => el.scrollWidth > el.clientWidth), "the headline is clipped");
  await thought.locator("summary").click();
  await thought.locator(".reasoning-text", { hasText: "END_OF_THOUGHT" }).waitFor();
  await thought.locator("summary").click();
  await thought.locator(".reasoning-text").waitFor({ state: "detached" });

  // 2. Queue mode while running: the message waits above the composer, not in the conversation.
  const textarea = page.locator(".composer textarea");
  const deliveryMode = page.getByRole("combobox", { name: "Message delivery mode" });
  await deliveryMode.waitFor();
  assert.equal(await deliveryMode.inputValue(), "steer", "native steering is the default");
  await deliveryMode.selectOption("queue");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
  assert.equal(await deliveryMode.inputValue(), "queue", "refresh preserves the explicit choice");
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["queue", "steer", "interrupt"]) {
      await deliveryMode.selectOption(mode);
      await textarea.fill("layout check");
      const boxes = await page.locator(".composer").evaluate(form => {
        const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width }; };
        return { form: box(form), mode: box(form.querySelector('.chip-behavior')), buttons: [...form.querySelectorAll('.composer-actions button')].map(box) };
      });
      assert.ok(boxes.mode.width < 110, `${width}/${mode}: compact mode control`);
      for (const button of boxes.buttons) {
        assert.ok(button.x >= boxes.form.x && button.right <= boxes.form.right, `${width}/${mode}: button stays inside composer`);
        assert.ok(button.width >= 28, `${width}/${mode}: button is not squeezed`);
      }
    }
    await textarea.fill("");
    await deliveryMode.selectOption("queue");
    if (width !== 768) await page.locator(".composer").screenshot({ path: `/tmp/litepaseo-composer-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Stress the action row with voice/cancel-sized controls, long labels and zoom.
  await page.locator('.composer-actions').evaluate(actions => {
    for (let i = 0; i < 3; i++) {
      const button = document.createElement('button');
      button.className = 'disc layout-fixture';
      button.type = 'button';
      button.textContent = '●';
      actions.append(button);
    }
  });
  for (const width of [1280, 320, 280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const zoom of [1, 1.5, 2]) {
      await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
      await textarea.fill('a very long unbroken input '.repeat(100));
      await page.locator('.chip-behavior > span').evaluate(el => { el.textContent = 'A very long translated delivery mode label'; });
      const overflow = await page.locator('.composer').evaluate(form => {
        const bounds = form.getBoundingClientRect();
        const controls = form.querySelectorAll('.composer-actions > *, .composer-tool, .agent-controls, textarea');
        return [...controls].filter(el => {
          const r = el.getBoundingClientRect();
          return r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1;
        }).map(el => el.className);
      });
      assert.deepEqual(overflow, [], `${width}px at ${zoom} zoom: all controls stay inside composer`);
    }
  }
  await page.evaluate(() => { document.body.style.zoom = ''; document.querySelectorAll('.layout-fixture').forEach(el => el.remove()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await deliveryMode.selectOption('interrupt');
  await deliveryMode.selectOption('queue');

  await textarea.fill("first queued");
  await textarea.press("Enter");
  await page.locator(".queue-item", { hasText: "first queued" }).waitFor();
  assert.equal(await textarea.inputValue(), "");
  assert.equal(await page.locator(".row-user", { hasText: "first queued" }).count(), 0);
  await textarea.fill("second queued");
  await textarea.press("Enter");
  await page.locator(".queue-item", { hasText: "second queued" }).waitFor();
  await textarea.fill("third queued");
  await textarea.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 3);
  await page.waitForTimeout(300);
  assert.equal(messages.length, 0, "nothing is sent while the turn runs");
  // Remove, edit back into the composer, and interrupt with one.
  await page.locator(".queue-item", { hasText: "second queued" }).getByRole("button", { name: "Remove queued message" }).click();
  await page.locator(".queue-item", { hasText: "third queued" }).getByRole("button", { name: "Edit queued message" }).click();
  await page.getByRole("textbox", { name: "Queued message text" }).fill("after the turn");
  await page.locator(".queue-item").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".queue-item", { hasText: "after the turn" }).waitFor();
  await page.locator(".queue-item", { hasText: "first queued" }).getByRole("button", { name: "Interrupt" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".queue-item").length === 1);
  assert.deepEqual(messages.map((m) => [m.text, m.behavior]), [["first queued", "interrupt"]]);
  // Explicit Interrupt bypasses the queue and preserves its remaining message.
  for (const mode of ["steer", "interrupt"]) {
    await deliveryMode.selectOption(mode);
    await textarea.fill(`direct ${mode}`);
    const sent = page.waitForResponse(response => response.url().endsWith("/messages") && response.request().method() === "POST");
    await textarea.press("Enter");
    await sent;
    await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === "" && !document.querySelector('.composer textarea')?.disabled);
    assert.equal(messages.at(-1).text, `direct ${mode}`);
    assert.equal(messages.at(-1).behavior, mode);
    assert.equal(queue.length, 1);
    assert.equal(await page.locator(".queue-item").count(), 1);
  }
  await deliveryMode.selectOption("steer");
  assert.match(await page.locator(".chip-behavior").getAttribute("title"), /Paseo may interrupt/);
  provider = "cursor";
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Message delivery mode"] option[value="steer"]'));
  assert.equal(await deliveryMode.inputValue(), "queue");
  provider = "claude";
  await deliveryMode.selectOption("queue");
  // The turn ends: the remaining message goes by itself.
  status = "idle";
  messages.push({ ...queue.shift(), behavior: "steer" }); // BFF owns dispatch; browser only reads the result.
  // Mocked streams end after their events; reconnect now, as a tab that becomes visible does.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => !document.querySelector(".queue-item"), null, { timeout: 10000 });
  assert.deepEqual(messages.map((m) => m.text), ["first queued", "direct steer", "direct interrupt", "after the turn"]);

  // A definite rejection restores the draft and never retries in another mode.
  rejectNextSend = true;
  await textarea.fill("keep my instruction");
  const rejected = page.waitForResponse(response => response.url().endsWith("/messages") && response.status() === 409);
  await textarea.press("Enter");
  await rejected;
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === "keep my instruction");
  await page.getByText("Message not sent. Choose Queue or Interrupt.", { exact: false }).waitFor();
  assert.equal(messages.length, 4);
  assert.equal(queue.length, 0);
  assert.equal(await page.locator(".uncertain").count(), 0);
  await page.locator(".toast button").click();
  await textarea.fill("");

  await page.getByRole("button", { name: "Changes", exact: true }).first().click();
  assert.equal(await page.locator('.changes-panel pre').count(), 0, 'collapsed diffs do not render their hunks');
  await page.locator('.changes-panel summary').click();
  await page.getByText('const changed = true;', { exact: false }).waitFor();
  diffFailure = true;
  await page.getByRole('button', {name: 'Refresh changes'}).click();
  await page.locator('.changes-panel [role=alert]').waitFor();
  assert.equal(await page.locator('.changes-panel details').count(), 0, 'failed refresh does not present stale diffs');
  diffFailure = false;
  await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search conversation content' }).fill('question');
  await page.locator('.conversation-search').getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('.conversation-search .result').waitFor();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();

  // 3. Scrolling up loads earlier pages by itself; scrolling down pages forward and back to live.
  const timeline = page.locator(".timeline");
  const firstSeq = () => page.locator(".timeline [data-seq-start]").first().getAttribute("data-seq-start").then(Number);
  const liveFirst = await firstSeq();
  /**
   * Reads through the timeline as a person scrolls (wheel + scroll, one step per frame), inside
   * the page so no step waits on a test round trip. Returns every row rendered on the way.
   */
  const readThrough = (direction, touch = false) => timeline.evaluate(async (el, { direction, touch }) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const inHistory = () => [...document.querySelectorAll(".older button")].some((b) => b.textContent.includes("Back to latest"));
    const done = () => !document.querySelector(".older-loading") &&
      (direction === "up" ? el.querySelector("[data-seq-start]")?.dataset.seqStart === "1" : !inHistory());
    const seen = new Set();
    const record = () => el.querySelectorAll("[data-seq-start]").forEach((r) => seen.add(Number(r.dataset.seqStart)));
    const dy = direction === "up" ? -1500 : 1500;
    for (let i = 0; i < 3000 && !done(); i++) {
      record();
      if (touch) {
        const finger = y => new Touch({identifier:1,target:el,clientX:100,clientY:y});
        el.dispatchEvent(new TouchEvent('touchstart',{touches:[finger(200)],bubbles:true}));
        el.dispatchEvent(new TouchEvent('touchmove',{touches:[finger(direction === 'up' ? 260 : 140)],bubbles:true}));
        el.dispatchEvent(new TouchEvent('touchend',{touches:[],bubbles:true}));
      } else el.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true }));
      el.scrollBy(0, dy);
      await frame();
    }
    record();
    return [...seen];
  }, { direction, touch });
  await readThrough("up");
  assert.ok((await firstSeq()) === 1, `paged back to the start (first row ${await firstSeq()}, live started at ${liveFirst})`);
  assert.ok(pages.length >= 3, "several earlier pages were fetched");
  assert.ok(await page.locator(".timeline [data-seq-start]").count() <= 150, "the window stays bounded");
  assert.equal(await page.getByRole("button", { name: "Show newer messages" }).count(), 0);
  const shownOnTheWayDown = new Set(await readThrough("down"));
  assert.equal(await page.getByRole("button", { name: "Back to latest" }).count(), 0, "returned to the live tail");
  assert.equal(shownOnTheWayDown.size, TOTAL, "paging forward shows every row once from the start to the tail");
  await page.setViewportSize({width:390,height:844});
  await readThrough("up", true);
  assert.equal(await firstSeq(),1,"touch-only paging reaches the beginning without clicking load more");
  await readThrough("down", true);
  assert.equal(await page.getByRole("button", {name:"Back to latest"}).count(),0);
  await page.setViewportSize({width:1280,height:900});
  await timeline.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.locator(`.timeline [data-seq-start="${TOTAL}"]`).waitFor();

  // 4. Turn footer, as in Paseo: Copy · model · finish time · duration.
  const footer = page.locator(".turn-footer").last();
  await footer.getByText("Claude Opus 5.5").waitFor();
  assert.equal(await footer.getByRole("button", { name: "Copy turn" }).textContent(), "Copy");
  assert.match(await footer.textContent(), /\d{1,2}:\d{2}/);
  assert.match(await footer.textContent(), /1m 15s/, "turn duration from the question to the answer");
  assert.equal(await footer.locator(".provider-icon").count(), 1);

  // 5. Rewind from a user message: a menu of the provider's modes; the prompt returns to the composer.
  const question = page.locator(".row-user", { hasText: `question ${TOTAL - 1}` });
  await question.hover();
  await question.getByRole("button", { name: "Rewind to this message" }).click();
  const menu = question.locator(".rewind-menu");
  await menu.getByText("This action cannot be undone").waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Rewind conversation", "Rewind files", "Rewind conversation and files"]);
  await menu.getByRole("menuitem", { name: "Rewind conversation", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".composer textarea").value === "question 399");
  assert.deepEqual(rewinds, [{ messageId: `msg-${TOTAL - 1}`, mode: "conversation" }]);
  await textarea.fill("");

  // 6. Outline rail: a tick per prompt; resting on it previews the prompt; clicking jumps there.
  const rail = page.getByRole("navigation", { name: "Prompts in this conversation" });
  await rail.waitFor();
  assert.equal(await rail.locator(".outline-slot").count(), TOTAL / 2);
  const tick = rail.getByRole("button", { name: /^11 of 200: question 21$/ });
  await tick.hover();
  await rail.locator(".outline-preview", { hasText: "question 21" }).waitFor();
  await tick.click();
  await page.locator('.timeline [data-seq-start="21"]').waitFor();
  const offset = await page.locator('.timeline [data-seq-start="21"]').evaluate((row) =>
    row.getBoundingClientRect().top - row.closest(".timeline").getBoundingClientRect().top);
  assert.ok(offset >= 0 && offset < 90, `the prompt is at the top of the view (${offset}px)`);
  await page.mouse.move(900, 400);
  await page.waitForFunction(() => !document.querySelector(".outline-preview"));
  // From there, scrolling down pages forward through the later turns back to the live tail.
  // One real wheel event first: the edge of a short window is reached by wheel, not scroll.
  await page.mouse.move(790, 400);
  await page.mouse.wheel(0, 1500);
  const seen = new Set(await readThrough("down"));
  const missing = [];
  for (let s = 21; s <= TOTAL; s++) if (!seen.has(s)) missing.push(s);
  assert.deepEqual(missing, [], "every row from the prompt to the tail was shown on the way down");
  assert.equal(await page.getByRole("button", { name: "Back to latest" }).count(), 0, "paged forward to the live tail");
  const seqs = await page.locator(".timeline [data-seq-start]").evaluateAll((rows) => rows.map((r) => Number(r.dataset.seqStart)));
  assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), "no rows skipped or repeated");

  await page.getByRole('button', { name: 'Search conversation', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search conversation content' }).fill('question');
  await page.locator('.conversation-search').getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'More results', exact: true }).click();
  await page.locator('.conversation-search .result', { hasText: '#21 ' }).click();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.locator('.timeline [data-seq-start="21"]').waitFor();
  await page.getByRole('button', {name: 'Search conversation', exact: true}).click();
  await page.getByRole('searchbox', {name: 'Search conversation content'}).fill('question');
  await page.locator('.conversation-search').getByRole('button', {name: 'Search', exact: true}).click();
  await page.locator('.conversation-search .result').waitFor();
  await page.getByRole('searchbox', {name: 'Search conversation content'}).fill('merged');
  assert.equal(await page.locator('.conversation-search .result').count(), 0);
  await page.locator('.conversation-search').getByRole('button', {name: 'Search', exact: true}).click();
  await page.locator('.conversation-search .result').click();
  await page.getByRole('button', {name: 'Close panel', exact: true}).click();
  await page.locator('.timeline [data-seq-start="400"]').waitFor();
  assert.equal(await page.locator('.timeline [data-seq-start="401"]').count(), 0, 'search hit within merged reply opens the containing row');
  // A file link opened in a new tab loads the app, selects the session and opens the file.
  await page.goto(`http://127.0.0.1:${port}/?session=alpha%3Aa1&file=src%2Fserver.ts&line=250`);
  await page.locator(".file-view .file-bar-path", { hasText: "src/server.ts" }).waitFor();
  await expectLineMark(250, 1);
  // Lines in a Markdown file show in its numbered source view.
  await page.goto(`http://127.0.0.1:${port}/?session=alpha%3Aa1&file=docs%2Freport.md&line=3`);
  await expectLineMark(3, 1);
  assert.equal(await page.locator(".file-markdown").count(), 0);
  // A slow open is reported with the browser's side of the timing.
  timelineDelay = 5000;
  const slowReport = page.waitForRequest((r) => r.url().endsWith("/api/diagnostics/timeline-slow"));
  await page.goto(`http://127.0.0.1:${port}/?session=alpha%3Aa1`);
  // Past 3 s the spinner says what it waits for: here the stream has not even connected.
  await page.locator(".timeline-empty", { hasText: "Still connecting to LitePaseo" }).waitFor();
  const report = (await slowReport).postDataJSON();
  timelineDelay = 0;
  assert.equal(typeof report.pageAgeMs, "number");
  assert.match(report.version, /^\d+\.\d+\.\d+/);
  assert.equal(report.hostId, "alpha");
  assert.equal(report.agentId, "a1");
  assert.ok(report.totalMs >= 3000 && report.connectedMs >= 3000 && report.rowsMs >= report.connectedMs, JSON.stringify(report));
  assert.equal(report.attempts, 1);
  // A page built for another version than the server offers a reload.
  assert.equal(await page.locator(".update-toast").count(), 0);
  serverVersion = "99.0.0";
  await page.goto(`http://127.0.0.1:${port}/?session=alpha%3Aa1`);
  await page.locator(".update-toast", { hasText: "LitePaseo 99.0.0 is installed. Reload to use it." }).waitFor();
  serverVersion = null;
  await Promise.all([page.waitForEvent("load"), page.locator(".update-toast").getByRole("button", { name: "Reload" }).click()]);
  await page.locator(".side-section").waitFor();
  assert.equal(await page.locator(".update-toast").count(), 0);
  // A directory deep link reveals it in the Files panel, on a phone too.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${port}/?session=alpha%3Aa1&dir=docs`);
  await page.locator('.tree-row.chosen[data-path="docs"]').waitFor();
  assert.ok(await page.locator('.tree-row[data-path="docs/report.md"]').isVisible());
  await page.locator('.tree-row[data-path="docs/report.md"]').click();
  await page.locator(".file-view .file-bar-path", { hasText: "docs/report.md" }).waitFor();
  assert.equal(new URL(page.url()).search, "");
  assert.deepEqual(errors, []);
  console.log("PASS browser conversation: highlighted code, queued messages (remove/edit/interrupt/auto-send), auto-paging history both ways, turn footer, rewind, outline rail preview + jump, local file links; no page errors");
} finally {
  await browser?.close();
  run("stop"); // returns once the instance has exited
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

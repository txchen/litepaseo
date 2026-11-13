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
  seqStart: seq, seqEnd: seq, timestamp: new Date(START + seq * 75_000).toISOString(), provider: "claude",
  turnId: `turn-${Math.ceil(seq / 2)}`,
  item: seq === TOTAL - 2 ? { type: "reasoning", text: LONG_THOUGHT }
    : seq % 2
    ? { type: "user_message", text: `question ${seq}`, messageId: `msg-${seq}` }
    : { type: "assistant_message", text: seq === TOTAL
      ? "Final answer\n\n```ts\nconst answer: number = 42; // the answer\n```"
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

  let status = "running", seq = 1;
  const queue = [];
  const messages = [], pages = [], rewinds = [];
  const agent = () => ({
    key: "alpha:a1", hostId: "alpha", id: "a1", workspaceId: "w1", title: "Long conversation",
    status, turnActive: status === "running", provider: "claude", model: "claude-opus-5-5", rewind: ["conversation", "files", "both"],
    cwd: "/code/app", project: "app", projectKey: null,
    activityAt: 1, attention: false, state: status === "running" ? "running" : "done", unread: false,
    lastError: null, pendingPermissions: [],
  });
  const workspace = { key: "alpha:w1", hostId: "alpha", id: "w1", name: "Long conversation", title: null, project: "app",
    projectKey: "app", rootPath: "/code/app", directory: "/code/app", kind: "local_checkout", branch: "main",
    pinnedAt: 0, activityAt: 1, state: "running", attention: false, unread: false };
  // Every reconnect answers with a fresh snapshot of the current agent state.
  await page.route("**/api/stream**", (route) => route.fulfill(sse(
    { type: "hosts", hosts: [{ id: "alpha", label: "Alpha", state: "connected" }] },
    { type: "workspaces-snapshot", generation: "wgen", seq: 1, workspaces: [workspace] },
    { type: "snapshot", generation: "gen", seq: ++seq, agents: [agent()] },
  )));
  await page.route("**/api/usage**", (route) => route.fulfill({ json: { fetchedAt: new Date().toISOString(), unavailableHosts: [], accounts: [] } }));
  await page.route("**/api/hosts**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p.endsWith("/timeline/stream")) {
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
    if (p.endsWith("/messages/status")) return route.fulfill({ json: { confirmed: [] } });
    if (p.endsWith("/messages")) {
      messages.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "acknowledged" } });
    }
    if (p.endsWith("/attachments/capabilities")) return route.fulfill({ json: { images: true, files: true, maxBytes: 8 << 20 } });
    if (p.endsWith("/config")) return route.fulfill({ json: { models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", thinking: [] }], modes: [], features: [] } });
    return route.fulfill({ json: {} });
  });

  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByLabel("Server access token").fill(readFileSync(join(directory, "token"), "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("button.session", { hasText: "Long conversation" }).click();

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

  // 1b. A single long line of thinking is cut off on screen, so it opens to show all of it.
  const thought = page.locator(".row-reasoning").last();
  assert.ok(await thought.locator(".line-text").evaluate((el) => el.scrollWidth > el.clientWidth), "the headline is clipped");
  await thought.locator("summary").click();
  await thought.locator(".reasoning-text", { hasText: "END_OF_THOUGHT" }).waitFor();
  await thought.locator("summary").click();
  await thought.locator(".reasoning-text").waitFor({ state: "detached" });

  // 2. Queue mode while running: the message waits above the composer, not in the conversation.
  const textarea = page.locator(".composer textarea");
  await page.getByRole("button", { name: /^Queue:/ }).waitFor();
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
  // The turn ends: the remaining message goes by itself.
  status = "idle";
  messages.push({ ...queue.shift(), behavior: "steer" }); // BFF owns dispatch; browser only reads the result.
  // Mocked streams end after their events; reconnect now, as a tab that becomes visible does.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => !document.querySelector(".queue-item"), null, { timeout: 10000 });
  assert.deepEqual(messages.map((m) => m.text), ["first queued", "after the turn"]);

  // 3. Scrolling up loads earlier pages by itself; scrolling down pages forward and back to live.
  const timeline = page.locator(".timeline");
  const firstSeq = () => page.locator(".timeline [data-seq-start]").first().getAttribute("data-seq-start").then(Number);
  const liveFirst = await firstSeq();
  /**
   * Reads through the timeline as a person scrolls (wheel + scroll, one step per frame), inside
   * the page so no step waits on a test round trip. Returns every row rendered on the way.
   */
  const readThrough = (direction) => timeline.evaluate(async (el, direction) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const inHistory = () => [...document.querySelectorAll(".older button")].some((b) => b.textContent.includes("Back to latest"));
    const done = () => !document.querySelector(".older-loading") &&
      (direction === "up" ? el.querySelector("[data-seq-start]")?.dataset.seqStart === "1" : !inHistory());
    const seen = new Set();
    const record = () => el.querySelectorAll("[data-seq-start]").forEach((r) => seen.add(Number(r.dataset.seqStart)));
    const dy = direction === "up" ? -1500 : 1500;
    for (let i = 0; i < 3000 && !done(); i++) {
      record();
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true }));
      el.scrollBy(0, dy);
      await frame();
    }
    record();
    return [...seen];
  }, direction);
  await readThrough("up");
  assert.ok((await firstSeq()) === 1, `paged back to the start (first row ${await firstSeq()}, live started at ${liveFirst})`);
  assert.ok(pages.length >= 3, "several earlier pages were fetched");
  assert.ok(await page.locator(".timeline [data-seq-start]").count() <= 150, "the window stays bounded");
  assert.equal(await page.getByRole("button", { name: "Show newer messages" }).count(), 0);
  const shownOnTheWayDown = new Set(await readThrough("down"));
  assert.equal(await page.getByRole("button", { name: "Back to latest" }).count(), 0, "returned to the live tail");
  assert.equal(shownOnTheWayDown.size, TOTAL, "paging forward shows every row once from the start to the tail");
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

  assert.deepEqual(errors, []);
  console.log("PASS browser conversation: highlighted code, queued messages (remove/edit/interrupt/auto-send), auto-paging history both ways, turn footer, rewind, outline rail preview + jump; no page errors");
} finally {
  await browser?.close();
  run("stop"); // returns once the instance has exited
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

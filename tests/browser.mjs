import { chromium } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHmac } from "node:crypto";

// RFC 6238 TOTP, independent of the server implementation.
const base32 = (text) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of text.replace(/\s/g, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
};
const totp = (secret, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = mac[19] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
};
const directory = mkdtempSync(join(tmpdir(), "lp-ui-"));
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const env = { ...process.env, LITEPASEO_DATA_DIR: directory, LITEPASEO_PORT: String(port) };
const run = (c) =>
  execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), c], {
    env,
    encoding: "utf8",
    timeout: 15000,
  });
let browser;
try {
  run("start");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let finishMessage = null;
  let messageFailure = false;
  const messages = [],
    permissions = [];
  // Each mocked stream response ends after its events; the client reconnects with its cursor,
  // which exercises resume. The directory answers resumes with only what changed.
  const sse = (...events) => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  });
  const summary = (host, pending) => ({
    key: `${host}:shared-id`,
    hostId: host,
    id: "shared-id",
    workspaceId: "w-" + host,
    title: host + " conversation",
    status: "idle",
    provider: "codex",
    cwd: "/",
    project: host === "alpha" ? "litepaseo" : "infra",
    projectKey: null,
    activityAt: 1,
    attention: pending.length > 0,
    state: pending.length ? "needs_input" : host === "alpha" ? "unread" : "done",
    unread: !pending.length && host === "alpha",
    lastError: null,
    pendingPermissions: pending,
  });
  // Threads (Paseo workspaces) are what the sidebar lists.
  const thread = (host, extra = {}) => ({
    key: `${host}:w-${host}`,
    hostId: host,
    id: "w-" + host,
    name: host + " conversation",
    title: null,
    project: host === "alpha" ? "litepaseo" : "infra",
    projectKey: host === "alpha" ? "litepaseo" : "infra",
    rootPath: "/code/" + host,
    directory: "/code/" + host,
    kind: "local_checkout",
    branch: "main",
    pinnedAt: 0,
    activityAt: 1,
    state: host === "alpha" ? "unread" : "needs_input",
    attention: host === "beta",
    unread: host === "alpha",
    ...extra,
  });
  const workspacesEvent = { type: "workspaces-snapshot", generation: "wgen-1", seq: 1, workspaces: [thread("alpha"), thread("beta")] };
  // A second agent in beta's thread, to switch between.
  const helper = { ...summary("beta", []), key: "beta:helper", id: "helper", title: "beta helper", activityAt: 0, state: "done", unread: false };
  const hostsEvent = {
    type: "hosts",
    hosts: [
      { id: "alpha", label: "Alpha", state: "connected" },
      { id: "beta", label: "Beta", state: "connected" },
    ],
  };
  const resumes = [];
  await page.route("**/api/stream**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("generation") !== "gen-1")
      return route.fulfill(
        sse(hostsEvent, workspacesEvent, {
          type: "snapshot",
          generation: "gen-1",
          seq: 1,
          agents: [
            summary("alpha", []),
            summary("beta", [{ id: "p-1", name: "Read file", kind: "tool", input: { path: "README.md" } }]),
            helper,
          ],
        }),
      );
    resumes.push(url.searchParams.get("since"));
    const changes = [];
    if (permissions.length) changes.push({ key: "beta:shared-id", value: summary("beta", []) });
    if (creations.length)
      changes.push({
        key: "alpha:new-1",
        value: { ...summary("alpha", []), key: "alpha:new-1", id: "new-1", workspaceId: "w-new", title: "Brand new session", activityAt: 9 },
      });
    return route.fulfill(
      changes.length
        ? sse(hostsEvent, { type: "changes", generation: "gen-1", seq: 2 + changes.length, changes })
        : sse(hostsEvent),
    );
  });
  const threadActions = [];
  const creations = [],
    predictions = [],
    reads = [];
  await page.route("**/api/usage**", (route) =>
    route.fulfill({
      json: {
        fetchedAt: new Date().toISOString(),
        unavailableHosts: [],
        accounts: [
          {
            key: "codex",
            providerId: "codex",
            name: "Codex",
            plan: "Pro",
            source: null,
            status: "available",
            error: null,
            hosts: ["Alpha", "Beta"],
            windows: [
              { id: "5h", label: "5-hour", shortLabel: "5h", remainingPct: 91, resetsAt: new Date(Date.now() + 3 * 3600e3).toISOString(), tone: null },
              { id: "wk", label: "Weekly", shortLabel: "wk", remainingPct: 8, resetsAt: new Date(Date.now() + 3 * 86400e3).toISOString(), tone: null },
            ],
          },
        ],
      },
    }),
  );
  await page.route("**/api/hosts**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    const host = p.split("/")[3];
    if (p.endsWith("/providers"))
      return route.fulfill({
        json: [
          {
            id: "codex",
            label: "Codex",
            status: "ready",
            defaultModeId: null,
            modes: [],
            models: [
              { id: "gpt-5", label: "GPT-5", isDefault: false, thinking: [], defaultThinkingId: null },
              { id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true, thinking: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultThinkingId: "high" },
            ],
          },
          { id: "pi", label: "Pi", status: "ready", defaultModeId: null, modes: [], models: [] },
        ],
      });
    if (p.endsWith("/projects"))
      return route.fulfill({ json: [{ key: "k", name: "litepaseo", rootPath: "/code/litepaseo", kind: "git" }] });
    if (p.endsWith("/agents") && route.request().method() === "POST") {
      creations.push({ host, ...route.request().postDataJSON() });
      return route.fulfill({ status: 201, json: { id: "new-1", key: `${host}:new-1` } });
    }
    if (p.endsWith("/timeline/stream"))
      return route.fulfill(
        sse({
          type: "ops",
          ops: [
            {
              type: "reset",
              epoch: host,
              hasOlder: false,
              startCursor: null,
              rows: [
                {
                  seqStart: 1,
                  seqEnd: 1,
                  timestamp: "t",
                  provider: "codex",
                  item: { type: "assistant_message", text: `Hello from ${host}` },
                },
                {
                  seqStart: 2,
                  seqEnd: 2,
                  timestamp: "t",
                  provider: "codex",
                  item: { type: "plugin", pluginId: "turn-speed", id: "turn-1", kind: "turn-speed", version: 1, data: { provider: "codex", outputTokens: 12345, generationMs: 41200, requests: 6, tokensPerSecond: 87.2 } },
                },
                {
                  seqStart: 3,
                  seqEnd: 3,
                  timestamp: "t",
                  provider: "codex",
                  item: { type: "plugin", pluginId: "next-input", id: "suggestion-tok", kind: "next-input", version: 1, data: { agentId: "shared-id", workspaceId: "w", token: "tok-" + host, status: "idle", text: "" } },
                },
              ],
            },
          ],
        }),
      );
    if (p.includes("/workspaces/")) {
      threadActions.push({ host, action: p.split("/").pop(), ...(route.request().postDataJSON() ?? {}) });
      return route.fulfill({ json: { ok: true } });
    }
    if (p.endsWith("/suggestion")) {
      predictions.push({ host, ...route.request().postDataJSON() });
      return route.fulfill({ json: { status: "ready", text: "Now add tests for the board" } });
    }
    if (p.endsWith("/read")) {
      reads.push(host);
      return route.fulfill({ json: { ok: true } });
    }
    if (p.endsWith("/messages")) {
      messages.push({ host, ...route.request().postDataJSON() });
      await new Promise(resolve => { finishMessage = resolve; });
      return route.fulfill({ status: messageFailure ? 502 : 200, json: messageFailure ? { error: "Delivery outcome unknown" } : { status: "acknowledged" } });
    }
    if (p.includes("/permissions/")) {
      permissions.push({ host, ...route.request().postDataJSON() });
      return route.fulfill({ json: { status: "acknowledged" } });
    }
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByLabel("Server access token").fill(readFileSync(join(directory, "token"), "utf8"));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  // A collapsed project keeps showing what it holds: litepaseo has a finished, unseen session.
  const litepaseoGroup = page.locator(".group-row", { hasText: "litepaseo" });
  await litepaseoGroup.locator(".group-toggle").click();
  assert.equal(await page.locator("button.session", { hasText: "alpha conversation" }).count(), 0, "collapsed");
  assert.equal(await litepaseoGroup.locator(".status-dot.is-unread").count(), 1);
  assert.match(await litepaseoGroup.locator(".group-marks").getAttribute("title"), /1 finished, not viewed/);
  await litepaseoGroup.locator(".group-toggle").click();
  await page.locator("button.session", { hasText: "beta conversation" }).click();
  await page.getByText("Hello from beta", { exact: true }).waitFor();
  await page.locator(".composer textarea").fill("Hello beta");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".composer textarea").value === "");
  await page.locator(".composer textarea").fill("Next beta draft");
  while (!finishMessage) await new Promise(r => setTimeout(r, 10));
  finishMessage();
  finishMessage = null;
  await page.waitForFunction(() => !document.querySelector('.disc-send').disabled);
  assert.equal(await page.locator(".composer textarea").inputValue(), "Next beta draft");
  messageFailure = true;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  while (!finishMessage) await new Promise(r => setTimeout(r, 10));
  await page.locator("button.session", { hasText: "alpha conversation" }).click();
  await page.locator(".composer textarea").fill("Alpha draft");
  finishMessage();
  await page.getByText("Delivery outcome unknown", { exact: true }).waitFor();
  assert.equal(await page.locator(".uncertain").count(), 0);
  assert.equal(await page.locator(".composer textarea").inputValue(), "Alpha draft");
  await page.locator("button.session", { hasText: "beta conversation" }).click();
  await page.locator(".uncertain").waitFor();
  assert.equal(await page.locator(".composer textarea").inputValue(), "Next beta draft");
  await page.getByRole("button", { name: "I checked", exact: true }).click();
  await page.locator(".composer textarea").fill("");
  assert.equal(messages[0].host, "beta");
  assert.equal(messages[0].behavior, "steer");
  await page.getByRole("button", { name: "Allow / submit" }).click();
  // The approval disappears through a resumed directory stream delivering the change.
  await page.waitForFunction(() => !document.querySelector(".permission"), null, { timeout: 15000 });
  assert.equal(permissions[0].host, "beta");
  assert.ok(resumes.length > 0 && resumes.every((since) => since === "1" || since === "2"));
  // New session from the litepaseo project's "+": host and project come from the group,
  // model and thinking from the host's defaults; the session opens when the stream delivers it.
  await page.getByRole("button", { name: "New session in litepaseo" }).click();
  const dialog = page.getByRole("dialog", { name: "New session" });
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector(".sheet select")?.value);
  assert.equal(await dialog.getByLabel("Model").inputValue(), "gpt-5-codex");
  assert.equal(await dialog.getByLabel("Thinking").inputValue(), "high");
  assert.equal(await dialog.getByLabel("Project").inputValue(), "/code/litepaseo");
  await dialog.getByLabel("First message").fill("Add a new session dialog");
  await dialog.getByRole("button", { name: "Start session" }).click();
  await page.getByRole("heading", { name: "Brand new session" }).waitFor({ timeout: 15000 });
  assert.equal(creations.length, 1);
  assert.deepEqual(
    { ...creations[0], idempotencyKey: typeof creations[0].idempotencyKey },
    {
      host: "alpha",
      idempotencyKey: "string",
      cwd: "/code/litepaseo",
      provider: "codex",
      model: "gpt-5-codex",
      thinkingOptionId: "high",
      prompt: "Add a new session dialog",
    },
  );
  assert.equal(await dialog.count(), 0, "the dialog closes after creation");

  threadActions.length = 0; // Earlier conversation switching also marked alpha as read.
  // Thread actions from the row menu (right click on desktop): pin, rename, unread, archive.
  const betaRow = page.locator("button.session", { hasText: "beta conversation" });
  await betaRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await betaRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename thread" });
  await renameDialog.getByLabel("Name").fill("Beta, renamed");
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await renameDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Actions for alpha conversation" }).click();
  await page.getByRole("menuitem", { name: "Mark as read" }).click();
  page.once("dialog", (d) => d.accept());
  await betaRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  for (let i = 0; i < 30 && threadActions.length < 4; i++) await page.waitForTimeout(100);
  assert.deepEqual(threadActions, [
    { host: "beta", action: "pin", pinned: true },
    { host: "beta", action: "title", title: "Beta, renamed" },
    { host: "alpha", action: "read" },
    { host: "beta", action: "archive" },
  ]);

  // A thread with two agents shows tabs to switch between them.
  await betaRow.click();
  await page.getByRole("navigation", { name: "Agents in this thread" }).waitFor();
  await page.getByRole("button", { name: "beta helper" }).click();
  await page.waitForFunction(() => document.querySelector(".agent-tabs .chosen")?.textContent?.includes("beta helper"));
  await page.getByRole("button", { name: "beta conversation", exact: true }).click();

  // Plugin rows: turn speed, and a next-input suggestion predicted on demand and taken with Tab.
  await page.locator("button.session", { hasText: "beta conversation" }).click();
  await page.getByText("87.2 tok/s · 12.3k tokens · 41.2s · 6 requests").waitFor();
  await page.getByText("Now add tests for the board").waitFor();
  assert.deepEqual(predictions.at(-1), { host: "beta", token: "tok-beta" });
  await page.locator(".composer textarea").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".composer textarea").inputValue(), "Now add tests for the board");
  await page.locator(".composer textarea").fill("");

  // Opening an unread conversation marks it read.
  await page.locator("button.session", { hasText: "alpha conversation" }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !reads.includes("alpha"); i++) await page.waitForTimeout(100);
  assert.ok(reads.includes("alpha"), "viewing an unread session clears its unread state");

  // Usage across hosts in the sidebar.
  await page.getByRole("button", { name: /Codex/ }).click();
  await page.getByText("Usage left").waitFor();
  await page.getByText("8% left").waitFor();
  await page.getByRole("button", { name: "Close" }).last().click();

  // Kanban: live agent lanes by default.
  await page.getByRole("button", { name: "Kanban", exact: true }).click();
  await page.locator(".lane-review .task-card", { hasText: "alpha conversation" }).waitFor();
  assert.equal(await page.locator(".lane-needs_input .task-card").count(), 0);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByPlaceholder("New task").fill("Validate two hosts");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByText("Validate two hosts", { exact: true }).waitFor();
  await page.locator(".card select").selectOption("Doing");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".column")]
      .find((e) => e.querySelector("h3").textContent === "Doing")
      .querySelector(".card"),
  );
  await page.reload();
  await page.getByRole("button", { name: "Kanban", exact: true }).click();
  await page.getByText("Validate two hosts", { exact: true }).waitFor();
  assert.equal(await page.locator(".card select").inputValue(), "Doing");
  // Keyboard: "/" focuses search from anywhere outside a text field.
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("type")), "search");
  assert.deepEqual(errors, []);

  // PWA: manifest, icons and a registered service worker.
  const manifest = await page.evaluate(async () => {
    const r = await fetch("/manifest.webmanifest");
    return { type: r.headers.get("content-type"), body: await r.json() };
  });
  assert.equal(manifest.type, "application/manifest+json");
  assert.equal(manifest.body.display, "standalone");
  for (const icon of manifest.body.icons)
    assert.equal((await page.request.get(`http://127.0.0.1:${port}${icon.src}`)).headers()["content-type"], "image/png");
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL.endsWith("/sw.js")), true);

  // Settings → authenticator: enroll with a real TOTP code, sign out, sign back in with a code.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Push notifications").waitFor();
  await page.getByRole("button", { name: "Set up" }).click();
  await page.getByAltText("Authenticator QR code").waitFor();
  const secret = (await page.locator(".secret").textContent()).replace(/\s/g, "");
  const step = Math.floor(Date.now() / 30000);
  await page.getByLabel("Code from your app").fill(totp(secret, step));
  await page.getByRole("button", { name: "Turn on" }).last().click();
  await page.getByText("On. Sign in with a 6-digit code").waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const codeInput = page.getByLabel("Authenticator code");
  await codeInput.waitFor();
  // The enrollment code is spent; the next step's code is accepted (±1 step window).
  await codeInput.fill(totp(secret, step + 1));
  await page.getByRole("button", { name: "New session" }).first().waitFor();
  assert.deepEqual(errors, []);

  // Phone: opening a conversation is a history entry; system back returns to the list.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.route("**/api/stream**", (route) =>
    route.fulfill(sse(hostsEvent, workspacesEvent, { type: "snapshot", generation: "gen-1", seq: 1, agents: [summary("alpha", [])] })),
  );
  await phone.route("**/timeline/stream", (route) =>
    route.fulfill(sse({ type: "ops", ops: [{ type: "reset", epoch: "e", hasOlder: false, startCursor: null, rows: [] }] })),
  );
  await phone.goto(`http://127.0.0.1:${port}`);
  // Authenticator sign-in is on now; the token remains available as a fallback.
  await phone.getByRole("button", { name: "Use the access token instead" }).click();
  await phone.getByLabel("Server access token").fill(readFileSync(join(directory, "token"), "utf8"));
  await phone.getByRole("button", { name: "Connect", exact: true }).click();
  await phone.locator("button.session", { hasText: "alpha conversation" }).click();
  await phone.waitForFunction(() => document.querySelector(".shell.detail-open"));
  await phone.goBack();
  await phone.waitForFunction(() => !document.querySelector(".shell.detail-open"));
  assert.ok(phone.url().startsWith(`http://127.0.0.1:${port}`), "back must stay in the app");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(tmpdir(), "litepaseo-preview.png"), fullPage: true });
  console.log(
    "PASS browser: login, streamed directory + resume, timeline stream, send routing, approval, new session, board, PWA + service worker, TOTP enroll/sign-in, phone back; no page errors",
  );
} finally {
  await browser?.close();
  run("stop");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(directory, { recursive: true, force: true });
}

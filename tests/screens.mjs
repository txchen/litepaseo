// Renders the UI against realistic mocked streams and saves screenshots for visual review.
// Usage: node tests/screens.mjs [outDir]   (requires `npm run build` first)
import { chromium } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

const out = resolve(process.argv[2] ?? join(tmpdir(), "litepaseo-screens"));
mkdirSync(out, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), "lp-screens-"));
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const env = { ...process.env, LITEPASEO_DATA_DIR: directory, LITEPASEO_PORT: String(port) };
const run = (c) =>
  execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), c], { env, encoding: "utf8", timeout: 15000 });

const hosts = [
  { id: "mac", label: "MacBook Pro", state: "connected" },
  { id: "build", label: "build-01", state: "connected" },
  { id: "gpu", label: "gpu-box", state: "disconnected" },
];
const projects = ["litepaseo", "paseo-plugins", "infra", "website", "data-pipeline", "mobile-app", "dotfiles"];
const titles = [
  "Make the BFF directory sync incremental",
  "Fix flaky websocket reconnect test",
  "Add dark mode to settings",
  "Investigate memory growth in worker",
  "Upgrade to Node 24",
  "Write release notes for 0.16",
  "Cloudflare tunnel health checks",
  "Refactor timeline projection",
  "Port schedule runner to cron v2",
  "Audit npm dependencies",
];
const agents = Array.from({ length: 64 }, (_, i) => {
  const host = hosts[i % 3].id;
  const pending =
    i === 1 ? [{ id: "p-1", name: "Bash", title: "Run npm test", kind: "tool", input: { command: "npm test -- --watch=false" } }] : [];
  return {
    key: `${host}:a${i}`,
    hostId: host,
    id: "a" + i,
    workspaceId: "w" + (i === 4 ? 1 : i),
    title: titles[i % titles.length] + (i >= titles.length ? ` (${Math.floor(i / titles.length) + 1})` : ""),
    status: i === 0 || i === 4 ? "running" : i === 7 ? "error" : "idle",
    provider: i % 2 ? "codex" : "pi",
    cwd: `/home/me/code/${projects[i % projects.length]}`,
    project: projects[i % projects.length],
    projectKey: projects[i % projects.length],
    activityAt: 1_000_000 - i,
    attention: pending.length > 0,
    state: pending.length ? "needs_input" : i === 0 || i === 4 ? "running" : i === 7 ? "failed" : i % 5 === 2 ? "unread" : "done",
    unread: !pending.length && (i === 7 || i % 5 === 2),
    lastError: i === 7 ? "codex exited with code 1: rate limit reached for gpt-5-codex" : null,
    pendingPermissions: pending,
  };
});
// One thread per agent, except a1 and a4 (same host) which share thread w1; a few are pinned and renamed.
const workspaces = agents
  .filter((a) => a.workspaceId === "w" + a.id.slice(1))
  .map((a, n) => ({
    key: `${a.hostId}:${a.workspaceId}`,
    hostId: a.hostId,
    id: a.workspaceId,
    name: a.id === "a5" ? "Release notes (renamed)" : a.title,
    title: a.id === "a5" ? "Release notes (renamed)" : null,
    project: a.project,
    projectKey: a.projectKey,
    rootPath: a.cwd,
    directory: a.cwd,
    kind: "worktree",
    branch: ["main", "feat/sync", "fix/flaky-ws", null][n % 4],
    pinnedAt: a.id === "a8" || a.id === "a14" ? 1_000 + n : 0,
    activityAt: a.activityAt,
    state: a.state,
    attention: a.attention,
    unread: a.unread,
  }));
let seq = 0;
const row = (item, turnId = "t1") => ({ seqStart: ++seq, seqEnd: seq, timestamp: "t", provider: "codex", turnId, item });
const rows = [
  row({ type: "user_message", text: "The sidebar re-renders on every agent update. Make the directory sync incremental and keep rendering proportional to what changed." }),
  row({ type: "reasoning", text: "Need to look at how the daemon exposes directory sync…" }),
  row({ type: "tool_call", callId: "c1", name: "shell", status: "completed", error: null, detail: { type: "shell", command: "rg -n \"fetch_agents_request\" packages/server/src" } }),
  row({ type: "tool_call", callId: "c2", name: "read", status: "completed", error: null, detail: { type: "read", filePath: "packages/server/src/server/session.ts" } }),
  row({
    type: "assistant_message",
    text: "The daemon already supports **directory sync**: a `fetch_agents_request` with `sync: { generation, afterSeq }` returns only what changed.\n\n### Plan\n\n1. Keep one `observeAgents` subscription per host\n2. Store summaries in a versioned collection\n3. Stream `changesSince(cursor)` to each browser\n\n```ts\nconst changes = agents.changesSince(stream.last);\nif (changes === null) sendSnapshot();\nelse send({ type: \"changes\", changes });\n```\n\n| Path | Before | After |\n| --- | --- | --- |\n| Idle | every 2s | none |\n| Update | O(n) | O(changes) |",
  }),
  row({ type: "todo", items: [
    { text: "Directory subscription with sync cursor", completed: true },
    { text: "Versioned collection with tombstones", completed: true },
    { text: "Timeline reducer + coalesced ops", completed: false, status: "in_progress" },
    { text: "Virtualized sidebar", completed: false },
  ] }),
  row({ type: "tool_call", callId: "c3", name: "edit", status: "completed", error: null, detail: { type: "edit", filePath: "src/server/host-directory.ts" } }),
  row({ type: "tool_call", callId: "c4", name: "shell", status: "failed", error: "exit code 1", detail: { type: "shell", command: "npm test" } }),
  row({ type: "assistant_message", text: "One test failed because the fixture used the old paging API. Fixing it now and re-running the suite." }),
  row({ type: "tool_call", callId: "c5", name: "shell", status: "completed", error: null, detail: { type: "shell", command: "npm test" } }),
  row({ type: "assistant_message", text: "All 32 tests pass now." }),
  row({ type: "plugin", pluginId: "turn-speed", id: "t1", kind: "turn-speed", version: 1, data: { provider: "codex", outputTokens: 18432, generationMs: 211000, requests: 14, tokensPerSecond: 87.4 } }),
  row({ type: "plugin", pluginId: "next-input", id: "s1", kind: "next-input", version: 1, data: { agentId: "a1", workspaceId: "w", token: "tok", status: "idle", text: "" } }),
];
const sse = (...events) => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
});

let browser;
try {
  run("start");
  browser = await chromium.launch({ headless: true });
  const shoot = async (name, options, steps) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.route("**/api/stream**", (route) =>
      route.fulfill(
        sse(
          { type: "hosts", hosts },
          { type: "workspaces-snapshot", generation: "wg", seq: 1, workspaces },
          { type: "snapshot", generation: "g", seq: 1, agents },
        ),
      ),
    );
    await page.route("**/timeline/stream", (route) =>
      route.fulfill(sse({ type: "ops", ops: [{ type: "reset", epoch: "e", rows, hasOlder: true, startCursor: { epoch: "e", seq: 1 } }] })),
    );
    await page.route("**/suggestion", (route) =>
      route.fulfill({ json: { status: "ready", text: "Great — now wire the board into the sidebar and add a test for it." } }),
    );
    await page.route("**/api/usage**", (route) =>
      route.fulfill({
        json: {
          fetchedAt: new Date().toISOString(),
          unavailableHosts: [],
          accounts: [
            { key: "c", providerId: "codex", name: "Codex", plan: "Pro", source: null, status: "available", error: null, hosts: ["MacBook Pro", "build-01"], windows: [
              { id: "5h", label: "5-hour", shortLabel: "5h", remainingPct: 72, resetsAt: new Date(Date.now() + 2.4 * 3600e3).toISOString(), tone: null },
              { id: "wk", label: "Weekly", shortLabel: "wk", remainingPct: 23, resetsAt: new Date(Date.now() + 4.2 * 86400e3).toISOString(), tone: null },
            ] },
            { key: "a", providerId: "claude", name: "Claude", plan: "Max", source: null, status: "available", error: null, hosts: ["MacBook Pro"], windows: [
              { id: "5h", label: "5-hour", shortLabel: "5h", remainingPct: 96, resetsAt: new Date(Date.now() + 4.1 * 3600e3).toISOString(), tone: null },
              { id: "wk", label: "Weekly", shortLabel: "wk", remainingPct: 61, resetsAt: new Date(Date.now() + 2.2 * 86400e3).toISOString(), tone: null },
              { id: "op", label: "Weekly · Opus", shortLabel: "Opus", remainingPct: 7, resetsAt: new Date(Date.now() + 2.2 * 86400e3).toISOString(), tone: null },
            ] },
          ],
        },
      }),
    );
    await page.route("**/providers", (route) =>
      route.fulfill({
        json: [
          { id: "codex", label: "Codex", status: "ready", defaultModeId: "auto", modes: [{ id: "auto", label: "Auto" }, { id: "read-only", label: "Read only" }], models: [
            { id: "gpt-5-codex", label: "GPT-5 Codex", isDefault: true, thinking: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }], defaultThinkingId: "high" },
            { id: "gpt-5", label: "GPT-5", isDefault: false, thinking: [], defaultThinkingId: null },
          ] },
          { id: "pi", label: "Pi", status: "ready", defaultModeId: null, modes: [], models: [{ id: "sonnet", label: "Claude Sonnet", isDefault: true, thinking: [], defaultThinkingId: null }] },
        ],
      }),
    );
    await page.route("**/projects", (route) =>
      route.fulfill({ json: projects.map((name) => ({ key: name, name, rootPath: `/home/me/code/${name}`, kind: "git" })) }),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await steps(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, name + ".png") });
    await context.close();
  };
  const token = readFileSync(join(directory, "token"), "utf8");
  const login = async (page) => {
    await page.getByLabel("Server access token").fill(token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText(titles[0]).first().waitFor();
  };
  const openChat = async (page) => {
    await login(page);
    await page.locator("button.session", { hasText: "Fix flaky websocket" }).first().click();
    await page.locator(".row-todo").waitFor();
    await page.locator(".row-suggestion.is-ready").waitFor();
  };
  const desktop = { viewport: { width: 1440, height: 900 } };
  const mobile = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
  await shoot("login", desktop, async () => {});
  await shoot("desktop-empty", desktop, login);
  await shoot("desktop-chat", desktop, openChat);
  await shoot("desktop-chat-dark", { ...desktop, colorScheme: "dark" }, openChat);
  await shoot("desktop-hosts", desktop, async (page) => {
    await login(page);
    await page.getByRole("button", { name: /Hosts/ }).click();
  });
  await shoot("desktop-board", desktop, async (page) => {
    await login(page);
    await page.getByRole("button", { name: /Kanban/ }).click();
    await page.locator(".task-card").first().waitFor();
  });
  await shoot("desktop-board-dark", { ...desktop, colorScheme: "dark" }, async (page) => {
    await login(page);
    await page.getByRole("button", { name: /Kanban/ }).click();
    await page.locator(".task-card").first().waitFor();
  });
  await shoot("mobile-board", mobile, async (page) => {
    await login(page);
    await page.getByRole("button", { name: /Kanban/ }).click();
    await page.locator(".task-card").first().waitFor();
  });
  await shoot("usage-open", desktop, async (page) => {
    await login(page);
    await page.locator(".usage-summary").click();
    await page.getByText("Usage left").waitFor();
  });
  await shoot("desktop-host-filter", desktop, async (page) => {
    await login(page);
    await page.getByRole("radio", { name: /build-01/ }).click();
  });
  const openNew = async (page) => {
    await login(page);
    await page.getByRole("button", { name: /^New session/ }).first().click();
    await page.waitForFunction(() => document.querySelector(".sheet select")?.value);
    await page.getByLabel("First message").fill("Add a host filter to the sidebar and keep switching O(1).");
  };
  await shoot("new-session", desktop, openNew);
  await shoot("new-session-dark", { ...desktop, colorScheme: "dark" }, openNew);
  await shoot("new-session-mobile", mobile, openNew);
  const openSettings = async (page) => {
    await login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByText("Push notifications").waitFor();
  };
  await shoot("settings", desktop, openSettings);
  await shoot("settings-mobile-dark", { ...mobile, colorScheme: "dark" }, openSettings);
  await shoot("login-code", mobile, async (page) => {
    await page.route("**/api/auth", (route) => route.fulfill({ json: { authenticated: false, totp: true } }));
    await page.reload();
    await page.getByLabel("Authenticator code").fill("1234");
  });
  const collapseAll = async (page) => {
    await login(page);
    for (let i = 0; i < 12; i++) {
      const open = page.locator(".group-row:not(.collapsed) .group-toggle");
      if (!(await open.count())) break;
      await open.first().click();
    }
  };
  await shoot("thread-menu", desktop, async (page) => {
    await openChat(page);
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("menu").waitFor();
  });
  await shoot("thread-menu-dark", { ...desktop, colorScheme: "dark" }, async (page) => {
    await login(page);
    const row = page.locator("button.session").nth(2);
    const box = await row.boundingBox();
    await row.click({ button: "right", position: { x: box.width - 60, y: 20 } });
    await page.getByRole("menu").waitFor();
  });
  await shoot("rename", desktop, async (page) => {
    await openChat(page);
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await page.getByRole("dialog", { name: "Rename thread" }).waitFor();
  });
  await shoot("agent-tabs", desktop, async (page) => {
    await login(page);
    await page
      .locator("button.session")
      .filter({ has: page.locator(".session-title", { hasText: /^Fix flaky websocket reconnect test$/ }) })
      .click();
    await page.getByRole("navigation", { name: "Agents in this thread" }).waitFor();
  });
  await shoot("sidebar-collapsed", desktop, collapseAll);
  await shoot("sidebar-collapsed-dark", { ...desktop, colorScheme: "dark" }, collapseAll);
  await shoot("mobile-list", mobile, login);
  await shoot("mobile-chat", mobile, openChat);
  await shoot("mobile-chat-dark", { ...mobile, colorScheme: "dark" }, openChat);
  await shoot("desktop-forced-dark", desktop, async (page) => {
    await openChat(page);
    await page.getByRole("button", { name: "Theme: system" }).click();
    await page.getByRole("button", { name: "Theme: light" }).click();
  });
  await shoot("mobile-list-dark", { ...mobile, colorScheme: "dark" }, login);
  await shoot("login-dark", { ...desktop, colorScheme: "dark" }, async () => {});
  await shoot("desktop-hosts-dark", { ...desktop, colorScheme: "dark" }, async (page) => {
    await login(page);
    await page.getByRole("button", { name: /Hosts/ }).click();
  });
  console.log("screens written to", out);
} finally {
  await browser?.close();
  run("stop");
  rmSync(directory, { recursive: true, force: true });
}

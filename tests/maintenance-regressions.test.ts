import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { HostBackgroundWork, type BackgroundWorkDriver } from "../src/server/background-work.ts";
import { NextSuggestionCache } from "../src/server/next-suggestion.ts";
import { Notifier } from "../src/server/notifier.ts";

test("fork attachment round-trips from /fork-context to POST /agents, download handles UTF-8 & 413, bodyLimit returns 413, archived workspaces paginate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "litepaseo-maint-"));
  const store = new Store(dir);
  const hosts = new Hosts();
  const host = store.addHost("Main", "ws://example.invalid/ws");
  let createdBody: any = null;
  let historyCalls = 0;

  const mockDriver = {
    getConnectionState: () => ({ status: "connected" }),
    subscribeConnectionStatus: () => () => {},
    getLastServerInfoMessage: () => ({ features: {} }),
    observeAgents: () => ({ subscribe: () => () => {}, release: async () => {} }),
    buildAgentForkContext: async () => ({
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        title: "Forked history",
        text: "User: hello\nAssistant: world",
      },
      itemCount: 2,
    }),
    readFile: async (_cwd: string, file: string) => {
      if (file === "huge.log") throw new Error("File is too large to display");
      return {
        path: "docs/报告.txt",
        kind: "text",
        mime: "text/plain",
        size: 5,
        modifiedAt: "2026-11-25T00:00:00.000Z",
        bytes: new TextEncoder().encode("hello"),
      };
    },
    fetchAgentHistory: async (opts: { page?: { cursor?: string } }) => {
      historyCalls++;
      if (!opts.page?.cursor) {
        return {
          entries: [
            { agent: { id: "active-1", cwd: "/repo", provider: "codex", status: "idle", archivedAt: null } },
          ],
          pageInfo: { hasMore: true, nextCursor: "page-2" },
        };
      }
      return {
        entries: [
          {
            agent: {
              id: "arch-1",
              workspaceId: "ws-arch-1",
              title: "Archived work",
              cwd: "/repo",
              provider: "codex",
              status: "idle",
              archivedAt: "2026-11-20T00:00:00.000Z",
            },
            project: { projectName: "repo" },
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      };
    },
  };
  const mockApi = {
    agents: {
      create: async (payload: any) => {
        createdBody = payload;
        return { id: "new-agent" };
      },
    },
    dispose: async () => {},
  };

  hosts.attach(host.id, mockDriver as never, mockApi as never);
  const app = createApp(store, hosts, "secret-token-1234567890", dir);
  const headers = { authorization: "Bearer secret-token-1234567890", "content-type": "application/json" };
  try {
    // 1. Fork round-trip: response from /fork-context is accepted verbatim by POST /agents.
    const forkRes = await app.request(`/api/hosts/${host.id}/agents/a1/fork-context`, { method: "POST", headers });
    assert.equal(forkRes.status, 200);
    const forkData = await forkRes.json();
    const createRes = await app.request(`/api/hosts/${host.id}/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        cwd: "/repo",
        provider: "codex",
        model: "gpt-5",
        prompt: "Continue",
        attachments: [forkData.attachment],
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createdBody.attachments[0].type, "text");
    assert.equal(createdBody.attachments[0].contextKind, "chat_history");

    // 2. UTF-8 filename download succeeds with ASCII fallback + filename*.
    const dlRes = await app.request(`/api/hosts/${host.id}/fs/download?cwd=/repo&path=docs/报告.txt`, { headers });
    assert.equal(dlRes.status, 200);
    const disp = dlRes.headers.get("content-disposition") ?? "";
    assert.match(disp, /filename="[^"]*\.txt"/);
    assert.match(disp, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.txt/);

    // 3. Oversized file returns 413 instead of 404 on both /fs/read and /fs/download.
    const bigRead = await app.request(`/api/hosts/${host.id}/fs/read?cwd=/repo&path=huge.log`, { headers });
    assert.equal(bigRead.status, 413);
    const bigDl = await app.request(`/api/hosts/${host.id}/fs/download?cwd=/repo&path=huge.log`, { headers });
    assert.equal(bigDl.status, 413);

    // 4. Oversized JSON request returns 413 instead of 502.
    const bigBody = JSON.stringify({ text: "x".repeat(1_200_000) });
    const limitRes = await app.request(`/api/hosts/${host.id}/agents`, { method: "POST", headers, body: bigBody });
    assert.equal(limitRes.status, 413);

    // 5. Archived workspaces paginates past active agents.
    const archRes = await app.request(`/api/hosts/${host.id}/archived-workspaces`, { headers });
    assert.equal(archRes.status, 200);
    const archived = await archRes.json();
    assert.equal(historyCalls, 2);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, "arch-1");
  } finally {
    await hosts.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HostBackgroundWork live updates invalidate older in-flight list responses", async () => {
  let resolveList!: (val: { items: any[]; error: null }) => void;
  let onUpdateHandler!: (msg: { payload: unknown }) => void;
  const driver: BackgroundWorkDriver = {
    listAgentBackgroundWork: () => new Promise((r) => { resolveList = r; }),
    on: (_type, handler) => {
      onUpdateHandler = handler;
      return () => {};
    },
    observeEvents: () => ({
      ready: Promise.resolve(),
      subscribe: () => () => {},
      release: () => Promise.resolve(),
    }),
  };
  const bg = new HostBackgroundWork(driver);
  const snapshots: any[][] = [];
  const stop = bg.watch("a1", (items) => snapshots.push(items));

  // Live update removes all tasks before the earlier listAgentBackgroundWork resolves.
  onUpdateHandler({ payload: { agentId: "a1", items: [] } });
  resolveList({ items: [{ id: "stale", kind: "task", description: "old", startedAt: "2026-11-25T00:00:00Z" }], error: null });
  await new Promise((r) => setTimeout(r, 560));

  assert.deepEqual(snapshots.at(-1), [], "stale list response must not resurrect removed background work");
  stop();
  await bg.dispose();
});

test("NextSuggestionCache.clear invalidates in-flight results so settings changes never cache stale output", async () => {
  const cache = new NextSuggestionCache();
  let resolveFirst!: (v: string) => void;
  const p1 = cache.getOrRun("k1", () => new Promise((r) => { resolveFirst = r; }));
  cache.clear();
  resolveFirst("old model suggestion");
  assert.equal(await p1, "old model suggestion");
  const p2 = await cache.getOrRun("k1", async () => "new model suggestion");
  assert.equal(p2, "new model suggestion");
});

test("Notifier.test counts only successful push deliveries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "litepaseo-notify-test-"));
  const store = new Store(dir);
  try {
    store.addSession({ id: "s1", secretHash: "h", label: "t", created: 0, lastSeen: 0, expires: 1e15 });
    store.savePushSubscription({ endpoint: "https://ok.example/1", sessionId: "s1", p256dh: "k", auth: "a", prefs: { attention: true, turns: true }, created: 0 });
    store.savePushSubscription({ endpoint: "https://fail.example/2", sessionId: "s1", p256dh: "k", auth: "a", prefs: { attention: true, turns: true }, created: 0 });
    const notifier = new Notifier({
      store,
      sender: {
        async send(sub) {
          if (sub.endpoint.includes("fail")) throw Object.assign(new Error("gone"), { statusCode: 410 });
        },
      },
      isViewing: () => false,
      deviceActive: () => false,
      viewedSince: () => false,
      hostLabel: () => "Host",
    });
    assert.equal(await notifier.test("s1"), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

type Requester = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

/** Minimal SSE reader over the in-process app. */
async function openEvents(app: Requester, path: string) {
  const controller = new AbortController();
  const response = await app.request(path, {
    headers: { authorization: "Bearer test-token" },
    signal: controller.signal,
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(): Promise<any> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!block.startsWith("data: ")) continue;
          const message = JSON.parse(block.slice(6));
          // These checks are about the agent directory; workspaces have their own test.
          if (String(message.type).startsWith("workspaces-")) continue;
          return message;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += value;
      }
    },
    close() {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
  };
}

const agentSnapshot = (title: string, extra: Record<string, unknown> = {}) => ({
  id: "same-id",
  title,
  status: "idle",
  provider: "codex",
  cwd: "/",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

test("two-host routing, permissions, uncertain sends, authentication and board persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-test-"));
  const store = new Store(directory);
  const calls: unknown[] = [];
  const hosts = new Hosts();
  const updates = new Map<string, (payload: unknown) => void>();
  for (const label of ["Alpha", "Beta"]) {
    const host = store.addHost(label, "ws://example.invalid/ws");
    const agent = {
      pendingPermissions: [{ id: "permission-1" }],
      refresh: async () => {},
      send: async (text: string, options: unknown) => {
        calls.push([label, "send", text, options]);
        if (text === "uncertain") throw Error("Disconnected");
      },
      respondToPermission: async (options: unknown) => {
        calls.push([label, "permission", options]);
      },
    };
    let observer: any;
    const driver = {
      getConnectionState: () => ({ status: "connected" }),
      subscribeConnectionStatus: () => () => {},
      getLastServerInfoMessage: () => ({ features: { directorySync: true } }),
      observeAgents: () => ({
        subscribe: (o: unknown) => {
          observer = o;
          return () => {};
        },
        release: async () => {},
      }),
      cancelAgent: async (id: string) => {
        calls.push([label, "stop", id]);
      },
      fetchAgentTimeline: async (_id: string, options: any) => ({
        epoch: label,
        hasOlder: false,
        startCursor: null,
        entries: [
          {
            seqStart: options.cursor.seq - 1,
            seqEnd: options.cursor.seq - 1,
            timestamp: "t",
            provider: "codex",
            item: { type: "user_message", text: label },
          },
        ],
      }),
      close: async () => {},
    };
    hosts.attach(host.id, driver as never, {
      agents: {
        ref: () => agent,
        create: async (options: any) => {
          calls.push([label, "create", options]);
          if (options.cwd === "/fails") throw new Error("provider not authenticated");
          return { id: "new-" + label };
        },
      },
      providers: {
        snapshot: async () => ({
          entries: [
            {
              provider: "codex",
              status: "ready",
              enabled: true,
              label: "Codex",
              defaultModeId: "auto",
              modes: [{ id: "auto", label: "Auto" }],
              models: [
                { provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }], defaultThinkingOptionId: "high" },
                { provider: "codex", id: "hidden", label: "Hidden", isSelectable: false },
              ],
            },
            { provider: "claude", status: "unavailable", enabled: true },
            { provider: "pi", status: "ready", enabled: false },
          ],
        }),
      },
      projects: {
        list: async () => ({
          projects: [
            { projectId: "p1", projectKey: "k1", projectDisplayName: "repo", projectCustomName: "My Repo", projectRootPath: "/code/repo", projectKind: "git" },
          ],
        }),
      },
      dispose: async () => {},
    } as never);
    observer.snapshot({
      entries: [{ agent: agentSnapshot(label), syncSeq: 1 }],
      pageInfo: { hasMore: false, nextCursor: null },
      sync: { generation: "g", headSeq: 1, mode: "snapshot", removals: [] },
    });
    updates.set(label, (payload) => observer.update({ type: "agent_update", payload }));
  }
  const [a, b] = store.hosts();
  const app = createApp(store, hosts, "test-token", directory);
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request("/api" + path, {
      method,
      headers: { authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await app.request("/api/hosts")).status, 401);
    const publicHosts = await (await request("/hosts")).json();
    assert.equal(publicHosts.length, 2);
    assert.equal(publicHosts[0].connection, undefined);
    // Directory stream: host states, then one snapshot holding both hosts' agents.
    const reader = await openEvents(app, "/api/stream");
    assert.equal((await reader.next()).type, "hosts");
    const snapshot = await reader.next();
    assert.equal(snapshot.type, "snapshot");
    assert.deepEqual(
      snapshot.agents.map((x: any) => x.key).sort(),
      [`${a.id}:same-id`, `${b.id}:same-id`].sort(),
    );
    // A daemon delta reaches the open stream as a change set holding only that agent.
    updates.get("Beta")!({
      kind: "upsert",
      agent: agentSnapshot("Renamed", { status: "running", updatedAt: "2026-01-02T00:00:00Z" }),
      generation: "g",
      seq: 2,
    });
    const changes = await reader.next();
    assert.equal(changes.type, "changes");
    assert.deepEqual(
      changes.changes.map((c: any) => [c.key, c.value.title]),
      [[`${b.id}:same-id`, "Renamed"]],
    );
    reader.close();
    // Resuming from that cursor replays nothing; an unknown generation gets a snapshot.
    const resumed = await openEvents(
      app,
      `/api/stream?generation=${snapshot.generation}&since=${changes.seq}`,
    );
    assert.equal((await resumed.next()).type, "hosts");
    updates.get("Alpha")!({ kind: "remove", agentId: "same-id", generation: "g", seq: 3 });
    assert.deepEqual((await resumed.next()).changes, [{ key: `${a.id}:same-id`, value: null }]);
    resumed.close();
    const stale = await openEvents(app, "/api/stream?generation=old&since=1");
    await stale.next();
    const fresh = await stale.next();
    assert.deepEqual([fresh.type, fresh.agents.length], ["snapshot", 1]);
    stale.close();
    // History pages are read straight from the right host.
    const cursor = encodeURIComponent(JSON.stringify({ epoch: "Beta", seq: 10 }));
    const page = await (await request(`/hosts/${b.id}/agents/same-id/timeline?cursor=${cursor}`)).json();
    assert.deepEqual([page.epoch, page.rows[0].seqStart, page.rows[0].item.text], ["Beta", 9, "Beta"]);
    assert.equal((await request(`/hosts/${b.id}/agents/same-id/timeline?cursor=bad`)).status, 400);
    const messageId = randomUUID();
    assert.equal(
      (
        await request(`/hosts/${b.id}/agents/same-id/messages`, "POST", {
          text: "hello",
          messageId,
          behavior: "steer",
        })
      ).status,
      200,
    );
    assert.deepEqual(calls[0], [
      "Beta",
      "send",
      "hello",
      { messageId, activeTurnBehavior: "steer" },
    ]);
    assert.equal(
      (
        await request(`/hosts/${a.id}/agents/same-id/permissions/permission-1`, "POST", {
          behavior: "allow",
          updatedInput: { answer: "yes" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/hosts/${a.id}/agents/same-id/permissions/stale`, "POST", {
          behavior: "allow",
        })
      ).status,
      409,
    );
    assert.equal((await request(`/hosts/${a.id}/agents/same-id/stop`, "POST")).status, 200);
    assert.equal(
      (
        await request(`/hosts/${b.id}/agents/same-id/messages`, "POST", {
          text: "uncertain",
          messageId: randomUUID(),
          behavior: "steer",
        })
      ).status,
      502,
    );
    assert.equal(calls.filter((c: any) => c[2] === "uncertain").length, 1);
    assert.equal(
      (
        await request(`/hosts/${b.id}/agents/same-id/messages`, "POST", {
          text: "",
          messageId: "bad",
          behavior: "steer",
        })
      ).status,
      400,
    );
    const cards = [
      { id: randomUUID(), title: "A task", column: "Todo", hostId: b.id, agentId: "same-id" },
    ];
    assert.equal((await request("/board", "PUT", { revision: 0, cards })).status, 200);
    assert.equal((await request("/board", "PUT", { revision: 0, cards: [] })).status, 409);
    assert.equal((await request("/missing")).status, 404);
    assert.equal((await request("/hosts/nope/agents/x/stop", "POST")).status, 404);

    // New sessions: providers and projects come from the right host, creation maps the request.
    const providers = await (await request(`/hosts/${a.id}/providers`)).json();
    assert.deepEqual(providers.map((p: any) => p.id), ["codex"], "unavailable and disabled providers are hidden");
    assert.deepEqual(providers[0].models.map((m: any) => [m.id, m.isDefault, m.defaultThinkingId]), [["gpt-5", true, "high"]]);
    assert.deepEqual(await (await request(`/hosts/${a.id}/projects`)).json(), [
      { key: "k1", name: "My Repo", rootPath: "/code/repo", kind: "git" },
    ]);
    const idempotencyKey = randomUUID();
    const created = await request(`/hosts/${b.id}/agents`, "POST", {
      idempotencyKey,
      cwd: "/code/repo",
      provider: "codex",
      model: "gpt-5",
      modeId: "auto",
      thinkingOptionId: "high",
      prompt: "Fix the tests",
      worktreeBranch: "fix/tests",
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { id: "new-Beta", key: `${b.id}:new-Beta` });
    assert.deepEqual(calls.at(-1), [
      "Beta",
      "create",
      {
        idempotencyKey,
        cwd: "/code/repo",
        config: { provider: "codex/gpt-5", modeId: "auto", thinkingOptionId: "high" },
        prompt: "Fix the tests",
        worktree: { mode: "branch-off", newBranch: "fix/tests" },
      },
    ]);
    // Minimal request: provider default model, no prompt.
    await request(`/hosts/${a.id}/agents`, "POST", { idempotencyKey: randomUUID(), cwd: "/x", provider: "pi", prompt: "  " });
    assert.deepEqual((calls.at(-1) as any)[2].config, { provider: "pi" });
    assert.equal((calls.at(-1) as any)[2].prompt, undefined);
    const failed = await request(`/hosts/${a.id}/agents`, "POST", { idempotencyKey: randomUUID(), cwd: "/fails", provider: "codex" });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /provider not authenticated/);
    for (const bad of [
      { idempotencyKey: "nope", cwd: "/x", provider: "codex" },
      { idempotencyKey: randomUUID(), cwd: "", provider: "codex" },
      { idempotencyKey: randomUUID(), cwd: "/x", provider: "codex/gpt-5" },
    ])
      assert.equal((await request(`/hosts/${a.id}/agents`, "POST", bad)).status, 400);
    await hosts.close();
    store.close();
    const reopened = new Store(directory);
    assert.deepEqual(reopened.board(), { revision: 1, cards });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

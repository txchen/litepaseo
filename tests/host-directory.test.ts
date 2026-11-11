import test from "node:test";
import assert from "node:assert/strict";
import { HostDirectory, type DirectoryDriver } from "../src/server/host-directory.ts";
import { VersionedCollection } from "../src/server/versioned-collection.ts";
import type { AgentSummary } from "../src/shared/wire.ts";

const agent = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    provider: "codex",
    cwd: "/w",
    status: "idle",
    title: id,
    updatedAt: "2026-01-01T00:00:00Z",
    pendingPermissions: [],
    ...extra,
  }) as never;

function fakeDriver(directorySync: boolean) {
  const requests: Record<string, unknown>[] = [];
  const fetches: Record<string, unknown>[] = [];
  let status = "connected";
  const statusListeners = new Set<(s: { status: string }) => void>();
  let observer: any = null;
  let released = 0;
  const pages: any[] = [];
  const driver: DirectoryDriver = {
    getConnectionState: () => ({ status }),
    subscribeConnectionStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    getLastServerInfoMessage: () => ({ features: { directorySync } }),
    observeAgents: (options) => {
      requests.push(structuredClone(options));
      return {
        subscribe: (o) => {
          observer = o;
          return () => {};
        },
        release: async () => {
          released++;
        },
      };
    },
    fetchAgents: async (options) => {
      fetches.push(options);
      return pages.shift();
    },
  };
  return {
    driver,
    requests,
    fetches,
    pages,
    get released() {
      return released;
    },
    snapshot: (payload: unknown) => observer.snapshot(payload),
    update: (payload: unknown) => observer.update({ type: "agent_update", payload }),
    setStatus(next: string) {
      status = next;
      for (const l of statusListeners) l({ status: next });
    },
  };
}

function setup(sync: boolean) {
  const collection = new VersionedCollection<AgentSummary>();
  const fake = fakeDriver(sync);
  let changes = 0;
  const directory = new HostDirectory("h1", fake.driver, collection, () => changes++);
  directory.start();
  return { collection, fake, directory, changes: () => changes };
}

test("sync directory: one snapshot, then deltas only; stale and no-op updates are dropped", () => {
  const { collection, fake, changes } = setup(true);
  assert.deepEqual(fake.requests[0], { scope: "active", sync: {} });
  fake.snapshot({
    entries: [
      { agent: agent("a"), syncSeq: 1 },
      { agent: agent("b"), syncSeq: 2 },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 2, mode: "snapshot", removals: [] },
  });
  assert.equal(collection.size, 2);
  const cursor = collection.seq;
  const before = changes();

  fake.update({ kind: "upsert", agent: agent("a", { status: "running" }), generation: "g1", seq: 3 });
  fake.update({ kind: "upsert", agent: agent("a", { status: "idle" }), generation: "g1", seq: 1 });
  fake.update({ kind: "upsert", agent: agent("b"), generation: "g1", seq: 4 }); // unchanged fields
  assert.equal(changes() - before, 1);
  assert.deepEqual(
    collection.changesSince(cursor)!.map((c) => [c.key, c.value?.status]),
    [["h1:a", "running"]],
  );

  fake.update({ kind: "remove", agentId: "b", generation: "g1", seq: 5 });
  fake.update({ kind: "upsert", agent: agent("c", { archivedAt: "x" }), generation: "g1", seq: 6 });
  assert.equal(collection.get("h1:b"), undefined);
  assert.equal(collection.get("h1:c"), undefined);
});

test("sync directory resumes from its cursor after reconnect and applies only the changes", () => {
  const { collection, fake } = setup(true);
  fake.snapshot({
    entries: [
      { agent: agent("a"), syncSeq: 1 },
      { agent: agent("b"), syncSeq: 2 },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 2, mode: "snapshot", removals: [] },
  });
  fake.update({ kind: "upsert", agent: agent("a", { title: "A" }), generation: "g1", seq: 7 });
  fake.setStatus("disconnected");
  assert.equal(fake.released, 1);
  fake.setStatus("connected");
  assert.deepEqual(fake.requests[1], { scope: "active", sync: { generation: "g1", afterSeq: 7 } });
  fake.snapshot({
    entries: [{ agent: agent("c"), syncSeq: 8 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 9, mode: "changes", removals: [{ id: "b", seq: 9 }] },
  });
  assert.deepEqual(
    collection.snapshot().map((a) => a.key).sort(),
    ["h1:a", "h1:c"],
  );
  assert.equal(collection.get("h1:a")!.title, "A");
});

test("a full snapshot after a daemon restart removes agents that no longer exist", () => {
  const { collection, fake } = setup(true);
  fake.snapshot({
    entries: [{ agent: agent("a"), syncSeq: 50 }, { agent: agent("b"), syncSeq: 51 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 51, mode: "snapshot", removals: [] },
  });
  fake.setStatus("disconnected");
  fake.setStatus("connected");
  fake.snapshot({
    entries: [{ agent: agent("b", { title: "new" }), syncSeq: 1 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g2", headSeq: 1, mode: "snapshot", removals: [] },
  });
  assert.deepEqual(collection.snapshot().map((a) => [a.key, a.title]), [["h1:b", "new"]]);
});

test("daemons without directory sync are paged once per connection", async () => {
  const { collection, fake } = setup(false);
  assert.deepEqual(fake.requests[0], { scope: "active", page: { limit: 200 } });
  fake.pages.push({
    entries: [{ agent: agent("b") }],
    pageInfo: { hasMore: false, nextCursor: null },
  });
  fake.snapshot({ entries: [{ agent: agent("a") }], pageInfo: { hasMore: true, nextCursor: "p2" } });
  // An agent created while pages are read must survive the reconciliation.
  fake.update({ kind: "upsert", agent: agent("new") });
  await new Promise((r) => setImmediate(r));
  assert.equal(fake.fetches.length, 1);
  assert.deepEqual(
    collection.snapshot().map((a) => a.key).sort(),
    ["h1:a", "h1:b", "h1:new"],
  );
});

test("disposing a host removes only its agents", () => {
  const { collection, fake, directory } = setup(true);
  collection.set("h2:x", { key: "h2:x" } as AgentSummary);
  fake.snapshot({
    entries: [{ agent: agent("a"), syncSeq: 1 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 1, mode: "snapshot", removals: [] },
  });
  directory.dispose();
  assert.deepEqual(collection.snapshot().map((a) => a.key), ["h2:x"]);
});

test("project placement is carried into summaries and kept when an update omits it", () => {
  const { collection, fake } = setup(true);
  fake.snapshot({
    entries: [{ agent: agent("a", { cwd: "/home/me/code/repo/sub" }), project: { projectKey: "k", projectName: "Repo" }, syncSeq: 1 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 1, mode: "snapshot", removals: [] },
  });
  assert.equal(collection.get("h1:a")!.project, "Repo");
  fake.update({ kind: "upsert", agent: agent("a", { status: "running", cwd: "/home/me/code/repo/sub" }), generation: "g1", seq: 2 });
  assert.deepEqual([collection.get("h1:a")!.project, collection.get("h1:a")!.status], ["Repo", "running"]);
  fake.update({ kind: "upsert", agent: agent("b", { cwd: "/srv/tools/" }), generation: "g1", seq: 3 });
  assert.equal(collection.get("h1:b")!.project, "tools", "without a placement the cwd folder names the project");
});

test("activity time is the last turn end: held while running, ignores idle metadata changes", () => {
  const { collection, fake } = setup(true);
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  fake.snapshot({
    entries: [
      { agent: agent("idle", { updatedAt: t(10) }), syncSeq: 1 },
      { agent: agent("busy", { status: "running", updatedAt: t(50), activeTurn: { turnId: "x", startedAt: t(20) } }), syncSeq: 2 },
    ],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g1", headSeq: 2, mode: "snapshot", removals: [] },
  });
  const at = (id: string) => collection.get("h1:" + id)!.activityAt;
  assert.equal(at("idle"), Date.parse(t(10)));
  assert.equal(at("busy"), Date.parse(t(20)), "a turn seen mid-run sorts by its start");

  // Streaming updates during the turn change nothing the browser sees.
  const before = collection.seq;
  for (let s = 51; s < 60; s++)
    fake.update({ kind: "upsert", agent: agent("busy", { status: "running", updatedAt: t(s), activeTurn: { turnId: "x", startedAt: t(20) } }), generation: "g1", seq: s });
  assert.equal(collection.seq, before, "mid-turn updates are not published");

  fake.update({ kind: "upsert", agent: agent("busy", { status: "idle", updatedAt: t(70) }), generation: "g1", seq: 70 });
  assert.equal(at("busy"), Date.parse(t(70)), "the turn end becomes the activity time");
  fake.update({ kind: "upsert", agent: agent("busy", { status: "idle", title: "renamed", updatedAt: t(90) }), generation: "g1", seq: 71 });
  assert.equal(at("busy"), Date.parse(t(70)), "idle metadata changes do not reorder");

  // A whole turn that happened while we were not looking is detected by its user message.
  fake.update({ kind: "upsert", agent: agent("idle", { updatedAt: t(95), lastUserMessageAt: t(80) }), generation: "g1", seq: 72 });
  assert.equal(at("idle"), Date.parse(t(95)));
});

test("agent state follows Paseo's state bucket; a finished turn is unread, not needs-input", async () => {
  const { summarize } = await import("../src/server/host-directory.ts");
  const s = (extra: Record<string, unknown>) => summarize("h", agent("a", extra));
  const permission = [{ id: "p", name: "Bash", kind: "tool" }];
  assert.deepEqual(
    [
      s({ status: "running", pendingPermissions: permission }),
      s({ status: "idle", requiresAttention: true, attentionReason: "permission" }),
      s({ status: "running" }),
      s({ status: "initializing" }),
      s({ status: "error", lastError: "boom", requiresAttention: true, attentionReason: "error" }),
      s({ status: "idle", requiresAttention: true, attentionReason: "finished" }),
      s({ status: "idle" }),
    ].map((x) => [x.state, x.attention, x.unread]),
    [
      ["needs_input", true, false],
      ["needs_input", true, false],
      ["running", false, false],
      ["running", false, false],
      ["failed", false, true],
      ["unread", false, true],
      ["done", false, false],
    ],
  );
  assert.equal(s({ status: "error", lastError: "x".repeat(1000) }).lastError!.length, 300);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostWorkspaces, type DirectoryDriver, type WorkspaceDescriptor } from "../src/server/host-directory.ts";
import { VersionedCollection } from "../src/server/versioned-collection.ts";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { DirectoryStore, comparePinnedFirst } from "../src/web/directory-store.ts";
import type { AgentSummary, WorkspaceSummary } from "../src/shared/wire.ts";

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const ws = (id: string, extra: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor => ({
  id,
  projectId: "p1",
  projectDisplayName: "litepaseo",
  projectRootPath: "/code/litepaseo",
  workspaceDirectory: "/code/litepaseo",
  workspaceKind: "local_checkout",
  name: "main",
  title: null,
  pinnedAt: null,
  status: "done",
  statusEnteredAt: t(1),
  activityAt: t(1),
  gitRuntime: { currentBranch: "main" },
  ...extra,
});

function mirror() {
  let observer: any;
  const requests: Record<string, unknown>[] = [];
  const driver: DirectoryDriver = {
    getConnectionState: () => ({ status: "connected" }),
    subscribeConnectionStatus: () => () => {},
    getLastServerInfoMessage: () => ({ features: { directorySync: true } }),
    observeAgents: () => {
      throw new Error("not used");
    },
    fetchAgents: async () => {
      throw new Error("not used");
    },
    observeWorkspaces: (options) => {
      requests.push(options);
      return { subscribe: (o) => ((observer = o), () => {}), release: async () => {} };
    },
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
  };
  const collection = new VersionedCollection<WorkspaceSummary>();
  const workspaces = new HostWorkspaces("h", driver, collection, () => {});
  workspaces.start();
  return {
    collection,
    requests,
    snapshot: (entries: WorkspaceDescriptor[]) =>
      observer.snapshot({
        entries,
        pageInfo: { hasMore: false, nextCursor: null },
        sync: { generation: "g", headSeq: entries.length, mode: "snapshot", removals: [] },
      }),
    update: (payload: unknown) => observer.update({ type: "workspace_update", payload }),
  };
}

test("workspaces mirror the daemon's descriptors: name, pin, state, and turn-end recency", () => {
  const m = mirror();
  assert.deepEqual(m.requests[0], { sync: {} }, "workspaces sync without filters");
  m.snapshot([
    ws("w1", { name: "Fix login", title: "Fix login", pinnedAt: t(5) }),
    ws("w2", { status: "running", statusEnteredAt: t(20), activityAt: t(25) }),
    ws("w3", { background: true }),
    ws("w4", { archivingAt: t(9) }),
  ]);
  assert.deepEqual(m.collection.snapshot().map((w) => w.key).sort(), ["h:w1", "h:w2"], "background and archiving are hidden");
  const w1 = m.collection.get("h:w1")!;
  assert.deepEqual([w1.name, w1.title, w1.pinnedAt, w1.branch, w1.state], ["Fix login", "Fix login", Date.parse(t(5)), "main", "done"]);
  assert.equal(m.collection.get("h:w2")!.activityAt, Date.parse(t(20)), "a running thread sorts by when its turn started");

  // Running updates do not move it; the turn end does.
  const seq = m.collection.seq;
  m.update({ kind: "upsert", workspace: ws("w2", { status: "running", statusEnteredAt: t(20), activityAt: t(40) }), generation: "g", seq: 5 });
  assert.equal(m.collection.seq, seq, "mid-turn activity is not published");
  m.update({ kind: "upsert", workspace: ws("w2", { status: "attention", statusEnteredAt: t(60), activityAt: t(60) }), generation: "g", seq: 6 });
  const w2 = m.collection.get("h:w2")!;
  assert.deepEqual([w2.state, w2.unread, w2.attention, w2.activityAt], ["unread", true, false, Date.parse(t(60))]);
  m.update({ kind: "upsert", workspace: ws("w2", { status: "needs_input", statusEnteredAt: t(61), activityAt: t(61) }), generation: "g", seq: 7 });
  assert.equal(m.collection.get("h:w2")!.attention, true);
  m.update({ kind: "remove", id: "w1", generation: "g", seq: 8 });
  assert.equal(m.collection.get("h:w1"), undefined);
});

test("sidebar order: pinned threads lead their project, which still sorts by real recency", () => {
  const store = new DirectoryStore<WorkspaceSummary>({ compare: comparePinnedFirst });
  const item = (id: string, project: string, activityAt: number, pinnedAt = 0) =>
    ({ key: "h:" + id, hostId: "h", id, name: id, title: null, project, projectKey: project, rootPath: "/", directory: "/", kind: "x", branch: null, pinnedAt, activityAt, state: "done", attention: false, unread: false }) as WorkspaceSummary;
  store.applyCollection({
    type: "snapshot",
    generation: "g",
    seq: 1,
    items: [item("old-pinned", "a", 1, 100), item("new", "a", 50), item("mid", "a", 30), item("b1", "b", 40), item("pinned-2", "a", 2, 200)],
  });
  const rows = store.groupedRows(0, 10_000).map((r) => (r.kind === "group" ? `[${r.group.name}]` : r.item.id));
  assert.deepEqual(rows, ["[a]", "old-pinned", "pinned-2", "new", "mid", "[b]", "b1"], "project a ranks by its newest thread (50), not by its pinned one");
});

test("agents are indexed by thread: a thread opens its most recent agent", () => {
  const agents = new DirectoryStore<AgentSummary>({ indexBy: (a) => (a.workspaceId ? `${a.hostId}:${a.workspaceId}` : null) });
  const agent = (id: string, workspaceId: string | null, activityAt: number) =>
    ({ key: "h:" + id, hostId: "h", id, workspaceId, title: id, status: "idle", provider: "codex", cwd: "/", project: "p", projectKey: null, activityAt, attention: false, state: "done", unread: false, lastError: null, pendingPermissions: [] }) as AgentSummary;
  agents.apply({ type: "snapshot", generation: "g", seq: 1, agents: [agent("a1", "w1", 10), agent("a2", "w1", 30), agent("a3", "w2", 20), agent("a4", null, 5)] });
  assert.deepEqual(agents.indexed("h:w1", 5).map((a) => a.id), ["a2", "a1"]);
  agents.apply({ type: "changes", generation: "g", seq: 2, changes: [{ key: "h:a1", value: agent("a1", "w1", 99) }, { key: "h:a2", value: null }] });
  assert.deepEqual(agents.indexed("h:w1", 5).map((a) => a.id), ["a1"]);
  assert.equal(agents.indexedSize("h:w2"), 1);
  assert.deepEqual(agents.indexed("h:none"), []);
});

test("thread actions reach the daemon's workspace operations on the right host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-ws-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const calls: unknown[][] = [];
  hosts.attach(
    "mac",
    {
      getConnectionState: () => ({ status: "connected" }),
      subscribeConnectionStatus: () => () => {},
      getLastServerInfoMessage: () => ({ features: { directorySync: true } }),
      observeAgents: () => ({ subscribe: () => () => {}, release: async () => {} }),
      setWorkspaceTitle: async (...args: unknown[]) => void calls.push(["title", ...args]),
      setWorkspacePinned: async (...args: unknown[]) => void calls.push(["pin", ...args]),
      markWorkspaceUnread: async (...args: unknown[]) => void calls.push(["unread", ...args]),
      clearWorkspaceAttention: async (...args: unknown[]) => void calls.push(["read", ...args]),
      archiveWorkspace: async (...args: unknown[]) => void calls.push(["archive", ...args]),
      close: async () => {},
    } as never,
    { dispose: async () => {} } as never,
  );
  const app = createApp(store, hosts, "t", directory, { pushSender: { send: async () => {} } });
  const post = (path: string, body: unknown = {}) =>
    app.request("/api/hosts/mac/workspaces/w1" + path, {
      method: "POST",
      headers: { authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const [path, body] of [
      ["/title", { title: "  Ship it  " }],
      ["/title", { title: null }],
      ["/title", { title: "" }],
      ["/pin", { pinned: true }],
      ["/unread", {}],
      ["/read", {}],
      ["/archive", {}],
    ] as const)
      assert.equal((await post(path, body)).status, 200, path);
    assert.deepEqual(calls, [
      ["title", "w1", "Ship it"],
      ["title", "w1", null],
      ["title", "w1", null],
      ["pin", "w1", true],
      ["unread", "w1"],
      ["read", "w1"],
      ["archive", "w1"],
    ]);
    assert.equal((await post("/pin", { pinned: "yes" })).status, 400);
    assert.equal((await app.request("/api/hosts/nope/workspaces/w1/read", { method: "POST", headers: { authorization: "Bearer t" } })).status, 404);
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project actions: removal and paseo.json edits reach the daemon, errors stay readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-proj-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const calls: unknown[][] = [];
  const revision = { mtimeMs: 1, size: 10 };
  let writeError: string | null = null;
  hosts.attach(
    "mac",
    {
      getConnectionState: () => ({ status: "connected" }),
      subscribeConnectionStatus: () => () => {},
      getLastServerInfoMessage: () => ({ features: { directorySync: true } }),
      observeAgents: () => ({ subscribe: () => () => {}, release: async () => {} }),
      removeProject: async (id: string) => (calls.push(["remove", id]), { removedWorkspaceIds: ["w1"] }),
      readProjectConfig: async (root: string) =>
        root === "/gone"
          ? { requestId: "r", repoRoot: root, ok: false, error: { code: "project_not_found" } }
          : { requestId: "r", repoRoot: root, ok: true, config: { worktree: { setup: "npm ci" } }, revision },
      writeProjectConfig: async (input: unknown) => {
        calls.push(["write", input]);
        if (writeError) return { requestId: "r", repoRoot: "/code/app", ok: false, error: { code: writeError, currentRevision: null } };
        return { requestId: "r", repoRoot: "/code/app", ok: true, config: (input as { config: unknown }).config, revision: { mtimeMs: 2, size: 12 }, hasUncommittedWorktreeSetupChanges: true };
      },
      close: async () => {},
    } as never,
    { dispose: async () => {} } as never,
  );
  const app = createApp(store, hosts, "t", directory, { pushSender: { send: async () => {} } });
  const call = (path: string, method = "GET", body?: unknown) =>
    app.request("/api/hosts/mac" + path, {
      method,
      headers: { authorization: "Bearer t", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const removed = await call("/projects/p1", "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true, removedWorkspaceIds: ["w1"] });

    const read = await call("/project-config?root=" + encodeURIComponent("/code/app"));
    assert.deepEqual(await read.json(), { rootPath: "/code/app", config: { worktree: { setup: "npm ci" } }, revision });
    assert.equal((await call("/project-config?root=%2Fgone")).status, 404);

    const config = { worktree: { setup: ["npm ci"] } };
    const written = await call("/project-config", "PUT", { root: "/code/app", config, revision });
    assert.deepEqual(await written.json(), { rootPath: "/code/app", config, revision: { mtimeMs: 2, size: 12 }, uncommittedSetup: true });
    writeError = "stale_project_config";
    const stale = await call("/project-config", "PUT", { root: "/code/app", config, revision });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "Config changed on disk. Reload to fetch the latest paseo.json before saving.", code: "stale_project_config" });
    assert.equal((await call("/project-config", "PUT", { root: "/code/app", config: [1], revision })).status, 400);
    assert.deepEqual(calls.slice(0, 2), [
      ["remove", "p1"],
      ["write", { repoRoot: "/code/app", config, expectedRevision: revision }],
    ]);
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project edit: rename and icon go to the daemon in Paseo's order; failures name their field", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-edit-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const calls: unknown[][] = [];
  let customIcons = true;
  let renameError = false;
  hosts.attach(
    "mac",
    {
      getConnectionState: () => ({ status: "connected" }),
      subscribeConnectionStatus: () => () => {},
      getLastServerInfoMessage: () => ({ features: { directorySync: true, projectCustomIcon: customIcons } }),
      observeAgents: () => ({ subscribe: () => () => {}, release: async () => {} }),
      renameProject: async (id: string, name: string | null) => {
        calls.push(["rename", id, name]);
        if (renameError) throw new Error("Project not found");
        return { customName: name };
      },
      setProjectIcon: async (id: string, source: unknown) => void calls.push(["icon", id, source]),
      getProjectIcon: async (id: string) => (calls.push(["get-icon", id]), { projectId: id, icon: { data: "iVBORw0KGgo=", mimeType: "image/png" }, error: null }),
      requestProjectIcon: async (cwd: string) => (calls.push(["cwd-icon", cwd]), { cwd, icon: null, error: null }),
      close: async () => {},
    } as never,
    { dispose: async () => {} } as never,
  );
  const app = createApp(store, hosts, "t", directory, { pushSender: { send: async () => {} } });
  const edit = (body: unknown) =>
    app.request("/api/hosts/mac/projects/p1/edit", {
      method: "POST",
      headers: { authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await edit({ rename: { customName: "  Shop  " }, icon: { type: "upload", data: "AAAA" } })).status, 200);
    assert.equal((await edit({ rename: { customName: "" }, icon: null })).status, 200);
    assert.equal((await edit({ rename: null, icon: { type: "automatic" } })).status, 200);
    assert.deepEqual(calls, [
      ["rename", "p1", "Shop"],
      ["icon", "p1", { type: "upload", data: "AAAA" }],
      ["rename", "p1", null],
      ["icon", "p1", { type: "automatic" }],
    ]);
    calls.length = 0;
    // An unreachable URL fails before anything is changed, under the icon field.
    const bad = await edit({ rename: { customName: "X" }, icon: { type: "url", url: "ftp://example.com/x.png" } });
    assert.equal(bad.status, 422);
    assert.deepEqual(await bad.json(), { error: "URL must use HTTP or HTTPS without credentials", scope: "icon" });
    renameError = true;
    assert.deepEqual(await (await edit({ rename: { customName: "X" }, icon: { type: "automatic" } })).json(), { error: "Project not found", scope: "name" });
    assert.deepEqual(calls, [["rename", "p1", "X"]], "a failed rename does not go on to the icon");

    // The effective icon (custom or automatic) comes by project when the daemon supports it.
    const icon = await app.request("/api/hosts/mac/project-icon?cwd=%2Fcode%2Fapp&project=p1&v=r1", { headers: { authorization: "Bearer t" } });
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    customIcons = false;
    const old = await app.request("/api/hosts/mac/project-icon?cwd=%2Fcode%2Fapp&project=p1&v=r2", { headers: { authorization: "Bearer t" } });
    assert.equal(old.status, 204);
    assert.deepEqual(calls.slice(1), [["get-icon", "p1"], ["cwd-icon", "/code/app"]]);
    assert.equal((await edit({ rename: null, icon: { type: "automatic" } })).status, 409, "older daemons cannot store icons");
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

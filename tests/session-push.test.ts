import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

const agent = (extra: Record<string, unknown> = {}) => ({
  id: "a1",
  title: "Ship notifications",
  status: "running",
  provider: "codex",
  cwd: "/code/litepaseo",
  updatedAt: new Date().toISOString(),
  pendingPermissions: [],
  ...extra,
});

test("cookie sign-in, CSRF header, revocation, and a daemon update becoming a push", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-cookie-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const host = store.addHost("MacBook", "ws://example.invalid/ws");
  let observer: any;
  hosts.setLabel(host.id, host.label);
  hosts.attach(
    host.id,
    {
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
      close: async () => {},
    } as never,
    { dispose: async () => {} } as never,
  );
  observer.snapshot({
    entries: [{ agent: agent(), project: { projectKey: "k", projectName: "litepaseo" }, syncSeq: 1 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g", headSeq: 1, mode: "snapshot", removals: [] },
  });
  const pushes: { endpoint: string; payload: any }[] = [];
  const app = createApp(store, hosts, "test-token", directory, {
    pushSender: {
      async send(subscription, payload) {
        pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
      },
    },
  });
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; csrf?: boolean } = {}) =>
    app.request("/api" + path, {
      method: init.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.csrf ? { "x-litepaseo": "1" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  try {
    assert.deepEqual(await (await call("/auth")).json(), { authenticated: false, totp: false });
    assert.equal((await call("/hosts")).status, 401);
    assert.equal((await call("/login", { method: "POST", body: { token: "wrong" } })).status, 401);
    const login = await call("/login", { method: "POST", body: { token: "test-token" } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /lp_session=[\w-]+;/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(";")[0];
    assert.deepEqual(await (await call("/auth", { cookie })).json(), { authenticated: true, totp: false });
    assert.equal((await call("/hosts", { cookie })).status, 200);

    // Writes with only a cookie must carry the same-origin header.
    const subscription = { endpoint: "https://push.example/device", keys: { p256dh: "p", auth: "a" } };
    const subscribe = { method: "POST", body: { subscription, prefs: { attention: true, turns: true } }, cookie };
    assert.equal((await call("/push/subscribe", subscribe)).status, 403);
    assert.equal((await call("/push/subscribe", { ...subscribe, csrf: true })).status, 200);
    assert.match((await (await call("/push/key", { cookie })).json()).publicKey, /^[\w-]{80,}$/);

    // The daemon reports a permission request: the subscribed device gets a push.
    observer.update({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: agent({ pendingPermissions: [{ id: "p1", name: "Bash", title: "run the tests", kind: "tool" }] }),
        generation: "g",
        seq: 2,
      },
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].payload.title, "litepaseo · needs your input");
    assert.equal(pushes[0].payload.url, `/?session=${encodeURIComponent(host.id + ":a1")}`);
    assert.equal((await (await call("/health", { cookie })).json()).waiting, 1);

    // The turn ends: a second push.
    // Paseo flags a finished turn for attention ("finished"); that is a turn-end, not a request for input.
    observer.update({
      type: "agent_update",
      payload: { kind: "upsert", agent: agent({ status: "idle", requiresAttention: true, attentionReason: "finished" }), generation: "g", seq: 3 },
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(pushes.map((p) => p.payload.title), ["litepaseo · needs your input", "litepaseo · turn finished"]);
    assert.equal((await (await call("/health", { cookie })).json()).waiting, 0, "an unread finished turn is not waiting for input");

    // Devices and revocation: signing out the session removes its push subscription too.
    const devices = await (await call("/sessions", { cookie })).json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].current, true);
    assert.equal((await call("/logout", { method: "POST", body: {}, cookie, csrf: true })).status, 200);
    assert.equal((await call("/hosts", { cookie })).status, 401, "a signed-out cookie is dead");
    assert.deepEqual(store.pushSubscriptions(), [], "and so is its device's push subscription");

    // Bearer token access (CLI, scripts) still works and needs no CSRF header.
    const bearer = await app.request("/api/board", { headers: { authorization: "Bearer test-token" } });
    assert.equal(bearer.status, 200);
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

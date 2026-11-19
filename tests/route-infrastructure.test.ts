import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { notifyListeners } from "../src/server/listeners.ts";

test("one throwing or rejecting listener neither stops the others nor escapes", async () => {
  const calls: string[] = [];
  const warn = console.warn;
  const logged: string[] = [];
  console.warn = (line: string) => void logged.push(line);
  try {
    const listeners = new Set<(value: number) => unknown>([
      (v) => calls.push(`a${v}`),
      () => { throw new Error("boom"); },
      async () => { throw new Error("later"); },
      (v) => calls.push(`d${v}`),
    ]);
    notifyListeners(listeners, 1);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(calls, ["a1", "d1"]);
  assert.equal(logged.filter((line) => line.includes("listener_failed")).length, 2);
});

test("Store.transaction commits, rolls back, and joins an open transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-tx-"));
  const store = new Store(dir);
  try {
    store.transaction(() => store.setSetting("a", "1"));
    assert.equal(store.setting("a"), "1");
    assert.throws(() => store.transaction(() => { store.setSetting("b", "1"); throw new Error("no"); }));
    assert.equal(store.setting("b"), null);
    // An inner failure rolls back the outer transaction as a whole.
    assert.throws(() => store.transaction(() => {
      store.setSetting("c", "1");
      store.transaction(() => { throw new Error("inner"); });
    }));
    assert.equal(store.setting("c"), null);
    assert.equal(store.db.isTransaction, false);
    store.setSetting("queued-message:x", "1");
    store.setSetting("queued-messagex", "2");
    assert.deepEqual(store.settingsWithPrefix("queued-message:"), [["queued-message:x", "1"]]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a host is attached once; attaching over a live client is refused", () => {
  const hosts = new Hosts();
  const driver = {
    subscribeConnectionStatus: () => () => {},
    getConnectionState: () => ({ status: "connecting", attempt: 1 }),
    subscribe: () => () => {},
  };
  hosts.clients.set("h", { driver } as never);
  assert.throws(() => hosts.attach("h", driver as never, {} as never), /already attached/);
  assert.throws(() => hosts.add({ id: "h", label: "h", connection: "ws://127.0.0.1:1" }), /already attached/);
});

test("browser-only routes refuse a bearer with 403; null provider patches are a 400; sw.js is served fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-routes-"));
  const web = mkdtempSync(join(tmpdir(), "lp-web-"));
  const store = new Store(dir);
  const hosts = new Hosts();
  hosts.clients.set("a", {
    driver: {
      getDaemonConfig: async () => ({ config: { providers: { codex: { enabled: true } } } }),
      getLastServerInfoMessage: () => ({ version: "0.15.3", features: {} }),
      patchDaemonConfig: async () => assert.fail("must not patch"),
    },
  } as never);
  const app = createApp(store, hosts, "test-token", web);
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  try {
    for (const path of ["/api/totp/setup", "/api/push/test"]) {
      const response = await app.request(path, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: "A browser session is required" });
    }
    const { revision } = await (await app.request("/api/hosts/a/settings", { headers })).json();
    const patched = await app.request("/api/hosts/a/settings", {
      method: "PATCH", headers, body: JSON.stringify({ revision, patch: { providers: { codex: null } } }),
    });
    assert.equal(patched.status, 400);

    assert.equal((await app.request("/sw.js")).status, 404);
    writeFileSync(join(web, "sw.js"), "// one");
    const first = await app.request("/sw.js");
    assert.equal(first.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(first.headers.get("cache-control"), "no-cache");
    assert.equal(await first.text(), "// one");
    writeFileSync(join(web, "sw.js"), "// two");
    assert.equal(await (await app.request("/sw.js")).text(), "// two");
  } finally {
    app.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(web, { recursive: true, force: true });
  }
});

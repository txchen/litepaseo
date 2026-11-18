import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { replacementReady, runLifecycle, type LifecycleJob } from "../src/server/host-lifecycle.ts";

test("host settings authenticate, isolate hosts, preserve secrets, reject stale/unsupported patches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-host-settings-")),
    store = new Store(dir),
    hosts = new Hosts();
  const configs: Record<string, any> = {
    a: {
      mcp: { injectIntoAgents: true },
      appendSystemPrompt: "original",
      providers: { codex: { enabled: true, env: { API_KEY: "secret" } } },
      features: { voiceMode: { secret: "voice-secret" } },
    },
    b: { appendSystemPrompt: "other" },
  };
  const calls: any[] = [];
  for (const id of ["a", "b"])
    hosts.clients.set(id, {
      driver: {
        getDaemonConfig: async () => ({ config: configs[id] }),
        getLastServerInfoMessage: () => ({ version: "0.15.3", features: { agentProfiles: true } }),
        patchDaemonConfig: async (patch: any) => {
          calls.push([id, patch]);
          configs[id] = { ...configs[id], ...patch };
        },
      },
    } as never);
  const app = createApp(store, hosts, "test-token", "/missing");
  const request = (id: string, body?: unknown) =>
    app.request(`/api/hosts/${id}/settings`, {
      method: body ? "PATCH" : "GET",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await app.request("/api/hosts/a/settings")).status, 401);
    const first = await (await request("a")).json();
    assert.ok(!JSON.stringify(first).includes("secret"));
    assert.equal(
      (await request("a", { revision: first.revision, patch: { appendSystemPrompt: "changed" } }))
        .status,
      200,
    );
    assert.equal(configs.b.appendSystemPrompt, "other");
    assert.equal(configs.a.providers.codex.env.API_KEY, "secret");
    assert.equal(
      (await request("a", { revision: first.revision, patch: { appendSystemPrompt: "stale" } }))
        .status,
      409,
    );
    const current = await (await request("a")).json();
    assert.equal(
      (await request("a", { revision: current.revision, patch: { idleRuntimeCleanup: true } }))
        .status,
      409,
    );
    assert.equal(
      (await request("a", { revision: current.revision, patch: { features: { dictation: {} } } }))
        .status,
      400,
    );
    assert.equal(
      (
        await request("a", {
          revision: current.revision,
          patch: { providers: { codex: { env: { API_KEY: "new" } } } },
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 1);
  } finally {
    app.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart verification requires a replacement worker and the installed version", () => {
  const previous = { serverId: "host", pid: 1, startedAt: "old" };
  assert.equal(replacementReady(previous, { ...previous, version: "new" }, "new"), false);
  assert.equal(replacementReady(previous, { ...previous, pid: 2, version: "new" }, "new"), true);
  assert.equal(
    replacementReady(previous, { ...previous, startedAt: "new", version: "new" }, "new"),
    true,
  );
  assert.throws(
    () => replacementReady(previous, { ...previous, pid: 2, version: "old" }, "new"),
    /Installed new/,
  );
  assert.throws(
    () => replacementReady(previous, { ...previous, pid: 2, serverId: "other" }),
    /identity/,
  );
});

test("remote update checks package success and replacement before reporting complete", async () => {
  for (const success of [false, true]) {
    let reads = 0,
      cleaned = false;
    const hosts = new Hosts();
    hosts.clients.set("a", {
      driver: {
        getDaemonStatus: async () => ({
          serverId: "a",
          pid: ++reads,
          version: reads === 1 ? "old" : null,
        }),
        getLastServerInfoMessage: () => ({version: "new"}),
        getConnectionState: () => ({ status: "connected" }),
        on: () => () => {
          cleaned = true;
        },
        updateDaemon: async () => ({
          success,
          newVersion: "new",
          error: success ? null : "install failed",
        }),
      },
    } as never);
    const job: LifecycleJob = { action: "update", state: "running", phase: "Starting" };
    await runLifecycle(hosts, "a", job);
    assert.equal(job.state, success ? "complete" : "failed");
    assert.equal(reads, success ? 2 : 1);
    assert.equal(cleaned, true);
    if (success) assert.equal(job.version, "new");
  }
});

test("settings list every provider and refresh re-fetches catalogues once per request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-host-providers-")),
    store = new Store(dir),
    hosts = new Hosts();
  let models = [{ id: "old", label: "Old" }];
  const refreshes: unknown[] = [];
  hosts.clients.set("a", {
    driver: {},
    api: {
      providers: {
        snapshot: async () => ({
          entries: [
            { provider: "codex", status: "ready", enabled: true, label: "Codex", fetchedAt: "2026-11-15T00:00:00Z", models },
            { provider: "claude", status: "unavailable", enabled: false },
          ],
        }),
        refresh: async (options: unknown) => {
          refreshes.push(options);
          await new Promise((r) => setTimeout(r, 20));
          models = [...models, { id: "new", label: "New", isSelectable: true } as never];
          return { acknowledged: true };
        },
      },
    },
  } as never);
  const app = createApp(store, hosts, "test-token", "/missing");
  const call = (path: string, body?: unknown) =>
    app.request(`/api/hosts/a/settings/providers${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const listed = await (await call("")).json();
    assert.deepEqual(listed.map((p: any) => [p.id, p.enabled, p.status]), [
      ["codex", true, "ready"],
      ["claude", false, "unavailable"],
    ]);
    assert.equal(listed[0].fetchedAt, "2026-11-15T00:00:00Z");
    const [first, second] = await Promise.all([call("/refresh", { providers: ["codex"] }), call("/refresh", { providers: ["codex"] })]);
    assert.equal(refreshes.length, 1, "concurrent refreshes of the same providers coalesce");
    assert.deepEqual(refreshes[0], { providers: ["codex"] });
    const after = await first.json();
    assert.deepEqual(after[0].models.map((m: any) => m.id), ["old", "new"]);
    assert.equal(second.status, 200);
    await call("/refresh", {});
    assert.deepEqual(refreshes[1], {});
  } finally {
    app.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom providers can be removed; built-ins and unsupported hosts refuse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-host-remove-")),
    store = new Store(dir),
    hosts = new Hosts();
  let config: Record<string, any> = { providers: { codex: { enabled: true }, mine: { extends: "codex", label: "Mine" } } };
  let removal = true;
  const patches: any[] = [];
  hosts.clients.set("a", {
    driver: {
      getDaemonConfig: async () => ({ config }),
      getLastServerInfoMessage: () => ({ features: { providerRemoval: removal } }),
      patchDaemonConfig: async (patch: any) => {
        patches.push(patch);
        const providers = { ...config.providers };
        for (const id of patch.removeProviders ?? []) delete providers[id];
        config = { ...config, providers };
      },
    },
  } as never);
  const app = createApp(store, hosts, "test-token", "/missing");
  const request = (body?: unknown) =>
    app.request(`/api/hosts/a/settings`, {
      method: body ? "PATCH" : "GET",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    let { revision } = await (await request()).json();
    assert.equal((await request({ revision, patch: { removeProviders: ["codex"] } })).status, 400);
    removal = false;
    assert.equal((await request({ revision, patch: { removeProviders: ["mine"] } })).status, 409);
    removal = true;
    assert.equal(
      (await request({ revision, patch: { removeProviders: ["mine"], providers: { mine: { label: "x" } } } })).status,
      400,
    );
    assert.equal(patches.length, 0);
    const saved = await request({ revision, patch: { removeProviders: ["mine"] } });
    assert.equal(saved.status, 200);
    assert.deepEqual(patches, [{ removeProviders: ["mine"] }]);
    assert.equal((await saved.json()).config.providers.mine, undefined);
  } finally {
    app.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

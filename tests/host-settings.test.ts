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

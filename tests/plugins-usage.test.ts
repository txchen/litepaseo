import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { UsageService } from "../src/server/usage.ts";
import { createApp } from "../src/server/app.ts";

const codex = (resetsAt: string, remaining = 91) => ({
  providerId: "codex",
  displayName: "Codex",
  status: "available",
  planLabel: "Pro",
  sourceLabel: null,
  windows: [
    { id: "5h", label: "5-hour", shortLabel: "5h", remainingPct: remaining, resetsAt },
    { id: "week", label: "Weekly", shortLabel: "wk", usedPct: 60, resetsAt: "2026-11-15T00:00:00Z" },
  ],
});

function hostsWith(usage: Record<string, () => Promise<unknown>>, calls: Record<string, unknown[]>) {
  const hosts = new Hosts();
  for (const [id, listUsage] of Object.entries(usage)) {
    hosts.setLabel(id, id.toUpperCase());
    hosts.attach(
      id,
      {
        getConnectionState: () => ({ status: "connected" }),
        subscribeConnectionStatus: () => () => {},
        getLastServerInfoMessage: () => ({ features: { directorySync: true } }),
        observeAgents: () => ({ subscribe: () => () => {}, release: async () => {} }),
        clearAgentAttention: async (agentId: string) => void (calls[id] ??= []).push(["read", agentId]),
        invokePluginRpc: async (plugin: string, method: string, input: unknown) => {
          (calls[id] ??= []).push(["rpc", plugin, method, input]);
          return { status: "ready", text: "Run the full test suite next." };
        },
        close: async () => {},
      } as never,
      {
        providers: {
          listUsage: async () => {
            (calls[id] ??= []).push(["usage"]);
            return listUsage();
          },
        },
        agents: { ref: (agentId: string) => ({ archive: async () => void (calls[id] ??= []).push(["archive", agentId]) }) },
        dispose: async () => {},
      } as never,
    );
  }
  return hosts;
}

test("usage: one read per host per window, shared in flight, same account merged across hosts", async () => {
  const calls: Record<string, unknown[]> = {};
  let now = 1_000_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hosts = hostsWith(
    {
      mac: async () => {
        await gate;
        return { providers: [codex("2026-11-11T05:00:00Z")] };
      },
      build: async () => ({ providers: [codex("2026-11-11T05:00:00Z"), { ...codex("2026-11-11T07:00:00Z", 40), planLabel: "Plus" }] }),
      gpu: async () => {
        throw new Error("Update the host to read usage.");
      },
    },
    calls,
  );
  const usage = new UsageService(hosts, () => now);
  const first = usage.report();
  const second = usage.report();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls.mac.length, 1, "concurrent readers share one request");
  assert.deepEqual(
    a.accounts.map((x) => [x.name, x.plan, x.hosts, x.windows.map((w) => w.remainingPct)]),
    [
      ["Codex", "Plus", ["BUILD"], [40, 40]],
      ["Codex", "Pro", ["MAC", "BUILD"], [91, 40]],
    ].sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
  );
  assert.deepEqual(a.unavailableHosts, [{ hostId: "gpu", label: "GPU", error: "Update the host to read usage." }]);

  now += 60_000;
  await usage.report();
  assert.equal(calls.mac.length, 1, "within five minutes the cached copy is used");
  now += 5 * 60_000;
  await usage.report();
  assert.equal(calls.mac.length, 2);
  assert.equal(calls.gpu.length, 3, "a failed host is retried once a minute has passed, not after five");
  await hosts.close();
});

test("board actions and the next-input suggestion reach the right host", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-plugins-"));
  const store = new Store(directory);
  const calls: Record<string, unknown[]> = {};
  const hosts = hostsWith({ mac: async () => ({ providers: [] }), build: async () => ({ providers: [] }) }, calls);
  const app = createApp(store, hosts, "t", directory, { pushSender: { send: async () => {} } });
  const post = (path: string, body: unknown = {}) =>
    app.request("/api" + path, {
      method: "POST",
      headers: { authorization: "Bearer t", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post("/hosts/build/agents/a1/read")).status, 200);
    assert.equal((await post("/hosts/build/agents/a1/archive")).status, 200);
    const suggestion = await (await post("/hosts/mac/agents/a2/suggestion", { token: "tok-1" })).json();
    assert.deepEqual(suggestion, { status: "ready", text: "Run the full test suite next." });
    assert.deepEqual(calls.build, [
      ["read", "a1"],
      ["archive", "a1"],
    ]);
    assert.deepEqual(calls.mac, [["rpc", "next-input", "suggestions.predict", { agentId: "a2", token: "tok-1" }]]);
    assert.equal((await post("/hosts/mac/agents/a2/suggestion", {})).status, 400);
    const report = await (await app.request("/api/usage", { headers: { authorization: "Bearer t" } })).json();
    assert.deepEqual(report.accounts, []);
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

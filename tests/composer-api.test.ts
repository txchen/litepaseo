import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-composer-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const host = store.addHost("Mac", "ws://example.invalid/ws");
  const calls: unknown[][] = [];
  let observer: any;
  const driver = {
    getConnectionState: () => ({ status: "connected" }),
    subscribeConnectionStatus: () => () => {},
    getLastServerInfoMessage: () => ({ features: { directorySync: true } }),
    observeAgents: () => ({ subscribe: (o: unknown) => ((observer = o), () => {}), release: async () => {} }),
    setAgentModel: async (...args: unknown[]) => void calls.push(["model", ...args]),
    setAgentThinkingOption: async (...args: unknown[]) => (calls.push(["thinking", ...args]), { message: "Applies next turn" }),
    setAgentMode: async (...args: unknown[]) => (calls.push(["mode", ...args]), null),
    setAgentFeature: async (...args: unknown[]) => void calls.push(["feature", ...args]),
    scheduleUpdate: async (options: unknown) => (calls.push(["scheduleUpdate", options]), { schedule: { id: "s1" }, error: null }),
    close: async () => {},
  };
  hosts.attach(host.id, driver as never, {
    providers: {
      snapshot: async () => ({
        entries: [{
          provider: "pi", status: "ready", enabled: true,
          models: [
            { id: "anthropic/opus", label: "Opus", thinkingOptions: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }], defaultThinkingOptionId: "medium" },
            { id: "hidden", label: "Hidden", isSelectable: false },
          ],
        }],
      }),
    },
    dispose: async () => {},
  } as never);
  observer.snapshot({
    entries: [{
      agent: {
        id: "a1", title: "t", status: "idle", provider: "pi", cwd: "/", updatedAt: "2026-01-01T00:00:00Z",
        model: "anthropic/opus", effectiveThinkingOptionId: "medium", currentModeId: "full",
        availableModes: [{ id: "full", label: "Full Access" }, { id: "ask", label: "Ask" }],
        features: [{ type: "select", id: "speed", label: "Speed", value: "normal", options: [{ id: "normal", label: "Normal" }, { id: "fast", label: "Fast" }] }],
        lastUsage: { contextWindowUsedTokens: 281_198, contextWindowMaxTokens: 1_000_000 },
      },
      syncSeq: 1,
    }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g", headSeq: 1, mode: "snapshot", removals: [] },
  });
  const app = createApp(store, hosts, "test-token", directory);
  const request = (path: string, init: RequestInit = {}) =>
    app.request("/api" + path, { ...init, headers: { authorization: "Bearer test-token", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return { app, hosts, host, calls, request, done: async () => { await hosts.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("the composer reads model, thinking, mode, features and context from the directory and the host", async () => {
  const { hosts, host, calls, request, done } = setup();
  try {
    const summary = hosts.agents.get(`${host.id}:a1`)!;
    assert.deepEqual(
      [summary.model, summary.thinking, summary.modeId, summary.contextUsed, summary.contextMax],
      ["anthropic/opus", "medium", "full", 281_198, 1_000_000],
    );
    const options = await (await request(`/hosts/${host.id}/agents/a1/config`)).json();
    assert.deepEqual(options.models.map((m: any) => m.id), ["anthropic/opus"]);
    assert.deepEqual(options.models[0].thinking.map((t: any) => t.id), ["low", "medium"]);
    assert.deepEqual(options.modes.map((m: any) => m.label), ["Full Access", "Ask"]);
    assert.equal(options.features[0].options.length, 2);

    const post = (body: unknown) => request(`/hosts/${host.id}/agents/a1/config`, { method: "POST", body: JSON.stringify(body) });
    assert.equal((await post({ model: "anthropic/opus" })).status, 200);
    assert.deepEqual(await (await post({ thinkingOptionId: "low" })).json(), { ok: true, notice: { message: "Applies next turn" } });
    await post({ modeId: "ask" });
    await post({ feature: { id: "speed", value: "fast" } });
    assert.equal((await post({ model: "x", modeId: "y" })).status >= 400, true, "one change per request");
    assert.deepEqual(calls, [
      ["model", "a1", "anthropic/opus"],
      ["thinking", "a1", "low"],
      ["mode", "a1", "ask"],
      ["feature", "a1", "speed", "fast"],
    ]);
  } finally {
    await done();
  }
});

test("editing a schedule sends only the fields that changed shape, as one update", async () => {
  const { host, calls, request, done } = setup();
  try {
    const response = await request(`/hosts/${host.id}/schedules/s1`, {
      method: "PATCH",
      body: JSON.stringify({ name: "", prompt: "Check in", cron: "0 9 * * 1-5", timezone: "UTC", cwd: "/repo", provider: "pi", model: null, archiveOnFinish: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [["scheduleUpdate", {
      id: "s1",
      name: null,
      prompt: "Check in",
      cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
      newAgentConfig: { provider: "pi", model: null, cwd: "/repo", archiveOnFinish: false },
    }]]);
  } finally {
    await done();
  }
});

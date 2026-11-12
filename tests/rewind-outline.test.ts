import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { rewindModes, summarize } from "../src/server/host-directory.ts";

test("rewind modes come from the provider's capabilities, in Paseo's menu order", () => {
  assert.deepEqual(rewindModes(undefined), []);
  assert.deepEqual(rewindModes({ supportsRewindConversation: true } as never), ["conversation"]);
  assert.deepEqual(
    rewindModes({ supportsRewindBoth: true, supportsRewindFiles: true, supportsRewindConversation: true } as never),
    ["conversation", "files", "both"],
  );
  const summary = summarize("h", { id: "a", status: "idle", provider: "claude", cwd: "/", capabilities: { supportsRewindFiles: true } } as never);
  assert.deepEqual(summary.rewind, ["files"]);
});

test("rewind and the prompt index reach the right agent; unsupported modes are refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-rewind-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const host = store.addHost("Alpha", "ws://example.invalid/ws");
  const calls: unknown[] = [];
  let observer: any;
  let promptsFail = false;
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
    rewindAgent: async (agentId: string, messageId: string, mode: string) => {
      calls.push(["rewind", agentId, messageId, mode]);
      if (messageId === "unacknowledged") throw new Error("Cannot rewind before the provider acknowledges the submitted prompt");
      return { ok: true, error: null };
    },
    listAgentTimelinePrompts: async (agentId: string) => {
      calls.push(["prompts", agentId]);
      if (promptsFail) throw new Error("Unknown request agent.timeline.list_prompts.request");
      return { epoch: "e1", prompts: [{ seq: 3, timestamp: "t", preview: "  fix the\n  build  " }], error: null };
    },
    close: async () => {},
  };
  hosts.attach(host.id, driver as never, { agents: { ref: () => ({}) }, dispose: async () => {} } as never);
  observer.snapshot({
    entries: [{ agent: { id: "a1", status: "idle", provider: "claude", cwd: "/", updatedAt: "2026-01-01T00:00:00Z",
      capabilities: { supportsRewindConversation: true, supportsRewindBoth: true } }, syncSeq: 1 }],
    pageInfo: { hasMore: false, nextCursor: null },
    sync: { generation: "g", headSeq: 1, mode: "snapshot", removals: [] },
  });
  const app = createApp(store, hosts, "test-token", directory);
  const request = (path: string, method = "GET", body?: unknown) =>
    app.request("/api" + path, {
      method,
      headers: { authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const base = `/hosts/${host.id}/agents/a1`;
  try {
    assert.deepEqual(await (await request(base + "/timeline/prompts")).json(), { epoch: "e1", prompts: [{ seq: 3, preview: "fix the build" }] });
    promptsFail = true;
    assert.equal((await request(base + "/timeline/prompts")).status, 501, "an older daemon has no prompt index");

    assert.equal((await request(base + "/rewind", "POST", { messageId: "m1", mode: "conversation" })).status, 200);
    assert.equal((await request(base + "/rewind", "POST", { messageId: "m1", mode: "files" })).status, 400, "provider cannot rewind files alone");
    assert.equal((await request(base + "/rewind", "POST", { messageId: "m1", mode: "sideways" })).status, 400);
    assert.equal((await request(`/hosts/${host.id}/agents/unknown/rewind`, "POST", { messageId: "m1", mode: "both" })).status, 404);
    const failed = await request(base + "/rewind", "POST", { messageId: "unacknowledged", mode: "both" });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /acknowledges/);
    assert.deepEqual(calls.filter((c: any) => c[0] === "rewind"), [
      ["rewind", "a1", "m1", "conversation"],
      ["rewind", "a1", "unacknowledged", "both"],
    ]);
  } finally {
    await hosts.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

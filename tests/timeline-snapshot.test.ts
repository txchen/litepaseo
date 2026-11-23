import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hosts, TimelineTimeoutError } from "../src/server/hosts.ts";
import { Store } from "../src/server/store.ts";
import { createApp } from "../src/server/app.ts";

/** A daemon whose timeline subscription is ready when `ready()` is called (or at once). */
function fakeHost(hosts: Hosts, options: { readyAtOnce?: boolean } = {}) {
  let ready!: () => void;
  const readiness = options.readyAtOnce ? Promise.resolve() : new Promise<void>((r) => (ready = r));
  let fetches = 0;
  const driver = {
    getConnectionState: () => ({ status: "connected" }),
    fetchAgentTimeline: async () => {
      await readiness;
      fetches++;
      return {
        epoch: "e", reset: false, window: { minSeq: 1, maxSeq: 7, nextSeq: 8 }, startCursor: null, endCursor: null,
        hasOlder: false, hasNewer: false,
        entries: [{ provider: "codex", item: { type: "user_message", text: "hi" }, timestamp: "t", seqStart: 1, seqEnd: 7 }],
      };
    },
  };
  hosts.clients.set("h", { driver } as never);
  return { ready: () => ready(), fetches: () => fetches };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const view = (hosts: Hosts) => (hosts as any).timelines.get("h:a1") as { view: { watcherCount: number }; idle?: unknown } | undefined;

test("a snapshot waits for a view that is still loading, then leaves it for the stream to resume from", async () => {
  const hosts = new Hosts();
  const host = fakeHost(hosts);
  const pending = hosts.timelineSnapshot("h", "a1");
  await settle();
  assert.equal(view(hosts)!.view.watcherCount, 1, "the snapshot waits as a viewer");
  host.ready();
  const snapshot = await pending;
  assert.equal(snapshot.type, "reset");
  assert.equal(snapshot.seq, 1, "says how far the view revision reaches, for the stream to resume from");
  assert.deepEqual(snapshot.rows.map((r) => r.seqStart), [1]);
  await settle();
  assert.equal(view(hosts)!.view.watcherCount, 0, "it does not stay a viewer");
  assert.ok(view(hosts)!.idle, "the view lives on for the stream that follows");
  // A live view answers at once, without reading from the daemon again.
  const again = await hosts.timelineSnapshot("h", "a1");
  assert.equal(again.seq, 1);
  assert.equal(host.fetches(), 1);
  await settle();
  assert.equal(view(hosts)!.view.watcherCount, 0);
  await hosts.close();
});

test("a snapshot gives up on a host that does not load the conversation", async () => {
  const hosts = new Hosts();
  fakeHost(hosts);
  await assert.rejects(hosts.timelineSnapshot("h", "a1", 30), TimelineTimeoutError);
  await settle();
  assert.equal(view(hosts)!.view.watcherCount, 0, "the waiting viewer is removed");
  await hosts.close();
});

test("GET …/timeline/latest returns the conversation as a plain response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-test-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  fakeHost(hosts, { readyAtOnce: true });
  const app = createApp(store, hosts, "test-token", directory);
  const get = (path: string) => app.request("/api" + path, { headers: { authorization: "Bearer test-token" } });
  try {
    const response = await get("/hosts/h/agents/a1/timeline/latest");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    const snapshot = await response.json();
    assert.deepEqual([snapshot.type, snapshot.epoch, snapshot.seq, snapshot.rows[0].item.text], ["reset", "e", 1, "hi"]);
    assert.equal((await get("/hosts/nope/agents/a1/timeline/latest")).status, 404);
  } finally {
    await hosts.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

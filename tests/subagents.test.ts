import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { HostSubagents, type SubagentDriver } from "../src/server/subagents.ts";
import { TimelineView } from "../src/server/timeline-view.ts";
import { TimelineStore } from "../src/web/timeline-store.ts";
import type { ProviderSubagent, TimelineOp } from "../src/shared/wire.ts";

mock.timers.enable({ apis: ["setTimeout"] });
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const sleep = async (ms: number) => {
  await settle();
  mock.timers.tick(ms);
  await settle();
};

const descriptor = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentAgentId: "parent",
  parentSubagentId: null,
  provider: "claude",
  title: "Task",
  description: `Do ${id}`,
  status: "running" as const,
  createdAt: `2026-01-01T00:00:0${id.length}Z`,
  updatedAt: "2026-01-01T00:00:00Z",
  toolCallId: `call-${id}`,
  cwd: "/repo",
  subtitle: null,
  ...extra,
});

/** A daemon double: list answers on demand, update events are pushed by the test. */
class FakeDaemon implements SubagentDriver {
  lists: { parent: string; resolve: (value: { subagents: ReturnType<typeof descriptor>[] }) => void }[] = [];
  handlers = new Set<(message: { payload: unknown }) => void>();
  observers = new Set<{ snapshot(payload: unknown): void }>();
  subscriptions = 0;
  released = 0;
  fetches: Record<string, unknown>[] = [];
  page: any = null;

  observeEvents() {
    this.subscriptions++;
    return {
      ready: Promise.resolve({}),
      subscribe: (observer: { snapshot(payload: unknown): void }) => {
        this.observers.add(observer);
        observer.snapshot({});
        return () => this.observers.delete(observer);
      },
      release: async () => {
        this.released++;
      },
    };
  }
  on(_type: string, handler: (message: { payload: unknown }) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  listProviderSubagents(parent: string) {
    return new Promise<{ subagents: ReturnType<typeof descriptor>[] }>((resolve) => this.lists.push({ parent, resolve }));
  }
  async fetchProviderSubagentTimeline(parent: string, subagent: string, options: Record<string, unknown>) {
    this.fetches.push({ parent, subagent, ...options });
    return this.page;
  }
  emit(payload: unknown) {
    for (const handler of this.handlers) handler({ payload });
  }
  reconnect() {
    for (const observer of this.observers) observer.snapshot({});
  }
}

test("lists an agent's subagents, folding in changes that race the list", async () => {
  const daemon = new FakeDaemon();
  const subagents = new HostSubagents(daemon);
  const seen: ProviderSubagent[][] = [];
  const stop = subagents.watch("parent", (list) => seen.push(list));
  assert.equal(daemon.subscriptions, 1);
  assert.equal(daemon.lists.length, 1);
  // Arrives while the list is in flight: newer than what the list reports.
  daemon.emit({ kind: "upsert", subagent: descriptor("a", { status: "completed", updatedAt: "2026-01-01T00:00:05Z" }) });
  daemon.emit({ kind: "upsert", subagent: { ...descriptor("x"), parentAgentId: "other" } });
  daemon.lists[0].resolve({ subagents: [descriptor("a"), descriptor("bb")] });
  await settle();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map((s) => [s.id, s.status]), [["a", "completed"], ["bb", "running"]]);
  assert.equal(seen[0][0].toolCallId, "call-a");
  assert.equal("parentAgentId" in seen[0][0], false);

  // Later changes are batched into one list.
  daemon.emit({ kind: "upsert", subagent: descriptor("bb", { status: "failed", updatedAt: "2026-01-01T00:00:09Z" }) });
  daemon.emit({ kind: "remove", parentAgentId: "parent", subagentId: "a" });
  assert.equal(seen.length, 1);
  await sleep(500);
  assert.deepEqual(seen.at(-1)!.map((s) => [s.id, s.status]), [["bb", "failed"]]);

  // A second watcher of the same agent gets the current list at once, without a request.
  const late: ProviderSubagent[][] = [];
  const stopLate = subagents.watch("parent", (list) => late.push(list));
  assert.equal(daemon.lists.length, 1);
  assert.deepEqual(late[0].map((s) => s.id), ["bb"]);
  stopLate();
  stop();

  // The host subscription outlives a quick conversation switch, then is released.
  await sleep(29_000);
  assert.equal(daemon.released, 0);
  await sleep(1_000);
  assert.equal(daemon.released, 1);
  assert.equal(daemon.handlers.size, 0);
});

test("a reconnect lists watched agents again", async () => {
  const daemon = new FakeDaemon();
  const subagents = new HostSubagents(daemon);
  const seen: ProviderSubagent[][] = [];
  const stop = subagents.watch("parent", (list) => seen.push(list));
  daemon.lists[0].resolve({ subagents: [descriptor("a")] });
  await settle();
  daemon.reconnect();
  assert.equal(daemon.lists.length, 2);
  daemon.lists[1].resolve({ subagents: [] });
  await settle();
  assert.deepEqual(seen.at(-1), []);
  stop();
  await subagents.dispose();
});

test("a daemon without provider subagents lists none", async () => {
  const daemon = new FakeDaemon();
  daemon.listProviderSubagents = () => Promise.reject(new Error("Unknown request"));
  const subagents = new HostSubagents(daemon);
  const seen: ProviderSubagent[][] = [];
  subagents.watch("parent", (list) => seen.push(list));
  await settle();
  assert.deepEqual(seen, [[]]);
  await subagents.dispose();
});

test("a subagent conversation streams through the shared timeline view", async () => {
  const daemon = new FakeDaemon();
  const subagents = new HostSubagents(daemon);
  daemon.page = {
    provider: "claude",
    epoch: "e1",
    reset: false,
    window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
    startCursor: { epoch: "e1", seq: 1 },
    endCursor: { epoch: "e1", seq: 2 },
    hasOlder: false,
    hasNewer: false,
    rows: [
      { item: { type: "user_message", text: "Find the bug" }, timestamp: "t1", seq: 1, seqStart: 1, seqEnd: 1 },
      { item: { type: "assistant_message", text: "Looking" }, timestamp: "t2", seq: 2, seqStart: 2, seqEnd: 2 },
    ],
  };
  const view = new TimelineView(subagents.timelineDriver("parent", "sub"), "parent");
  view.setActive(true);
  const store = new TimelineStore();
  view.watch((ops: TimelineOp[]) => store.apply(ops));
  view.start();
  await settle();
  assert.equal(daemon.fetches[0].direction, "tail");
  assert.equal(daemon.fetches[0].subagent, "sub");
  assert.deepEqual(store.rows.map((r) => r.row.value.item.text), ["Find the bug", "Looking"]);
  assert.equal(store.rows[1].row.value.provider, "claude");

  // Next low-frequency pull picks up the updated subagent projection from the daemon.
  daemon.page = {
    ...daemon.page,
    window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
    rows: [
      { item: { type: "user_message", text: "Find the bug" }, timestamp: "t1", seq: 1, seqStart: 1, seqEnd: 1 },
      { item: { type: "assistant_message", text: "Looking closely" }, timestamp: "t3", seq: 2, seqStart: 2, seqEnd: 3 },
    ],
  };
  await sleep(1_500);
  assert.deepEqual(store.rows.map((r) => r.row.value.item.text), ["Find the bug", "Looking closely"]);

  await view.dispose();
});

test("an event subscription that fails to start is replaced on the next try", async () => {
  const daemon = new FakeDaemon();
  const observe = daemon.observeEvents.bind(daemon);
  let failures = 1;
  daemon.observeEvents = () => {
    const events = observe();
    if (failures-- > 0) {
      const ready = Promise.reject(new Error("socket closed"));
      ready.catch(() => {});
      return { ...events, ready };
    }
    return events;
  };
  daemon.page = {
    provider: "claude", epoch: "e1", reset: false, window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
    startCursor: { epoch: "e1", seq: 1 }, endCursor: { epoch: "e1", seq: 1 }, hasOlder: false, hasNewer: false,
    rows: [{ item: { type: "user_message", text: "Find the bug" }, timestamp: "t1", seq: 1, seqStart: 1, seqEnd: 1 }],
  };
  const subagents = new HostSubagents(daemon);
  const sub1 = subagents.timelineDriver("parent", "sub").subscribeAgentTimeline!("parent", () => {});
  sub1.ready.catch(() => {});
  await settle();
  assert.equal(daemon.released, 1, "the failed subscription is let go at once");
  sub1();
  const sub2 = subagents.timelineDriver("parent", "sub").subscribeAgentTimeline!("parent", () => {});
  await settle();
  assert.equal(daemon.subscriptions, 2, "the retry subscribes afresh");
  sub2();
  await subagents.dispose();
});

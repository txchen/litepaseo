import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mergeToolCallItems, TimelineView, type TimelineDriver } from "../src/server/timeline-view.ts";
import { TimelineStore } from "../src/web/timeline-store.ts";
import type { AgentMetric, TimelineItem, TimelineOp, TimelineRow } from "../src/shared/wire.ts";

mock.timers.enable({ apis: ["setTimeout"] });
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const sleep = async (ms: number) => {
  await settle();
  mock.timers.tick(ms);
  await settle();
};

/** Independent model of the daemon's projected timeline (append + tail/before reads). */
class ReferenceDaemon {
  epoch = "e1";
  rows: (TimelineRow & { sources: number[] })[] = [];
  identities = new Map<string, number>();
  nextSeq = 1;
  fetches: Record<string, unknown>[] = [];

  append(item: TimelineItem, turnId?: string, turnMetrics?: AgentMetric[]) {
    const seq = this.nextSeq++;
    const entry = {
      seqStart: seq,
      seqEnd: seq,
      timestamp: "t" + seq,
      provider: "codex",
      item,
      sources: [seq],
      ...(turnId ? { turnId } : {}),
      ...(turnMetrics?.length ? { turnMetrics } : {}),
    };
    const id = item.type === "tool_call" ? (item.callId as string) : item.type === "plugin" ? `${item.pluginId}/${item.id}` : null;
    const index = id === null ? undefined : this.identities.get(id);
    const existing = index === undefined ? undefined : this.rows[index];
    if (existing && item.type === "tool_call" && existing.item.type === "tool_call" && existing.turnId === turnId) {
      existing.item = mergeToolCallItems(existing.item, item);
      existing.timestamp = entry.timestamp;
      existing.seqEnd = Math.max(existing.seqEnd, seq);
      if (turnMetrics?.length) existing.turnMetrics = turnMetrics;
      existing.sources.push(seq);
      return seq;
    }
    const prev = this.rows.at(-1);
    if (
      prev &&
      prev.item.type === item.type &&
      (item.type === "assistant_message" || item.type === "reasoning") &&
      prev.seqEnd + 1 === seq &&
      prev.turnId === turnId &&
      (item.type === "reasoning" || item.messageId === undefined || item.messageId === prev.item.messageId)
    ) {
      prev.item = {
        type: item.type,
        text: (prev.item.text ?? "") + (item.text ?? ""),
        ...(item.type === "assistant_message" && prev.item.messageId ? { messageId: prev.item.messageId } : {}),
      };
      prev.timestamp = entry.timestamp;
      prev.seqEnd = seq;
      if (turnMetrics?.length) prev.turnMetrics = turnMetrics;
      prev.sources.push(seq);
      return seq;
    }
    if (id !== null) this.identities.set(id, this.rows.length);
    this.rows.push(entry);
    return seq;
  }

  attachTurnMetrics(seqStart: number, metrics: AgentMetric[]) {
    const row = this.rows.find((r) => r.seqStart === seqStart);
    if (row) row.turnMetrics = metrics;
  }

  page(rows: typeof this.rows, extra: Record<string, unknown>) {
    return {
      epoch: this.epoch,
      reset: false,
      window: { minSeq: this.rows.length ? 1 : 0, maxSeq: this.nextSeq - 1, nextSeq: this.nextSeq },
      endCursor: { epoch: this.epoch, seq: this.nextSeq - 1 },
      hasNewer: false,
      entries: rows.map(({ sources, ...row }) => structuredClone(row)),
      ...extra,
    } as any;
  }

  fetch(options: any) {
    this.fetches.push(options);
    if (options.direction === "tail") {
      const start = Math.max(0, this.rows.length - options.limit);
      return this.page(this.rows.slice(start), {
        hasOlder: start > 0,
        startCursor: this.rows[start] ? { epoch: this.epoch, seq: this.rows[start].seqStart } : null,
      });
    }
    if (options.direction === "before") {
      const before = this.rows.filter((r) => r.seqStart < options.cursor.seq);
      const start = Math.max(0, before.length - options.limit);
      return this.page(before.slice(start), {
        hasOlder: start > 0,
        startCursor: before[start] ? { epoch: this.epoch, seq: before[start].seqStart } : null,
      });
    }
    return this.page([], { hasOlder: false, startCursor: null });
  }
}

function harness(daemon = new ReferenceDaemon()) {
  const driver: TimelineDriver = {
    fetchAgentTimeline: async (_id, options) => daemon.fetch(options),
  };
  const view = new TimelineView(driver, "agent");
  const store = new TimelineStore();
  const ops: TimelineOp[] = [];
  const stop = view.watch((batch) => {
    ops.push(...batch);
    store.apply(batch);
  });
  return { daemon, view, store, ops, stop };
}

test("history can traverse thousands of rows in both directions without growing or skipping", () => {
  const daemon = new ReferenceDaemon();
  for (let i = 0; i < 1500; i++) daemon.append({ type: "user_message", text: `m${i}` }, `t${i}`);
  const tail = daemon.fetch({ direction: "tail", limit: 100 });
  const seen = new Set(tail.entries.map((r: TimelineRow) => r.seqStart));
  let cursor = tail.startCursor;
  while (cursor) {
    const page = daemon.fetch({ direction: "before", cursor, limit: 100 });
    for (const r of page.entries) seen.add(r.seqStart);
    cursor = page.hasOlder ? page.startCursor : null;
  }
  assert.equal(seen.size, 1500);
});

test("idle views do zero polling; active views pull at 1.5s and broadcast only changed rows", async () => {
  const { daemon, view, store, ops } = harness();
  daemon.append({ type: "user_message", text: "Hello" }, "t1");
  daemon.append({ type: "assistant_message", text: "Hi" }, "t1");
  view.start();
  await settle();
  assert.equal(daemon.fetches.length, 1);
  assert.deepEqual(store.rows.map((r) => r.row.value.item.text), ["Hello", "Hi"]);

  // Idle: advancing time triggers zero additional fetches.
  await sleep(10_000);
  assert.equal(daemon.fetches.length, 1);

  // Turning active pulls immediately and then every 1.5s while watched.
  ops.length = 0;
  daemon.append({ type: "assistant_message", text: " there" }, "t1");
  view.setActive(true);
  await settle();
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.type, "upsert");
  assert.equal(store.rows[1]!.row.value.item.text, "Hi there");

  // Unchanged poll emits nothing.
  ops.length = 0;
  await sleep(1_500);
  assert.equal(ops.length, 0);

  // Changed tool call & text arrive on the next poll.
  daemon.append({ type: "tool_call", callId: "c1", status: "running", detail: { type: "shell", command: "ls" } }, "t1");
  await sleep(1_500);
  assert.equal(store.rows.length, 3);
  assert.equal(store.rows[2]!.row.value.item.status, "running");

  await view.dispose();
});

test("turning idle settles turnMetrics and returning browsers resume with them via monotonic revision", async () => {
  const { daemon, view, store, stop } = harness();
  daemon.append({ type: "user_message", text: "Check" }, "t1");
  daemon.append({ type: "assistant_message", text: "Done" }, "t1");
  view.setActive(true);
  view.start();
  await settle();
  const resumeBeforeMetrics = store.resumePoint()!;
  assert.equal(resumeBeforeMetrics.seq, 1);

  // Viewer leaves while turn finishes; daemon attaches turnMetrics shortly after turn end.
  stop();
  view.setActive(false);
  await settle();
  const metrics: AgentMetric[] = [{ label: "Speed", value: "~45 tok/s" }, { label: "Cost", value: "$0.12" }];
  daemon.attachTurnMetrics(2, metrics);
  await sleep(700);

  // Returning browser resumes with its old revision and gets only the row with turnMetrics attached.
  const resumedOps: TimelineOp[] = [];
  const stop2 = view.watch((batch) => {
    resumedOps.push(...batch);
    store.apply(batch);
  }, resumeBeforeMetrics);
  assert.equal(resumedOps.length, 1);
  assert.equal(resumedOps[0]!.type, "upsert");
  assert.deepEqual(store.rows[1]!.row.value.turnMetrics, metrics);
  stop2();
  await view.dispose();
});

test("epoch replacement sends a clean reset and initial failures retry automatically", async () => {
  const daemon = new ReferenceDaemon();
  daemon.append({ type: "user_message", text: "First" }, "t1");
  let failOnce = true;
  const reports: any[] = [];
  const driver: TimelineDriver = {
    fetchAgentTimeline: async (_id, options) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("temporary network error");
      }
      return daemon.fetch(options);
    },
  };
  const view = new TimelineView(driver, "agent", (r) => reports.push(r));
  const store = new TimelineStore();
  const types: string[] = [];
  view.watch((batch) => {
    for (const op of batch) types.push(op.type);
    store.apply(batch);
  });
  view.start();
  await settle();
  assert.deepEqual(types, ["error"]);
  await sleep(2_000);
  assert.deepEqual(types, ["error", "reset"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].failures, 1);
  assert.equal(store.epoch, "e1");

  // Rewind / daemon epoch change replaces the timeline cleanly.
  daemon.epoch = "e2";
  daemon.rows = [];
  daemon.nextSeq = 1;
  daemon.append({ type: "user_message", text: "Rewound" }, "t2");
  view.wake();
  await settle();
  assert.equal(store.epoch, "e2");
  assert.deepEqual(store.rows.map((r) => r.row.value.item.text), ["Rewound"]);
  await view.dispose();
});

test("window trimming advances resumeFloor so stale browsers get a reset", async () => {
  const { daemon, view, store } = harness();
  for (let i = 0; i < 60; i++) daemon.append({ type: "user_message", text: `m${i}` }, `t${i}`);
  view.start();
  await settle();
  const oldResume = store.resumePoint()!;
  // Push > 600 rows across multiple tail pulls so trimming occurs.
  for (let batch = 0; batch < 12; batch++) {
    for (let i = 0; i < 55; i++) daemon.append({ type: "user_message", text: `b${batch}_${i}` }, `tb${batch}_${i}`);
    view.wake();
    await settle();
  }
  const lateOps: TimelineOp[] = [];
  const stopLate = view.watch((ops) => lateOps.push(...ops), oldResume);
  assert.equal(lateOps[0]?.type, "reset");
  stopLate();
  await view.dispose();
});

test("rewind without epoch change and >TAIL_LIMIT gaps trigger clean resets instead of stale rows or holes", async () => {
  const { daemon, view, store, ops } = harness();
  for (let i = 0; i < 5; i++) daemon.append({ type: "user_message", text: `u${i}` }, `t${i}`);
  view.start();
  await settle();
  assert.equal(store.rows.length, 5);

  // Rewind trims the last 2 rows while keeping the same epoch.
  ops.length = 0;
  daemon.rows = daemon.rows.slice(0, 3);
  view.wake();
  await settle();
  assert.equal(ops[0]?.type, "reset");
  assert.deepEqual(store.rows.map((r) => r.row.value.item.text), ["u0", "u1", "u2"]);

  // A burst of >60 rows arrives while idle (gap > TAIL_LIMIT): resets cleanly instead of creating a hole.
  ops.length = 0;
  for (let i = 0; i < 80; i++) daemon.append({ type: "user_message", text: `burst${i}` }, `b${i}`);
  view.wake();
  await settle();
  assert.equal(ops[0]?.type, "reset");
  assert.equal(store.rows.length, 60);
  assert.equal(store.rows[0]!.row.value.item.text, "burst20");
  assert.equal(store.rows.at(-1)!.row.value.item.text, "burst79");
  await view.dispose();
});

test("in-flight pull preserves pendingSettle on turn end, and wake(true) fast-bursts then stops cleanly", async () => {
  const daemon = new ReferenceDaemon();
  daemon.append({ type: "user_message", text: "Go" }, "t1");
  daemon.append({ type: "assistant_message", text: "Working" }, "t1");
  let releaseInflight: (() => void) | null = null;
  let fetchCount = 0;
  const driver: TimelineDriver = {
    fetchAgentTimeline: async (_id, options) => {
      fetchCount++;
      if (fetchCount === 2) await new Promise<void>((r) => (releaseInflight = r));
      return daemon.fetch(options);
    },
  };
  const view = new TimelineView(driver, "agent");
  const store = new TimelineStore();
  view.watch((batch) => store.apply(batch));
  view.setActive(true);
  view.start();
  await settle();
  assert.equal(fetchCount, 1);

  // Start second pull (in-flight), then turn ends before it finishes.
  await sleep(1_500);
  assert.equal(fetchCount, 2);
  view.setActive(false);
  daemon.append({ type: "assistant_message", text: " done" }, "t1");
  releaseInflight!();
  await settle();
  // Pending pull ran right after; daemon attaches turnMetrics just before settle timer fires.
  const metrics: AgentMetric[] = [{ label: "Speed", value: "~30 tok/s" }];
  daemon.attachTurnMetrics(2, metrics);
  await sleep(700);
  assert.deepEqual(store.rows[1]!.row.value.turnMetrics, metrics);

  // Fast burst while active: user submits a prompt and agent flips running before the daemon writes it.
  // The fast burst picks up the new row at 300 ms (not 1500 ms), then drops back to 1500 ms cadence.
  view.setActive(true);
  await settle();
  view.wake(true);
  await settle();
  daemon.append({ type: "user_message", text: "Fast prompt" }, "t2");
  await sleep(300);
  assert.equal(store.rows.at(-1)!.row.value.item.text, "Fast prompt");
  const afterFastHit = fetchCount;
  // Exited fast burst early: no pull 300 ms later, next steady pull is at 1500 ms.
  await sleep(600);
  assert.equal(fetchCount, afterFastHit, "fast burst exits immediately once new rows land");
  await sleep(900);
  assert.equal(fetchCount, afterFastHit + 1, "resumes steady 1500 ms cadence while active");

  // wake(true) while idle bursts up to 6 fast follow-ups (300 ms each), then stops completely with zero leaks.
  view.setActive(false);
  await settle();
  const beforeIdleWake = fetchCount;
  view.wake(true);
  await settle();
  assert.equal(fetchCount, beforeIdleWake + 1);
  for (let i = 0; i < 6; i++) await sleep(300);
  assert.equal(fetchCount, beforeIdleWake + 7, "burst ran 6 bounded follow-up checks");
  await sleep(10_000);
  assert.equal(fetchCount, beforeIdleWake + 7, "no polling leaks after fast burst expires");
  await view.dispose();
});

test("wedged remote fetch times out cleanly without locking inFlight, and stale resume triggers background verify", async () => {
  const daemon = new ReferenceDaemon();
  daemon.append({ type: "user_message", text: "Hello" }, "t1");
  let wedgeFirst = true;
  const driver: TimelineDriver = {
    fetchAgentTimeline: async (_id, options) => {
      if (wedgeFirst) {
        wedgeFirst = false;
        return new Promise(() => {}); // hangs forever
      }
      return daemon.fetch(options);
    },
  };
  const view = new TimelineView(driver, "agent");
  const store = new TimelineStore();
  const stop = view.watch((ops) => store.apply(ops));
  view.start();
  await settle();
  // 20s timeout frees inFlight and marks failed, 2s later retry succeeds.
  await sleep(20_000);
  assert.equal(view.status, "failed");
  await sleep(2_000);
  assert.equal(view.status, "live");
  assert.equal(store.rows.length, 1);

  // Mobile sleeps for > 5s; meanwhile another client adds a reply and misses notification.
  const resume = store.resumePoint()!;
  stop();
  daemon.append({ type: "assistant_message", text: "While phone slept" }, "t1");
  // Simulate > 5s passing before phone wakes and resumes.
  const baseNow = performance.now();
  const restoreNow = mock.method(performance, "now", () => baseNow + 10_000);
  try {
    const stop2 = view.watch((ops) => store.apply(ops), resume);
    await settle();
    assert.deepEqual(store.rows.map((r) => r.row.value.item.text), ["Hello", "While phone slept"]);
    stop2();
  } finally {
    restoreNow.mock.restore();
  }
  await view.dispose();
});

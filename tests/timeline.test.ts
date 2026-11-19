import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mergeToolCallItems, TimelineView, type TimelineDriver } from "../src/server/timeline-view.ts";
import { TimelineStore } from "../src/web/timeline-store.ts";
import type { TimelineItem, TimelineOp, TimelineRow } from "../src/shared/wire.ts";

// The view batches on timers (500 ms flushes). The clock is simulated: `sleep` lets pending
// async work settle, then advances time, so the suite does not wait in real time.
mock.timers.enable({ apis: ["setTimeout"] });
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const sleep = async (ms: number) => {
  await settle();
  mock.timers.tick(ms);
  await settle();
};

/** Independent model of the daemon's live TimelineProjection (append + tail/after/before reads). */
class ReferenceDaemon {
  epoch = "e1";
  rows: (TimelineRow & { sources: number[] })[] = [];
  identities = new Map<string, number>();
  nextSeq = 1;
  fetches: Record<string, unknown>[] = [];

  append(item: TimelineItem, turnId?: string) {
    const seq = this.nextSeq++;
    const entry = { seqStart: seq, seqEnd: seq, timestamp: "t" + seq, provider: "codex", item, sources: [seq], ...(turnId ? { turnId } : {}) };
    const id = item.type === "tool_call" ? (item.callId as string) : item.type === "plugin" ? `${item.pluginId}/${item.id}` : null;
    const index = id === null ? undefined : this.identities.get(id);
    const existing = index === undefined ? undefined : this.rows[index];
    if (existing && item.type === "tool_call" && existing.item.type === "tool_call" && existing.turnId === turnId) {
      existing.item = mergeToolCallItems(existing.item, item);
      existing.timestamp = entry.timestamp;
      existing.seqEnd = Math.max(existing.seqEnd, seq);
      existing.sources.push(seq);
      return seq;
    }
    if (existing && item.type === "plugin" && existing.item.type === "plugin") {
      Object.assign(existing, { ...entry, seqStart: existing.seqStart, sources: [...existing.sources, seq] });
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
      prev.sources.push(seq);
      return seq;
    }
    if (id !== null) this.identities.set(id, this.rows.length);
    this.rows.push(entry);
    return seq;
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
    if (options.cursor.epoch !== this.epoch) {
      const start = Math.max(0, this.rows.length - 60);
      return this.page(this.rows.slice(start), { reset: true, hasOlder: start > 0, startCursor: null });
    }
    if (options.direction === "after")
      return this.page(
        this.rows.filter((r) => r.sources.some((s) => s > options.cursor.seq)),
        { hasOlder: true, startCursor: null },
      );
    const before = this.rows.filter((r) => r.seqStart < options.cursor.seq);
    const start = Math.max(0, before.length - options.limit);
    return this.page(before.slice(start), {
      hasOlder: start > 0,
      startCursor: before[start] ? { epoch: this.epoch, seq: before[start].seqStart } : null,
    });
  }
}

function harness(daemon: ReferenceDaemon) {
  let handler: (message: any) => void = () => {};
  const driver: TimelineDriver = {
    subscribeAgentTimeline: (_id, h) => {
      handler = h;
      return Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} });
    },
    fetchAgentTimeline: async (_id, options) => {
      if (options.direction === "tail") assert.equal(options.wholeTurns, false, "initial load must not expand an unbounded turn");
      await null;
      return daemon.fetch(options);
    },
  };
  const view = new TimelineView(driver, "agent");
  const store = new TimelineStore();
  const received: TimelineOp[][] = [];
  const unwatch = view.watch((ops) => {
    received.push(ops);
    store.apply(structuredClone(ops));
  });
  view.start();
  const emit = (seq: number, epoch = daemon.epoch) => {
    const row = daemon.rows.find((r) => r.sources.includes(seq))!;
    // Reconstruct the source event: the delta for text rows, the full item otherwise.
    handler({ type: "agent_stream", payload: events.get(seq)!(epoch) });
    void row;
  };
  const events = new Map<number, (epoch: string) => unknown>();
  const append = (item: TimelineItem, turnId?: string) => {
    const seq = daemon.append(item, turnId);
    events.set(seq, (epoch) => ({
      agentId: "agent",
      event: { type: "timeline", provider: "codex", item, ...(turnId ? { turnId } : {}) },
      timestamp: "t" + seq,
      seq,
      epoch,
    }));
    return seq;
  };
  return { view, store, received, emit, append, unwatch, send: (m: unknown) => handler(m) };
}

const visible = (store: TimelineStore) => store.rows.map((r) => r.row.value);
const expected = (daemon: ReferenceDaemon, from: number) =>
  daemon.rows.filter((r) => r.seqStart >= from).map(({ sources, ...row }) => row);

test("live text streaming reaches the browser as one coalesced append per flush", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  h.append({ type: "user_message", text: "hi" }, "t1");
  await sleep(550);
  assert.equal(h.received.at(-1)![0].type, "reset");
  const before = h.received.length;
  h.emit(h.append({ type: "assistant_message", text: "Hel", messageId: "m" }, "t1"));
  await sleep(90);
  assert.equal(h.received.length, before, "body updates wait for the 500 ms batch instead of flushing at 50 ms");
  await sleep(460);
  for (const text of ["lo", " wor", "ld"]) h.emit(h.append({ type: "assistant_message", text }, "t1"));
  await sleep(550);
  const last = h.received.at(-1)!;
  assert.deepEqual(last.map((op) => op.type), ["append"]);
  assert.equal((last[0] as any).text, "lo world");
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  assert.equal(daemon.fetches.length, 1, "pure streaming needs no daemon reads");
  h.view.dispose();
});

test("tool lifecycle updates replace their row; gaps recover with an incremental read", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  await sleep(550);
  h.emit(h.append({ type: "tool_call", callId: "c1", status: "running", detail: { type: "unknown" } } as any, "t1"));
  h.emit(h.append({ type: "assistant_message", text: "working" }, "t1"));
  h.emit(h.append({ type: "tool_call", callId: "c1", status: "completed", detail: { type: "shell", command: "ls" } } as any, "t1"));
  await sleep(550);
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  // Drop two events: the next one exposes the gap.
  h.append({ type: "assistant_message", text: " more" }, "t1");
  h.append({ type: "user_message", text: "next" }, "t2");
  h.emit(h.append({ type: "assistant_message", text: "ok" }, "t2"));
  await sleep(550);
  assert.equal((daemon.fetches.at(-1) as any).direction, "after");
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  h.view.dispose();
});

test("a late watcher gets a bounded reset; epoch replacement reloads the tail", async () => {
  const daemon = new ReferenceDaemon();
  for (let i = 0; i < 300; i++) daemon.append({ type: "user_message", text: "m" + i }, "t" + i);
  const h = harness(daemon);
  await sleep(550);
  const reset = h.received[0][0] as Extract<TimelineOp, { type: "reset" }>;
  assert.equal(reset.rows.length, 60, "first load reads only the tail");
  assert.equal(reset.hasOlder, true);
  const late = new TimelineStore();
  h.view.watch((ops) => late.apply(structuredClone(ops)));
  assert.deepEqual(visible(late), visible(h.store));
  daemon.epoch = "e2";
  daemon.rows = [];
  daemon.identities.clear();
  daemon.nextSeq = 1;
  h.append({ type: "user_message", text: "fresh" });
  h.send({ type: "agent.timeline.replacement", payload: { agentId: "agent", epoch: "e2" } });
  await sleep(550);
  assert.equal(h.store.epoch, "e2");
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  h.view.dispose();
});

test("a returning browser resumes with only the rows that changed; otherwise it gets a reset", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  h.emit(h.append({ type: "user_message", text: "hi" }, "t1"));
  h.emit(h.append({ type: "tool_call", callId: "c1", status: "running", detail: { type: "unknown" } } as any, "t1"));
  h.emit(h.append({ type: "assistant_message", text: "Working", messageId: "m" }, "t1"));
  await sleep(550);
  // Another browser opens the conversation, then leaves (a cached view, or a hidden tab).
  const away = new TimelineStore();
  const leave = h.view.watch((ops) => away.apply(structuredClone(ops)));
  assert.deepEqual(visible(away), visible(h.store));
  const point = away.resumePoint()!;
  assert.equal(point.seq, daemon.nextSeq - 1, "the reset says how far it reaches");
  leave();
  // Meanwhile: text streams on, the tool call finishes, a new turn starts.
  h.emit(h.append({ type: "assistant_message", text: " hard" }, "t1"));
  h.emit(h.append({ type: "tool_call", callId: "c1", status: "completed", detail: { type: "shell", command: "ls" } } as any, "t1"));
  h.emit(h.append({ type: "user_message", text: "next" }, "t2"));
  await sleep(550);
  const resumed: TimelineOp[][] = [];
  const back = h.view.watch((ops) => {
    resumed.push(ops);
    away.apply(structuredClone(ops));
  }, point);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0].map((op) => op.type), ["upsert", "upsert", "upsert"], "only the changed rows");
  assert.deepEqual(resumed[0].map((op) => (op as any).row.seqStart), [2, 3, 6]);
  assert.deepEqual(visible(away), visible(h.store), "the returning browser holds exactly what a watching one does");
  back();
  // Nothing changed since: nothing to send.
  const quiet: TimelineOp[][] = [];
  h.view.watch((ops) => quiet.push(ops), away.resumePoint()!)();
  assert.deepEqual(quiet, []);
  // Another epoch, or a point the view cannot resume from: a reset, as before.
  const other: TimelineOp[][] = [];
  h.view.watch((ops) => other.push(ops), { ...point, epoch: "e0" })();
  h.view.watch((ops) => other.push(ops), { ...point, seq: 0 })();
  assert.deepEqual(other.map((ops) => ops[0].type), ["reset", "reset"]);
  h.view.dispose();
});

test("a view nobody watches keeps no pending changes, and whoever comes back sees them all", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  h.emit(h.append({ type: "assistant_message", text: "a", messageId: "m" }, "t1"));
  await sleep(550);
  const point = h.store.resumePoint()!;
  h.unwatch();
  for (let i = 0; i < 50; i++) h.emit(h.append({ type: "assistant_message", text: " " + i }, "t1"));
  h.emit(h.append({ type: "tool_call", callId: "c", status: "running", detail: { type: "unknown" } } as any, "t1"));
  await sleep(550);
  assert.equal((h.view as any).pending.size, 0, "an unwatched view accumulates nothing to send");
  const later = new TimelineStore();
  later.apply(structuredClone([{ type: "reset", epoch: point.epoch, rows: visible(h.store), hasOlder: false, startCursor: null, seq: point.seq }] as TimelineOp[]));
  h.view.watch((ops) => later.apply(structuredClone(ops)), point);
  assert.deepEqual(visible(later), expected(daemon, 1));
  h.view.dispose();
});

test("a view that trimmed rows a browser still lacks changes for sends a reset", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  await sleep(550); // loaded: what follows arrives live
  h.emit(h.append({ type: "tool_call", callId: "old", status: "running", detail: { type: "unknown" } } as any, "t0"));
  for (let i = 0; i < 598; i++) h.emit(h.append({ type: "user_message", text: "m" + i }, "t" + i));
  await sleep(550);
  const point = h.store.resumePoint()!;
  // The old call changes, then a few rows arrive: just enough that the view drops the call.
  h.emit(h.append({ type: "tool_call", callId: "old", status: "completed", detail: { type: "unknown" } } as any, "t0"));
  for (let i = 0; i < 5; i++) h.emit(h.append({ type: "user_message", text: "n" + i }, "n" + i));
  await sleep(550);
  assert.equal(h.store.rows.length, 604, "the watching browser still holds every row");
  assert.ok(!(h.view as any).bySeqStart.has(1), "the view dropped the old call");
  const ops: TimelineOp[][] = [];
  h.view.watch((o) => ops.push(o), point)();
  assert.equal(ops[0][0].type, "reset");
  h.view.dispose();
});

test("randomized: dropped events and reconnects converge to the daemon projection", async () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let totalResumes = 0;
  for (let run = 0; run < 25; run++) {
    const daemon = new ReferenceDaemon();
    const callIds: string[] = [];
    for (let i = 0; i < 80; i++) {
      daemon.append({ type: "user_message", text: "old" + i }, "o" + i);
      if (i % 10 === 0) {
        // Calls older than the loaded tail: their later updates must still land on the right row.
        daemon.append({ type: "tool_call", callId: "old" + i, status: "running", detail: { type: "unknown" } } as any, "o" + i);
        callIds.push("old" + i);
      }
    }
    const h = harness(daemon);
    await sleep(60);
    // A second browser that leaves and comes back, resuming from what it holds.
    const roamer = new TimelineStore();
    let roaming: (() => void) | null = h.view.watch((ops) => roamer.apply(structuredClone(ops)));
    let resumes = 0;
    let turn = 0;
    for (let step = 0; step < 300; step++) {
      const r = random();
      let seq: number;
      if (r < 0.05) {
        turn++;
        seq = h.append({ type: "user_message", text: "u" + step }, "t" + turn);
      } else if (r < 0.45) {
        seq = h.append(
          { type: "assistant_message", text: "a" + step, ...(random() < 0.1 ? { messageId: "m" + step } : {}) },
          "t" + turn,
        );
      } else if (r < 0.6) seq = h.append({ type: "reasoning", text: "r" + step }, "t" + turn);
      else if (r < 0.75 || !callIds.length) {
        const callId = "c" + step;
        callIds.push(callId);
        seq = h.append({ type: "tool_call", callId, status: "running", detail: { type: "unknown" } } as any, "t" + turn);
      } else if (r < 0.95) {
        // Update an existing call, sometimes from an older turn (outside the loaded tail).
        const callId = callIds[Math.floor(random() * callIds.length)];
        const old = callId.startsWith("old");
        seq = h.append(
          { type: "tool_call", callId, status: random() < 0.5 ? "completed" : "running", detail: { type: "shell", step } } as any,
          old ? "o" + callId.slice(3) : "t" + turn,
        );
      } else seq = h.append({ type: "plugin", pluginId: "p", id: "card", n: step } as any, "t" + turn);
      const roll = random();
      if (roll < 0.9) h.emit(seq);
      else if (roll < 0.93) h.send({ type: "agent.timeline.subscription_restored", payload: { agentId: "agent" } });
      // else: dropped event
      if (random() < 0.05) await sleep(0);
      if (random() < 0.04) {
        if (roaming) {
          roaming();
          roaming = null;
        } else {
          const point = roamer.resumePoint() ?? undefined;
          if (point) resumes++;
          roaming = h.view.watch((ops) => roamer.apply(structuredClone(ops)), point);
        }
      }
    }
    roaming ??= h.view.watch((ops) => roamer.apply(structuredClone(ops)), roamer.resumePoint() ?? undefined);
    // A final event lets the view notice any trailing gap.
    h.emit(h.append({ type: "user_message", text: "end" }, "end"));
    await sleep(550);
    const rows = visible(h.store);
    assert.ok(rows.length > 0);
    const bySeq = new Map(daemon.rows.map(({ sources, ...row }) => [row.seqStart, row]));
    for (const row of rows) assert.deepEqual(row, bySeq.get(row.seqStart), `run ${run} seq ${row.seqStart}`);
    // Rows before the loaded window may appear when an old tool call updates; from the
    // window start on, the browser must hold exactly the daemon's rows.
    const reset = h.received.flat().filter((op) => op.type === "reset").at(-1) as any;
    const windowStart = reset.rows[0].seqStart;
    assert.deepEqual(
      rows.filter((r) => r.seqStart >= windowStart).map((r) => r.seqStart),
      expected(daemon, windowStart).map((r) => r.seqStart),
      `run ${run}`,
    );
    // The browser that came and went holds the same rows, with no gaps from where it started.
    const roamed = visible(roamer);
    for (const row of roamed) assert.deepEqual(row, bySeq.get(row.seqStart), `run ${run} roamer seq ${row.seqStart}`);
    const roamStart = roamer.resumePoint()!.from;
    assert.deepEqual(
      roamed.filter((r) => r.seqStart >= windowStart && r.seqStart >= roamStart).map((r) => r.seqStart),
      expected(daemon, Math.max(windowStart, roamStart)).map((r) => r.seqStart),
      `run ${run} roamer (${resumes} resumes)`,
    );
    totalResumes += resumes;
    roaming();
    h.view.dispose();
  }
  assert.ok(totalResumes > 20, "the randomized runs resume often: " + totalResumes);
});

test("a conversation's first rows go out at once, and slow opens report which layer waited", async () => {
  let clock = 0;
  const restore = mock.method(performance, "now", () => clock);
  const daemon = new ReferenceDaemon();
  daemon.append({ type: "user_message", text: "hi" }, "t1");
  let failSubscribe = true;
  const driver: TimelineDriver = {
    subscribeAgentTimeline: () => {
      const ready = failSubscribe
        ? new Promise<void>((_, reject) => setTimeout(() => { clock += 4000; reject(new Error("host offline")); }, 10))
        : new Promise<void>((resolve) => setTimeout(() => { clock += 300; resolve(); }, 10));
      failSubscribe = false;
      return Object.assign(() => {}, { ready, release: async () => {} });
    },
    fetchAgentTimeline: async (_id, options) => {
      await new Promise((r) => setTimeout(r, 10));
      clock += 1200;
      return daemon.fetch(options);
    },
  };
  const reports: unknown[] = [];
  const view = new TimelineView(driver, "agent", (report) => reports.push(report));
  const first: TimelineOp[][] = [], second: TimelineOp[][] = [];
  view.watch((ops) => first.push(ops));
  view.start();
  await sleep(10); // subscription fails after 4 s of host time
  view.watch((ops) => second.push(ops)); // a second viewer joins while it retries
  await sleep(2000); // retry
  await sleep(10); // subscribed
  await sleep(10); // tail read
  // The failed attempt says it is retrying; the rows follow the read without a batch delay.
  assert.deepEqual(first.map((ops) => ops.map((op) => op.type)), [["error"], ["reset"]]);
  assert.deepEqual(second.map((ops) => ops.map((op) => op.type)), [["reset"]]);
  assert.deepEqual(reports, [
    { kind: "view", totalMs: 5500, subscribeMs: 300, fetchMs: 1200, attempts: 2, failures: 1 },
    { kind: "join", totalMs: 1500, subscribeMs: 300, fetchMs: 1200, attempts: 2, failures: 1 },
  ]);
  // Viewers of a loaded view get rows from memory, and there is nothing to report.
  const third: TimelineOp[][] = [];
  view.watch((ops) => third.push(ops));
  assert.equal(third[0][0].type, "reset");
  assert.equal(reports.length, 2);
  view.dispose();
  restore.mock.restore();
});

test("a catch-up page that claims more rows but does not advance falls back to the tail", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  await sleep(550);
  const fetch = daemon.fetch.bind(daemon);
  daemon.fetch = (options: any) => {
    const page = fetch(options);
    // A confused daemon: always "more", never past the cursor.
    return options.direction === "after" ? { ...page, hasNewer: true, endCursor: options.cursor } : page;
  };
  h.append({ type: "user_message", text: "lost" }, "t1");
  h.emit(h.append({ type: "assistant_message", text: "reply" }, "t1"));
  await sleep(550);
  const directions = daemon.fetches.map((f: any) => f.direction);
  assert.deepEqual(directions.slice(-2), ["after", "tail"], "one catch-up page, then the tail, not an endless loop");
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  h.view.dispose();
});

test("a catch-up that touches a row older than the rows held keeps them contiguous", async () => {
  const daemon = new ReferenceDaemon();
  daemon.append({ type: "tool_call", callId: "old", status: "running", detail: { type: "unknown" } } as any, "t0");
  for (let i = 0; i < 80; i++) daemon.append({ type: "user_message", text: "m" + i }, "t" + i);
  const h = harness(daemon);
  await sleep(550);
  const first = h.store.rows[0].seqStart;
  assert.ok(first > 1 && h.store.hasOlder);
  // The old tool call finishes; the event is missed, so a catch-up reads it back.
  h.append({ type: "tool_call", callId: "old", status: "completed", detail: { type: "shell", command: "ls" } } as any, "t0");
  h.emit(h.append({ type: "user_message", text: "next" }, "t9"));
  await sleep(550);
  assert.equal(h.store.rows[0].seqStart, first, "the older row is left to history pages");
  assert.deepEqual(visible(h.store), expected(daemon, first));
  h.view.dispose();
});

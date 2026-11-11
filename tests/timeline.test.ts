import test from "node:test";
import assert from "node:assert/strict";
import { mergeToolCallItems, TimelineView, type TimelineDriver } from "../src/server/timeline-view.ts";
import { TimelineStore } from "../src/web/timeline-store.ts";
import type { TimelineItem, TimelineOp, TimelineRow } from "../src/shared/wire.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      await null;
      return daemon.fetch(options);
    },
  };
  const view = new TimelineView(driver, "agent");
  const store = new TimelineStore();
  const received: TimelineOp[][] = [];
  view.watch((ops) => {
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
  return { view, store, received, emit, append, send: (m: unknown) => handler(m) };
}

const visible = (store: TimelineStore) => store.rows.map((r) => r.row.value);
const expected = (daemon: ReferenceDaemon, from: number) =>
  daemon.rows.filter((r) => r.seqStart >= from).map(({ sources, ...row }) => row);

test("live text streaming reaches the browser as one coalesced append per flush", async () => {
  const daemon = new ReferenceDaemon();
  const h = harness(daemon);
  h.append({ type: "user_message", text: "hi" }, "t1");
  await sleep(70);
  assert.equal(h.received.at(-1)![0].type, "reset");
  h.emit(h.append({ type: "assistant_message", text: "Hel", messageId: "m" }, "t1"));
  await sleep(70);
  for (const text of ["lo", " wor", "ld"]) h.emit(h.append({ type: "assistant_message", text }, "t1"));
  await sleep(70);
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
  await sleep(70);
  h.emit(h.append({ type: "tool_call", callId: "c1", status: "running", detail: { type: "unknown" } } as any, "t1"));
  h.emit(h.append({ type: "assistant_message", text: "working" }, "t1"));
  h.emit(h.append({ type: "tool_call", callId: "c1", status: "completed", detail: { type: "shell", command: "ls" } } as any, "t1"));
  await sleep(70);
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  // Drop two events: the next one exposes the gap.
  h.append({ type: "assistant_message", text: " more" }, "t1");
  h.append({ type: "user_message", text: "next" }, "t2");
  h.emit(h.append({ type: "assistant_message", text: "ok" }, "t2"));
  await sleep(70);
  assert.equal((daemon.fetches.at(-1) as any).direction, "after");
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  h.view.dispose();
});

test("a late watcher gets a bounded reset; epoch replacement reloads the tail", async () => {
  const daemon = new ReferenceDaemon();
  for (let i = 0; i < 300; i++) daemon.append({ type: "user_message", text: "m" + i }, "t" + i);
  const h = harness(daemon);
  await sleep(70);
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
  await sleep(70);
  assert.equal(h.store.epoch, "e2");
  assert.deepEqual(visible(h.store), expected(daemon, 1));
  h.view.dispose();
});

test("randomized: dropped events and reconnects converge to the daemon projection", async () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
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
    }
    // A final event lets the view notice any trailing gap.
    h.emit(h.append({ type: "user_message", text: "end" }, "end"));
    await sleep(80);
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
    h.view.dispose();
  }
});

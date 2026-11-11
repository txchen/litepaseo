import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import type { TimelineCursor, TimelineItem, TimelineOp, TimelineRow } from "../shared/wire.ts";

interface FetchedEntry {
  provider: string;
  item: TimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
}
interface TimelinePayload {
  epoch: string;
  reset: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  entries: FetchedEntry[];
}
interface StreamPayload {
  agentId: string;
  event: { type: string; provider?: string; item?: TimelineItem; turnId?: string };
  timestamp: string;
  seq?: number;
  epoch?: string;
}
type TimelineMessage = { type: string; payload?: unknown };

export interface TimelineDriver {
  subscribeAgentTimeline(
    agentId: string,
    handler: (message: TimelineMessage) => void,
  ): (() => void) & { ready: Promise<void>; release(): Promise<void> };
  fetchAgentTimeline(agentId: string, options: Record<string, unknown>): Promise<TimelinePayload>;
}

const TAIL_LIMIT = 60;
const CATCH_UP_PAGE = 200;
/** Rows kept per view; older rows are dropped and stay reachable through history pages. */
const MAX_ROWS = 600;
const KEEP_ROWS = 500;
/** Rows sent to a client that (re)joins; older ones load on demand. */
const RESET_ROWS = 200;
const MAX_BUFFER = 5000;
const FLUSH_MS = 50;
const RETRY_MS = 2000;

type Watcher = (ops: TimelineOp[]) => void;

/** Same fold the daemon's TimelineProjection applies when a tool call reports again. */
export function mergeToolCallItems(existing: TimelineItem, incoming: TimelineItem): TimelineItem {
  const a = existing.detail as { type?: string } | undefined,
    b = incoming.detail as { type?: string } | undefined;
  const detail = a?.type === "unknown" && b?.type !== "unknown" ? b : b?.type === "unknown" && a?.type !== "unknown" ? a : b;
  const metadata =
    existing.metadata || incoming.metadata
      ? { ...(existing.metadata as object), ...(incoming.metadata as object) }
      : undefined;
  const merged: TimelineItem = { ...existing, ...incoming, detail, metadata };
  if (incoming.status === "failed") merged.error = incoming.error;
  else if (incoming.status === "completed" || incoming.status === "canceled") merged.error = null;
  else if (incoming.error !== undefined) merged.error = incoming.error;
  return merged;
}

function textMergeable(previous: TimelineRow, entry: TimelineRow) {
  const a = previous.item,
    b = entry.item;
  if (a.type !== b.type || previous.seqEnd + 1 !== entry.seqStart || previous.turnId !== entry.turnId)
    return false;
  if (a.type === "reasoning") return true;
  return a.type === "assistant_message" && (b.messageId === undefined || a.messageId === b.messageId);
}

/**
 * Live projection of one agent's timeline, shared by every browser viewing it. Daemon stream
 * events are folded with the daemon's own projection rules, so each event costs O(1) work and
 * reaches browsers as a small upsert/append op. Gaps, unknown identities and reconnects fall
 * back to an incremental `after` fetch, which returns only rows touched since the cursor.
 */
export class TimelineView {
  private rows: TimelineRow[] = [];
  private readonly bySeqStart = new Map<number, TimelineRow>();
  private readonly identities = new Map<string, TimelineRow>();
  private epoch = "";
  private lastSeq = -1;
  private hasOlder = false;
  private startCursor: TimelineCursor | null = null;
  /** True while rows reach back to the first projected row, so unseen identities are new. */
  private complete = false;
  private state: "loading" | "live" | "catching-up" | "failed" | "disposed" = "loading";
  private buffer: StreamPayload[] = [];
  private overflowed = false;
  private readonly watchers = new Set<Watcher>();
  /** seqStart → pending change since the last flush; full means send the whole row. */
  private pending = new Map<number, { full: boolean; text: string }>();
  private pendingReset = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private subscription: { release(): Promise<void> } | null = null;
  private token = 0;
  private loads = 0;

  private readonly driver: TimelineDriver;
  private readonly agentId: string;

  constructor(driver: TimelineDriver, agentId: string) {
    this.driver = driver;
    this.agentId = agentId;
  }

  get watcherCount() {
    return this.watchers.size;
  }

  start() {
    const token = ++this.token;
    this.state = "loading";
    const subscription = this.driver.subscribeAgentTimeline(this.agentId, (message) => {
      if (token === this.token) this.onMessage(message);
    });
    this.subscription = subscription;
    subscription.ready.then(
      () => (token === this.token ? this.reload() : undefined),
      () => this.fail(token),
    );
  }

  dispose() {
    this.token++;
    this.state = "disposed";
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.watchers.clear();
    const released = this.subscription?.release().catch(() => {}) ?? Promise.resolve();
    this.subscription = null;
    return released;
  }

  watch(watcher: Watcher) {
    if (this.state === "live" || this.state === "catching-up") {
      // Deliver what existing watchers are owed first; the newcomer starts from the reset.
      this.flush();
      watcher([this.resetOp()]);
    }
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  // ---- daemon input -------------------------------------------------------------------------

  private onMessage(message: TimelineMessage) {
    switch (message.type) {
      case "agent_stream": {
        const payload = message.payload as StreamPayload;
        if (payload.event.type !== "timeline" || payload.seq === undefined) return;
        if (this.state !== "live") return this.bufferEvent(payload);
        return this.process(payload);
      }
      case "agent.timeline.replacement":
        return void this.reload();
      case "agent.timeline.subscription_restored":
        return void (this.state === "live" ? this.catchUp() : undefined);
      case "agent.timeline.error":
        return this.fail(this.token);
    }
  }

  private bufferEvent(payload: StreamPayload) {
    if (this.overflowed) return;
    if (this.buffer.length >= MAX_BUFFER) {
      // Too far behind to replay event by event; the next settle reloads the tail instead.
      this.buffer = [];
      this.overflowed = true;
      return;
    }
    this.buffer.push(payload);
  }

  private process(payload: StreamPayload) {
    const seq = payload.seq!;
    if (payload.epoch !== undefined && payload.epoch !== this.epoch) return void this.reload();
    if (seq <= this.lastSeq) return;
    if (seq > this.lastSeq + 1) {
      this.bufferEvent(payload);
      return void this.catchUp();
    }
    if (!this.applyLive(payload)) return void this.catchUp();
    this.lastSeq = seq;
  }

  /** Folds one source event; false when the view cannot decide locally. */
  private applyLive(payload: StreamPayload) {
    const entry: TimelineRow = {
      seqStart: payload.seq!,
      seqEnd: payload.seq!,
      timestamp: payload.timestamp,
      provider: payload.event.provider ?? "",
      ...(payload.event.turnId ? { turnId: payload.event.turnId } : {}),
      item: payload.event.item!,
    };
    const identity = timelineItemIdentity(entry.item as never);
    if (identity !== null) {
      const existing = this.identities.get(identity);
      if (existing) {
        if (entry.item.type === "tool_call") {
          if (existing.item.type === "tool_call" && existing.turnId === entry.turnId) {
            existing.item = mergeToolCallItems(existing.item, entry.item);
            existing.timestamp = entry.timestamp;
            existing.seqEnd = Math.max(existing.seqEnd, entry.seqEnd);
            this.mark(existing.seqStart, true);
            return true;
          }
        } else if (entry.item.type === "plugin" && existing.item.type === "plugin") {
          Object.assign(existing, { ...entry, seqStart: existing.seqStart });
          this.mark(existing.seqStart, true);
          return true;
        }
      } else if (!this.complete) return false;
    }
    const previous = this.rows.at(-1);
    if (previous && textMergeable(previous, entry)) {
      const text = entry.item.text ?? "";
      previous.item = {
        type: previous.item.type,
        text: (previous.item.text ?? "") + text,
        ...(previous.item.type === "assistant_message" && previous.item.messageId
          ? { messageId: previous.item.messageId }
          : {}),
      };
      previous.timestamp = entry.timestamp;
      previous.seqEnd = entry.seqEnd;
      this.mark(previous.seqStart, false, text);
      return true;
    }
    this.insert(entry);
    return true;
  }

  // ---- authoritative reads ------------------------------------------------------------------

  private async reload() {
    const token = this.token;
    const load = ++this.loads;
    this.state = "loading";
    try {
      const page = await this.driver.fetchAgentTimeline(this.agentId, {
        direction: "tail",
        limit: TAIL_LIMIT,
        projection: "projected",
        wholeTurns: true,
      });
      if (token !== this.token || load !== this.loads) return;
      this.replaceWith(page);
      this.settle();
    } catch {
      this.fail(token);
    }
  }

  private async catchUp() {
    if (this.state === "catching-up" || this.state === "loading") return;
    const token = this.token;
    this.state = "catching-up";
    try {
      for (;;) {
        const page = await this.driver.fetchAgentTimeline(this.agentId, {
          direction: "after",
          cursor: { epoch: this.epoch, seq: Math.max(0, this.lastSeq) },
          limit: CATCH_UP_PAGE,
          projection: "projected",
        });
        if (token !== this.token) return;
        if (page.reset || page.epoch !== this.epoch) {
          this.replaceWith(page);
          break;
        }
        for (const entry of page.entries) this.upsertFetched(entry);
        const end = page.endCursor?.seq ?? (page.hasNewer ? null : page.window.maxSeq);
        if (end === null) break;
        this.lastSeq = Math.max(this.lastSeq, end);
        if (!page.hasNewer) break;
      }
      this.settle();
    } catch {
      this.fail(token);
    }
  }

  /** Back to live: replay what arrived meanwhile, or reload if the buffer overflowed. */
  private settle() {
    if (this.overflowed) {
      this.overflowed = false;
      this.buffer = [];
      return void this.reload();
    }
    this.state = "live";
    const events = this.buffer;
    this.buffer = [];
    for (let i = 0; i < events.length; i++) {
      if (this.state !== "live") {
        this.buffer = events.slice(i).concat(this.buffer);
        return;
      }
      this.process(events[i]);
    }
  }

  private fail(token: number) {
    if (token !== this.token || this.state === "disposed") return;
    this.state = "failed";
    this.broadcast([{ type: "error", message: "Timeline sync interrupted; retrying" }]);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.state !== "failed" || token !== this.token) return;
      void this.subscription?.release().catch(() => {});
      this.start();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  private replaceWith(page: TimelinePayload) {
    this.rows = [];
    this.bySeqStart.clear();
    this.identities.clear();
    this.pending.clear();
    this.epoch = page.epoch;
    this.lastSeq = page.window.maxSeq;
    this.hasOlder = page.hasOlder;
    this.startCursor = page.startCursor;
    this.complete = !page.hasOlder;
    for (const entry of page.entries) this.upsertFetched(entry, false);
    this.buffer = this.buffer.filter((e) => e.epoch === this.epoch && e.seq! > this.lastSeq);
    this.pending.clear();
    this.pendingReset = true;
    this.scheduleFlush();
  }

  private upsertFetched(entry: FetchedEntry, notify = true) {
    const row: TimelineRow = {
      seqStart: entry.seqStart,
      seqEnd: entry.seqEnd,
      timestamp: entry.timestamp,
      provider: entry.provider,
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
      item: entry.item,
    };
    const existing = this.bySeqStart.get(row.seqStart);
    if (existing) {
      Object.assign(existing, row);
      if (!row.turnId) delete existing.turnId;
      this.noteIdentity(existing);
      if (notify) this.mark(existing.seqStart, true);
      return;
    }
    this.insert(row, notify);
  }

  private insert(row: TimelineRow, notify = true) {
    // Rows arrive in seqStart order almost always; binary search covers catch-up inserts.
    let index = this.rows.length;
    if (index && this.rows[index - 1].seqStart > row.seqStart) {
      let low = 0,
        high = index;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.rows[middle].seqStart < row.seqStart) low = middle + 1;
        else high = middle;
      }
      index = low;
    }
    if (index === this.rows.length) this.rows.push(row);
    else this.rows.splice(index, 0, row);
    this.bySeqStart.set(row.seqStart, row);
    this.noteIdentity(row);
    if (notify) this.mark(row.seqStart, true);
    if (this.rows.length > MAX_ROWS) this.trim();
  }

  /** Like the daemon, an identity resolves to its most recent row. */
  private noteIdentity(row: TimelineRow) {
    const identity = timelineItemIdentity(row.item as never);
    if (identity === null) return;
    const current = this.identities.get(identity);
    if (!current || current.seqStart <= row.seqStart) this.identities.set(identity, row);
  }

  private trim() {
    const removed = this.rows.splice(0, this.rows.length - KEEP_ROWS);
    for (const row of removed) {
      this.bySeqStart.delete(row.seqStart);
      this.pending.delete(row.seqStart);
      const identity = timelineItemIdentity(row.item as never);
      if (identity !== null && this.identities.get(identity) === row) this.identities.delete(identity);
    }
    this.complete = false;
    this.hasOlder = true;
    this.startCursor = { epoch: this.epoch, seq: this.rows[0].seqStart };
  }

  // ---- browser output -----------------------------------------------------------------------

  private mark(seqStart: number, full: boolean, text = "") {
    if (this.pendingReset) return;
    const pending = this.pending.get(seqStart);
    if (!pending) this.pending.set(seqStart, { full, text: full ? "" : text });
    else if (full) {
      pending.full = true;
      pending.text = "";
    } else if (!pending.full) pending.text += text;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer || !this.watchers.size) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pendingReset) {
      this.pendingReset = false;
      this.pending.clear();
      return this.broadcast([this.resetOp()]);
    }
    if (!this.pending.size) return;
    const ops: TimelineOp[] = [];
    for (const [seqStart, change] of this.pending) {
      const row = this.bySeqStart.get(seqStart);
      if (!row) continue;
      ops.push(
        change.full
          ? { type: "upsert", row: { ...row } }
          : { type: "append", seqStart, seqEnd: row.seqEnd, timestamp: row.timestamp, text: change.text },
      );
    }
    this.pending.clear();
    if (ops.length) this.broadcast(ops);
  }

  private resetOp(): TimelineOp {
    const start = Math.max(0, this.rows.length - RESET_ROWS);
    const rows = this.rows.slice(start).map((row) => ({ ...row }));
    return {
      type: "reset",
      epoch: this.epoch,
      rows,
      hasOlder: this.hasOlder || start > 0,
      startCursor: start > 0 ? { epoch: this.epoch, seq: rows[0].seqStart } : this.startCursor,
    };
  }

  private broadcast(ops: TimelineOp[]) {
    for (const watcher of this.watchers) watcher(ops);
  }
}

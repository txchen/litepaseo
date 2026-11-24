import { notifyListeners } from "./listeners.ts";
import type { TimelineCursor, TimelineItem, TimelineOp, TimelineRow } from "../shared/wire.ts";

interface FetchedEntry {
  provider: string;
  item: TimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  turnMetrics?: TimelineRow["turnMetrics"];
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

export interface TimelineDriver {
  /** Retained optional on the interface for legacy test doubles; Wake + Pull uses fetchAgentTimeline exclusively. */
  subscribeAgentTimeline?: (
    agentId: string,
    handler: (message: { type: string; payload?: unknown }) => void,
  ) => (() => void) & { ready: Promise<void>; release(): Promise<void> };
  fetchAgentTimeline(agentId: string, options: Record<string, unknown>): Promise<TimelinePayload>;
}

const TAIL_LIMIT = 60;
/** Rows kept per view; older rows stay reachable through on-demand history pages. */
const MAX_ROWS = 600;
const KEEP_ROWS = 500;
/** Rows sent to a client that (re)joins; older ones load on demand. */
const RESET_ROWS = 200;
const MAX_JOINERS = 64;
/** Low-frequency pull interval while an agent is actively running and watched. */
const DEFAULT_POLL_MS = 1500;
/** Short burst interval right after sending a message or rewind so the new row lands quickly. */
const FAST_POLL_MS = 300;
/** Max fast-burst follow-up polls (~1.8 s at 300 ms); exits early as soon as rows change. */
const FAST_BURST_POLLS = 6;
/** Retry delay when the initial load fails. */
const RETRY_MS = 2000;
/** One-shot follow-up delay after a turn ends if turnMetrics have not landed yet. */
const METRICS_SETTLE_MS = 700;
/** Per-pull RPC timeout so a wedged remote host can never lock `inFlight` forever. */
const PULL_TIMEOUT_MS = 20_000;
/** If a browser reconnects/resumes after this much silence, verify once against the daemon. */
const RESUME_VERIFY_MS = 5_000;

/** What a returning browser already holds: rows from `from` on, with every change up to `seq` (view revision). */
export interface TimelineResume {
  epoch: string;
  seq: number;
  from: number;
}

type Watcher = (ops: TimelineOp[]) => void;

export interface TimelineLoadReport {
  totalMs: number;
  subscribeMs: number | null;
  fetchMs: number | null;
  attempts: number;
  failures: number;
  kind: "view" | "join";
}
export type TimelineLoadReporter = (report: TimelineLoadReport) => void;

const now = () => performance.now();

/** Retained for compatibility with existing unit tests. */
export function mergeToolCallItems(existing: TimelineItem, incoming: TimelineItem): TimelineItem {
  const a = existing.detail as { type?: string } | undefined;
  const b = incoming.detail as { type?: string } | undefined;
  const detail =
    a?.type === "unknown" && b?.type !== "unknown"
      ? b
      : b?.type === "unknown" && a?.type !== "unknown"
        ? a
        : b;
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

function toRow(entry: FetchedEntry): TimelineRow {
  return {
    seqStart: entry.seqStart,
    seqEnd: entry.seqEnd,
    timestamp: entry.timestamp,
    provider: entry.provider,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    item: entry.item,
    ...(entry.turnMetrics?.length ? { turnMetrics: entry.turnMetrics } : {}),
  };
}

function rowFingerprint(row: TimelineRow): string {
  return JSON.stringify([row.seqEnd, row.timestamp, row.provider, row.turnId ?? null, row.item, row.turnMetrics ?? null]);
}

/**
 * Single-source-of-truth projected timeline view (Wake + Pull).
 *
 * Every row comes directly from the daemon's `fetchAgentTimeline(..., projection: "projected")`:
 * - Idle conversations do zero polling and use zero timers.
 * - Active (running) conversations pull at a low cadence (1.5 s) while watched and broadcast only
 *   rows whose fingerprint actually changed.
 * - Turning idle triggers a final pull (with one short follow-up if turnMetrics haven't landed),
 *   and every changed row advances a monotonic `revision` so returning tabs resume cleanly with
 *   all updates including `turnMetrics`.
 */
export class TimelineView {
  private rows: TimelineRow[] = [];
  private readonly bySeqStart = new Map<number, TimelineRow>();
  private readonly fingerprints = new Map<number, string>();
  private readonly rowRev = new Map<number, number>();
  private epoch = "";
  private revision = 0;
  private resumeFloor = 0;
  private hasOlder = false;
  private startCursor: TimelineCursor | null = null;
  private state: "idle" | "loading" | "live" | "failed" | "disposed" = "idle";
  private active = false;
  private readonly watchers = new Set<Watcher>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private settleTimer?: ReturnType<typeof setTimeout>;
  private fastPollsLeft = 0;
  private inFlight = false;
  private pendingPull = false;
  private pendingSettle = false;
  private consecutiveFailures = 0;
  private lastPullAt = 0;
  private token = 0;
  private timing: { startedAt: number; fetchMs: number | null; attempts: number; failures: number } | null = null;
  private joiners: number[] = [];

  private readonly driver: TimelineDriver;
  private readonly agentId: string;
  private readonly report?: TimelineLoadReporter;
  private readonly pollMs: number;
  private readonly fastPollMs: number;

  constructor(driver: TimelineDriver, agentId: string, report?: TimelineLoadReporter, pollMs = DEFAULT_POLL_MS) {
    this.driver = driver;
    this.agentId = agentId;
    this.report = report;
    this.pollMs = pollMs;
    this.fastPollMs = Math.min(pollMs, FAST_POLL_MS);
  }

  get watcherCount() {
    return this.watchers.size;
  }
  get status() {
    return this.state;
  }

  start() {
    if (this.state === "disposed" || this.state === "loading" || this.state === "live") return;
    this.state = "loading";
    this.token++;
    this.timing ??= { startedAt: now(), fetchMs: null, attempts: 0, failures: 0 };
    this.timing.attempts++;
    void this.pull(true);
  }

  /** Updates whether this conversation is actively running; drives low-frequency pulling. */
  setActive(running: boolean) {
    if (this.state === "disposed") return;
    const wasActive = this.active;
    this.active = running;
    clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    if (running) {
      if (this.state === "live") {
        void this.pull(false);
        this.schedulePoll();
      }
    } else {
      if (!this.inFastBurst()) {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
      if (wasActive && this.state === "live") {
        void this.pull(false, true);
      }
    }
  }

  /**
   * Requests an immediate pull (e.g. after a message send, rewind, reconnect, or state update).
   * With `followUp = true`, opens a short fast-burst window (up to 2 s at 300 ms cadence) that
   * runs regardless of `active` so a newly submitted user_message lands quickly instead of
   * waiting for the 1.5 s steady-state poll, and exits early as soon as rows change.
   */
  wake(followUp = false) {
    if (this.state === "disposed") return;
    if (followUp) {
      this.fastPollsLeft = FAST_BURST_POLLS;
      // Drop any slower steady-state timer so the fast cadence takes effect immediately.
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.state === "idle" || this.state === "failed") return this.start();
    if (this.state === "live") void this.pull(false);
    else this.pendingPull = true;
  }

  /** Backwards-compatible alias for one-shot tail refresh. */
  refreshTailMetrics() {
    this.wake();
  }

  watch(watcher: Watcher, since?: TimelineResume): () => void {
    this.watchers.add(watcher);
    if (this.state === "live") {
      const ops = since ? this.resumeOps(since) : null;
      if (ops) {
        if (ops.length) watcher(ops);
      } else {
        watcher([this.resetOp()]);
      }
      if (this.active || this.inFastBurst()) this.schedulePoll();
      else if (since && now() - this.lastPullAt >= RESUME_VERIFY_MS) this.wake();
    } else if (this.state === "loading" && this.joiners.length < MAX_JOINERS) {
      this.joiners.push(now());
    }
    return () => {
      this.watchers.delete(watcher);
      if (!this.watchers.size) {
        clearTimeout(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
  }

  dispose(): Promise<void> {
    this.state = "disposed";
    this.token++;
    this.fastPollsLeft = 0;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.settleTimer);
    this.pollTimer = this.retryTimer = this.settleTimer = undefined;
    this.watchers.clear();
    return Promise.resolve();
  }

  private inFastBurst() {
    return this.fastPollsLeft > 0;
  }

  private schedulePoll() {
    if (this.state !== "live" || !this.watchers.size || this.pollTimer) return;
    const fast = this.inFastBurst();
    if (!this.active && !fast) return;
    const delay = fast ? this.fastPollMs : this.pollMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.state !== "live" || !this.watchers.size) return;
      if (fast && this.fastPollsLeft > 0) this.fastPollsLeft--;
      if (!this.active && !fast) return;
      void this.pull(false);
    }, delay);
    this.pollTimer.unref?.();
  }

  private async pull(initial: boolean, checkMetricsSettle = false) {
    if (this.state === "disposed") return;
    if (this.inFlight) {
      this.pendingPull = true;
      if (checkMetricsSettle) this.pendingSettle = true;
      return;
    }
    this.inFlight = true;
    const token = this.token;
    const fetchAt = now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const fetchPromise = this.driver.fetchAgentTimeline(this.agentId, {
        direction: "tail",
        limit: TAIL_LIMIT,
        projection: "projected",
        wholeTurns: false,
        timeout: 15_000,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("Timeline fetch timed out")), PULL_TIMEOUT_MS);
        timeoutHandle.unref?.();
      });
      const page = await Promise.race([fetchPromise, timeoutPromise]);
      if (token !== this.token) return;
      this.lastPullAt = now();
      if (this.timing) this.timing.fetchMs = Math.round(this.lastPullAt - fetchAt);
      this.consecutiveFailures = 0;

      const isReset = initial || this.state !== "live" || page.reset || page.epoch !== this.epoch;
      if (isReset) {
        this.replaceWith(page);
        this.state = "live";
        this.loaded();
        // A newly created empty conversation gets one short fast burst while its initial prompt lands.
        if (initial && page.entries.length === 0 && this.watchers.size > 0) {
          this.fastPollsLeft = Math.max(this.fastPollsLeft, FAST_BURST_POLLS);
        } else if (page.entries.length > 0) {
          this.fastPollsLeft = 0;
        }
        this.broadcast([this.resetOp()]);
      } else {
        const ops = this.mergeTail(page);
        if (ops.length) {
          this.fastPollsLeft = 0;
          this.broadcast(ops);
        }
      }

      if (checkMetricsSettle && !this.active) {
        const latest = [...page.entries]
          .reverse()
          .find((e) => e.item.type === "assistant_message" || e.item.type === "tool_call");
        if (latest && !latest.turnMetrics?.length) {
          clearTimeout(this.settleTimer);
          this.settleTimer = setTimeout(() => {
            this.settleTimer = undefined;
            if (this.state === "live" && !this.active) void this.pull(false, false);
          }, METRICS_SETTLE_MS);
          this.settleTimer.unref?.();
        }
      }
    } catch {
      if (token !== this.token) return;
      this.consecutiveFailures++;
      if (this.timing) this.timing.failures++;
      if (initial || this.state !== "live") {
        this.state = "failed";
        this.broadcast([{ type: "error", message: "Timeline sync interrupted; retrying" }]);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (this.state === "failed" && token === this.token) this.start();
        }, RETRY_MS);
        this.retryTimer.unref?.();
      } else if (this.consecutiveFailures >= 3) {
        this.broadcast([{ type: "error", message: "Timeline sync interrupted; retrying" }]);
      }
    } finally {
      clearTimeout(timeoutHandle);
      this.inFlight = false;
      if (this.state === "live") {
        if (this.pendingPull) {
          const settle = this.pendingSettle;
          this.pendingPull = false;
          this.pendingSettle = false;
          void this.pull(false, settle);
        } else if ((this.active || this.inFastBurst()) && this.watchers.size) {
          this.schedulePoll();
        }
      }
    }
  }

  private replaceWith(page: TimelinePayload) {
    this.rows = [];
    this.bySeqStart.clear();
    this.fingerprints.clear();
    this.rowRev.clear();
    this.epoch = page.epoch;
    this.revision++;
    this.resumeFloor = this.revision;
    this.hasOlder = page.hasOlder;
    this.startCursor = page.startCursor;
    for (const entry of page.entries) {
      const row = toRow(entry);
      this.insertRow(row, this.revision);
    }
    this.trimIfNeeded();
  }

  private mergeTail(page: TimelinePayload): TimelineOp[] {
    // Detect truncation, rewind without epoch change, or a >TAIL_LIMIT gap: reset cleanly.
    if (this.rows.length > 0) {
      if (page.entries.length === 0) {
        this.replaceWith(page);
        return [this.resetOp()];
      }
      const tailFirst = page.entries[0]!.seqStart;
      const ourLast = this.rows.at(-1)!;
      if (page.hasOlder && tailFirst > ourLast.seqEnd + 1) {
        this.replaceWith(page);
        return [this.resetOp()];
      }
      const incomingStarts = new Set(page.entries.map((e) => e.seqStart));
      for (let i = this.rows.length - 1; i >= 0; i--) {
        const r = this.rows[i]!;
        if (r.seqStart < tailFirst) break;
        if (!incomingStarts.has(r.seqStart)) {
          this.replaceWith(page);
          return [this.resetOp()];
        }
      }
    }
    const ops: TimelineOp[] = [];
    let touched = false;
    for (const entry of page.entries) {
      const row = toRow(entry);
      const fp = rowFingerprint(row);
      const existing = this.bySeqStart.get(row.seqStart);
      if (existing) {
        if (this.fingerprints.get(row.seqStart) === fp) continue;
        if (!touched) {
          this.revision++;
          touched = true;
        }
        Object.assign(existing, row);
        if (!row.turnId) delete existing.turnId;
        if (!row.turnMetrics?.length) delete existing.turnMetrics;
        this.fingerprints.set(row.seqStart, fp);
        this.rowRev.set(row.seqStart, this.revision);
        ops.push({ type: "upsert", row: { ...existing }, seq: this.revision });
        continue;
      }
      if (this.hasOlder && this.startCursor && row.seqStart < this.startCursor.seq) continue;
      if (!touched) {
        this.revision++;
        touched = true;
      }
      this.insertRow(row, this.revision);
      ops.push({ type: "upsert", row: { ...row }, seq: this.revision });
    }
    this.trimIfNeeded();
    return ops;
  }

  private insertRow(row: TimelineRow, rev: number) {
    const fp = rowFingerprint(row);
    let index = this.rows.length;
    if (index && this.rows[index - 1]!.seqStart > row.seqStart) {
      let low = 0;
      let high = index;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (this.rows[mid]!.seqStart < row.seqStart) low = mid + 1;
        else high = mid;
      }
      index = low;
    }
    this.rows.splice(index, 0, row);
    this.bySeqStart.set(row.seqStart, row);
    this.fingerprints.set(row.seqStart, fp);
    this.rowRev.set(row.seqStart, rev);
  }

  private trimIfNeeded() {
    if (this.rows.length <= MAX_ROWS) return;
    const dropped = this.rows.slice(0, this.rows.length - KEEP_ROWS);
    this.rows = this.rows.slice(this.rows.length - KEEP_ROWS);
    for (const row of dropped) {
      this.bySeqStart.delete(row.seqStart);
      this.fingerprints.delete(row.seqStart);
      this.rowRev.delete(row.seqStart);
    }
    this.hasOlder = true;
    this.startCursor = this.rows[0] ? { epoch: this.epoch, seq: this.rows[0].seqStart } : this.startCursor;
    this.resumeFloor = this.revision;
  }

  private resumeOps(since: TimelineResume): TimelineOp[] | null {
    if (since.epoch !== this.epoch || since.seq < this.resumeFloor || since.seq > this.revision) return null;
    const changed = this.rows.filter(
      (row) => row.seqStart >= since.from && (this.rowRev.get(row.seqStart) ?? 0) > since.seq,
    );
    if (changed.length > RESET_ROWS) return null;
    return changed.map((row) => ({ type: "upsert", row: { ...row }, seq: this.revision }));
  }

  private resetOp(): TimelineOp {
    const start = Math.max(0, this.rows.length - RESET_ROWS);
    const rows = this.rows.slice(start).map((row) => ({ ...row }));
    return {
      type: "reset",
      epoch: this.epoch,
      rows,
      hasOlder: this.hasOlder || start > 0,
      startCursor: start > 0 ? { epoch: this.epoch, seq: rows[0]!.seqStart } : this.startCursor,
      seq: this.revision,
    };
  }

  private loaded() {
    const timing = this.timing;
    const joiners = this.joiners;
    this.timing = null;
    this.joiners = [];
    if (!timing || !this.watchers.size) return;
    const done = now();
    const base = {
      subscribeMs: null,
      fetchMs: timing.fetchMs,
      attempts: timing.attempts,
      failures: timing.failures,
    };
    this.report?.({ ...base, totalMs: Math.round(done - timing.startedAt), kind: "view" });
    for (const joined of joiners) this.report?.({ ...base, totalMs: Math.round(done - joined), kind: "join" });
  }

  private broadcast(ops: TimelineOp[]) {
    notifyListeners(this.watchers, ops);
  }
}

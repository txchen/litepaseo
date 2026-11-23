import { shallowRef, type ShallowRef } from "vue";
import type { TimelineCursor, TimelineOp, TimelineRow } from "../shared/wire.ts";

export interface RowRef {
  seqStart: number;
  row: ShallowRef<TimelineRow>;
}

/** Rows kept in the browser; the oldest beyond this are dropped and can be paged back in. */
const MAX_ROWS = 3000;
const TRIM_TO = 2500;

/** Whether a row from the server is unchanged: every change to a row moves its seqEnd, except
 * message images, which the server adds to the item; comparing the item covers both. */
function sameRow(a: TimelineRow, b: TimelineRow) {
  return a.seqEnd === b.seqEnd && a.timestamp === b.timestamp && a.provider === b.provider && a.turnId === b.turnId
    && JSON.stringify(a.item) === JSON.stringify(b.item)
    && JSON.stringify(a.turnMetrics ?? null) === JSON.stringify(b.turnMetrics ?? null);
}

/**
 * One conversation in the browser. Each row has its own ref, so an append re-renders only
 * that row; `membership` changes only when rows are added or removed.
 */
export class TimelineStore {
  rows: RowRef[] = [];
  epoch = "";
  hasOlder = false;
  startCursor: TimelineCursor | null = null;
  ready = false;
  /** The latest change these rows include; a reconnect asks only for what came after it. */
  lastSeq = -1;
  readonly membership = shallowRef(0);

  /** How far this conversation is held, for resuming its stream; null before the first rows. */
  resumePoint() {
    const first = this.rows[0];
    return this.ready && first && this.lastSeq >= 0 ? { epoch: this.epoch, seq: this.lastSeq, from: first.seqStart } : null;
  }

  apply(ops: TimelineOp[]) {
    let membership = false;
    for (const op of ops) {
      if (op.type === "reset") {
        // A reset of the same conversation (reconnect, a cached view reopened) keeps the refs
        // of rows that did not change, so only new and changed rows render again.
        const previous = this.ready && op.epoch === this.epoch ? new Map(this.rows.map((r) => [r.seqStart, r])) : null;
        this.rows = op.rows.map((row) => {
          const kept = previous?.get(row.seqStart);
          if (kept && sameRow(kept.row.value, row)) return kept;
          if (kept) {
            kept.row.value = row;
            return kept;
          }
          return { seqStart: row.seqStart, row: shallowRef(row) };
        });
        this.epoch = op.epoch;
        this.hasOlder = op.hasOlder;
        this.startCursor = op.startCursor;
        this.ready = true;
        this.lastSeq = op.seq ?? op.rows.reduce((max, row) => Math.max(max, row.seqEnd), -1);
        membership = true;
      } else if (op.type === "upsert") {
        this.lastSeq = Math.max(this.lastSeq, op.row.seqEnd);
        const index = this.find(op.row.seqStart);
        if (index >= 0) this.rows[index].row.value = op.row;
        else {
          this.insert({ seqStart: op.row.seqStart, row: shallowRef(op.row) });
          membership = true;
        }
      } else if (op.type === "append") {
        this.lastSeq = Math.max(this.lastSeq, op.seqEnd);
        const index = this.find(op.seqStart);
        if (index < 0) continue;
        const ref = this.rows[index].row,
          row = ref.value;
        ref.value = {
          ...row,
          seqEnd: op.seqEnd,
          timestamp: op.timestamp,
          item: { ...row.item, text: (row.item.text ?? "") + op.text },
        };
      }
    }
    if (this.rows.length > MAX_ROWS) {
      this.rows = this.rows.slice(this.rows.length - TRIM_TO);
      this.hasOlder = true;
      this.startCursor = { epoch: this.epoch, seq: this.rows[0].seqStart };
      membership = true;
    }
    if (membership) this.membership.value++;
  }

  private find(seqStart: number) {
    let low = 0,
      high = this.rows.length;
    // Live changes almost always touch the last row.
    if (high && this.rows[high - 1].seqStart === seqStart) return high - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.rows[middle].seqStart < seqStart) low = middle + 1;
      else high = middle;
    }
    return this.rows[low]?.seqStart === seqStart ? low : -1;
  }

  private insert(ref: RowRef) {
    const last = this.rows.at(-1);
    if (!last || last.seqStart < ref.seqStart) return void this.rows.push(ref);
    let low = 0,
      high = this.rows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.rows[middle].seqStart < ref.seqStart) low = middle + 1;
      else high = middle;
    }
    this.rows.splice(low, 0, ref);
  }
}

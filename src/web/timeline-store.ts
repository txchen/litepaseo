import { shallowRef, type ShallowRef } from "vue";
import type { TimelineCursor, TimelineOp, TimelinePage, TimelineRow } from "../shared/wire.ts";

export interface RowRef {
  seqStart: number;
  row: ShallowRef<TimelineRow>;
}

/** Rows kept in the browser; the oldest beyond this are dropped and can be paged back in. */
const MAX_ROWS = 3000;
const TRIM_TO = 2500;

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
  readonly membership = shallowRef(0);

  apply(ops: TimelineOp[]) {
    let membership = false;
    for (const op of ops) {
      if (op.type === "reset") {
        this.rows = op.rows.map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) }));
        this.epoch = op.epoch;
        this.hasOlder = op.hasOlder;
        this.startCursor = op.startCursor;
        this.ready = true;
        membership = true;
      } else if (op.type === "upsert") {
        const index = this.find(op.row.seqStart);
        if (index >= 0) this.rows[index].row.value = op.row;
        else {
          this.insert({ seqStart: op.row.seqStart, row: shallowRef(op.row) });
          membership = true;
        }
      } else if (op.type === "append") {
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

  /** Adds an older history page; returns how many rows were new. */
  prepend(page: TimelinePage) {
    if (page.epoch !== this.epoch) return 0;
    const first = this.rows[0]?.seqStart ?? Infinity;
    const older = page.rows
      .filter((row) => row.seqStart < first)
      .map((row) => ({ seqStart: row.seqStart, row: shallowRef(row) }));
    this.rows = older.concat(this.rows);
    this.hasOlder = page.hasOlder;
    this.startCursor = page.startCursor;
    if (older.length) this.membership.value++;
    return older.length;
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

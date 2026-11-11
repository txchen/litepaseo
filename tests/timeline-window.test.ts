import test from "node:test";
import assert from "node:assert/strict";
import { shallowRef } from "vue";
import { pageHistory } from "../src/web/timeline-window.ts";
import type { TimelineRow } from "../src/shared/wire.ts";

const row = (seq: number): TimelineRow => ({ seqStart: seq, seqEnd: seq, timestamp: "t", provider: "codex", item: { type: "assistant_message", text: String(seq) } });
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i));
test("history can traverse thousands of rows in both directions without growing or skipping", () => {
  let window = rows(4941, 60).map(row => ({ seqStart: row.seqStart, row: shallowRef(row) }));
  for (let i = 0; i < 40; i++) {
    const first = window[0].seqStart;
    const next = pageHistory(window, { epoch: "e", hasOlder: true, startCursor: null, rows: rows(first - 100, 100) }, "before");
    window = next.rows;
    assert.equal(window.length, 150);
    assert.equal(window[0].seqStart, first - 100);
    assert.deepEqual(window.map(r => r.seqStart), rows(first - 100, 150).map(r => r.seqStart));
  }
  for (let i = 0; i < 39; i++) {
    const last = window.at(-1)!.seqStart;
    window = pageHistory(window, { epoch: "e", hasOlder: true, startCursor: null, rows: rows(last + 1, 100) }, "after").rows;
    assert.equal(window.length, 150);
    assert.equal(window.at(-1)!.seqStart, last + 100);
    assert.deepEqual(window.map(r => r.seqStart), rows(last - 49, 150).map(r => r.seqStart));
  }
});

test("oversized whole-turn pages keep nearest rows reachable and exclude overlap", () => {
  const current = rows(501, 150).map(row => ({ seqStart: row.seqStart, row: shallowRef(row) }));
  const before = pageHistory(current, { epoch: "e", hasOlder: false, startCursor: null, rows: rows(1, 510) }, "before");
  assert.equal(before.rows[0].seqStart, 401);
  assert.equal(before.rows.at(-1)!.seqStart, 550);
  assert.equal(before.hasOlder, true, "discarded older rows remain pageable even when daemon hasOlder is false");
  const after = pageHistory(current, { epoch: "e", hasOlder: true, startCursor: null, rows: rows(640, 500) }, "after");
  assert.equal(after.rows[0].seqStart, 601);
  assert.equal(after.rows.at(-1)!.seqStart, 750);
});

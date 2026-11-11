import test from "node:test";
import assert from "node:assert/strict";
import { OrderedIndex } from "../src/shared/ordered-index.ts";
import { VersionedCollection } from "../src/server/versioned-collection.ts";

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

test("OrderedIndex matches a sorted array under random inserts, removes and range reads", () => {
  type Item = { key: string; score: number };
  const cmp = (a: Item, b: Item) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const random = rng(7);
  const index = new OrderedIndex<Item>(cmp);
  const live = new Map<string, Item>();
  for (let step = 0; step < 20000; step++) {
    const key = "k" + Math.floor(random() * 500);
    const old = live.get(key);
    if (old) assert.equal(index.remove(old), true);
    if (random() < 0.8) {
      const item = { key, score: Math.floor(random() * 100) };
      index.insert(item);
      live.set(key, item);
    } else live.delete(key);
    if (step % 500 === 0) {
      const expected = [...live.values()].sort(cmp);
      assert.equal(index.size, expected.length);
      const start = Math.floor(random() * expected.length);
      assert.deepEqual(index.range(start, 37), expected.slice(start, start + 37));
      assert.deepEqual(index.range(0, expected.length), expected);
      for (let i = 0; i < expected.length; i += 13) {
        assert.equal(index.at(i), expected[i]);
        assert.equal(index.rank(expected[i]), i);
      }
    }
  }
  assert.equal(index.remove({ key: "missing", score: -1 }), false);
  assert.deepEqual(index.range(-5, 0), []);
});

test("VersionedCollection returns only entries changed after a cursor, latest value once", () => {
  const c = new VersionedCollection<number>(3);
  c.set("a", 1);
  c.set("b", 1);
  const cursor = c.seq;
  assert.deepEqual(c.changesSince(cursor), []);
  c.set("a", 2);
  c.set("a", 3);
  c.set("c", 1);
  c.delete("b");
  assert.deepEqual(c.changesSince(cursor), [
    { key: "a", value: 3 },
    { key: "c", value: 1 },
    { key: "b", value: null },
  ]);
  assert.deepEqual(c.snapshot().sort(), [1, 3]);
  assert.equal(c.size, 2);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.changesSince(c.seq + 1), null, "a cursor from the future is not resumable");
  // Resurrecting a tombstone makes the old deletion record stale, not evictable.
  c.set("b", 9);
  for (const key of ["x", "y", "z", "w"]) {
    c.set(key, 0);
    c.delete(key);
  }
  assert.equal(c.changesSince(cursor), null, "evicted tombstones move the resumable horizon");
  assert.equal(c.get("b"), 9);
  const recent = c.seq;
  c.set("a", 4);
  assert.deepEqual(c.changesSince(recent), [{ key: "a", value: 4 }]);
});

test("VersionedCollection delta reads do not scan the whole collection", () => {
  const c = new VersionedCollection<number>();
  for (let i = 0; i < 200_000; i++) c.set("k" + i, i);
  const cursor = c.seq;
  c.set("k5", -1);
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) assert.equal(c.changesSince(cursor)!.length, 1);
  // 10k reads over a 200k collection: linear reads would take seconds.
  assert.ok(performance.now() - started < 250, "changesSince must be O(changes)");
});

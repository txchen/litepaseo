import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineRow } from "../src/shared/wire.ts";
import { OptimisticStore, findMatchedOptimisticIds } from "../src/web/optimistic-messages.ts";

function userRow(seq: number, item: Record<string, unknown>): TimelineRow {
  return {
    seqStart: seq,
    seqEnd: seq,
    timestamp: new Date().toISOString(),
    provider: "codex",
    item: { type: "user_message", ...item },
  };
}

test("optimistic deduplication matches exact clientMessageId/messageId and preserves FIFO for duplicate sends", () => {
  const revoked: string[] = [];
  const store = new OptimisticStore({ revoke: (url) => revoked.push(url), expireMs: 5_000 });

  store.add({
    messageId: "m-1",
    agentKey: "h:a",
    text: "continue",
    images: ["blob:1"],
    baselineSeqEnd: 10,
  });
  store.add({
    messageId: "m-2",
    agentKey: "h:a",
    text: "continue",
    images: ["blob:2"],
    baselineSeqEnd: 10,
  });

  // An older identical "continue" before baselineSeqEnd must NEVER dismiss new optimistic bubbles.
  assert.deepEqual(store.reconcile("h:a", [userRow(5, { text: "continue" })]), []);
  assert.equal(store.list("h:a").length, 2);

  // Exact match by clientMessageId removes only m-2 (even if daemon reformatted text) and revokes its blob URL.
  const hit1 = store.reconcile("h:a", [
    userRow(5, { text: "continue" }),
    userRow(11, { text: "continue (normalized)", clientMessageId: "m-2" }),
  ]);
  assert.deepEqual(hit1, ["m-2"]);
  assert.deepEqual(revoked, ["blob:2"]);
  assert.equal(store.wasConfirmed("m-2"), true);
  assert.deepEqual(
    store.list("h:a").map((m) => m.messageId),
    ["m-1"],
  );

  // Exact match by server messageId removes m-1 too.
  const hit2 = store.reconcile("h:a", [userRow(12, { text: "continue", messageId: "m-1" })]);
  assert.deepEqual(hit2, ["m-1"]);
  assert.deepEqual(revoked, ["blob:2", "blob:1"]);
  assert.equal(store.list("h:a").length, 0);
});

test("fallback content deduplication is 1-to-1 FIFO and refuses mismatched clientMessageIds", () => {
  const store = new OptimisticStore({ revoke: () => {} });
  store.add({ messageId: "a-1", agentKey: "h:a", text: "ping", baselineSeqEnd: 20 });
  store.add({ messageId: "a-2", agentKey: "h:a", text: "ping", baselineSeqEnd: 20 });

  // A daemon row explicitly tagged with another clientMessageId must not falsely match a-1 or a-2.
  const wrongId = findMatchedOptimisticIds(store.list("h:a"), [
    userRow(21, { text: "ping", clientMessageId: "someone-else" }),
  ]);
  assert.equal(wrongId.size, 0);

  // One ID-less real row strictly after baseline consumes ONLY the first optimistic "ping" (FIFO).
  const first = store.reconcile("h:a", [userRow(21, { text: "ping" })]);
  assert.deepEqual(first, ["a-1"]);
  assert.deepEqual(
    store.list("h:a").map((m) => m.messageId),
    ["a-2"],
  );

  // Image-only optimistic bubble matches only a newer image-bearing empty-text row.
  store.add({ messageId: "img-1", agentKey: "h:a", text: "", images: ["blob:img"], baselineSeqEnd: 21 });
  assert.deepEqual(store.reconcile("h:a", [userRow(22, { text: "" })]), []);
  assert.deepEqual(
    store.reconcile("h:a", [userRow(22, { text: "", imageUrls: ["/api/images/1"] })]),
    ["img-1"],
  );
});

test("mobile race: SSE arriving before HTTP response confirms message; epoch reset & expiry clean up cleanly", async () => {
  const revoked: string[] = [];
  const store = new OptimisticStore({ revoke: (url) => revoked.push(url), expireMs: 40 });

  store.add({ messageId: "race-1", agentKey: "h:a", text: "hello", images: ["blob:r1"], baselineSeqEnd: 0 });
  // Real row lands over SSE while POST /messages is still "sending" (HTTP response delayed/dropped).
  assert.deepEqual(store.reconcile("h:a", [userRow(1, { text: "hello", clientMessageId: "race-1" })]), ["race-1"]);
  assert.equal(store.wasConfirmed("race-1"), true);
  // Late HTTP 200 markSent is a clean no-op and does not resurrect the bubble.
  assert.equal(store.markSent("h:a", "race-1"), false);
  assert.equal(store.list("h:a").length, 0);

  // clearAgent(key, true) clears sent bubbles (e.g., on epoch change) while keeping in-flight sends.
  store.add({ messageId: "s-1", agentKey: "h:a", text: "one", images: ["blob:s1"], baselineSeqEnd: 1 });
  store.add({ messageId: "s-2", agentKey: "h:a", text: "two", images: ["blob:s2"], baselineSeqEnd: 1 });
  store.add({ messageId: "other", agentKey: "h:b", text: "other", images: ["blob:o"], baselineSeqEnd: 0 });
  store.markSent("h:a", "s-1");
  store.clearAgent("h:a", true);
  assert.deepEqual(
    store.list("h:a").map((m) => m.messageId),
    ["s-2"],
  );
  assert.equal(store.list("h:b").length, 1);

  // Fallback expiry cleans up a sent bubble that never lands and revokes its blob URL.
  store.markSent("h:a", "s-2");
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(store.list("h:a").length, 0);
  assert.ok(revoked.includes("blob:s2"));

  store.clearAll();
  assert.ok(revoked.includes("blob:o"));
});

test("repeated snapshots with one ID-less row never confirm two identical sends", () => {
  const store = new OptimisticStore({ revoke: () => {} });
  store.add({ messageId: "dup-1", agentKey: "h:a", text: "ping", baselineSeqEnd: 0 });
  store.add({ messageId: "dup-2", agentKey: "h:a", text: "ping", baselineSeqEnd: 0 });

  const snapshot = [userRow(1, { text: "ping" })];
  assert.deepEqual(store.reconcile("h:a", snapshot, "epoch-1"), ["dup-1"]);
  assert.equal(store.wasConfirmed("dup-1"), true);
  assert.equal(store.wasConfirmed("dup-2"), false);

  // Re-running reconcile on the exact same snapshot must NOT consume row 1 again for dup-2.
  assert.deepEqual(store.reconcile("h:a", snapshot, "epoch-1"), []);
  assert.equal(store.wasConfirmed("dup-2"), false);
  assert.deepEqual(store.list("h:a").map((m) => m.messageId), ["dup-2"]);

  // Once the second real row arrives, dup-2 confirms cleanly.
  assert.deepEqual(
    store.reconcile("h:a", [userRow(1, { text: "ping" }), userRow(2, { text: "ping" })], "epoch-1"),
    ["dup-2"],
  );
  assert.equal(store.wasConfirmed("dup-2"), true);
  store.clearAll();
});

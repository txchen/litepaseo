import test from "node:test";
import assert from "node:assert/strict";
import { ViewingPresence } from "../src/server/viewing-presence.ts";

test("presence is per conversation, spans devices, and retains other tabs", () => {
  const presence = new ViewingPresence(() => true);
  presence.update("desktop", "one", 1, "h:a");
  presence.update("desktop", "two", 1, "h:a");
  assert.equal(presence.isViewing("h:a"), true);
  assert.equal(presence.isViewing("h:b"), false);
  presence.update("desktop", "one", 2, null);
  assert.equal(presence.isViewing("h:a"), true);
  presence.update("desktop", "two", 2, "h:b");
  assert.equal(presence.isViewing("h:a"), false);
  assert.equal(presence.isViewing("h:b"), true);
});

test("late heartbeats cannot undo leaving; expired and revoked viewers stop suppressing", () => {
  let now = 0;
  const valid = new Set(["desktop"]);
  const presence = new ViewingPresence(id => valid.has(id), () => now);
  presence.update("desktop", "tab", 1, "h:a");
  presence.update("desktop", "tab", 3, null);
  presence.update("desktop", "tab", 2, "h:a");
  assert.equal(presence.isViewing("h:a"), false);
  presence.update("desktop", "tab", 4, "h:a");
  now = 44_999;
  assert.equal(presence.isViewing("h:a"), true);
  now = 45_000;
  assert.equal(presence.isViewing("h:a"), false);
  presence.update("desktop", "tab", 5, "h:a");
  valid.clear();
  assert.equal(presence.isViewing("h:a"), false);
});

test("an active device counts without a conversation open; last views outlive the lease", () => {
  let now = 1000;
  const presence = new ViewingPresence(() => true, () => now);
  assert.equal(presence.anyActive(), false);
  presence.update("desktop", "tab", 1, null, true);
  assert.equal(presence.anyActive(), true, "using the sidebar is activity");
  presence.update("desktop", "tab", 2, "h:a");
  now = 5000;
  presence.update("desktop", "tab", 3, null, true);
  assert.equal(presence.isViewing("h:a"), false);
  assert.equal(presence.viewedSince("h:a", 1000), true, "opened briefly after the event");
  assert.equal(presence.viewedSince("h:a", 1001), false);
  presence.update("desktop", "tab", 4, null, false);
  assert.equal(presence.anyActive(), false, "idle pages stop counting");
  presence.update("desktop", "tab", 5, null, true);
  now += 45_000;
  assert.equal(presence.anyActive(), false, "and so do silent ones");
  assert.equal(presence.viewedSince("h:a", 1000), true);
  now += 60 * 60_000;
  presence.update("phone", "tab", 1, null);
  assert.equal(presence.viewedSince("h:a", 1000), false, "old views are forgotten");
});

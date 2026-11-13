import test from "node:test";
import assert from "node:assert/strict";
import { notificationPreview } from "../src/server/notification-preview.ts";
const row = (type: string, text: string, at: number) => ({ timestamp: new Date(at).toISOString(), item: { type, text } });
const reader = (entries: ReturnType<typeof row>[]) => ({ fetchAgentTimeline: async () => ({ entries }) });

test("preview chooses the latest assistant answer, skipping tools and reasoning", async () => {
  const driver = reader([
    row("user_message", "My initial prompt", 1000),
    row("assistant_message", "Working on it", 1100),
    row("reasoning", "private reasoning", 1200),
    row("assistant_message", "Fixed it.\n\nTests pass.", 1300),
    row("tool_call", "tool output", 1400),
  ]);
  assert.equal(await notificationPreview(driver, "a", 1000, 1500), "Fixed it. Tests pass.");
});

test("preview never substitutes a prompt or an earlier turn; queued new turns are excluded", async () => {
  const entries = [row("assistant_message", "Old answer", 500), row("user_message", "New prompt", 1000)];
  assert.equal(await notificationPreview(reader(entries), "a", 1000, 1500), null);
  assert.equal(await notificationPreview(reader([entries[0]]), "a", 1000, 1500), null);
  entries.push(row("assistant_message", "Current answer", 1300), row("user_message", "Queued prompt", 1600), row("assistant_message", "Next answer", 1700));
  assert.equal(await notificationPreview(reader(entries), "a", 1000, 1500), "Current answer");
});

test("empty timelines fall back and long replies are bounded", async () => {
  assert.equal(await notificationPreview(reader([]), "a"), null);
  assert.equal((await notificationPreview(reader([row("assistant_message", "x".repeat(1000), 1000)]), "a"))?.length, 240);
});

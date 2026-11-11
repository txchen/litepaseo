import test from "node:test";
import assert from "node:assert/strict";
import { confirmedMessages } from "../src/server/message-status.ts";

test("delivery confirmation uses only exact user message IDs and pages older history", async () => {
  const calls: any[] = [];
  const driver = { async fetchAgentTimeline(agentId: string, options: any) {
    calls.push([agentId, options]);
    return calls.length === 1 ? {
      entries: [{ item: { type: "assistant_message", messageId: "wanted" } }, { item: { type: "user_message", messageId: "different", text: "same text" } }],
      hasOlder: true, startCursor: { epoch: "e", seq: 20 },
    } : { entries: [{ item: { type: "user_message", messageId: "provider-id", clientMessageId: "wanted" } }], hasOlder: false, startCursor: null };
  } };
  assert.deepEqual(await confirmedMessages(driver, "agent", ["wanted", "absent"]), ["wanted"]);
  assert.equal(calls[1][1].direction, "before");
  assert.equal(calls[1][0], "agent");
});
test("missing IDs stay uncertain and cursor loops are bounded", async () => {
  let calls = 0;
  const driver = { async fetchAgentTimeline() { calls++; return { entries: [], hasOlder: true, startCursor: { epoch: "e", seq: 1 } }; } };
  assert.deepEqual(await confirmedMessages(driver, "a", ["missing"]), []);
  assert.equal(calls, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import type { ProviderSubagent, TimelineOp } from "../src/shared/wire.ts";

async function reader(response: Response) {
  const stream = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  return {
    async next(): Promise<any> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.startsWith("data: ")) return JSON.parse(block.slice(6));
          continue;
        }
        const { value, done } = await stream.read();
        if (done) throw new Error("stream ended");
        buffer += value;
      }
    },
    cancel: () => stream.cancel().catch(() => {}),
  };
}

test("the conversation stream carries the agent's provider subagents; their conversations stream on their own", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-test-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  hosts.clients.set("h", {} as never);
  const watched: unknown[][] = [];
  let pushList!: (subagents: ProviderSubagent[]) => void;
  let stopped = 0;
  hosts.watchSubagents = (host, agent, listener) => {
    watched.push(["subagents", host, agent]);
    pushList = listener;
    listener([]);
    return () => void stopped++;
  };
  const resumes: unknown[] = [];
  hosts.watchTimeline = (host, agent, watcher, subagent, since) => {
    watched.push(["timeline", host, agent, subagent]);
    resumes.push(since);
    watcher([{ type: "reset", epoch: "e", rows: [], hasOlder: false, startCursor: null } satisfies TimelineOp]);
    return () => void stopped++;
  };
  const app = createApp(store, hosts, "test-token", directory);
  const open = async (path: string) =>
    reader(await app.request("/api" + path, { headers: { authorization: "Bearer test-token" } }));
  try {
    const chat = await open("/hosts/h/agents/a1/timeline/stream");
    assert.equal((await chat.next()).type, "ops");
    // The first list goes out even when empty, so a reconnect clears ones that are gone.
    assert.deepEqual(await chat.next(), { type: "subagents", subagents: [] });
    const subagent: ProviderSubagent = {
      id: "s1", parentSubagentId: null, provider: "claude", title: "Task", description: "Find it", subtitle: null,
      status: "running", createdAt: "t", updatedAt: "t", toolCallId: "call-1",
    };
    pushList([subagent]);
    pushList([subagent]);
    pushList([{ ...subagent, status: "completed" }]);
    assert.deepEqual(await chat.next(), { type: "subagents", subagents: [subagent] });
    assert.equal((await chat.next()).subagents[0].status, "completed", "an unchanged list is not resent");

    const sub = await open("/hosts/h/agents/a1/subagents/s1/timeline/stream");
    assert.equal((await sub.next()).ops[0].type, "reset");
    assert.deepEqual(watched, [["timeline", "h", "a1", undefined], ["subagents", "h", "a1"], ["timeline", "h", "a1", "s1"]]);
    await chat.cancel();
    await sub.cancel();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stopped, 3);
    // A browser that holds the conversation resumes from where it is; a malformed point is ignored.
    for (const query of ["?epoch=e&seq=41&from=3", "?epoch=e&seq=-1&from=3", "?epoch=e&seq=4"]) {
      const resumed = await open("/hosts/h/agents/a1/timeline/stream" + query);
      await resumed.next();
      await resumed.cancel();
    }
    assert.deepEqual(resumes.slice(-3), [{ epoch: "e", seq: 41, from: 3 }, undefined, undefined]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { Hosts } from "../src/server/hosts.ts";

test("host removal awaits unsubscribe acknowledgements before closing the SDK transport", async () => {
  const hosts = new Hosts();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  hosts.clients.set("h", {
    directory: { dispose: () => released.then(() => { calls.push("directory released"); }) },
    workspaces: { dispose: async () => { calls.push("workspaces released"); } },
    subagents: { dispose: async () => { calls.push("subagents released"); } },
    stopStatus: () => {},
    api: { dispose: async () => { calls.push("api disposed"); } },
    driver: { close: async () => { calls.push("transport closed"); } },
  } as never);
  const removing = hosts.remove("h");
  await Promise.resolve();
  assert.ok(!calls.includes("transport closed"));
  release();
  await removing;
  assert.ok(calls.indexOf("directory released") < calls.indexOf("transport closed"));
  assert.ok(calls.indexOf("subagents released") < calls.indexOf("transport closed"));
  assert.equal(calls.at(-1), "transport closed");
});

test("host removal stops status reports first and finishes its cleanup even when a release fails", async () => {
  const hosts = new Hosts();
  const calls: string[] = [];
  let changes = 0;
  hosts.onHostsChanged(() => changes++);
  hosts.clients.set("h", {
    directory: { dispose: async () => { calls.push("directory"); throw new Error("socket closed"); } },
    workspaces: { dispose: async () => {} },
    subagents: { dispose: async () => {} },
    stopStatus: () => calls.push("status stopped"),
    api: { dispose: async () => { throw new Error("already gone"); } },
    driver: { close: async () => { calls.push("transport closed"); } },
  } as never);
  const warn = console.warn;
  console.warn = () => {};
  try { await hosts.remove("h"); } finally { console.warn = warn; }
  assert.equal(calls[0], "status stopped");
  assert.equal(calls.at(-1), "transport closed");
  assert.equal(changes, 1);
  assert.equal(hosts.clients.has("h"), false);
});

test("a timeline snapshot that cannot start watching rejects without leaving its timer", async () => {
  const hosts = new Hosts();
  await assert.rejects(hosts.timelineSnapshot("missing", "a", 60_000));
});

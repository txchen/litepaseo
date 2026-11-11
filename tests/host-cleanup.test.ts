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
  assert.equal(calls.at(-1), "transport closed");
});

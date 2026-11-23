import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { HostLiveness, forceReconnect } from "../src/server/host-liveness.ts";
import { Hosts } from "../src/server/hosts.ts";
import type { TimelineOp } from "../src/shared/wire.ts";

const quiet = <T>(run: (logged: any[]) => Promise<T>) => async () => {
  const logged: any[] = [];
  const original = console.warn;
  console.warn = (line: string) => void logged.push(JSON.parse(line));
  try {
    return await run(logged);
  } finally {
    console.warn = original;
  }
};

test("a silent daemon connection is reopened; an answering one is left alone", quiet(async (logged) => {
  let status = "connected";
  let answer = true;
  let reconnects = 0;
  let now = 0;
  const pings: number[] = [];
  const driver = {
    getConnectionState: () => ({ status }),
    ping: async (options: { timeoutMs: number }) => {
      pings.push(options.timeoutMs);
      if (!answer) throw new Error("timeout");
    },
  };
  const liveness = new HostLiveness(driver, "h", () => void reconnects++, () => now);
  assert.equal(await liveness.check("test"), true);
  assert.equal(reconnects, 0);
  // Checked at most every 10 s, so a struggling host is not pinged in a loop.
  answer = false;
  now = 5_000;
  assert.equal(await liveness.check("test"), true);
  assert.equal(pings.length, 1);
  now = 11_000;
  const [a, b] = [liveness.check("test"), liveness.check("again")];
  assert.equal(await a, false);
  assert.equal(await b, false, "concurrent checks share one ping");
  assert.equal(pings.length, 2);
  assert.equal(reconnects, 1);
  assert.equal(logged.at(-1).event, "host_unresponsive");
  assert.equal(logged.at(-1).hostId, "h");
  // A host already reconnecting is not forced again, and one that is offline is not pinged.
  now = 30_000;
  driver.ping = async () => {
    status = "connecting";
    throw new Error("closed");
  };
  assert.equal(await liveness.check("test"), false);
  assert.equal(reconnects, 1);
  now = 60_000;
  assert.equal(await liveness.check("test"), true);
}));

test("forcing a reconnect uses the SDK liveness path until the connection drops", () => {
  let status = "connected";
  let failures = 0;
  const driver = {
    getConnectionState: () => ({ status }),
    recordLivenessFailure() {
      if (++failures === 2) status = "disconnected";
    },
  };
  forceReconnect(driver);
  assert.equal(failures, 2);
  assert.equal(status, "disconnected");
  // One failed heartbeat already counted: one more call is enough, and no extra is left over.
  status = "connected";
  failures = 1;
  forceReconnect(driver);
  assert.equal(failures, 2);
  forceReconnect({ getConnectionState: () => ({ status: "connected" }) }); // an SDK without it: no-op
});

test("a viewer waiting for rows checks the host and is logged, also when it gives up", quiet(async (logged) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hosts = new Hosts();
    const checks: string[] = [];
    let ready!: () => void;
    const gate = new Promise<void>((r) => (ready = r));
    const driver = {
      getConnectionState: () => ({ status: "connected" }),
      fetchAgentTimeline: async () => {
        await gate;
        return {
          epoch: "e", reset: false, window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null,
          hasOlder: false, hasNewer: false,
          entries: [{ provider: "codex", item: { type: "user_message", text: "hi" }, timestamp: "t", seqStart: 1, seqEnd: 1 }],
        };
      },
    };
    hosts.clients.set("h", { driver, liveness: { check: async (reason: string) => void checks.push(reason) } } as never);
    const t0 = performance.now();
    let clock = 0;
    mock.method(performance, "now", () => t0 + clock);

    // The first viewer leaves before rows arrive: logged as left.
    const stopFirst = hosts.watchTimeline("h", "a1", () => {});
    clock = 2_000;
    mock.timers.tick(2_000);
    assert.deepEqual(checks, ["timeline_wait"]);
    clock = 4_000;
    stopFirst();
    const left = logged.find((l) => l.event === "timeline_wait");
    assert.equal(left.left, true);
    assert.equal(left.freshView, true);
    assert.equal(left.joinedState, "loading");

    // A second viewer joins the same, still loading view and gets rows: no longer fresh.
    const ops: TimelineOp[][] = [];
    const stop = hosts.watchTimeline("h", "a1", (o) => ops.push(o));
    clock = 9_000;
    ready();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(ops[0][0].type, "reset");
    const waited = logged.filter((l) => l.event === "timeline_wait").at(-1);
    assert.deepEqual([waited.left, waited.freshView, waited.waitMs], [false, false, 5000]);
    assert.ok(waited.time);
    // A browser coming back to the live view with nothing new to receive is not waiting.
    const waits = logged.filter((l) => l.event === "timeline_wait").length;
    const resumed: TimelineOp[][] = [];
    const stopResumed = hosts.watchTimeline("h", "a1", (o) => resumed.push(o), undefined, { epoch: "e", seq: 1, from: 1 });
    clock = 20_000;
    stopResumed();
    assert.deepEqual(resumed, [], "nothing changed since: nothing sent");
    assert.equal(logged.filter((l) => l.event === "timeline_wait").length, waits);
    stop();
    mock.method(performance, "now", () => t0);
    await hosts.close();
  } finally {
    mock.timers.reset();
    mock.restoreAll();
  }
}));

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifier, type PushMessage } from "../src/server/notifier.ts";
import { Store } from "../src/server/store.ts";
import type { AgentSummary } from "../src/shared/wire.ts";

const summary = (extra: Partial<AgentSummary> = {}): AgentSummary => ({
  key: "h:a",
  hostId: "h",
  id: "a",
  title: "Fix the tests",
  status: "idle",
  provider: "codex",
  cwd: "/code/repo",
  project: "repo",
  projectKey: null,
  activityAt: 1000,
  attention: false,
  pendingPermissions: [],
  ...extra,
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-notify-"));
  const store = new Store(directory);
  const sent: { endpoint: string; message: PushMessage }[] = [];
  const failing = new Set<string>();
  let now = 1000;
  let viewing = false;
  const notifier = new Notifier({
    store,
    sender: {
      async send(subscription, payload) {
        if (failing.has(subscription.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
        sent.push({ endpoint: subscription.endpoint, message: JSON.parse(payload) });
      },
    },
    isViewing: () => viewing,
    hostLabel: () => "MacBook",
    now: () => now,
  });
  const subscribe = (endpoint: string, prefs = { attention: true, turns: true }) =>
    store.savePushSubscription({ endpoint, sessionId: "s1", p256dh: "k", auth: "a", prefs, created: 0 });
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    store,
    notifier,
    sent,
    failing,
    subscribe,
    settle,
    tick: (ms: number) => (now += ms),
    view: (on: boolean) => (viewing = on),
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("needs-input and turn-end transitions notify; first sight and idle changes do not", async () => {
  const t = setup();
  try {
    t.subscribe("https://push.example/1");
    t.subscribe("https://push.example/2", { attention: true, turns: false });
    t.notifier.transition(null, summary({ status: "running" })); // baseline
    await t.settle();
    assert.equal(t.sent.length, 0);

    const permission = { id: "p1", name: "Bash", title: "run npm test", kind: "tool" };
    t.notifier.transition(summary({ status: "running" }), summary({ status: "running", attention: true, pendingPermissions: [permission] }));
    await t.settle();
    assert.equal(t.sent.length, 2, "attention goes to both devices");
    assert.deepEqual(
      { title: t.sent[0].message.title, body: t.sent[0].message.body, url: t.sent[0].message.url, badge: t.sent[0].message.badge },
      { title: "repo · needs your input", body: "Fix the tests wants to run npm test — MacBook", url: "/?session=h%3Aa", badge: 1 },
    );
    assert.equal(t.notifier.waitingCount, 1);

    t.sent.length = 0;
    t.notifier.transition(summary({ status: "running", attention: true, pendingPermissions: [permission] }), summary({ status: "running" }));
    t.notifier.transition(summary({ status: "running" }), summary({ status: "idle", activityAt: 1000 }));
    await t.settle();
    assert.deepEqual(t.sent.map((s) => [s.endpoint, s.message.title]), [["https://push.example/1", "repo · turn finished"]]);
    assert.equal(t.notifier.waitingCount, 0);

    t.sent.length = 0;
    t.notifier.transition(summary(), summary({ title: "Renamed" }));
    await t.settle();
    assert.equal(t.sent.length, 0, "idle metadata changes are silent");
  } finally {
    t.cleanup();
  }
});

test("failed turns, dedupe, stale ends, viewing suppression and dead subscriptions", async () => {
  const t = setup();
  try {
    t.subscribe("https://push.example/live");
    t.subscribe("https://push.example/dead");
    t.failing.add("https://push.example/dead");
    t.notifier.transition(summary({ status: "running" }), summary({ status: "error" }));
    await t.settle();
    assert.equal(t.sent[0].message.title, "repo · turn failed");
    assert.deepEqual(t.store.pushSubscriptions().map((s) => s.endpoint), ["https://push.example/live"], "410 forgets the device");

    t.sent.length = 0;
    t.notifier.transition(summary({ status: "running" }), summary({ status: "idle" }));
    t.notifier.transition(summary({ status: "running" }), summary({ status: "idle" }));
    await t.settle();
    assert.equal(t.sent.length, 1, "a repeat within the dedupe window is dropped");

    t.tick(20 * 60_000);
    t.sent.length = 0;
    t.notifier.transition(summary({ status: "running" }), summary({ status: "idle", activityAt: 1000 }));
    await t.settle();
    assert.equal(t.sent.length, 0, "a turn end seen long after it happened is not announced");

    t.view(true);
    t.notifier.transition(summary(), summary({ attention: true }));
    await t.settle();
    assert.equal(t.sent.length, 0, "no push for the conversation you are looking at");
    assert.equal(t.notifier.waitingCount, 1, "but the badge count still tracks it");
  } finally {
    t.cleanup();
  }
});

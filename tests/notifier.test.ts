import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notifier, PROJECT_COOLDOWN_MS, type PushMessage } from "../src/server/notifier.ts";
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
  workspaceId: null,
  attention: false,
  state: "done",
  unread: false,
  lastError: null,
  pendingPermissions: [],
  ...extra,
});

function setup(replyPreview?: (agent: AgentSummary, previous: AgentSummary) => Promise<string | null>) {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-notify-"));
  const store = new Store(directory);
  store.addSession({ id: "s1", secretHash: "test", label: "test", created: 0, lastSeen: 0, expires: 1e15 });
  const sent: { endpoint: string; message: PushMessage }[] = [];
  const failing = new Set<string>();
  let now = 1000;
  let timers: { at: number; run: () => void }[] = [];
  let viewing = false;
  const notifier = new Notifier({
    store,
    replyPreview,
    sender: {
      async send(subscription, payload) {
        if (failing.has(subscription.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
        sent.push({ endpoint: subscription.endpoint, message: JSON.parse(payload) });
      },
    },
    isViewing: () => viewing,
    hostLabel: () => "MacBook",
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => { timers = timers.filter((t) => t !== timer); };
    },
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
    tick: (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const timer of due) timer.run();
    },
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
      { title: "repo · needs your input", body: "The agent wants to run npm test — MacBook", url: "/?session=h%3Aa", badge: 1 },
    );
    assert.equal(t.sent[0].message.tag, "project:h:repo", "one notification per project");
    assert.equal(t.notifier.waitingCount, 1);

    t.sent.length = 0;
    t.notifier.transition(summary({ status: "running", attention: true, pendingPermissions: [permission] }), summary({ status: "running" }));
    t.notifier.transition(summary({ status: "running" }), summary({ status: "idle", activityAt: 1000 }));
    await t.settle();
    assert.equal(t.sent.length, 0, "a turn end right after a push for the project waits for the cooldown");
    t.tick(PROJECT_COOLDOWN_MS);
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
    t.tick(PROJECT_COOLDOWN_MS);
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


test("viewing suppresses all devices; expired devices cannot receive pushes", async () => {
  const t = setup();
  try {
    t.subscribe("https://push.example/desktop");
    t.store.addSession({ id: "s2", secretHash: "phone", label: "phone", created: 0, lastSeen: 0, expires: 2000 });
    t.store.savePushSubscription({ endpoint: "https://push.example/phone", sessionId: "s2", p256dh: "k", auth: "a", prefs: { attention: true, turns: true }, created: 0 });
    t.view(true);
    t.notifier.transition(summary(), summary({ attention: true }));
    await t.settle();
    assert.equal(t.sent.length, 0);
    t.view(false);
    t.sent.length = 0;
    t.tick(20_000);
    t.notifier.transition(summary(), summary({ attention: true }));
    await t.settle();
    assert.deepEqual(t.sent.map(s => s.endpoint), ["https://push.example/desktop"]);
    assert.deepEqual(t.store.pushSubscriptions().map(s => s.sessionId), ["s1"]);
  } finally { t.cleanup(); }
});


test("turn notifications use the agent reply, with safe fallback and one lookup for all devices", async () => {
  let reads = 0;
  const t = setup(async () => { reads++; return "Fixed the bug.\nAll tests pass."; });
  try {
    t.subscribe("https://push.example/1"); t.subscribe("https://push.example/2");
    t.notifier.transition(summary({ status: "running" }), summary());
    await t.settle();
    assert.equal(reads, 1);
    assert.equal(t.sent.length, 2);
    assert.equal(t.sent[0].message.body, "Fixed the bug. All tests pass. — MacBook");
  } finally { t.cleanup(); }
  for (const preview of [async () => null, async () => { throw new Error("offline"); }]) {
    const f = setup(preview);
    try {
      f.subscribe("https://push.example/1");
      f.notifier.transition(summary({ status: "running" }), summary());
      await f.settle();
      assert.equal(f.sent[0].message.body, "The agent finished this turn. — MacBook");
    } finally { f.cleanup(); }
  }
});

test("failed turns show their error and viewing suppression avoids timeline reads", async () => {
  let reads = 0;
  const t = setup(async () => { reads++; return "reply"; });
  try {
    t.subscribe("https://push.example/1");
    t.notifier.transition(summary({ status: "running" }), summary({ status: "error", lastError: "Provider unavailable" }));
    await t.settle();
    assert.equal(t.sent[0].message.body, "Provider unavailable — MacBook");
    t.view(true);
    t.notifier.transition(summary({ status: "running" }), summary());
    await t.settle();
    assert.equal(reads, 0);
  } finally { t.cleanup(); }
});


test("viewing is rechecked after preparing the reply preview", async () => {
  let finish!: (value: string) => void;
  const t = setup(() => new Promise(resolve => { finish = resolve; }));
  try {
    t.subscribe("https://push.example/phone");
    t.notifier.transition(summary({ status: "running" }), summary());
    t.view(true);
    finish("Finished");
    await t.settle();
    assert.equal(t.sent.length, 0);
  } finally { t.cleanup(); }
});

const agent = (id: string, title: string, extra: Partial<AgentSummary> = {}) =>
  summary({ key: `h:${id}`, id, title, ...extra });
const finish = (t: ReturnType<typeof setup>, id: string, title: string) =>
  t.notifier.transition(agent(id, title, { status: "running", unread: false }), agent(id, title, { unread: true }));

test("a project's finished turns merge into one push per cooldown; needing input is never held", async () => {
  const t = setup();
  try {
    t.subscribe("https://push.example/phone");
    finish(t, "a", "Fix tests");
    await t.settle();
    assert.deepEqual(t.sent.map((s) => s.message.title), ["repo · turn finished"], "a quiet project's first event goes out at once");

    t.sent.length = 0;
    finish(t, "b", "Docs");
    finish(t, "c", "Refactor");
    t.notifier.transition(agent("x", "Other", { status: "running", project: "other", projectKey: "other" }), agent("x", "Other", { project: "other", projectKey: "other" }));
    await t.settle();
    assert.deepEqual(t.sent.map((s) => s.message.title), ["other · turn finished"], "projects are throttled separately");

    t.sent.length = 0;
    t.tick(PROJECT_COOLDOWN_MS);
    assert.equal(t.sent.length, 1, "one push for the held turns");
    assert.deepEqual(
      { title: t.sent[0].message.title, body: t.sent[0].message.body, tag: t.sent[0].message.tag, url: t.sent[0].message.url },
      {
        title: "repo · 3 finished",
        body: "Done · Refactor: The agent finished this turn.\nDone · Docs: The agent finished this turn.\nDone · Fix tests: The agent finished this turn.\n— MacBook",
        tag: "project:h:repo",
        url: "/?session=h%3Ac",
      },
      "the push lists everything still unseen in the project, newest first",
    );

    t.sent.length = 0;
    t.notifier.transition(agent("a", "Fix tests", { unread: true }), agent("a", "Fix tests")); // opened
    t.notifier.transition(agent("b", "Docs", { unread: true }), agent("b", "Docs", { status: "running" })); // replied
    t.notifier.transition(agent("d", "Deploy", { status: "running" }), agent("d", "Deploy", { status: "running", attention: true }));
    await t.settle();
    assert.deepEqual(
      { title: t.sent[0].message.title, body: t.sent[0].message.body, url: t.sent[0].message.url },
      {
        title: "repo · 1 needs input, 1 finished",
        body: "Needs input · Deploy: The agent is waiting for your input.\nDone · Refactor: The agent finished this turn.\n— MacBook",
        url: "/?session=h%3Ad",
      },
      "input goes out within the cooldown; seen or resumed conversations drop out",
    );

    t.sent.length = 0;
    t.tick(PROJECT_COOLDOWN_MS);
    assert.equal(t.sent.length, 0, "nothing new: no push");
  } finally { t.cleanup(); }
});

test("held turns are dropped when seen before the cooldown ends; long digests are capped", async () => {
  const t = setup();
  try {
    t.subscribe("https://push.example/phone");
    finish(t, "a", "A");
    await t.settle();
    finish(t, "b", "B");
    t.notifier.transition(agent("b", "B", { unread: true }), agent("b", "B"));
    t.sent.length = 0;
    t.tick(PROJECT_COOLDOWN_MS);
    assert.equal(t.sent.length, 0);

    for (const id of ["c", "d", "e", "f", "g"]) finish(t, id, id.toUpperCase());
    await t.settle();
    assert.equal(t.sent.length, 1, "the cooldown had ended: c goes out at once, the rest wait");
    t.sent.length = 0;
    t.tick(PROJECT_COOLDOWN_MS);
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].message.title, "repo · 6 finished");
    assert.match(t.sent[0].message.body, /^Done · G: .*\n.*\n.*\nDone · D: .*\n\+2 more\n— MacBook$/);
  } finally { t.cleanup(); }
});

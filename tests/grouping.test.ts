import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_PITCH,
  DirectoryStore,
  GROUP_PITCH,
  compareAgents,
  groupKey,
} from "../src/web/directory-store.ts";
import { LANES, laneOf, type AgentSummary } from "../src/shared/wire.ts";

const agent = (id: string, project: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
  key: (extra.hostId ?? "h") + ":" + id,
  hostId: "h",
  id,
  title: id,
  status: "idle",
  provider: "codex",
  cwd: "/" + project,
  project,
  projectKey: null,
  activityAt: 0,
  attention: false,
  state: "done",
  unread: false,
  lastError: null,
  pendingPermissions: [],
  ...extra,
});
const describe = (rows: ReturnType<DirectoryStore["groupedRows"]>) =>
  rows.map((r) => (r.kind === "group" ? `[${r.group.name}${r.collapsed ? "+" : ""}]@${r.top}` : `${r.agent.id}@${r.top}`));

test("projects and their sessions are ordered by most recent use, with counters", () => {
  const store = new DirectoryStore();
  store.apply({
    type: "snapshot",
    generation: "g",
    seq: 1,
    agents: [
      agent("a1", "beta", { activityAt: 1 }),
      agent("a2", "Alpha", { activityAt: 2, status: "running" }),
      agent("a3", "beta", { activityAt: 3 }),
      agent("a4", "beta", { activityAt: 0, attention: true }),
    ],
  });
  const G = GROUP_PITCH,
    A = AGENT_PITCH;
  // beta's newest session (a3, t=3) is newer than Alpha's (a2, t=2).
  assert.deepEqual(describe(store.groupedRows(0, 10_000)), [
    "[beta]@0",
    `a3@${G}`,
    `a1@${G + A}`,
    `a4@${G + 2 * A}`,
    `[Alpha]@${G + 3 * A}`,
    `a2@${2 * G + 3 * A}`,
  ]);
  assert.equal(store.groupedHeight, 2 * G + 4 * A);
  assert.equal(store.projectCount, 2);
  const beta = store.groupedRows(0, 1)[0];
  assert.ok(beta.kind === "group" && beta.group.attention === 1 && beta.group.running === 0);

  store.toggleGroup("beta");
  assert.deepEqual(describe(store.groupedRows(0, 2 * G)), ["[beta+]@0", "[Alpha]@" + G]);
  assert.equal(store.groupedHeight, 2 * G + A);
  store.toggleGroup("beta");

  // Using an Alpha session moves Alpha to the top; moving its last session away removes it.
  store.apply({ type: "changes", generation: "g", seq: 2, changes: [{ key: "h:a2", value: agent("a2", "Alpha", { activityAt: 5 }) }] });
  assert.equal(describe(store.groupedRows(0, 1))[0], "[Alpha]@0");
  store.apply({
    type: "changes",
    generation: "g",
    seq: 3,
    changes: [{ key: "h:a2", value: agent("a2", "gamma", { activityAt: 9 }) }],
  });
  assert.deepEqual(
    describe(store.groupedRows(0, 10_000)).filter((r) => r.startsWith("[")),
    ["[gamma]@0", `[beta]@${G + A}`],
  );
});

test("randomized: windows over the grouped view match a brute-force layout", () => {
  let seed = 9;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const collapsed = new Set<string>();
  const store = new DirectoryStore({ collapsed: [], persist: () => {} });
  const live = new Map<string, AgentSummary>();
  let filter: string | null = null;
  let host: string | null = null;
  const hostIds = ["mac", "build", "gpu"];
  store.apply({ type: "snapshot", generation: "g", seq: 0, agents: [] });
  const projects = ["api", "Web", "infra", "docs", "mobile", "data", "ops", "x"];
  for (let step = 1; step <= 3000; step++) {
    const r = random();
    if (r < 0.75) {
      const n = Math.floor(random() * 300);
      const id = "a" + n;
      const hostId = hostIds[n % 3];
      const value =
        random() < 0.85
          ? agent(id, projects[Math.floor(random() * projects.length)], {
              hostId,
              activityAt: Math.floor(random() * 50),
              status: random() < 0.2 ? "running" : "idle",
              state: (["needs_input", "running", "failed", "unread", "done"] as const)[Math.floor(random() * 5)],
              attention: random() < 0.1,
            })
          : null;
      const key = hostId + ":" + id;
      if (value) live.set(key, value);
      else live.delete(key);
      store.apply({ type: "changes", generation: "g", seq: step, changes: [{ key, value }] });
    } else if (r < 0.85) {
      const key = projects[Math.floor(random() * projects.length)].toLowerCase();
      store.toggleGroup(key);
      if (!filter) collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    } else if (r < 0.88) {
      host = random() < 0.4 ? null : hostIds[Math.floor(random() * 3)];
      store.setHost(host);
    } else if (r < 0.92) {
      filter = random() < 0.5 ? null : String(Math.floor(random() * 10));
      const f = filter;
      store.setFilter(f === null ? null : (a) => a.id.includes(f));
    }
    if (step % 50 !== 0) continue;
    // Reference layout: group, sort, and stack everything.
    const visible = [...live.values()].filter(
      (a) => (host === null || a.hostId === host) && (filter === null || a.id.includes(filter)),
    );
    const groups = new Map<string, AgentSummary[]>();
    for (const a of visible) groups.set(groupKey(a), [...(groups.get(groupKey(a)) ?? []), a]);
    const recent = (members: AgentSummary[]) => Math.max(...members.map((a) => a.activityAt));
    const ordered = [...groups.entries()].sort(
      ([ka, a], [kb, b]) =>
        recent(b) - recent(a) ||
        a[0].project.localeCompare(b[0].project, undefined, { sensitivity: "base", numeric: true }) ||
        (ka < kb ? -1 : 1),
    );
    const expected: string[] = [];
    let top = 0;
    for (const [key, members] of ordered) {
      const isCollapsed = filter === null && collapsed.has(key);
      expected.push(`[${members[0].project}${isCollapsed ? "+" : ""}]@${top}`);
      top += GROUP_PITCH;
      if (isCollapsed) continue;
      for (const a of members.sort(compareAgents)) {
        expected.push(`${a.id}@${top}`);
        top += AGENT_PITCH;
      }
    }
    assert.equal(store.size, visible.length, `size at step ${step}`);
    assert.deepEqual(
      store.range(0, visible.length).map((a) => a.key),
      [...visible].sort(compareAgents).map((a) => a.key),
      `recent order at step ${step}`,
    );
    assert.equal(store.groupedHeight, top, `height at step ${step}`);
    for (const lane of LANES) {
      const want = visible.filter((x) => laneOf(x.state) === lane).sort(compareAgents).map((x) => x.key);
      assert.equal(store.laneSize(lane), want.length, `lane ${lane} size at step ${step}`);
      assert.deepEqual(store.laneRange(lane, 0, want.length).map((x) => x.key), want, `lane ${lane} at step ${step}`);
    }
    assert.deepEqual(describe(store.groupedRows(0, top + 1)), expected, `layout at step ${step}`);
    // A random window returns exactly the rows that intersect it.
    const from = Math.floor(random() * Math.max(1, top));
    const span = 50 + Math.floor(random() * 400);
    const windowed = expected.filter((row) => {
      const at = Number(row.split("@")[1]);
      const pitch = row.startsWith("[") ? GROUP_PITCH : AGENT_PITCH;
      return at + pitch > from && at < from + span;
    });
    assert.deepEqual(describe(store.groupedRows(from, span)), windowed, `window at step ${step}`);
  }
});

test("grouped updates stay logarithmic with thousands of projects", () => {
  const store = new DirectoryStore();
  const agents = Array.from({ length: 50_000 }, (_, i) => agent("a" + i, "project-" + (i % 2000), { activityAt: i }));
  store.apply({ type: "snapshot", generation: "g", seq: 1, agents });
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) {
    const n = i % 50_000;
    store.apply({
      type: "changes",
      generation: "g",
      seq: i + 2,
      changes: [{ key: "h:a" + n, value: agent("a" + n, "project-" + ((n + i) % 2000), { activityAt: 100_000 + i }) }],
    });
    if (i % 100 === 0) store.groupedRows(store.groupedHeight / 2, 900);
  }
  assert.ok(performance.now() - started < 2000, "20k grouped changes must not scale with the directory");
  assert.equal(store.size, 50_000);
});

test("switching hosts does not rescan the directory", () => {
  const store = new DirectoryStore();
  const agents = Array.from({ length: 60_000 }, (_, i) =>
    agent("a" + i, "p" + (i % 300), { hostId: "h" + (i % 3), activityAt: i }),
  );
  store.apply({ type: "snapshot", generation: "g", seq: 1, agents });
  assert.equal(store.hostSize("h1"), 20_000);
  const started = performance.now();
  for (let i = 0; i < 30_000; i++) store.setHost(i % 4 === 3 ? null : "h" + (i % 4));
  assert.ok(performance.now() - started < 200, "host switches must be O(1)");
  store.setHost("h2");
  assert.equal(store.size, 20_000);
  assert.ok(store.range(0, 50).every((a) => a.hostId === "h2"));
  assert.ok(
    store.groupedRows(0, 2000).every((r) => r.kind === "group" || r.agent.hostId === "h2"),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lp-queue-")), store = new Store(dir), hosts = new Hosts();
  const sends: any[] = [];
  let connected = true, fail = false;
  let pending: Promise<void> | undefined, release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  hosts.onAgentsChanged = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const update = (running: boolean) => {
    hosts.agents.set("h:a", { key: "h:a", hostId: "h", id: "a", status: running ? "running" : "idle", turnActive: running, activityAt: 0 } as any);
    for (const listener of listeners) listener();
  };
  hosts.clients.set("h", { directory: { facts: () => ({ provider: "codex", capabilities: { supportsImages: true } }) },
    driver: { getConnectionState: () => ({ status: connected ? "connected" : "disconnected" }) },
    api: { agents: { ref: () => ({ send: async (text: string, options: any) => {
      sends.push({ text, options });
      if (pending) await pending;
      if (fail) throw new Error("lost ack");
    } }) } } } as any);
  update(true);
  let app = createApp(store, hosts, "test-token", "/missing");
  const request = async (suffix: string, method = "GET", body?: unknown) => app.request("/api/hosts/h/agents/a/" + suffix, {
    method, headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { store, hosts, sends, update, request,
    changes: (cwd: string) => app.request('/api/hosts/h/changes?cwd=' + encodeURIComponent(cwd), { headers: { authorization: 'Bearer test-token' } }),
    upload: (body: Buffer) => app.request("/api/hosts/h/agents/a/attachments", {
      method: "POST", headers: { authorization: "Bearer test-token", "x-file-name": "image.png", "content-type": "image/png" }, body: new Uint8Array(body),
    }),
    enqueue: (text: string, id = randomUUID(), attachmentIds: string[] = []) => request("queue", "POST", { text, id, attachmentIds }),
    hold: () => { pending = new Promise<void>(resolve => { release = resolve; }); },
    release: () => release?.(),
    offline: () => { connected = false; }, online: () => { connected = true; }, fail: () => { fail = true; },
    restart: () => { app.dispose(); app = createApp(store, hosts, "test-token", "/missing"); },
    close: () => { app.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("BFF delivers without browser activity, one message per observed turn, and restores queue after restart", async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    assert.equal((await f.enqueue("first", id)).status, 201);
    await f.enqueue("second");
    f.restart();
    assert.equal((await (await f.request("queue")).json()).length, 2);
    assert.equal(f.sends.length, 0);
    f.offline(); f.update(false); await settle();
    assert.equal(f.sends.length, 0);
    f.online(); f.update(false); await settle();
    assert.deepEqual(f.sends.map(s => s.text), ["first"]);
    f.update(false); await settle();
    assert.equal(f.sends.length, 1, "stale idle does not drain the queue");
    f.update(true); f.update(false); await settle();
    assert.deepEqual(f.sends.map(s => s.text), ["first", "second"]);
    assert.equal((await f.enqueue("first", id)).status, 200, "lost enqueue response can be retried after delivery");
    assert.equal((await (await f.request("queue")).json()).length, 0);
  } finally { f.close(); }
});

test("unknown delivery pauses the head across restart, edits preserve attachments, explicit removal resumes", async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    await f.enqueue("first", id); await f.enqueue("second");
    f.fail(); f.update(false); await settle();
    const rows = await (await f.request("queue")).json();
    assert.match(rows[0].error, /unknown/);
    f.restart(); f.update(false); await settle();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.request(`queue/${id}`, "PATCH", { text: "edited" })).status, 200);
    assert.equal((await (await f.request("queue")).json())[0].text, "edited");
    await f.request(`queue/${id}`, "DELETE"); await settle();
    assert.equal(f.sends.length, 2);
  } finally { f.close(); }
});

test("queued images survive staging cleanup and BFF restart", async () => {
  const f = fixture();
  try {
    const png = Buffer.from([137,80,78,71,13,10,26,10]);
    const file = await (await f.upload(png)).json();
    const id = randomUUID();
    await f.enqueue("image", id, [file.id]);
    await f.request(`queue/${id}`, "PATCH", { text: "edited image" });
    f.restart();
    const list = await (await f.request("queue")).json();
    assert.deepEqual(list[0].attachmentNames, ["image.png"]);
    assert.equal(list[0].prepared, undefined, "payload is not exposed by list API");
    f.update(false); await settle();
    assert.equal(f.sends[0].text, "edited image");
    assert.equal(f.sends[0].options.images[0].data, png.toString("base64"));
  } finally { f.close(); }
});


test("restart during dispatch pauses uncertain message; edits and deletion cannot race a send", async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    await f.enqueue("in flight", id); await f.enqueue("later");
    f.hold(); f.update(false);
    assert.equal((await f.request(`queue/${id}`, "DELETE")).status, 409);
    assert.equal((await f.request(`queue/${id}`, "PATCH", { text: "changed" })).status, 409);
    f.restart();
    const rows = await (await f.request("queue")).json();
    assert.match(rows[0].error, /unknown after restart/);
    f.release(); await settle(); f.update(false); await settle();
    assert.equal(f.sends.length, 1, "no duplicate or following message after an uncertain restart");
  } finally { f.release(); f.close(); }
});


test("queue pause survives restart, ordering is editable, resume dispatches only the head", async () => {
  const f = fixture();
  try {
    const a = randomUUID(), b = randomUUID();
    await f.enqueue("first", a); await f.enqueue("second", b);
    const control = (id: string, action: string) => f.request(`queue/${id}/control`, "POST", { action });
    await control(b, "up"); await control(b, "pause");
    f.restart(); f.update(false); await settle();
    assert.equal(f.sends.length, 0);
    const rows = await (await f.request("queue")).json();
    assert.deepEqual(rows.map((r: any) => r.id), [b, a]);
    assert.equal(rows[0].paused, true);
    assert.equal(f.store.setting("send-queue"), null);
    await control(b, "resume"); await settle();
    assert.deepEqual(f.sends.map(s => s.text), ["second"]);
    f.update(true); f.update(false); await settle();
    assert.deepEqual(f.sends.map(s => s.text), ["second", "first"]);
  } finally { f.close(); }
});

test("delivery check removes only positively confirmed messages and resumes queue", async () => {
  const f = fixture();
  try {
    const id = randomUUID(); await f.enqueue("first", id);
    f.fail(); f.update(false); await settle();
    let found = false;
    (f.hosts.get("h").driver as any).fetchAgentTimeline = async () => ({ entries: found ? [{item: {type: "user_message", clientMessageId: id}}] : [], hasOlder: false, startCursor: null });
    assert.equal((await f.request(`queue/${id}/control`, "POST", {action: "check"})).status, 409);
    assert.equal((await (await f.request("queue")).json()).length, 1);
    found = true;
    assert.equal((await f.request(`queue/${id}/control`, "POST", {action: "check"})).status, 200);
    assert.equal((await (await f.request("queue")).json()).length, 0);
    assert.equal(f.sends.length, 1);
  } finally { f.close(); }
});

test("search and diff route requests to the selected host without mutations", async () => {
  const f = fixture();
  try {
    const driver = f.hosts.get("h").driver as any;
    driver.searchAgentTimeline = async (input: any) => {
      assert.deepEqual(input, {agentId: "a", query: "needle", cursor: 42});
      return {epoch: "e", locations: [{seq: 12, role: "assistant"}], nextCursor: null, error: null};
    };
    const response = await f.request("search?q=needle&cursor=42");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).locations[0].seq, 12);
    assert.equal((await f.request("search?q=")).status, 400);
    driver.getCheckoutDiff = async (cwd: string, options: unknown) => {
      assert.equal(cwd, '/workspace'); assert.deepEqual(options, {mode: 'uncommitted'});
      return {files: [{path: 'code.ts', additions: 1, deletions: 0, hunks: []}], error: null};
    };
    assert.equal((await (await f.changes('/workspace')).json()).files[0].path, 'code.ts');
    driver.getCheckoutDiff = async () => ({error: {message: 'Not a Git repository'}});
    assert.equal((await f.changes('/workspace')).status, 409);
  } finally { f.close(); }
});


test("legacy queue migrates atomically and removed payloads do not return after restart", async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    f.store.setSetting('send-queue', JSON.stringify([{id, host: 'h', agent: 'a', text: 'legacy', attachmentNames: [], prepared: {images: [], attachments: []}}]));
    f.restart();
    assert.equal((await (await f.request('queue')).json())[0].text, 'legacy');
    await f.request(`queue/${id}`, 'DELETE');
    f.restart();
    assert.equal((await (await f.request('queue')).json()).length, 0);
    assert.equal(f.store.setting(`send-queue-entry:${id}`), null);
  } finally { f.close(); }
});


test("delivery verification excludes concurrent retry, edit, reorder and removal", async () => {
  const f = fixture();
  let release!: (value: any) => void;
  try {
    const id = randomUUID(), second = randomUUID();
    await f.enqueue('first', id); await f.enqueue('later', second);
    f.fail(); f.update(false); await settle();
    (f.hosts.get('h').driver as any).fetchAgentTimeline = () => new Promise(resolve => { release = resolve; });
    const check = f.request(`queue/${id}/control`, 'POST', { action: 'check' });
    await settle();
    assert.equal((await f.request(`queue/${id}/send`, 'POST')).status, 409);
    assert.equal((await f.request(`queue/${id}`, 'DELETE')).status, 409);
    assert.equal((await f.request(`queue/${id}`, 'PATCH', {text: 'changed'})).status, 409);
    assert.equal((await f.request(`queue/${second}/control`, 'POST', { action: 'up' })).status, 409);
    release({entries: [{item: {type: 'user_message', clientMessageId: id}}], hasOlder: false, startCursor: null});
    assert.equal((await check).status, 200);
    await settle();
    assert.deepEqual(f.sends.map(s => s.text), ['first', 'later']);
  } finally { f.close(); }
});

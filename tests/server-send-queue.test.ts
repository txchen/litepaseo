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

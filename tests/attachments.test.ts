import test from "node:test";
import assert from "node:assert/strict";
import { Attachments, MAX_FILE_BYTES } from "../src/server/attachments.ts";
import { Hosts } from "../src/server/hosts.ts";
import { Store } from "../src/server/store.ts";
import { createApp } from "../src/server/app.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function fakeHosts() {
  const hosts = new Hosts(), uploads: string[] = [], sends: any[] = [];
  let provider = "codex";
  const agent = { refresh: async () => {}, current: () => ({ provider }), capabilities: { supportsToolInvocations: true },
    send: async (text: string, options: any) => { sends.push({ text, options }); } };
  hosts.clients.set("h", { api: { agents: { ref: () => agent } }, driver: {
    getConnectionState: () => ({ status: "connected" }),
    uploadFile: async (input: any) => { uploads.push(Buffer.from(input.bytes).toString()); return { file: { type: "uploaded_file", id: "remote", fileName: input.fileName, mimeType: input.mimeType, size: input.bytes.length, path: "/daemon/upload/file" }, error: null }; },
  } } as never);
  return { hosts, uploads, sends, provider: (value: string) => { provider = value; } };
}

test("attachment staging enforces ownership, limits, expiry and image signatures; upload happens only on send", async () => {
  const store = new Attachments(), fixture = fakeHosts();
  try {
    const file = store.put("owner", "h", "a", "notes.txt", "text/plain", Buffer.from("contents"));
    assert.equal(fixture.uploads.length, 0);
    for (const [owner, host, agent] of [["other", "h", "a"], ["owner", "other", "a"], ["owner", "h", "other"]])
      assert.throws(() => store.get(file.id, owner, host, agent), /another session/);
    assert.throws(() => store.put("o", "h", "a", "../file", "text/plain", Buffer.from("x")), /path/);
    assert.throws(() => store.put("o", "h", "a", "fake.png", "image/png", Buffer.from("not an image")), /content/);
    assert.throws(() => store.put("o", "h", "a", "big", "text/plain", Buffer.alloc(MAX_FILE_BYTES + 1)), /8 MiB/);
    const prepared = await store.prepare(fixture.hosts, "owner", "h", "a", [file.id]);
    assert.equal(prepared.attachments[0].path, "/daemon/upload/file");
    await store.prepare(fixture.hosts, "owner", "h", "a", [file.id]);
    assert.deepEqual(fixture.uploads, ["contents"], "retry preparation reuses the daemon upload");
    store.consumed([file.id]);
    assert.throws(() => store.get(file.id, "owner", "h", "a"), /expired/);
    const expire = store.put("owner", "h", "a", "old.txt", "text/plain", Buffer.from("old"));
    store.get(expire.id, "owner", "h", "a").expires = 0;
    assert.throws(() => store.get(expire.id, "owner", "h", "a"), /expired/);
    fixture.provider("unknown");
    assert.equal((await store.capabilities(fixture.hosts, "h", "a")).images, false);
  } finally { store.close(); }
});

test("BFF accepts attachment-only messages and forwards native images and uploaded files", async () => {
  const root = mkdtempSync(join(tmpdir(), "lp-attachment-api-")), store = new Store(root), fixture = fakeHosts();
  const app = createApp(store, fixture.hosts, "test", root, { pushSender: { async send() {} } });
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  try {
    const upload = await app.request("/api/hosts/h/agents/a/attachments", { method: "POST", headers: { ...headers, "content-type": "text/plain", "x-file-name": "readme.txt" }, body: "HELLO_FILE" });
    assert.equal(upload.status, 201);
    const file = await upload.json();
    const image = await app.request("/api/hosts/h/agents/a/attachments", { method: "POST", headers: { ...headers, "content-type": "image/png", "x-file-name": "pixel.png" }, body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZk0AAAAASUVORK5CYII=", "base64") });
    const img = await image.json();
    const messageId = randomUUID();
    const sent = await app.request("/api/hosts/h/agents/a/messages", { method: "POST", headers, body: JSON.stringify({ text: "", messageId, behavior: "steer", attachmentIds: [file.id, img.id] }) });
    assert.equal(sent.status, 200);
    assert.deepEqual(fixture.uploads, ["HELLO_FILE"]);
    assert.equal(fixture.sends[0].options.messageId, messageId);
    assert.equal(fixture.sends[0].options.images[0].mimeType, "image/png");
    assert.equal(fixture.sends[0].options.attachments[0].fileName, "readme.txt");
    const retry = await app.request("/api/hosts/h/agents/a/messages", { method: "POST", headers, body: JSON.stringify({ text: "", messageId: randomUUID(), behavior: "steer", attachmentIds: [file.id] }) });
    assert.equal(retry.status, 400);
    assert.equal((await retry.json()).delivery, "not-sent");
    assert.equal(fixture.sends.length, 1);
  } finally { app.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

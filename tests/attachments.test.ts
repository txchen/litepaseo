import test from "node:test";
import assert from "node:assert/strict";
import { Attachments, MAX_FILE_BYTES, MAX_FILES_PER_OWNER } from "../src/server/attachments.ts";
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
  const facts = new Map<string, unknown>();
  const agent = { refresh: async () => {}, current: () => ({ provider }), capabilities: { supportsToolInvocations: true },
    send: async (text: string, options: any) => { sends.push({ text, options }); } };
  hosts.clients.set("h", { directory: { facts: (id: string) => facts.get(id) }, api: { agents: { ref: () => agent } }, driver: {
    getConnectionState: () => ({ status: "connected" }),
    uploadFile: async (input: any) => { uploads.push(Buffer.from(input.bytes).toString()); return { file: { type: "uploaded_file", id: "remote", fileName: input.fileName, mimeType: input.mimeType, size: input.bytes.length, path: "/daemon/upload/file" }, error: null }; },
  } } as never);
  return { hosts, uploads, sends, facts, provider: (value: string) => { provider = value; }, agent };
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

test("capabilities come from the live directory without a daemon round trip", async () => {
  const store = new Attachments(), fixture = fakeHosts();
  let refreshes = 0;
  fixture.agent.refresh = async () => { refreshes++; };
  fixture.facts.set("a", { provider: "pi", capabilities: { supportsImages: true, supportsToolInvocations: false } });
  try {
    assert.deepEqual(await store.capabilities(fixture.hosts, "h", "a").then(c => [c.images, c.files]), [true, false]);
    assert.equal(refreshes, 0);
    await store.capabilities(fixture.hosts, "h", "not-listed");
    assert.equal(refreshes, 1, "only an agent outside the directory is fetched");
  } finally { store.close(); }
});

test("staging limits the number of files and keeps byte totals exact across removal and expiry", () => {
  const store = new Attachments();
  try {
    const ids = Array.from({ length: MAX_FILES_PER_OWNER }, (_, i) => store.put("o", "h", "a", `f${i}`, "text/plain", Buffer.alloc(1024 * 1024)).id);
    assert.throws(() => store.put("o", "h", "a", "one-more", "text/plain", Buffer.from("x")), /full/);
    store.put("other", "h", "a", "theirs", "text/plain", Buffer.from("x")); // a different session is unaffected
    store.remove(ids[0], "o", "h", "a");
    store.put("o", "h", "a", "replacement", "text/plain", Buffer.from("x"));
    store.consumed(ids.slice(1));
    // 24 MiB per session is available again once files are gone.
    for (let i = 0; i < 2; i++) store.put("o", "h", "a", `big${i}`, "text/plain", Buffer.alloc(MAX_FILE_BYTES));
    store.clearOwner("o");
    for (let i = 0; i < 3; i++) store.put("o", "h", "a", `again${i}`, "text/plain", Buffer.alloc(MAX_FILE_BYTES));
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

test("a failed operation is logged with its path, route and error, without the query string", async () => {
  const root = mkdtempSync(join(tmpdir(), "lp-error-log-")), store = new Store(root), fixture = fakeHosts();
  const app = createApp(store, fixture.hosts, "test", root, { pushSender: { async send() {} } });
  const logged: string[] = [], original = console.error;
  console.error = (line: string) => { logged.push(line); };
  try {
    // The fake driver has no cancelAgent, so the operation throws.
    const response = await app.request("/api/hosts/h/agents/a/stop?secret=1", { method: "POST", headers: { authorization: "Bearer test" } });
    assert.equal(response.status, 502);
    const entry = JSON.parse(logged.find(l => l.includes("api_operation_failed"))!);
    assert.equal(entry.requestId, (await response.json()).requestId);
    assert.equal(entry.path, "/api/hosts/h/agents/a/stop");
    assert.equal(entry.route, "/api/hosts/:host/agents/:agent/stop");
    assert.equal(entry.error, "TypeError");
    assert.match(entry.message, /cancelAgent/);
    assert.ok(!JSON.stringify(entry).includes("secret"));
  } finally { console.error = original; app.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

import { withMessageImages, messageImage, saveMessageImages } from "../src/server/message-images.ts";
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
  hosts.agents.set("h:a", { key: "h:a", hostId: "h", id: "a", status: "idle", turnActive: false } as any);
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
    const sent = await app.request("/api/hosts/h/agents/a/messages", { method: "POST", headers, body: JSON.stringify({ text: "", messageId, behavior: "send", attachmentIds: [file.id, img.id] }) });
    assert.equal(sent.status, 200);
    assert.deepEqual(fixture.uploads, ["HELLO_FILE"]);
    assert.equal(fixture.sends[0].options.messageId, messageId);
    assert.equal(fixture.sends[0].options.images[0].mimeType, "image/png");
    assert.equal(fixture.sends[0].options.attachments[0].fileName, "readme.txt");
    const enriched = withMessageImages(store, "h", "a", { type: "user_message", clientMessageId: messageId });
    const url = (enriched.imageUrls as string[])[0];
    const downloaded = await app.request(url, { headers });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString("base64"), fixture.sends[0].options.images[0].data);
    assert.equal((await app.request(url)).status, 401);
    assert.equal((await app.request(url.replace("/agents/a/", "/agents/other/"), { headers })).status, 404);
    const retry = await app.request("/api/hosts/h/agents/a/messages", { method: "POST", headers, body: JSON.stringify({ text: "", messageId: randomUUID(), behavior: "send", attachmentIds: [file.id] }) });
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

test("message images survive restart, scope IDs and preserve the original on retries", () => {
  const root = mkdtempSync(join(tmpdir(), "lp-message-images-"));
  let store = new Store(root);
  try {
    const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
    saveMessageImages(store, "host", "agent", "id", images);
    store.close(); store = new Store(root);
    assert.deepEqual(messageImage(store, "host", "agent", "id", 0), images[0]);
    assert.equal(messageImage(store, "other", "agent", "id", 0), null);
    saveMessageImages(store, "host", "agent", "id", [{ data: "different", mimeType: "image/jpeg" }]);
    assert.deepEqual(messageImage(store, "host", "agent", "id", 0), images[0]);
    assert.equal((withMessageImages(store, "host", "agent", { type: "user_message", messageId: "id" }).imageUrls as string[]).length, 1);
    assert.equal(withMessageImages(store, "host", "agent", { type: "assistant_message", messageId: "id" }).imageUrls, undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an image type in any case or spacing is still checked against its content; dot names are refused", () => {
  const store = new Attachments();
  try {
    for (const mime of ["IMAGE/PNG", " image/png ", "Image/Jpeg"])
      assert.throws(() => store.put("o", "h", "a", "fake.png", mime, Buffer.from("not an image")), /content/, mime);
    for (const name of [".", ".."]) assert.throws(() => store.put("o", "h", "a", name, "text/plain", Buffer.from("x")), /path/);
    const png = store.put("o", "h", "a", "ok.png", "IMAGE/PNG", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.mimeType, "image/png");
  } finally { store.close(); }
});

test("new sessions can stage and send pasted images and files on the first message", async () => {
  const root = mkdtempSync(join(tmpdir(), "lp-draft-attach-")), store = new Store(root), fixture = fakeHosts();
  const createdCalls: any[] = [];
  const client = fixture.hosts.clients.get("h") as any;
  client.api.agents.create = async (options: any) => {
    createdCalls.push(options);
    return { id: "new-1" };
  };
  const app = createApp(store, fixture.hosts, "test", root, { pushSender: { async send() {} } });
  const headers = { authorization: "Bearer test", "content-type": "application/json" };
  try {
    // 1. Draft capabilities reflect provider image support.
    const claudeCaps = await (await app.request("/api/hosts/h/draft/claude/attachments/capabilities", { headers })).json();
    assert.equal(claudeCaps.images, true);
    assert.equal(claudeCaps.files, true);
    const otherCaps = await (await app.request("/api/hosts/h/draft/other/attachments/capabilities", { headers })).json();
    assert.equal(otherCaps.images, false);
    assert.equal(otherCaps.files, true);

    // 2. Stage a PNG image and a text file against the draft scope.
    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const imgRes = await app.request("/api/hosts/h/draft/claude/attachments", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "image/png", "x-file-name": encodeURIComponent("shot.png") },
      body: pngBytes,
    });
    assert.equal(imgRes.status, 201);
    const img = await imgRes.json();

    const txtRes = await app.request("/api/hosts/h/draft/claude/attachments", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "text/plain", "x-file-name": encodeURIComponent("notes.txt") },
      body: Buffer.from("hello draft"),
    });
    assert.equal(txtRes.status, 201);
    const txt = await txtRes.json();

    // 3. Attempting to send a staged image to a non-image provider fails cleanly before creating an agent.
    const badProvider = await app.request("/api/hosts/h/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        cwd: "/repo",
        provider: "other",
        model: "m1",
        prompt: "Look at this",
        attachmentIds: [img.id],
      }),
    });
    assert.equal(badProvider.status, 400);
    assert.equal((await badProvider.json()).delivery, "not-sent");
    assert.equal(createdCalls.length, 0);

    // 4. Creating with claude forwards images, uploaded file attachment, and clientMessageId, and persists images.
    const clientMessageId = randomUUID();
    const createRes = await app.request("/api/hosts/h/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        clientMessageId,
        cwd: "/repo",
        provider: "claude",
        model: "claude-opus-4",
        prompt: "",
        attachmentIds: [img.id, txt.id],
      }),
    });
    assert.equal(createRes.status, 201);
    assert.equal(createdCalls.length, 1);
    assert.equal(createdCalls[0].clientMessageId, clientMessageId);
    assert.equal(createdCalls[0].images.length, 1);
    assert.equal(createdCalls[0].images[0].data, pngBytes.toString("base64"));
    assert.equal(createdCalls[0].attachments.length, 1);
    assert.equal(createdCalls[0].attachments[0].path, "/daemon/upload/file");

    // 5. Persisted image is served via message-images endpoint and staged IDs are consumed.
    const enriched = withMessageImages(store, "h", "new-1", { type: "user_message", clientMessageId });
    assert.equal((enriched.imageUrls as string[]).length, 1);
    const fetched = await app.request((enriched.imageUrls as string[])[0]!, { headers });
    assert.equal(fetched.status, 200);
    assert.equal(Buffer.from(await fetched.arrayBuffer()).toString("base64"), pngBytes.toString("base64"));

    const delAfterConsume = await app.request(`/api/hosts/h/draft/claude/attachments/${img.id}`, { method: "DELETE", headers });
    assert.equal(delAfterConsume.status, 404);
  } finally { app.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

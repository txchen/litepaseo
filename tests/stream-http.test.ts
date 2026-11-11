import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";

test("over real HTTP, stream events arrive immediately and a disconnect releases the stream", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-http-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const app = createApp(store, hosts, "t", directory);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    const controller = new AbortController();
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
      headers: { authorization: "Bearer t" },
      signal: controller.signal,
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes('"type":"snapshot"')) text += (await reader.read()).value ?? "";
    assert.ok(performance.now() - started < 1000, "initial events must not be buffered");
    assert.equal(app.openStreams(), 1);
    controller.abort();
    await reader.cancel().catch(() => {});
    for (let i = 0; i < 50 && app.openStreams(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(app.openStreams(), 0, "the server must drop a stream whose client went away");
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

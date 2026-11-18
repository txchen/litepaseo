import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressJson, MIN_COMPRESSED_BYTES } from "../src/server/compression.ts";

function app(enabled = true) {
  const a = new Hono();
  a.use("/api/*", compressJson(enabled));
  a.get("/api/big", (c) => c.json({ rows: "row ".repeat(2000) }));
  a.get("/api/small", (c) => c.json({ ok: true }));
  a.get("/api/text", (c) => c.text("plain ".repeat(2000)));
  return a;
}
const get = (a: Hono, path: string, acceptEncoding = "gzip, deflate, br") => a.request(path, { headers: { "Accept-Encoding": acceptEncoding } });

test("JSON over 1 KB is compressed with what the browser accepts; it decodes to the same body", async () => {
  const expected = JSON.stringify({ rows: "row ".repeat(2000) });
  const br = await get(app(), "/api/big");
  assert.equal(br.headers.get("content-encoding"), "br");
  assert.equal(br.headers.get("vary"), "Accept-Encoding");
  assert.equal(br.headers.get("content-type"), "application/json");
  const brBody = Buffer.from(await br.arrayBuffer());
  assert.ok(brBody.byteLength < expected.length / 10, "much smaller on the wire");
  assert.equal(brotliDecompressSync(brBody).toString(), expected);
  const gz = await get(app(), "/api/big", "gzip");
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), expected);
});

test("small JSON, other content, browsers that accept nothing and compression off go out unchanged", async () => {
  assert.ok(JSON.stringify({ ok: true }).length < MIN_COMPRESSED_BYTES);
  const small = await get(app(), "/api/small");
  assert.equal(small.headers.get("content-encoding"), null);
  assert.deepEqual(await small.json(), { ok: true });
  assert.equal((await get(app(), "/api/text")).headers.get("content-encoding"), null);
  assert.equal((await get(app(), "/api/big", "identity")).headers.get("content-encoding"), null);
  const off = await get(app(false), "/api/big");
  assert.equal(off.headers.get("content-encoding"), null);
  assert.equal((await off.json()).rows.length, 8000);
});

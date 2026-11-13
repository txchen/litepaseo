import test from "node:test";
import assert from "node:assert/strict";
import { importProjectIcon, iconCandidates } from "../src/server/project-icon-import.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const respond = (body: BodyInit | null, type: string, status = 200, url = "") => {
  const response = new Response(body, { status, headers: { "content-type": type } });
  if (url) Object.defineProperty(response, "url", { value: url });
  return response;
};

test("an image URL becomes base64 bytes as served", async () => {
  const seen: string[] = [];
  const data = await importProjectIcon(" https://example.com/logo.png ", async (u) => (seen.push(String(u)), respond(PNG, "image/png")));
  assert.equal(data, PNG.toString("base64"));
  assert.deepEqual(seen, ["https://example.com/logo.png"]);
});

test("a website URL uses its declared raster icons, then /favicon.ico", async () => {
  const html = `<html><head>
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    <link rel="apple-touch-icon" href="/apple.png">
  </head></html>`;
  const seen: string[] = [];
  const data = await importProjectIcon("https://example.com/docs/", async (u) => {
    const url = String(u);
    seen.push(url);
    if (url === "https://example.com/docs/") return respond(html, "text/html; charset=utf-8");
    if (url.endsWith("/apple.png")) return respond(null, "text/plain", 404);
    return respond(PNG, "image/x-icon");
  });
  assert.equal(data, PNG.toString("base64"));
  assert.deepEqual(seen, ["https://example.com/docs/", "https://example.com/apple.png", "https://example.com/favicon.ico"]);
  assert.deepEqual(
    iconCandidates(`<link href='a.png' rel='shortcut icon'><link rel="icon" href="javascript:x">`, new URL("https://x.dev/p/")).map(String),
    ["https://x.dev/p/a.png", "https://x.dev/favicon.ico"],
    "relative hrefs resolve against the page; non-http candidates are dropped",
  );
});

test("bad URLs, failures and oversized downloads are explained", async () => {
  await assert.rejects(importProjectIcon("not a url"), /valid website or image URL/);
  await assert.rejects(importProjectIcon("file:///etc/passwd"), /HTTP or HTTPS/);
  await assert.rejects(importProjectIcon("https://u:p@example.com/a.png"), /without credentials/);
  await assert.rejects(importProjectIcon("https://example.com/a.png", async () => respond(null, "image/png", 500)), /Download failed \(500\)/);
  const big = new Uint8Array(600 * 1024);
  await assert.rejects(importProjectIcon("https://example.com/a.png", async () => respond(big, "image/png")), /512 KB or smaller/);
  await assert.rejects(
    importProjectIcon("https://example.com/", async (u) => (String(u).endsWith("/") ? respond("<html></html>", "text/html") : respond(null, "image/png", 404))),
    /Download failed \(404\)/,
  );
});

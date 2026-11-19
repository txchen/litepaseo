import test from "node:test";
import assert from "node:assert/strict";
import { importProjectIcon as importIcon, iconCandidates, isInternalAddress, type Lookup } from "../src/server/project-icon-import.ts";

/** Public DNS for every name unless a test says otherwise; no real lookups. */
const publicDns: Lookup = async () => ["93.184.215.14"];
const importProjectIcon = (value: string, fetchIcon?: Parameters<typeof importIcon>[1], lookup: Lookup = publicDns) => importIcon(value, fetchIcon, lookup);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const respond = (body: BodyInit | null, type: string, status = 200, url = "", location = "") => {
  const response = new Response(body, { status, headers: { "content-type": type, ...(location ? { location } : {}) } });
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

test("internal addresses are recognised in every spelling", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.31.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "255.255.255.255", "::1", "::", "fe80::1", "fe80::1%eth0", "fd00::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "[::1]", "not-an-ip"])
    assert.equal(isInternalAddress(address), true, address);
  for (const address of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])
    assert.equal(isInternalAddress(address), false, address);
});

test("local, private and metadata addresses are never fetched", async () => {
  const seen: string[] = [];
  const fetchIcon = async (u: string | URL) => (seen.push(String(u)), respond(PNG, "image/png"));
  for (const url of ["http://127.0.0.1/a.png", "http://localhost:8787/a.png", "http://app.localhost/a.png", "http://[::1]/a.png", "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/a.png", "http://[::ffff:127.0.0.1]/a.png", "http://[fd12::1]/a.png", "http://2130706433/a.png", "http://0x7f.1/a.png"])
    await assert.rejects(importProjectIcon(url, fetchIcon), /public website/, url);
  await assert.rejects(importProjectIcon("https://intranet.example/a.png", fetchIcon, async () => ["192.168.1.10"]), /public website/);
  await assert.rejects(importProjectIcon("https://mixed.example/a.png", fetchIcon, async () => ["93.184.215.14", "::1"]), /public website/, "any internal answer blocks");
  await assert.rejects(importProjectIcon("https://nowhere.example/a.png", fetchIcon, async () => { throw new Error("ENOTFOUND"); }), /could not be found/);
  assert.deepEqual(seen, []);
});

test("redirects are followed by hand and each hop is checked", async () => {
  const seen: { url: string; redirect?: RequestRedirect }[] = [];
  const lookup: Lookup = async (host) => (host === "internal.example" ? ["10.0.0.1"] : ["93.184.215.14"]);
  const data = await importProjectIcon("https://example.com/logo", async (u, init) => {
    seen.push({ url: String(u), redirect: init?.redirect });
    return String(u).endsWith("/logo") ? respond(null, "text/plain", 302, "", "/cdn/logo.png") : respond(PNG, "image/png");
  }, lookup);
  assert.equal(data, PNG.toString("base64"));
  assert.deepEqual(seen, [{ url: "https://example.com/logo", redirect: "manual" }, { url: "https://example.com/cdn/logo.png", redirect: "manual" }]);

  for (const target of ["http://127.0.0.1/a.png", "http://169.254.169.254/", "https://internal.example/a.png"]) {
    const hops: string[] = [];
    await assert.rejects(
      importProjectIcon("https://example.com/a.png", async (u) => (hops.push(String(u)), String(u) === "https://example.com/a.png" ? respond(null, "text/plain", 301, "", target) : respond(PNG, "image/png")), lookup),
      /public website/, target);
    assert.deepEqual(hops, ["https://example.com/a.png"], "the internal target is never requested");
  }
  await assert.rejects(importProjectIcon("https://example.com/a.png", async () => respond(null, "text/plain", 302, "", "file:///etc/passwd")), /HTTP or HTTPS/);
  await assert.rejects(importProjectIcon("https://example.com/a.png", async () => respond(null, "text/plain", 302, "", "/again")), /too many redirects/);
});

test("icons a page declares pass the same checks", async () => {
  assert.deepEqual(
    iconCandidates(`<link rel="icon" href="https://u:p@x.dev/a.png"><link rel="icon" href="data:image/png;base64,AA"><link rel="icon" href="//cdn.x.dev/b.png">`, new URL("https://x.dev/")).map(String),
    ["https://cdn.x.dev/b.png", "https://x.dev/favicon.ico"],
  );
  const seen: string[] = [];
  const html = `<link rel="icon" href="http://127.0.0.1:8787/api/secret.png"><link rel="icon" href="http://[::1]/b.png">`;
  const data = await importProjectIcon("https://example.com/", async (u) => {
    seen.push(String(u));
    return String(u) === "https://example.com/" ? respond(html, "text/html") : respond(PNG, "image/x-icon");
  });
  assert.equal(data, PNG.toString("base64"));
  assert.deepEqual(seen, ["https://example.com/", "https://example.com/favicon.ico"]);
});

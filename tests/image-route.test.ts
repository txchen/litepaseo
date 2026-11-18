import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.ts";
import { Hosts } from "../src/server/hosts.ts";
import { createApp } from "../src/server/app.ts";
import { imageReadTarget } from "../src/server/media.ts";

test("an absolute image path is read from its own folder; a relative one from the cwd", () => {
  assert.deepEqual(imageReadTarget("/Users/me/other/run/shot.png", "/Users/me/app"), { root: "/Users/me/other/run", path: "shot.png" });
  assert.deepEqual(imageReadTarget("/a/b/../c/./x.png", undefined), { root: "/a/c", path: "x.png" });
  assert.deepEqual(imageReadTarget("/x.png", undefined), { root: "/", path: "x.png" });
  assert.deepEqual(imageReadTarget("C:\\Users\\me\\x.png", undefined), { root: "C:/Users/me", path: "x.png" });
  assert.deepEqual(imageReadTarget("docs/a.png", "/repo"), { root: "/repo", path: "docs/a.png" });
  assert.equal(imageReadTarget("docs/a.png", undefined), null);
  assert.equal(imageReadTarget("/", undefined), null);
});

test("message images outside the agent's workspace are served through the daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "litepaseo-test-"));
  const store = new Store(directory);
  const hosts = new Hosts();
  const reads: unknown[][] = [];
  hosts.clients.set("h", {
    driver: {
      readFile: async (root: string, path: string, _encoding: unknown, max: number) => {
        reads.push([root, path, max]);
        if (path === "missing.png") throw new Error("not found");
        return { size: 3, bytes: new Uint8Array([1, 2, 3]) };
      },
    },
  } as never);
  const app = createApp(store, hosts, "test-token", directory);
  const get = (path: string) =>
    app.request(`/api/hosts/h/agents/a1/image?path=${encodeURIComponent(path)}`, { headers: { authorization: "Bearer test-token" } });
  try {
    const ok = await get("/Users/me/unity/.local/run-018/natural-startup.png");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
    assert.deepEqual(reads[0].slice(0, 2), ["/Users/me/unity/.local/run-018", "natural-startup.png"]);
    assert.equal((await get("/Users/me/missing.png")).status, 404);
    // Only raster images: nothing else on the machine is readable this way.
    assert.equal((await get("/etc/passwd")).status, 415);
    assert.equal((await get("/Users/me/a.svg")).status, 415);
    assert.equal(reads.length, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
test("packaged CLI background readiness, duplicate start, HTTP authentication and shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lp-life-"));
  const portServer = createServer();
  await new Promise<void>((r) => portServer.listen(0, "127.0.0.1", r));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((r) => portServer.close(() => r()));
  const env = { ...process.env, LITEPASEO_DATA_DIR: directory, LITEPASEO_PORT: String(port) };
  const run = (command: string) =>
    execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), command], {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  try {
    const first = JSON.parse(run("start").split("\n")[0]);
    assert.equal(first.ready, true);
    const second = JSON.parse(run("start").split("\n")[0]);
    assert.equal(second.pid, first.pid);
    assert.equal((await fetch(first.url)).status, 200);
    assert.equal((await fetch(first.url + "/api/hosts")).status, 401);
    const token = readFileSync(join(directory, "token"), "utf8");
    assert.equal(
      (await fetch(first.url + "/api/hosts", { headers: { authorization: "Bearer " + token } }))
        .status,
      200,
    );
    assert.match(run("status"), /"ready":true/);
  } finally {
    run("stop");
    for (let i = 0; i < 50; i++) {
      if (run("status").includes("Not running")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(run("status"), /Not running/);
    rmSync(directory, { recursive: true, force: true });
  }
});

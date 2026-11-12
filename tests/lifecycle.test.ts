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
  const run = (command: string, ...args: string[]) =>
    execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), command, ...args], {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
  /** `status` exits 3 when nothing runs; that is an answer, not a failure. */
  const status = () => {
    try {
      return run("status", "--json");
    } catch (error: any) {
      if (error.status === 3) return String(error.stdout);
      throw error;
    }
  };
  try {
    const first = JSON.parse(run("start", "--json"));
    assert.equal(first.ready, true);
    const second = JSON.parse(run("start", "--json"));
    assert.equal(second.pid, first.pid);
    assert.equal((await fetch(first.url)).status, 200);
    assert.equal((await fetch(first.url + "/api/hosts")).status, 401);
    const token = readFileSync(join(directory, "token"), "utf8");
    assert.equal(
      (await fetch(first.url + "/api/hosts", { headers: { authorization: "Bearer " + token } }))
        .status,
      200,
    );
    // Rotating and choosing the token take effect in the running server, without a restart.
    const bearer = (value: string) =>
      fetch(first.url + "/api/hosts", { headers: { authorization: "Bearer " + value } }).then((r) => r.status);
    const rotated = run("token", "rotate").trim();
    assert.match(rotated, /^[0-9a-f]{64}$/);
    assert.equal(run("token").trim(), rotated);
    assert.equal(await bearer(token.trim()), 401);
    assert.equal(await bearer(rotated), 200);
    const chosen = "my-own-access-token-42";
    execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), "token", "set"], {
      env, input: chosen + "\n", encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(run("token").trim(), chosen);
    assert.equal(await bearer(chosen), 200);
    assert.throws(
      () => execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), "token", "set"], {
        env, input: "too-short\n", encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
      }),
      (error: any) => /at least 16/.test(String(error.stderr)),
    );
    assert.equal(run("token").trim(), chosen, "a refused token leaves the old one");
    assert.match(status(), /"ready":true/);
    assert.equal(JSON.parse(status()).version, JSON.parse(readFileSync("package.json", "utf8")).version);
    process.kill(first.workerPid, "SIGKILL");
    let recovered: any;
    for (let i = 0; i < 60; i++) {
      recovered = JSON.parse(status());
      if (recovered.ready && recovered.workerPid !== first.workerPid) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(recovered.ready, true);
    assert.notEqual(recovered.workerPid, first.workerPid);
    assert.equal(recovered.pid, first.pid, "supervisor survives a worker crash");
    assert.equal((await fetch(recovered.url)).status, 200);
    // Killing the supervisor releases the kernel lock. Its worker exits on IPC disconnect.
    process.kill(recovered.pid, "SIGKILL");
    await new Promise(r => setTimeout(r, 300));
    const restarted = JSON.parse(run("start", "--json"));
    assert.equal(restarted.ready, true);
    assert.notEqual(restarted.pid, first.pid);
    assert.equal((await fetch(restarted.url)).status, 200);
    assert.match(readFileSync(join(directory, "service.log"), "utf8"), /worker_restart/);
    const archive = join(directory, "snapshot");
    assert.match(run("backup", archive), /Backup complete/);
    const restoredHome = join(directory, "restored");
    const restored = execFileSync(process.execPath, [resolve("dist/server/cli.mjs"), "restore", archive], {
      env: { ...env, LITEPASEO_HOME: restoredHome }, encoding: "utf8", timeout: 15000,
    });
    assert.match(restored, /Restore complete/);
    assert.equal(readFileSync(join(restoredHome, "token"), "utf8").trim(), chosen);

  } finally {
    assert.match(run("stop"), /stopped/);
    assert.deepEqual(JSON.parse(status()), { running: false });
    assert.match(run("stop"), /not running/);
    rmSync(directory, { recursive: true, force: true });
  }
});

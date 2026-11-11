import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeLock } from "../src/server/runtime-lock.ts";
import { RotatingLog } from "../src/server/rotating-log.ts";
import { manageService, serviceDefinition } from "../src/server/autostart.ts";
import { recoverSocket } from "../src/server/supervisor.ts";
import { createServer } from "node:net";

test("kernel runtime lock rejects a second owner and can be reacquired", () => {
  const root = mkdtempSync(join(tmpdir(), "lp-lock-"));
  try {
    const release = acquireRuntimeLock(root);
    assert.throws(() => acquireRuntimeLock(root), /Another/);
    release();
    acquireRuntimeLock(root)();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rotation keeps bounded private files, retaining the newest bytes even for oversized writes", () => {
  const root = mkdtempSync(join(tmpdir(), "lp-log-"));
  try {
    const path = join(root, "service.log"), logger = new RotatingLog(path, 1024, 2);
    logger.write(Buffer.alloc(5000, "a")); logger.write("last line\n");
    assert.equal(readdirSync(root).length, 3);
    for (const file of readdirSync(root)) {
      assert.ok(statSync(join(root, file)).size <= 1024);
      assert.equal(statSync(join(root, file)).mode & 0o777, 0o600);
    }
    assert.match(readFileSync(path, "utf8"), /last line\n$/);
    new RotatingLog(path, 1024, 1);
    assert.equal(readdirSync(root).length, 2, "lowering retention removes old excess archives");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("autostart renders escaped platform configs; install/uninstall use argv and preserve data", () => {
  const root = mkdtempSync(join(tmpdir(), "lp-service-"));
  try {
    const options = { platform: "linux", home: root, directory: join(root, "data % $x"), node: "/node path", cli: "/cli path", env: { PATH: "/bin", LITEPASEO_PORT: "9876", UNRELATED_SECRET: "not included" }, uid: 123 };
    const definition = serviceDefinition(options);
    assert.match(definition.content, /Restart=on-failure/);
    assert.match(definition.content, /%%/);
    assert.doesNotMatch(definition.content, /not included/);
    const calls: [string, string[]][] = [];
    const run = (file: string, args: string[]) => { calls.push([file, args]); return ""; };
    manageService("install", options, run);
    assert.deepEqual(calls[1], ["systemctl", ["--user", "enable", "--now", definition.name]]);
    assert.equal(statSync(definition.path).mode & 0o777, 0o600);
    manageService("uninstall", options, run);
    assert.deepEqual(calls[2], ["systemctl", ["--user", "disable", "--now", definition.name]]);
    const mac = serviceDefinition({ ...options, platform: "darwin", directory: "/a&b<c" });
    assert.match(mac.content, /a&amp;b&lt;c/);
    assert.match(mac.content, /SuccessfulExit/);
    assert.throws(() => serviceDefinition({ ...options, directory: "/bad\npath" }), /control characters/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("socket recovery refuses live sockets and ordinary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "lp-recover-")), path = join(root, "control.sock");
  const server = createServer(s => s.destroy());
  try {
    await new Promise<void>(resolve => server.listen(path, resolve));
    await assert.rejects(recoverSocket(path), /running instance/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    writeFileSync(path, "keep this");
    await assert.rejects(recoverSocket(path), /not a socket/);
    assert.equal(readFileSync(path, "utf8"), "keep this");
  } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
});

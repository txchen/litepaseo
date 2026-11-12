import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:net";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const directory = mkdtempSync(join(tmpdir(), "lp-pack-"));
const binary = join(directory, "prefix/bin/litepaseo");
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const env = { ...process.env, LITEPASEO_HOME: join(directory, "data"), LITEPASEO_PORT: String(port), LITEPASEO_BIND: "127.0.0.1" };
const run = (...args) => execFileSync(binary, args, { encoding: "utf8", env, timeout: 15000 });
let started = false;
try {
  const archive = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      join(directory, "prefix"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(directory, archive.filename),
    ],
    { stdio: "pipe" },
  );
  assert.match(run("--help"), /start \| serve/);
  assert.equal(run("--version").trim(), version);
  assert.ok(archive.files.every(file => /^(dist\/|docs\/|README\.md$|package\.json$|LICENSE)/.test(file.path)), "Only release files belong in the tarball");
  run("start");
  started = true;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: `Bearer ${run("token").trim()}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, version);
  const frontend = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(frontend.status, 200);
  assert.match(await frontend.text(), /<html/);
  assert.ok(existsSync(join(directory, "prefix/lib/node_modules/litepaseo/dist/web/index.html")));
  assert.equal(
    existsSync(join(directory, "prefix/lib/node_modules/litepaseo/node_modules/vite-plus")),
    false,
  );
  console.log("PASS tarball install, CLI version, service startup, health version, bundled frontend, runtime-only dependencies");
} finally {
  if (started) run("stop");
  rmSync(directory, { recursive: true, force: true });
}

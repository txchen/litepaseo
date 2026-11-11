import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const directory = mkdtempSync(join(tmpdir(), "lp-pack-"));
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
  const binary = join(directory, "prefix/bin/litepaseo");
  assert.match(
    execFileSync(binary, ["--help"], {
      encoding: "utf8",
      env: { ...process.env, LITEPASEO_DATA_DIR: join(directory, "data") },
    }),
    /start \| serve/,
  );
  assert.ok(existsSync(join(directory, "prefix/lib/node_modules/litepaseo/dist/web/index.html")));
  assert.equal(
    existsSync(join(directory, "prefix/lib/node_modules/litepaseo/node_modules/vite-plus")),
    false,
  );
  console.log("PASS tarball install, executable CLI, bundled frontend, runtime-only dependencies");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

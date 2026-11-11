import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyDirectory, resolveDataDirectory } from "../src/server/data-dir.ts";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "litepaseo-home-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const dead = async () => false;
const live = async () => true;

test("defaults to ~/.litepaseo; LITEPASEO_HOME and the old LITEPASEO_DATA_DIR override it", async () => {
  const h = home();
  try {
    assert.deepEqual(await resolveDataDirectory({}, h.dir, "linux", dead), { directory: join(h.dir, ".litepaseo") });
    assert.deepEqual(await resolveDataDirectory({}, h.dir, "darwin", dead), { directory: join(h.dir, ".litepaseo") });
    assert.equal((await resolveDataDirectory({ LITEPASEO_HOME: "/srv/lp" }, h.dir, "linux", dead)).directory, "/srv/lp");
    assert.equal((await resolveDataDirectory({ LITEPASEO_DATA_DIR: "/srv/old" }, h.dir, "linux", dead)).directory, "/srv/old");
    assert.equal(legacyDirectory({ XDG_DATA_HOME: "/x" }, h.dir, "linux"), "/x/litepaseo");
    assert.equal(legacyDirectory({}, h.dir, "darwin"), join(h.dir, "Library/Application Support/LitePaseo"));
  } finally {
    h.cleanup();
  }
});

test("old-location data moves once, unless an instance is still running there", async () => {
  const h = home();
  try {
    const legacy = legacyDirectory({}, h.dir, "linux");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "token"), "abc");
    writeFileSync(join(legacy, "control.sock"), "");

    const running = await resolveDataDirectory({}, h.dir, "linux", live);
    assert.equal(running.directory, legacy, "a running instance keeps its directory");
    assert.match(running.notice!, /litepaseo stop/);
    assert.ok(!existsSync(join(h.dir, ".litepaseo")));

    const moved = await resolveDataDirectory({}, h.dir, "linux", dead);
    assert.equal(moved.directory, join(h.dir, ".litepaseo"));
    assert.match(moved.notice!, /^Moved LitePaseo data/);
    assert.equal(readFileSync(join(moved.directory, "token"), "utf8"), "abc");
    assert.ok(!existsSync(join(moved.directory, "control.sock")), "the dead socket file does not block the lock");
    assert.ok(!existsSync(legacy));

    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "token"), "other");
    const again = await resolveDataDirectory({}, h.dir, "linux", dead);
    assert.equal(again.notice, undefined, "with ~/.litepaseo present, the old location is left alone");
    assert.equal(readFileSync(join(again.directory, "token"), "utf8"), "abc");
  } finally {
    h.cleanup();
  }
});
